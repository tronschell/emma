const std = @import("std");
const image_attachments = @import("../images/image_attachments.zig");
const io_mod = @import("../shared/io.zig");
const model_capabilities = @import("../config/model_capabilities.zig");
const types = @import("../shared/types.zig");

pub const ChatRole = types.ChatRole;
pub const ChatMessage = types.ChatMessage;
pub const GatewayCompletion = types.GatewayCompletion;
pub const ToolCall = types.ToolCall;

pub const StructuredResponseFormat = struct {
    name: []const u8,
    description: []const u8,
    schema_json: []const u8,
};

const pending_tool_review_result_text = "Tool call has not executed; it is pending permission review.";

pub fn roleName(role: ChatRole) []const u8 {
    return switch (role) {
        .system => "system",
        .user => "user",
        .assistant => "assistant",
        .tool => "tool",
    };
}

pub fn writeChatMessageJson(
    scratch_alloc: std.mem.Allocator,
    writer: *std.Io.Writer,
    message: ChatMessage,
) !void {
    writeChatMessageJsonInner(scratch_alloc, writer, message, .none, null, null) catch |err| return err;
}

pub fn writeChatMessageJsonCached(
    scratch_alloc: std.mem.Allocator,
    writer: *std.Io.Writer,
    message: ChatMessage,
) !void {
    writeChatMessageJsonInner(scratch_alloc, writer, message, .short, null, null) catch |err| return err;
}

pub fn buildGatewayRequestBody(
    alloc: std.mem.Allocator,
    tools_json: []const u8,
    messages: []const ChatMessage,
) ![]u8 {
    return buildGatewayRequestBodyWithOptions(alloc, tools_json, messages, .{}, .auto);
}

pub fn buildGatewayRequestBodyWithOptions(
    alloc: std.mem.Allocator,
    tools_json: []const u8,
    messages: []const ChatMessage,
    options: model_capabilities.ResolvedProviderOptions,
    tool_choice: types.ToolChoice,
) ![]u8 {
    return buildGatewayRequestBodyWithOptionsAndOutputLimit(
        alloc,
        tools_json,
        messages,
        options,
        tool_choice,
        null,
    );
}

pub fn buildGatewayRequestBodyWithOptionsAndOutputLimit(
    alloc: std.mem.Allocator,
    tools_json: []const u8,
    messages: []const ChatMessage,
    options: model_capabilities.ResolvedProviderOptions,
    tool_choice: types.ToolChoice,
    max_output_tokens: ?u32,
) ![]u8 {
    return buildGatewayRequestBodyWithSettings(
        alloc,
        tools_json,
        messages,
        options,
        tool_choice.label(),
        max_output_tokens,
    );
}

pub fn buildGatewayRequestBodyWithOptionsAndBudget(
    alloc: std.mem.Allocator,
    tools_json: []const u8,
    messages: []const ChatMessage,
    options: model_capabilities.ResolvedProviderOptions,
    tool_choice: types.ToolChoice,
    max_output_tokens: ?u32,
    budget: BuildBudget,
) ![]u8 {
    try validateToolMessageHistory(alloc, messages);
    return buildGatewayRequestBodyValidated(
        alloc,
        tools_json,
        messages,
        options,
        tool_choice.label(),
        max_output_tokens,
        budget,
        null,
        null,
    );
}

pub fn buildGatewayRequestBodyWithVerifiedImagesAndBudget(
    alloc: std.mem.Allocator,
    tools_json: []const u8,
    messages: []const ChatMessage,
    verified_images: []const image_attachments.VerifiedSnapshot,
    options: model_capabilities.ResolvedProviderOptions,
    tool_choice: types.ToolChoice,
    response_format: StructuredResponseFormat,
    budget: BuildBudget,
) ![]u8 {
    if (messages.len == 0 or messages[messages.len - 1].role != .user) {
        return error.InvalidGatewayHistory;
    }
    if (messages[messages.len - 1].images.len != 0) {
        return error.InvalidGatewayHistory;
    }
    try validateToolMessageHistory(alloc, messages);
    return buildGatewayRequestBodyValidated(
        alloc,
        tools_json,
        messages,
        options,
        tool_choice.label(),
        null,
        budget,
        response_format,
        .{
            .message_index = messages.len - 1,
            .images = verified_images,
        },
    );
}

pub fn buildGatewayRequiredToolRequestBodyWithOptions(
    alloc: std.mem.Allocator,
    tools_json: []const u8,
    messages: []const ChatMessage,
    options: model_capabilities.ResolvedProviderOptions,
) ![]u8 {
    return buildGatewayRequiredToolRequestBodyWithOptionsAndOutputLimit(
        alloc,
        tools_json,
        messages,
        options,
        null,
    );
}

pub fn buildGatewayRequiredToolRequestBodyWithOptionsAndOutputLimit(
    alloc: std.mem.Allocator,
    tools_json: []const u8,
    messages: []const ChatMessage,
    options: model_capabilities.ResolvedProviderOptions,
    max_output_tokens: ?u32,
) ![]u8 {
    return buildGatewayRequestBodyWithSettings(
        alloc,
        tools_json,
        messages,
        options,
        "required",
        max_output_tokens,
    );
}

pub fn buildGatewayRequiredToolRequestBodyWithOptionsAndBudget(
    alloc: std.mem.Allocator,
    tools_json: []const u8,
    messages: []const ChatMessage,
    options: model_capabilities.ResolvedProviderOptions,
    max_output_tokens: ?u32,
    budget: BuildBudget,
) ![]u8 {
    try validateToolMessageHistory(alloc, messages);
    return buildGatewayRequestBodyValidated(
        alloc,
        tools_json,
        messages,
        options,
        "required",
        max_output_tokens,
        budget,
        null,
        null,
    );
}

pub fn buildGatewayRequiredToolRequestBodyWithMaxOutputTokens(
    alloc: std.mem.Allocator,
    tools_json: []const u8,
    messages: []const ChatMessage,
    max_output_tokens: u32,
) ![]u8 {
    return buildGatewayRequestBodyWithSettings(alloc, tools_json, messages, .{}, "required", max_output_tokens);
}

pub fn buildGatewayPendingToolReviewRequestBodyWithMaxOutputTokens(
    alloc: std.mem.Allocator,
    tools_json: []const u8,
    messages: []const ChatMessage,
    target_call_id: []const u8,
    options: model_capabilities.ResolvedProviderOptions,
    max_output_tokens: u32,
    deadline: std.Io.Clock.Timestamp,
    cancel_flag: *std.atomic.Value(bool),
) ![]u8 {
    const budget = BuildBudget{ .deadline = deadline, .cancel_flag = cancel_flag };
    const expanded = try expandPendingToolReviewMessages(
        alloc,
        messages,
        target_call_id,
        deadline,
        cancel_flag,
    );
    defer alloc.free(expanded);

    return buildGatewayRequestBodyValidated(
        alloc,
        tools_json,
        expanded,
        options,
        "required",
        max_output_tokens,
        budget,
        null,
        null,
    );
}

pub fn expandPendingToolReviewMessages(
    alloc: std.mem.Allocator,
    messages: []const ChatMessage,
    target_call_id: []const u8,
    deadline: std.Io.Clock.Timestamp,
    cancel_flag: *std.atomic.Value(bool),
) ![]ChatMessage {
    const budget = BuildBudget{ .deadline = deadline, .cancel_flag = cancel_flag };
    try budget.check();
    try validatePendingToolReviewMessages(alloc, messages, target_call_id, budget);
    try budget.check();

    const pending = messages[messages.len - 1];
    const expanded_len = try std.math.add(usize, messages.len, pending.tool_calls.len);
    const expanded = try alloc.alloc(ChatMessage, expanded_len);
    errdefer alloc.free(expanded);

    @memcpy(expanded[0..messages.len], messages);
    for (pending.tool_calls, 0..) |call, i| {
        try budget.check();
        expanded[messages.len + i] = .{
            .role = .tool,
            .content = pending_tool_review_result_text,
            .tool_call_id = call.id,
            .tool_name = call.name,
        };
    }
    try budget.check();
    try validateToolMessageHistory(alloc, expanded);
    try budget.check();
    return expanded;
}

fn buildGatewayRequestBodyWithSettings(
    alloc: std.mem.Allocator,
    tools_json: []const u8,
    messages: []const ChatMessage,
    options: model_capabilities.ResolvedProviderOptions,
    tool_choice: []const u8,
    max_output_tokens: ?u32,
) ![]u8 {
    try validateToolMessageHistory(alloc, messages);
    return buildGatewayRequestBodyValidated(
        alloc,
        tools_json,
        messages,
        options,
        tool_choice,
        max_output_tokens,
        null,
        null,
        null,
    );
}

pub const BuildBudget = struct {
    deadline: ?std.Io.Clock.Timestamp = null,
    cancel_flag: ?*std.atomic.Value(bool) = null,

    pub fn check(self: BuildBudget) error{ Cancelled, TimedOut }!void {
        if (self.cancel_flag) |flag| {
            if (flag.load(.seq_cst)) return error.Cancelled;
        }
        if (self.deadline) |deadline| {
            const now = std.Io.Clock.Timestamp.now(io_mod.getIo(), .awake);
            if (now.raw.nanoseconds >= deadline.raw.nanoseconds) return error.TimedOut;
        }
    }
};

fn buildGatewayRequestBodyValidated(
    alloc: std.mem.Allocator,
    tools_json: []const u8,
    messages: []const ChatMessage,
    options: model_capabilities.ResolvedProviderOptions,
    tool_choice: []const u8,
    max_output_tokens: ?u32,
    budget: ?BuildBudget,
    response_format: ?StructuredResponseFormat,
    verified_image_override: ?VerifiedImageOverride,
) ![]u8 {
    if (budget) |active| try active.check();

    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    const cache_marks = if (options.prompt_caching) findCacheMarks(messages) else CacheMarks{};
    var prefix_cacheable = true;

    try out.writer.writeAll("{\"prompt\":[");
    for (messages, 0..) |message, i| {
        if (budget) |active| try active.check();
        if (i > 0) try out.writer.writeByte(',');
        const use_cache = if (prefix_cacheable) cacheTtlForMessage(message, i, cache_marks, options.prompt_caching) else .none;
        const verified_images = if (verified_image_override) |override|
            if (override.message_index == i) override.images else null
        else
            null;
        if (budget) |active| {
            try writeChatMessageJsonInner(
                std.heap.c_allocator,
                &out.writer,
                message,
                use_cache,
                active,
                verified_images,
            );
        } else if (use_cache != .none) {
            try writeChatMessageJsonInner(std.heap.c_allocator, &out.writer, message, use_cache, null, null);
        } else {
            try writeChatMessageJson(std.heap.c_allocator, &out.writer, message);
        }
        if (message.cache_policy == .no_cache) prefix_cacheable = false;
        if (budget) |active| try active.check();
    }
    try out.writer.writeAll("],\"tools\":");
    try out.writer.writeAll(tools_json);
    try out.writer.writeAll(",\"toolChoice\":{\"type\":");
    try std.json.Stringify.value(tool_choice, .{}, &out.writer);
    try out.writer.writeByte('}');

    if (response_format) |format| {
        try writeStructuredResponseFormat(alloc, &out.writer, format);
    }

    if (max_output_tokens) |value| {
        try out.writer.print(",\"maxOutputTokens\":{d}", .{value});
    }

    if (options.reasoning) |*reasoning| {
        try out.writer.writeAll(",\"reasoning\":");
        try std.json.Stringify.value(reasoning.label(), .{}, &out.writer);
    }
    try writeProviderOptions(&out.writer, options);

    try out.writer.writeByte('}');
    if (budget) |active| try active.check();
    return try out.toOwnedSlice();
}

/// Returns a new request body with the provider-visible user agent added.
/// The caller retains ownership of `body` and owns the returned slice.
pub fn withRequestUserAgent(
    alloc: std.mem.Allocator,
    body: []const u8,
    user_agent: []const u8,
) ![]u8 {
    if (body.len == 0 or body[body.len - 1] != '}') return error.InvalidGatewayRequestBody;

    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    try out.writer.writeAll(body[0 .. body.len - 1]);
    try out.writer.writeAll(",\"headers\":{\"user-agent\":");
    try std.json.Stringify.value(user_agent, .{}, &out.writer);
    try out.writer.writeAll("}}");
    return try out.toOwnedSlice();
}

fn writeStructuredResponseFormat(
    alloc: std.mem.Allocator,
    writer: *std.Io.Writer,
    format: StructuredResponseFormat,
) !void {
    var schema = std.json.parseFromSlice(std.json.Value, alloc, format.schema_json, .{}) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidStructuredResponseSchema,
    };
    defer schema.deinit();
    if (schema.value != .object) return error.InvalidStructuredResponseSchema;

    try writer.writeAll(",\"responseFormat\":{\"type\":\"json\",\"name\":");
    try std.json.Stringify.value(format.name, .{}, writer);
    try writer.writeAll(",\"description\":");
    try std.json.Stringify.value(format.description, .{}, writer);
    try writer.writeAll(",\"schema\":");
    try std.json.Stringify.value(schema.value, .{}, writer);
    try writer.writeByte('}');
}

const VerifiedImageOverride = struct {
    message_index: usize,
    images: []const image_attachments.VerifiedSnapshot,
};

fn validatePendingToolReviewMessages(
    alloc: std.mem.Allocator,
    messages: []const ChatMessage,
    target_call_id: []const u8,
    budget: BuildBudget,
) !void {
    try budget.check();
    if (messages.len < 2 or target_call_id.len == 0) return error.InvalidGatewayHistory;
    const instruction = messages[0];
    const pending = messages[messages.len - 1];
    if (instruction.role != .system or instruction.content == null) return error.InvalidGatewayHistory;
    if (pending.role != .assistant or pending.tool_calls.len == 0) return error.InvalidGatewayHistory;
    try validateToolMessageHistory(alloc, messages[1 .. messages.len - 1]);
    try budget.check();
    try validateAssistantToolCalls(alloc, pending.tool_calls);
    try budget.check();

    var target_matches: usize = 0;
    for (pending.tool_calls) |call| {
        try budget.check();
        if (std.mem.eql(u8, call.id, target_call_id)) target_matches += 1;
    }
    if (target_matches != 1) return error.InvalidGatewayHistory;
}

pub fn writeProviderOptions(writer: *std.Io.Writer, options: model_capabilities.ResolvedProviderOptions) !void {
    if (!options.fast and options.parallel_tool_calls == null) return;

    try writer.writeAll(",\"providerOptions\":{");
    if (options.fast) try writer.writeAll("\"gateway\":{\"speed\":\"fast\"}");
    if (options.parallel_tool_calls) |parallel_tool_calls| {
        if (options.fast) try writer.writeByte(',');
        try writer.writeAll("\"xai\":{\"parallelToolCalls\":");
        try writer.writeAll(if (parallel_tool_calls) "true" else "false");
        try writer.writeByte('}');
    }
    try writer.writeByte('}');
}

pub fn validateToolMessageHistory(alloc: std.mem.Allocator, messages: []const ChatMessage) !void {
    var i: usize = 0;
    while (i < messages.len) {
        const msg = messages[i];
        if (msg.role == .tool) return error.InvalidGatewayHistory;
        if (msg.role != .assistant or msg.tool_calls.len == 0) {
            i += 1;
            continue;
        }

        try validateAssistantToolCalls(alloc, msg.tool_calls);
        const seen = try alloc.alloc(bool, msg.tool_calls.len);
        defer alloc.free(seen);

        i = try validateAssistantToolResultBlock(messages, i + 1, msg.tool_calls, seen);
    }
}

fn validateAssistantToolResultBlock(
    messages: []const ChatMessage,
    start_index: usize,
    calls: []const ToolCall,
    seen: []bool,
) !usize {
    @memset(seen, false);

    var result_count: usize = 0;
    var j = start_index;
    while (result_count < calls.len) : (j += 1) {
        if (j >= messages.len) return error.InvalidGatewayHistory;
        const result = messages[j];
        if (result.role != .tool) return error.InvalidGatewayHistory;
        const tool_call_id = result.tool_call_id orelse return error.InvalidGatewayHistory;
        const tool_name = result.tool_name orelse return error.InvalidGatewayHistory;
        if (result.content == null) return error.InvalidGatewayHistory;

        const matched_index = findToolCallIndex(calls, tool_call_id) orelse return error.InvalidGatewayHistory;
        if (seen[matched_index]) return error.InvalidGatewayHistory;
        if (!std.mem.eql(u8, calls[matched_index].name, tool_name)) return error.InvalidGatewayHistory;
        seen[matched_index] = true;
        result_count += 1;
    }
    return j;
}

fn validateAssistantToolCalls(alloc: std.mem.Allocator, calls: []const ToolCall) !void {
    for (calls, 0..) |call, i| {
        if (call.id.len == 0 or call.name.len == 0 or call.arguments_json.len == 0) return error.InvalidGatewayHistory;
        if (try types.ToolArgumentIntegrity.classifySerialized(alloc, call.arguments_json) == .malformed_json) {
            return error.InvalidGatewayHistory;
        }
        var j = i + 1;
        while (j < calls.len) : (j += 1) {
            if (std.mem.eql(u8, call.id, calls[j].id)) return error.InvalidGatewayHistory;
        }
    }
}

fn findToolCallIndex(calls: []const ToolCall, id: []const u8) ?usize {
    for (calls, 0..) |call, i| {
        if (std.mem.eql(u8, call.id, id)) return i;
    }
    return null;
}

pub const CacheMarks = struct {
    /// Last leading system message: the static prefix, cached for an hour.
    stable_prefix_idx: ?usize = null,
    /// Last durable-history message before the current prompt; stable across a turn's steps.
    history_end_idx: ?usize = null,
    /// Last cacheable message before the volatile tail; moves forward each step.
    breakpoint_idx: ?usize = null,

    pub fn marks(self: CacheMarks, index: usize) bool {
        return (self.stable_prefix_idx != null and index == self.stable_prefix_idx.?) or
            (self.history_end_idx != null and index == self.history_end_idx.?) or
            (self.breakpoint_idx != null and index == self.breakpoint_idx.?);
    }
};

/// How long a cache mark on a message should live. Anthropic requires the
/// longer-lived marks to precede the shorter ones, which the prefix layout guarantees.
pub const CacheTtl = enum { none, short, long };

pub fn cacheTtlForMessage(message: ChatMessage, index: usize, cache_marks: CacheMarks, prompt_caching: bool) CacheTtl {
    if (!prompt_caching) return .none;
    if (message.cache_policy == .no_cache) return .none;
    if (!cache_marks.marks(index)) return .none;
    if (cache_marks.stable_prefix_idx != null and index == cache_marks.stable_prefix_idx.?) return .long;
    return .short;
}

pub fn shouldCacheMessage(message: ChatMessage, index: usize, cache_marks: CacheMarks, prompt_caching: bool) bool {
    return cacheTtlForMessage(message, index, cache_marks, prompt_caching) != .none;
}

pub const cache_control_short = "{\"type\":\"ephemeral\"}";
pub const cache_control_long = "{\"type\":\"ephemeral\",\"ttl\":\"1h\"}";

pub fn cacheControlJson(ttl: CacheTtl) []const u8 {
    return switch (ttl) {
        .none => "",
        .short => cache_control_short,
        .long => cache_control_long,
    };
}

const anthropic_cache_meta = ",\"providerOptions\":{\"anthropic\":{\"cacheControl\":" ++ cache_control_short ++ "}}";
const anthropic_cache_meta_long = ",\"providerOptions\":{\"anthropic\":{\"cacheControl\":" ++ cache_control_long ++ "}}";
const max_prompt_shape_entries: usize = 12;

fn writeChatMessageJsonInner(
    scratch_alloc: std.mem.Allocator,
    writer: *std.Io.Writer,
    message: ChatMessage,
    cached: CacheTtl,
    budget: ?BuildBudget,
    verified_images: ?[]const image_attachments.VerifiedSnapshot,
) !void {
    try writer.writeAll("{\"role\":");
    try std.json.Stringify.value(roleName(message.role), .{}, writer);

    switch (message.role) {
        .system => {
            try writer.writeAll(",\"content\":");
            if (message.content) |content| {
                try std.json.Stringify.value(content, .{}, writer);
            } else {
                try writer.writeAll("\"\"");
            }
        },
        .user => {
            try writer.writeAll(",\"content\":[");
            var wrote_part = false;
            if (message.content) |content| {
                if (content.len > 0) {
                    try writer.writeAll("{\"type\":\"text\",\"text\":");
                    try std.json.Stringify.value(content, .{}, writer);
                    try writer.writeByte('}');
                    wrote_part = true;
                }
            }
            if (verified_images) |snapshots| {
                for (snapshots) |snapshot| {
                    if (wrote_part) try writer.writeByte(',');
                    try image_attachments.writeVerifiedImageFilePartJsonWithBudget(
                        writer,
                        snapshot,
                        .{
                            .deadline = if (budget) |active| active.deadline else null,
                            .cancel_flag = if (budget) |active| active.cancel_flag else null,
                        },
                    );
                    wrote_part = true;
                }
            } else {
                for (message.images) |image| {
                    if (wrote_part) try writer.writeByte(',');
                    if (budget) |active| {
                        try image_attachments.writeImageFilePartJsonWithBudget(
                            scratch_alloc,
                            writer,
                            image,
                            .{
                                .deadline = active.deadline,
                                .cancel_flag = active.cancel_flag,
                            },
                        );
                    } else {
                        try image_attachments.writeImageFilePartJson(scratch_alloc, writer, image);
                    }
                    wrote_part = true;
                }
            }
            try writer.writeByte(']');
        },
        .assistant => {
            try writer.writeAll(",\"content\":[");
            var wrote_part = false;
            if (message.content) |content| {
                if (content.len > 0) {
                    try writer.writeAll("{\"type\":\"text\",\"text\":");
                    try std.json.Stringify.value(content, .{}, writer);
                    try writer.writeByte('}');
                    wrote_part = true;
                }
            }
            for (message.tool_calls) |tool_call| {
                if (wrote_part) try writer.writeByte(',');
                try writer.writeAll("{\"type\":\"tool-call\",\"toolCallId\":");
                try std.json.Stringify.value(tool_call.id, .{}, writer);
                try writer.writeAll(",\"toolName\":");
                try std.json.Stringify.value(tool_call.name, .{}, writer);
                try writer.writeAll(",\"input\":");
                try writer.writeAll(tool_call.arguments_json);
                try writer.writeByte('}');
                wrote_part = true;
            }
            try writer.writeByte(']');
        },
        .tool => {
            try writer.writeAll(",\"content\":[{\"type\":\"tool-result\",\"toolCallId\":");
            if (message.tool_call_id) |tool_call_id| {
                try std.json.Stringify.value(tool_call_id, .{}, writer);
            } else {
                try writer.writeAll("\"\"");
            }
            try writer.writeAll(",\"toolName\":");
            if (message.tool_name) |tool_name| {
                try std.json.Stringify.value(tool_name, .{}, writer);
            } else {
                try writer.writeAll("\"unknown\"");
            }
            try writer.writeAll(",\"output\":{\"type\":\"text\",\"value\":");
            if (message.content) |content| {
                try std.json.Stringify.value(content, .{}, writer);
            } else {
                try writer.writeAll("\"\"");
            }
            try writer.writeAll("}}]");
        },
    }

    switch (cached) {
        .none => {},
        .short => try writer.writeAll(anthropic_cache_meta),
        .long => try writer.writeAll(anthropic_cache_meta_long),
    }
    try writer.writeAll("}");
}

pub fn formatGatewayRequestShapeSummary(alloc: std.mem.Allocator, payload: []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();

    try out.writer.print("bytes={d}", .{payload.len});

    var parsed = std.json.parseFromSlice(std.json.Value, alloc, payload, .{}) catch |err| {
        try out.writer.print(" parse_error={s}", .{@errorName(err)});
        return try out.toOwnedSlice();
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        try out.writer.print(" root={s}", .{jsonKindName(parsed.value)});
        return try out.toOwnedSlice();
    }

    // Emma's OpenAI transport names the turn `messages` where the AI SDK routes
    // name it `prompt`, and a shape summary is worthless if it cannot describe
    // the payload that actually failed.
    const turn_key: []const u8 = if (parsed.value.object.contains("messages")) "messages" else "prompt";
    if (parsed.value.object.get(turn_key)) |prompt| {
        if (prompt == .array) {
            try out.writer.print(" {s}_count={d}", .{ turn_key, prompt.array.items.len });
            const limit = @min(prompt.array.items.len, max_prompt_shape_entries);
            for (prompt.array.items[0..limit], 0..) |entry, i| {
                try out.writer.print(" {s}.{d}", .{ turn_key, i });
                if (entry == .object) {
                    if (entry.object.get("role")) |role_value| {
                        try out.writer.writeAll(" role=");
                        if (role_value == .string) {
                            try appendSafeShapeToken(&out.writer, role_value.string);
                        } else {
                            try out.writer.writeAll(jsonKindName(role_value));
                        }
                    } else {
                        try out.writer.writeAll(" role=missing");
                    }
                    if (entry.object.get("content")) |content_value| {
                        try out.writer.print(" content={s}", .{jsonKindName(content_value)});
                        if (content_value == .array) try out.writer.print(" parts={d}", .{content_value.array.items.len});
                    } else {
                        try out.writer.writeAll(" content=missing");
                    }
                } else {
                    try out.writer.print(" entry={s}", .{jsonKindName(entry)});
                }
            }
            if (prompt.array.items.len > limit) {
                try out.writer.print(" {s}_omitted={d}", .{ turn_key, prompt.array.items.len - limit });
            }
        } else {
            try out.writer.print(" {s}={s}", .{ turn_key, jsonKindName(prompt) });
        }
    } else {
        try out.writer.print(" {s}=missing", .{turn_key});
    }

    if (parsed.value.object.get("tools")) |tools| {
        try out.writer.print(" tools={s}", .{jsonKindName(tools)});
        if (tools == .array) try out.writer.print(" tools_count={d}", .{tools.array.items.len});
    }

    if (parsed.value.object.get("toolChoice")) |tool_choice| {
        if (tool_choice == .object) {
            if (tool_choice.object.get("type")) |type_value| {
                try out.writer.writeAll(" toolChoice=");
                if (type_value == .string) {
                    try appendSafeShapeToken(&out.writer, type_value.string);
                } else {
                    try out.writer.writeAll(jsonKindName(type_value));
                }
            } else {
                try out.writer.writeAll(" toolChoice=object");
            }
        } else {
            try out.writer.print(" toolChoice={s}", .{jsonKindName(tool_choice)});
        }
    }

    if (parsed.value.object.get("providerOptions")) |provider_options| {
        try out.writer.print(" providerOptions={s}", .{jsonKindName(provider_options)});
        if (provider_options == .object) try out.writer.print(" providerOptions_count={d}", .{provider_options.object.count()});
    }

    return try out.toOwnedSlice();
}

fn appendSafeShapeToken(writer: *std.Io.Writer, raw: []const u8) !void {
    var wrote = false;
    var last_was_underscore = false;
    for (raw) |c| {
        switch (c) {
            'a'...'z', 'A'...'Z', '0'...'9', '_', '-', '.', '/', '[', ']' => {
                try writer.writeByte(c);
                wrote = true;
                last_was_underscore = c == '_';
            },
            else => {
                if (!last_was_underscore) {
                    try writer.writeByte('_');
                    wrote = true;
                    last_was_underscore = true;
                }
            },
        }
    }
    if (!wrote) try writer.writeAll("unknown");
}

fn jsonKindName(value: std.json.Value) []const u8 {
    return switch (value) {
        .null => "null",
        .bool => "bool",
        .integer, .float, .number_string => "number",
        .string => "string",
        .array => "array",
        .object => "object",
    };
}

pub fn findCacheMarks(messages: []const ChatMessage) CacheMarks {
    var marks: CacheMarks = .{};
    for (messages, 0..) |message, i| {
        if (message.role != .system or message.cache_policy == .no_cache) break;
        marks.stable_prefix_idx = i;
    }
    var i = messages.len;
    while (i > 0) {
        i -= 1;
        const message = messages[i];
        if (message.cache_policy == .no_cache) continue;
        if (marks.stable_prefix_idx != null and i <= marks.stable_prefix_idx.?) break;
        marks.breakpoint_idx = i;
        break;
    }
    // The message before the last user prompt closes the durable history. Marking it keeps
    // the whole history cached across every step of the turn and into the next turn, even
    // when the moving breakpoint lands on a tool result that never recurs.
    var last_user: ?usize = null;
    for (messages, 0..) |message, index| {
        if (message.role == .user) last_user = index;
    }
    if (last_user) |user_idx| {
        if (user_idx > 0) {
            const candidate = user_idx - 1;
            const beyond_prefix = marks.stable_prefix_idx == null or candidate > marks.stable_prefix_idx.?;
            const before_breakpoint = marks.breakpoint_idx != null and candidate < marks.breakpoint_idx.?;
            if (beyond_prefix and before_breakpoint and messages[candidate].cache_policy != .no_cache) {
                marks.history_end_idx = candidate;
            }
        }
    }
    return marks;
}

pub fn parseGatewayCompletion(alloc: std.mem.Allocator, body: []const u8) !GatewayCompletion {
    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, body, .{});
    defer parsed.deinit();

    const root = parsed.value;
    if (root != .object) return error.InvalidGatewayResponse;

    const choices = root.object.get("choices") orelse return error.InvalidGatewayResponse;
    if (choices != .array or choices.array.items.len == 0) return error.InvalidGatewayResponse;

    const choice = choices.array.items[0];
    if (choice != .object) return error.InvalidGatewayResponse;

    const message_value = choice.object.get("message") orelse return error.InvalidGatewayResponse;
    if (message_value != .object) return error.InvalidGatewayResponse;

    var output: GatewayCompletion = .{};
    if (message_value.object.get("content")) |content| {
        if (content == .string) output.content = try alloc.dupe(u8, content.string);
    }
    errdefer freeGatewayCompletion(alloc, output);

    if (choice.object.get("finish_reason")) |finish_reason| {
        if (finish_reason == .string and finish_reason.string.len > 0) {
            output.finish_reason = types.ProviderFinishReason.parse_legacy(finish_reason.string) orelse
                return error.InvalidGatewayResponse;
        }
    }

    output.usage = parseGatewayUsage(root.object);

    if (message_value.object.get("tool_calls")) |tool_calls| {
        if (tool_calls == .array and tool_calls.array.items.len > 0) {
            const buffer = try alloc.alloc(ToolCall, tool_calls.array.items.len);
            var count: usize = 0;
            errdefer {
                for (buffer[0..count]) |tool_call| {
                    alloc.free(tool_call.id);
                    alloc.free(tool_call.name);
                    alloc.free(tool_call.arguments_json);
                }
                alloc.free(buffer);
            }

            for (tool_calls.array.items) |item| {
                if (item != .object) continue;
                const id = item.object.get("id") orelse continue;
                if (id != .string) continue;
                const fn_value = item.object.get("function") orelse continue;
                if (fn_value != .object) continue;
                const name = fn_value.object.get("name") orelse continue;
                const args = fn_value.object.get("arguments") orelse continue;
                if (name != .string or args != .string) continue;
                if (try types.ToolArgumentIntegrity.classifySerialized(alloc, args.string) == .malformed_json) {
                    return error.InvalidGatewayResponse;
                }
                const id_copy = try alloc.dupe(u8, id.string);
                errdefer alloc.free(id_copy);
                const name_copy = try alloc.dupe(u8, name.string);
                errdefer alloc.free(name_copy);
                const arguments_copy = try alloc.dupe(u8, args.string);
                errdefer alloc.free(arguments_copy);

                buffer[count] = .{
                    .id = id_copy,
                    .name = name_copy,
                    .arguments_json = arguments_copy,
                };
                count += 1;
            }
            if (count == 0) {
                alloc.free(buffer);
            } else if (count < buffer.len) {
                output.tool_calls = try alloc.dupe(ToolCall, buffer[0..count]);
                alloc.free(buffer);
            } else {
                output.tool_calls = buffer;
            }
        }
    }

    return output;
}

fn parseGatewayUsage(root: std.json.ObjectMap) types.Usage {
    const usage_value = root.get("usage") orelse return .{};
    if (usage_value != .object) return .{};
    const usage = usage_value.object;
    const input_value = usage.get("inputTokens") orelse
        usage.get("promptTokens") orelse
        usage.get("prompt_tokens");
    const output_value = usage.get("outputTokens") orelse
        usage.get("completionTokens") orelse
        usage.get("completion_tokens");
    const input_tokens = parseGatewayTokenValue(input_value);
    const output_tokens = parseGatewayTokenValue(output_value);
    var cache_read_tokens = parseGatewayTokenDetail(input_value, "cacheRead");
    var cache_write_tokens = parseGatewayTokenDetail(input_value, "cacheWrite");
    if (cache_read_tokens == null) {
        cache_read_tokens = parseGatewayTokenDetail(
            usage.get("promptTokensDetails") orelse usage.get("prompt_tokens_details"),
            "cachedTokens",
        );
    }
    if (cache_write_tokens == null) {
        cache_write_tokens = parseGatewayTokenDetail(
            usage.get("promptTokensDetails") orelse usage.get("prompt_tokens_details"),
            "cacheCreationTokens",
        );
    }
    if (input_tokens) |input| {
        if (cache_read_tokens) |read| {
            if (read > input) cache_read_tokens = null;
        }
        if (cache_write_tokens) |write| {
            if (write > input) cache_write_tokens = null;
        }
    }

    const gateway_cost = if (root.get("providerMetadata")) |metadata|
        if (metadata == .object)
            if (metadata.object.get("gateway")) |gateway|
                if (gateway == .object) parseMicroDollarsValue(gateway.object.get("cost")) else null
            else
                null
        else
            null
    else
        null;
    const usage_cost = parseMicroDollarsValue(usage.get("cost"));
    return .{
        .input_tokens = input_tokens,
        .output_tokens = output_tokens,
        .cache_read_tokens = cache_read_tokens,
        .cache_write_tokens = cache_write_tokens,
        .cost_micro_usd = gateway_cost orelse usage_cost,
    };
}

fn parseGatewayTokenValue(value: ?std.json.Value) ?u64 {
    const actual = value orelse return null;
    return switch (actual) {
        .integer => |number| if (number >= 0) std.math.cast(u64, number) else null,
        .number_string => |text| std.fmt.parseInt(u64, text, 10) catch null,
        .object => parseGatewayTokenValue(actual.object.get("total")),
        else => null,
    };
}

fn parseGatewayTokenDetail(value: ?std.json.Value, detail: []const u8) ?u64 {
    const actual = value orelse return null;
    if (actual != .object) return null;
    return parseGatewayTokenValue(actual.object.get(detail));
}

fn parseMicroDollarsValue(value: ?std.json.Value) ?u64 {
    const actual = value orelse return null;
    return switch (actual) {
        .string => |text| types.parseMicroDollars(text),
        .number_string => |text| types.parseMicroDollars(text),
        .integer => |number| if (number >= 0)
            std.math.mul(u64, std.math.cast(u64, number) orelse return null, 1_000_000) catch null
        else
            null,
        .float => |number| types.microDollarsFromFloat(number),
        .object => parseMicroDollarsValue(actual.object.get("total")),
        else => null,
    };
}

pub fn freeGatewayCompletion(alloc: std.mem.Allocator, completion: GatewayCompletion) void {
    if (completion.content) |content| alloc.free(content);
    for (completion.tool_calls) |tool_call| {
        alloc.free(tool_call.id);
        alloc.free(tool_call.name);
        alloc.free(tool_call.arguments_json);
    }
    if (completion.tool_calls.len > 0) alloc.free(completion.tool_calls);
    if (completion.provider_state_json) |state| alloc.free(state);
    if (completion.reasoning_details_json) |details| alloc.free(@constCast(details));
}

fn checkParseGatewayCompletionAllocFailures(alloc: std.mem.Allocator) !void {
    const body = "{\"choices\":[{\"finish_reason\":\"tool_calls\",\"message\":{\"content\":\"hello\",\"tool_calls\":[{\"id\":\"call_1\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{}\"}},{\"id\":\"call_2\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"src/main.zig\\\"}\"}}]}}]}";

    const completion = try parseGatewayCompletion(alloc, body);
    defer freeGatewayCompletion(alloc, completion);

    try std.testing.expectEqualStrings("hello", completion.content.?);
    try std.testing.expectEqual(types.ProviderFinishReason.tool_calls, completion.finish_reason.?);
    try std.testing.expectEqual(@as(usize, 2), completion.tool_calls.len);
}

test "roleName returns exact gateway role strings" {
    try std.testing.expectEqualStrings("system", roleName(.system));
    try std.testing.expectEqualStrings("user", roleName(.user));
    try std.testing.expectEqualStrings("assistant", roleName(.assistant));
    try std.testing.expectEqualStrings("tool", roleName(.tool));
}

test "gateway request serializes an optional structured response format" {
    const alloc = std.testing.allocator;
    const messages = [_]ChatMessage{.{ .role = .user, .content = "inspect" }};
    const body = try buildGatewayRequestBodyValidated(
        alloc,
        "[]",
        &messages,
        .{},
        "none",
        null,
        null,
        .{
            .name = "fx_vision_evidence",
            .description = "Evidence \"only\"",
            .schema_json = "{\"type\":\"object\",\"additionalProperties\":false}",
        },
        null,
    );
    defer alloc.free(body);

    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, body, .{});
    defer parsed.deinit();
    const format = parsed.value.object.get("responseFormat").?;
    try std.testing.expectEqualStrings("json", format.object.get("type").?.string);
    try std.testing.expectEqualStrings("fx_vision_evidence", format.object.get("name").?.string);
    try std.testing.expectEqualStrings("Evidence \"only\"", format.object.get("description").?.string);
    try std.testing.expectEqualStrings("object", format.object.get("schema").?.object.get("type").?.string);

    const plain = try buildGatewayRequestBody(alloc, "[]", &messages);
    defer alloc.free(plain);
    var plain_parsed = try std.json.parseFromSlice(std.json.Value, alloc, plain, .{});
    defer plain_parsed.deinit();
    try std.testing.expect(plain_parsed.value.object.get("responseFormat") == null);

    try std.testing.expectError(
        error.InvalidStructuredResponseSchema,
        buildGatewayRequestBodyValidated(
            alloc,
            "[]",
            &messages,
            .{},
            "none",
            null,
            null,
            .{
                .name = "invalid",
                .description = "invalid",
                .schema_json = "not json",
            },
            null,
        ),
    );
}

test "writeChatMessageJson serializes user text plus image file parts through core image writer" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    {
        var file = try tmp.dir.createFile(std.testing.io, "image.png", .{});
        defer file.close(std.testing.io);
        try file.writeStreamingAll(std.testing.io, "\x89PNG\r\n\x1a\nabc");
    }

    const image_path = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "image.png");
    defer alloc.free(image_path);

    const source = [_]types.ImageAttachment{.{
        .id = 1,
        .path = @constCast(image_path),
        .media_type = @constCast("image/png"),
    }};
    const images = try types.dupeImageAttachmentSlice(alloc, &source);
    defer types.freeImageAttachmentSlice(alloc, images);
    const root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, ".");
    defer alloc.free(root);
    const snapshot_dir = try std.fs.path.join(alloc, &.{ root, "snapshots" });
    defer alloc.free(snapshot_dir);
    try image_attachments.captureImageSnapshot(alloc, &images[0], snapshot_dir);

    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    try writeChatMessageJson(alloc, &out.writer, .{
        .role = .user,
        .content = "look",
        .images = images,
    });
    const json = out.written();

    try std.testing.expect(std.mem.find(u8, json, "\"type\":\"text\"") != null);
    try std.testing.expect(std.mem.find(u8, json, "\"text\":\"look\"") != null);
    try std.testing.expect(std.mem.find(u8, json, "\"type\":\"file\"") != null);
    try std.testing.expect(std.mem.find(u8, json, "\"mediaType\":\"image/png\"") != null);
    try std.testing.expect(std.mem.find(u8, json, "\"data\":\"iVBORw0KGgphYmM=\"") != null);
}

test "writeChatMessageJson serializes assistant tool call input as raw json" {
    const alloc = std.testing.allocator;
    const calls = [_]ToolCall{.{
        .id = "call_1",
        .name = "read_file",
        .arguments_json = "{\"path\":\"src/main.zig\"}",
    }};

    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    try writeChatMessageJson(alloc, &out.writer, .{
        .role = .assistant,
        .content = "I will read it",
        .tool_calls = &calls,
    });
    const json = out.written();

    try std.testing.expect(std.mem.find(u8, json, "\"type\":\"tool-call\"") != null);
    try std.testing.expect(std.mem.find(u8, json, "\"toolCallId\":\"call_1\"") != null);
    try std.testing.expect(std.mem.find(u8, json, "\"toolName\":\"read_file\"") != null);
    try std.testing.expect(std.mem.find(u8, json, "\"input\":{\"path\":\"src/main.zig\"}") != null);
}

test "writeChatMessageJson serializes tool-result fallbacks and escaped output" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    try writeChatMessageJson(alloc, &out.writer, .{
        .role = .tool,
        .content = "line\n\ttext",
    });
    const json = out.written();

    try std.testing.expect(std.mem.find(u8, json, "\"type\":\"tool-result\"") != null);
    try std.testing.expect(std.mem.find(u8, json, "\"toolCallId\":\"\"") != null);
    try std.testing.expect(std.mem.find(u8, json, "\"toolName\":\"unknown\"") != null);
    try std.testing.expect(std.mem.find(u8, json, "\"value\":\"line\\n\\ttext\"") != null);
}

test "writeChatMessageJsonCached adds provider options and non-cached omits them" {
    const alloc = std.testing.allocator;
    var cached_out: std.Io.Writer.Allocating = .init(alloc);
    defer cached_out.deinit();
    var uncached_out: std.Io.Writer.Allocating = .init(alloc);
    defer uncached_out.deinit();

    const message: ChatMessage = .{ .role = .system, .content = "rules" };
    try writeChatMessageJsonCached(alloc, &cached_out.writer, message);
    try writeChatMessageJson(alloc, &uncached_out.writer, message);

    try std.testing.expect(std.mem.find(u8, cached_out.written(), "\"providerOptions\"") != null);
    try std.testing.expect(std.mem.find(u8, cached_out.written(), "\"cacheControl\":{\"type\":\"ephemeral\"}") != null);
    try std.testing.expect(std.mem.find(u8, uncached_out.written(), "providerOptions") == null);

    var long_out: std.Io.Writer.Allocating = .init(alloc);
    defer long_out.deinit();
    try writeChatMessageJsonInner(alloc, &long_out.writer, message, .long, null, null);
    try std.testing.expect(std.mem.find(u8, long_out.written(), "\"cacheControl\":{\"type\":\"ephemeral\",\"ttl\":\"1h\"}") != null);
}

fn promptStringEntryHasCacheControl(body: []const u8, needle: []const u8) !bool {
    const alloc = std.testing.allocator;
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, body, .{});
    defer parsed.deinit();

    const prompt = parsed.value.object.get("prompt") orelse return error.TestExpectedPromptMissing;
    if (prompt != .array) return error.TestExpectedPromptMissing;
    for (prompt.array.items) |entry| {
        if (entry != .object) continue;
        const content = entry.object.get("content") orelse continue;
        if (content != .string) continue;
        if (std.mem.find(u8, content.string, needle) == null) continue;
        return entry.object.get("providerOptions") != null;
    }
    return error.TestExpectedPromptMessageMissing;
}

test "buildGatewayRequestBodyWithOptions leaves transient system messages uncached" {
    const alloc = std.testing.allocator;
    const msgs = [_]ChatMessage{
        .{ .role = .system, .content = "stable system prompt" },
        .{ .role = .system, .content = "static project context" },
        .{ .role = .system, .content = "volatile runtime overlay", .cache_policy = .no_cache },
        .{ .role = .user, .content = "first question" },
        .{ .role = .assistant, .content = "answer" },
        .{ .role = .user, .content = "follow up" },
    };
    const body = try buildGatewayRequestBodyWithOptions(alloc, "[]", &msgs, .{ .prompt_caching = true }, .auto);
    defer alloc.free(body);

    try std.testing.expectEqual(@as(usize, 0), std.mem.count(u8, body, "\"cacheControl\":{\"type\":\"ephemeral\"}"));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, body, cache_control_long));
    try std.testing.expect(!try promptStringEntryHasCacheControl(body, "stable system prompt"));
    try std.testing.expect(try promptStringEntryHasCacheControl(body, "static project context"));
    try std.testing.expect(!try promptStringEntryHasCacheControl(body, "volatile runtime overlay"));

    const overlay_idx = std.mem.indexOf(u8, body, "volatile runtime overlay") orelse return error.TestExpectedPromptMessageMissing;
    try std.testing.expect(std.mem.find(u8, body[overlay_idx..], "cacheControl") == null);
}

test "findCacheMarks closes the stable prefix and moves the breakpoint past the tail overlay" {
    const messages = [_]ChatMessage{
        .{ .role = .system, .content = "system prompt" },
        .{ .role = .system, .content = "project context" },
        .{ .role = .user, .content = "first question" },
        .{ .role = .assistant, .content = "answer" },
        .{ .role = .tool, .content = "output", .tool_call_id = "call_1", .tool_name = "read_file" },
        .{ .role = .system, .content = "volatile runtime overlay", .cache_policy = .no_cache },
    };
    const marks = findCacheMarks(&messages);
    try std.testing.expectEqual(@as(?usize, 1), marks.stable_prefix_idx);
    try std.testing.expectEqual(@as(?usize, 4), marks.breakpoint_idx);
    try std.testing.expectEqual(@as(?usize, null), marks.history_end_idx);
    try std.testing.expectEqual(CacheTtl.long, cacheTtlForMessage(messages[1], 1, marks, true));
    try std.testing.expectEqual(CacheTtl.short, cacheTtlForMessage(messages[4], 4, marks, true));
    try std.testing.expectEqual(CacheTtl.none, cacheTtlForMessage(messages[3], 3, marks, true));

    const with_history = [_]ChatMessage{
        .{ .role = .system, .content = "system prompt" },
        .{ .role = .user, .content = "first question" },
        .{ .role = .assistant, .content = "answer" },
        .{ .role = .user, .content = "follow up" },
        .{ .role = .assistant, .content = "working", .tool_calls = &.{} },
    };
    const history_marks = findCacheMarks(&with_history);
    try std.testing.expectEqual(@as(?usize, 0), history_marks.stable_prefix_idx);
    try std.testing.expectEqual(@as(?usize, 2), history_marks.history_end_idx);
    try std.testing.expectEqual(@as(?usize, 4), history_marks.breakpoint_idx);
    try std.testing.expectEqual(@as(?usize, null), findCacheMarks(with_history[0..2]).history_end_idx);

    const only_prefix = findCacheMarks(messages[0..2]);
    try std.testing.expectEqual(@as(?usize, 1), only_prefix.stable_prefix_idx);
    try std.testing.expectEqual(@as(?usize, null), only_prefix.breakpoint_idx);

    const no_system = findCacheMarks(messages[2..]);
    try std.testing.expectEqual(@as(?usize, null), no_system.stable_prefix_idx);
    try std.testing.expectEqual(@as(?usize, 2), no_system.breakpoint_idx);
    try std.testing.expectEqual(@as(?usize, null), findCacheMarks(&.{}).breakpoint_idx);
}

test "buildGatewayRequestBodyWithOptions keeps Anthropic default silent and named effort provider neutral" {
    const alloc = std.testing.allocator;
    const messages = [_]ChatMessage{
        .{ .role = .user, .content = "question" },
    };

    const default_body = try buildGatewayRequestBodyWithOptions(alloc, "[]", &messages, .{}, .auto);
    defer alloc.free(default_body);
    var default_parsed = try std.json.parseFromSlice(std.json.Value, alloc, default_body, .{});
    defer default_parsed.deinit();
    try std.testing.expect(default_parsed.value.object.get("reasoning") == null);
    try std.testing.expect(default_parsed.value.object.get("providerOptions") == null);

    const named_body = try buildGatewayRequestBodyWithOptions(alloc, "[]", &messages, .{
        .reasoning = types.ReasoningEffort.literal("future-tier"),
    }, .auto);
    defer alloc.free(named_body);
    var named_parsed = try std.json.parseFromSlice(std.json.Value, alloc, named_body, .{});
    defer named_parsed.deinit();
    try std.testing.expectEqualStrings("future-tier", named_parsed.value.object.get("reasoning").?.string);
    try std.testing.expect(named_parsed.value.object.get("providerOptions") == null);
}

test "required gateway request serializes required tool choice and max output" {
    const alloc = std.testing.allocator;
    const messages = [_]ChatMessage{
        .{ .role = .user, .content = "question" },
    };

    const body = try buildGatewayRequiredToolRequestBodyWithMaxOutputTokens(alloc, "[]", &messages, 4096);
    defer alloc.free(body);

    try std.testing.expectEqualStrings(
        "{\"prompt\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"question\"}]}],\"tools\":[],\"toolChoice\":{\"type\":\"required\"},\"maxOutputTokens\":4096}",
        body,
    );
}

test "required gateway request validates history" {
    const alloc = std.testing.allocator;
    const messages = [_]ChatMessage{
        .{ .role = .user, .content = "question" },
        .{ .role = .tool, .content = "orphan", .tool_call_id = "call_1", .tool_name = "read_file" },
    };

    try std.testing.expectError(
        error.InvalidGatewayHistory,
        buildGatewayRequiredToolRequestBodyWithMaxOutputTokens(alloc, "[]", &messages, 4096),
    );
}

test "pending tool review closes the exact assistant step with synthetic pending results" {
    var cancel = std.atomic.Value(bool).init(false);
    const deadline = std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{
        .clock = .awake,
        .raw = .fromMilliseconds(1000),
    });
    const messages = [_]ChatMessage{
        .{ .role = .system, .content = "Review only install." },
        .{ .role = .user, .content = "Install dependencies." },
        .{ .role = .assistant, .tool_calls = &.{
            .{ .id = "install", .name = "run_command", .arguments_json = "{\"command\":\"pnpm install\"}" },
            .{ .id = "read", .name = "read_file", .arguments_json = "{\"path\":\"package.json\"}" },
        } },
    };

    const body = try buildGatewayPendingToolReviewRequestBodyWithMaxOutputTokens(
        std.testing.allocator,
        "[]",
        &messages,
        "install",
        .{ .reasoning = types.ReasoningEffort.literal("minimal") },
        2048,
        deadline,
        &cancel,
    );
    defer std.testing.allocator.free(body);

    try std.testing.expect(std.mem.find(u8, body, "\"toolCallId\":\"install\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"toolCallId\":\"read\"") != null);
    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, body, "\"role\":\"tool\""));
    try std.testing.expectEqual(
        @as(usize, 2),
        std.mem.count(u8, body, "Tool call has not executed; it is pending permission review."),
    );
    try std.testing.expect(std.mem.find(u8, body, "\"maxOutputTokens\":2048") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"reasoning\":\"minimal\"") != null);
    try std.testing.expectError(
        error.InvalidGatewayHistory,
        buildGatewayRequestBody(std.testing.allocator, "[]", &messages),
    );
}

test "pending tool review rejects missing or duplicate target ids" {
    var cancel = std.atomic.Value(bool).init(false);
    const deadline = std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{
        .clock = .awake,
        .raw = .fromMilliseconds(1000),
    });
    const messages = [_]ChatMessage{
        .{ .role = .system, .content = "Review it." },
        .{ .role = .user, .content = "Run this." },
        .{ .role = .assistant, .tool_calls = &.{
            .{ .id = "duplicate", .name = "run_command", .arguments_json = "{}" },
            .{ .id = "duplicate", .name = "read_file", .arguments_json = "{}" },
        } },
    };

    try std.testing.expectError(
        error.InvalidGatewayHistory,
        buildGatewayPendingToolReviewRequestBodyWithMaxOutputTokens(
            std.testing.allocator,
            "[]",
            &messages,
            "duplicate",
            .{},
            2048,
            deadline,
            &cancel,
        ),
    );
    try std.testing.expectError(
        error.InvalidGatewayHistory,
        buildGatewayPendingToolReviewRequestBodyWithMaxOutputTokens(
            std.testing.allocator,
            "[]",
            &messages,
            "missing",
            .{},
            2048,
            deadline,
            &cancel,
        ),
    );
}

test "buildGatewayRequestBodyWithOptions serializes Gateway Fast provider options" {
    const alloc = std.testing.allocator;
    const messages = [_]ChatMessage{
        .{ .role = .user, .content = "question" },
    };

    const body = try buildGatewayRequestBodyWithOptions(alloc, "[]", &messages, .{
        .reasoning = types.ReasoningEffort.literal("future-tier"),
        .fast = true,
    }, .auto);
    defer alloc.free(body);

    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, body, .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings("future-tier", parsed.value.object.get("reasoning").?.string);
    try std.testing.expect(parsed.value.object.get("fast") == null);
    const provider_options = parsed.value.object.get("providerOptions").?;
    const gateway = provider_options.object.get("gateway").?;
    try std.testing.expectEqualStrings("fast", gateway.object.get("speed").?.string);

    const automatic = try buildGatewayRequestBodyWithOptions(alloc, "[]", &messages, .{}, .auto);
    defer alloc.free(automatic);
    var parsed_automatic = try std.json.parseFromSlice(std.json.Value, alloc, automatic, .{});
    defer parsed_automatic.deinit();
    try std.testing.expect(parsed_automatic.value.object.get("reasoning") == null);
    try std.testing.expect(parsed_automatic.value.object.get("fast") == null);
    try std.testing.expect(parsed_automatic.value.object.get("providerOptions") == null);
}

test "buildGatewayRequestBodyWithOptions combines Gateway Fast and xai options" {
    const alloc = std.testing.allocator;
    const messages = [_]ChatMessage{
        .{ .role = .user, .content = "question" },
    };

    const body = try buildGatewayRequestBodyWithOptions(alloc, "[]", &messages, .{
        .fast = true,
        .parallel_tool_calls = true,
    }, .auto);
    defer alloc.free(body);

    try std.testing.expect(std.mem.find(u8, body, "\"providerOptions\":{\"gateway\":{\"speed\":\"fast\"},\"xai\":{\"parallelToolCalls\":true}}") != null);
}

test "formatGatewayRequestShapeSummary reports content kinds without request content" {
    const alloc = std.testing.allocator;
    var calls = [_]ToolCall{.{
        .id = "call_1",
        .name = "read_file",
        .arguments_json = "{\"path\":\"SECRET_TOOL_ARGUMENT_PATH\"}",
    }};
    const messages = [_]ChatMessage{
        .{ .role = .system, .content = "SECRET_SYSTEM_PROMPT" },
        .{ .role = .user, .content = "SECRET_USER_PROMPT" },
        .{ .role = .assistant, .tool_calls = calls[0..] },
        .{ .role = .tool, .content = "SECRET_TOOL_OUTPUT", .tool_call_id = "call_1", .tool_name = "read_file" },
    };

    const body = try buildGatewayRequestBodyWithOptions(
        alloc,
        "[{\"name\":\"SECRET_TOOL_SCHEMA\"}]",
        &messages,
        .{},
        .auto,
    );
    defer alloc.free(body);

    const valid_summary = try formatGatewayRequestShapeSummary(alloc, body);
    defer alloc.free(valid_summary);

    try std.testing.expect(std.mem.find(u8, valid_summary, "prompt_count=4") != null);
    try std.testing.expect(std.mem.find(u8, valid_summary, "prompt.0 role=system content=string") != null);
    try std.testing.expect(std.mem.find(u8, valid_summary, "prompt.1 role=user content=array") != null);
    try std.testing.expect(std.mem.find(u8, valid_summary, "prompt.2 role=assistant content=array") != null);
    try std.testing.expect(std.mem.find(u8, valid_summary, "prompt.3 role=tool content=array") != null);
    try std.testing.expect(std.mem.find(u8, valid_summary, "tools_count=1") != null);
    try std.testing.expect(std.mem.find(u8, valid_summary, "toolChoice=auto") != null);
    try std.testing.expect(std.mem.find(u8, valid_summary, "SECRET_SYSTEM_PROMPT") == null);
    try std.testing.expect(std.mem.find(u8, valid_summary, "SECRET_USER_PROMPT") == null);
    try std.testing.expect(std.mem.find(u8, valid_summary, "SECRET_TOOL_ARGUMENT_PATH") == null);
    try std.testing.expect(std.mem.find(u8, valid_summary, "SECRET_TOOL_OUTPUT") == null);
    try std.testing.expect(std.mem.find(u8, valid_summary, "SECRET_TOOL_SCHEMA") == null);

    const mutated =
        \\{"prompt":[{"role":"system","content":[{"type":"text","text":"SECRET_MUTATED_SYSTEM"}]}],"tools":[],"toolChoice":{"type":"auto"}}
    ;
    const mutated_summary = try formatGatewayRequestShapeSummary(alloc, mutated);
    defer alloc.free(mutated_summary);

    try std.testing.expect(std.mem.find(u8, mutated_summary, "prompt.0 role=system content=array") != null);
    try std.testing.expect(std.mem.find(u8, mutated_summary, "SECRET_MUTATED_SYSTEM") == null);
}

test "buildGatewayRequestBodyWithOptions includes cache markers for anthropic" {
    const alloc = std.testing.allocator;
    const messages = [_]ChatMessage{
        .{ .role = .system, .content = "system prompt" },
        .{ .role = .user, .content = "first question" },
        .{ .role = .assistant, .content = "answer" },
        .{ .role = .user, .content = "follow up" },
    };
    const body = try buildGatewayRequestBodyWithOptions(alloc, "[]", &messages, .{ .prompt_caching = true }, .auto);
    defer alloc.free(body);

    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, body, anthropic_cache_meta));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, body, anthropic_cache_meta_long));
    try std.testing.expect(try promptStringEntryHasCacheControl(body, "system prompt"));
    try std.testing.expect(std.mem.find(u8, body, "\"text\":\"first question\"}]}") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"text\":\"answer\"}]" ++ anthropic_cache_meta) != null);
    try std.testing.expect(std.mem.find(u8, body, "\"text\":\"follow up\"}]" ++ anthropic_cache_meta) != null);
}

test "buildGatewayRequestBodyWithOptions omits cache markers when disabled" {
    const alloc = std.testing.allocator;
    const messages = [_]ChatMessage{
        .{ .role = .system, .content = "system prompt" },
        .{ .role = .user, .content = "question" },
    };
    const body = try buildGatewayRequestBodyWithOptions(alloc, "[]", &messages, .{}, .auto);
    defer alloc.free(body);

    try std.testing.expect(std.mem.find(u8, body, "cacheControl") == null);
}

test "gateway request validation accepts paired assistant tool calls and results" {
    const alloc = std.testing.allocator;
    var calls = [_]ToolCall{.{
        .id = "call_1",
        .name = "read_file",
        .arguments_json = "{\"path\":\"src/main.zig\"}",
    }};
    const messages = [_]ChatMessage{
        .{ .role = .user, .content = "read it" },
        .{ .role = .assistant, .tool_calls = calls[0..] },
        .{ .role = .tool, .content = "contents", .tool_call_id = "call_1", .tool_name = "read_file" },
        .{ .role = .assistant, .content = "done" },
    };

    const body = try buildGatewayRequestBodyWithOptions(alloc, "[]", &messages, .{}, .auto);
    defer alloc.free(body);
    try std.testing.expect(std.mem.find(u8, body, "\"toolCallId\":\"call_1\"") != null);
}

test "gateway request validation rejects unpaired tool result" {
    const alloc = std.testing.allocator;
    const messages = [_]ChatMessage{
        .{ .role = .user, .content = "hello" },
        .{ .role = .tool, .content = "orphan", .tool_call_id = "call_1", .tool_name = "read_file" },
    };

    try std.testing.expectError(error.InvalidGatewayHistory, buildGatewayRequestBodyWithOptions(alloc, "[]", &messages, .{}, .auto));
}

test "gateway request validation rejects malformed tool call arguments" {
    const alloc = std.testing.allocator;
    var calls = [_]ToolCall{.{
        .id = "call_1",
        .name = "read_file",
        .arguments_json = "{not json",
    }};
    const messages = [_]ChatMessage{
        .{ .role = .assistant, .tool_calls = calls[0..] },
        .{ .role = .tool, .content = "contents", .tool_call_id = "call_1", .tool_name = "read_file" },
    };

    try std.testing.expectError(error.InvalidGatewayHistory, buildGatewayRequestBodyWithOptions(alloc, "[]", &messages, .{}, .auto));
}

test "gateway request validation rejects duplicate-key tool call arguments" {
    const alloc = std.testing.allocator;
    var calls = [_]ToolCall{.{
        .id = "call_1",
        .name = "read_file",
        .arguments_json = "{\"depth\":1,\"depth\":2}",
    }};
    const messages = [_]ChatMessage{
        .{ .role = .assistant, .tool_calls = calls[0..] },
        .{ .role = .tool, .content = "contents", .tool_call_id = "call_1", .tool_name = "read_file" },
    };

    try std.testing.expectError(error.InvalidGatewayHistory, buildGatewayRequestBodyWithOptions(alloc, "[]", &messages, .{}, .auto));
}

test "gateway request validation preserves argument parser allocation failure" {
    var calls = [_]ToolCall{.{
        .id = "call_1",
        .name = "read_file",
        .arguments_json = "{\"path\":\"src/main.zig\"}",
    }};
    const messages = [_]ChatMessage{
        .{ .role = .assistant, .tool_calls = calls[0..] },
        .{ .role = .tool, .content = "contents", .tool_call_id = "call_1", .tool_name = "read_file" },
    };
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });

    try std.testing.expectError(error.OutOfMemory, validateToolMessageHistory(failing.allocator(), &messages));
}

test "gateway request validation rejects assistant tool call without result" {
    const alloc = std.testing.allocator;
    var calls = [_]ToolCall{.{
        .id = "call_1",
        .name = "read_file",
        .arguments_json = "{}",
    }};
    const messages = [_]ChatMessage{
        .{ .role = .assistant, .tool_calls = calls[0..] },
        .{ .role = .assistant, .content = "next" },
    };

    try std.testing.expectError(error.InvalidGatewayHistory, buildGatewayRequestBodyWithOptions(alloc, "[]", &messages, .{}, .auto));
}

test "gateway request validation accepts out-of-order tool results by id" {
    const alloc = std.testing.allocator;
    var calls = [_]ToolCall{
        .{
            .id = "call_1",
            .name = "read_file",
            .arguments_json = "{\"path\":\"a.txt\"}",
        },
        .{
            .id = "call_2",
            .name = "list_files",
            .arguments_json = "{\"path\":\".\"}",
        },
    };
    const messages = [_]ChatMessage{
        .{ .role = .assistant, .tool_calls = calls[0..] },
        .{ .role = .tool, .content = "second", .tool_call_id = "call_2", .tool_name = "list_files" },
        .{ .role = .tool, .content = "first", .tool_call_id = "call_1", .tool_name = "read_file" },
    };

    const body = try buildGatewayRequestBodyWithOptions(alloc, "[]", &messages, .{}, .auto);
    defer alloc.free(body);
    try std.testing.expect(std.mem.find(u8, body, "\"toolCallId\":\"call_2\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"toolCallId\":\"call_1\"") != null);
}

test "gateway request validation rejects duplicate tool result ids" {
    const alloc = std.testing.allocator;
    var calls = [_]ToolCall{
        .{
            .id = "call_1",
            .name = "read_file",
            .arguments_json = "{\"path\":\"a.txt\"}",
        },
        .{
            .id = "call_2",
            .name = "list_files",
            .arguments_json = "{\"path\":\".\"}",
        },
    };
    const messages = [_]ChatMessage{
        .{ .role = .assistant, .tool_calls = calls[0..] },
        .{ .role = .tool, .content = "first", .tool_call_id = "call_1", .tool_name = "read_file" },
        .{ .role = .tool, .content = "duplicate", .tool_call_id = "call_1", .tool_name = "read_file" },
    };

    try std.testing.expectError(error.InvalidGatewayHistory, buildGatewayRequestBodyWithOptions(alloc, "[]", &messages, .{}, .auto));
}

test "gateway request validation rejects mismatched tool result names" {
    const alloc = std.testing.allocator;
    var calls = [_]ToolCall{.{
        .id = "call_1",
        .name = "read_file",
        .arguments_json = "{\"path\":\"src/main.zig\"}",
    }};
    const messages = [_]ChatMessage{
        .{ .role = .assistant, .tool_calls = calls[0..] },
        .{ .role = .tool, .content = "contents", .tool_call_id = "call_1", .tool_name = "write_file" },
    };

    try std.testing.expectError(error.InvalidGatewayHistory, buildGatewayRequestBodyWithOptions(alloc, "[]", &messages, .{}, .auto));
}

test "parseMicroDollarsValue converts a JSON float cost to micro-dollars" {
    try std.testing.expectEqual(@as(?u64, 4200), parseMicroDollarsValue(.{ .float = 0.0042 }));
    try std.testing.expectEqual(@as(?u64, 0), parseMicroDollarsValue(.{ .float = 0.0 }));
    try std.testing.expectEqual(@as(?u64, 1), parseMicroDollarsValue(.{ .float = 0.0000006 }));
    try std.testing.expectEqual(@as(?u64, null), parseMicroDollarsValue(.{ .float = -0.5 }));
    try std.testing.expectEqual(@as(?u64, null), parseMicroDollarsValue(.{ .float = std.math.nan(f64) }));
    try std.testing.expectEqual(@as(?u64, null), parseMicroDollarsValue(.{ .float = std.math.inf(f64) }));
}

test "parseGatewayCompletion duplicates returned strings" {
    const alloc = std.testing.allocator;
    const body = try alloc.dupe(
        u8,
        "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"hello\",\"tool_calls\":[{\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]}}]}",
    );
    defer alloc.free(body);

    const completion = try parseGatewayCompletion(alloc, body);
    defer freeGatewayCompletion(alloc, completion);

    @memset(body, 'x');

    try std.testing.expectEqualStrings("hello", completion.content.?);
    try std.testing.expectEqual(types.ProviderFinishReason.stop, completion.finish_reason.?);
    try std.testing.expectEqualStrings("call_1", completion.tool_calls[0].id);
    try std.testing.expectEqualStrings("read_file", completion.tool_calls[0].name);
    try std.testing.expectEqualStrings("{}", completion.tool_calls[0].arguments_json);
}

test "parseGatewayCompletion skips malformed tool call entries" {
    const alloc = std.testing.allocator;
    const body =
        "{\"choices\":[{\"message\":{\"content\":\"ok\",\"tool_calls\":[" ++
        "42," ++
        "{\"id\":7,\"function\":{\"name\":\"bad\",\"arguments\":\"{}\"}}," ++
        "{\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"a\\\"}\"}}" ++
        "]}}]}";

    const completion = try parseGatewayCompletion(alloc, body);
    defer freeGatewayCompletion(alloc, completion);

    try std.testing.expectEqual(@as(usize, 1), completion.tool_calls.len);
    try std.testing.expectEqualStrings("call_1", completion.tool_calls[0].id);
    try std.testing.expectEqualStrings("read_file", completion.tool_calls[0].name);
    try std.testing.expectEqualStrings("{\"path\":\"a\"}", completion.tool_calls[0].arguments_json);
}

test "parseGatewayCompletion rejects malformed legacy tool arguments" {
    const body =
        "{\"choices\":[{\"finish_reason\":\"tool_calls\",\"message\":{\"tool_calls\":[" ++
        "{\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{]\"}}" ++
        "]}}]}";

    try std.testing.expectError(
        error.InvalidGatewayResponse,
        parseGatewayCompletion(std.testing.allocator, body),
    );
}

test "parseGatewayCompletion rejects duplicate-key legacy tool arguments" {
    const body =
        "{\"choices\":[{\"finish_reason\":\"tool_calls\",\"message\":{\"tool_calls\":[" ++
        "{\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"depth\\\":1,\\\"depth\\\":2}\"}}" ++
        "]}}]}";

    try std.testing.expectError(
        error.InvalidGatewayResponse,
        parseGatewayCompletion(std.testing.allocator, body),
    );
}

test "parseGatewayCompletion cleans up allocation failures" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, checkParseGatewayCompletionAllocFailures, .{});
}

test "freeGatewayCompletion frees parsed completions under testing allocator" {
    const alloc = std.testing.allocator;
    const body = "{\"choices\":[{\"finish_reason\":\"tool_calls\",\"message\":{\"content\":\"hello\",\"tool_calls\":[{\"id\":\"call_1\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{}\"}}]}}]}";

    const completion = try parseGatewayCompletion(alloc, body);
    freeGatewayCompletion(alloc, completion);
}
