const std = @import("std");
const build_options = @import("build_options");
const jsonrpc = @import("jsonrpc.zig");
const core_types = @import("../core/shared/types.zig");

const Allocator = std.mem.Allocator;
const writeJsonStr = jsonrpc.writeJsonStr;

pub const protocol_version: u32 = 1;

pub fn writeModelRecoveryInfoUpdate(
    writer: *std.Io.Writer,
    status: ?core_types.RouteRecoveryStatus,
    durable: bool,
) !void {
    try writer.writeAll("{\"sessionUpdate\":\"session_info_update\",\"_meta\":{\"fx\":{\"modelResponseRecovery\":");
    const recovery = status orelse {
        try writer.writeAll("null}}}");
        return;
    };
    try writer.writeAll("{\"state\":");
    try writeJsonStr(
        if (recovery.isRecovered())
            "recovered"
        else if (recovery.kind == .terminal_provider_error)
            "paused"
        else
            "active",
        writer,
    );
    try writer.writeAll(",\"kind\":");
    try writeJsonStr(@tagName(recovery.kind), writer);
    if (recovery.cause) |cause| {
        try writer.writeAll(",\"cause\":");
        try writeJsonStr(@tagName(cause), writer);
    }
    if (recovery.action) |action| {
        try writer.writeAll(",\"action\":");
        try writeJsonStr(@tagName(action), writer);
    }
    if (recovery.required_action != .none) {
        try writer.writeAll(",\"requiredAction\":");
        try writeJsonStr(@tagName(recovery.required_action), writer);
    }
    const reported_attempt = recovery.reportedAttempt();
    if (reported_attempt != 0) {
        try writer.print(",\"attempt\":{d}", .{reported_attempt});
    }
    if (recovery.attempt_limit != 0) {
        try writer.print(",\"attemptLimit\":{d}", .{recovery.attempt_limit});
    }
    if (recovery.delay_seconds != 0) {
        try writer.print(",\"delaySeconds\":{d}", .{recovery.delay_seconds});
    }
    try writer.print(",\"durable\":{s},\"message\":", .{if (durable) "true" else "false"});
    var label_buf: [core_types.RouteRecoveryStatus.label_max_bytes]u8 = undefined;
    try writeJsonStr(recovery.label(&label_buf), writer);
    try writer.writeAll("}}}}");
}

/// A context experiment that fired on one step. Emma's Harness settings switch
/// these on, and without this the levers work invisibly — the client has no way
/// to tell a step that was pruned from one that was not, and cannot say so.
pub fn writeContextExperimentInfoUpdate(
    writer: *std.Io.Writer,
    pruned_results: usize,
    reinjected: bool,
    saved_tokens: usize,
    added_tokens: usize,
) !void {
    try writer.writeAll("{\"sessionUpdate\":\"session_info_update\",\"_meta\":{\"fx\":{\"contextExperiment\":{\"prunedResults\":");
    try writer.print("{d}", .{pruned_results});
    try writer.writeAll(",\"reinjected\":");
    try writer.writeAll(if (reinjected) "true" else "false");
    try writer.print(",\"savedTokens\":{d},\"addedTokens\":{d}", .{ saved_tokens, added_tokens });
    try writer.writeAll("}}}}");
}

pub const StopReason = enum {
    end_turn,
    max_output_tokens,
    max_model_turns,
    refused,
    cancelled,

    pub fn jsonString(self: StopReason) []const u8 {
        return switch (self) {
            .end_turn => "end_turn",
            .max_output_tokens => "max_output_tokens",
            .max_model_turns => "max_model_turns",
            .refused => "refused",
            .cancelled => "cancelled",
        };
    }
};

pub const ToolCallKind = enum {
    read,
    edit,
    delete,
    move,
    search,
    execute,
    think,
    fetch,
    other,

    pub fn jsonString(self: ToolCallKind) []const u8 {
        return switch (self) {
            .read => "read",
            .edit => "edit",
            .delete => "delete",
            .move => "move",
            .search => "search",
            .execute => "execute",
            .think => "think",
            .fetch => "fetch",
            .other => "other",
        };
    }
};

pub const ToolCallStatus = enum {
    pending,
    in_progress,
    completed,
    failed,

    pub fn jsonString(self: ToolCallStatus) []const u8 {
        return switch (self) {
            .pending => "pending",
            .in_progress => "in_progress",
            .completed => "completed",
            .failed => "failed",
        };
    }
};

pub fn writeSessionUpdate(w: *std.Io.Writer, session_id: []const u8, update_json: []const u8) !void {
    try w.writeAll("{\"sessionId\":");
    try writeJsonStr(session_id, w);
    try w.writeAll(",\"update\":");
    try w.writeAll(update_json);
    try w.writeAll("}");
}

/// One subagent's update, riding the parent session's stream.
///
/// ACP has no nested sessions, so a child is carried on its parent's and named in
/// `_meta` — the client fans it back out onto a transcript of its own. Without
/// this a subagent is visible only to the TUI: nothing it says or does reaches a
/// front end, so it cannot be listed, opened, or watched.
///
/// Spliced in ahead of the object's closing brace rather than threaded through
/// every writer above, which would grow a `_meta` parameter on all of them for
/// one caller. `state` closes the child out: a front end that only ever saw
/// updates would have no way to know one had finished.
pub fn writeChildTaggedUpdate(
    w: *std.Io.Writer,
    update_json: []const u8,
    child_id: []const u8,
    title: []const u8,
    ended: bool,
) !void {
    // An update that carries its own `_meta` would end up with the key twice, and
    // an empty one has nothing to hang a comma off.
    if (update_json.len <= 2 or update_json[update_json.len - 1] != '}') return error.InvalidChildUpdate;
    if (std.mem.indexOf(u8, update_json, "\"_meta\"") != null) return error.InvalidChildUpdate;
    try w.writeAll(update_json[0 .. update_json.len - 1]);
    try w.writeAll(",\"_meta\":{\"fx\":{\"child\":{\"id\":");
    try writeJsonStr(child_id, w);
    try w.writeAll(",\"title\":");
    try writeJsonStr(title, w);
    try w.writeAll(",\"state\":");
    try writeJsonStr(if (ended) "ended" else "running", w);
    try w.writeAll("}}}}");
}

/// The bare update a child's last tag rides on, so its end is announced even when
/// it finished without saying anything.
pub const child_state_update = "{\"sessionUpdate\":\"session_info_update\"}";

test "a child's update is tagged with the child it came from" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try writeChildTaggedUpdate(&out.writer, child_state_update, "child-1", "read the docs", true);
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, out.writer.buffered(), .{});
    defer parsed.deinit();
    const child = parsed.value.object.get("_meta").?.object.get("fx").?.object.get("child").?.object;
    try std.testing.expectEqualStrings("child-1", child.get("id").?.string);
    try std.testing.expectEqualStrings("ended", child.get("state").?.string);
    try std.testing.expectEqualStrings("session_info_update", parsed.value.object.get("sessionUpdate").?.string);
}

test "an update that already carries _meta is refused rather than tagged twice" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try std.testing.expectError(error.InvalidChildUpdate, writeChildTaggedUpdate(&out.writer, "{\"_meta\":{}}", "c", "t", false));
    try std.testing.expectError(error.InvalidChildUpdate, writeChildTaggedUpdate(&out.writer, "{}", "c", "t", false));
}

pub fn writeAgentMessageChunk(w: *std.Io.Writer, text: []const u8) !void {
    try w.writeAll("{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":");
    try writeJsonStr(text, w);
    try w.writeAll("}}");
}

/// The model's reasoning, which ACP keeps apart from the answer so a client can
/// fold it away. Standard `agent_thought_chunk`, not an extension.
pub fn writeAgentThoughtChunk(w: *std.Io.Writer, text: []const u8) !void {
    try w.writeAll("{\"sessionUpdate\":\"agent_thought_chunk\",\"content\":{\"type\":\"text\",\"text\":");
    try writeJsonStr(text, w);
    try w.writeAll("}}");
}

pub fn writeUserMessageChunk(w: *std.Io.Writer, text: []const u8) !void {
    try w.writeAll("{\"sessionUpdate\":\"user_message_chunk\",\"content\":{\"type\":\"text\",\"text\":");
    try writeJsonStr(text, w);
    try w.writeAll("}}");
}

/// `raw_input_json` is ACP's optional `rawInput`: the call's arguments exactly as
/// the model sent them. Upstream published it only on a permission request, which
/// left a client's timeline able to say a tool ran but never with what — and the
/// arguments are the whole of diagnosing why a run got stuck.
pub fn writeToolCall(
    w: *std.Io.Writer,
    tool_call_id: []const u8,
    title: []const u8,
    kind: ToolCallKind,
    status: ToolCallStatus,
    raw_input_json: ?[]const u8,
) !void {
    try w.writeAll("{\"sessionUpdate\":\"tool_call\",\"toolCallId\":");
    try writeJsonStr(tool_call_id, w);
    try w.writeAll(",\"title\":");
    try writeJsonStr(title, w);
    try w.writeAll(",\"kind\":");
    try writeJsonStr(kind.jsonString(), w);
    try w.writeAll(",\"status\":");
    try writeJsonStr(status.jsonString(), w);
    if (raw_input_json) |json| {
        // Sent as a string, not spliced in as an object: the arguments come off
        // the wire from a model and are not this writer's to vouch for as JSON.
        try w.writeAll(",\"rawInput\":");
        try writeJsonStr(json, w);
    }
    try w.writeAll("}");
}

pub fn writeToolCallUpdate(w: *std.Io.Writer, tool_call_id: []const u8, status: ToolCallStatus, content_text: ?[]const u8) !void {
    try writeToolCallUpdateWithCommandResult(w, tool_call_id, status, content_text, null);
}

pub fn writeToolCallUpdateWithCommandResult(
    w: *std.Io.Writer,
    tool_call_id: []const u8,
    status: ToolCallStatus,
    content_text: ?[]const u8,
    command_result_json: ?[]const u8,
) !void {
    try w.writeAll("{\"sessionUpdate\":\"tool_call_update\",\"toolCallId\":");
    try writeJsonStr(tool_call_id, w);
    try w.writeAll(",\"status\":");
    try writeJsonStr(status.jsonString(), w);
    if (content_text) |text| {
        try w.writeAll(",\"content\":[{\"type\":\"content\",\"content\":{\"type\":\"text\",\"text\":");
        try writeJsonStr(text, w);
        try w.writeAll("}}]");
    }
    if (command_result_json) |json| {
        try w.writeAll(",\"command_result\":");
        try w.writeAll(json);
    }
    try w.writeAll("}");
}

pub fn writeInitializeResponse(w: *std.Io.Writer) !void {
    try w.writeAll("{\"protocolVersion\":");
    try w.print("{d}", .{protocol_version});
    try w.writeAll(",\"agentCapabilities\":{");
    try w.writeAll("\"loadSession\":true,");
    try w.writeAll("\"promptCapabilities\":{\"image\":false,\"audio\":false,\"embeddedContext\":true},");
    try w.writeAll("\"mcpCapabilities\":{\"http\":true,\"sse\":true},");
    try w.writeAll("\"sessionCapabilities\":{\"list\":{},\"resume\":{},\"close\":{}}");
    try w.writeAll("},\"agentInfo\":{\"name\":\"fx\",\"title\":\"fx\",\"version\":");
    try writeJsonStr(build_options.app_version, w);
    try w.writeAll("},");
    try w.writeAll("\"authMethods\":[]}");
}

/// What one turn cost. Upstream ACP has no usage field, so this is an Emma
/// extension on the `session/prompt` result: a client that does not know it
/// ignores it, and Emma reads it straight into the turn's telemetry.
pub const TurnUsage = struct {
    input_tokens: u64 = 0,
    output_tokens: u64 = 0,
};

pub fn writePromptResponse(w: *std.Io.Writer, reason: StopReason, usage: TurnUsage) !void {
    try w.writeAll("{\"stopReason\":");
    try writeJsonStr(reason.jsonString(), w);
    try w.print(
        ",\"usage\":{{\"inputTokens\":{d},\"outputTokens\":{d}}}}}",
        .{ usage.input_tokens, usage.output_tokens },
    );
}

pub fn writeAvailableCommandsUpdate(w: *std.Io.Writer, commands_json: []const u8) !void {
    try w.writeAll("{\"sessionUpdate\":\"available_commands_update\",\"availableCommands\":");
    try w.writeAll(commands_json);
    try w.writeAll("}");
}

test "writeAgentMessageChunk produces valid json" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeAgentMessageChunk(&out.writer, "Hello world");
    const expected = "{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"Hello world\"}}";
    try std.testing.expectEqualStrings(expected, out.writer.buffered());
}

test "writeAgentThoughtChunk produces valid json" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeAgentThoughtChunk(&out.writer, "weighing it up");
    const expected = "{\"sessionUpdate\":\"agent_thought_chunk\",\"content\":{\"type\":\"text\",\"text\":\"weighing it up\"}}";
    try std.testing.expectEqualStrings(expected, out.writer.buffered());
}

test "writeToolCall produces valid json" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeToolCall(&out.writer, "call_001", "Reading file", .read, .pending, null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"toolCallId\":\"call_001\"") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"kind\":\"read\"") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "rawInput") == null);
}

test "writeToolCall carries the arguments as an escaped string" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeToolCall(&out.writer, "call_004", "Running", .execute, .pending, "{\"command\":\"ls\"}");
    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, out.writer.buffered(), .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings(
        "{\"command\":\"ls\"}",
        parsed.value.object.get("rawInput").?.string,
    );
}

test "writePromptResponse produces valid json" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writePromptResponse(&out.writer, .end_turn, .{ .input_tokens = 12, .output_tokens = 34 });
    try std.testing.expectEqualStrings(
        "{\"stopReason\":\"end_turn\",\"usage\":{\"inputTokens\":12,\"outputTokens\":34}}",
        out.writer.buffered(),
    );
}

test "StopReason jsonString values" {
    try std.testing.expectEqualStrings("end_turn", StopReason.end_turn.jsonString());
    try std.testing.expectEqualStrings("cancelled", StopReason.cancelled.jsonString());
    try std.testing.expectEqualStrings("max_output_tokens", StopReason.max_output_tokens.jsonString());
}

test "ToolCallKind jsonString values" {
    try std.testing.expectEqualStrings("read", ToolCallKind.read.jsonString());
    try std.testing.expectEqualStrings("edit", ToolCallKind.edit.jsonString());
    try std.testing.expectEqualStrings("execute", ToolCallKind.execute.jsonString());
    try std.testing.expectEqualStrings("search", ToolCallKind.search.jsonString());
    try std.testing.expectEqualStrings("other", ToolCallKind.other.jsonString());
}

test "ToolCallStatus jsonString values" {
    try std.testing.expectEqualStrings("pending", ToolCallStatus.pending.jsonString());
    try std.testing.expectEqualStrings("in_progress", ToolCallStatus.in_progress.jsonString());
    try std.testing.expectEqualStrings("completed", ToolCallStatus.completed.jsonString());
    try std.testing.expectEqualStrings("failed", ToolCallStatus.failed.jsonString());
}

test "writeToolCallUpdate with content" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeToolCallUpdate(&out.writer, "call_002", .completed, "File written successfully");
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"tool_call_update\"") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"completed\"") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "File written successfully") != null);
}

test "writeToolCallUpdate can include structured command result" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    try writeToolCallUpdateWithCommandResult(
        &out.writer,
        "call_002",
        .completed,
        "exit_code=0\n<stdout>\nok\n</stdout>\n",
        "{\"kind\":\"foreground\",\"command\":\"printf ok\",\"cwd\":\"/tmp\",\"exit_code\":0,\"signal\":null,\"timed_out\":false,\"stdout_bytes\":2,\"stderr_bytes\":0,\"truncated\":false,\"sandbox_denied\":false}",
    );
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, out.writer.buffered(), .{});
    defer parsed.deinit();

    try std.testing.expectEqualStrings("tool_call_update", parsed.value.object.get("sessionUpdate").?.string);
    const command_result = parsed.value.object.get("command_result").?.object;
    try std.testing.expectEqualStrings("foreground", command_result.get("kind").?.string);
    try std.testing.expectEqual(@as(i64, 0), command_result.get("exit_code").?.integer);
    try std.testing.expect(parsed.value.object.get("content") != null);
}

test "writeToolCallUpdate without content" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeToolCallUpdate(&out.writer, "call_003", .in_progress, null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"in_progress\"") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "content") == null);
}

test "writeInitializeResponse contains required fields" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeInitializeResponse(&out.writer);
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, out.writer.buffered(), .{});
    defer parsed.deinit();

    const agent_capabilities = parsed.value.object.get("agentCapabilities").?.object;
    const mcp_capabilities = agent_capabilities.get("mcpCapabilities").?.object;
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"protocolVersion\":1") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"loadSession\":true") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"name\":\"fx\"") != null);
    try std.testing.expectEqualStrings(
        build_options.app_version,
        parsed.value.object.get("agentInfo").?.object.get("version").?.string,
    );
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"image\":false") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"list\":{}") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"resume\":{}") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"close\":{}") != null);
    try std.testing.expect(mcp_capabilities.get("http").?.bool);
    try std.testing.expect(mcp_capabilities.get("sse").?.bool);
}

test "writeUserMessageChunk produces valid json" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeUserMessageChunk(&out.writer, "User says hello");
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"user_message_chunk\"") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "User says hello") != null);
}

test "writeSessionUpdate wraps update with sessionId" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeSessionUpdate(&out.writer, "sess_123", "{\"sessionUpdate\":\"test\"}");
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"sessionId\":\"sess_123\"") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"sessionUpdate\":\"test\"") != null);
}

test "model recovery info update is structured and clearable" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeModelRecoveryInfoUpdate(&out.writer, .{
        .kind = .terminal_provider_error,
        .failed_attempt = 4,
        .attempt_limit = 10,
        .cause = .system_resumed,
        .action = .paused,
        .required_action = .continue_later,
        .diagnostic = core_types.ModelFailureDiagnostic.init("ConnectionResetByPeer"),
    }, true);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"state\":\"paused\"") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"cause\":\"system_resumed\"") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"requiredAction\":\"continue_later\"") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"attempt\":4") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"durable\":true") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "ConnectionResetByPeer") != null);

    out.writer.end = 0;
    try writeModelRecoveryInfoUpdate(&out.writer, .{
        .kind = .auto_recovered,
        .succeeded_attempt = 5,
        .attempt_limit = 10,
    }, true);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"state\":\"recovered\"") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"attempt\":5") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "ConnectionResetByPeer") == null);

    out.writer.end = 0;
    try writeModelRecoveryInfoUpdate(&out.writer, null, false);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"modelResponseRecovery\":null") != null);
}

test "context experiment info update reports both levers" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeContextExperimentInfoUpdate(&out.writer, 6, false, 12_400, 0);
    try std.testing.expectEqualStrings(
        "{\"sessionUpdate\":\"session_info_update\",\"_meta\":{\"fx\":{\"contextExperiment\":{\"prunedResults\":6,\"reinjected\":false,\"savedTokens\":12400,\"addedTokens\":0}}}}",
        out.writer.buffered(),
    );

    out.writer.end = 0;
    try writeContextExperimentInfoUpdate(&out.writer, 0, true, 0, 310);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"reinjected\":true") != null);
    try std.testing.expect(std.mem.find(u8, out.writer.buffered(), "\"addedTokens\":310") != null);
}
