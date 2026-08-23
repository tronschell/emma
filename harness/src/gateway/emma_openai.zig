//! Emma's model transport: OpenAI-compatible Chat Completions.
//!
//! Upstream fx speaks Vercel AI Gateway's AI SDK language-model v3 protocol
//! (`prompt`/`toolChoice` posted to `/v3/ai/language-model`). Emma's provider
//! seam everywhere else is "an OpenAI-compatible base URL, a model, and the
//! name of an environment variable holding the credential", so this replaces
//! that transport rather than wrapping it. It implements the same
//! `stream_provider.Provider` interface the Gateway and Codex routes do, so
//! the agent loop, tool admission, and permission layers above are untouched.
//!
//! ponytail: non-streaming (`"stream": false`) — the whole reply is handed to
//! `on_content_chunk` in one call. The loop, tools, and permissions behave
//! identically; only token-by-token rendering is lost. Upgrade path is an SSE
//! decoder for OpenAI's `choices[].delta` frames, replacing `parseCompletion`
//! with an incremental accumulator.

const std = @import("std");

const debug_trace = @import("../core/shared/debug_trace.zig");
const gateway_failure_diagnostics = @import("../core/gateway/gateway_failure_diagnostics.zig");
const gateway_json = @import("../core/gateway/gateway_json.zig");
const image_attachments = @import("../core/images/image_attachments.zig");
const io_mod = @import("../core/shared/io.zig");
const secret = @import("../core/auth/secret.zig");
const stream_provider = @import("../core/agent/stream_provider.zig");
const gateway_schema = @import("../core/tooling/gateway_schema.zig");
const tool_advertisement = @import("../core/tooling/tool_advertisement.zig");
const tool_dispatch = @import("../core/tooling/tool_dispatch.zig");
const types = @import("../core/shared/types.zig");

const Allocator = std.mem.Allocator;

pub const max_request_bytes = 1024 * 1024;
pub const max_response_bytes = 4 * 1024 * 1024;
pub const max_content_bytes = 256 * 1024;
pub const max_tool_calls_per_step = 16;

/// Emma's default route. Any OpenAI-compatible endpoint works; this one is the
/// catalog Emma already restricts to free, tool-capable, zero-retention models.
pub const default_chat_url = "https://openrouter.ai/api/v1/chat/completions";
pub const chat_url_env = "EMMA_PROVIDER_CHAT_URL";

pub const provider = stream_provider.Provider{
    .build_fn = build,
    .stream_fn = stream,
};

pub fn chatUrl() []const u8 {
    const override = io_mod.getenv(chat_url_env) orelse return default_chat_url;
    return if (override.len == 0) default_chat_url else override;
}

/// The env var Emma's zero-retention toggle sets. This is its only reader.
pub const zero_retention_env = "EMMA_OPENROUTER_ZDR";

fn isOpenRouter(url: []const u8) bool {
    return std.mem.indexOf(u8, url, "://openrouter.ai/") != null;
}

/// OpenRouter honours per-request routing flags that keep a turn on endpoints
/// which neither retain nor train on it.
///
/// This follows Emma's own toggle rather than being always on. Zero retention
/// narrows routing to endpoints that offer it, and most free models offer none —
/// forcing it turns every one of them into an unroutable 404 with no way for the
/// user to opt out of a guarantee they never asked for.
fn zeroRetentionRequested() bool {
    const value = io_mod.getenv(zero_retention_env) orelse return false;
    return value.len > 0;
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

fn build(_: ?*anyopaque, alloc: Allocator, request: stream_provider.BuildRequest) ![]u8 {
    const budget: image_attachments.CaptureBudget = if (request.budget) |value|
        .{ .deadline = value.deadline, .cancel_flag = value.cancel_flag }
    else
        .{};
    try budget.check();

    // The vision route hands over already-read, hash-verified bytes and asks for
    // a schema-shaped answer; neither half is meaningful without the other.
    if (request.verified_images != null and request.response_format == null) {
        return error.MissingStructuredResponseFormat;
    }
    if (request.verified_images == null and request.response_format != null) {
        return error.StructuredResponseRequiresVerifiedImages;
    }
    const override_index: ?usize = if (request.verified_images == null) null else index: {
        if (request.messages.len == 0) return error.InvalidGatewayHistory;
        const last = request.messages.len - 1;
        // Verified bytes replace the trailing prompt's own attachments, so a
        // message that already carries images would send them twice.
        if (request.messages[last].role != .user or request.messages[last].images.len != 0) {
            return error.InvalidGatewayHistory;
        }
        break :index last;
    };

    const tools_json = try advertisedToolsJson(alloc, request);
    defer alloc.free(tools_json);

    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    const w = &out.writer;

    // Emma's free router arrives as one comma-separated chain of model IDs,
    // best first. OpenRouter's own `models` array takes it from there: a model
    // that is rate-limited, down, or refuses on moderation falls through to the
    // next in the list, on the provider's side of the wire. The primary is
    // repeated as `model` so an endpoint that has never heard of `models` — a
    // local llama-server on EMMA_PROVIDER_CHAT_URL — still gets a routable
    // request rather than one with no model on it.
    var chain = std.mem.tokenizeScalar(u8, request.model, ',');
    const primary = chain.next() orelse return error.InvalidGatewayHistory;
    try w.writeAll("{\"model\":");
    try std.json.Stringify.value(primary, .{}, w);
    if (chain.peek() != null) {
        try w.writeAll(",\"models\":[");
        var listed = std.mem.tokenizeScalar(u8, request.model, ',');
        var index: usize = 0;
        while (listed.next()) |model| : (index += 1) {
            if (index > 0) try w.writeByte(',');
            try std.json.Stringify.value(model, .{}, w);
        }
        try w.writeByte(']');
    }

    try w.writeAll(",\"messages\":[");
    for (request.messages, 0..) |message, index| {
        try budget.check();
        if (index > 0) try w.writeByte(',');
        const verified = if (override_index != null and override_index.? == index)
            request.verified_images
        else
            null;
        try writeMessage(alloc, w, message, verified, budget);
    }
    try w.writeByte(']');

    if (try writeTools(alloc, w, tools_json)) {
        try w.writeAll(",\"tool_choice\":");
        // A required Vision gate is expressed by the advertisement itself, so
        // the choice has to follow the narrowed tool list rather than the
        // caller's default.
        const tool_choice = if (request.vision_mode == .required) types.ToolChoice.required else request.tool_choice;
        try std.json.Stringify.value(switch (tool_choice) {
            .auto => "auto",
            .none => "none",
            .required => "required",
        }, .{}, w);
    }

    if (request.response_format) |format| try writeResponseFormat(alloc, w, format);
    if (request.max_output_tokens) |value| try w.print(",\"max_tokens\":{d}", .{value});

    // Of the resolved provider options only these two have an OpenAI spelling.
    // `fast` is an AI Gateway routing hint and prompt caching is implicit here.
    if (request.provider_options.reasoning) |*effort| {
        try w.writeAll(",\"reasoning_effort\":");
        try std.json.Stringify.value(effort.label(), .{}, w);
    }
    if (request.provider_options.parallel_tool_calls) |parallel| {
        try w.writeAll(",\"parallel_tool_calls\":");
        try w.writeAll(if (parallel) "true" else "false");
    }

    if (isOpenRouter(chatUrl()) and zeroRetentionRequested()) {
        try w.writeAll(",\"provider\":{\"data_collection\":\"deny\",\"zdr\":true}");
    }

    try w.writeAll(",\"stream\":false}");

    const body = try out.toOwnedSlice();
    errdefer alloc.free(body);
    if (body.len > max_request_bytes) return error.RequestTooLarge;
    return body;
}

fn writeMessage(
    alloc: Allocator,
    w: *std.Io.Writer,
    message: types.ChatMessage,
    verified_images: ?[]const image_attachments.VerifiedSnapshot,
    budget: image_attachments.CaptureBudget,
) !void {
    try w.writeAll("{\"role\":");
    try std.json.Stringify.value(gateway_json.roleName(message.role), .{}, w);

    if (message.role == .tool) {
        // A tool result is bound to the call it answers; without the id the
        // provider cannot pair them and rejects the whole turn.
        try w.writeAll(",\"tool_call_id\":");
        try std.json.Stringify.value(message.tool_call_id orelse "", .{}, w);
    }

    try w.writeAll(",\"content\":");
    if (verified_images != null or message.images.len > 0) {
        try writeImageContentParts(alloc, w, message, verified_images, budget);
    } else {
        try std.json.Stringify.value(message.content orelse "", .{}, w);
    }

    if (message.tool_calls.len > 0) {
        try w.writeAll(",\"tool_calls\":[");
        for (message.tool_calls, 0..) |call, index| {
            if (index > 0) try w.writeByte(',');
            try w.writeAll("{\"type\":\"function\",\"id\":");
            try std.json.Stringify.value(call.id, .{}, w);
            try w.writeAll(",\"function\":{\"name\":");
            try std.json.Stringify.value(call.name, .{}, w);
            try w.writeAll(",\"arguments\":");
            // Arguments cross the wire as a JSON *string* holding JSON.
            try std.json.Stringify.value(
                if (call.arguments_json.len == 0) "{}" else call.arguments_json,
                .{},
                w,
            );
            try w.writeAll("}}");
        }
        try w.writeByte(']');
    }

    try w.writeByte('}');
}

/// Resolves the flat fx advertisement for this step. A `required` Vision gate
/// narrows it to the Vision tool alone so the model cannot answer around the
/// gate; `optional` appends Vision to whatever else is on offer. Caller owns
/// the returned slice.
fn advertisedToolsJson(alloc: Allocator, request: stream_provider.BuildRequest) ![]u8 {
    const vision_schema = if (request.vision_mode != .unavailable)
        try visionSchemaJson(alloc, request.tool_registry)
    else
        null;
    defer if (vision_schema) |schema| alloc.free(schema);

    if (request.vision_mode == .required) {
        return std.fmt.allocPrint(alloc, "[{s}]", .{vision_schema.?});
    }

    const base = if (request.serialized_tools.len == 0) "[]" else request.serialized_tools;
    if (vision_schema == null and request.selected_dynamic_tool_schemas.len == 0) {
        return alloc.dupe(u8, base);
    }

    var schemas: std.ArrayList([]const u8) = .empty;
    defer schemas.deinit(alloc);
    try schemas.appendSlice(alloc, request.selected_dynamic_tool_schemas);
    if (vision_schema) |schema| try schemas.append(alloc, schema);
    // Reused so a dynamic tool that shadows a built-in name is dropped here
    // rather than advertised twice.
    return tool_advertisement.buildGatewayToolsJsonWithSelectedDynamicSchemas(alloc, base, schemas.items);
}

fn visionSchemaJson(alloc: Allocator, registry: tool_dispatch.Registry) ![]u8 {
    const vision_tool = registry.lookup("vision") orelse return error.VisionToolNotRegistered;
    return gateway_schema.builtinFunctionSchemaJsonAlloc(alloc, vision_tool.gateway_schema);
}

/// fx advertises tools flat (`{"type","name","description","inputSchema"}`);
/// OpenAI nests them under `function` and calls the schema `parameters`.
fn writeTools(alloc: Allocator, w: *std.Io.Writer, tools_json: []const u8) !bool {
    const trimmed = std.mem.trim(u8, tools_json, " \n\r\t");
    if (trimmed.len == 0) return false;

    var parsed = std.json.parseFromSlice(std.json.Value, alloc, trimmed, .{}) catch {
        return error.InvalidToolAdvertisement;
    };
    defer parsed.deinit();
    if (parsed.value != .array) return error.InvalidToolAdvertisement;
    if (parsed.value.array.items.len == 0) return false;

    try w.writeAll(",\"tools\":[");
    for (parsed.value.array.items, 0..) |tool, index| {
        if (tool != .object) return error.InvalidToolAdvertisement;
        if (index > 0) try w.writeByte(',');
        try writeOneTool(w, tool.object);
    }
    try w.writeByte(']');
    return true;
}

fn writeOneTool(w: *std.Io.Writer, tool: std.json.ObjectMap) !void {
    const name = tool.get("name") orelse return error.InvalidToolAdvertisement;
    if (name != .string) return error.InvalidToolAdvertisement;

    try w.writeAll("{\"type\":\"function\",\"function\":{\"name\":");
    try std.json.Stringify.value(name.string, .{}, w);
    if (tool.get("description")) |description| {
        if (description == .string) {
            try w.writeAll(",\"description\":");
            try std.json.Stringify.value(description.string, .{}, w);
        }
    }
    try w.writeAll(",\"parameters\":");
    if (tool.get("inputSchema")) |schema| {
        try std.json.Stringify.value(schema, .{}, w);
    } else {
        try w.writeAll("{\"type\":\"object\",\"properties\":{}}");
    }
    try w.writeAll("}}");
}

fn writeImageContentParts(
    alloc: Allocator,
    w: *std.Io.Writer,
    message: types.ChatMessage,
    verified_images: ?[]const image_attachments.VerifiedSnapshot,
    budget: image_attachments.CaptureBudget,
) !void {
    try w.writeByte('[');
    var wrote_part = false;
    if (message.content) |content| {
        if (content.len > 0) {
            try w.writeAll("{\"type\":\"text\",\"text\":");
            try std.json.Stringify.value(content, .{}, w);
            try w.writeByte('}');
            wrote_part = true;
        }
    }
    if (verified_images) |snapshots| {
        for (snapshots) |snapshot| {
            if (wrote_part) try w.writeByte(',');
            try writeImagePart(w, snapshot, budget);
            wrote_part = true;
        }
    } else for (message.images) |image| {
        if (wrote_part) try w.writeByte(',');
        var snapshot = try image_attachments.loadVerifiedSnapshot(alloc, image, budget);
        defer snapshot.deinit(alloc);
        try writeImagePart(w, snapshot, budget);
        wrote_part = true;
    }
    try w.writeByte(']');
}

/// OpenAI carries image bytes inline as a data URL under `image_url`, where the
/// AI SDK used a `file` part with separate `mediaType` and `data` fields.
fn writeImagePart(
    w: *std.Io.Writer,
    snapshot: image_attachments.VerifiedSnapshot,
    budget: image_attachments.CaptureBudget,
) !void {
    try budget.check();
    try w.writeAll("{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:");
    try w.writeAll(snapshot.media_type);
    try w.writeAll(";base64,");
    // Chunked so a large attachment stays interruptible by the caller's budget.
    var offset: usize = 0;
    while (offset < snapshot.bytes.len) {
        try budget.check();
        const end = @min(offset + 3 * 1024, snapshot.bytes.len);
        try std.base64.standard.Encoder.encodeWriter(w, snapshot.bytes[offset..end]);
        offset = end;
    }
    try w.writeAll("\"}}");
}

/// The AI SDK asked for structured output with a flat `responseFormat`; OpenAI
/// wraps the same name/description/schema triple in `json_schema`.
fn writeResponseFormat(
    alloc: Allocator,
    w: *std.Io.Writer,
    format: stream_provider.StructuredResponseFormat,
) !void {
    var schema = std.json.parseFromSlice(std.json.Value, alloc, format.schema_json, .{}) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidStructuredResponseSchema,
    };
    defer schema.deinit();
    if (schema.value != .object) return error.InvalidStructuredResponseSchema;

    try w.writeAll(",\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":");
    try std.json.Stringify.value(format.name, .{}, w);
    try w.writeAll(",\"description\":");
    try std.json.Stringify.value(format.description, .{}, w);
    try w.writeAll(",\"schema\":");
    try std.json.Stringify.value(schema.value, .{}, w);
    try w.writeAll("}}");
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

fn stream(_: ?*anyopaque, alloc: Allocator, request: stream_provider.Request) anyerror!stream_provider.Result {
    if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;

    var client: std.http.Client = .{ .allocator = alloc, .io = io_mod.getIo() };
    defer client.deinit();

    var auth_header: ?[]u8 = null;
    defer if (auth_header) |value| secret.zeroAndFree(alloc, value);

    var headers: std.http.Client.Request.Headers = .{};
    if (request.api_key.len > 0) {
        auth_header = try std.fmt.allocPrint(alloc, "Bearer {s}", .{request.api_key});
        headers.authorization = .{ .override = auth_header.? };
    }

    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    const url = if (request.chat_url.len > 0) request.chat_url else chatUrl();

    // Past this point the request may have been billed, so recovery must not
    // silently re-send it.
    request.delivery.markPossiblySent();
    request.attempt_evidence.provider_admitted = true;

    const result = try client.fetch(.{
        .location = .{ .url = url },
        .method = .POST,
        .headers = headers,
        .payload = request.payload,
        .response_writer = &out.writer,
        .redirect_behavior = .unhandled,
    });

    const body = try out.toOwnedSlice();
    defer alloc.free(body);
    if (body.len > max_response_bytes) return error.ResponseTooLarge;

    if (result.status != .ok) {
        const err_body = try alloc.dupe(u8, body);
        errdefer alloc.free(err_body);
        // The runtime renders these into the network diagnostics ring, which is
        // the only place a rejected request's shape is ever visible.
        const failure = gateway_failure_diagnostics.collect(alloc, request.payload, err_body);
        return .{
            .status = result.status,
            .err_body = err_body,
            .failure_schema = failure.schema,
            .failure_request_shape = failure.request_shape,
            .ownership = .owned,
        };
    }

    var completion = try parseCompletion(alloc, body);
    errdefer freeCompletion(alloc, &completion);

    // Reasoning first: it is what the model did before the answer, and the
    // transcript folds it into the dropdown above the reply.
    if (completion.reasoning) |reasoning| {
        if (request.on_reasoning_chunk) |on_reasoning| on_reasoning(request.callback_ctx, reasoning);
    }
    if (completion.content) |content| {
        if (content.len > 0) request.on_content_chunk(request.callback_ctx, content);
    }
    if (request.on_tool_start) |on_tool_start| {
        for (completion.tool_calls) |call| on_tool_start(request.callback_ctx, call.id, call.name, null);
    }

    return .{
        .status = result.status,
        .completion = completion,
        .generation_origin = url,
        .ownership = .owned,
    };
}

fn freeCompletion(alloc: Allocator, completion: *types.GatewayCompletion) void {
    if (completion.content) |content| alloc.free(@constCast(content));
    if (completion.reasoning) |reasoning| alloc.free(@constCast(reasoning));
    types.freeToolCallSlice(alloc, @constCast(completion.tool_calls));
    completion.* = .{};
}

/// How much of an unparseable body to trace. Enough to see the shape that broke,
/// short enough not to spill a whole answer into a log.
const trace_body_bytes = 600;

fn parseCompletion(alloc: Allocator, body: []const u8) !types.GatewayCompletion {
    // A 200 that this function rejects is otherwise invisible: the caller sees
    // only `InvalidProviderResponse` with no way to learn what the provider sent.
    errdefer debug_trace.logf(
        "emma_openai",
        "unparseable_completion body={s}",
        .{body[0..@min(body.len, trace_body_bytes)]},
    );
    var parsed = std.json.parseFromSlice(std.json.Value, alloc, body, .{}) catch {
        return error.InvalidProviderResponse;
    };
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidProviderResponse;

    const choices = parsed.value.object.get("choices") orelse return error.InvalidProviderResponse;
    if (choices != .array or choices.array.items.len == 0) return error.InvalidProviderResponse;
    if (choices.array.items[0] != .object) return error.InvalidProviderResponse;
    const choice = choices.array.items[0].object;
    const message = choice.get("message") orelse return error.InvalidProviderResponse;
    if (message != .object) return error.InvalidProviderResponse;

    const content: []const u8 = if (message.object.get("content")) |value| switch (value) {
        .null => "",
        .string => |text| text,
        else => return error.InvalidProviderResponse,
    } else "";
    if (content.len > max_content_bytes or !std.unicode.utf8ValidateSlice(content)) {
        return error.InvalidProviderResponse;
    }

    // OpenRouter (and vLLM, and DeepSeek) put the scratchpad here; a provider
    // that does not reason simply omits it. Anything that is not a string is
    // ignored rather than fatal: reasoning is never worth failing a good answer.
    const reasoning: []const u8 = if (message.object.get("reasoning")) |value| switch (value) {
        .string => |text| text,
        else => "",
    } else "";

    var completion: types.GatewayCompletion = .{};
    completion.tool_calls = try parseToolCalls(alloc, message.object.get("tool_calls"));
    errdefer types.freeToolCallSlice(alloc, @constCast(completion.tool_calls));

    // An empty reply with no tool call is a dead turn, not a valid answer.
    if (content.len == 0 and completion.tool_calls.len == 0) return error.InvalidProviderResponse;
    completion.content = try alloc.dupe(u8, content);
    if (reasoning.len > 0 and reasoning.len <= max_content_bytes and std.unicode.utf8ValidateSlice(reasoning)) {
        completion.reasoning = try alloc.dupe(u8, reasoning);
    }

    if (choice.get("finish_reason")) |reason| {
        if (reason == .string) completion.finish_reason = finishReason(reason.string);
    }
    if (parsed.value.object.get("usage")) |usage| {
        if (usage == .object) {
            completion.usage = .{
                .input_tokens = tokenCount(usage.object.get("prompt_tokens")),
                .output_tokens = tokenCount(usage.object.get("completion_tokens")),
            };
        }
    }
    return completion;
}

fn finishReason(raw: []const u8) ?types.ProviderFinishReason {
    if (std.mem.eql(u8, raw, "stop")) return .stop;
    if (std.mem.eql(u8, raw, "length")) return .length;
    if (std.mem.eql(u8, raw, "tool_calls")) return .tool_calls;
    if (std.mem.eql(u8, raw, "function_call")) return .tool_calls;
    return null;
}

fn tokenCount(value: ?std.json.Value) ?u64 {
    const found = value orelse return null;
    return switch (found) {
        .integer => |count| if (count < 0) null else @intCast(count),
        else => null,
    };
}

fn parseToolCalls(alloc: Allocator, value: ?std.json.Value) ![]const types.ToolCall {
    const calls = value orelse return &.{};
    if (calls != .array or calls.array.items.len == 0) return &.{};
    if (calls.array.items.len > max_tool_calls_per_step) return error.InvalidProviderResponse;

    var list: std.ArrayList(types.ToolCall) = .empty;
    errdefer {
        types.freeToolCallSlice(alloc, list.items);
        list.deinit(alloc);
    }

    for (calls.array.items) |entry| {
        if (entry != .object) return error.InvalidProviderResponse;
        const function = entry.object.get("function") orelse return error.InvalidProviderResponse;
        if (function != .object) return error.InvalidProviderResponse;
        const name = function.object.get("name") orelse return error.InvalidProviderResponse;
        if (name != .string or name.string.len == 0) return error.InvalidProviderResponse;

        const raw_arguments: []const u8 = if (function.object.get("arguments")) |arguments| switch (arguments) {
            .string => |text| text,
            .null => "{}",
            else => return error.InvalidProviderResponse,
        } else "{}";
        const arguments = if (raw_arguments.len == 0) "{}" else raw_arguments;

        const id: []const u8 = if (entry.object.get("id")) |found|
            switch (found) {
                .string => |text| text,
                else => return error.InvalidProviderResponse,
            }
        else
            "";

        try list.append(alloc, .{
            .id = try alloc.dupe(u8, id),
            .name = try alloc.dupe(u8, name.string),
            .arguments_json = try alloc.dupe(u8, arguments),
        });
    }

    return try list.toOwnedSlice(alloc);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

test "request body is OpenAI shaped and rewrites fx tool advertisements" {
    const alloc = std.testing.allocator;
    const messages = [_]types.ChatMessage{
        .{ .role = .system, .content = "Be brief." },
        .{ .role = .user, .content = "Hi" },
    };
    const tools =
        \\[{"type":"function","name":"read_file","description":"Read","inputSchema":{"type":"object","properties":{"path":{"type":"string"}}}}]
    ;
    const body = try build(null, alloc, .{
        .model = "nvidia/nemotron-3-super-120b-a12b:free",
        .serialized_tools = tools,
        .messages = &messages,
        .tool_choice = .auto,
        .provider_options = .{},
    });
    defer alloc.free(body);

    // OpenAI vocabulary, not AI SDK vocabulary.
    try std.testing.expect(std.mem.indexOf(u8, body, "\"messages\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"prompt\":[") == null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"tool_choice\":\"auto\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"toolChoice\"") == null);
    // The flat fx tool became a nested OpenAI function with `parameters`.
    try std.testing.expect(std.mem.indexOf(u8, body, "\"function\":{\"name\":\"read_file\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"parameters\":{\"type\":\"object\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"inputSchema\"") == null);
}

test "one model stays one model, and a chain becomes OpenRouter's fallback array" {
    const alloc = std.testing.allocator;
    const messages = [_]types.ChatMessage{.{ .role = .user, .content = "Hi" }};

    const one = try build(null, alloc, .{
        .model = "nvidia/nemotron-3-super-120b-a12b:free",
        .serialized_tools = "[]",
        .messages = &messages,
        .tool_choice = .auto,
        .provider_options = .{},
    });
    defer alloc.free(one);
    try std.testing.expect(std.mem.indexOf(u8, one, "\"model\":\"nvidia/nemotron-3-super-120b-a12b:free\"") != null);
    // No chain, no array: every ordinary turn sends exactly what it used to.
    try std.testing.expect(std.mem.indexOf(u8, one, "\"models\"") == null);

    const chained = try build(null, alloc, .{
        .model = "a/one:free,b/two:free,c/three:free",
        .serialized_tools = "[]",
        .messages = &messages,
        .tool_choice = .auto,
        .provider_options = .{},
    });
    defer alloc.free(chained);
    try std.testing.expect(std.mem.indexOf(u8, chained, "\"model\":\"a/one:free\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, chained, "\"models\":[\"a/one:free\",\"b/two:free\",\"c/three:free\"]") != null);
}

test "zero retention rides Emma's toggle instead of every request" {
    const alloc = std.testing.allocator;
    const messages = [_]types.ChatMessage{.{ .role = .user, .content = "Hi" }};
    const body = try build(null, alloc, .{
        .model = "nvidia/nemotron-3-super-120b-a12b:free",
        .serialized_tools = "[]",
        .messages = &messages,
        .tool_choice = .auto,
        .provider_options = .{},
    });
    defer alloc.free(body);

    // The test process does not set the toggle, so the routing constraint must be
    // absent: forcing it makes every free OpenRouter model an unroutable 404.
    try std.testing.expect(!zeroRetentionRequested());
    try std.testing.expect(std.mem.indexOf(u8, body, "\"zdr\":true") == null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"data_collection\"") == null);
    // Emma's host reads the same name, so the two agree on one setting.
    try std.testing.expectEqualStrings("EMMA_OPENROUTER_ZDR", zero_retention_env);
}

test "tool results carry their call id and assistant calls round trip" {
    const alloc = std.testing.allocator;
    const calls = [_]types.ToolCall{
        .{ .id = "call_1", .name = "bash", .arguments_json = "{\"command\":\"ls\"}" },
    };
    const messages = [_]types.ChatMessage{
        .{ .role = .assistant, .content = "", .tool_calls = &calls },
        .{ .role = .tool, .content = "README.md", .tool_call_id = "call_1" },
    };
    const body = try build(null, alloc, .{
        .model = "m",
        .serialized_tools = "",
        .messages = &messages,
        .tool_choice = .auto,
        .provider_options = .{},
    });
    defer alloc.free(body);

    try std.testing.expect(std.mem.indexOf(u8, body, "\"tool_call_id\":\"call_1\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"arguments\":\"{\\\"command\\\":\\\"ls\\\"}\"") != null);
    // No tools advertised means no tool_choice, which some providers reject.
    try std.testing.expect(std.mem.indexOf(u8, body, "\"tool_choice\"") == null);
}

test "completion parsing accepts content, tool calls, and usage but rejects empty turns" {
    const alloc = std.testing.allocator;

    var text = try parseCompletion(alloc,
        \\{"choices":[{"message":{"content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3}}
    );
    defer freeCompletion(alloc, &text);
    try std.testing.expectEqualStrings("hello", text.content.?);
    try std.testing.expectEqual(@as(?u64, 7), text.usage.input_tokens);
    try std.testing.expectEqual(@as(?u64, 3), text.usage.output_tokens);

    var called = try parseCompletion(alloc,
        \\{"choices":[{"message":{"content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"bash","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}
    );
    defer freeCompletion(alloc, &called);
    try std.testing.expectEqual(@as(usize, 1), called.tool_calls.len);
    try std.testing.expectEqualStrings("bash", called.tool_calls[0].name);
    try std.testing.expectEqualStrings("call_1", called.tool_calls[0].id);

    // No content and no tool call is a dead turn, not a valid answer.
    // Reasoning rides beside the answer, not inside it: a model that thinks out
    // loud must not have its scratchpad rendered as the reply.
    var reasoned = try parseCompletion(alloc,
        \\{"choices":[{"message":{"content":"4","reasoning":"two plus two"}}]}
    );
    defer freeCompletion(alloc, &reasoned);
    try std.testing.expectEqualStrings("4", reasoned.content.?);
    try std.testing.expectEqualStrings("two plus two", reasoned.reasoning.?);
    // A provider that does not reason leaves it null rather than empty.
    try std.testing.expect(text.reasoning == null);

    try std.testing.expectError(error.InvalidProviderResponse, parseCompletion(alloc,
        \\{"choices":[{"message":{"content":""}}]}
    ));
    try std.testing.expectError(error.InvalidProviderResponse, parseCompletion(alloc, "{}"));
}
