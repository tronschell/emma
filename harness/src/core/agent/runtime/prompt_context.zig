const std = @import("std");
const model_capabilities = @import("../../config/model_capabilities.zig");
const types = @import("../../shared/types.zig");
const session_runtime = @import("../../session/session.zig");
const gateway_json = @import("../../gateway/gateway_json.zig");

const runtime_config = @import("config.zig");

const Allocator = std.mem.Allocator;
const ChatMessage = types.ChatMessage;
const HistoryTurn = types.HistoryTurn;

pub fn historyContextBudgetTokensForCapabilities(capabilities: model_capabilities.Capabilities) usize {
    const context_window = capabilities.context_window orelse
        return runtime_config.default_history_context_budget_tokens;
    const context_tokens: usize = @intCast(context_window);
    const available_input_tokens = if (capabilities.max_output_tokens) |max_output_tokens|
        context_tokens -| @as(usize, @intCast(max_output_tokens))
    else
        context_tokens;
    return @max(
        @as(usize, 1),
        available_input_tokens / runtime_config.history_context_budget_window_divisor,
    );
}

pub const unfinished_tool_result_output =
    "The turn was interrupted before this tool call reported a result. It may have partially run, " ++
    "so check the current state before reissuing it.";

pub fn buildGatewayMessages(
    alloc: Allocator,
    stable_prefix: []const ChatMessage,
    ephemeral_overlay: []const ChatMessage,
    durable_history: []const ChatMessage,
    current_user_message: ChatMessage,
    within_turn_suffix: []const ChatMessage,
) !std.ArrayList(ChatMessage) {
    var messages: std.ArrayList(ChatMessage) = .empty;
    errdefer messages.deinit(alloc);

    try messages.appendSlice(alloc, stable_prefix);
    try messages.appendSlice(alloc, durable_history);
    try appendEphemeralOverlayMessages(alloc, &messages, ephemeral_overlay);
    try messages.append(alloc, current_user_message);
    try messages.appendSlice(alloc, within_turn_suffix);
    try ensureToolResultsPresent(alloc, &messages);
    return messages;
}

pub fn ensureToolResultsPresent(
    alloc: Allocator,
    messages: *std.ArrayList(ChatMessage),
) !void {
    var index: usize = 0;
    while (index < messages.items.len) {
        const assistant = messages.items[index];
        if (assistant.role != .assistant or assistant.tool_calls.len == 0) {
            index += 1;
            continue;
        }
        var block_end = index + 1;
        while (block_end < messages.items.len and
            messages.items[block_end].role == .tool) : (block_end += 1)
        {}
        for (assistant.tool_calls) |call| {
            if (hasToolResult(messages.items[index + 1 .. block_end], call.id)) continue;
            try messages.insert(alloc, block_end, .{
                .role = .tool,
                .content = unfinished_tool_result_output,
                .tool_call_id = call.id,
                .tool_name = call.name,
                .tool_result_status = .failure,
            });
            block_end += 1;
        }
        index = block_end;
    }
}

fn hasToolResult(results: []const ChatMessage, call_id: []const u8) bool {
    for (results) |result| {
        const existing = result.tool_call_id orelse continue;
        if (std.mem.eql(u8, existing, call_id)) return true;
    }
    return false;
}

fn appendEphemeralOverlayMessages(alloc: Allocator, messages: *std.ArrayList(ChatMessage), ephemeral_overlay: []const ChatMessage) !void {
    for (ephemeral_overlay) |overlay_message| {
        var copy = overlay_message;
        copy.cache_policy = .no_cache;
        try messages.append(alloc, copy);
    }
}

test "history context budget reserves known output capacity from one capability snapshot" {
    const cases = [_]struct {
        capabilities: model_capabilities.Capabilities,
        expected: usize,
    }{
        .{ .capabilities = .{ .context_window = 128_000, .max_output_tokens = 32_000 }, .expected = 24_000 },
        .{ .capabilities = .{ .context_window = 256_000, .max_output_tokens = 64_000 }, .expected = 48_000 },
        .{ .capabilities = .{ .context_window = 1_000_000, .max_output_tokens = 128_000 }, .expected = 218_000 },
        .{ .capabilities = .{ .context_window = 512_000 }, .expected = 128_000 },
        .{ .capabilities = .{ .max_output_tokens = 32_000 }, .expected = runtime_config.default_history_context_budget_tokens },
        .{ .capabilities = .{ .context_window = 32_000, .max_output_tokens = 32_000 }, .expected = 1 },
        .{ .capabilities = .{ .context_window = 32_000, .max_output_tokens = 64_000 }, .expected = 1 },
        .{ .capabilities = .{}, .expected = runtime_config.default_history_context_budget_tokens },
    };

    for (cases) |case| {
        try std.testing.expectEqual(
            case.expected,
            historyContextBudgetTokensForCapabilities(case.capabilities),
        );
    }
}

test "budgeted history projection uses corrected Anthropic window while remaining bounded" {
    const alloc = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const large_user = try arena.alloc(u8, 120_000);
    @memset(large_user, 'u');
    const large_assistant = try arena.alloc(u8, 120_000);
    @memset(large_assistant, 'a');

    var history: [5]HistoryTurn = undefined;
    for (&history) |*turn| {
        turn.* = try session_runtime.makeAssistantTurn(arena, large_user, large_assistant);
    }

    const exact_budget = historyContextBudgetTokensForCapabilities(
        model_capabilities.capabilitiesForModel("anthropic/claude-opus-4.8"),
    );
    try std.testing.expectEqual(@as(usize, 250_000), exact_budget);

    var below_new_budget: std.ArrayList(ChatMessage) = .empty;
    try session_runtime.appendHistoryChatMessagesBudgeted(
        arena,
        &below_new_budget,
        history[0..4],
        .{ .max_tokens = exact_budget },
    );
    try std.testing.expectEqual(@as(usize, 8), below_new_budget.items.len);
    try std.testing.expectEqualStrings(large_assistant, below_new_budget.items[below_new_budget.items.len - 1].content.?);

    var above_new_budget: std.ArrayList(ChatMessage) = .empty;
    try session_runtime.appendHistoryChatMessagesBudgeted(
        arena,
        &above_new_budget,
        &history,
        .{ .max_tokens = exact_budget },
    );
    try std.testing.expectEqual(types.ChatRole.system, above_new_budget.items[0].role);
    try std.testing.expectEqual(@as(usize, 9), above_new_budget.items.len);
    try std.testing.expectEqualStrings(large_assistant, above_new_budget.items[above_new_budget.items.len - 1].content.?);

    const body = try gateway_json.buildGatewayRequestBodyWithOptions(
        arena,
        "[]",
        above_new_budget.items,
        .{},
        .auto,
    );
    try std.testing.expect(body.len < 1_100_000);

    var older_model_projection: std.ArrayList(ChatMessage) = .empty;
    try session_runtime.appendHistoryChatMessagesBudgeted(
        arena,
        &older_model_projection,
        history[0..4],
        .{ .max_tokens = historyContextBudgetTokensForCapabilities(model_capabilities.capabilitiesForModel("anthropic/claude-opus-4.5")) },
    );
    try std.testing.expectEqual(types.ChatRole.system, older_model_projection.items[0].role);
    try std.testing.expectEqual(@as(usize, 3), older_model_projection.items.len);
    try std.testing.expectEqualStrings(large_assistant, older_model_projection.items[older_model_projection.items.len - 1].content.?);
}

test "buildGatewayMessages orders stable prefix history live delta and current prompt" {
    const alloc = std.testing.allocator;
    const stable_prefix = [_]ChatMessage{
        .{ .role = .system, .content = "stable system prompt" },
        .{ .role = .system, .content = "stable project context" },
    };
    const overlay = [_]ChatMessage{
        .{ .role = .system, .content = "volatile runtime overlay" },
    };
    const history = [_]ChatMessage{
        .{ .role = .user, .content = "history user prompt" },
        .{ .role = .assistant, .content = "history assistant answer" },
    };
    const current = ChatMessage{ .role = .user, .content = "current user prompt" };
    const suffix = [_]ChatMessage{
        .{ .role = .assistant, .content = "within turn assistant" },
    };

    var messages = try buildGatewayMessages(alloc, &stable_prefix, &overlay, &history, current, &suffix);
    defer messages.deinit(alloc);

    try std.testing.expectEqual(@as(usize, 7), messages.items.len);
    try std.testing.expectEqualStrings("stable system prompt", messages.items[0].content.?);
    try std.testing.expectEqualStrings("stable project context", messages.items[1].content.?);
    try std.testing.expectEqualStrings("history user prompt", messages.items[2].content.?);
    try std.testing.expectEqualStrings("history assistant answer", messages.items[3].content.?);
    try std.testing.expectEqualStrings("volatile runtime overlay", messages.items[4].content.?);
    try std.testing.expectEqualStrings("current user prompt", messages.items[5].content.?);
    try std.testing.expectEqualStrings("within turn assistant", messages.items[6].content.?);
    try std.testing.expectEqual(types.ChatRole.system, messages.items[4].role);
    try std.testing.expectEqual(types.ChatCachePolicy.no_cache, messages.items[4].cache_policy);

    const changed_overlay = [_]ChatMessage{
        .{ .role = .system, .content = "different volatile runtime overlay" },
    };
    var changed_messages = try buildGatewayMessages(alloc, &stable_prefix, &changed_overlay, &history, current, &suffix);
    defer changed_messages.deinit(alloc);
    const before_prefix = try gateway_json.buildGatewayRequestBody(alloc, "[]", messages.items[0..4]);
    defer alloc.free(before_prefix);
    const after_prefix = try gateway_json.buildGatewayRequestBody(alloc, "[]", changed_messages.items[0..4]);
    defer alloc.free(after_prefix);
    try std.testing.expectEqualStrings(before_prefix, after_prefix);
}

test "buildGatewayMessages preserves one system prefix for projected session history" {
    const alloc = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var calls = [_]types.ToolCall{.{
        .id = "call_read",
        .name = "read_file",
        .arguments_json = "{\"path\":\"src/portable.zig\"}",
    }};
    var results = [_]types.PersistedToolResult{.{
        .tool_call_id = @constCast("call_read"),
        .tool_name = @constCast("read_file"),
        .status = .success,
        .output = @constCast("portable contents"),
        .output_bytes = 17,
        .stored_output_bytes = 17,
    }};
    var steps = [_]types.ToolExecutionStep{.{
        .assistant = @constCast("Reading the file."),
        .tool_calls = calls[0..],
        .tool_results = results[0..],
    }};
    var files = [_]types.FileEvidence{.{
        .path = @constCast("src/portable.zig"),
        .tool_call_id = @constCast("call_read"),
        .tool_name = @constCast("read_file"),
        .action = .read,
        .status = .success,
        .model_view_covers_full_file = true,
    }};
    const history = [_]HistoryTurn{
        .{ .compacted_summary = .{
            .summary = @constCast("LEADING_SUMMARY_ONLY"),
            .removed_turn_count = 2,
            .compaction_count = 1,
        } },
        .{ .assistant = .{
            .user = .{ .text = @constCast("inspect portable history") },
            .assistant = @constCast("inspection complete"),
            .execution = .{ .tool_steps = steps[0..], .files = files[0..] },
        } },
        .{ .compacted_summary = .{
            .summary = @constCast("LATE_SUMMARY_ONLY"),
            .removed_turn_count = 1,
            .compaction_count = 2,
        } },
        .{ .background_command = .{
            .user = .{ .text = @constCast("run portable server") },
            .assistant = @constCast("server started"),
            .log_path = @constCast("/tmp/portable.log"),
            .expect_url = false,
        } },
        .{ .interrupted = .{
            .user = .{ .text = @constCast("stop portable work") },
            .assistant = @constCast("partial portable work"),
        } },
    };

    var projected_history: std.ArrayList(ChatMessage) = .empty;
    defer projected_history.deinit(arena);
    try session_runtime.appendHistoryChatMessages(arena, &projected_history, &history);

    const stable_prefix = [_]ChatMessage{
        .{ .role = .system, .content = "stable system prompt" },
        .{ .role = .system, .content = "stable project context" },
    };
    const overlay = [_]ChatMessage{.{ .role = .system, .content = "ephemeral overlay" }};
    const current = ChatMessage{ .role = .user, .content = "current portable prompt" };
    const suffix = [_]ChatMessage{.{ .role = .assistant, .content = "within-turn suffix" }};
    var messages = try buildGatewayMessages(
        arena,
        &stable_prefix,
        &overlay,
        projected_history.items,
        current,
        &suffix,
    );
    defer messages.deinit(arena);

    var leading_summary_count: usize = 0;
    var late_summary_count: usize = 0;
    var file_evidence_count: usize = 0;
    var background_count: usize = 0;
    var interruption_count: usize = 0;
    for (messages.items[0..stable_prefix.len]) |entry| {
        try std.testing.expectEqual(types.ChatRole.system, entry.role);
    }
    for (messages.items[stable_prefix.len..]) |entry| {
        const content = entry.content orelse continue;
        if (std.mem.find(u8, content, "LEADING_SUMMARY_ONLY") != null) {
            try std.testing.expectEqual(types.ChatRole.system, entry.role);
            leading_summary_count += 1;
        }
        if (std.mem.find(u8, content, "LATE_SUMMARY_ONLY") != null) {
            try std.testing.expectEqual(types.ChatRole.user, entry.role);
            late_summary_count += 1;
        }
        if (std.mem.find(u8, content, "src/portable.zig") != null and
            std.mem.find(u8, content, "Session file evidence") != null)
        {
            try std.testing.expectEqual(types.ChatRole.user, entry.role);
            file_evidence_count += 1;
        }
        if (std.mem.find(u8, content, "/tmp/portable.log") != null) {
            try std.testing.expectEqual(types.ChatRole.user, entry.role);
            background_count += 1;
        }
        if (std.mem.find(u8, content, "<turn_aborted>") != null) {
            try std.testing.expectEqual(types.ChatRole.user, entry.role);
            interruption_count += 1;
        }
    }
    const overlay_index = stable_prefix.len + projected_history.items.len;
    try std.testing.expectEqual(types.ChatRole.system, messages.items[overlay_index].role);
    try std.testing.expectEqual(types.ChatCachePolicy.no_cache, messages.items[overlay_index].cache_policy);
    try std.testing.expectEqual(@as(usize, 1), leading_summary_count);
    try std.testing.expectEqual(@as(usize, 1), late_summary_count);
    try std.testing.expectEqual(@as(usize, 1), file_evidence_count);
    try std.testing.expectEqual(@as(usize, 1), background_count);
    try std.testing.expectEqual(@as(usize, 1), interruption_count);
    try std.testing.expectEqualStrings("current portable prompt", messages.items[messages.items.len - 2].content.?);
    try std.testing.expectEqualStrings("within-turn suffix", messages.items[messages.items.len - 1].content.?);
    try gateway_json.validateToolMessageHistory(arena, messages.items);
}

test "dangling tool call gains exactly one synthetic result in call position" {
    const alloc = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const calls = [_]types.ToolCall{
        .{ .id = "call_done", .name = "read_file", .arguments_json = "{}" },
        .{ .id = "call_dangling", .name = "run_command", .arguments_json = "{}" },
    };
    const suffix = [_]ChatMessage{
        .{ .role = .assistant, .content = "working", .tool_calls = calls[0..] },
        .{ .role = .tool, .content = "read", .tool_call_id = "call_done", .tool_name = "read_file", .tool_result_status = .success },
    };

    var messages = try buildGatewayMessages(
        arena,
        &.{},
        &.{},
        &.{},
        .{ .role = .user, .content = "prompt" },
        &suffix,
    );

    try std.testing.expectEqual(@as(usize, 4), messages.items.len);
    try std.testing.expectEqualStrings("call_done", messages.items[2].tool_call_id.?);
    try std.testing.expectEqual(types.ChatRole.tool, messages.items[3].role);
    try std.testing.expectEqualStrings("call_dangling", messages.items[3].tool_call_id.?);
    try std.testing.expectEqualStrings("run_command", messages.items[3].tool_name.?);
    try std.testing.expectEqualStrings(unfinished_tool_result_output, messages.items[3].content.?);
    try std.testing.expectEqual(types.PersistedToolStatus.failure, messages.items[3].tool_result_status.?);
    try gateway_json.validateToolMessageHistory(arena, messages.items);

    try ensureToolResultsPresent(arena, &messages);
    try std.testing.expectEqual(@as(usize, 4), messages.items.len);
}

test "tool result repair leaves well formed history byte identical across independent runs" {
    const alloc = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const calls = [_]types.ToolCall{
        .{ .id = "call_paired", .name = "read_file", .arguments_json = "{}" },
    };
    const paired = [_]ChatMessage{
        .{ .role = .assistant, .content = "working", .tool_calls = calls[0..] },
        .{ .role = .tool, .content = "read", .tool_call_id = "call_paired", .tool_name = "read_file", .tool_result_status = .success },
    };
    var untouched: std.ArrayList(ChatMessage) = .empty;
    try untouched.appendSlice(arena, &paired);
    const before = try gateway_json.buildGatewayRequestBodyWithOptions(arena, "[]", untouched.items, .{}, .auto);
    try ensureToolResultsPresent(arena, &untouched);
    const after = try gateway_json.buildGatewayRequestBodyWithOptions(arena, "[]", untouched.items, .{}, .auto);
    try std.testing.expectEqualStrings(before, after);

    const dangling = [_]ChatMessage{
        .{ .role = .assistant, .content = "working", .tool_calls = calls[0..] },
    };
    var first: std.ArrayList(ChatMessage) = .empty;
    try first.appendSlice(arena, &dangling);
    try ensureToolResultsPresent(arena, &first);
    var second: std.ArrayList(ChatMessage) = .empty;
    try second.appendSlice(arena, &dangling);
    try ensureToolResultsPresent(arena, &second);
    try std.testing.expectEqualStrings(
        try gateway_json.buildGatewayRequestBodyWithOptions(arena, "[]", first.items, .{}, .auto),
        try gateway_json.buildGatewayRequestBodyWithOptions(arena, "[]", second.items, .{}, .auto),
    );
}

test "mid stream cancellation during tool argument assembly leaves a repairable request" {
    const alloc = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const persisted_calls = [_]types.ToolCall{
        .{ .id = "call_persisted", .name = "read_file", .arguments_json = "{}" },
        .{ .id = "call_never_dispatched", .name = "run_command", .arguments_json = "{}" },
    };
    const persisted_results = [_]types.PersistedToolResult{
        .{ .tool_call_id = @constCast("call_persisted"), .tool_name = @constCast("read_file"), .status = .success, .output = @constCast("read"), .output_bytes = 4, .stored_output_bytes = 4, .created_at_ms = 1 },
    };
    var steps = [_]types.ToolExecutionStep{.{
        .assistant = @constCast("assembling"),
        .tool_calls = @constCast(persisted_calls[0..]),
        .tool_results = @constCast(persisted_results[0..]),
    }};
    const history = [_]HistoryTurn{.{ .interrupted = .{
        .user = .{ .text = @constCast("do the thing") },
        .execution = .{ .tool_steps = steps[0..] },
    } }};

    var history_messages: std.ArrayList(ChatMessage) = .empty;
    try session_runtime.appendHistoryChatMessages(arena, &history_messages, &history);
    try std.testing.expectError(
        error.InvalidGatewayHistory,
        gateway_json.validateToolMessageHistory(arena, history_messages.items),
    );

    const messages = try buildGatewayMessages(
        arena,
        &.{},
        &.{},
        history_messages.items,
        .{ .role = .user, .content = "continue" },
        &.{},
    );
    try gateway_json.validateToolMessageHistory(arena, messages.items);
    try std.testing.expectEqual(
        @as(usize, 1),
        std.mem.count(
            u8,
            try gateway_json.buildGatewayRequestBodyWithOptions(arena, "[]", messages.items, .{}, .auto),
            unfinished_tool_result_output,
        ),
    );
}
