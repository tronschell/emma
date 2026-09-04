const std = @import("std");

const debug_trace = @import("../core/shared/debug_trace.zig");
const gateway_client = @import("client.zig");
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
const Sha256 = std.crypto.hash.sha2.Sha256;

pub const max_request_bytes = 1024 * 1024;
pub const max_response_bytes = 4 * 1024 * 1024;
pub const max_content_bytes = 256 * 1024;
pub const max_tool_calls_per_step = 16;
pub const max_routed_model_bytes = 256;

pub const default_chat_url = "https://openrouter.ai/api/v1/chat/completions";
pub const chat_url_env = "EMMA_PROVIDER_CHAT_URL";
pub const stream_silence_env = "EMMA_STREAM_SILENCE_MS";
const default_stream_silence_ms: i64 = 3 * std.time.ms_per_min;
var test_stream_silence_ms: ?i64 = null;

const StreamSilence = struct {
    limit_ms: i64,
    last_ms: std.atomic.Value(i64),

    fn init(limit_ms: i64) StreamSilence {
        return .{ .limit_ms = limit_ms, .last_ms = .init(io_mod.milliTimestamp()) };
    }

    fn touch(self: *StreamSilence) void {
        self.last_ms.store(io_mod.milliTimestamp(), .seq_cst);
    }

    fn overdue(self: *const StreamSilence) bool {
        if (self.limit_ms <= 0) return false;
        return io_mod.milliTimestamp() - self.last_ms.load(.seq_cst) > self.limit_ms;
    }
};

fn streamSilenceLimitMs() i64 {
    if (@import("builtin").is_test) {
        if (test_stream_silence_ms) |limit| return limit;
    }
    const raw = io_mod.getenv(stream_silence_env) orelse return default_stream_silence_ms;
    const trimmed = std.mem.trim(u8, raw, " \t\r\n");
    if (trimmed.len == 0) return default_stream_silence_ms;
    return std.fmt.parseInt(i64, trimmed, 10) catch default_stream_silence_ms;
}

fn waitForStreamSilence(silence: *StreamSilence) anyerror!void {
    while (!silence.overdue()) {
        try io_mod.getIo().sleep(.fromMilliseconds(50), .awake);
    }
}

const openrouter_session_id_prefix = "emma-openrouter-session-v1:";
const openrouter_session_id_bytes = openrouter_session_id_prefix.len + Sha256.digest_length * 2;

pub const provider = stream_provider.Provider{
    .build_fn = build,
    .stream_fn = stream,
};

pub fn chatUrl() []const u8 {
    const override = io_mod.getenv(chat_url_env) orelse return default_chat_url;
    return if (override.len == 0) default_chat_url else override;
}

pub const zero_retention_env = "EMMA_OPENROUTER_ZDR";

fn isOpenRouter(url: []const u8) bool {
    const uri = std.Uri.parse(url) catch return false;
    if (!std.ascii.eqlIgnoreCase(uri.scheme, "https")) return false;
    const host_component = uri.host orelse return false;
    var host_buf: [std.Io.net.HostName.max_len]u8 = undefined;
    const host = host_component.toRaw(&host_buf) catch return false;
    return std.ascii.eqlIgnoreCase(host, "openrouter.ai");
}

fn openRouterSessionId(session_id: []const u8) [openrouter_session_id_bytes]u8 {
    var digest: [Sha256.digest_length]u8 = undefined;
    var hasher = Sha256.init(.{});
    hasher.update(openrouter_session_id_prefix);
    hasher.update(session_id);
    digest = hasher.finalResult();

    var value: [openrouter_session_id_bytes]u8 = undefined;
    @memcpy(value[0..openrouter_session_id_prefix.len], openrouter_session_id_prefix);
    const hex = std.fmt.bytesToHex(digest, .lower);
    @memcpy(value[openrouter_session_id_prefix.len..], hex[0..]);
    return value;
}

fn openRouterSessionHeader(
    url: []const u8,
    session_id: ?[]const u8,
    value: *[openrouter_session_id_bytes]u8,
) ?std.http.Header {
    if (!isOpenRouter(url)) return null;
    const id = session_id orelse return null;
    if (id.len == 0) return null;
    value.* = openRouterSessionId(id);
    return .{ .name = "x-session-id", .value = value[0..] };
}

fn hostIs(url: []const u8, expected: []const u8) bool {
    const uri = std.Uri.parse(url) catch return false;
    const host_component = uri.host orelse return false;
    var host_buf: [std.Io.net.HostName.max_len]u8 = undefined;
    const host = host_component.toRaw(&host_buf) catch return false;
    return std.ascii.eqlIgnoreCase(host, expected);
}

fn isZai(url: []const u8) bool {
    if (hostIs(url, "api.z.ai") or hostIs(url, "open.bigmodel.cn")) return true;
    return std.mem.indexOf(u8, url, "/api/coding/paas/v4/") != null or std.mem.indexOf(u8, url, "/api/paas/v4/") != null;
}

fn isLoopback(url: []const u8) bool {
    return hostIs(url, "127.0.0.1") or hostIs(url, "localhost");
}

fn promptCacheKeyTarget(url: []const u8) bool {
    const uri = std.Uri.parse(url) catch return false;
    const host_component = uri.host orelse return false;
    var host_buf: [std.Io.net.HostName.max_len]u8 = undefined;
    const host = host_component.toRaw(&host_buf) catch return false;
    return std.ascii.eqlIgnoreCase(host, "openrouter.ai") or
        std.ascii.eqlIgnoreCase(host, "api.openai.com") or
        std.mem.eql(u8, host, "127.0.0.1") or
        std.ascii.eqlIgnoreCase(host, "localhost");
}

fn zeroRetentionRequested() bool {
    const value = io_mod.getenv(zero_retention_env) orelse return false;
    return value.len > 0;
}

fn explicitCachingTarget(model: []const u8) bool {
    if (!isOpenRouter(chatUrl())) return false;
    var models = std.mem.tokenizeScalar(u8, model, ',');
    var found = false;
    while (models.next()) |candidate| {
        found = true;
        if (!std.mem.startsWith(u8, candidate, "anthropic/")) return false;
    }
    return found;
}

fn build(_: ?*anyopaque, alloc: Allocator, request: stream_provider.BuildRequest) ![]u8 {
    const budget: image_attachments.CaptureBudget = if (request.budget) |value|
        .{ .deadline = value.deadline, .cancel_flag = value.cancel_flag }
    else
        .{};
    try budget.check();

    if (request.verified_images != null and request.response_format == null) {
        return error.MissingStructuredResponseFormat;
    }
    if (request.verified_images == null and request.response_format != null) {
        return error.StructuredResponseRequiresVerifiedImages;
    }
    const override_index: ?usize = if (request.verified_images == null) null else index: {
        if (request.messages.len == 0) return error.InvalidGatewayHistory;
        const last = request.messages.len - 1;
        if (request.messages[last].role != .user or request.messages[last].images.len != 0) {
            return error.InvalidGatewayHistory;
        }
        break :index last;
    };

    const chat_url = chatUrl();
    const tools_json = try advertisedToolsJson(alloc, request);
    defer alloc.free(tools_json);

    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    const w = &out.writer;

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

    const prompt_caching = request.provider_options.prompt_caching and explicitCachingTarget(request.model);
    const cache_marks = if (prompt_caching)
        gateway_json.findCacheMarks(request.messages)
    else
        gateway_json.CacheMarks{};
    var prefix_cacheable = true;

    try w.writeAll(",\"messages\":[");
    for (request.messages, 0..) |message, index| {
        try budget.check();
        if (index > 0) try w.writeByte(',');
        const verified = if (override_index != null and override_index.? == index)
            request.verified_images
        else
            null;
        const use_cache = if (prefix_cacheable) gateway_json.cacheTtlForMessage(
            message,
            index,
            cache_marks,
            prompt_caching,
        ) else .none;
        try writeMessage(alloc, w, chat_url, message, verified, budget, use_cache);
        if (message.cache_policy == .no_cache) prefix_cacheable = false;
    }
    try w.writeByte(']');

    if (try writeTools(alloc, w, tools_json)) {
        try w.writeAll(",\"tool_choice\":");
        const tool_choice = if (request.vision_mode == .required) types.ToolChoice.required else request.tool_choice;
        try std.json.Stringify.value(switch (tool_choice) {
            .auto => "auto",
            .none => "none",
            .required => "required",
        }, .{}, w);
    }

    if (request.response_format) |format| try writeResponseFormat(alloc, w, format);
    if (request.max_output_tokens) |value| try w.print(",\"max_tokens\":{d}", .{value});

    if (request.provider_options.reasoning) |*effort| {
        try w.writeAll(",\"reasoning_effort\":");
        try std.json.Stringify.value(effort.label(), .{}, w);
    }
    if (request.provider_options.parallel_tool_calls) |parallel| {
        try w.writeAll(",\"parallel_tool_calls\":");
        try w.writeAll(if (parallel) "true" else "false");
    }

    if (isOpenRouter(chat_url) and zeroRetentionRequested()) {
        try w.writeAll(",\"provider\":{\"data_collection\":\"deny\",\"zdr\":true}");
    }
    if (promptCacheKeyTarget(chat_url)) {
        if (request.session_id) |session_id| if (session_id.len > 0) {
            const key = openRouterSessionId(session_id);
            try w.writeAll(",\"prompt_cache_key\":");
            try std.json.Stringify.value(key[0..], .{}, w);
        };
    }
    try writeZaiRequestOptions(w, chat_url, request.session_id);

    if (request.stream) {
        try w.writeAll(",\"stream\":true,\"stream_options\":{\"include_usage\":true}}");
    } else {
        try w.writeAll(",\"stream\":false}");
    }

    const body = try out.toOwnedSlice();
    errdefer alloc.free(body);
    if (body.len > max_request_bytes) return error.RequestTooLarge;
    return body;
}

fn writeZaiRequestOptions(
    w: *std.Io.Writer,
    url: []const u8,
    session_id: ?[]const u8,
) !void {
    if (!isZai(url)) return;
    try w.writeAll(",\"thinking\":{\"type\":\"enabled\",\"clear_thinking\":false}");
    const id = session_id orelse return;
    if (id.len == 0) return;
    const key = openRouterSessionId(id);
    try w.writeAll(",\"user_id\":");
    try std.json.Stringify.value(key[0..], .{}, w);
}

fn writeMessage(
    alloc: Allocator,
    w: *std.Io.Writer,
    chat_url: []const u8,
    message: types.ChatMessage,
    verified_images: ?[]const image_attachments.VerifiedSnapshot,
    budget: image_attachments.CaptureBudget,
    cached: gateway_json.CacheTtl,
) !void {
    try w.writeAll("{\"role\":");
    try std.json.Stringify.value(gateway_json.roleName(message.role), .{}, w);

    if (message.role == .tool) {
        try w.writeAll(",\"tool_call_id\":");
        try std.json.Stringify.value(message.tool_call_id orelse "", .{}, w);
    }

    try w.writeAll(",\"content\":");
    if (verified_images != null or message.images.len > 0) {
        try writeImageContentParts(alloc, w, message, verified_images, budget, cached);
    } else if (cached != .none and message.content != null and message.content.?.len > 0) {
        try w.writeAll("[{\"type\":\"text\",\"text\":");
        try std.json.Stringify.value(message.content.?, .{}, w);
        try w.writeAll(",\"cache_control\":");
        try w.writeAll(gateway_json.cacheControlJson(cached));
        try w.writeAll("}]");
    } else {
        try std.json.Stringify.value(message.content orelse "", .{}, w);
    }

    if (message.role == .assistant) {
        if (message.reasoning) |reasoning| {
            if (reasoning.len > 0 and isZai(chat_url)) {
                try w.writeAll(",\"reasoning_content\":");
                try std.json.Stringify.value(reasoning, .{}, w);
            }
        }
        if (message.reasoning_details_json) |details| {
            if (details.len > 0 and isLoopback(chat_url)) {
                try w.writeAll(",\"reasoning_details\":");
                try w.writeAll(details);
            }
        }
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
    return tool_advertisement.buildGatewayToolsJsonWithSelectedDynamicSchemas(alloc, base, schemas.items);
}

fn visionSchemaJson(alloc: Allocator, registry: tool_dispatch.Registry) ![]u8 {
    const vision_tool = registry.lookup("vision") orelse return error.VisionToolNotRegistered;
    return gateway_schema.builtinFunctionSchemaJsonAlloc(alloc, vision_tool.gateway_schema);
}

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
    cached: gateway_json.CacheTtl,
) !void {
    try w.writeByte('[');
    var wrote_part = false;
    if (message.content) |content| {
        if (content.len > 0) {
            try w.writeAll("{\"type\":\"text\",\"text\":");
            try std.json.Stringify.value(content, .{}, w);
            if (cached != .none) {
                try w.writeAll(",\"cache_control\":");
                try w.writeAll(gateway_json.cacheControlJson(cached));
            }
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

fn writeImagePart(
    w: *std.Io.Writer,
    snapshot: image_attachments.VerifiedSnapshot,
    budget: image_attachments.CaptureBudget,
) !void {
    try budget.check();
    try w.writeAll("{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:");
    try w.writeAll(snapshot.media_type);
    try w.writeAll(";base64,");
    var offset: usize = 0;
    while (offset < snapshot.bytes.len) {
        try budget.check();
        const end = @min(offset + 3 * 1024, snapshot.bytes.len);
        try std.base64.standard.Encoder.encodeWriter(w, snapshot.bytes[offset..end]);
        offset = end;
    }
    try w.writeAll("\"}}");
}

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

fn stream(_: ?*anyopaque, alloc: Allocator, request: stream_provider.Request) anyerror!stream_provider.Result {
    if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;

    var client: std.http.Client = .{ .allocator = alloc, .io = io_mod.getIo() };
    defer client.deinit();

    var auth_header: ?[]u8 = null;
    defer if (auth_header) |value| secret.zeroAndFree(alloc, value);

    var headers: std.http.Client.Request.Headers = .{ .content_type = .{ .override = "application/json" } };
    if (request.api_key.len > 0) {
        auth_header = try std.fmt.allocPrint(alloc, "Bearer {s}", .{request.api_key});
        headers.authorization = .{ .override = auth_header.? };
    }

    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    var sink: SseSink = .{ .alloc = alloc, .request = &request };
    defer sink.deinit();

    const url = if (request.chat_url.len > 0) request.chat_url else chatUrl();
    var affinity_id: [openrouter_session_id_bytes]u8 = undefined;
    var extra_headers_buf: [1]std.http.Header = undefined;
    const extra_headers: []const std.http.Header = if (openRouterSessionHeader(
        url,
        request.session_id,
        &affinity_id,
    )) |header| blk: {
        extra_headers_buf[0] = header;
        break :blk extra_headers_buf[0..];
    } else &.{};

    request.delivery.markPossiblySent();
    request.attempt_evidence.provider_admitted = true;

    var silence = StreamSilence.init(streamSilenceLimitMs());
    const posted = post(.{
        .client = &client,
        .url = url,
        .headers = headers,
        .extra_headers = extra_headers,
        .payload = request.payload,
        .out = &out,
        .sink = &sink,
        .cancel_flag = request.cancel_flag,
        .silence = &silence,
    }) catch |err| {
        request.attempt_evidence.network_failure = stream_provider.responseFailureEvidence(
            err,
            request.delivery.load(),
        ) orelse gateway_client.networkFailureEvidence(err, request.delivery.load());
        return err;
    };

    const body = try out.toOwnedSlice();
    defer alloc.free(body);
    if (body.len > max_response_bytes) return error.ResponseTooLarge;

    if (posted.status != .ok) {
        const err_body = try alloc.dupe(u8, body);
        errdefer alloc.free(err_body);
        const failure = gateway_failure_diagnostics.collect(alloc, request.payload, err_body);
        return .{
            .status = posted.status,
            .err_body = err_body,
            .failure_schema = failure.schema,
            .failure_request_shape = failure.request_shape,
            .ownership = .owned,
        };
    }

    var completion = completionFor(alloc, posted.streamed, &sink, body) catch |err| {
        request.attempt_evidence.network_failure = stream_provider.responseFailureEvidence(
            err,
            request.delivery.load(),
        );
        return err;
    };
    errdefer freeCompletion(alloc, &completion);

    if (!posted.streamed) {
        if (completion.reasoning) |reasoning| {
            if (request.on_reasoning_chunk) |on_reasoning| on_reasoning(request.callback_ctx, reasoning);
        }
        if (completion.content) |content| {
            if (content.len > 0) request.on_content_chunk(request.callback_ctx, content);
        }
    }
    if (request.on_tool_start) |on_tool_start| {
        for (completion.tool_calls) |call| on_tool_start(request.callback_ctx, call.id, call.name, null);
    }

    return .{
        .status = posted.status,
        .completion = completion,
        .generation_origin = url,
        .ownership = .owned,
    };
}

fn completionFor(
    alloc: Allocator,
    streamed: bool,
    sink: *SseSink,
    body: []const u8,
) !types.GatewayCompletion {
    if (streamed) return sink.finish();
    return parseCompletion(alloc, body);
}

const sse_transfer_buffer_bytes = 16 * 1024;

fn jsonStringField(object: std.json.ObjectMap, name: []const u8) ?[]const u8 {
    const value = object.get(name) orelse return null;
    return switch (value) {
        .string => |text| text,
        else => null,
    };
}

const SseToolFragment = struct {
    index: i64,
    id: std.ArrayList(u8) = .empty,
    name: std.ArrayList(u8) = .empty,
    arguments: std.ArrayList(u8) = .empty,

    fn deinit(self: *@This(), alloc: Allocator) void {
        self.id.deinit(alloc);
        self.name.deinit(alloc);
        self.arguments.deinit(alloc);
    }
};

const SseSink = struct {
    alloc: Allocator,
    request: *const stream_provider.Request,
    content: std.ArrayList(u8) = .empty,
    reasoning: std.ArrayList(u8) = .empty,
    reasoning_dropped: bool = false,
    reasoning_details: ?[]u8 = null,
    tools: std.ArrayList(SseToolFragment) = .empty,
    routed_model: ?[]u8 = null,
    finish_reason: ?types.ProviderFinishReason = null,
    failure_detail: ?[]u8 = null,
    usage: types.Usage = .{},
    payload_bytes: usize = 0,

    fn deinit(self: *@This()) void {
        self.content.deinit(self.alloc);
        self.reasoning.deinit(self.alloc);
        if (self.reasoning_details) |details| self.alloc.free(details);
        self.reasoning_details = null;
        for (self.tools.items) |*fragment| fragment.deinit(self.alloc);
        self.tools.deinit(self.alloc);
        if (self.routed_model) |routed| self.alloc.free(routed);
        self.routed_model = null;
        if (self.failure_detail) |detail| self.alloc.free(detail);
        self.failure_detail = null;
    }

    fn consumeStream(
        self: *@This(),
        reader: *std.Io.Reader,
        cancel_flag: *std.atomic.Value(bool),
        silence: *StreamSilence,
    ) !void {
        var event_reader = gateway_client.SseEventReader{ .max_line_bytes = max_response_bytes };
        defer event_reader.deinit(self.alloc);

        while (true) {
            if (cancel_flag.load(.seq_cst)) return error.Cancelled;
            const event = try event_reader.next(self.alloc, reader);
            silence.touch();
            defer event_reader.releaseLine();
            switch (event) {
                .data => |json_text| try self.consume(json_text),
                .done, .eof => return,
                .ignored => {},
                .read_failed => {
                    if (cancel_flag.load(.seq_cst)) return error.Cancelled;
                    return error.InvalidProviderResponse;
                },
            }
        }
    }

    fn countPayload(self: *@This(), len: usize) !void {
        self.payload_bytes += len;
        if (self.payload_bytes > max_response_bytes) return error.ResponseTooLarge;
    }

    fn consume(self: *@This(), json_text: []const u8) !void {
        var parsed = std.json.parseFromSlice(std.json.Value, self.alloc, json_text, .{}) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            else => return,
        };
        defer parsed.deinit();
        if (parsed.value != .object) return;
        const root = parsed.value.object;

        if (self.routed_model == null) {
            if (jsonStringField(root, "model")) |routed| {
                if (routed.len > 0 and routed.len <= max_routed_model_bytes) {
                    self.routed_model = try self.alloc.dupe(u8, routed);
                }
            }
        }
        if (root.get("usage")) |usage| {
            if (usage == .object) {
                self.usage = .{
                    .input_tokens = tokenCount(usage.object.get("prompt_tokens")),
                    .output_tokens = tokenCount(usage.object.get("completion_tokens")),
                    .cache_read_tokens = cacheReadTokenCount(usage.object),
                    .cache_write_tokens = cacheWriteTokenCount(usage.object),
                    .cost_micro_usd = costMicroUsd(usage.object.get("cost")),
                };
            }
        }

        if (root.get("error")) |raised| {
            if (raised == .object or (raised == .string and raised.string.len > 0)) {
                try gateway_client.captureProviderFailureDetail(self.alloc, &self.failure_detail, parsed.value);
                self.finish_reason = .provider_error;
                return;
            }
        }

        const choices = root.get("choices") orelse return;
        if (choices != .array or choices.array.items.len == 0) return;
        const choice = choices.array.items[0];
        if (choice != .object) return;

        if (jsonStringField(choice.object, "finish_reason")) |reason| {
            if (finishReason(reason)) |parsed_reason| self.finish_reason = parsed_reason;
        }

        const delta = choice.object.get("delta") orelse return;
        if (delta != .object) return;

        if (jsonStringField(delta.object, "content")) |text| try self.appendContent(text);
        if (jsonStringField(delta.object, "reasoning") orelse
            jsonStringField(delta.object, "reasoning_content")) |text| try self.appendReasoning(text);
        if (delta.object.get("reasoning_details")) |details| try self.captureReasoningDetails(details);
        if (delta.object.get("tool_calls")) |calls| try self.appendToolCalls(calls);
    }

    fn appendContent(self: *@This(), text: []const u8) !void {
        if (text.len == 0) return;
        try self.countPayload(text.len);
        if (self.content.items.len + text.len > max_content_bytes) return error.InvalidProviderResponse;
        try self.content.appendSlice(self.alloc, text);
        self.request.on_content_chunk(self.request.callback_ctx, text);
    }

    fn appendReasoning(self: *@This(), text: []const u8) !void {
        if (text.len == 0) return;
        try self.countPayload(text.len);
        if (self.request.on_reasoning_chunk) |on_reasoning| {
            on_reasoning(self.request.callback_ctx, text);
        }
        if (self.reasoning_dropped) return;
        if (self.reasoning.items.len + text.len > max_content_bytes) {
            self.reasoning_dropped = true;
            self.reasoning.clearAndFree(self.alloc);
            return;
        }
        try self.reasoning.appendSlice(self.alloc, text);
    }

    fn captureReasoningDetails(self: *@This(), value: std.json.Value) !void {
        if (value == .null) return;
        var out: std.Io.Writer.Allocating = .init(self.alloc);
        defer out.deinit();
        try std.json.Stringify.value(value, .{}, &out.writer);
        if (out.written().len > max_content_bytes) return;
        const raw = try self.alloc.dupe(u8, out.written());
        if (self.reasoning_details) |old| self.alloc.free(old);
        self.reasoning_details = raw;
    }

    fn appendToolCalls(self: *@This(), value: std.json.Value) !void {
        if (value != .array) return;
        for (value.array.items) |entry| {
            if (entry != .object) continue;
            const index: i64 = if (entry.object.get("index")) |raw| switch (raw) {
                .integer => |number| number,
                else => 0,
            } else 0;
            const fragment = try self.fragmentFor(index);

            if (jsonStringField(entry.object, "id")) |id| {
                if (fragment.id.items.len == 0 and id.len <= max_routed_model_bytes) {
                    try fragment.id.appendSlice(self.alloc, id);
                }
            }
            const function = entry.object.get("function") orelse continue;
            if (function != .object) continue;
            if (jsonStringField(function.object, "name")) |name| {
                if (fragment.name.items.len == 0 and name.len <= max_routed_model_bytes) {
                    try fragment.name.appendSlice(self.alloc, name);
                }
            }
            const arguments = jsonStringField(function.object, "arguments") orelse continue;
            if (arguments.len == 0) continue;
            try self.countPayload(arguments.len);
            if (fragment.arguments.items.len + arguments.len > max_content_bytes) {
                return error.InvalidProviderResponse;
            }
            try fragment.arguments.appendSlice(self.alloc, arguments);
            if (self.request.on_tool_input_chunk) |on_chunk| {
                on_chunk(self.request.callback_ctx, arguments);
            }
        }
    }

    fn fragmentFor(self: *@This(), index: i64) !*SseToolFragment {
        for (self.tools.items) |*fragment| {
            if (fragment.index == index) return fragment;
        }
        if (self.tools.items.len >= max_tool_calls_per_step) return error.InvalidProviderResponse;
        try self.tools.append(self.alloc, .{ .index = index });
        return &self.tools.items[self.tools.items.len - 1];
    }

    fn finish(self: *@This()) !types.GatewayCompletion {
        if (!std.unicode.utf8ValidateSlice(self.content.items)) return error.InvalidProviderResponse;

        var completion: types.GatewayCompletion = .{};
        errdefer freeCompletion(self.alloc, &completion);

        var list: std.ArrayList(types.ToolCall) = .empty;
        errdefer {
            for (list.items) |call| types.freeToolCall(self.alloc, call);
            list.deinit(self.alloc);
        }
        for (self.tools.items) |fragment| {
            if (fragment.name.items.len == 0) {
                if (fragment.arguments.items.len > 0) return error.InvalidProviderResponse;
                continue;
            }
            const call = try types.dupeToolCall(self.alloc, .{
                .id = fragment.id.items,
                .name = fragment.name.items,
                .arguments_json = if (fragment.arguments.items.len == 0) "{}" else fragment.arguments.items,
            });
            errdefer types.freeToolCall(self.alloc, call);
            try list.append(self.alloc, call);
        }
        completion.tool_calls = try list.toOwnedSlice(self.alloc);

        completion.finish_reason = self.finish_reason;
        const disposition = types.classifyProviderCompletion(completion);
        if (self.content.items.len == 0 and completion.tool_calls.len == 0 and
            disposition != .provider_failure and disposition != .length_limited)
        {
            return error.InvalidProviderResponse;
        }
        if (self.failure_detail) |detail| {
            completion.provider_failure_detail = detail;
            self.failure_detail = null;
        }
        completion.content = try self.alloc.dupe(u8, self.content.items);
        if (!self.reasoning_dropped and
            self.reasoning.items.len > 0 and
            std.unicode.utf8ValidateSlice(self.reasoning.items))
        {
            completion.reasoning = try self.alloc.dupe(u8, self.reasoning.items);
        }
        if (self.reasoning_details) |details| {
            completion.reasoning_details_json = details;
            self.reasoning_details = null;
        }
        if (self.routed_model) |routed| {
            completion.routed_model = routed;
            self.routed_model = null;
        }
        completion.usage = self.usage;
        return completion;
    }
};

const PostOutcome = struct {
    status: std.http.Status,
    streamed: bool,
};

const PostCall = struct {
    client: *std.http.Client,
    url: []const u8,
    headers: std.http.Client.Request.Headers,
    extra_headers: []const std.http.Header,
    payload: []const u8,
    out: *std.Io.Writer.Allocating,
    sink: *SseSink,
    cancel_flag: *std.atomic.Value(bool),
    silence: *StreamSilence,

    fn run(self: PostCall) anyerror!PostOutcome {
        const uri = try std.Uri.parse(self.url);
        var request = try self.client.request(.POST, uri, .{
            .headers = self.headers,
            .extra_headers = self.extra_headers,
            .redirect_behavior = .unhandled,
        });
        defer request.deinit();
        try request.sendBodyComplete(@constCast(self.payload));

        var response = try request.receiveHead(&.{});
        const status = response.head.status;
        const decompress_buffer: []u8 = switch (response.head.content_encoding) {
            .identity => &.{},
            .zstd => try self.client.allocator.alloc(u8, std.compress.zstd.default_window_len),
            .deflate, .gzip => try self.client.allocator.alloc(u8, std.compress.flate.max_window_len),
            .compress => return error.UnsupportedCompressionMethod,
        };
        defer if (decompress_buffer.len > 0) self.client.allocator.free(decompress_buffer);

        const content_type = gateway_client.findHeaderValue(response.head, "content-type") orelse "";
        const streamed = status == .ok and
            std.ascii.indexOfIgnoreCase(content_type, "text/event-stream") != null;

        var transfer_buffer: [sse_transfer_buffer_bytes]u8 = undefined;
        var decompress: std.http.Decompress = undefined;
        const reader = response.readerDecompressing(&transfer_buffer, &decompress, decompress_buffer);
        if (streamed) {
            try self.sink.consumeStream(reader, self.cancel_flag, self.silence);
            return .{ .status = status, .streamed = true };
        }
        _ = reader.streamRemaining(&self.out.writer) catch |err| switch (err) {
            error.ReadFailed => return response.bodyErr() orelse if (self.cancel_flag.load(.seq_cst)) error.Cancelled else error.ReadFailed,
            else => |other| return other,
        };
        return .{ .status = status, .streamed = false };
    }
};

fn post(call: PostCall) anyerror!PostOutcome {
    const Event = union(enum) {
        posted: anyerror!PostOutcome,
        cancelled: anyerror!void,
        silent: anyerror!void,
    };
    var buffer: [3]Event = undefined;
    var select: std.Io.Select(Event) = .init(io_mod.getIo(), &buffer);
    try select.concurrent(.cancelled, gateway_client.waitForBoundedCancellation, .{call.cancel_flag});
    try select.concurrent(.silent, waitForStreamSilence, .{call.silence});
    select.concurrent(.posted, PostCall.run, .{call}) catch |err| {
        select.cancelDiscard();
        return err;
    };
    const event = select.await() catch |err| {
        select.cancelDiscard();
        return err;
    };
    select.cancelDiscard();
    switch (event) {
        .posted => |result| return if (call.cancel_flag.load(.seq_cst)) error.Cancelled else result,
        .cancelled => |result| {
            try result;
            return error.Cancelled;
        },
        .silent => |result| {
            try result;
            return error.Timeout;
        },
    }
}

fn freeCompletion(alloc: Allocator, completion: *types.GatewayCompletion) void {
    if (completion.routed_model) |routed| alloc.free(@constCast(routed));
    if (completion.content) |content| alloc.free(@constCast(content));
    if (completion.reasoning) |reasoning| alloc.free(@constCast(reasoning));
    if (completion.reasoning_details_json) |details| alloc.free(@constCast(details));
    types.freeToolCallSlice(alloc, @constCast(completion.tool_calls));
    if (completion.provider_failure_detail) |detail| alloc.free(@constCast(detail));
    completion.* = .{};
}

const trace_body_bytes = 600;

fn parseCompletion(alloc: Allocator, body: []const u8) !types.GatewayCompletion {
    errdefer debug_trace.logf(
        "emma_openai",
        "unparseable_completion body={s}",
        .{body[0..@min(body.len, trace_body_bytes)]},
    );
    var parsed = std.json.parseFromSlice(std.json.Value, alloc, body, .{}) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidProviderResponse,
    };
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidProviderResponse;

    if (parsed.value.object.get("error")) |raised| {
        if (raised == .object or (raised == .string and raised.string.len > 0)) {
            var detail: ?[]u8 = null;
            errdefer if (detail) |value| alloc.free(value);
            try gateway_client.captureProviderFailureDetail(alloc, &detail, parsed.value);
            return .{
                .finish_reason = .provider_error,
                .provider_failure_detail = detail,
                .content = try alloc.dupe(u8, ""),
            };
        }
    }

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

    const reasoning: []const u8 = if (message.object.get("reasoning")) |value| switch (value) {
        .string => |text| text,
        else => "",
    } else "";

    var completion: types.GatewayCompletion = .{};
    errdefer freeCompletion(alloc, &completion);
    if (parsed.value.object.get("model")) |routed| {
        if (routed == .string and routed.string.len > 0 and routed.string.len <= max_routed_model_bytes) {
            completion.routed_model = try alloc.dupe(u8, routed.string);
        }
    }
    completion.tool_calls = try parseToolCalls(alloc, message.object.get("tool_calls"));

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
                .cache_read_tokens = cacheReadTokenCount(usage.object),
                .cache_write_tokens = cacheWriteTokenCount(usage.object),
                .cost_micro_usd = costMicroUsd(usage.object.get("cost")),
            };
        }
    }
    return completion;
}

fn finishReason(raw: []const u8) ?types.ProviderFinishReason {
    if (raw.len == 0) return null;
    if (std.mem.eql(u8, raw, "function_call")) return .tool_calls;
    return types.ProviderFinishReason.parse_legacy(raw) orelse .other;
}

fn tokenCount(value: ?std.json.Value) ?u64 {
    const found = value orelse return null;
    return switch (found) {
        .integer => |count| if (count < 0) null else @intCast(count),
        .number_string => |text| std.fmt.parseInt(u64, text, 10) catch null,
        else => null,
    };
}

fn cacheReadTokenCount(usage: std.json.ObjectMap) ?u64 {
    const details = usage.get("prompt_tokens_details") orelse return null;
    if (details != .object) return null;
    return tokenCount(details.object.get("cached_tokens"));
}

fn cacheWriteTokenCount(usage: std.json.ObjectMap) ?u64 {
    const details = usage.get("prompt_tokens_details") orelse return null;
    if (details != .object) return null;
    return tokenCount(details.object.get("cache_creation_tokens"));
}

fn costMicroUsd(value: ?std.json.Value) ?u64 {
    const found = value orelse return null;
    return switch (found) {
        .string => |text| types.parseMicroDollars(text),
        .number_string => |text| types.parseMicroDollars(text),
        .integer => |number| if (number >= 0)
            std.math.mul(u64, std.math.cast(u64, number) orelse return null, 1_000_000) catch null
        else
            null,
        .float => |number| types.microDollarsFromFloat(number),
        else => null,
    };
}

fn parseToolCalls(alloc: Allocator, value: ?std.json.Value) ![]const types.ToolCall {
    const calls = value orelse return &.{};
    if (calls != .array or calls.array.items.len == 0) return &.{};
    if (calls.array.items.len > max_tool_calls_per_step) return error.InvalidProviderResponse;

    var list: std.ArrayList(types.ToolCall) = .empty;
    errdefer {
        for (list.items) |call| types.freeToolCall(alloc, call);
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

        const call = try types.dupeToolCall(alloc, .{
            .id = id,
            .name = name.string,
            .arguments_json = arguments,
        });
        errdefer types.freeToolCall(alloc, call);
        try list.append(alloc, call);
    }

    return try list.toOwnedSlice(alloc);
}

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

    try std.testing.expect(std.mem.indexOf(u8, body, "\"messages\":[") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"prompt\":[") == null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"tool_choice\":\"auto\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"toolChoice\"") == null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"function\":{\"name\":\"read_file\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"parameters\":{\"type\":\"object\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"inputSchema\"") == null);
}

test "native request marks one stable cache boundary" {
    const alloc = std.testing.allocator;
    const messages = [_]types.ChatMessage{
        .{ .role = .system, .content = "stable system" },
        .{ .role = .user, .content = "first question" },
        .{ .role = .assistant, .content = "first answer" },
        .{ .role = .user, .content = "current question" },
    };
    const body = try build(null, alloc, .{
        .model = "anthropic/claude-sonnet-4.5",
        .serialized_tools = "[]",
        .messages = &messages,
        .tool_choice = .auto,
        .provider_options = .{ .prompt_caching = true },
    });
    defer alloc.free(body);

    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, body, "\"cache_control\":{\"type\":\"ephemeral\"}"));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, body, "\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"1h\"}"));
    try std.testing.expect(std.mem.indexOf(u8, body, "\"text\":\"stable system\",\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"1h\"}") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"content\":\"first question\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"text\":\"first answer\",\"cache_control\":{\"type\":\"ephemeral\"}") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"text\":\"current question\",\"cache_control\":{\"type\":\"ephemeral\"}") != null);
}

test "native request keys the prompt cache to the session on cache-aware hosts" {
    const alloc = std.testing.allocator;
    const messages = [_]types.ChatMessage{
        .{ .role = .system, .content = "stable system" },
        .{ .role = .user, .content = "question" },
    };
    const body = try build(null, alloc, .{
        .model = "openai/gpt-5",
        .serialized_tools = "[]",
        .messages = &messages,
        .tool_choice = .auto,
        .provider_options = .{},
        .session_id = "session-abc",
    });
    defer alloc.free(body);
    const expected = openRouterSessionId("session-abc");
    const key_idx = std.mem.indexOf(u8, body, "\"prompt_cache_key\":\"") orelse return error.TestExpectedCacheKey;
    try std.testing.expect(std.mem.startsWith(u8, body[key_idx + "\"prompt_cache_key\":\"".len ..], expected[0..]));
    try std.testing.expect(std.mem.indexOf(u8, body, "session-abc") == null);

    const keyless = try build(null, alloc, .{
        .model = "openai/gpt-5",
        .serialized_tools = "[]",
        .messages = &messages,
        .tool_choice = .auto,
        .provider_options = .{},
    });
    defer alloc.free(keyless);
    try std.testing.expect(std.mem.indexOf(u8, keyless, "prompt_cache_key") == null);
    try std.testing.expect(promptCacheKeyTarget("http://127.0.0.1:4321/v1/chat/completions"));
    try std.testing.expect(!promptCacheKeyTarget("https://vision.example/v1/chat/completions"));
}

test "native request stops cache markers after a no-cache message" {
    const alloc = std.testing.allocator;
    const messages = [_]types.ChatMessage{
        .{ .role = .system, .content = "stable system" },
        .{ .role = .system, .content = "volatile overlay", .cache_policy = .no_cache },
        .{ .role = .user, .content = "first question" },
        .{ .role = .assistant, .content = "first answer" },
        .{ .role = .user, .content = "current question" },
    };
    const body = try build(null, alloc, .{
        .model = "anthropic/claude-sonnet-4.5",
        .serialized_tools = "[]",
        .messages = &messages,
        .tool_choice = .auto,
        .provider_options = .{ .prompt_caching = true },
    });
    defer alloc.free(body);

    try std.testing.expectEqual(@as(usize, 0), std.mem.count(u8, body, "\"cache_control\":{\"type\":\"ephemeral\"}"));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, body, "\"cache_control\":{\"type\":\"ephemeral\",\"ttl\":\"1h\"}"));
    const overlay = std.mem.indexOf(u8, body, "volatile overlay") orelse return error.TestExpectedOverlay;
    try std.testing.expect(std.mem.indexOf(u8, body[overlay..], "cache_control") == null);
}

test "native request omits cache markers when disabled or unsupported" {
    const alloc = std.testing.allocator;
    const messages = [_]types.ChatMessage{
        .{ .role = .system, .content = "stable system" },
        .{ .role = .user, .content = "first question" },
        .{ .role = .assistant, .content = "first answer" },
        .{ .role = .user, .content = "current question" },
    };
    const cases = [_]struct {
        model: []const u8,
        prompt_caching: bool,
    }{
        .{ .model = "anthropic/claude-sonnet-4.5", .prompt_caching = false },
        .{ .model = "openai/gpt-5", .prompt_caching = true },
    };
    for (cases) |case| {
        const body = try build(null, alloc, .{
            .model = case.model,
            .serialized_tools = "[]",
            .messages = &messages,
            .tool_choice = .auto,
            .provider_options = .{ .prompt_caching = case.prompt_caching },
        });
        defer alloc.free(body);
        try std.testing.expect(std.mem.indexOf(u8, body, "cache_control") == null);
    }
}

test "native request preserves text and tool content around cache markers" {
    const alloc = std.testing.allocator;
    const calls = [_]types.ToolCall{.{
        .id = "call_1",
        .name = "read_file",
        .arguments_json = "{\"path\":\"README.md\"}",
    }};
    const messages = [_]types.ChatMessage{
        .{ .role = .system, .content = "stable system" },
        .{ .role = .user, .content = "read README.md" },
        .{ .role = .assistant, .content = "Reading README.md", .tool_calls = &calls },
        .{ .role = .tool, .content = "README contents", .tool_call_id = "call_1", .tool_name = "read_file" },
        .{ .role = .user, .content = "summarize it" },
    };
    const body = try build(null, alloc, .{
        .model = "anthropic/claude-sonnet-4.5",
        .serialized_tools = "[]",
        .messages = &messages,
        .tool_choice = .auto,
        .provider_options = .{ .prompt_caching = true },
    });
    defer alloc.free(body);

    try std.testing.expect(std.mem.indexOf(u8, body, "\"content\":\"Reading README.md\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"tool_call_id\":\"call_1\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"name\":\"read_file\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"text\":\"README contents\",\"cache_control\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"text\":\"summarize it\",\"cache_control\"") != null);
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

    try std.testing.expect(!zeroRetentionRequested());
    try std.testing.expect(std.mem.indexOf(u8, body, "\"zdr\":true") == null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"data_collection\"") == null);
    try std.testing.expectEqualStrings("EMMA_OPENROUTER_ZDR", zero_retention_env);
}

test "native OpenRouter session affinity is opaque stable and endpoint scoped" {
    const url = "https://openrouter.ai/api/v1/chat/completions";
    var first_value: [openrouter_session_id_bytes]u8 = undefined;
    var repeat_value: [openrouter_session_id_bytes]u8 = undefined;
    var different_value: [openrouter_session_id_bytes]u8 = undefined;
    const raw_session = "/Users/tronschell/Documents/emma/private user prompt";
    const first = openRouterSessionHeader(url, raw_session, &first_value);
    const repeat = openRouterSessionHeader(url, raw_session, &repeat_value);
    const different = openRouterSessionHeader(url, "another thread", &different_value);

    try std.testing.expect(first != null);
    try std.testing.expect(repeat != null);
    try std.testing.expect(different != null);
    try std.testing.expectEqualStrings("x-session-id", first.?.name);
    try std.testing.expectEqualStrings(first.?.value, repeat.?.value);
    try std.testing.expect(!std.mem.eql(u8, first.?.value, different.?.value));
    try std.testing.expect(std.mem.indexOf(u8, first.?.value, raw_session) == null);
    try std.testing.expect(openRouterSessionHeader("http://127.0.0.1:8099/v1/chat/completions", raw_session, &different_value) == null);
    try std.testing.expect(openRouterSessionHeader("https://example.com/https://openrouter.ai/api/v1/chat/completions", raw_session, &different_value) == null);
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
    try std.testing.expect(std.mem.indexOf(u8, body, "\"tool_choice\"") == null);
}

test "completion parsing accepts content, tool calls, and usage but rejects empty turns" {
    const alloc = std.testing.allocator;

    var text = try parseCompletion(alloc,
        \\{"choices":[{"message":{"content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2,"cache_creation_tokens":4},"cost":"0.005678"}}
    );
    defer freeCompletion(alloc, &text);
    try std.testing.expectEqualStrings("hello", text.content.?);
    try std.testing.expectEqual(@as(?u64, 7), text.usage.input_tokens);
    try std.testing.expectEqual(@as(?u64, 3), text.usage.output_tokens);
    try std.testing.expectEqual(@as(?u64, 2), text.usage.cache_read_tokens);
    try std.testing.expectEqual(@as(?u64, 4), text.usage.cache_write_tokens);
    try std.testing.expectEqual(@as(?u64, 5_678), text.usage.cost_micro_usd);

    var called = try parseCompletion(alloc,
        \\{"choices":[{"message":{"content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"bash","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}
    );
    defer freeCompletion(alloc, &called);
    try std.testing.expectEqual(@as(usize, 1), called.tool_calls.len);
    try std.testing.expectEqualStrings("bash", called.tool_calls[0].name);
    try std.testing.expectEqualStrings("call_1", called.tool_calls[0].id);

    var reasoned = try parseCompletion(alloc,
        \\{"choices":[{"message":{"content":"4","reasoning":"two plus two"}}]}
    );
    defer freeCompletion(alloc, &reasoned);
    try std.testing.expectEqualStrings("4", reasoned.content.?);
    try std.testing.expectEqualStrings("two plus two", reasoned.reasoning.?);
    try std.testing.expect(text.reasoning == null);

    try std.testing.expectError(error.InvalidProviderResponse, parseCompletion(alloc,
        \\{"choices":[{"message":{"content":""}}]}
    ));
    try std.testing.expectError(error.InvalidProviderResponse, parseCompletion(alloc, "{}"));
}

test "a buffered error object is a provider failure, not an unparseable completion" {
    const alloc = std.testing.allocator;

    var completion = try parseCompletion(alloc,
        \\{"error":{"code":"1210","message":"context length exceeded for this model"}}
    );
    defer freeCompletion(alloc, &completion);

    try std.testing.expectEqual(types.ProviderFinishReason.provider_error, completion.finish_reason.?);
    try std.testing.expectEqual(
        types.ProviderCompletionDisposition.provider_failure,
        types.classifyProviderCompletion(completion),
    );
    try std.testing.expectEqualStrings("1210: context length exceeded for this model", completion.provider_failure_detail.?);
}

test "completion parsing frees earlier tool calls when a later call is invalid" {
    try std.testing.expectError(error.InvalidProviderResponse, parseCompletion(std.testing.allocator,
        \\{"model":"test/model","choices":[{"message":{"tool_calls":[{"id":"call_1","function":{"name":"read_file","arguments":"{}"}},null]}}]}
    ));
}

test "completion parsing frees every allocation on failure" {
    const Check = struct {
        fn run(alloc: Allocator) !void {
            var completion = try parseCompletion(alloc,
                \\{"model":"test/model","choices":[{"message":{"content":"hello","reasoning":"thinking","tool_calls":[{"id":"call_1","function":{"name":"read_file","arguments":"{}"}},{"id":"call_2","function":{"name":"list_files","arguments":"{}"}}]}}]}
            );
            defer freeCompletion(alloc, &completion);
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Check.run, .{});
}

const StreamCapture = struct {
    alloc: Allocator,
    text: std.ArrayList(u8) = .empty,
    reasoning: std.ArrayList(u8) = .empty,
    content_chunks: usize = 0,
    tool_inputs: std.ArrayList(u8) = .empty,
    started: std.ArrayList(u8) = .empty,
    cancel_flag: ?*std.atomic.Value(bool) = null,
    cancel_after_chunks: usize = 0,
    failed: bool = false,

    fn deinit(self: *@This()) void {
        self.text.deinit(self.alloc);
        self.reasoning.deinit(self.alloc);
        self.tool_inputs.deinit(self.alloc);
        self.started.deinit(self.alloc);
    }

    fn onContent(raw: *anyopaque, chunk: []const u8) void {
        const self: *@This() = @ptrCast(@alignCast(raw));
        self.content_chunks += 1;
        self.text.appendSlice(self.alloc, chunk) catch {
            self.failed = true;
        };
        if (self.cancel_flag) |flag| {
            if (self.content_chunks >= self.cancel_after_chunks) flag.store(true, .seq_cst);
        }
    }

    fn onReasoning(raw: *anyopaque, chunk: []const u8) void {
        const self: *@This() = @ptrCast(@alignCast(raw));
        self.reasoning.appendSlice(self.alloc, chunk) catch {
            self.failed = true;
        };
    }

    fn onToolInput(raw: *anyopaque, chunk: []const u8) void {
        const self: *@This() = @ptrCast(@alignCast(raw));
        self.tool_inputs.appendSlice(self.alloc, chunk) catch {
            self.failed = true;
        };
    }

    fn onToolStart(raw: *anyopaque, tool_id: []const u8, tool_name: []const u8, _: ?[]const u8) void {
        const self: *@This() = @ptrCast(@alignCast(raw));
        self.started.appendSlice(self.alloc, tool_id) catch {
            self.failed = true;
        };
        self.started.append(self.alloc, ':') catch {
            self.failed = true;
        };
        self.started.appendSlice(self.alloc, tool_name) catch {
            self.failed = true;
        };
        self.started.append(self.alloc, ';') catch {
            self.failed = true;
        };
    }
};

const StreamHarness = struct {
    capture: StreamCapture,
    delivery: stream_provider.DeliveryCertainty = .{},
    attempt_evidence: stream_provider.AttemptEvidence = .{},
    cancel_flag: std.atomic.Value(bool) = .init(false),
    request: stream_provider.Request = undefined,

    fn init(alloc: Allocator) StreamHarness {
        return .{ .capture = .{ .alloc = alloc } };
    }

    fn bind(self: *@This(), chat_url: []const u8) void {
        self.request = .{
            .api_key = "test-key",
            .model = "test/model",
            .retry_count = 1,
            .chat_url = chat_url,
            .payload = "{}",
            .trace_ctx = .{},
            .content_capture_limit = null,
            .delivery = &self.delivery,
            .attempt_evidence = &self.attempt_evidence,
            .callback_ctx = @ptrCast(&self.capture),
            .on_content_chunk = StreamCapture.onContent,
            .on_tool_start = StreamCapture.onToolStart,
            .on_reasoning_chunk = StreamCapture.onReasoning,
            .on_tool_input_chunk = StreamCapture.onToolInput,
            .cancel_flag = &self.cancel_flag,
        };
    }

    fn deinit(self: *@This()) void {
        self.capture.deinit();
    }
};

fn consumeSseForTest(
    harness: *StreamHarness,
    payload: []const u8,
    transfer_buffer: []u8,
) !types.GatewayCompletion {
    harness.bind("");
    var sink: SseSink = .{ .alloc = harness.capture.alloc, .request = &harness.request };
    defer sink.deinit();
    var source = std.Io.Reader.fixed(payload);
    var buffered = source.limited(.unlimited, transfer_buffer);
    var silence = StreamSilence.init(0);
    try sink.consumeStream(&buffered.interface, &harness.cancel_flag, &silence);
    return sink.finish();
}

test "text deltas reach the callback one at a time and concatenate" {
    const alloc = std.testing.allocator;
    var harness = StreamHarness.init(alloc);
    defer harness.deinit();

    const payload =
        "data: {\"model\":\"test/routed\",\"choices\":[{\"delta\":{\"reasoning\":\"think\"}}]}\n\n" ++
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n" ++
        "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n" ++
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"prompt_tokens_details\":{\"cached_tokens\":3,\"cache_creation_tokens\":1},\"cost\":\"0.001234\"}}\n\n" ++
        "data: [DONE]\n\n" ++
        "data: {\"choices\":[{\"delta\":{\"content\":\"ignored\"}}]}\n\n";

    var transfer_buffer: [4096]u8 = undefined;
    var completion = try consumeSseForTest(&harness, payload, &transfer_buffer);
    defer freeCompletion(alloc, &completion);

    try std.testing.expect(!harness.capture.failed);
    try std.testing.expectEqual(@as(usize, 2), harness.capture.content_chunks);
    try std.testing.expectEqualStrings("Hello", harness.capture.text.items);
    try std.testing.expectEqualStrings("Hello", completion.content.?);
    try std.testing.expectEqualStrings("think", harness.capture.reasoning.items);
    try std.testing.expectEqualStrings("think", completion.reasoning.?);
    try std.testing.expectEqualStrings("test/routed", completion.routed_model.?);
    try std.testing.expectEqual(types.ProviderFinishReason.stop, completion.finish_reason.?);
    try std.testing.expectEqual(@as(?u64, 5), completion.usage.input_tokens);
    try std.testing.expectEqual(@as(?u64, 2), completion.usage.output_tokens);
    try std.testing.expectEqual(@as(?u64, 3), completion.usage.cache_read_tokens);
    try std.testing.expectEqual(@as(?u64, 1), completion.usage.cache_write_tokens);
    try std.testing.expectEqual(@as(?u64, 1_234), completion.usage.cost_micro_usd);
}

test "a provider-finished stream keeps its finish reason instead of reading as interrupted" {
    const alloc = std.testing.allocator;
    var harness = StreamHarness.init(alloc);
    defer harness.deinit();

    const payload =
        "data: {\"choices\":[{\"delta\":{\"content\":\"I cannot help with\"},\"finish_reason\":\"content_filter\"}]}\n\n" ++
        "data: [DONE]\n\n";

    var transfer_buffer: [4096]u8 = undefined;
    var completion = try consumeSseForTest(&harness, payload, &transfer_buffer);
    defer freeCompletion(alloc, &completion);

    try std.testing.expectEqual(types.ProviderFinishReason.content_filter, completion.finish_reason.?);
    try std.testing.expectEqual(types.ProviderCompletionDisposition.provider_failure, types.classifyProviderCompletion(completion));
    try std.testing.expectEqual(types.ProviderFinishReason.other, finishReason("recitation").?);
    try std.testing.expect(finishReason("") == null);

    var empty_harness = StreamHarness.init(alloc);
    defer empty_harness.deinit();
    var empty_completion = try consumeSseForTest(
        &empty_harness,
        "data: {\"choices\":[{\"delta\":{\"content\":\"\"},\"finish_reason\":\"content_filter\"}]}\n\ndata: [DONE]\n\n",
        &transfer_buffer,
    );
    defer freeCompletion(alloc, &empty_completion);
    try std.testing.expectEqual(types.ProviderFinishReason.content_filter, empty_completion.finish_reason.?);
}

test "a reasoning-only stream that hits the length limit finishes instead of erroring" {
    const alloc = std.testing.allocator;
    var transfer_buffer: [4096]u8 = undefined;

    var harness = StreamHarness.init(alloc);
    defer harness.deinit();
    var completion = try consumeSseForTest(
        &harness,
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking hard\"}}]}\n\n" ++
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\" and harder\"}}]}\n\n" ++
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n" ++
            "data: [DONE]\n\n",
        &transfer_buffer,
    );
    defer freeCompletion(alloc, &completion);
    try std.testing.expectEqual(types.ProviderFinishReason.length, completion.finish_reason.?);
    try std.testing.expectEqual(types.ProviderCompletionDisposition.length_limited, types.classifyProviderCompletion(completion));
    try std.testing.expectEqualStrings("", completion.content.?);

    var stop_harness = StreamHarness.init(alloc);
    defer stop_harness.deinit();
    try std.testing.expectError(error.InvalidProviderResponse, consumeSseForTest(
        &stop_harness,
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking hard\"}}]}\n\n" ++
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" ++
            "data: [DONE]\n\n",
        &transfer_buffer,
    ));
}

test "an SSE frame split across a read boundary still parses" {
    const alloc = std.testing.allocator;
    var harness = StreamHarness.init(alloc);
    defer harness.deinit();

    var long: std.ArrayList(u8) = .empty;
    defer long.deinit(alloc);
    try long.appendNTimes(alloc, 'x', 700);

    const payload = try std.fmt.allocPrint(
        alloc,
        "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{s}\"}}}}]}}\n\ndata: [DONE]\n\n",
        .{long.items},
    );
    defer alloc.free(payload);

    var transfer_buffer: [64]u8 = undefined;
    var completion = try consumeSseForTest(&harness, payload, &transfer_buffer);
    defer freeCompletion(alloc, &completion);

    try std.testing.expect(!harness.capture.failed);
    try std.testing.expectEqualStrings(long.items, completion.content.?);
    try std.testing.expectEqual(@as(usize, 1), harness.capture.content_chunks);
}

test "tool call arguments are assembled from fragments across events" {
    const alloc = std.testing.allocator;
    var harness = StreamHarness.init(alloc);
    defer harness.deinit();

    const payload =
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]}}]}\n\n" ++
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\n" ++
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_2\",\"function\":{\"name\":\"list_files\",\"arguments\":\"{}\"}}]}}]}\n\n" ++
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.txt\\\"}\"}}]}}]}\n\n" ++
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n" ++
        "data: [DONE]\n\n";

    var transfer_buffer: [128]u8 = undefined;
    var completion = try consumeSseForTest(&harness, payload, &transfer_buffer);
    defer freeCompletion(alloc, &completion);

    try std.testing.expectEqual(@as(usize, 2), completion.tool_calls.len);
    try std.testing.expectEqualStrings("call_1", completion.tool_calls[0].id);
    try std.testing.expectEqualStrings("read_file", completion.tool_calls[0].name);
    try std.testing.expectEqualStrings("{\"path\":\"a.txt\"}", completion.tool_calls[0].arguments_json);
    try std.testing.expectEqualStrings("call_2", completion.tool_calls[1].id);
    try std.testing.expectEqualStrings("{}", completion.tool_calls[1].arguments_json);
    try std.testing.expectEqual(types.ProviderFinishReason.tool_calls, completion.finish_reason.?);
    try std.testing.expectEqualStrings("{\"path\":{}\"a.txt\"}", harness.capture.tool_inputs.items);
}

test "streaming holds the buffered bounds on tool call count and argument size" {
    const alloc = std.testing.allocator;
    var harness = StreamHarness.init(alloc);
    defer harness.deinit();
    harness.bind("");

    var payload: std.ArrayList(u8) = .empty;
    defer payload.deinit(alloc);
    for (0..max_tool_calls_per_step + 1) |index| {
        try payload.print(
            alloc,
            "data: {{\"choices\":[{{\"delta\":{{\"tool_calls\":[{{\"index\":{d},\"id\":\"c\",\"function\":{{\"name\":\"n\",\"arguments\":\"{{}}\"}}}}]}}}}]}}\n\n",
            .{index},
        );
    }

    var sink: SseSink = .{ .alloc = alloc, .request = &harness.request };
    defer sink.deinit();
    var source = std.Io.Reader.fixed(payload.items);
    var transfer_buffer: [4096]u8 = undefined;
    var buffered = source.limited(.unlimited, &transfer_buffer);
    var silence = StreamSilence.init(0);
    try std.testing.expectError(
        error.InvalidProviderResponse,
        sink.consumeStream(&buffered.interface, &harness.cancel_flag, &silence),
    );
}

test "the response cap counts generated bytes, not SSE envelope bytes" {
    const alloc = std.testing.allocator;
    var harness = StreamHarness.init(alloc);
    defer harness.deinit();
    harness.bind("");

    const envelope = "\"id\":\"chatcmpl-0123456789abcdef0123456789abcdef\",\"object\":\"chat.completion.chunk\",\"created\":1788036149,\"model\":\"z-ai/glm-5.3-flash\",\"system_fingerprint\":\"fp_0123456789\",";
    const chunks = 64;
    var payload: std.ArrayList(u8) = .empty;
    defer payload.deinit(alloc);
    for (0..chunks) |_| {
        try payload.print(
            alloc,
            "data: {{{s}\"choices\":[{{\"index\":0,\"delta\":{{\"reasoning\":\"abcd\"}}}}]}}\n\n",
            .{envelope},
        );
    }
    try payload.appendSlice(alloc, "data: {\"choices\":[{\"delta\":{\"content\":\"done\"}}]}\n\n");
    try payload.appendSlice(alloc, "data: [DONE]\n\n");

    var sink: SseSink = .{ .alloc = alloc, .request = &harness.request };
    defer sink.deinit();
    var source = std.Io.Reader.fixed(payload.items);
    var transfer_buffer: [4096]u8 = undefined;
    var buffered = source.limited(.unlimited, &transfer_buffer);
    var silence = StreamSilence.init(0);
    try sink.consumeStream(&buffered.interface, &harness.cancel_flag, &silence);

    try std.testing.expectEqual(@as(usize, chunks * 4 + 4), sink.payload_bytes);
    try std.testing.expect(payload.items.len > sink.payload_bytes * 20);
}

test "a mid stream cancellation abandons partial state without a leak" {
    const alloc = std.testing.allocator;
    var harness = StreamHarness.init(alloc);
    defer harness.deinit();
    harness.capture.cancel_flag = &harness.cancel_flag;
    harness.capture.cancel_after_chunks = 1;
    harness.bind("");

    const payload =
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\n" ++
        "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n" ++
        "data: {\"choices\":[{\"delta\":{\"content\":\"never\"}}]}\n\n" ++
        "data: [DONE]\n\n";

    var sink: SseSink = .{ .alloc = alloc, .request = &harness.request };
    defer sink.deinit();
    var source = std.Io.Reader.fixed(payload);
    var transfer_buffer: [4096]u8 = undefined;
    var buffered = source.limited(.unlimited, &transfer_buffer);
    var silence = StreamSilence.init(0);

    try std.testing.expectError(
        error.Cancelled,
        sink.consumeStream(&buffered.interface, &harness.cancel_flag, &silence),
    );
    try std.testing.expectEqualStrings("partial", harness.capture.text.items);
}

test "a mid stream error payload fails the turn with the provider message" {
    const alloc = std.testing.allocator;
    var harness = StreamHarness.init(alloc);
    defer harness.deinit();

    const payload =
        "data: {\"error\":null,\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n" ++
        "data: {\"error\":{\"message\":\"You have hit your usage limit.\"}}\n\n" ++
        "data: [DONE]\n\n";

    var transfer_buffer: [4096]u8 = undefined;
    var completion = try consumeSseForTest(&harness, payload, &transfer_buffer);
    defer freeCompletion(alloc, &completion);

    try std.testing.expectEqual(types.ProviderFinishReason.provider_error, completion.finish_reason.?);
    try std.testing.expectEqualStrings("provider_error: You have hit your usage limit.", completion.provider_failure_detail.?);
    try std.testing.expectEqualStrings("Hel", completion.content.?);
}

test "an error payload alone is a provider failure, not an empty turn" {
    const alloc = std.testing.allocator;
    var harness = StreamHarness.init(alloc);
    defer harness.deinit();

    var transfer_buffer: [512]u8 = undefined;
    var completion = try consumeSseForTest(
        &harness,
        "data: {\"error\":{\"message\":\"The ChatGPT run stopped early.\"}}\n\ndata: [DONE]\n\n",
        &transfer_buffer,
    );
    defer freeCompletion(alloc, &completion);

    try std.testing.expectEqual(types.ProviderCompletionDisposition.provider_failure, types.classifyProviderCompletion(completion));
    try std.testing.expectEqualStrings("provider_error: The ChatGPT run stopped early.", completion.provider_failure_detail.?);
}

test "a raw error object streamed without an sse frame still fails the turn" {
    const alloc = std.testing.allocator;
    var harness = StreamHarness.init(alloc);
    defer harness.deinit();

    var transfer_buffer: [512]u8 = undefined;
    var completion = try consumeSseForTest(
        &harness,
        "{\"error\":{\"code\":\"1113\",\"message\":\"insufficient balance\"}}",
        &transfer_buffer,
    );
    defer freeCompletion(alloc, &completion);

    try std.testing.expectEqual(
        types.ProviderCompletionDisposition.provider_failure,
        types.classifyProviderCompletion(completion),
    );
    try std.testing.expectEqualStrings("1113: insufficient balance", completion.provider_failure_detail.?);
}

test "a stream that carried nothing is rejected like an empty buffered turn" {
    const alloc = std.testing.allocator;
    var harness = StreamHarness.init(alloc);
    defer harness.deinit();

    var transfer_buffer: [512]u8 = undefined;
    try std.testing.expectError(
        error.InvalidProviderResponse,
        consumeSseForTest(&harness, "data: [DONE]\n\n", &transfer_buffer),
    );
}

test "streamed completions release every allocation on failure" {
    const Check = struct {
        fn run(alloc: Allocator) !void {
            var harness = StreamHarness.init(alloc);
            defer harness.deinit();
            const payload =
                "data: {\"model\":\"test/routed\",\"choices\":[{\"delta\":{\"reasoning\":\"why\",\"content\":\"hi\"}}]}\n\n" ++
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}},{\"index\":1,\"id\":\"call_2\",\"function\":{\"name\":\"list_files\",\"arguments\":\"{}\"}}]}}]}\n\n" ++
                "data: [DONE]\n\n";
            var transfer_buffer: [256]u8 = undefined;
            var completion = try consumeSseForTest(&harness, payload, &transfer_buffer);
            freeCompletion(alloc, &completion);
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Check.run, .{});
}

const LoopbackResponseFixture = struct {
    io_backend: std.Io.Threaded = .init_single_threaded,
    server: std.Io.net.Server,
    response: []const u8,
    thread: ?std.Thread = null,
    open: bool = true,
    stall: bool = false,
    released: std.atomic.Value(bool) = .init(false),

    fn init(response: []const u8) !@This() {
        var fixture: @This() = .{ .server = undefined, .response = response };
        var address = try std.Io.net.IpAddress.parse("127.0.0.1", 0);
        fixture.server = try address.listen(fixture.io(), .{ .reuse_address = true });
        return fixture;
    }

    fn io(self: *@This()) std.Io {
        return self.io_backend.io();
    }

    fn port(self: *@This()) u16 {
        return self.server.socket.address.getPort();
    }

    fn start(self: *@This()) !void {
        self.thread = try std.Thread.spawn(.{}, run, .{self});
    }

    fn deinit(self: *@This()) void {
        if (!self.open) return;
        self.released.store(true, .seq_cst);
        if (self.thread) |thread| thread.join();
        self.thread = null;
        self.server.deinit(self.io());
        self.open = false;
    }

    fn run(self: *@This()) void {
        self.runFallible() catch {};
    }

    fn runFallible(self: *@This()) !void {
        const zio = self.io();
        var socket = try self.server.accept(zio);
        defer socket.close(zio);

        var socket_buffer: [4096]u8 = undefined;
        var reader = socket.reader(zio, &socket_buffer);
        var head: [16 * 1024]u8 = undefined;
        var head_len: usize = 0;
        while (head_len < head.len) {
            head[head_len] = try reader.interface.takeByte();
            head_len += 1;
            if (!std.mem.endsWith(u8, head[0..head_len], "\r\n\r\n")) continue;
            var lines = std.mem.splitSequence(u8, head[0 .. head_len - 4], "\r\n");
            while (lines.next()) |line| {
                const name = "content-length:";
                if (line.len < name.len or !std.ascii.eqlIgnoreCase(line[0..name.len], name)) continue;
                const length = std.fmt.parseInt(usize, std.mem.trim(u8, line[name.len..], " \t"), 10) catch 0;
                try reader.interface.discardAll(length);
            }
            break;
        }

        var write_buffer: [4096]u8 = undefined;
        var writer = socket.writer(zio, &write_buffer);
        try writer.interface.writeAll(self.response);
        try writer.interface.flush();
        while (self.stall and !self.released.load(.seq_cst)) {
            io_mod.sleep(5 * std.time.ns_per_ms);
        }
    }
};

fn streamAgainstFixture(alloc: Allocator, harness: *StreamHarness, response: []const u8) !stream_provider.Result {
    var fixture = try LoopbackResponseFixture.init(response);
    defer fixture.deinit();
    try fixture.start();

    const url = try std.fmt.allocPrint(alloc, "http://127.0.0.1:{d}/chat", .{fixture.port()});
    defer alloc.free(url);
    harness.bind(url);
    return provider.stream(alloc, harness.request);
}

test "a provider that goes quiet mid-stream fails the attempt instead of hanging" {
    const alloc = std.testing.allocator;
    var harness = StreamHarness.init(alloc);
    defer harness.deinit();

    test_stream_silence_ms = 150;
    defer test_stream_silence_ms = null;

    var fixture = try LoopbackResponseFixture.init("HTTP/1.1 200 OK\r\n" ++
        "Content-Type: text/event-stream\r\n" ++
        "Connection: close\r\n\r\n" ++
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n");
    fixture.stall = true;
    defer fixture.deinit();
    try fixture.start();

    const url = try std.fmt.allocPrint(alloc, "http://127.0.0.1:{d}/chat", .{fixture.port()});
    defer alloc.free(url);
    harness.bind(url);

    const started_ms = io_mod.milliTimestamp();
    try std.testing.expectError(error.Timeout, provider.stream(alloc, harness.request));
    try std.testing.expect(io_mod.milliTimestamp() - started_ms < 5_000);
    try std.testing.expectEqual(
        stream_provider.NetworkFailureCause.response_interrupted,
        harness.attempt_evidence.network_failure.?.cause,
    );
}

test "a refused connection reports retryable transport failure evidence" {
    const alloc = std.testing.allocator;
    var harness = StreamHarness.init(alloc);
    defer harness.deinit();

    harness.bind("http://127.0.0.1:1/chat");
    try std.testing.expectError(error.ConnectionRefused, provider.stream(alloc, harness.request));
    try std.testing.expectEqual(
        stream_provider.NetworkFailureCause.transport_interrupted,
        harness.attempt_evidence.network_failure.?.cause,
    );
}

test "the silence limit reads its environment override and stays off when disabled" {
    test_stream_silence_ms = null;
    var quiet = StreamSilence.init(0);
    try std.testing.expect(!quiet.overdue());

    var bounded = StreamSilence.init(1);
    io_mod.sleep(10 * std.time.ns_per_ms);
    try std.testing.expect(bounded.overdue());
    bounded.touch();
    try std.testing.expect(!bounded.overdue());
}

test "an event stream response reaches the agent as incremental chunks" {
    const alloc = std.testing.allocator;
    var harness = StreamHarness.init(alloc);
    defer harness.deinit();

    var result = try streamAgainstFixture(alloc, &harness, "HTTP/1.1 200 OK\r\n" ++
        "Content-Type: text/event-stream\r\n" ++
        "Connection: close\r\n\r\n" ++
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n" ++
        "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n" ++
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\n" ++
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.txt\\\"}\"}}]}}]}\n\n" ++
        "data: [DONE]\n\n");
    defer result.deinit(alloc);

    try std.testing.expectEqual(std.http.Status.ok, result.status);
    try std.testing.expectEqual(@as(usize, 2), harness.capture.content_chunks);
    try std.testing.expectEqualStrings("Hello", harness.capture.text.items);
    try std.testing.expectEqualStrings("Hello", result.completion.content.?);
    try std.testing.expectEqual(@as(usize, 1), result.completion.tool_calls.len);
    try std.testing.expectEqualStrings("{\"path\":\"a.txt\"}", result.completion.tool_calls[0].arguments_json);
    try std.testing.expectEqualStrings("call_1:read_file;", harness.capture.started.items);
}

test "a json response falls back to the buffered path" {
    const alloc = std.testing.allocator;
    var harness = StreamHarness.init(alloc);
    defer harness.deinit();

    const body = "{\"choices\":[{\"message\":{\"content\":\"buffered\"},\"finish_reason\":\"stop\"}]}";
    const response = try std.fmt.allocPrint(
        alloc,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n{s}",
        .{ body.len, body },
    );
    defer alloc.free(response);

    var result = try streamAgainstFixture(alloc, &harness, response);
    defer result.deinit(alloc);

    try std.testing.expectEqual(@as(usize, 1), harness.capture.content_chunks);
    try std.testing.expectEqualStrings("buffered", harness.capture.text.items);
    try std.testing.expectEqualStrings("buffered", result.completion.content.?);
}

test "assistant reasoning is replayed only to Z.AI and reasoning details only to the relay" {
    const alloc = std.testing.allocator;
    const message: types.ChatMessage = .{
        .role = .assistant,
        .content = "answer",
        .reasoning = "the working out",
        .reasoning_details_json = "[{\"type\":\"reasoning.encrypted\",\"data\":\"abc\"}]",
    };

    const hosts = [_]struct {
        url: []const u8,
        reasoning_content: bool,
        reasoning_details: bool,
    }{
        .{ .url = "https://api.z.ai/api/coding/paas/v4/chat/completions", .reasoning_content = true, .reasoning_details = false },
        .{ .url = "https://open.bigmodel.cn/api/paas/v4/chat/completions", .reasoning_content = true, .reasoning_details = false },
        .{ .url = "http://127.0.0.1:18081/api/coding/paas/v4/chat/completions", .reasoning_content = true, .reasoning_details = true },
        .{ .url = "http://127.0.0.1:4321/v1/chat/completions", .reasoning_content = false, .reasoning_details = true },
        .{ .url = "http://localhost:4321/v1/chat/completions", .reasoning_content = false, .reasoning_details = true },
        .{ .url = default_chat_url, .reasoning_content = false, .reasoning_details = false },
        .{ .url = "https://api.openai.com/v1/chat/completions", .reasoning_content = false, .reasoning_details = false },
    };

    for (hosts) |host| {
        var out: std.Io.Writer.Allocating = .init(alloc);
        defer out.deinit();
        try writeMessage(alloc, &out.writer, host.url, message, null, .{}, .none);
        const written = out.written();
        try std.testing.expectEqual(
            host.reasoning_content,
            std.mem.find(u8, written, "\"reasoning_content\":\"the working out\"") != null,
        );
        try std.testing.expectEqual(
            host.reasoning_details,
            std.mem.find(u8, written, "\"reasoning_details\":[{\"type\":\"reasoning.encrypted\",\"data\":\"abc\"}]") != null,
        );
    }
}

test "a user message never carries reasoning to Z.AI" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeMessage(
        alloc,
        &out.writer,
        "https://api.z.ai/api/coding/paas/v4/chat/completions",
        .{ .role = .user, .content = "question", .reasoning = "leaked" },
        null,
        .{},
        .none,
    );
    try std.testing.expect(std.mem.find(u8, out.written(), "reasoning") == null);
}

test "thinking and user_id are written only for Z.AI" {
    const alloc = std.testing.allocator;
    const zai = "https://api.z.ai/api/coding/paas/v4/chat/completions";

    var keyed: std.Io.Writer.Allocating = .init(alloc);
    defer keyed.deinit();
    try writeZaiRequestOptions(&keyed.writer, zai, "session-abc");
    const expected = openRouterSessionId("session-abc");
    try std.testing.expect(std.mem.find(u8, keyed.written(), ",\"thinking\":{\"type\":\"enabled\",\"clear_thinking\":false}") != null);
    try std.testing.expect(std.mem.find(u8, keyed.written(), expected[0..]) != null);
    try std.testing.expect(std.mem.find(u8, keyed.written(), "session-abc") == null);

    var keyless: std.Io.Writer.Allocating = .init(alloc);
    defer keyless.deinit();
    try writeZaiRequestOptions(&keyless.writer, zai, null);
    try std.testing.expectEqualStrings(",\"thinking\":{\"type\":\"enabled\",\"clear_thinking\":false}", keyless.written());

    for ([_][]const u8{ default_chat_url, "https://api.openai.com/v1/chat/completions", "http://127.0.0.1:4321/v1/chat/completions" }) |url| {
        var other: std.Io.Writer.Allocating = .init(alloc);
        defer other.deinit();
        try writeZaiRequestOptions(&other.writer, url, "session-abc");
        try std.testing.expectEqualStrings("", other.written());
    }
}

test "streamed reasoning details survive to the completion and back onto the wire" {
    const alloc = std.testing.allocator;
    var harness = StreamHarness.init(alloc);
    defer harness.deinit();

    var transfer_buffer: [4096]u8 = undefined;
    var completion = try consumeSseForTest(
        &harness,
        "data: {\"choices\":[{\"delta\":{\"reasoning_details\":[{\"type\":\"reasoning.encrypted\",\"data\":\"opaque\"}]}}]}\n\n" ++
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\n" ++
            "data: [DONE]\n\n",
        &transfer_buffer,
    );
    defer freeCompletion(alloc, &completion);

    try std.testing.expectEqualStrings(
        "[{\"type\":\"reasoning.encrypted\",\"data\":\"opaque\"}]",
        completion.reasoning_details_json.?,
    );

    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeMessage(
        alloc,
        &out.writer,
        "http://127.0.0.1:4321/v1/chat/completions",
        .{
            .role = .assistant,
            .content = completion.content,
            .reasoning_details_json = completion.reasoning_details_json,
        },
        null,
        .{},
        .none,
    );
    try std.testing.expectEqualStrings(
        "{\"role\":\"assistant\",\"content\":\"hi\",\"reasoning_details\":[{\"type\":\"reasoning.encrypted\",\"data\":\"opaque\"}]}",
        out.written(),
    );
}
