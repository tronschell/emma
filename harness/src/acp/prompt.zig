const std = @import("std");
const std_builtin = @import("builtin");
const command_admission = @import("../core/permissions/command_admission.zig");
const auth_runtime = @import("../core/auth/auth_runtime.zig");
const credentials = @import("../core/auth/credentials.zig");
const model_provider = @import("../core/config/model_provider.zig");
const host = @import("../core/hosts/host.zig");
const host_target = @import("../core/hosts/target.zig");
const io_mod = @import("../core/shared/io.zig");
const jsonrpc = @import("jsonrpc.zig");
const acp_types = @import("types.zig");
const server = @import("server.zig");
const sessions = @import("sessions.zig");
const agent_runtime = @import("../core/agent/agent_runtime.zig");
const diff_mod = @import("../core/output/diff.zig");
const file_mutation = @import("../core/tooling/file_mutation.zig");
const file_mutation_contract = @import("../core/tooling/file_mutation_contract.zig");
const mcp_runtime = @import("../core/mcp/mcp_runtime.zig");
const mcp_model_catalog = @import("../core/mcp/model_catalog.zig");
const mcp_elicitation = @import("../core/mcp/elicitation.zig");
const mrtr = @import("../core/mcp/mrtr.zig");
const permission_auto_classifier = @import("../core/permissions/auto_classifier.zig");
const auto_classifier_context = @import("../core/permissions/auto_classifier_context.zig");
const permission_gate = @import("../core/permissions/permission_gate.zig");
const permission_request = @import("../core/permissions/permission_request.zig");
const sandbox = @import("../core/permissions/sandbox.zig");
const session_codec = @import("../core/session/session_codec.zig");
const session_log = @import("../core/session/session_log.zig");
const session_store = @import("../core/session/session_store.zig");
const session_runtime = @import("../core/session/session.zig");
const session_usage = @import("../core/session/session_usage.zig");
const subagent_agent_adapter = @import("../core/subagent/agent_adapter.zig");
const subagent_domain = @import("../core/subagent/domain.zig");
const subagent_execution = @import("../core/subagent/execution.zig");
const subagent_resume_admission = @import("../core/subagent/resume_admission.zig");
const parent_delivery_projector = @import("../core/subagent/parent_delivery_projector.zig");
const usage_recovery = @import("../core/session/usage_recovery.zig");
const skill_runtime = @import("../core/skills/skill_runtime.zig");
const skill_invocation = @import("../core/skills/skill_invocation.zig");
const context_contract = @import("../core/workspace/context_contract.zig");
const context_experiments = @import("../core/agent/runtime/context_experiments.zig");
const image_attachments = @import("../core/images/image_attachments.zig");
const config_runtime = @import("../core/config/config_runtime.zig");
const model_capabilities = @import("../core/config/model_capabilities.zig");
const mode_registry = @import("../core/modes/mode_registry.zig");
const debug_trace = @import("../core/shared/debug_trace.zig");
const display_width = @import("../core/shared/display_width.zig");
const text_utils = @import("../core/shared/text_utils.zig");
const tool_advertisement = @import("../core/tooling/tool_advertisement.zig");
const tool_admission = @import("../core/tooling/tool_admission.zig");
const tool_dispatch = @import("../core/tooling/tool_dispatch.zig");
const tool_specs = @import("../core/tooling/tool_specs.zig");
const tool_set_contract = @import("../core/tooling/tool_set.zig");
const tool_mcp_runtime = @import("../core/tooling/tool_mcp_runtime.zig");
const tool_presentation = @import("../core/tooling/tool_presentation.zig");
const tool_result_errors = @import("../core/tooling/tool_result_errors.zig");
const tool_runtime = @import("../core/tooling/tool_runtime.zig");
const command_output_content = @import("../core/tooling/command_output_content.zig");
const builtin_tools = @import("../builtins/tools.zig");
const test_builtin_gateway = if (std_builtin.is_test)
    @import("../builtins/gateway.zig")
else
    struct {};
const types = @import("../core/shared/types.zig");
const worker_runtime = @import("../core/agent/worker_runtime.zig");

const Allocator = std.mem.Allocator;
const ErrorCode = jsonrpc.ErrorCode;

pub const no_active_session_rpc_error = jsonrpc.RpcError{
    .code = ErrorCode.invalid_params,
    .message = "No active session",
};
const ToolCall = types.ToolCall;
const ChatMessage = types.ChatMessage;
const HistoryTurn = types.HistoryTurn;
const PermissionGrant = types.PermissionGrant;
const PermissionMode = types.PermissionMode;
const ToolPermissionDecision = types.ToolPermissionDecision;
const ToolExecutionResult = agent_runtime.ToolExecutionResult;
const McpHasToolFn = tool_mcp_runtime.HasToolFn;

pub const TerminalOutcome = union(enum) {
    /// Why the turn stopped, plus what it cost, summed over this turn's steps.
    stop_reason: struct {
        reason: acp_types.StopReason,
        usage: acp_types.TurnUsage = .{},
    },
    rpc_error: jsonrpc.RpcError,
};

/// Which subagent an `AcpContext` speaks for, when it is not the session itself.
/// Set only on the context `runSubagentChild` builds, so tagging is a property of
/// the context rather than something every send site has to remember.
const ChildTag = struct {
    id: []const u8,
    title: []const u8,
    ended: bool = false,
};

const AcpContext = struct {
    alloc: Allocator,
    state: *server.ServerState,
    session_id: []const u8,
    /// Set when this context belongs to a subagent rather than to the session.
    child: ?ChildTag = null,
    /// Tool-call IDs already announced with a pending update. Keys are owned
    /// copies of provider call ids so the ID stays stable from permission
    /// review through execution.
    published_tool_calls: std.StringHashMapUnmanaged(void) = .empty,
    stop_reason: acp_types.StopReason = .end_turn,
    auto_classifier: permission_auto_classifier.Classifier =
        permission_auto_classifier.Classifier.disabled(),
    /// Mode and permission policy captured at prompt dispatch so mid-turn
    /// session/set_mode changes never mutate a running turn.
    captured_mode: ?[]const u8 = null,
    captured_permission_mode: ?PermissionMode = null,
    captured_sandbox_backend: ?sandbox.BackendKind = null,
    /// Summed across every model step in this turn.
    ///
    /// Not the session ledger's before/after delta, which is what this used to
    /// be and why every turn reported zero: the ledger only credits usage that
    /// arrives with a Vercel AI Gateway generation identity (`gen_` plus 26
    /// Crockford characters), and an OpenAI-compatible provider has none — so
    /// `session_usage.record` took its early return and the counters never moved.
    /// The per-step `report_usage` callback carries the numbers the provider
    /// actually sent, and every other front end was already reading them there.
    /// ponytail: the ledger stays at zero for this route, so `/usage` and cost
    /// reporting still under-count; fixing that means giving the ledger a path
    /// for usage with no billing identity.
    turn_usage: acp_types.TurnUsage = .{},
    context_breakdown: acp_types.ContextBreakdown = .{},
    context_breakdown_sent: bool = false,

    fn sendContextBreakdown(self: *AcpContext) void {
        if (self.context_breakdown_sent) return;
        self.context_breakdown_sent = true;
        var out: std.Io.Writer.Allocating = .init(self.alloc);
        defer out.deinit();
        acp_types.writeContextBreakdownInfoUpdate(&out.writer, self.context_breakdown) catch return;
        self.sendUpdate(out.writer.buffered()) catch {};
    }

    fn noteTurnUsage(self: *AcpContext, usage: types.Usage) void {
        if (usage.input_tokens) |input| self.turn_usage.input_tokens = input;
        self.turn_usage.output_tokens +|= usage.output_tokens orelse 0;
    }

    fn deinitPublishedToolCalls(self: *AcpContext) void {
        var keys = self.published_tool_calls.keyIterator();
        while (keys.next()) |key| self.alloc.free(key.*);
        self.published_tool_calls.deinit(self.alloc);
    }

    fn sendRawUpdate(self: *AcpContext, update_json: []const u8) !void {
        var out: std.Io.Writer.Allocating = .init(self.alloc);
        defer out.deinit();
        try acp_types.writeSessionUpdate(&out.writer, self.session_id, update_json);
        try self.state.writer.writeNotification(self.alloc, "session/update", out.writer.buffered());
    }

    fn sendUpdate(self: *AcpContext, update_json: []const u8) !void {
        // A subagent's words are not the session's answer, so they are tagged
        // rather than merged: untagged, a child's text would land in the parent's
        // durable reply as if the parent had said it.
        const child = self.child orelse return self.sendRawUpdate(update_json);
        var tagged: std.Io.Writer.Allocating = .init(self.alloc);
        defer tagged.deinit();
        try acp_types.writeChildTaggedUpdate(&tagged.writer, update_json, child.id, child.title, child.ended);
        try self.sendRawUpdate(tagged.writer.buffered());
    }

    /// Closes a child out, so a front end watching it knows the run ended rather
    /// than inferring it from the updates stopping.
    fn sendChildEnded(self: *AcpContext) !void {
        if (self.child == null) return;
        self.child.?.ended = true;
        try self.sendUpdate(acp_types.child_state_update);
    }

    fn sendAgentText(self: *AcpContext, text: []const u8) !void {
        const plain = try stripAnsiAlloc(self.alloc, text);
        defer if (plain.ptr != text.ptr) self.alloc.free(plain);
        var out: std.Io.Writer.Allocating = .init(self.alloc);
        defer out.deinit();
        try acp_types.writeAgentMessageChunk(&out.writer, plain);
        try self.sendUpdate(out.writer.buffered());
    }

    fn sendAgentThought(self: *AcpContext, text: []const u8) !void {
        const plain = try stripAnsiAlloc(self.alloc, text);
        defer if (plain.ptr != text.ptr) self.alloc.free(plain);
        var out: std.Io.Writer.Allocating = .init(self.alloc);
        defer out.deinit();
        try acp_types.writeAgentThoughtChunk(&out.writer, plain);
        try self.sendUpdate(out.writer.buffered());
    }

    fn sendModelRecoveryStatus(
        self: *AcpContext,
        status: types.RouteRecoveryStatus,
    ) !void {
        var out: std.Io.Writer.Allocating = .init(self.alloc);
        defer out.deinit();
        try acp_types.writeModelRecoveryInfoUpdate(
            &out.writer,
            status,
            self.state.active_session.?.writable != null,
        );
        try self.sendUpdate(out.writer.buffered());
    }

    fn clearModelRecoveryStatus(self: *AcpContext) !void {
        var out: std.Io.Writer.Allocating = .init(self.alloc);
        defer out.deinit();
        try acp_types.writeModelRecoveryInfoUpdate(&out.writer, null, false);
        try self.sendUpdate(out.writer.buffered());
    }

    fn sendToolCallPending(self: *AcpContext, arena: Allocator, call: ToolCall) ![]const u8 {
        if (self.published_tool_calls.getKey(call.id)) |published| return published;
        const registry = self.toolRegistry();
        const title = describeToolTitle(registry, arena, call) catch "Tool call";
        const kind = mapToolKind(call.name);

        const owned_id = try self.alloc.dupe(u8, call.id);
        errdefer self.alloc.free(owned_id);
        var out: std.Io.Writer.Allocating = .init(self.alloc);
        defer out.deinit();
        try acp_types.writeToolCall(&out.writer, owned_id, title, kind, .pending, boundedArguments(call.arguments_json));
        try self.sendUpdate(out.writer.buffered());
        try self.published_tool_calls.put(self.alloc, owned_id, {});
        return owned_id;
    }

    fn sendToolCallProgressText(self: *AcpContext, tool_call_id: []const u8, text: ?[]const u8) !void {
        const plain = if (text) |value| try stripAnsiAlloc(self.alloc, value) else null;
        defer if (plain) |value| if (text) |original| {
            if (value.ptr != original.ptr) self.alloc.free(value);
        };
        var out: std.Io.Writer.Allocating = .init(self.alloc);
        defer out.deinit();
        try acp_types.writeToolCallUpdate(&out.writer, tool_call_id, .in_progress, plain);
        try self.sendUpdate(out.writer.buffered());
    }

    fn sendWebSearchProgress(self: *AcpContext, tool_call_id: []const u8, progress: types.WebSearchProgress) !void {
        var out: std.Io.Writer.Allocating = .init(self.alloc);
        defer out.deinit();
        try writeWebSearchProgressUpdate(self.alloc, &out.writer, tool_call_id, progress);
        try self.sendUpdate(out.writer.buffered());
    }

    fn sendWebFetchProgress(self: *AcpContext, tool_call_id: []const u8, progress: types.WebFetchProgress) !void {
        var out: std.Io.Writer.Allocating = .init(self.alloc);
        defer out.deinit();
        try writeWebFetchProgressUpdate(self.alloc, &out.writer, tool_call_id, progress);
        try self.sendUpdate(out.writer.buffered());
    }

    fn sendToolCallCompletedWithCommandResult(self: *AcpContext, tool_call_id: []const u8, result_text: ?[]const u8, command_result_json: ?[]const u8) !void {
        var out: std.Io.Writer.Allocating = .init(self.alloc);
        defer out.deinit();
        try acp_types.writeToolCallUpdateWithCommandResult(&out.writer, tool_call_id, .completed, result_text, command_result_json);
        try self.sendUpdate(out.writer.buffered());
    }

    fn sendToolCallError(self: *AcpContext, tool_call_id: []const u8, err_text: []const u8) !void {
        try self.sendToolCallErrorWithCommandResult(tool_call_id, err_text, null);
    }

    fn sendToolCallErrorWithCommandResult(self: *AcpContext, tool_call_id: []const u8, err_text: []const u8, command_result_json: ?[]const u8) !void {
        var out: std.Io.Writer.Allocating = .init(self.alloc);
        defer out.deinit();
        try acp_types.writeToolCallUpdateWithCommandResult(&out.writer, tool_call_id, .failed, err_text, command_result_json);
        try self.sendUpdate(out.writer.buffered());
    }

    fn toolContext(self: *AcpContext) tool_runtime.Context {
        const session = if (self.state.active_session) |*active| active else unreachable;
        const gateway_features_allowed = model_provider.usesGatewayAuxiliaries(session.provider);
        if (gateway_features_allowed) {
            self.state.web_search_runtime.configure(.{
                .api_key = session.api_key,
                .worker_model = session.model,
                .gateway_retry_count = self.state.cfg.gateway_retry_count,
                .gateway_chat_url = self.state.cfg.gateway_chat_url,
                .usage = &session.session_rt.usage,
                .usage_allocator = self.state.alloc,
            });
        }
        var tc: tool_runtime.Context = .{
            .workspace_root = self.state.workspace_root,
            .access_scope = self.state.workspace_access.scope(self.state.workspace_root),
            .ignored_list_entries = self.state.cfg.ignored_list_entries,
            .max_list_entries = self.state.cfg.max_list_entries,
            .max_read_file_bytes = self.state.cfg.max_read_file_bytes,
            .max_read_file_lines = self.state.cfg.max_read_file_lines,
            .max_read_file_line_len = self.state.cfg.max_read_file_line_len,
            .max_command_output_bytes = self.state.cfg.max_command_output_bytes,
            .max_tool_result_bytes = session.max_tool_result_bytes,
            .api_key = session.api_key,
            .agent_stream_provider = server.streamProviderFor(self.state, session.provider),
            .credential_source = session.credential_source,
            .provider = session.provider,
            .model = session.model,
            .gateway_retry_count = self.state.cfg.gateway_retry_count,
            .gateway_chat_url = self.state.cfg.gateway_chat_url,
            .gateway_models_path = self.state.cfg.gateway_models_path,
            .agent_step_limit = session.agent_step_limit,
            .fast_mode = session.fast_mode,
            .effort = session.effort,
            .first_call_tool_choice = session.first_call_tool_choice,
            .permission_mode = self.captured_permission_mode orelse session.permission_mode,
            .permission_grants = session.session_grants,
            .permission_rules = session.permission_rules,
            .tool_registry = self.toolRegistry(),
            .permission_reviewer_provider = self.state.cfg.permission_reviewer_provider,
            .auto_classifier = self.auto_classifier,
            .subagent_host = self.state.subagent_host,
            .subagent_caller_id = session.session_id,
            .worker = &self.state.worker,
            .permission_prompter = if (self.state.initialized) .{
                .context = @ptrCast(self),
                .request_fn = requestAcpPermission,
                .retain_grant_fn = retainAcpGrant,
            } else null,
            .cancel_flag = &session.cancel_flag,
            .background = &self.state.background,
            .session = &session.session_rt,
            .session_allocator = self.alloc,
            .skills_dir = self.state.skills.dir,
            .context_limits = self.state.context_limits,
            .context_enabled = self.state.context_enabled,
            .context_registry = self.state.cfg.context_registry,
            .output_chunk_ctx = @ptrCast(self),
            .on_output_chunk = onCommandOutputChunk,
            .mcp_progress_ctx = @ptrCast(self),
            .on_mcp_progress = onMcpProgress,
            .background_url_ctx = @ptrCast(self),
            .on_background_url_ready = onBackgroundUrlReady,
            .session_child_capability = if (session.writable) |*writable|
                writable.childCapability() catch null
            else
                null,
            .terminal_client = &self.state.terminal_client,
            .sandbox_backend = self.captured_sandbox_backend orelse session.sandbox_backend,
            .web_fetch_runtime = &self.state.web_fetch_runtime,
            .web_fetch_artifact_store = session.session_rt.webFetchArtifactStore(),
            .web_fetch_artifact_error = session.session_rt.webFetchArtifactError(),
            .web_search_runtime_ready = false,
            .web_search_backend = if (gateway_features_allowed) self.state.web_search_runtime.dispatchBackend() else null,
            .model_capability_resolver = .{
                .ctx = @ptrCast(self),
                .resolve_fn = resolveModelCapabilities,
            },
            .interactive = false,
            .lifecycle_view = self.state.lifecycle_view,
            .lifecycle_scope = .{
                .kind = .acp,
                .workspace_root = session.workspace_root,
                .session_id = session.session_id,
            },
        };
        if (comptime !host_target.is_wasm) {
            if (session.mcp != null) {
                tc.mcp_ctx = @ptrCast(self);
                tc.mcp_has_tool = mcpHasTool;
                tc.mcp_validate_tool = mcpValidateTool;
                tc.mcp_call_tool = mcpCallTool;
                tc.mcp_search_tools = mcpSearchTools;
                tc.mcp_tool_schema = mcpToolSchemaJson;
                tc.mcp_call_feature = mcpCallFeature;
            }
        }
        return tc;
    }

    fn modelVisibleProjectContext(self: *const AcpContext) []const u8 {
        if (!self.state.context_enabled) return "";
        return self.state.context_snapshot.modelVisibleBytes();
    }

    fn toolRegistry(self: *const AcpContext) tool_dispatch.Registry {
        return activeToolSet(self.state).registry;
    }
};

/// ponytail: 4 KiB of a call's arguments on the wire, which covers everything but
/// a whole-file write; raise it if a client ever needs to replay a call verbatim.
/// The cut backs off any trailing UTF-8 continuation bytes so the JSON string the
/// client parses is still valid text.
const max_raw_input_bytes = 4096;

fn boundedArguments(arguments_json: []const u8) []const u8 {
    if (arguments_json.len <= max_raw_input_bytes) return arguments_json;
    var end: usize = max_raw_input_bytes;
    while (end > 0 and arguments_json[end] & 0xc0 == 0x80) end -= 1;
    return arguments_json[0..end];
}

test "boundedArguments cuts on a character boundary" {
    const short = "{\"a\":1}";
    try std.testing.expectEqual(short.len, boundedArguments(short).len);
    const wide = "{\"a\":\"" ++ ("é" ** 3000) ++ "\"}";
    const cut = boundedArguments(wide);
    try std.testing.expect(cut.len <= max_raw_input_bytes);
    try std.testing.expect(std.unicode.utf8ValidateSlice(cut));
}

fn activeToolSet(state: *const server.ServerState) tool_set_contract.ToolSet {
    if (comptime host_target.is_wasm) return tool_set_contract.empty;
    return if (state.cfg.allow_native_tools) builtin_tools.advertisement_set else tool_set_contract.empty;
}

const AcpElicitationResponderContext = struct {
    const AcceptedLegacyUrl = struct {
        acp_id: []u8,

        fn deinit(self: *AcceptedLegacyUrl, alloc: Allocator) void {
            alloc.free(self.acp_id);
            self.* = undefined;
        }
    };

    acp: *AcpContext,
    tool_call_id: []const u8,
    operation_cancel_flag: ?*const std.atomic.Value(bool),
    accepted_url_ids: std.ArrayListUnmanaged([]u8) = .empty,
    accepted_legacy_urls: std.ArrayListUnmanaged(AcceptedLegacyUrl) = .empty,

    fn deinit(self: *AcpElicitationResponderContext) void {
        for (self.accepted_url_ids.items) |id| self.acp.state.alloc.free(id);
        self.accepted_url_ids.deinit(self.acp.state.alloc);
        for (self.accepted_legacy_urls.items) |*accepted| {
            server.removeLegacyUrl(self.acp.state, accepted.acp_id);
            accepted.deinit(self.acp.state.alloc);
        }
        self.accepted_legacy_urls.deinit(self.acp.state.alloc);
        self.* = undefined;
    }

    fn responder(self: *AcpElicitationResponderContext) ?tool_mcp_runtime.InputResponder {
        const capabilities = self.acp.state.client_elicitation;
        if (!capabilities.any()) return null;
        return .{
            .context = @ptrCast(self),
            .capabilities = capabilities,
            .callback = respondToAcpMcpInput,
            .continuation_terminal = finishAcpUrlElicitations,
        };
    }
};

/// Runs one of Emma's own tools by asking the client to run it.
///
/// The harness owns the turn but not the tool: Emma's stores live in Electron.
/// So a call becomes an outbound `_emma/callTool` request on the same channel
/// permission and elicitation already use, and the turn blocks on the answer.
/// The only way out other than a reply is the user cancelling — an Emma tool
/// has no honest deadline, since connecting a folder or running a thread can
/// legitimately take minutes.
const AcpEmmaToolResponderContext = struct {
    acp: *AcpContext,
    tool_call_id: []const u8,
    operation_cancel_flag: ?*const std.atomic.Value(bool),

    fn responder(self: *AcpEmmaToolResponderContext) tool_dispatch.EmmaToolResponder {
        return .{ .context = @ptrCast(self), .call_fn = callEmmaTool };
    }
};

const AcpEmmaToolWait = union(enum) {
    response: ?server.OutboundResponse,
    cancelled: anyerror!void,
};

fn callEmmaTool(
    raw_ctx: *anyopaque,
    out_alloc: Allocator,
    name: []const u8,
    arguments_json: []const u8,
) anyerror![]u8 {
    const self: *AcpEmmaToolResponderContext = @ptrCast(@alignCast(raw_ctx));
    const state = self.acp.state;
    const alloc = state.alloc;

    const outbound_id = try server.beginOutboundRequest(state, .client_tool) orelse
        return error.TooManyPendingRequests;
    var awaiting = true;
    defer if (awaiting) server.cancelOutboundRequest(state, outbound_id);

    const params = try emmaToolParamsJson(
        alloc,
        self.acp.session_id,
        self.tool_call_id,
        name,
        arguments_json,
    );
    defer alloc.free(params);
    try state.writer.writeRequest(
        alloc,
        .{ .integer = @intCast(outbound_id) },
        "_emma/callTool",
        params,
    );

    const maybe_response = try awaitEmmaToolResponse(state, outbound_id, self.operation_cancel_flag);
    awaiting = false;
    var response = maybe_response orelse return error.Cancelled;
    defer response.deinit(alloc);
    if (response.cancelled) return error.Cancelled;
    if (response.error_json != null) return error.EmmaToolFailed;
    const result_json = response.result_json orelse return error.EmmaToolFailed;
    return emmaToolOutput(out_alloc, result_json);
}

fn emmaToolParamsJson(
    alloc: Allocator,
    session_id: []const u8,
    tool_call_id: []const u8,
    name: []const u8,
    arguments_json: []const u8,
) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.writeAll("{\"sessionId\":");
    try std.json.Stringify.value(session_id, .{}, &out.writer);
    try out.writer.writeAll(",\"toolCallId\":");
    try std.json.Stringify.value(tool_call_id, .{}, &out.writer);
    try out.writer.writeAll(",\"name\":");
    try std.json.Stringify.value(name, .{}, &out.writer);
    // Already validated as a JSON object by the bridge decode, so it is embedded
    // rather than re-encoded: the client sees exactly what the model wrote.
    try out.writer.writeAll(",\"arguments\":");
    try out.writer.writeAll(arguments_json);
    try out.writer.writeByte('}');
    return try out.toOwnedSlice();
}

/// Takes `output` out of the client's result. A reply that is not shaped that
/// way is the client's bug, and the model cannot fix it by retrying.
fn emmaToolOutput(alloc: Allocator, result_json: []const u8) ![]u8 {
    var parsed = std.json.parseFromSlice(std.json.Value, alloc, result_json, .{}) catch
        return error.EmmaToolFailed;
    defer parsed.deinit();
    if (parsed.value != .object) return error.EmmaToolFailed;
    const output = parsed.value.object.get("output") orelse return error.EmmaToolFailed;
    if (output != .string) return error.EmmaToolFailed;
    return alloc.dupe(u8, output.string);
}

fn awaitEmmaToolResponse(
    state: *server.ServerState,
    id: u64,
    operation_cancel_flag: ?*const std.atomic.Value(bool),
) !?server.OutboundResponse {
    const Cleanup = struct {
        fn drain(state_alloc: Allocator, select: *std.Io.Select(AcpEmmaToolWait)) void {
            while (select.cancel()) |item| switch (item) {
                .response => |maybe_response| if (maybe_response) |owned| {
                    var response = owned;
                    response.deinit(state_alloc);
                },
                .cancelled => {},
            };
        }
    };

    var select_buffer: [2]AcpEmmaToolWait = undefined;
    var select: std.Io.Select(AcpEmmaToolWait) = .init(io_mod.getIo(), &select_buffer);
    try select.concurrent(.response, server.awaitOutboundResponse, .{ state, id, server.OutboundKind.client_tool });
    select.concurrent(.cancelled, waitForAcpElicitationCancellation, .{
        @as(?*const std.atomic.Value(bool), null),
        operation_cancel_flag,
    }) catch |err| {
        Cleanup.drain(state.alloc, &select);
        return err;
    };
    const event = select.await() catch |err| {
        Cleanup.drain(state.alloc, &select);
        return err;
    };
    return switch (event) {
        .response => |response| result: {
            Cleanup.drain(state.alloc, &select);
            break :result response;
        },
        .cancelled => result: {
            server.cancelOutboundRequest(state, id);
            Cleanup.drain(state.alloc, &select);
            break :result null;
        },
    };
}

const Osc8Link = struct {
    uri: []const u8,
    end: usize,
};

/// Parses an OSC-8 hyperlink sequence (`ESC ]8;params;uri ST`) starting at
/// `index`. An empty uri marks the end of a hyperlink span.
fn parseOsc8Link(text: []const u8, index: usize) ?Osc8Link {
    if (!std.mem.startsWith(u8, text[index..], "\x1b]8;")) return null;
    const end = display_width.ansiSequenceEnd(text, index);
    var body_end = end;
    if (body_end > index and text[body_end - 1] == 0x07) {
        body_end -= 1;
    } else if (body_end >= index + 2 and text[body_end - 2] == 0x1b and text[body_end - 1] == '\\') {
        body_end -= 2;
    }
    const body_start = index + "\x1b]8;".len;
    if (body_end < body_start) return null;
    const body = text[body_start..body_end];
    const separator = std.mem.findScalar(u8, body, ';') orelse return null;
    return .{ .uri = body[separator + 1 ..], .end = end };
}

/// Removes ANSI escape sequences so ACP clients receive Markdown-compatible
/// text. OSC-8 hyperlinks become Markdown links so their targets survive the
/// conversion. Returns the original slice when no escape byte is present;
/// callers free the result only when it differs from the input.
fn stripAnsiAlloc(alloc: Allocator, text: []const u8) ![]const u8 {
    if (std.mem.findScalar(u8, text, 0x1b) == null) return text;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(alloc);
    var open_link_uri: ?[]const u8 = null;
    var index: usize = 0;
    while (index < text.len) {
        if (text[index] == 0x1b) {
            if (parseOsc8Link(text, index)) |link| {
                if (link.uri.len > 0) {
                    if (open_link_uri == null) {
                        try out.append(alloc, '[');
                        open_link_uri = link.uri;
                    }
                } else if (open_link_uri) |uri| {
                    try appendMarkdownLinkClose(alloc, &out, uri);
                    open_link_uri = null;
                }
                index = link.end;
            } else {
                index = display_width.ansiSequenceEnd(text, index);
            }
        } else {
            try out.append(alloc, text[index]);
            index += 1;
        }
    }
    // A link left open by a chunk boundary still closes with its target so
    // the emitted Markdown stays balanced.
    if (open_link_uri) |uri| try appendMarkdownLinkClose(alloc, &out, uri);
    return try out.toOwnedSlice(alloc);
}

fn appendMarkdownLinkClose(alloc: Allocator, out: *std.ArrayList(u8), uri: []const u8) !void {
    try out.appendSlice(alloc, "](");
    try out.appendSlice(alloc, uri);
    try out.append(alloc, ')');
}

/// Runs a prompt turn under the mode and permission policy captured at
/// dispatch. Mid-turn session/set_mode changes only affect later prompts.
fn captureSessionImageSnapshots(
    alloc: Allocator,
    session: *server.ActiveSessionState,
    images: []types.ImageAttachment,
) !void {
    const durable = session.store != null and session.writable != null;
    const snapshot_dir = try session_store.imageSnapshotStorageDir(
        alloc,
        if (durable) session.store.?.sessions_dir else null,
        if (durable) session.writable.?.active_id else null,
        &session.image_snapshot_temp_dir,
    );
    defer alloc.free(snapshot_dir);
    try image_attachments.captureImageSnapshots(
        alloc,
        images,
        snapshot_dir,
        .{ .cancel_flag = &session.cancel_flag },
    );
}

pub fn handlePrompt(
    state: *server.ServerState,
    alloc: Allocator,
    msg: *jsonrpc.Message,
    captured_mode: []const u8,
    captured_permission_mode: PermissionMode,
    captured_sandbox_backend: sandbox.BackendKind,
) !TerminalOutcome {
    const session = if (state.active_session) |*active| active else return .{
        .rpc_error = no_active_session_rpc_error,
    };
    if (!try server.selectCredentialForProvider(state, session.provider)) {
        return .{ .rpc_error = .{
            .code = ErrorCode.invalid_request,
            .message = credentials.missing_credential_message,
        } };
    }

    const params = msg.params_raw orelse return .{
        .rpc_error = .{
            .code = ErrorCode.invalid_params,
            .message = "Missing params",
        },
    };

    var prompt_input = parsePromptInput(alloc, params) catch |err| switch (err) {
        error.UnsupportedPromptImage => return .{
            .rpc_error = .{
                .code = ErrorCode.invalid_params,
                .message = "Image prompt blocks need a local file:// uri",
            },
        },
        error.UnreadablePromptImage => return .{
            .rpc_error = .{
                .code = ErrorCode.invalid_params,
                .message = "That image could not be read as PNG, JPEG, GIF or WebP",
            },
        },
        error.TooManyPromptImages => return .{
            .rpc_error = .{
                .code = ErrorCode.invalid_params,
                .message = "A prompt carries at most 8 images",
            },
        },
        else => return err,
    };
    defer prompt_input.deinit(alloc);
    const prompt_text = prompt_input.text;

    if (prompt_input.continue_recovery and prompt_text.len != 0) {
        return .{
            .rpc_error = .{
                .code = ErrorCode.invalid_params,
                .message = "Recovery continuation cannot include a new prompt",
            },
        };
    }
    if (!prompt_input.continue_recovery and prompt_text.len == 0) {
        return .{
            .rpc_error = .{
                .code = ErrorCode.invalid_params,
                .message = "Empty prompt",
            },
        };
    }

    try refreshProjectContext(
        state,
        alloc,
        prompt_input.targets,
        prompt_input.omissions,
        prompt_input.omission_summary,
    );

    session.pending_prompt_id = msg.id;
    defer session.pending_prompt_id = null;

    var ctx = AcpContext{
        .alloc = alloc,
        .state = state,
        .session_id = session.session_id,
        .captured_mode = captured_mode,
        .captured_permission_mode = captured_permission_mode,
        .captured_sandbox_backend = captured_sandbox_backend,
    };
    defer ctx.deinitPublishedToolCalls();

    var recovery_checkpoint: ?session_codec.RecoveryCheckpoint = null;
    defer if (recovery_checkpoint) |*checkpoint| checkpoint.deinit(alloc);
    if (prompt_input.continue_recovery) {
        const writable = if (session.writable) |*value| value else return .{
            .rpc_error = .{
                .code = ErrorCode.invalid_params,
                .message = "This session does not support durable recovery",
            },
        };
        const checkpoint = writable.state.recovery_checkpoint orelse return .{
            .rpc_error = .{
                .code = ErrorCode.invalid_params,
                .message = "No paused model response to continue",
            },
        };
        recovery_checkpoint = try checkpoint.dupe(alloc);
    }

    var tool_projection = try state.cfg.mode_registry.buildGatewayToolProjection(alloc, activeToolSet(state), captured_mode, .{
        .permission_mode = captured_permission_mode,
        .permission_rules = session.permission_rules,
        .mcp_runtime = session.mcp,
        .subagent_available = state.subagent_host != null,
    });
    defer tool_projection.deinit(alloc);

    var bounded_skills = try state.skills.buildBoundedSystemPromptSection(alloc, state.context_limits);
    defer bounded_skills.deinit(alloc);
    if (bounded_skills.notice) |notice| try pushContextNotice(@ptrCast(&ctx), notice);
    if (bounded_skills.diagnostic_notice) |notice| try pushContextNotice(@ptrCast(&ctx), notice);
    for (state.context_snapshot.notices) |notice| try pushContextNotice(@ptrCast(&ctx), notice);
    const skills_section = bounded_skills.text;

    const owned_prompt = try alloc.dupe(
        u8,
        if (recovery_checkpoint) |checkpoint| checkpoint.user.text else prompt_text,
    );
    defer alloc.free(owned_prompt);
    var explicit_skills = try skill_invocation.buildExplicitPromptSection(
        alloc,
        .{ .skills = state.skills.items, .diagnostics = state.skills.diagnostics },
        owned_prompt,
        &.{},
        state.context_limits,
    );
    defer explicit_skills.deinit(alloc);
    if (explicit_skills.notice) |notice| try pushContextNotice(@ptrCast(&ctx), notice);
    if (explicit_skills.diagnostic_notice) |notice| try pushContextNotice(@ptrCast(&ctx), notice);

    session.session_rt.setConversationLanguageFromUserMessage(owned_prompt);
    const context_history = try session.session_rt.snapshotContextHistory(alloc);
    defer types.freeHistoryTurnSlice(alloc, context_history);
    var context_snapshot = try state.context_snapshot.dupe(alloc);
    defer context_snapshot.deinit(alloc);
    const root_user_intent_context = try auto_classifier_context.buildCanonicalRootUserContext(
        alloc,
        owned_prompt,
        session.session_rt.history.items,
    );
    defer alloc.free(root_user_intent_context);

    const current_images = if (recovery_checkpoint) |checkpoint| checkpoint.user.images else stamp: {
        const carried = try session.session_rt.snapshotImageCatalog(alloc, &.{});
        defer types.freeImageAttachmentSlice(alloc, carried);
        const bounds = try image_attachments.calculate_next_image_id(carried);
        for (prompt_input.images, 0..) |*image, offset| image.id = bounds.next_id + offset;
        if (prompt_input.images.len > 0) try captureSessionImageSnapshots(alloc, session, prompt_input.images);
        break :stamp prompt_input.images;
    };
    const authorized_image_catalog = try session.session_rt.snapshotImageCatalog(alloc, current_images);
    defer types.freeImageAttachmentSlice(alloc, authorized_image_catalog);

    const job: worker_runtime.QueuedPrompt = .{
        .turn_id = if (recovery_checkpoint) |checkpoint| checkpoint.turn_id else 0,
        .prompt = @constCast(owned_prompt),
        .images = @constCast(current_images),
        .authorized_image_catalog = authorized_image_catalog,
        .model = session.model,
        .api_key = @constCast(session.api_key),
        .credential_source = session.credential_source,
        .provider = session.provider,
        .permission_mode = captured_permission_mode,
        .sandbox_backend = captured_sandbox_backend,
        .history = context_history,
        .root_user_intent_context = root_user_intent_context,
        .grants = session.session_grants,
        .context_snapshot = context_snapshot,
        .recovery_checkpoint = recovery_checkpoint,
        .recovery_source_already_presented = recovery_checkpoint != null,
    };

    session.session_rt.usage.configureCheckpointSink(
        if (session.writable != null)
            .{
                .context = @ptrCast(&ctx),
                .allocator = alloc,
                .persist = persistUsageCheckpoint,
            }
        else
            null,
    );
    defer session.session_rt.usage.configureCheckpointSink(null);
    const deps = agentRuntimeDeps(&ctx);
    var agent_config = buildAgentConfig(state, session, .{
        .skills_prompt_section = skills_section,
        .explicit_skills_prompt_section = explicit_skills.text,
        .gateway_tools_json = tool_projection.tools_json,
        .custom_tool_guidance = tool_projection.custom_guidance,
    });
    ctx.context_breakdown = .{
        .system_prompt_bytes = agent_config.system_prompt.len +
            (if (agent_config.model_prompt_overlay) |overlay| overlay.len else 0) +
            agent_config.custom_tool_guidance.len,
        .system_tools_bytes = agent_config.gateway_tools_json.len,
        .skills_bytes = agent_config.skills_prompt_section.len,
    };
    ctx.context_breakdown_sent = false;
    agent_config.session_child_capability = if (session.writable) |*writable|
        writable.childCapability() catch null
    else
        null;
    agent_runtime.processQueuedPrompt(&deps, null, .{
        .view = state.lifecycle_view,
        .scope = .{
            .kind = .acp,
            .workspace_root = session.workspace_root,
            .session_id = session.session_id,
        },
        .outcome_allocator = alloc,
    }, agent_config, job) catch |err| {
        if (err == error.NonInteractivePermissionRequired) {
            ctx.stop_reason = .refused;
        } else {
            return err;
        }
    };

    if (session.cancel_flag.load(.seq_cst)) {
        ctx.stop_reason = .cancelled;
    }

    return .{ .stop_reason = .{
        .reason = ctx.stop_reason,
        .usage = ctx.turn_usage,
    } };
}

/// One subagent turn, mirrored onto the parent's ACP stream as it runs.
///
/// The child's own runtime deps publish text and tool lifecycle to
/// `turn.appendLive*`, a bounded buffer only the TUI reads — so over ACP a
/// subagent used to be a single opaque `subagent` tool call with nothing inside
/// it. `live_mirror` gives those same events a second destination, and the
/// context below tags everything it sends with the child's id, so a front end can
/// fan the child out onto a transcript of its own instead of gluing its words
/// into the parent's answer.
///
/// The ids need no namespacing: this context keeps its own `published_tool_calls`,
/// and a client that separates children by tag never has two in one timeline.
pub fn runSubagentChild(
    raw: ?*anyopaque,
    turn: *subagent_execution.TurnContext,
    message: subagent_domain.QueuedMessage,
    admission: subagent_domain.AdmissionSnapshot,
    cancel: *std.atomic.Value(bool),
) subagent_execution.ServiceError!subagent_execution.RunOutcome {
    const state: *server.ServerState = @ptrCast(@alignCast(raw.?));
    const subagent_host = state.subagent_host orelse return error.ProviderFailed;
    const alloc = state.alloc;
    state.subagent_authority_mutex.lockUncancelable(io_mod.getIo());
    const active = if (state.active_session) |*session| session else {
        state.subagent_authority_mutex.unlock(io_mod.getIo());
        return error.ProviderFailed;
    };
    const session_id = active.session_id;
    const captured_mode = active.mode;
    const mcp = active.mcp;
    state.subagent_authority_mutex.unlock(io_mod.getIo());
    var ctx = AcpContext{
        .alloc = alloc,
        .state = state,
        .session_id = session_id,
        // Only a child that has been attached has an id to be watched under; one
        // that has not runs exactly as it did before, unmirrored.
        .child = if (turn.child_id) |child_id| .{ .id = child_id, .title = childTitle(message.content) } else null,
        .captured_mode = captured_mode,
        .captured_permission_mode = admission.permission_mode,
        .captured_sandbox_backend = admission.sandbox_backend,
    };
    defer ctx.deinitPublishedToolCalls();
    // Announced whichever way the run ends, including the error paths below, so a
    // front end never leaves a subagent showing as running forever.
    defer ctx.sendChildEnded() catch {};
    var child_projection = state.cfg.mode_registry.buildGatewayToolProjection(
        alloc,
        builtin_tools.advertisement_set,
        captured_mode,
        .{
            .permission_mode = admission.permission_mode,
            .permission_rules = admission.rules,
            .mcp_runtime = mcp,
            .subagent_available = true,
        },
    ) catch return error.OutOfMemory;
    defer child_projection.deinit(alloc);
    var bounded_skills = state.skills.buildBoundedSystemPromptSection(
        alloc,
        state.context_limits,
    ) catch return error.OutOfMemory;
    defer bounded_skills.deinit(alloc);
    var explicit_skills = skill_invocation.buildExplicitPromptSection(
        alloc,
        .{ .skills = state.skills.items, .diagnostics = state.skills.diagnostics },
        message.content,
        &.{},
        state.context_limits,
    ) catch return error.OutOfMemory;
    defer explicit_skills.deinit(alloc);
    var emma_responder = AcpEmmaToolResponderContext{
        .acp = &ctx,
        .tool_call_id = if (turn.child_id) |child_id| child_id else session_id,
        .operation_cancel_flag = cancel,
    };
    var child_tool_context = ctx.toolContext();
    child_tool_context.emma_tool_responder = emma_responder.responder();
    return subagent_agent_adapter.run(.{
        .host = subagent_host,
        .tool_context = child_tool_context,
        .live_mirror = if (ctx.child == null) null else .{
            .ctx = @ptrCast(&ctx),
            .push_text = pushText,
            .push_tool_lifecycle = pushChildToolLifecycle,
            .push_usage = reportTurnUsage,
        },
        .provider_routes = .{
            .gateway = .{
                .agent_stream_provider = server.streamProviderFor(state, .gateway),
                .permission_reviewer_provider = state.cfg.permission_reviewer_provider,
            },
        },
        .system_prompt = state.cfg.prompt_policy.systemPrompt(),
        .model_prompt_overlay = state.cfg.prompt_policy.modelPromptOverlay(admission.model),
        .skills_prompt_section = bounded_skills.text,
        .explicit_skills_prompt_section = explicit_skills.text,
        .gateway_tools_json = child_projection.tools_json,
        .custom_tool_guidance = child_projection.custom_guidance,
        .context_registry = state.cfg.context_registry,
        .context_enabled = state.context_enabled,
        .project_context = state.context_snapshot.modelVisibleBytes(),
        .lifecycle_view = state.lifecycle_view,
    }, turn, message, admission, cancel);
}

fn refreshProjectContext(
    state: *server.ServerState,
    alloc: Allocator,
    targets: []const context_contract.ApplicableTarget,
    omissions: []const context_contract.ContextOmissionInput,
    omission_summary: ?context_contract.ContextOmissionSummary,
) context_contract.ProviderError!void {
    state.context_snapshot.deinit(alloc);
    if (!state.context_enabled) return;

    state.context_snapshot = state.cfg.context_registry.gatherDefaultSnapshot(alloc, .{
        .workspace_root = state.workspace_root,
        .access_scope = state.workspace_access.scope(state.workspace_root),
        .targets = targets,
        .omissions = omissions,
        .omission_summary = omission_summary,
        .context_limits = state.context_limits,
    }) catch |err| {
        debug_trace.logf("context", "acp gather failed err={s}", .{@errorName(err)});
        return err;
    };
}

const AgentConfigSections = struct {
    skills_prompt_section: []const u8,
    explicit_skills_prompt_section: []const u8,
    gateway_tools_json: []const u8,
    custom_tool_guidance: []const u8,
};

fn buildAgentConfig(state: *server.ServerState, session: *server.ActiveSessionState, sections: AgentConfigSections) agent_runtime.Config {
    return .{
        .system_prompt = state.cfg.prompt_policy.systemPrompt(),
        .model_prompt_overlay = state.cfg.prompt_policy.modelPromptOverlay(session.model),
        .skills_prompt_section = sections.skills_prompt_section,
        .explicit_skills_prompt_section = sections.explicit_skills_prompt_section,
        .gateway_retry_count = state.cfg.gateway_retry_count,
        .gateway_chat_url = state.cfg.gateway_chat_url,
        .gateway_tools_json = sections.gateway_tools_json,
        .custom_tool_guidance = sections.custom_tool_guidance,
        .agent_step_limit = session.agent_step_limit,
        .max_tool_result_bytes = session.max_tool_result_bytes,
        .cancel_flag = &session.cancel_flag,
        .fast_mode = session.fast_mode,
        .effort = session.effort,
        .first_call_tool_choice = session.first_call_tool_choice,
        .workspace_root = state.workspace_root,
        .access_scope = state.workspace_access.scope(state.workspace_root),
        .origin = if (session.writable) |writable|
            if (writable.external_prompt_origin == .persistent_child) .subagent else .root
        else
            .root,
        .root_user_messages = if (session.writable) |writable|
            writable.external_root_user_messages
        else
            &.{},
        .root_user_evidence_complete = if (session.writable) |writable|
            writable.external_root_user_evidence_complete
        else
            false,
        .current_prompt_is_root_authority = if (session.writable) |writable|
            writable.external_prompt_origin == .persistent_child
        else
            false,
        .context_limits = state.context_limits,
        .context_experiments = experiments: {
            var experiments = session.context_experiments;
            // The client sends the real window on its own option; reuse it
            // rather than asking for the same number twice.
            experiments.context_window_tokens = session.session_rt.context_window_tokens;
            break :experiments experiments;
        },
    };
}

const max_prompt_images: usize = 8;

const ParsedPromptInput = struct {
    text: []u8,
    continue_recovery: bool = false,
    targets: []context_contract.ApplicableTarget = &.{},
    omissions: []context_contract.ContextOmissionInput = &.{},
    omission_summary: ?context_contract.ContextOmissionSummary = null,
    images: []types.ImageAttachment = &.{},

    fn deinit(self: *ParsedPromptInput, alloc: Allocator) void {
        alloc.free(self.text);
        for (self.targets) |target| alloc.free(@constCast(target.path));
        if (self.targets.len > 0) alloc.free(self.targets);
        for (self.omissions) |omission| alloc.free(@constCast(omission.source));
        if (self.omissions.len > 0) alloc.free(self.omissions);
        types.freeImageAttachmentSlice(alloc, self.images);
        self.* = undefined;
    }
};

fn parsePromptInput(alloc: Allocator, params_json: []const u8) !ParsedPromptInput {
    const parsed = std.json.parseFromSlice(std.json.Value, alloc, params_json, .{}) catch
        return .{ .text = try alloc.dupe(u8, "") };
    defer parsed.deinit();

    if (parsed.value != .object) return .{ .text = try alloc.dupe(u8, "") };

    const continue_recovery = blk: {
        const meta = parsed.value.object.get("_meta") orelse break :blk false;
        if (meta != .object) break :blk false;
        const fx = meta.object.get("fx") orelse break :blk false;
        if (fx != .object) break :blk false;
        const value = fx.object.get("continueRecovery") orelse break :blk false;
        break :blk value == .bool and value.bool;
    };

    const prompt_arr = parsed.value.object.get("prompt") orelse
        return .{ .text = try alloc.dupe(u8, ""), .continue_recovery = continue_recovery };
    if (prompt_arr != .array) return .{ .text = try alloc.dupe(u8, ""), .continue_recovery = continue_recovery };

    var text_buf: std.ArrayList(u8) = .empty;
    defer text_buf.deinit(alloc);
    var targets: std.ArrayList(context_contract.ApplicableTarget) = .empty;
    defer {
        for (targets.items) |target| alloc.free(@constCast(target.path));
        targets.deinit(alloc);
    }
    var omissions: std.ArrayList(context_contract.ContextOmissionInput) = .empty;
    var omission_summary: context_contract.ContextOmissionSummaryBuilder = .{};
    defer {
        for (omissions.items) |omission| alloc.free(@constCast(omission.source));
        omissions.deinit(alloc);
    }
    var images: std.ArrayList(types.ImageAttachment) = .empty;
    defer {
        for (images.items) |image| types.freeImageAttachment(alloc, image);
        images.deinit(alloc);
    }

    for (prompt_arr.array.items) |block| {
        if (block != .object) continue;
        const block_type = block.object.get("type") orelse continue;
        if (block_type != .string) continue;

        if (std.mem.eql(u8, block_type.string, "text")) {
            if (block.object.get("text")) |text_val| {
                if (text_val == .string) {
                    if (text_buf.items.len > 0) try text_buf.append(alloc, '\n');
                    try text_buf.appendSlice(alloc, text_val.string);
                }
            }
        } else if (std.mem.eql(u8, block_type.string, "image")) {
            const uri = if (block.object.get("uri")) |uri_value|
                if (uri_value == .string) uri_value.string else ""
            else
                "";
            const path = (try localFileTargetPath(alloc, uri)) orelse return error.UnsupportedPromptImage;
            defer alloc.free(path);
            if (images.items.len >= max_prompt_images) return error.TooManyPromptImages;
            const image = image_attachments.loadImageAttachment(alloc, path) catch
                return error.UnreadablePromptImage;
            errdefer types.freeImageAttachment(alloc, image);
            try images.append(alloc, image);
        } else if (std.mem.eql(u8, block_type.string, "resource")) {
            if (block.object.get("resource")) |resource| {
                if (resource == .object) {
                    const uri = if (resource.object.get("uri")) |uri_value|
                        if (uri_value == .string) uri_value.string else ""
                    else
                        "";
                    if (uri.len > 0) {
                        if (try localFileTargetPath(alloc, uri)) |path| {
                            errdefer alloc.free(path);
                            try targets.append(alloc, .{ .path = path, .kind = .file });
                        } else {
                            var duplicate = false;
                            for (omissions.items) |omission| {
                                if (omission.reason == .unsafe_target and std.mem.eql(u8, omission.source, uri)) {
                                    duplicate = true;
                                    break;
                                }
                            }
                            if (!duplicate) {
                                if (omissions.items.len < context_contract.Limits.project_omission_records) {
                                    const source = try alloc.dupe(u8, uri);
                                    errdefer alloc.free(source);
                                    try omissions.append(alloc, .{
                                        .source = source,
                                        .reason = .unsafe_target,
                                    });
                                } else {
                                    omission_summary.add(uri, .unsafe_target);
                                }
                            }
                        }
                    }
                    if (resource.object.get("text")) |text_val| {
                        if (text_val == .string) {
                            if (text_buf.items.len > 0) try text_buf.append(alloc, '\n');
                            if (uri.len > 0) {
                                try text_buf.appendSlice(alloc, "File: ");
                                try text_buf.appendSlice(alloc, uri);
                                try text_buf.append(alloc, '\n');
                            }
                            try text_buf.appendSlice(alloc, text_val.string);
                        }
                    }
                }
            }
        }
    }

    var result = ParsedPromptInput{
        .text = try alloc.dupe(u8, text_buf.items),
        .continue_recovery = continue_recovery,
    };
    errdefer result.deinit(alloc);
    result.targets = try targets.toOwnedSlice(alloc);
    result.omissions = try omissions.toOwnedSlice(alloc);
    result.omission_summary = omission_summary.finish();
    result.images = try images.toOwnedSlice(alloc);
    return result;
}

fn localFileTargetPath(alloc: Allocator, uri_text: []const u8) Allocator.Error!?[]u8 {
    const uri = std.Uri.parse(uri_text) catch return null;
    if (!std.ascii.eqlIgnoreCase(uri.scheme, "file") or
        uri.user != null or
        uri.password != null or
        uri.host != null or
        uri.port != null or
        uri.query != null or
        uri.fragment != null)
    {
        return null;
    }

    const encoded_path = switch (uri.path) {
        .raw, .percent_encoded => |path| path,
    };
    const decoded_storage = try alloc.dupe(u8, encoded_path);
    defer alloc.free(decoded_storage);

    var read_index: usize = 0;
    var write_index: usize = 0;
    while (read_index < decoded_storage.len) {
        const byte = if (decoded_storage[read_index] == '%') blk: {
            if (decoded_storage.len - read_index < 3) return null;
            const value = std.fmt.parseInt(
                u8,
                decoded_storage[read_index + 1 .. read_index + 3],
                16,
            ) catch return null;
            read_index += 3;
            break :blk value;
        } else blk: {
            const value = decoded_storage[read_index];
            read_index += 1;
            break :blk value;
        };
        if (byte == 0) return null;
        decoded_storage[write_index] = byte;
        write_index += 1;
    }
    const decoded_path = decoded_storage[0..write_index];
    if (!std.fs.path.isAbsolute(decoded_path)) return null;

    var components = std.mem.splitScalar(u8, decoded_path, '/');
    while (components.next()) |component| {
        if (std.mem.eql(u8, component, "..")) return null;
    }

    return io_mod.realpathAlloc(alloc, decoded_path) catch |err| switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        else => null,
    };
}

fn agentRuntimeDeps(ctx: *AcpContext) agent_runtime.AgentRuntimeDeps {
    const session = if (ctx.state.active_session) |*active| active else unreachable;
    return .{
        .ctx = @ptrCast(ctx),
        .agent_stream_provider = server.streamProviderFor(ctx.state, ctx.state.active_session.?.provider),
        .flush_assistant_stream_per_content_chunk = host_target.is_wasm,
        .tool_registry = ctx.toolRegistry(),
        .context_registry = ctx.state.cfg.context_registry,
        .context_enabled = ctx.state.context_enabled,
        .finalize_turn = finalizeTurn,
        .prepare_parent_turn_context = prepareParentTurnContext,
        .acknowledge_parent_turn_context = acknowledgeParentTurnContext,
        .append_runtime_context = appendRuntimeContext,
        .append_static_context = appendStaticContext,
        .validate_tool_call = validateToolCall,
        .check_tool_availability = checkToolAvailability,
        .request_tool_permission = requestToolPermissionOutcomeWithRequest,
        .request_prepared_file_mutation_permission = requestPreparedFileMutationPermissionOutcomeForRuntime,
        .request_sandbox_widening = requestSandboxWideningForRuntime,
        .describe_tool_action = describeToolAction,
        .describe_tool_action_completed = describeToolActionCompleted,
        .describe_tool_action_denied = describeToolActionDenied,
        .permission_target_for_call = permissionTargetForCall,
        .execute_tool_call = if (comptime host_target.is_wasm) executeWebToolCall else executeToolCall,
        .publish_committed_file_handoff = publishCommittedFileHandoff,
        .publish_deferred_tool_completion = publishDeferredToolCompletion,
        .propagate_history_turn = propagateHistoryTurn,
        .recovery_checkpoint = if (session.writable != null)
            .{
                .set = setRecoveryCheckpoint,
            }
        else
            null,
        .propagate_grant = retainAcpGrant,
        .push_event = pushEvent,
        .push_text = pushText,
        .push_route_recovery_status = pushRouteRecoveryStatus,
        .push_tool_lifecycle = pushToolLifecycle,
        .push_diff_block = pushDiffBlock,
        .push_system_notice = pushSystemNotice,
        .push_context_notice = pushContextNotice,
        .push_context_experiment = pushContextExperiment,
        .push_command_output_complete = pushCommandOutputComplete,
        .push_http_error = pushHttpError,
        .available_model_capabilities = availableModelCapabilities,
        .resolve_model_capabilities = resolveModelCapabilities,
        .format_tool_execution_error = formatToolExecutionError,
        .record_tool_call_rejected = recordToolCallRejected,
        .report_usage = reportTurnUsage,
        .usage = &session.session_rt.usage,
        .usage_allocator = ctx.state.alloc,
    };
}

/// One turn's usage. See `AcpContext.turn_usage` for why the session ledger
/// cannot answer this on an OpenAI-compatible route.
///
/// The two halves are counted differently on purpose. Output is genuinely
/// cumulative — every step writes new tokens. Input is not: each step resends
/// the whole conversation, so summing it counts the same context once per step
/// and reports a number far larger than anything that was ever in the window.
/// The client subtracts this from measured characters to size the "retrieval and
/// retries" row of its context ledger, and a sum made that residual grow without
/// bound until the ledger read as more-than-full. The last step's prompt is the
/// carried context, so that is what the turn reports.
fn reportTurnUsage(raw_ctx: *anyopaque, usage: types.Usage) void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    ctx.noteTurnUsage(usage);
    var out: std.Io.Writer.Allocating = .init(ctx.alloc);
    defer out.deinit();
    // A child's numbers carry its tag in the same `_meta` rather than a second
    // one, which `writeChildTaggedUpdate` refuses — silently, so a subagent read
    // as having spent nothing at all.
    if (ctx.child) |child| {
        acp_types.writeChildTurnUsageInfoUpdate(&out.writer, ctx.turn_usage, child.id, child.title, child.ended) catch return;
        ctx.sendRawUpdate(out.writer.buffered()) catch {};
        return;
    }
    acp_types.writeTurnUsageInfoUpdate(&out.writer, ctx.turn_usage) catch return;
    ctx.sendUpdate(out.writer.buffered()) catch {};
    ctx.sendContextBreakdown();
}

test "noteTurnUsage sums output but reports the last step's input" {
    var state: server.ServerState = undefined;
    var ctx = AcpContext{ .alloc = std.testing.allocator, .state = &state, .session_id = "sess" };
    ctx.noteTurnUsage(.{ .input_tokens = 1000, .output_tokens = 3 });
    ctx.noteTurnUsage(.{ .input_tokens = 2000, .output_tokens = 4 });
    try std.testing.expectEqual(@as(u64, 2000), ctx.turn_usage.input_tokens);
    try std.testing.expectEqual(@as(u64, 7), ctx.turn_usage.output_tokens);
}

test "noteTurnUsage keeps the last known input when a step omits it" {
    var state: server.ServerState = undefined;
    var ctx = AcpContext{ .alloc = std.testing.allocator, .state = &state, .session_id = "sess" };
    ctx.noteTurnUsage(.{ .input_tokens = 7, .output_tokens = 3 });
    ctx.noteTurnUsage(.{ .input_tokens = null, .output_tokens = 5 });
    try std.testing.expectEqual(@as(u64, 7), ctx.turn_usage.input_tokens);
    try std.testing.expectEqual(@as(u64, 8), ctx.turn_usage.output_tokens);
}

fn persistUsageCheckpoint(
    raw_ctx: *anyopaque,
    snapshot: session_usage.Snapshot,
) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const active = if (ctx.state.active_session) |*session|
        session
    else
        return error.SessionPersistenceUnavailable;
    if (!std.mem.eql(u8, active.session_id, ctx.session_id)) {
        return error.SessionPersistenceUnavailable;
    }
    active.session_write_mutex.lockUncancelable(io_mod.getIo());
    defer active.session_write_mutex.unlock(io_mod.getIo());
    const writable = if (active.writable) |*value|
        value
    else
        return error.SessionPersistenceUnavailable;
    const store = if (active.store) |*value|
        value
    else
        return error.SessionPersistenceUnavailable;
    const recovery_checkpoint = try store.prepareUsageRecoveryCheckpoint(
        ctx.alloc,
        writable,
        snapshot,
    );
    if (writable.degradedTail() != null) {
        var current = try currentAcpState(
            ctx.alloc,
            active,
            writable,
            recovery_checkpoint.timestamp_ms,
        );
        defer current.deinit(ctx.alloc);
        try writable.retryDegradedWithStateReplacement(
            ctx.alloc,
            current,
            .{},
        );
    }
    _ = try writable.appendEvent(
        ctx.alloc,
        .{ .usage_checkpointed = .{ .usage = snapshot } },
        recovery_checkpoint.timestamp_ms,
        .retry_expected_tail,
        .{ .checkpoint_interval = 0 },
    );
    try store.finishUsageRecoveryCheckpoint(
        writable.active_id,
        recovery_checkpoint,
    );
}

fn resolveModelCapabilities(
    raw_ctx: *anyopaque,
    _: Allocator,
    model: []const u8,
) model_capabilities.ResolveError!model_capabilities.Capabilities {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const session = if (ctx.state.active_session) |*active| active else return model_capabilities.capabilitiesForModel(model);
    return withPublishedEfforts(ctx, model, try ctx.state.capability_resolver.resolve(
        ctx.state.alloc,
        ctx.state.cfg.gateway_provider.model_catalog,
        .{
            .access = credentials.catalogAccessForCredential(session.credential_source, session.api_key),
            .endpoint = ctx.state.cfg.gateway_models_path,
            .cancel_flag = &session.cancel_flag,
        },
        model,
    ));
}

fn availableModelCapabilities(
    raw_ctx: *anyopaque,
    model: []const u8,
) model_capabilities.Capabilities {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    return withPublishedEfforts(ctx, model, ctx.state.capability_resolver.available(model));
}

/// The stops the client sent on the `reasoning_effort` option, over whatever the
/// catalog answered. Both hooks take them because either one can end up being the
/// capabilities a request is built from, and an effort missing from the set the
/// request is checked against is dropped on the way to the gateway.
///
/// Only for the model they were published for: the same session resolves other
/// models — a reviewer's, a subagent's — and their vocabularies are their own.
fn withPublishedEfforts(
    ctx: *AcpContext,
    model: []const u8,
    capabilities: model_capabilities.Capabilities,
) model_capabilities.Capabilities {
    const session = if (ctx.state.active_session) |*active| active else return capabilities;
    if (session.reasoning_efforts.len == 0 or !std.mem.eql(u8, model, session.model)) return capabilities;
    var published = capabilities;
    published.supports_reasoning = true;
    published.reasoning_efforts = session.reasoning_efforts;
    return published;
}

fn finalizeTurn(raw_ctx: *anyopaque, turn_id: u64, outcome: types.TurnPresentationOutcome, disposition: ?types.ProviderCompletionDisposition) !void {
    std.debug.assert(turn_id != 0);
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    if (disposition == .length_limited) {
        ctx.stop_reason = .max_output_tokens;
    } else if (outcome == .failed or outcome == .paused) {
        ctx.stop_reason = .refused;
    }
}

fn appendRuntimeContext(raw_ctx: *anyopaque, arena: Allocator, messages: *std.ArrayList(ChatMessage)) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const session = if (ctx.state.active_session) |*active| active else unreachable;
    try ctx.state.cfg.context_registry.appendDefaultTransient(.{
        .workspace_root = ctx.state.workspace_root,
        .access_scope = ctx.state.workspace_access.scope(ctx.state.workspace_root),
        .interactive = false,
        .permission_mode = ctx.captured_permission_mode orelse session.permission_mode,
        .sandbox_backend = ctx.captured_sandbox_backend orelse session.sandbox_backend,
        .tracker = null,
        .background = &ctx.state.background,
        .session = &session.session_rt,
    }, arena, messages);
}

/// Steering rides the same per-step channel the children's deliveries do, and
/// under the same rule: it is acknowledged, and so dropped, only once a request
/// carrying it may have reached the model.
const steer_ack_delivery_id = "acp-steer";

fn childDeliveries(
    ctx: *AcpContext,
    arena: Allocator,
) !?agent_runtime.PreparedParentTurnContext {
    const subagent_host = ctx.state.subagent_host orelse return null;
    const session = if (ctx.state.active_session) |*active| active else return null;
    return parent_delivery_projector.prepare(
        arena,
        subagent_host.sessions,
        session.session_id,
        subagent_host.manager.options.child_store,
    );
}

fn prepareParentTurnContext(
    raw_ctx: *anyopaque,
    arena: Allocator,
) !?agent_runtime.PreparedParentTurnContext {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const deliveries = try childDeliveries(ctx, arena);
    if (ctx.child != null) return deliveries;
    const steering = try server.takePendingSteering(ctx.state, arena) orelse return deliveries;

    const acknowledgements = try arena.alloc(
        agent_runtime.ParentTurnDeliveryAck,
        (if (deliveries) |prepared| prepared.acknowledgements.len else 0) + 1,
    );
    if (deliveries) |prepared| @memcpy(acknowledgements[0 .. acknowledgements.len - 1], prepared.acknowledgements);
    acknowledgements[acknowledgements.len - 1] = .{
        .child_id = steer_ack_delivery_id,
        .target_session_id = steer_ack_delivery_id,
        .through_sequence = 0,
        .delivery_id = steer_ack_delivery_id,
        .start_offset = 0,
        .end_offset = steering.len,
        .total_bytes = steering.len,
    };
    return .{
        .content = if (deliveries) |prepared|
            try std.mem.concat(arena, u8, &.{ prepared.content, steering })
        else
            steering,
        .acknowledgements = acknowledgements,
    };
}

fn acknowledgeParentTurnContext(
    raw_ctx: *anyopaque,
    arena: Allocator,
    acknowledgements: []const agent_runtime.ParentTurnDeliveryAck,
) void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    var child_acks = acknowledgements;
    if (child_acks.len > 0 and std.mem.eql(u8, child_acks[child_acks.len - 1].delivery_id, steer_ack_delivery_id)) {
        child_acks = child_acks[0 .. child_acks.len - 1];
        server.clearDeliveredSteering(ctx.state);
    }
    if (child_acks.len == 0) return;
    const subagent_host = ctx.state.subagent_host orelse return;
    const retirement_ready = parent_delivery_projector
        .acknowledgeWithRetirementSignal(
        arena,
        subagent_host.sessions,
        subagent_host.manager.options.child_store,
        child_acks,
    );
    if (retirement_ready) {
        subagent_host.requestRetirementSweep(io_mod.milliTimestamp());
    }
}

fn appendStaticContext(raw_ctx: *anyopaque, arena: Allocator, messages: *std.ArrayList(ChatMessage)) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const before_static = messages.items.len;
    try ctx.state.cfg.context_registry.appendDefaultStatic(.{
        .project_context = ctx.modelVisibleProjectContext(),
    }, arena, messages);
    var memory_bytes: usize = 0;
    for (messages.items[before_static..]) |message| {
        if (message.content) |content| memory_bytes +|= content.len;
    }
    ctx.context_breakdown.memory_bytes = memory_bytes;
    const active_session = if (ctx.state.active_session) |*session| session else null;
    var snapshot = if (active_session) |session|
        if (session.mcp) |mcp|
            try mcp.snapshotModelCatalog(arena, session.permission_rules, false)
        else
            try mcp_model_catalog.Snapshot.empty(arena)
    else
        try mcp_model_catalog.Snapshot.empty(arena);
    defer snapshot.deinit(arena);
    const section = try mcp_model_catalog.render(arena, snapshot);
    ctx.context_breakdown.mcp_tools_bytes = section.text.len;
    if (section.text.len > 0) {
        try messages.append(arena, .{ .role = .system, .content = section.text });
    }
    if (section.notice) |notice| try pushContextNotice(raw_ctx, notice);
}

fn validateToolCall(raw_ctx: *anyopaque, arena: Allocator, call: ToolCall) !agent_runtime.ToolCallValidationResult {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    if (ctx.state.active_session) |session| {
        const mode = ctx.captured_mode orelse session.mode;
        if (try ctx.state.cfg.mode_registry.toolPolicyDeniedJson(arena, activeToolSet(ctx.state), mode, call.name)) |reason| {
            return .{ .failure = reason };
        }
    }
    return tool_runtime.validateToolCall(ctx.toolContext(), arena, call);
}

fn checkToolAvailability(raw_ctx: *anyopaque, arena: Allocator, call: ToolCall) !?[]const u8 {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    return tool_runtime.checkToolAvailability(ctx.toolContext(), arena, call);
}

fn requestSandboxWideningForRuntime(
    raw_ctx: *anyopaque,
    arena: Allocator,
    call: ToolCall,
    review_turn: permission_auto_classifier.ReviewTurnContext,
    permission_mode: PermissionMode,
    local_grants: []const PermissionGrant,
    live_authority: ?agent_runtime.LiveToolAuthority,
    advertised_dynamic_tool_names: []const []const u8,
    required: agent_runtime.SandboxScopeRequired,
) !command_admission.PermissionOutcome {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    var tool_ctx = tool_runtime.withAdvertisedDynamicToolNames(
        ctx.toolContext(),
        advertised_dynamic_tool_names,
    );
    tool_ctx.permission_review_turn = review_turn;
    return tool_admission.requestSandboxWideningOutcome(
        tool_ctx.admissionInputWithLiveAuthority(live_authority),
        arena,
        call,
        permission_mode,
        local_grants,
        required.wideningInput(),
    );
}

fn requestPreparedFileMutationPermissionOutcomeForRuntime(raw_ctx: *anyopaque, arena: Allocator, call: ToolCall, prepared: *tool_admission.PreparedFileMutationCall, review_turn: permission_auto_classifier.ReviewTurnContext, permission_mode: PermissionMode, local_grants: []const PermissionGrant, live_authority: ?agent_runtime.LiveToolAuthority, advertised_dynamic_tool_names: []const []const u8) !command_admission.PermissionOutcome {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    var tool_ctx = tool_runtime.withAdvertisedDynamicToolNames(ctx.toolContext(), advertised_dynamic_tool_names);
    tool_ctx.permission_review_turn = review_turn;
    const admission = tool_ctx.admissionInputWithLiveAuthority(live_authority);
    return tool_admission.requestPreparedFileMutationPermissionOutcome(
        admission,
        arena,
        call,
        prepared,
        permission_mode,
        local_grants,
    );
}

fn requestToolPermissionOutcome(raw_ctx: *anyopaque, arena: Allocator, call: ToolCall, permission_mode: PermissionMode, local_grants: []const PermissionGrant, advertised_dynamic_tool_names: []const []const u8) !command_admission.PermissionOutcome {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const tool_ctx = tool_runtime.withAdvertisedDynamicToolNames(ctx.toolContext(), advertised_dynamic_tool_names);
    return tool_admission.requestPermissionOutcome(
        tool_ctx.admissionInput(),
        arena,
        call,
        permission_mode,
        local_grants,
    );
}

fn requestToolPermissionOutcomeWithRequest(raw_ctx: *anyopaque, arena: Allocator, call: ToolCall, review_turn: permission_auto_classifier.ReviewTurnContext, permission_mode: PermissionMode, local_grants: []const PermissionGrant, live_authority: ?agent_runtime.LiveToolAuthority, revalidation: ?agent_runtime.LivePermissionRevalidation, advertised_dynamic_tool_names: []const []const u8) !command_admission.PermissionOutcome {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    var tool_ctx = tool_runtime.withAdvertisedDynamicToolNames(ctx.toolContext(), advertised_dynamic_tool_names);
    tool_ctx.permission_review_turn = review_turn;
    const admission = tool_ctx.admissionInputWithLiveAuthority(live_authority);
    return if (revalidation) |request| switch (request) {
        .action => |action| tool_admission.revalidateLiveActionPermissionOutcome(
            admission,
            arena,
            call,
            permission_mode,
            local_grants,
            action.authority,
            action.human_approval,
        ),
        .sandbox_widening => |widening| tool_admission.revalidateLiveSandboxWideningOutcome(
            admission,
            arena,
            call,
            permission_mode,
            local_grants,
            widening.authority,
            widening.required.wideningInput(),
            widening.human_approval,
        ),
    } else tool_admission.requestPermissionOutcome(
        admission,
        arena,
        call,
        permission_mode,
        local_grants,
    );
}

const TestReviewTurn = struct {
    tool_calls: [1]ToolCall,
    root_messages: [1][]const u8,

    fn init(root_text: []const u8, call: ToolCall) TestReviewTurn {
        return .{
            .tool_calls = .{call},
            .root_messages = .{root_text},
        };
    }

    fn context(self: *const TestReviewTurn) permission_auto_classifier.ReviewTurnContext {
        return .{
            .model = "openai/gpt-5",
            .pending_assistant = .{ .role = .assistant, .tool_calls = &self.tool_calls },
            .target_call_id = self.tool_calls[0].id,
            .origin = .root,
            .current_root_request = self.root_messages[0],
        };
    }
};

fn requestAcpPermission(
    raw_ctx: *anyopaque,
    alloc: Allocator,
    request: permission_request.PermissionRequest,
    call: ToolCall,
    _: ?*const diff_mod.FileReview,
    _: ?[]const PermissionGrant,
) anyerror!permission_request.OwnedPermissionResponse {
    var validated_arguments: std.Io.Writer.Allocating = .init(alloc);
    defer validated_arguments.deinit();
    try writeValidatedToolArguments(alloc, &validated_arguments.writer, call.arguments_json);

    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const request_id = server.beginPermissionRequest(ctx.state) orelse return error.PermissionRequestAlreadyPending;
    errdefer {
        server.cancelPermissionRequest(ctx.state, request_id);
        _ = server.awaitPermissionDecision(ctx.state, request_id);
    }

    var pending_arena = std.heap.ArenaAllocator.init(alloc);
    defer pending_arena.deinit();
    const tool_call_id = try ctx.sendToolCallPending(pending_arena.allocator(), call);

    var params: std.Io.Writer.Allocating = .init(alloc);
    defer params.deinit();
    try params.writer.writeAll("{\"sessionId\":");
    try jsonrpc.writeJsonStr(ctx.session_id, &params.writer);
    try params.writer.writeAll(",\"toolCall\":{\"toolCallId\":");
    try jsonrpc.writeJsonStr(tool_call_id, &params.writer);
    try params.writer.writeAll(",\"title\":");
    try jsonrpc.writeJsonStr(request.label, &params.writer);
    try params.writer.writeAll(",\"kind\":");
    try jsonrpc.writeJsonStr(mapToolKind(call.name).jsonString(), &params.writer);
    try params.writer.writeAll(",\"status\":\"pending\",\"rawInput\":");
    try params.writer.writeAll(validated_arguments.written());
    try params.writer.writeAll("},\"options\":[");
    try writePermissionOption(&params.writer, "allow_once", "Allow once", "allow_once");
    try params.writer.writeByte(',');
    try writePermissionOption(&params.writer, "allow_always", "Allow for this session", "allow_always");
    try params.writer.writeByte(',');
    try writePermissionOption(&params.writer, "reject_once", "Reject", "reject_once");
    try params.writer.writeAll("]}");

    try ctx.state.writer.writeRequest(
        alloc,
        .{ .integer = @intCast(request_id) },
        "session/request_permission",
        params.writer.buffered(),
    );
    const decision = server.awaitPermissionDecision(ctx.state, request_id);
    return permission_request.OwnedPermissionResponse.init(alloc, decision, null);
}

fn writeValidatedToolArguments(alloc: Allocator, writer: *std.Io.Writer, arguments_json: []const u8) !void {
    var parsed = std.json.parseFromSlice(std.json.Value, alloc, arguments_json, .{}) catch
        return error.InvalidToolArgumentsJson;
    defer parsed.deinit();
    try std.json.Stringify.value(parsed.value, .{}, writer);
}

fn writePermissionOption(
    writer: *std.Io.Writer,
    option_id: []const u8,
    name: []const u8,
    kind: []const u8,
) !void {
    try writer.writeAll("{\"optionId\":");
    try jsonrpc.writeJsonStr(option_id, writer);
    try writer.writeAll(",\"name\":");
    try jsonrpc.writeJsonStr(name, writer);
    try writer.writeAll(",\"kind\":");
    try jsonrpc.writeJsonStr(kind, writer);
    try writer.writeByte('}');
}

fn describeToolAction(raw_ctx: *anyopaque, arena: Allocator, call: ToolCall, file_display_path: ?[]const u8, advertised_dynamic_tool_names: []const []const u8) ![]const u8 {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    return tool_presentation.formatPlainAction(arena, .{
        .tool_registry = ctx.toolRegistry(),
        .call = call,
        .file_display_path = file_display_path,
        .is_available_dynamic_mcp_tool = lifecycleDynamicMcpToolAvailable(ctx, call.name, advertised_dynamic_tool_names),
    });
}

fn describeToolActionCompleted(raw_ctx: *anyopaque, arena: Allocator, call: ToolCall, file_display_path: ?[]const u8, advertised_dynamic_tool_names: []const []const u8) ![]const u8 {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    return tool_presentation.formatPlainAction(arena, .{
        .tool_registry = ctx.toolRegistry(),
        .call = call,
        .file_display_path = file_display_path,
        .is_available_dynamic_mcp_tool = lifecycleDynamicMcpToolAvailable(ctx, call.name, advertised_dynamic_tool_names),
    });
}

fn describeToolActionDenied(raw_ctx: *anyopaque, arena: Allocator, call: ToolCall, file_display_path: ?[]const u8, label: []const u8, advertised_dynamic_tool_names: []const []const u8) ![]const u8 {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const action = try tool_presentation.formatPlainAction(arena, .{
        .tool_registry = ctx.toolRegistry(),
        .call = call,
        .file_display_path = file_display_path,
        .is_available_dynamic_mcp_tool = lifecycleDynamicMcpToolAvailable(ctx, call.name, advertised_dynamic_tool_names),
    });
    return std.fmt.allocPrint(arena, "{s}: {s}", .{ label, action });
}

fn lifecycleDynamicMcpToolAvailable(ctx: *AcpContext, name: []const u8, advertised_dynamic_tool_names: []const []const u8) bool {
    if (comptime host_target.is_wasm) return false;
    return dynamicMcpToolAvailable(ctx.toolRegistry(), name, advertised_dynamic_tool_names, @ptrCast(ctx), mcpHasTool, .unrestricted);
}

fn dynamicMcpToolAvailable(registry: tool_dispatch.Registry, name: []const u8, advertised_dynamic_tool_names: []const []const u8, mcp_ctx: ?*anyopaque, has_tool: ?McpHasToolFn, access: tool_mcp_runtime.Access) bool {
    if (!tool_presentation.isAdvertisedDynamicMcpName(registry, name, advertised_dynamic_tool_names)) return false;
    const raw_ctx = mcp_ctx orelse return false;
    const has = has_tool orelse return false;
    return has(raw_ctx, name, access);
}

fn permissionTargetForCall(raw_ctx: *anyopaque, arena: Allocator, call: ToolCall, advertised_dynamic_tool_names: []const []const u8) ![]const u8 {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const tool_ctx = tool_runtime.withAdvertisedDynamicToolNames(
        ctx.toolContext(),
        advertised_dynamic_tool_names,
    );
    return tool_admission.permissionTargetForCall(tool_ctx.admissionInput(), arena, call);
}

fn executeWebToolCall(
    _: *anyopaque,
    request: agent_runtime.ToolExecutionRequest,
) !ToolExecutionResult {
    return agent_runtime.unavailableHostToolResult(request.result_allocator);
}

fn executeToolCall(
    raw_ctx: *anyopaque,
    request: agent_runtime.ToolExecutionRequest,
) !ToolExecutionResult {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));

    const acp_id = ctx.sendToolCallPending(request.call_allocator, request.call) catch "call_unknown";
    ctx.sendToolCallProgressText(acp_id, null) catch {};

    var tool_ctx = ctx.toolContext();
    var elicitation_responder = AcpElicitationResponderContext{
        .acp = ctx,
        .tool_call_id = acp_id,
        .operation_cancel_flag = tool_ctx.cancel_flag,
    };
    defer elicitation_responder.deinit();
    tool_ctx.mcp_input_responder = elicitation_responder.responder();
    var emma_responder = AcpEmmaToolResponderContext{
        .acp = ctx,
        .tool_call_id = acp_id,
        .operation_cancel_flag = tool_ctx.cancel_flag,
    };
    tool_ctx.emma_tool_responder = emma_responder.responder();
    tool_ctx.root_user_intent_context = request.root_user_intent_context;
    tool_ctx.root_user_messages = request.root_user_messages;
    tool_ctx.root_user_evidence_complete = request.root_user_evidence_complete;
    var progress_ctx = AcpWebSearchProgressContext{ .ctx = ctx, .tool_call_id = acp_id };
    var fetch_progress_ctx = AcpWebFetchProgressContext{ .ctx = ctx, .tool_call_id = acp_id };
    tool_ctx.web_search_progress_ctx = @ptrCast(&progress_ctx);
    tool_ctx.on_web_search_progress = onWebSearchProgress;
    tool_ctx.web_fetch_progress_ctx = @ptrCast(&fetch_progress_ctx);
    tool_ctx.on_web_fetch_progress = onWebFetchProgress;
    tool_ctx.session_grants = request.session_grants;
    tool_ctx.advertised_dynamic_tool_names = request.advertised_dynamic_tool_names;
    tool_ctx.max_tool_result_bytes = request.max_tool_result_bytes;
    const result = tool_runtime.executeToolCallAuthorized(
        tool_ctx,
        request,
    ) catch |err| {
        const err_text = try formatToolExecutionError(
            raw_ctx,
            request.result_allocator,
            request.call.name,
            err,
        );
        sendAuthorizedToolCallError(ctx, request, acp_id, err, err_text);
        return err;
    };

    return completeAuthorizedToolCallTransport(ctx, request, acp_id, result);
}

fn sendAuthorizedToolCallError(
    ctx: *AcpContext,
    request: agent_runtime.ToolExecutionRequest,
    acp_id: []const u8,
    err: anyerror,
    err_text: []const u8,
) void {
    if (request.isSandboxWideningRetryCancellationError(err)) return;
    ctx.sendToolCallError(acp_id, err_text) catch {};
}

fn completeAuthorizedToolCallTransport(
    ctx: *AcpContext,
    request: agent_runtime.ToolExecutionRequest,
    acp_id: []const u8,
    result: ToolExecutionResult,
) ToolExecutionResult {
    if (request.resultAwaitsSandboxWidening(result)) return result;
    return completeToolCallTransport(ctx, request.call, acp_id, result);
}

fn completeToolCallTransport(
    ctx: *AcpContext,
    call: ToolCall,
    acp_id: []const u8,
    result: ToolExecutionResult,
) ToolExecutionResult {
    const output_text = toolUpdateContentText(result);
    if (result.status == .failure) {
        ctx.sendToolCallErrorWithCommandResult(
            acp_id,
            output_text,
            result.command_result_json,
        ) catch {};
        return result;
    }
    if (file_mutation_contract.isToolName(call.name) and
        result.committed_file_handoff != null)
    {
        var deferred = result;
        deferred.deferred_tool_completion = .{
            .transport_id = acp_id,
            .content_text = output_text,
            .command_result_json = result.command_result_json,
        };
        return deferred;
    }
    ctx.sendToolCallCompletedWithCommandResult(
        acp_id,
        output_text,
        result.command_result_json,
    ) catch {};
    return result;
}

fn publishCommittedFileHandoff(
    _: *anyopaque,
    _: file_mutation.CommittedFileHandoff,
) agent_runtime.SecondaryPublicationReport {
    return .{ .diff = .skipped, .tracker = .skipped };
}

fn publishDeferredToolCompletion(
    raw_ctx: *anyopaque,
    completion: agent_runtime.DeferredToolCompletion,
) agent_runtime.TransportPublicationOutcome {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    ctx.sendToolCallCompletedWithCommandResult(
        completion.transport_id,
        completion.content_text,
        completion.command_result_json,
    ) catch |err| {
        debug_trace.logf(
            "acp",
            "deferred ACP completion publication failed call_id={s} err={s}",
            .{ completion.transport_id, @errorName(err) },
        );
        return .failed;
    };
    return .published;
}

const AcpWebSearchProgressContext = struct {
    ctx: *AcpContext,
    tool_call_id: []const u8,
};

const AcpWebFetchProgressContext = struct {
    ctx: *AcpContext,
    tool_call_id: []const u8,
};

fn onWebSearchProgress(raw_ctx: *anyopaque, _: []const u8, progress: types.WebSearchProgress) void {
    const progress_ctx: *AcpWebSearchProgressContext = @ptrCast(@alignCast(raw_ctx));
    progress_ctx.ctx.sendWebSearchProgress(progress_ctx.tool_call_id, progress) catch {};
}

fn onWebFetchProgress(raw_ctx: *anyopaque, _: []const u8, progress: types.WebFetchProgress) void {
    const progress_ctx: *AcpWebFetchProgressContext = @ptrCast(@alignCast(raw_ctx));
    progress_ctx.ctx.sendWebFetchProgress(progress_ctx.tool_call_id, progress) catch {};
}

fn writeWebSearchProgressUpdate(alloc: Allocator, writer: *std.Io.Writer, tool_call_id: []const u8, progress: types.WebSearchProgress) !void {
    const text = try tool_presentation.formatWebSearchProgressPlain(alloc, progress);
    defer alloc.free(text);
    try acp_types.writeToolCallUpdate(writer, tool_call_id, .in_progress, text);
}

fn writeWebFetchProgressUpdate(alloc: Allocator, writer: *std.Io.Writer, tool_call_id: []const u8, progress: types.WebFetchProgress) !void {
    const text = try tool_presentation.formatWebFetchProgressPlain(alloc, progress);
    defer alloc.free(text);
    try acp_types.writeToolCallUpdate(writer, tool_call_id, .in_progress, text);
}

fn recordToolCallRejected(
    raw_ctx: *anyopaque,
    arena: Allocator,
    call: ToolCall,
    model_output: []const u8,
    command_result_json: ?[]const u8,
) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const acp_id = ctx.sendToolCallPending(arena, call) catch "call_unknown";
    ctx.sendToolCallErrorWithCommandResult(
        acp_id,
        toolUpdateContentText(.{
            .status = .failure,
            .model_output = model_output,
        }),
        command_result_json,
    ) catch {};
}

fn toolUpdateContentText(result: ToolExecutionResult) []const u8 {
    if (!text_utils.isModelSafeText(result.model_output)) {
        debug_trace.logf(
            "acp",
            "tool update omitted binary or non-utf8 output bytes={d}",
            .{result.model_output.len},
        );
        return "binary or non-utf8 tool output omitted";
    }
    if (result.status == .failure and tool_result_errors.isToolPermissionDeniedOutput(result.model_output)) {
        return result.model_output;
    }
    return text_utils.utf8PrefixByBytes(result.model_output, 200);
}

fn propagateHistoryTurn(raw_ctx: *anyopaque, turn: HistoryTurn) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    if (ctx.state.active_session) |*session| {
        try persistAcpHistoryTurn(ctx.alloc, session, turn);
    }
}

fn persistAcpHistoryTurn(
    alloc: Allocator,
    session: *server.ActiveSessionState,
    turn: HistoryTurn,
) !void {
    session.session_write_mutex.lockUncancelable(io_mod.getIo());
    defer session.session_write_mutex.unlock(io_mod.getIo());
    try session.session_rt.appendHistoryEntry(alloc, turn);
    if (comptime host_target.is_wasm) {
        try sessions.commitWasmSessionLocked(alloc, session);
        return;
    }
    const writable = if (session.writable) |*value| value else return;
    try subagent_resume_admission.retainExternalRootUserTurn(
        alloc,
        writable,
        turn,
    );
    if (writable.degradedTail() != null) {
        const now_ms = io_mod.milliTimestamp();
        var current = try currentAcpState(alloc, session, writable, now_ms);
        defer current.deinit(alloc);
        if (current.recovery_checkpoint) |*checkpoint| checkpoint.deinit(alloc);
        current.recovery_checkpoint = null;
        try writable.retryDegradedWithStateReplacement(
            alloc,
            current,
            .{},
        );
        if (current.usage) |usage| session.session_rt.usage.markClean(usage);
        return;
    }
    _ = writable.appendEvent(
        alloc,
        .{ .history_turn_committed = .{
            .conversation_language = session.session_rt.languageSnapshot(),
            .total_input_tokens = writable.state.total_input_tokens,
            .total_output_tokens = writable.state.total_output_tokens,
            .turn = turn,
        } },
        io_mod.milliTimestamp(),
        .retry_expected_tail,
        .{},
    ) catch |err| switch (err) {
        error.EventFrameTooLarge => {
            try commitAcpStateReplacement(alloc, session, writable, true);
            return;
        },
        else => return err,
    };
}

test "ACP degraded history repair commits the finished turn once" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home");
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home);
    const workspace = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "workspace");
    defer alloc.free(workspace);

    var store = try session_store.Store.initFromHome(alloc, home, workspace);
    defer store.deinit(alloc);
    var state = session_codec.DurableSessionState{
        .id = try alloc.dupe(u8, "acp-degraded-history"),
        .origin_workspace_root = try alloc.dupe(u8, workspace),
        .workspace_root = try alloc.dupe(u8, workspace),
        .created_at_ms = 1,
        .updated_at_ms = 1,
        .conversation_language = session_runtime.ConversationLanguage.literal("en"),
        .preferences = .{
            .model = try alloc.dupe(u8, "test/model"),
            .effort = .auto,
            .fast_mode = false,
        },
        .history = try alloc.alloc(HistoryTurn, 0),
        .total_input_tokens = 0,
        .total_output_tokens = 0,
    };
    defer state.deinit(alloc);
    const writable = try store.startWritableSession(alloc, state);
    var session = server.ActiveSessionState{
        .session_id = try alloc.dupe(u8, state.id),
        .writable = writable,
        .model = try alloc.dupe(u8, state.preferences.model),
        .mode = "code",
        .workspace_root = workspace,
        .api_key = "",
        .agent_step_limit = 1,
        .max_tool_result_bytes = 1024,
        .fast_mode = false,
        .effort = .auto,
        .first_call_tool_choice = .auto,
        .permission_mode = .auto,
        .sandbox_backend = .none,
        .permission_rules = .{},
        .session_rt = .{ .max_history_turns = 8 },
        .cancel_flag = std.atomic.Value(bool).init(false),
        .pending_prompt_id = null,
    };
    defer {
        session.session_rt.deinit(alloc);
        session.writable.?.deinit(alloc);
        alloc.free(session.model);
        alloc.free(session.session_id);
    }

    const Failure = struct {
        fn boundary(_: ?*anyopaque, point: session_log.Boundary) !void {
            if (point == .after_event_sync) return error.InjectedBoundaryFailure;
        }
    };
    try std.testing.expectError(
        error.SessionPersistenceDegraded,
        session.writable.?.appendEvent(
            alloc,
            .{ .preferences_changed = .{ .fast_mode = true } },
            2,
            .retry_expected_tail,
            .{ .test_controls = .{ .boundary_fn = Failure.boundary } },
        ),
    );
    try std.testing.expect(session.writable.?.degradedTail() != null);

    const turn = try session_runtime.makeAssistantTurn(alloc, "hello", "done");
    defer types.freeHistoryTurn(alloc, turn);
    try persistAcpHistoryTurn(alloc, &session, turn);

    try std.testing.expect(session.writable.?.degradedTail() == null);
    try std.testing.expectEqual(@as(usize, 1), session.session_rt.history.items.len);
    try std.testing.expectEqual(@as(usize, 1), session.writable.?.state.history.len);
    try std.testing.expectEqualStrings(
        "done",
        session.writable.?.state.history[0].assistant.assistant,
    );
}

fn setRecoveryCheckpoint(
    raw_ctx: *anyopaque,
    checkpoint: session_codec.RecoveryCheckpoint,
) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const session = if (ctx.state.active_session) |*value| value else return error.SessionPersistenceUnavailable;
    session.session_write_mutex.lockUncancelable(io_mod.getIo());
    defer session.session_write_mutex.unlock(io_mod.getIo());
    const writable = if (session.writable) |*value| value else return error.SessionPersistenceUnavailable;
    const now_ms = io_mod.milliTimestamp();
    _ = writable.appendEvent(
        ctx.alloc,
        .{ .recovery_checkpoint_set = .{ .checkpoint = checkpoint } },
        now_ms,
        .retry_expected_tail,
        .{},
    ) catch |err| switch (err) {
        error.EventFrameTooLarge => {
            var current = try currentAcpState(ctx.alloc, session, writable, now_ms);
            defer current.deinit(ctx.alloc);
            if (current.recovery_checkpoint) |*old| old.deinit(ctx.alloc);
            current.recovery_checkpoint = try checkpoint.dupe(ctx.alloc);
            _ = try writable.commitStateReplacement(
                ctx.alloc,
                current,
                .compaction,
                .retry_expected_tail,
                .{},
            );
        },
        else => return err,
    };
}

fn currentAcpState(
    alloc: Allocator,
    session: *server.ActiveSessionState,
    writable: *session_store.LoadedWritableSession,
    now_ms: i64,
) !session_codec.DurableSessionState {
    var state = try writable.state.dupe(alloc);
    errdefer state.deinit(alloc);
    const history = try session.session_rt.snapshotHistory(alloc);
    types.freeHistoryTurnSlice(alloc, state.history);
    state.history = history;
    const permission_state = try session.session_rt.snapshotPermissionState(alloc);
    state.permission_state.deinit(alloc);
    state.permission_state = permission_state;
    state.conversation_language = session.session_rt.languageSnapshot();
    state.updated_at_ms = now_ms;
    const usage = try session.session_rt.usage.snapshot(alloc);
    if (state.usage) |*old| old.deinit(alloc);
    state.usage = usage;
    return state;
}

fn commitAcpStateReplacement(
    alloc: Allocator,
    session: *server.ActiveSessionState,
    writable: *session_store.LoadedWritableSession,
    clear_recovery_checkpoint: bool,
) !void {
    const now_ms = io_mod.milliTimestamp();
    var state = try currentAcpState(alloc, session, writable, now_ms);
    defer state.deinit(alloc);
    if (clear_recovery_checkpoint) {
        if (state.recovery_checkpoint) |*checkpoint| checkpoint.deinit(alloc);
        state.recovery_checkpoint = null;
    }
    _ = try writable.commitStateReplacement(
        alloc,
        state,
        .compaction,
        .retry_expected_tail,
        .{},
    );
    if (state.usage) |usage| {
        session.session_rt.usage.markClean(usage);
    }
}

/// Folds this session's older turns into one summary, on request.
///
/// The ACP command list has always advertised `compact` and nothing honoured
/// it. This is the same lever `/compact` pulls in the TUI, and it is a method of
/// its own rather than a prompt because the model is not involved: the summary
/// is built the next time a prompt reads the context history, so nothing here
/// costs a generation. `waitsForActivePrompt` keeps it out of a turn already in
/// flight, whose history is being read on another thread.
pub fn handleCompact(
    state: *server.ServerState,
    alloc: Allocator,
    msg: *jsonrpc.Message,
) !void {
    const session = if (state.active_session) |*active| active else {
        return state.writer.writeError(alloc, msg.id, no_active_session_rpc_error);
    };
    const before = session.session_rt.contextHistoryStart();
    session.session_rt.forceCompaction();
    const start = session.session_rt.contextHistoryStart();
    const compacted = start != before;
    // Only when something moved: an unchanged session is not worth a durable
    // write, and a session with no store behind it compacts in memory alone.
    if (compacted) {
        if (session.writable) |*writable| try commitAcpStateReplacement(alloc, session, writable, false);
    }
    const total = session.session_rt.historyLen();
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.print(
        "{{\"compacted\":{s},\"summarizedTurns\":{d},\"remainingTurns\":{d}}}",
        .{ if (compacted) "true" else "false", start, total -| start },
    );
    try state.writer.writeResponse(alloc, msg.id, out.writer.buffered());
}

/// Stores grants on the active ACP session without persisting them.
fn retainAcpGrant(raw_ctx: *anyopaque, tool_name: []const u8, target_path: []const u8) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    ctx.state.subagent_authority_mutex.lockUncancelable(io_mod.getIo());
    defer ctx.state.subagent_authority_mutex.unlock(io_mod.getIo());
    const session = if (ctx.state.active_session) |*active| active else return;
    try session.retainGrant(ctx.alloc, tool_name, target_path);
}

fn pushEvent(raw_ctx: *anyopaque, event: worker_runtime.WorkerEvent) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    switch (event) {
        .clear_route_recovery_status => try ctx.clearModelRecoveryStatus(),
        else => {},
    }
    worker_runtime.freeWorkerEvent(std.heap.c_allocator, event);
}

fn pushRouteRecoveryStatus(
    raw_ctx: *anyopaque,
    status: types.RouteRecoveryStatus,
) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    try ctx.sendModelRecoveryStatus(status);
}

fn pushText(raw_ctx: *anyopaque, emission: agent_runtime.TextEmission) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const text = switch (emission) {
        // The client renders markdown itself, so it gets the model's own bytes.
        // `assistant_rendered` is the TUI projection — box-drawing tables, `•`
        // bullets, ANSI — which is unparseable once it reaches a markdown view.
        .assistant_source => |text| text,
        .reasoning => |text| {
            if (text.len != 0) ctx.sendAgentThought(text) catch {};
            return;
        },
        .assistant_rendered => return,
        .operational => |text| text,
    };
    if (text.len == 0) return;
    ctx.sendAgentText(text) catch {};
}

fn pushToolLifecycle(raw_ctx: *anyopaque, event: types.ToolLifecycleEvent) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    switch (event) {
        .authoritative_started => |started| {
            var arena_state = std.heap.ArenaAllocator.init(ctx.alloc);
            defer arena_state.deinit();
            _ = try ctx.sendToolCallPending(arena_state.allocator(), .{
                .id = started.id.call_id,
                .name = started.tool_name,
                .arguments_json = started.arguments_json orelse "{}",
            });
        },
        .provisional, .progress, .terminal, .turn_finished => {},
    }
}

/// A subagent's tool calls, published on the parent's stream.
///
/// The session's own `pushToolLifecycle` only opens a call, because the parent
/// closes its calls from `executeToolCall` — a path a child never takes, since
/// `subagent_agent_adapter` installs its own. So this one opens and closes.
fn pushChildToolLifecycle(raw_ctx: *anyopaque, event: types.ToolLifecycleEvent) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    switch (event) {
        .authoritative_started => |started| {
            var arena_state = std.heap.ArenaAllocator.init(ctx.alloc);
            defer arena_state.deinit();
            _ = ctx.sendToolCallPending(arena_state.allocator(), .{
                .id = started.id.call_id,
                .name = started.tool_name,
                .arguments_json = started.arguments_json orelse "{}",
            }) catch {};
        },
        .progress => |progress| ctx.sendToolCallProgressText(progress.id.call_id, progress.text) catch {},
        .terminal => |terminal| {
            const text = terminal.result orelse terminal.outcome.summary;
            switch (terminal.outcome.kind) {
                // Still running as far as anyone watching is concerned: the call
                // is waiting on something and will report again.
                .deferred => {},
                .completed => ctx.sendToolCallCompletedWithCommandResult(terminal.id.call_id, text, null) catch {},
                .denied, .cancelled, .failed => ctx.sendToolCallError(terminal.id.call_id, text) catch {},
            }
        },
        .provisional, .turn_finished => {},
    }
}

/// What to call a subagent in a list of them: the opening line of the work it was
/// given, which is the only name a child has. Cut on a character boundary, since
/// a title is written straight into JSON.
fn childTitle(content: []const u8) []const u8 {
    const line = content[0 .. std.mem.indexOfScalar(u8, content, '\n') orelse content.len];
    const trimmed = std.mem.trim(u8, line, " \t\r");
    var end = @min(trimmed.len, 80);
    while (end > 0 and end < trimmed.len and trimmed[end] & 0xc0 == 0x80) end -= 1;
    return trimmed[0..end];
}

test "a child is named after the first line of its brief, never mid-character" {
    try std.testing.expectEqualStrings("read the docs", childTitle("  read the docs \nthen report"));
    // 27 three-byte characters: the 80-byte cut falls inside the 27th.
    const wide = "日" ** 27;
    const title = childTitle(wide);
    try std.testing.expectEqual(@as(usize, 78), title.len);
    try std.testing.expect(std.unicode.utf8ValidateSlice(title));
}

fn pushSystemNotice(raw_ctx: *anyopaque, text: []const u8) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    ctx.sendAgentText(text) catch {};
}

fn pushContextNotice(raw_ctx: *anyopaque, text: []const u8) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const session = if (ctx.state.active_session) |*active| active else return;
    if (!try session.session_rt.claimContextNotice(ctx.alloc, text)) return;
    try pushSystemNotice(raw_ctx, text);
}

/// Status, not words: it rides the info channel rather than the agent text a
/// notice takes, because anything sent as agent text lands in the durable reply
/// as though the model had said it.
fn pushContextExperiment(raw_ctx: *anyopaque, outcome: context_experiments.Outcome) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    var out: std.Io.Writer.Allocating = .init(ctx.alloc);
    defer out.deinit();
    try acp_types.writeContextExperimentInfoUpdate(&out.writer, outcome.pruned_results, outcome.reinjected, outcome.saved_tokens, outcome.added_tokens);
    // ponytail: a subagent's copy is dropped — `writeChildTaggedUpdate` refuses an
    // update that already carries `_meta`, and a status line is not worth failing
    // the step it reports on. Merge the two `_meta` objects if children need it.
    ctx.sendUpdate(out.writer.buffered()) catch {};
}

fn pushDiffBlock(raw_ctx: *anyopaque, payload: agent_runtime.DiffEntryPayload) !void {
    defer diff_mod.freeDiffEntryPayload(std.heap.c_allocator, payload);
    try pushText(raw_ctx, .{ .operational = payload.preview });
}

fn pushCommandOutputComplete(_: *anyopaque, _: ?types.ToolLifecycleId) !void {}

fn pushHttpError(raw_ctx: *anyopaque, status: std.http.Status, detail: []const u8, credential_source: ?types.CredentialSource) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    var buf: [1024]u8 = undefined;
    const auth_failure = auth_runtime.FailureSnapshot.fromHttp(status, credential_source);
    const owned_message = if (auth_failure) |failure|
        try failure.renderText(ctx.alloc)
    else
        null;
    defer if (owned_message) |message| ctx.alloc.free(message);
    const msg = owned_message orelse if (detail.len > 0)
        std.fmt.bufPrint(&buf, "HTTP {d}: {s}", .{ @intFromEnum(status), detail }) catch "HTTP error"
    else
        std.fmt.bufPrint(&buf, "HTTP {d}", .{@intFromEnum(status)}) catch "HTTP error";
    ctx.sendAgentText(msg) catch {};
}

fn formatToolExecutionError(_: *anyopaque, arena: Allocator, tool_name: []const u8, err: anyerror) ![]const u8 {
    return tool_result_errors.formatToolExecutionErrorJson(arena, tool_name, err);
}

fn onCommandOutputChunk(raw_ctx: *anyopaque, lifecycle_id: ?types.ToolLifecycleId, _: command_output_content.Stream, chunk: []const u8) !void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const id = lifecycle_id orelse return;
    try ctx.sendToolCallProgressText(id.call_id, chunk);
}

fn onMcpProgress(raw_ctx: *anyopaque, lifecycle_id: types.ToolLifecycleId, text: []const u8) void {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    ctx.sendToolCallProgressText(lifecycle_id.call_id, text) catch |err| {
        debug_trace.logf("mcp", "failed to publish ACP MCP progress err={s}", .{@errorName(err)});
    };
}

const AcpInputResponse = struct {
    key: []const u8,
    json: []u8,

    fn deinit(self: *AcpInputResponse, alloc: Allocator) void {
        alloc.free(self.json);
        self.* = undefined;
    }
};

fn respondToAcpMcpInput(
    raw_ctx: *anyopaque,
    alloc: Allocator,
    origin: tool_mcp_runtime.InputOrigin,
    required: tool_mcp_runtime.InputRequired,
) anyerror![]const u8 {
    const responder: *AcpElicitationResponderContext = @ptrCast(@alignCast(raw_ctx));
    const requests = try mrtr.parseRequestJsonForWire(
        alloc,
        required.input_requests_json,
        origin.wire,
        .{},
    );
    defer {
        for (requests) |*request| request.deinit(alloc);
        alloc.free(requests);
    }
    if (requests.len == 0) return error.McpInputRequired;

    const responses = try alloc.alloc(AcpInputResponse, requests.len);
    var response_count: usize = 0;
    errdefer {
        for (responses[0..response_count]) |*response| response.deinit(alloc);
        alloc.free(responses);
    }

    var cancelled = false;
    for (requests) |request| {
        const response_json = if (cancelled)
            try alloc.dupe(u8, "{\"action\":\"cancel\"}")
        else response: {
            const input_request = switch (request.payload) {
                .elicitation_create => |value| value,
                else => return error.McpInputRequired,
            };
            if (!responder.acp.state.client_elicitation.supports(input_request.mode)) {
                return error.McpInputRequired;
            }
            const direct = try requestAcpElicitation(
                responder,
                alloc,
                origin,
                input_request,
            );
            if (std.mem.eql(u8, direct, "{\"action\":\"cancel\"}")) cancelled = true;
            break :response direct;
        };
        responses[response_count] = .{ .key = request.key, .json = response_json };
        response_count += 1;
    }

    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.writeByte('{');
    for (responses, 0..) |response, index| {
        if (index > 0) try out.writer.writeByte(',');
        try std.json.Stringify.value(response.key, .{}, &out.writer);
        try out.writer.writeByte(':');
        try out.writer.writeAll(response.json);
    }
    try out.writer.writeByte('}');
    const result = try out.toOwnedSlice();
    for (responses) |*response| response.deinit(alloc);
    alloc.free(responses);
    return result;
}

fn requestAcpElicitation(
    responder: *AcpElicitationResponderContext,
    alloc: Allocator,
    origin: tool_mcp_runtime.InputOrigin,
    input_request: mcp_elicitation.Request,
) ![]u8 {
    const state = responder.acp.state;
    const outbound_id = (try server.beginOutboundRequest(state, .elicitation)) orelse
        return error.McpInputRequired;
    var awaiting = true;
    errdefer if (awaiting) {
        server.cancelOutboundRequest(state, outbound_id);
        if (server.awaitOutboundResponse(state, outbound_id, .elicitation)) |owned| {
            var response = owned;
            response.deinit(state.alloc);
        }
    };

    var id_buffer: [48]u8 = undefined;
    const url_id = if (input_request.mode == .url)
        try std.fmt.bufPrint(&id_buffer, "fx-{d}", .{outbound_id})
    else
        null;
    const legacy_source_id = if (origin.wire.isLegacy() and input_request.mode == .url)
        input_request.elicitation_id orelse return error.McpInputRequired
    else
        null;
    var legacy_url_retained = false;
    if (legacy_source_id) |source_id| {
        if (!try server.reserveLegacyUrl(
            state,
            origin,
            source_id,
            url_id.?,
            responder.acp.session_id,
            responder.tool_call_id,
        )) return error.McpInputRequired;
        if (activeMcp(responder.acp)) |runtime| {
            runtime.reconcileLegacyUrlCompletion(
                origin,
                source_id,
                server.legacyUrlCompletionSink(state),
            );
        }
    }
    defer if (legacy_source_id != null and !legacy_url_retained) {
        server.removeLegacyUrl(state, url_id.?);
    };
    const display_message = try formatAcpElicitationMessage(alloc, origin.server_name, input_request);
    defer alloc.free(display_message);
    const params = try mcp_elicitation.projectToAcpCreateParams(
        alloc,
        input_request,
        .{ .session = .{
            .session_id = responder.acp.session_id,
            .tool_call_id = responder.tool_call_id,
        } },
        url_id,
        display_message,
        .{},
    );
    defer alloc.free(params);
    try state.writer.writeRequest(
        alloc,
        .{ .integer = @intCast(outbound_id) },
        "elicitation/create",
        params,
    );

    const maybe_response = try awaitAcpElicitationResponse(
        state,
        outbound_id,
        origin,
        responder.operation_cancel_flag,
    );
    awaiting = false;
    var response = maybe_response orelse return error.Cancelled;
    defer response.deinit(state.alloc);
    if (response.cancelled) return error.Cancelled;
    if (response.error_json != null) return error.McpInputRequired;
    const response_json = response.result_json orelse return error.McpInputRequired;

    var projected_request = try mcp_elicitation.parseRequest(alloc, .acp, params, .{});
    defer projected_request.deinit(alloc);
    const canonical_response = try mcp_elicitation.canonicalResponse(
        alloc,
        projected_request,
        response_json,
        .{},
    );
    errdefer alloc.free(canonical_response);
    const action = try mcp_elicitation.validateResponse(
        alloc,
        projected_request,
        canonical_response,
        .{},
    );
    var transition_state: mcp_elicitation.RequestState = .pending;
    const live_witness = if (activeMcp(responder.acp)) |runtime|
        runtime.inputIdentityWitness(origin.server_name)
    else
        null;
    const transition = mcp_elicitation.decideTransition(
        transition_state,
        bindingForAcpInput(responder, origin),
        answerBindingForAcpInput(responder, origin, live_witness),
        acpAwakeMillis(),
        live_witness != null,
    );
    switch (transition) {
        .consume => transition_state = .consumed,
        .reject => return error.McpInputRequired,
    }
    std.debug.assert(transition_state == .consumed);

    if (input_request.mode == .url and action == .accept) {
        if (legacy_source_id != null) {
            const runtime = activeMcp(responder.acp) orelse return error.McpInputRequired;
            const accept_result = runtime.acceptLegacyUrlCompletion(
                origin,
                url_id.?,
                server.legacyUrlCompletionSink(state),
            ) orelse return error.McpInputRequired;
            if (accept_result == .awaiting_completion) {
                const retained_acp_id = try state.alloc.dupe(u8, url_id.?);
                errdefer state.alloc.free(retained_acp_id);
                try responder.accepted_legacy_urls.append(state.alloc, .{
                    .acp_id = retained_acp_id,
                });
                legacy_url_retained = true;
            }
        } else {
            const retained_id = try state.alloc.dupe(u8, url_id.?);
            errdefer state.alloc.free(retained_id);
            try responder.accepted_url_ids.append(state.alloc, retained_id);
        }
    }
    return canonical_response;
}

fn formatAcpElicitationMessage(
    alloc: Allocator,
    server_name: []const u8,
    request: mcp_elicitation.Request,
) ![]u8 {
    return switch (request.mode) {
        .form => std.fmt.allocPrint(
            alloc,
            "Fx received a form request from MCP server {s}. {s}",
            .{ server_name, request.message },
        ),
        .url => std.fmt.allocPrint(
            alloc,
            "Fx received a URL request from MCP server {s} for host {s}. {s}",
            .{ server_name, request.url_host orelse "unknown", request.message },
        ),
        .unknown => error.McpInputRequired,
    };
}

fn bindingForAcpInput(
    responder: *AcpElicitationResponderContext,
    origin: tool_mcp_runtime.InputOrigin,
) mcp_elicitation.Binding {
    return .{
        .server_name = origin.server_name,
        .scope = .{ .acp_session = .{
            .session_id = responder.acp.session_id,
            .tool_call_id = responder.tool_call_id,
        } },
        .runtime_generation = origin.runtime_generation,
        .connection_generation = origin.connection_generation,
        .client_generation = origin.client_generation,
        .catalog_generation = origin.catalog_generation,
        .request_generation = origin.request_generation,
        .auth_generation = origin.auth_generation,
        .deadline_ms = origin.deadline_ms,
    };
}

fn answerBindingForAcpInput(
    responder: *AcpElicitationResponderContext,
    origin: tool_mcp_runtime.InputOrigin,
    witness: ?tool_mcp_runtime.InputIdentityWitness,
) mcp_elicitation.AnswerBinding {
    const current: tool_mcp_runtime.InputIdentityWitness = witness orelse .{
        .runtime_generation = origin.runtime_generation,
        .connection_generation = origin.connection_generation,
        .client_generation = origin.client_generation,
        .catalog_generation = origin.catalog_generation,
        .auth_generation = origin.auth_generation,
    };
    return .{
        .server_name = origin.server_name,
        .scope = .{ .acp_session = .{
            .session_id = responder.acp.session_id,
            .tool_call_id = responder.tool_call_id,
        } },
        .runtime_generation = current.runtime_generation,
        .connection_generation = current.connection_generation,
        .client_generation = current.client_generation,
        .catalog_generation = current.catalog_generation,
        .request_generation = origin.request_generation,
        .auth_generation = current.auth_generation,
    };
}

const AcpElicitationWait = union(enum) {
    response: ?server.OutboundResponse,
    deadline: anyerror!void,
    cancelled: anyerror!void,
};

fn awaitAcpElicitationResponse(
    state: *server.ServerState,
    id: u64,
    origin: tool_mcp_runtime.InputOrigin,
    operation_cancel_flag: ?*const std.atomic.Value(bool),
) !?server.OutboundResponse {
    const Cleanup = struct {
        fn drain(state_alloc: Allocator, select: *std.Io.Select(AcpElicitationWait)) void {
            while (select.cancel()) |item| switch (item) {
                .response => |maybe_response| if (maybe_response) |owned| {
                    var response = owned;
                    response.deinit(state_alloc);
                },
                .deadline, .cancelled => {},
            };
        }
    };

    var select_buffer: [3]AcpElicitationWait = undefined;
    var select: std.Io.Select(AcpElicitationWait) = .init(io_mod.getIo(), &select_buffer);
    try select.concurrent(.response, server.awaitOutboundResponse, .{ state, id, server.OutboundKind.elicitation });
    select.concurrent(.deadline, waitForAcpElicitationDeadline, .{origin.deadline_ms}) catch |err| {
        Cleanup.drain(state.alloc, &select);
        return err;
    };
    select.concurrent(.cancelled, waitForAcpElicitationCancellation, .{
        origin.lifecycle_cancel_flag,
        operation_cancel_flag,
    }) catch |err| {
        Cleanup.drain(state.alloc, &select);
        return err;
    };
    const event = select.await() catch |err| {
        Cleanup.drain(state.alloc, &select);
        return err;
    };
    return switch (event) {
        .response => |response| result: {
            Cleanup.drain(state.alloc, &select);
            break :result response;
        },
        .deadline, .cancelled => result: {
            server.cancelOutboundRequest(state, id);
            Cleanup.drain(state.alloc, &select);
            break :result null;
        },
    };
}

fn waitForAcpElicitationDeadline(deadline_ms: i64) anyerror!void {
    while (acpAwakeMillis() < deadline_ms) {
        const remaining = deadline_ms - acpAwakeMillis();
        try io_mod.getIo().sleep(.fromMilliseconds(@intCast(@max(@min(remaining, 20), 1))), .awake);
    }
}

fn waitForAcpElicitationCancellation(
    lifecycle_cancel_flag: ?*const std.atomic.Value(bool),
    operation_cancel_flag: ?*const std.atomic.Value(bool),
) anyerror!void {
    while ((lifecycle_cancel_flag == null or !lifecycle_cancel_flag.?.load(.acquire)) and
        (operation_cancel_flag == null or !operation_cancel_flag.?.load(.acquire)))
    {
        try io_mod.getIo().sleep(.fromMilliseconds(10), .awake);
    }
}

fn acpAwakeMillis() i64 {
    const now = std.Io.Clock.Timestamp.now(io_mod.getIo(), .awake);
    const milliseconds = @divFloor(now.raw.nanoseconds, std.time.ns_per_ms);
    return std.math.cast(i64, milliseconds) orelse if (milliseconds < 0)
        std.math.minInt(i64)
    else
        std.math.maxInt(i64);
}

fn finishAcpUrlElicitations(
    raw_ctx: *anyopaque,
    alloc: Allocator,
    _: tool_mcp_runtime.InputOrigin,
    outcome: tool_mcp_runtime.ContinuationTerminal,
) void {
    const responder: *AcpElicitationResponderContext = @ptrCast(@alignCast(raw_ctx));
    for (responder.accepted_url_ids.items) |id| {
        if (outcome == .completed) {
            var params: std.Io.Writer.Allocating = .init(alloc);
            defer params.deinit();
            params.writer.writeAll("{\"elicitationId\":") catch continue;
            std.json.Stringify.value(id, .{}, &params.writer) catch continue;
            params.writer.writeByte('}') catch continue;
            responder.acp.state.writer.writeNotification(
                alloc,
                "elicitation/complete",
                params.writer.buffered(),
            ) catch {};
        }
        responder.acp.state.alloc.free(id);
    }
    responder.accepted_url_ids.clearRetainingCapacity();
    for (responder.accepted_legacy_urls.items) |*accepted| {
        if (outcome != .completed) {
            server.removeLegacyUrl(responder.acp.state, accepted.acp_id);
        }
        accepted.deinit(responder.acp.state.alloc);
    }
    responder.accepted_legacy_urls.clearRetainingCapacity();
}

fn mcpHasTool(raw_ctx: *anyopaque, name: []const u8, access: tool_mcp_runtime.Access) bool {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const mcp = activeMcp(ctx) orelse return false;
    return mcp.hasToolWithAccess(name, access);
}

fn mcpValidateTool(raw_ctx: *anyopaque, arena: Allocator, name: []const u8, arguments_json: []const u8, access: tool_mcp_runtime.Access) anyerror!tool_mcp_runtime.ValidationResult {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const runtime = activeMcp(ctx) orelse return .not_available;
    return runtime.validateToolArgumentsByNameWithAccess(
        arena,
        name,
        arguments_json,
        access,
    );
}

fn mcpCallTool(raw_ctx: *anyopaque, arena: Allocator, name: []const u8, arguments_json: []const u8, max_tool_result_bytes: usize, options: tool_mcp_runtime.CallOptions) anyerror!?tool_mcp_runtime.CallResult {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const mcp = activeMcp(ctx) orelse return null;
    return mcp.callToolByNameWithOptions(
        arena,
        name,
        arguments_json,
        max_tool_result_bytes,
        options,
    );
}

fn mcpSearchTools(raw_ctx: *anyopaque, arena: Allocator, query: []const u8, limit: usize, permission_rules: types.PermissionRuleSet, limits: config_runtime.context_limits.Values, access: tool_mcp_runtime.Access) anyerror!tool_mcp_runtime.SearchResult {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const mcp = activeMcp(ctx) orelse return error.McpServerNotFound;
    return mcp.searchTools(arena, query, limit, permission_rules, limits, access);
}

fn mcpToolSchemaJson(raw_ctx: *anyopaque, arena: Allocator, name: []const u8, permission_rules: types.PermissionRuleSet, limits: config_runtime.context_limits.Values, access: tool_mcp_runtime.Access) anyerror!?tool_mcp_runtime.ToolSchemaResult {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const mcp = activeMcp(ctx) orelse return null;
    return mcp.toolSchemaJsonByNameWithAccess(
        arena,
        name,
        permission_rules,
        limits,
        access,
    );
}

fn mcpCallFeature(
    raw_ctx: *anyopaque,
    arena: Allocator,
    request: tool_mcp_runtime.FeatureRequest,
    options: tool_mcp_runtime.FeatureCallOptions,
) anyerror!tool_mcp_runtime.FeatureResult {
    const ctx: *AcpContext = @ptrCast(@alignCast(raw_ctx));
    const mcp = activeMcp(ctx) orelse return error.McpRuntimeUnavailable;
    return mcp.callFeatureForModel(arena, request, options);
}

fn activeMcp(ctx: *AcpContext) ?*mcp_runtime.McpRuntime {
    const session = if (ctx.state.active_session) |*active| active else return null;
    return session.mcp;
}

fn onBackgroundUrlReady(_: *anyopaque, _: u64, _: []const u8) void {}

pub fn mapToolKind(tool_name: []const u8) acp_types.ToolCallKind {
    if (std.mem.eql(u8, tool_name, "list_files")) return .read;
    if (std.mem.eql(u8, tool_name, "glob_files")) return .read;
    if (std.mem.eql(u8, tool_name, "grep_files")) return .search;
    if (std.mem.eql(u8, tool_name, "read_file")) return .read;
    if (std.mem.eql(u8, tool_name, "file_info")) return .read;
    if (std.mem.eql(u8, tool_name, "semantic_search")) return .search;
    if (std.mem.eql(u8, tool_name, "web_fetch")) return .read;
    if (std.mem.eql(u8, tool_name, "web_search")) return .search;
    if (std.mem.eql(u8, tool_name, "write_file")) return .edit;
    if (std.mem.eql(u8, tool_name, "edit_file")) return .edit;
    if (std.mem.eql(u8, tool_name, "delete_file")) return .delete;
    if (std.mem.eql(u8, tool_name, "rename_file")) return .move;
    if (std.mem.eql(u8, tool_name, "copy_file")) return .move;
    if (std.mem.eql(u8, tool_name, "create_folder")) return .edit;
    if (std.mem.eql(u8, tool_name, "terminal")) return .execute;
    if (std.mem.eql(u8, tool_name, "run_command")) return .execute;
    if (std.mem.eql(u8, tool_name, "memory")) return .other;
    if (std.mem.eql(u8, tool_name, "skill")) return .other;
    if (std.mem.eql(u8, tool_name, "install_skill")) return .other;
    return .other;
}

fn describeToolTitle(registry: tool_dispatch.Registry, arena: Allocator, call: ToolCall) ![]const u8 {
    if (registry.lookup(call.name)) |tool| {
        return std.fmt.allocPrint(arena, "{s}", .{tool.action_label});
    }
    return std.fmt.allocPrint(arena, "{s}", .{call.name});
}

test "ACP lifecycle action preserves dynamic MCP availability boundaries" {
    const Fixture = struct {
        calls: usize = 0,
        available: bool = false,

        fn hasTool(raw_ctx: *anyopaque, _: []const u8, _: tool_mcp_runtime.Access) bool {
            const self: *@This() = @ptrCast(@alignCast(raw_ctx));
            self.calls += 1;
            return self.available;
        }
    };
    const alloc = std.testing.allocator;
    const advertised = [_][]const u8{"mcp_lookup"};
    var fixture = Fixture{};

    const missing = dynamicMcpToolAvailable(builtin_tools.registry, "mcp_lookup", &advertised, @ptrCast(&fixture), Fixture.hasTool, .unrestricted);
    try std.testing.expect(!missing);
    try std.testing.expectEqual(@as(usize, 1), fixture.calls);
    const missing_label = try tool_presentation.formatPlainAction(alloc, .{
        .tool_registry = builtin_tools.registry,
        .call = .{ .id = "missing", .name = "mcp_lookup", .arguments_json = "{}" },
        .is_available_dynamic_mcp_tool = missing,
    });
    defer alloc.free(missing_label);
    try std.testing.expectEqualStrings("Working: mcp_lookup", missing_label);

    const builtin = dynamicMcpToolAvailable(builtin_tools.registry, "terminal", &.{"terminal"}, @ptrCast(&fixture), Fixture.hasTool, .unrestricted);
    try std.testing.expect(!builtin);
    try std.testing.expectEqual(@as(usize, 1), fixture.calls);
}

test "ACP lifecycle resolves dynamic MCP availability through session context" {
    const alloc = std.testing.allocator;
    var state = try initTestAcpState(alloc, "/tmp/workspace", .auto);
    defer state.deinit();

    const runtime = try alloc.create(mcp_runtime.McpRuntime);
    runtime.* = mcp_runtime.McpRuntime.init(alloc);
    var runtime_owned = true;
    defer if (runtime_owned) {
        runtime.deinit();
        alloc.destroy(runtime);
    };
    try runtime.addServer(.{
        .name = try alloc.dupe(u8, "fixture"),
    });
    const mcp_server = &runtime.servers.items[0];
    mcp_server.state = .ready;
    try mcp_server.tool_catalog.tools.append(alloc, .{
        .server_name = mcp_server.config.name,
        .original_name = try alloc.dupe(u8, "echo"),
        .prefixed_name = try alloc.dupe(u8, "mcp_fixture_echo"),
        .description = try alloc.dupe(u8, "Echo input"),
        .input_schema_json = try alloc.dupe(u8, "{\"type\":\"object\"}"),
        .tags = &.{},
        .search_text = try alloc.dupe(u8, "echo input"),
    });
    state.active_session.?.mcp = runtime;
    runtime_owned = false;

    var ctx = AcpContext{
        .alloc = alloc,
        .state = &state,
        .session_id = "session_1",
    };
    try std.testing.expect(lifecycleDynamicMcpToolAvailable(
        &ctx,
        "mcp_fixture_echo",
        &.{"mcp_fixture_echo"},
    ));
    try std.testing.expect(!lifecycleDynamicMcpToolAvailable(
        &ctx,
        "mcp_fixture_echo",
        &.{},
    ));
    try std.testing.expect(!lifecycleDynamicMcpToolAvailable(
        &ctx,
        "mcp_missing",
        &.{"mcp_missing"},
    ));
}

test "mapToolKind maps common tools" {
    try std.testing.expectEqual(acp_types.ToolCallKind.read, mapToolKind("read_file"));
    try std.testing.expectEqual(acp_types.ToolCallKind.edit, mapToolKind("write_file"));
    try std.testing.expectEqual(acp_types.ToolCallKind.edit, mapToolKind("edit_file"));
    try std.testing.expectEqual(acp_types.ToolCallKind.delete, mapToolKind("delete_file"));
    try std.testing.expectEqual(acp_types.ToolCallKind.move, mapToolKind("rename_file"));
    try std.testing.expectEqual(acp_types.ToolCallKind.search, mapToolKind("grep_files"));
    try std.testing.expectEqual(acp_types.ToolCallKind.execute, mapToolKind("run_command"));
    try std.testing.expectEqual(acp_types.ToolCallKind.other, mapToolKind("unknown_tool"));
}

test "ACP usage checkpoints honor the active session write boundary" {
    const alloc = std.testing.allocator;
    var usage = session_usage.Usage.initFresh();
    defer usage.deinit(alloc);
    var snapshot = try usage.snapshot(alloc);
    defer snapshot.deinit(alloc);

    var active: server.ActiveSessionState = undefined;
    active.session_id = @constCast("session-test");
    active.writable = null;
    active.session_write_mutex = .init;
    var state: server.ServerState = undefined;
    state.active_session = active;
    var ctx = AcpContext{
        .alloc = alloc,
        .state = &state,
        .session_id = "session-test",
    };

    const Worker = struct {
        ctx: *AcpContext,
        snapshot: session_usage.Snapshot,
        started: std.atomic.Value(bool) = .init(false),
        done: std.atomic.Value(bool) = .init(false),
        failure: ?anyerror = null,

        fn run(self: *@This()) void {
            self.started.store(true, .seq_cst);
            persistUsageCheckpoint(
                @ptrCast(self.ctx),
                self.snapshot,
            ) catch |err| {
                self.failure = err;
            };
            self.done.store(true, .seq_cst);
        }
    };
    var worker = Worker{
        .ctx = &ctx,
        .snapshot = snapshot,
    };
    state.active_session.?.session_write_mutex.lockUncancelable(io_mod.getIo());
    const thread = try std.Thread.spawn(.{}, Worker.run, .{&worker});
    while (!worker.started.load(.seq_cst)) std.Thread.yield() catch {};
    for (0..100) |_| std.Thread.yield() catch {};
    const blocked_at_boundary = !worker.done.load(.seq_cst);
    state.active_session.?.session_write_mutex.unlock(io_mod.getIo());
    thread.join();

    try std.testing.expect(blocked_at_boundary);
    try std.testing.expect(worker.done.load(.seq_cst));
    try std.testing.expectEqual(
        error.SessionPersistenceUnavailable,
        worker.failure.?,
    );
}

test "ACP usage checkpoints maintain the profile recovery marker" {
    const alloc = std.testing.allocator;
    const PublicationSink = struct {
        fn publish(_: *anyopaque, _: session_usage.usage_report.ProfileEvent) !void {}
    };

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDir(io_mod.getIo(), "workspace", .default_dir);
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, ".");
    defer alloc.free(home);
    const workspace = try io_mod.dirRealpathAlloc(
        alloc,
        tmp.dir,
        "workspace",
    );
    defer alloc.free(workspace);

    var store = try session_store.Store.initFromHome(alloc, home, workspace);
    var store_owned = true;
    defer if (store_owned) store.deinit(alloc);
    const history = try alloc.alloc(types.HistoryTurn, 0);
    var history_owned = true;
    defer if (history_owned) alloc.free(history);
    var initial = session_codec.DurableSessionState{
        .id = try alloc.dupe(u8, "acp-usage-recovery"),
        .origin_workspace_root = try alloc.dupe(u8, workspace),
        .workspace_root = try alloc.dupe(u8, workspace),
        .created_at_ms = 1000,
        .updated_at_ms = 1000,
        .conversation_language = session_runtime.ConversationLanguage.default(),
        .preferences = .{
            .model = try alloc.dupe(u8, "provider/model"),
            .effort = types.ReasoningEffort.literal("high"),
            .fast_mode = false,
        },
        .history = history,
        .total_input_tokens = 0,
        .total_output_tokens = 0,
    };
    history_owned = false;
    defer initial.deinit(alloc);
    var writable = try store.startWritableSession(alloc, initial);
    var writable_owned = true;
    defer if (writable_owned) writable.deinit(alloc);

    var usage = session_usage.Usage.initFresh();
    defer usage.deinit(alloc);
    const sequence = try usage.reserveInvocation();
    try usage.finishObservedInvocation(
        alloc,
        sequence,
        1,
        .observed_generation,
        "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "https://openrouter.ai/api",
        null,
    );
    var pending = try usage.snapshot(alloc);
    defer pending.deinit(alloc);

    var active: server.ActiveSessionState = undefined;
    active.session_id = writable.active_id;
    active.store = store;
    active.writable = writable;
    active.session_write_mutex = .init;
    var state: server.ServerState = undefined;
    state.active_session = active;
    store_owned = false;
    writable_owned = false;
    defer {
        if (state.active_session) |*session| {
            if (session.writable) |*active_writable| {
                active_writable.deinit(alloc);
            }
            if (session.store) |*active_store| active_store.deinit(alloc);
            state.active_session = null;
        }
    }
    var ctx = AcpContext{
        .alloc = alloc,
        .state = &state,
        .session_id = writable.active_id,
    };

    try persistUsageCheckpoint(@ptrCast(&ctx), pending);
    var marked = try store.listUsageRecoverySessions(alloc);
    defer {
        for (marked.items) |*entry| entry.deinit(alloc);
        marked.deinit(alloc);
    }
    try std.testing.expectEqual(@as(usize, 1), marked.items.len);
    try std.testing.expectEqualStrings(writable.active_id, marked.items[0].id);
    var recovered = try usage_recovery.collectFromHome(alloc, home);
    defer recovered.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 1), recovered.pending.len);
    try std.testing.expectEqualStrings(
        "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        recovered.pending[0].id,
    );

    var publication_context: u8 = 0;
    usage.configurePublicationSink(.{
        .context = &publication_context,
        .allocator = alloc,
        .publish = PublicationSink.publish,
    });
    try usage.applyGeneration(alloc, .{
        .id = "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        .created_at_ms = 1000,
        .model = "provider/model",
        .total_cost = 0.25,
        .input_tokens = 10,
        .output_tokens = 2,
        .cache_read_tokens = 1,
        .cache_write_tokens = 0,
        .reasoning_tokens = 1,
        .billable_web_search_calls = 0,
    });
    var settled = try usage.snapshot(alloc);
    defer settled.deinit(alloc);
    try persistUsageCheckpoint(@ptrCast(&ctx), settled);

    var cleared = try store.listUsageRecoverySessions(alloc);
    defer {
        for (cleared.items) |*entry| entry.deinit(alloc);
        cleared.deinit(alloc);
    }
    try std.testing.expectEqual(@as(usize, 0), cleared.items.len);
    var after_settlement = try usage_recovery.collectFromHome(alloc, home);
    defer after_settlement.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 0), after_settlement.facts.len);
    try std.testing.expectEqual(@as(usize, 0), after_settlement.pending.len);
}

test "parsePromptInput extracts text blocks" {
    const alloc = std.testing.allocator;
    const params = "{\"sessionId\":\"s1\",\"prompt\":[{\"type\":\"text\",\"text\":\"Hello world\"}]}";
    var result = try parsePromptInput(alloc, params);
    defer result.deinit(alloc);
    try std.testing.expectEqualStrings("Hello world", result.text);
}

test "parsePromptInput handles multiple text blocks" {
    const alloc = std.testing.allocator;
    const params = "{\"sessionId\":\"s1\",\"prompt\":[{\"type\":\"text\",\"text\":\"Hello\"},{\"type\":\"text\",\"text\":\"World\"}]}";
    var result = try parsePromptInput(alloc, params);
    defer result.deinit(alloc);
    try std.testing.expectEqualStrings("Hello\nWorld", result.text);
}

test "parsePromptInput returns empty for missing prompt" {
    const alloc = std.testing.allocator;
    var result = try parsePromptInput(alloc, "{\"sessionId\":\"s1\"}");
    defer result.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 0), result.text.len);
}

test "parsePromptInput handles empty prompt array" {
    const alloc = std.testing.allocator;
    var result = try parsePromptInput(alloc, "{\"sessionId\":\"s1\",\"prompt\":[]}");
    defer result.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 0), result.text.len);
}

test "parsePromptInput accepts explicit recovery continuation metadata" {
    const alloc = std.testing.allocator;
    const params =
        "{\"sessionId\":\"s1\",\"prompt\":[],\"_meta\":{\"fx\":{\"continueRecovery\":true}}}";
    var result = try parsePromptInput(alloc, params);
    defer result.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 0), result.text.len);
    try std.testing.expect(result.continue_recovery);
}

test "parsePromptInput rejects image blocks without a local file uri" {
    const alloc = std.testing.allocator;
    const params = "{\"sessionId\":\"s1\",\"prompt\":[{\"type\":\"text\",\"text\":\"Only text\"},{\"type\":\"image\",\"data\":\"aGVsbG8=\",\"mimeType\":\"image/png\"}]}";
    try std.testing.expectError(error.UnsupportedPromptImage, parsePromptInput(alloc, params));
}

test "parsePromptInput carries local image blocks as attachments" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var file = try tmp.dir.createFile(std.testing.io, "shot.png", .{});
    try file.writeStreamingAll(std.testing.io, "\x89PNG\r\n\x1a\nrest");
    file.close(std.testing.io);
    const expected_path = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "shot.png");
    defer alloc.free(expected_path);
    const params = try std.fmt.allocPrint(
        alloc,
        "{{\"sessionId\":\"s1\",\"prompt\":[" ++
            "{{\"type\":\"text\",\"text\":\"look\"}}," ++
            "{{\"type\":\"image\",\"mimeType\":\"image/png\",\"uri\":\"file://{s}\"}}]}}",
        .{expected_path},
    );
    defer alloc.free(params);

    var parsed = try parsePromptInput(alloc, params);
    defer parsed.deinit(alloc);

    try std.testing.expectEqualStrings("look", parsed.text);
    try std.testing.expectEqual(@as(usize, 1), parsed.images.len);
    try std.testing.expectEqualStrings(expected_path, parsed.images[0].path);
    try std.testing.expectEqualStrings("image/png", parsed.images[0].media_type);
}

test "parsePromptInput preserves resource text and accepts only local absolute file targets" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(std.testing.io, "Fx Project/src");
    var file = try tmp.dir.createFile(std.testing.io, "Fx Project/src/main.zig", .{});
    file.close(std.testing.io);
    const root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, ".");
    defer alloc.free(root);
    const expected_path = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "Fx Project/src/main.zig");
    defer alloc.free(expected_path);
    const local_uri = try std.fmt.allocPrint(alloc, "file://{s}/Fx%20Project/src/main.zig", .{root});
    defer alloc.free(local_uri);
    const remote_uri = "https://example.test/reference.txt";
    const params = try std.fmt.allocPrint(
        alloc,
        "{{\"sessionId\":\"s1\",\"prompt\":[" ++
            "{{\"type\":\"resource\",\"resource\":{{\"uri\":\"{s}\",\"text\":\"local body\"}}}}," ++
            "{{\"type\":\"resource\",\"resource\":{{\"uri\":\"{s}\",\"text\":\"remote body\"}}}}]}}",
        .{ local_uri, remote_uri },
    );
    defer alloc.free(params);

    var parsed = try parsePromptInput(alloc, params);
    defer parsed.deinit(alloc);

    const expected_text = try std.fmt.allocPrint(
        alloc,
        "File: {s}\nlocal body\nFile: {s}\nremote body",
        .{ local_uri, remote_uri },
    );
    defer alloc.free(expected_text);
    try std.testing.expectEqualStrings(
        expected_text,
        parsed.text,
    );
    try std.testing.expectEqual(@as(usize, 1), parsed.targets.len);
    try std.testing.expectEqual(context_contract.TargetKind.file, parsed.targets[0].kind);
    try std.testing.expectEqualStrings(expected_path, parsed.targets[0].path);
    try std.testing.expectEqual(@as(usize, 1), parsed.omissions.len);
    try std.testing.expectEqualStrings(remote_uri, parsed.omissions[0].source);
    try std.testing.expectEqual(context_contract.OmissionReason.unsafe_target, parsed.omissions[0].reason);
}

test "parsePromptInput rejects unsafe file URI targeting without losing embedded text" {
    const alloc = std.testing.allocator;
    const uris = [_][]const u8{
        "file://remote.example/tmp/file.txt",
        "file:relative.txt",
        "file:///tmp/../secret.txt",
        "file:///tmp/%00secret.txt",
        "file:///tmp/file.txt?revision=1",
        "file:///tmp/file.txt#fragment",
    };

    for (uris) |uri| {
        const params = try std.fmt.allocPrint(
            alloc,
            "{{\"sessionId\":\"s1\",\"prompt\":[{{\"type\":\"resource\",\"resource\":{{\"uri\":\"{s}\",\"text\":\"embedded text\"}}}}]}}",
            .{uri},
        );
        defer alloc.free(params);

        var parsed = try parsePromptInput(alloc, params);
        defer parsed.deinit(alloc);

        try std.testing.expect(std.mem.endsWith(u8, parsed.text, "embedded text"));
        try std.testing.expectEqual(@as(usize, 0), parsed.targets.len);
        try std.testing.expectEqual(@as(usize, 1), parsed.omissions.len);
        try std.testing.expectEqualStrings(uri, parsed.omissions[0].source);
        try std.testing.expectEqual(context_contract.OmissionReason.unsafe_target, parsed.omissions[0].reason);
    }
}

test "parsePromptInput bounds remote resource omissions with a stable summary" {
    const alloc = std.testing.allocator;
    var params: std.Io.Writer.Allocating = .init(alloc);
    defer params.deinit();
    try params.writer.writeAll("{\"sessionId\":\"s1\",\"prompt\":[{\"type\":\"text\",\"text\":\"hello\"}");
    for (0..128) |index| {
        try params.writer.print(
            ",{{\"type\":\"resource\",\"resource\":{{\"uri\":\"https://example.test/resource/{d}\"}}}}",
            .{index},
        );
    }
    try params.writer.writeAll("]}");

    var parsed = try parsePromptInput(alloc, params.written());
    defer parsed.deinit(alloc);

    try std.testing.expectEqual(context_contract.Limits.project_omission_records, parsed.omissions.len);
    try std.testing.expectEqualStrings("https://example.test/resource/0", parsed.omissions[0].source);
    try std.testing.expect(std.mem.find(u8, parsed.omissions[parsed.omissions.len - 1].source, "/31") != null);
    const summary = parsed.omission_summary orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(@as(usize, 96), summary.omitted_count);
    try std.testing.expectEqual(@as(usize, 96), summary.reason_counts[@intFromEnum(context_contract.OmissionReason.unsafe_target)]);
    const zero_digest = [_]u8{0} ** std.crypto.hash.sha2.Sha256.digest_length;
    try std.testing.expect(!std.mem.eql(u8, &summary.digest, &zero_digest));
}

test "localFileTargetPath canonicalizes a local symlink target" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var file = try tmp.dir.createFile(std.testing.io, "real.txt", .{});
    file.close(std.testing.io);
    try createSymlinkOrSkip(tmp.dir, "real.txt", "alias.txt");

    const root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, ".");
    defer alloc.free(root);
    const alias_path = try std.fs.path.join(alloc, &.{ root, "alias.txt" });
    defer alloc.free(alias_path);
    const expected = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "real.txt");
    defer alloc.free(expected);
    const uri = try std.fmt.allocPrint(alloc, "file://{s}", .{alias_path});
    defer alloc.free(uri);

    const actual = (try localFileTargetPath(alloc, uri)) orelse
        return error.TestExpectedEqual;
    defer alloc.free(actual);
    try std.testing.expectEqualStrings(expected, actual);
}

test "parsePromptInput releases partial resource state across allocation failures" {
    const backing = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var file = try tmp.dir.createFile(std.testing.io, "local.txt", .{});
    file.close(std.testing.io);
    const local_path = try io_mod.dirRealpathAlloc(backing, tmp.dir, "local.txt");
    defer backing.free(local_path);
    const params = try std.fmt.allocPrint(
        backing,
        "{{\"sessionId\":\"s1\",\"prompt\":[" ++
            "{{\"type\":\"resource\",\"resource\":{{\"uri\":\"file://{s}\",\"text\":\"local body\"}}}}," ++
            "{{\"type\":\"resource\",\"resource\":{{\"uri\":\"https://example.test/reference.txt\",\"text\":\"remote body\"}}}}]}}",
        .{local_path},
    );
    defer backing.free(params);

    var probe = std.testing.FailingAllocator.init(backing, .{});
    var parsed = try parsePromptInput(probe.allocator(), params);
    parsed.deinit(probe.allocator());
    try std.testing.expectEqual(probe.allocated_bytes, probe.freed_bytes);

    for (0..probe.alloc_index) |fail_index| {
        var failing = std.testing.FailingAllocator.init(backing, .{ .fail_index = fail_index });
        if (parsePromptInput(failing.allocator(), params)) |input| {
            var owned = input;
            owned.deinit(failing.allocator());
        } else |err| switch (err) {
            error.OutOfMemory => {},
            else => return err,
        }
        try std.testing.expect(failing.has_induced_failure);
        try std.testing.expectEqual(failing.allocated_bytes, failing.freed_bytes);
    }
}

test "mapToolKind maps all file tools" {
    try std.testing.expectEqual(acp_types.ToolCallKind.read, mapToolKind("list_files"));
    try std.testing.expectEqual(acp_types.ToolCallKind.read, mapToolKind("glob_files"));
    try std.testing.expectEqual(acp_types.ToolCallKind.read, mapToolKind("file_info"));
    try std.testing.expectEqual(acp_types.ToolCallKind.search, mapToolKind("semantic_search"));
    try std.testing.expectEqual(acp_types.ToolCallKind.move, mapToolKind("copy_file"));
    try std.testing.expectEqual(acp_types.ToolCallKind.edit, mapToolKind("create_folder"));
    try std.testing.expectEqual(acp_types.ToolCallKind.other, mapToolKind("memory"));
    try std.testing.expectEqual(acp_types.ToolCallKind.other, mapToolKind("skill"));
    try std.testing.expectEqual(acp_types.ToolCallKind.other, mapToolKind("install_skill"));
}

test "ACP permission arguments are validated and reserialized before emission" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    try writeValidatedToolArguments(alloc, &out.writer, " { \"path\" : \"README.md\" } ");
    try std.testing.expectEqualStrings("{\"path\":\"README.md\"}", out.written());

    var malformed: std.Io.Writer.Allocating = .init(alloc);
    defer malformed.deinit();
    try std.testing.expectError(
        error.InvalidToolArgumentsJson,
        writeValidatedToolArguments(alloc, &malformed.writer, "{\"path\":}"),
    );
    try std.testing.expectEqual(@as(usize, 0), malformed.written().len);
}

test "acp exposes web_search progress updates" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();

    try writeWebSearchProgressUpdate(alloc, &out.writer, "call_search", .{ .results_received = .{
        .query = "current news",
        .result_count = 4,
    } });

    try std.testing.expect(std.mem.find(u8, out.written(), "\"toolCallId\":\"call_search\"") != null);
    try std.testing.expect(std.mem.find(u8, out.written(), "\"status\":\"in_progress\"") != null);
    try std.testing.expect(std.mem.find(u8, out.written(), "Found 4 results for current news") != null);
    try std.testing.expectEqual(acp_types.ToolCallKind.search, mapToolKind("web_search"));
}

test "ACP tool notifications preserve UTF-8 for clipped and unsafe output" {
    const alloc = std.testing.allocator;
    var model_output: [202]u8 = undefined;
    @memset(model_output[0..199], 'x');
    model_output[199] = 0xc3;
    model_output[200] = 0xa9;
    model_output[201] = 'z';

    const preview = toolUpdateContentText(.{
        .status = .failure,
        .model_output = model_output[0..],
    });
    try std.testing.expectEqual(@as(usize, 199), preview.len);
    try std.testing.expect(std.unicode.utf8ValidateSlice(preview));

    const unsafe_preview = toolUpdateContentText(.{
        .status = .success,
        .model_output = "command output: \xff",
    });
    try std.testing.expectEqualStrings(
        "binary or non-utf8 tool output omitted",
        unsafe_preview,
    );
    try std.testing.expect(std.unicode.utf8ValidateSlice(unsafe_preview));

    for ([_][]const u8{ preview, unsafe_preview }, 0..) |content, index| {
        var update: std.Io.Writer.Allocating = .init(alloc);
        defer update.deinit();
        try acp_types.writeToolCallUpdate(
            &update.writer,
            if (index == 0) "call_clipped" else "call_unsafe",
            if (index == 0) .failed else .completed,
            content,
        );

        var params: std.Io.Writer.Allocating = .init(alloc);
        defer params.deinit();
        try acp_types.writeSessionUpdate(
            &params.writer,
            "session_1",
            update.written(),
        );

        var notification: std.Io.Writer.Allocating = .init(alloc);
        defer notification.deinit();
        try notification.writer.writeAll(
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":",
        );
        try notification.writer.writeAll(params.written());
        try notification.writer.writeByte('}');

        try std.testing.expect(std.unicode.utf8ValidateSlice(notification.written()));
        var parsed = try std.json.parseFromSlice(
            std.json.Value,
            alloc,
            notification.written(),
            .{},
        );
        defer parsed.deinit();
    }
}

test "ACP stream adapter strips ANSI from agent chunks and suppresses writer failure" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const alloc = arena_state.allocator();
    const spans = [_][]const u8{
        "\x1b[1mbold\x1b[22m and \x1b[3mitalic\x1b[23m\n",
        "\x1b]8;id=fx-1;https://example.com\x1b\\docs\x1b]8;;\x1b\\\n",
        "\x1b[2m\xe2\x94\x82 \x1b[22mconst x = **literal**;\n",
    };
    const expected_spans = [_][]const u8{
        "bold and italic\n",
        "[docs](https://example.com)\n",
        "\xe2\x94\x82 const x = **literal**;\n",
    };
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var capture = try tmp.dir.createFile(
        io_mod.getIo(),
        "acp-stream.jsonl",
        .{ .read = true },
    );
    defer capture.close(io_mod.getIo());
    {
        var state = try initTestAcpState(alloc, "/tmp/workspace", .ask);
        defer state.deinit();
        state.writer = .{ .stdout = capture };
        var ctx = AcpContext{
            .alloc = alloc,
            .state = &state,
            .session_id = "session_1",
        };
        const deps = agentRuntimeDeps(&ctx);

        // `operational` is the styled path that still reaches the client now that
        // the assistant's own text is forwarded as unrendered source.
        for (spans) |span| try deps.push_text(deps.ctx, .{ .operational = span });
        try deps.push_text(deps.ctx, .{ .operational = "" });
        try capture.sync(io_mod.getIo());
    }

    var captured_file = try tmp.dir.openFile(io_mod.getIo(), "acp-stream.jsonl", .{});
    defer captured_file.close(io_mod.getIo());
    const captured = try io_mod.readFileToEnd(alloc, &captured_file, 64 * 1024);
    defer alloc.free(captured);

    var notifications = std.mem.splitScalar(u8, captured, '\n');
    var notification_count: usize = 0;
    while (notifications.next()) |line| {
        if (line.len == 0) continue;

        var parsed = try std.json.parseFromSlice(std.json.Value, alloc, line, .{});
        defer parsed.deinit();

        try std.testing.expectEqualStrings("session/update", parsed.value.object.get("method").?.string);
        const params = parsed.value.object.get("params").?.object;
        try std.testing.expectEqualStrings("session_1", params.get("sessionId").?.string);
        const update = params.get("update").?.object;
        try std.testing.expectEqualStrings("agent_message_chunk", update.get("sessionUpdate").?.string);
        const content = update.get("content").?.object;
        try std.testing.expectEqualStrings("text", content.get("type").?.string);
        try std.testing.expectEqualStrings(expected_spans[notification_count], content.get("text").?.string);
        try std.testing.expect(std.mem.find(u8, content.get("text").?.string, "\x1b") == null);

        notification_count += 1;
    }
    try std.testing.expectEqual(spans.len, notification_count);

    var failed_output = try tmp.dir.createFile(io_mod.getIo(), "acp-stream-failure.jsonl", .{});
    failed_output.close(io_mod.getIo());
    var failed_state = try initTestAcpState(alloc, "/tmp/workspace", .ask);
    defer failed_state.deinit();
    failed_state.writer = .{ .stdout = failed_output };
    var failed_ctx = AcpContext{
        .alloc = alloc,
        .state = &failed_state,
        .session_id = "session_1",
    };

    var writer_failed = false;
    failed_ctx.sendAgentText("writer failure probe") catch {
        writer_failed = true;
    };
    try std.testing.expect(writer_failed);

    const failed_deps = agentRuntimeDeps(&failed_ctx);
    try failed_deps.push_text(failed_deps.ctx, .{ .operational = "writer failure remains suppressed" });
}

test "ACP auth failure emits a valid detail-free JSON-RPC notification" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var capture = try tmp.dir.createFile(io_mod.getIo(), "acp-auth-failure.jsonl", .{ .read = true });
    defer capture.close(io_mod.getIo());
    var state = try initTestAcpState(alloc, "/tmp/workspace", .ask);
    defer state.deinit();
    state.writer = .{ .stdout = capture };
    state.active_session.?.credential_source = .emma_provider_api_key;
    var ctx = AcpContext{
        .alloc = alloc,
        .state = &state,
        .session_id = "session_1",
    };
    try std.testing.expectEqual(
        types.CredentialSource.emma_provider_api_key,
        ctx.toolContext().credential_source.?,
    );

    const deps = agentRuntimeDeps(&ctx);
    try deps.push_http_error(
        deps.ctx,
        .unauthorized,
        "provider rejected access-token-secret",
        state.active_session.?.credential_source,
    );
    try capture.sync(io_mod.getIo());

    var captured_file = try tmp.dir.openFile(io_mod.getIo(), "acp-auth-failure.jsonl", .{});
    defer captured_file.close(io_mod.getIo());
    const captured = try io_mod.readFileToEnd(alloc, &captured_file, 16 * 1024);
    defer alloc.free(captured);
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, captured, .{});
    defer parsed.deinit();

    try std.testing.expectEqualStrings("2.0", parsed.value.object.get("jsonrpc").?.string);
    try std.testing.expectEqualStrings("session/update", parsed.value.object.get("method").?.string);
    const update = parsed.value.object.get("params").?.object.get("update").?.object;
    const content = update.get("content").?.object;
    try std.testing.expectEqualStrings(
        credentials.api_key_env ++ " authentication failed · HTTP 401",
        content.get("text").?.string,
    );
    try std.testing.expect(std.mem.find(u8, captured, "access-token-secret") == null);
    try std.testing.expect(std.mem.find(u8, captured, "provider rejected") == null);
    try std.testing.expect(std.mem.find(u8, captured, "\x1b") == null);
}

test "ACP tool updates preserve typed permission failures without truncation" {
    const alloc = std.testing.allocator;
    const payload = try tool_result_errors.toolPermissionDeniedJson(alloc, "run_command", .permission_required);
    defer alloc.free(payload);

    const output_text = toolUpdateContentText(.{
        .status = .failure,
        .model_output = payload,
    });

    try std.testing.expectEqualStrings(payload, output_text);
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, output_text, .{});
    defer parsed.deinit();
    const error_obj = parsed.value.object.get("error").?.object;
    try std.testing.expectEqualStrings("tool_permission_denied", error_obj.get("type").?.string);
    try std.testing.expectEqualStrings("run_command", error_obj.get("tool_name").?.string);
    try std.testing.expectEqualStrings("permission_required", error_obj.get("reason").?.string);
    try std.testing.expect(error_obj.get("denied").?.bool);
}

test "ACP plan mode validates registered tools against mode policy" {
    const alloc = std.testing.allocator;
    var state = try initTestAcpState(alloc, "/tmp/fx-acp-plan-mode", .ask);
    defer state.deinit();
    state.active_session.?.mode = "plan";
    var ctx = AcpContext{
        .alloc = alloc,
        .state = &state,
        .session_id = state.active_session.?.session_id,
    };

    const allowed = try validateToolCall(&ctx, alloc, .{
        .id = "call_read",
        .name = "read_file",
        .arguments_json = "{\"path\":\"README.md\"}",
    });
    switch (allowed) {
        .valid => {},
        else => return error.TestExpectedEqual,
    }

    const denied = try validateToolCall(&ctx, alloc, .{
        .id = "call_write",
        .name = "write_file",
        .arguments_json = "{}",
    });
    switch (denied) {
        .failure => |body| {
            defer alloc.free(body);
            try std.testing.expect(std.mem.find(u8, body, "\"tool_name\":\"write_file\"") != null);
            try std.testing.expect(std.mem.find(u8, body, "Plan mode only allows read-only workspace inspection tools.") != null);
        },
        else => return error.TestExpectedEqual,
    }
}

const AcpContextRegistryFixture = struct {
    var gather_calls: usize = 0;
    var gather_error: ?context_contract.ProviderError = null;
    var static_context: ?[]const u8 = null;
    var transient_calls: usize = 0;
    var transient_permission_mode: ?PermissionMode = null;
    var transient_sandbox_backend: sandbox.BackendKind = .none;

    fn reset() void {
        gather_calls = 0;
        gather_error = null;
        static_context = null;
        transient_calls = 0;
        transient_permission_mode = null;
        transient_sandbox_backend = .none;
    }

    fn gather(alloc: Allocator, _: context_contract.InitialContextInput) context_contract.ProviderError!context_contract.ProviderContext {
        gather_calls += 1;
        if (gather_error) |err| return err;
        return .{ .content = try std.fmt.allocPrint(alloc, "ACP registry context {d}", .{gather_calls}) };
    }

    fn appendStatic(input: context_contract.StaticContextInput, alloc: Allocator, messages: *std.ArrayList(ChatMessage)) context_contract.ProviderError!void {
        static_context = input.project_context;
        try messages.append(alloc, .{ .role = .system, .content = input.project_context });
    }

    fn appendTransient(input: context_contract.TransientContextInput, alloc: Allocator, messages: *std.ArrayList(ChatMessage)) context_contract.ProviderError!void {
        transient_calls += 1;
        transient_permission_mode = input.permission_mode;
        transient_sandbox_backend = input.sandbox_backend;
        try messages.append(alloc, .{ .role = .system, .content = "ACP registry transient" });
    }
};

const test_acp_context_registry = context_contract.Registry{ .default_provider = .{
    .id = "test.acp_context",
    .gather_project_context_fn = AcpContextRegistryFixture.gather,
    .select_applicable_project_context_fn = context_contract.selectNoApplicableProjectContext,
    .append_static_fn = AcpContextRegistryFixture.appendStatic,
    .append_transient_fn = AcpContextRegistryFixture.appendTransient,
} };

const test_acp_modes = [_]mode_registry.ModeSpec{
    .{ .id = "normal", .name = "Normal" },
    .{
        .id = "plan",
        .name = "Plan",
        .permission_mode = .ask,
        .tool_policy = .read_only,
        .tool_policy_denial_message = "Plan mode only allows read-only workspace inspection tools.",
    },
};

const test_acp_mode_registry = mode_registry.Registry{
    .default_mode_id = "normal",
    .modes = test_acp_modes[0..],
};

fn testModelPromptOverlay(model: []const u8) ?[]const u8 {
    return if (std.mem.eql(u8, model, "test-model")) "ACP test model overlay" else null;
}

fn testServerConfig() server.Config {
    return .{
        .default_model = "test-model",
        .default_agent_step_limit = 4,
        .gateway_retry_count = 0,
        .gateway_chat_url = "http://127.0.0.1",
        .gateway_models_path = "/models",
        .gateway_provider = test_builtin_gateway.provider,
        .prompt_policy = .{
            .system_prompt = "test",
            .model_prompt_overlay_fn = testModelPromptOverlay,
        },
        .ignored_list_entries = &.{},
        .max_list_entries = 32,
        .max_read_file_bytes = 1024 * 1024,
        .max_read_file_lines = 1000,
        .max_read_file_line_len = 4096,
        .max_command_output_bytes = 1024 * 1024,
        .max_tool_result_bytes = 1024 * 1024,
        .max_history_turns = 8,
        .context_registry = test_acp_context_registry,
        .mode_registry = test_acp_mode_registry,
    };
}

fn initTestAcpState(alloc: Allocator, workspace_root: []const u8, mode: PermissionMode) !server.ServerState {
    const owned_workspace = try alloc.dupe(u8, workspace_root);
    errdefer alloc.free(owned_workspace);
    const session_id = try alloc.dupe(u8, "session_1");
    errdefer alloc.free(session_id);
    const model = try alloc.dupe(u8, "test-model");
    errdefer alloc.free(model);
    const api_key = try alloc.dupe(u8, "test-api-key");
    errdefer alloc.free(api_key);

    const selected_backend: sandbox.BackendKind = .none;
    const cfg = testServerConfig();
    return .{
        .alloc = alloc,
        .cfg = cfg,
        .writer = jsonrpc.Writer.init(),
        .workspace_root = owned_workspace,
        .api_key = api_key,
        .credential_source = .emma_provider_api_key,
        .sandbox_backend = selected_backend,
        .web_search_runtime = @import("../core/tooling/web_search_runtime.zig").Runtime.init(.{
            .provider = cfg.gateway_provider.web_search,
        }),
        .active_session = .{
            .session_id = session_id,
            .model = model,
            .mode = "normal",
            .workspace_root = owned_workspace,
            .api_key = api_key,
            .credential_source = .emma_provider_api_key,
            .agent_step_limit = 4,
            .max_tool_result_bytes = 1024 * 1024,
            .fast_mode = false,
            .effort = .auto,
            .first_call_tool_choice = .auto,
            .permission_mode = mode,
            .sandbox_backend = selected_backend,
            .permission_rules = .{},
            .session_rt = .{ .max_history_turns = 8 },
            .cancel_flag = std.atomic.Value(bool).init(false),
            .pending_prompt_id = null,
        },
    };
}

test "stripAnsiAlloc returns the original slice for clean text and strips escapes" {
    const alloc = std.testing.allocator;
    const clean = "plain **markdown** text\n";
    const untouched = try stripAnsiAlloc(alloc, clean);
    try std.testing.expect(untouched.ptr == clean.ptr);

    const stripped = try stripAnsiAlloc(alloc, "\x1b[31mred\x1b[0m and \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\");
    defer alloc.free(stripped);
    try std.testing.expectEqualStrings("red and [link](https://example.com)", stripped);
    try std.testing.expect(std.mem.find(u8, stripped, "\x1b") == null);
}

test "stripAnsiAlloc converts OSC-8 hyperlinks with params and BEL terminators" {
    const alloc = std.testing.allocator;
    const with_params = try stripAnsiAlloc(alloc, "\x1b]8;id=fx-1;https://ziglang.org/download/\x1b\\Zig downloads\x1b]8;;\x1b\\ ready");
    defer alloc.free(with_params);
    try std.testing.expectEqualStrings("[Zig downloads](https://ziglang.org/download/) ready", with_params);

    const bel_terminated = try stripAnsiAlloc(alloc, "\x1b]8;;https://example.com\x07docs\x1b]8;;\x07");
    defer alloc.free(bel_terminated);
    try std.testing.expectEqualStrings("[docs](https://example.com)", bel_terminated);

    const unterminated = try stripAnsiAlloc(alloc, "\x1b]8;;https://example.com\x1b\\split chunk");
    defer alloc.free(unterminated);
    try std.testing.expectEqualStrings("[split chunk](https://example.com)", unterminated);
}

test "ACP pending tool_call updates keep provider ids stable and dedupe" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const alloc = arena_state.allocator();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var capture = try tmp.dir.createFile(io_mod.getIo(), "acp-tool-call.jsonl", .{ .read = true });
    defer capture.close(io_mod.getIo());
    var state = try initTestAcpState(alloc, "/tmp/workspace", .ask);
    defer state.deinit();
    state.writer = .{ .stdout = capture };
    var ctx = AcpContext{
        .alloc = alloc,
        .state = &state,
        .session_id = "session_1",
    };
    defer ctx.deinitPublishedToolCalls();

    const call = ToolCall{
        .id = "provider_call_7",
        .name = "terminal",
        .arguments_json = "{\"action\":\"exec\",\"command\":\"ls\"}",
    };
    const first = try ctx.sendToolCallPending(alloc, call);
    const second = try ctx.sendToolCallPending(alloc, call);
    try std.testing.expectEqualStrings("provider_call_7", first);
    try std.testing.expect(first.ptr == second.ptr);
    try capture.sync(io_mod.getIo());

    var captured_file = try tmp.dir.openFile(io_mod.getIo(), "acp-tool-call.jsonl", .{});
    defer captured_file.close(io_mod.getIo());
    const captured = try io_mod.readFileToEnd(alloc, &captured_file, 64 * 1024);
    var lines = std.mem.splitScalar(u8, captured, '\n');
    var pending_count: usize = 0;
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        try std.testing.expect(std.mem.find(u8, line, "\"toolCallId\":\"provider_call_7\"") != null);
        try std.testing.expect(std.mem.find(u8, line, "\"sessionUpdate\":\"tool_call\"") != null);
        pending_count += 1;
    }
    try std.testing.expectEqual(@as(usize, 1), pending_count);
}

test "ACP defers cancelled sandbox retry to one combined failed update" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const alloc = arena_state.allocator();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var capture = try tmp.dir.createFile(io_mod.getIo(), "acp-retry-cancel.jsonl", .{ .read = true });
    defer capture.close(io_mod.getIo());
    var state = try initTestAcpState(alloc, "/tmp/workspace", .ask);
    defer state.deinit();
    state.writer = .{ .stdout = capture };
    var ctx = AcpContext{
        .alloc = alloc,
        .state = &state,
        .session_id = "session_1",
    };
    defer ctx.deinitPublishedToolCalls();

    const call = ToolCall{
        .id = "retry_call",
        .name = "terminal",
        .arguments_json = "{\"action\":\"exec\",\"command\":\"npm test\"}",
    };
    const acp_id = try ctx.sendToolCallPending(alloc, call);
    const request: agent_runtime.ToolExecutionRequest = .{
        .call_allocator = alloc,
        .result_allocator = alloc,
        .call = call,
        .authority = .{ .run_command = .{ .shell_allowed = .{
            .fingerprint = .{
                .command = "npm test",
                .resolved_cwd = "/tmp/workspace",
                .background = false,
                .resolved_backend = .none,
                .target_os = std_builtin.os.tag,
                .scope = .broader,
            },
            .source = .auto_classifier,
        } } },
        .session_grants = &.{},
        .advertised_dynamic_tool_names = &.{},
        .max_tool_result_bytes = 64 * 1024,
    };
    sendAuthorizedToolCallError(
        &ctx,
        request,
        acp_id,
        error.CancelledBeforeExecution,
        "raw retry pre-spawn cancellation",
    );
    sendAuthorizedToolCallError(
        &ctx,
        request,
        acp_id,
        error.Cancelled,
        "raw retry error cancellation",
    );
    _ = completeAuthorizedToolCallTransport(&ctx, request, acp_id, .{
        .status = .failure,
        .cancelled = true,
        .model_output = "raw retry cancellation",
        .command_result_json = "{\"attempt\":\"broader\"}",
    });
    try recordToolCallRejected(
        @ptrCast(&ctx),
        alloc,
        call,
        "combined restricted and broader evidence",
        "{\"attempt\":\"broader\",\"retained\":true}",
    );
    try capture.sync(io_mod.getIo());

    {
        var captured_file = try tmp.dir.openFile(io_mod.getIo(), "acp-retry-cancel.jsonl", .{});
        defer captured_file.close(io_mod.getIo());
        const captured = try io_mod.readFileToEnd(alloc, &captured_file, 64 * 1024);
        try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, captured, "\"status\":\"failed\""));
        try std.testing.expect(std.mem.find(u8, captured, "raw retry pre-spawn cancellation") == null);
        try std.testing.expect(std.mem.find(u8, captured, "raw retry error cancellation") == null);
        try std.testing.expect(std.mem.find(u8, captured, "raw retry cancellation") == null);
        try std.testing.expect(std.mem.find(u8, captured, "combined restricted and broader evidence") != null);
        try std.testing.expect(std.mem.find(u8, captured, "\"retained\":true") != null);
    }

    const ordinary_call = ToolCall{
        .id = "ordinary_call",
        .name = "terminal",
        .arguments_json = "{\"action\":\"exec\",\"command\":\"npm test\"}",
    };
    const ordinary_acp_id = try ctx.sendToolCallPending(alloc, ordinary_call);
    var ordinary_request = request;
    ordinary_request.call = ordinary_call;
    ordinary_request.authority = .ordinary;
    sendAuthorizedToolCallError(
        &ctx,
        ordinary_request,
        ordinary_acp_id,
        error.Cancelled,
        "ordinary error cancellation",
    );
    try capture.sync(io_mod.getIo());
    {
        var captured_file = try tmp.dir.openFile(io_mod.getIo(), "acp-retry-cancel.jsonl", .{});
        defer captured_file.close(io_mod.getIo());
        const captured = try io_mod.readFileToEnd(alloc, &captured_file, 64 * 1024);
        try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, captured, "\"status\":\"failed\""));
        try std.testing.expect(std.mem.find(u8, captured, "ordinary error cancellation") != null);
    }
}

test "ACP propagateGrant stores deduped runtime session grants" {
    const alloc = std.testing.allocator;
    var state = try initTestAcpState(alloc, "/tmp/workspace", .ask);
    defer state.deinit();
    var ctx = AcpContext{
        .alloc = alloc,
        .state = &state,
        .session_id = "session_1",
    };

    try retainAcpGrant(&ctx, "run_command", "git status*");
    try retainAcpGrant(&ctx, "run_command", "git status*");
    try retainAcpGrant(&ctx, "write_file", "/tmp/workspace/**");

    const session = &state.active_session.?;
    try std.testing.expectEqual(@as(usize, 2), session.session_grants.len);
    try std.testing.expectEqualStrings("run_command", session.session_grants[0].tool_name);
    try std.testing.expectEqualStrings("git status*", session.session_grants[0].target_path);
    try std.testing.expectEqualStrings("write_file", session.session_grants[1].tool_name);

    const tool_ctx = ctx.toolContext();
    try std.testing.expectEqual(session.session_grants.len, tool_ctx.permission_grants.len);
    try std.testing.expect(tool_ctx.permission_grants.ptr == session.session_grants.ptr);
}

test "ACP refreshes typed registry context and propagates enabled gathering errors" {
    const alloc = std.testing.allocator;
    AcpContextRegistryFixture.reset();

    var state = try initTestAcpState(alloc, "/tmp/workspace", .ask);
    defer state.deinit();

    try refreshProjectContext(&state, alloc, &.{}, &.{}, null);
    try std.testing.expectEqual(@as(usize, 1), AcpContextRegistryFixture.gather_calls);
    var contribution = state.context_snapshot.contribution orelse return error.TestExpectedEqual;
    try std.testing.expectEqualStrings("test.acp_context", contribution.provider_id);
    try std.testing.expectEqualStrings("ACP registry context 1", contribution.content);

    try refreshProjectContext(&state, alloc, &.{}, &.{}, null);
    try std.testing.expectEqual(@as(usize, 2), AcpContextRegistryFixture.gather_calls);
    contribution = state.context_snapshot.contribution orelse return error.TestExpectedEqual;
    try std.testing.expectEqualStrings("ACP registry context 2", contribution.content);

    state.context_enabled = false;
    try refreshProjectContext(&state, alloc, &.{}, &.{}, null);
    try std.testing.expectEqual(@as(usize, 2), AcpContextRegistryFixture.gather_calls);
    try std.testing.expect(state.context_snapshot.contribution == null);

    state.context_enabled = true;
    AcpContextRegistryFixture.gather_error = error.WriteFailed;
    try std.testing.expectError(
        error.WriteFailed,
        refreshProjectContext(&state, alloc, &.{}, &.{}, null),
    );
    try std.testing.expectEqual(@as(usize, 3), AcpContextRegistryFixture.gather_calls);
    try std.testing.expect(state.context_snapshot.contribution == null);
}

test "ACP prompt propagates context provider errors before pending prompt state" {
    const alloc = std.testing.allocator;
    var state = try initTestAcpState(alloc, "/tmp/workspace", .ask);
    defer state.deinit();
    var msg = jsonrpc.Message{
        .id = .{ .integer = 7 },
        .method = "session/prompt",
        .params_raw = "{\"sessionId\":\"session_1\",\"prompt\":[{\"type\":\"text\",\"text\":\"hello\"}]}",
    };
    const errors = [_]context_contract.ProviderError{
        error.OutOfMemory,
        error.NoSpaceLeft,
        error.WriteFailed,
    };

    for (errors) |expected_error| {
        AcpContextRegistryFixture.reset();
        AcpContextRegistryFixture.gather_error = expected_error;
        try std.testing.expectError(
            expected_error,
            handlePrompt(&state, alloc, &msg, "code", .ask, .none),
        );
        try std.testing.expectEqual(@as(usize, 1), AcpContextRegistryFixture.gather_calls);
        try std.testing.expect(state.active_session.?.pending_prompt_id == null);
        try std.testing.expect(state.context_snapshot.contribution == null);
    }
}

test "ACP registry callbacks preserve snapshot bytes before transient context" {
    const alloc = std.testing.allocator;
    AcpContextRegistryFixture.reset();

    var state = try initTestAcpState(alloc, "/tmp/workspace", .ask);
    defer state.deinit();
    try refreshProjectContext(&state, alloc, &.{}, &.{}, null);

    var ctx = AcpContext{
        .alloc = alloc,
        .state = &state,
        .session_id = state.active_session.?.session_id,
        .captured_permission_mode = .auto,
        .captured_sandbox_backend = .macos,
    };
    state.active_session.?.permission_mode = .ask;
    state.active_session.?.sandbox_backend = .none;
    const deps = agentRuntimeDeps(&ctx);
    try std.testing.expect(deps.context_enabled);
    try std.testing.expectEqualStrings(
        "test.acp_context",
        deps.context_registry.?.defaultProvider().id,
    );
    try std.testing.expect(deps.request_prepared_file_mutation_permission != null);
    try std.testing.expect(deps.prepare_parent_turn_context != null);
    try std.testing.expect(deps.acknowledge_parent_turn_context != null);

    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var messages: std.ArrayList(ChatMessage) = .empty;
    defer messages.deinit(arena);
    try messages.append(arena, .{ .role = .system, .content = "base system" });

    try deps.append_static_context.?(deps.ctx, arena, &messages);
    try deps.append_runtime_context(deps.ctx, arena, &messages);

    try std.testing.expectEqual(@as(usize, 4), messages.items.len);
    try std.testing.expectEqualStrings("base system", messages.items[0].content.?);
    try std.testing.expectEqualStrings("ACP registry context 1", messages.items[1].content.?);
    try std.testing.expect(std.mem.find(u8, messages.items[2].content.?, "<mcp_servers>") != null);
    try std.testing.expectEqualStrings("ACP registry transient", messages.items[3].content.?);
    try std.testing.expectEqualStrings("ACP registry context 1", AcpContextRegistryFixture.static_context.?);
    try std.testing.expectEqual(@as(usize, 1), AcpContextRegistryFixture.transient_calls);
    try std.testing.expectEqual(
        PermissionMode.auto,
        AcpContextRegistryFixture.transient_permission_mode orelse return error.TestExpectedEqual,
    );
    try std.testing.expectEqual(sandbox.BackendKind.macos, AcpContextRegistryFixture.transient_sandbox_backend);

    const tool_context = ctx.toolContext();
    try std.testing.expectEqual(PermissionMode.auto, tool_context.permission_mode);
    try std.testing.expectEqual(sandbox.BackendKind.macos, tool_context.sandbox_backend);
    try std.testing.expectEqualStrings("test.acp_context", tool_context.context_registry.defaultProvider().id);

    state.context_enabled = false;
    try std.testing.expectEqualStrings("", ctx.modelVisibleProjectContext());
    try std.testing.expect(!ctx.toolContext().context_enabled);
    try std.testing.expect(!agentRuntimeDeps(&ctx).context_enabled);
}

fn testPermissionRuleSet(alloc: Allocator, permission: []const u8, pattern: []const u8, action: types.PermissionAction) !types.PermissionRuleSet {
    var rules = types.PermissionRuleSet{
        .rules = try alloc.alloc(types.PermissionRule, 1),
    };
    errdefer alloc.free(rules.rules);

    const owned_permission = try alloc.dupe(u8, permission);
    errdefer alloc.free(owned_permission);

    const owned_pattern = try alloc.dupe(u8, pattern);
    rules.rules[0] = .{
        .permission = owned_permission,
        .pattern = owned_pattern,
        .action = action,
    };
    return rules;
}

fn writeArgsJson(alloc: Allocator, path: []const u8, content: []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.writeAll("{\"path\":");
    try std.json.Stringify.value(path, .{}, &out.writer);
    try out.writer.writeAll(",\"content\":");
    try std.json.Stringify.value(content, .{}, &out.writer);
    try out.writer.writeByte('}');
    return try out.toOwnedSlice();
}

fn semanticSearchArgsJson(alloc: Allocator, query: []const u8, path: []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.writeAll("{\"query\":");
    try std.json.Stringify.value(query, .{}, &out.writer);
    try out.writer.writeAll(",\"path\":");
    try std.json.Stringify.value(path, .{}, &out.writer);
    try out.writer.writeByte('}');
    return try out.toOwnedSlice();
}

fn createSymlinkOrSkip(dir: std.Io.Dir, target_path: []const u8, link_path: []const u8) !void {
    if (comptime @import("builtin").os.tag == .windows) return error.SkipZigTest;
    dir.symLink(std.testing.io, target_path, link_path, .{ .is_directory = false }) catch |err| {
        if (err == error.AccessDenied or std.mem.eql(u8, @errorName(err), "Permission" ++ "Denied")) {
            return error.SkipZigTest;
        }
        return err;
    };
}

test "ACP deps validate malformed registered calls" {
    const alloc = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var state = try initTestAcpState(alloc, "/tmp/workspace", .ask);
    defer state.deinit();
    var ctx = AcpContext{ .alloc = alloc, .state = &state, .session_id = "session_1" };

    const deps = agentRuntimeDeps(&ctx);
    try deps.finalize_turn(deps.ctx, 8, .completed, null);
    const validate = deps.validate_tool_call orelse return error.TestExpectedEqual;
    const result = try validate(deps.ctx, arena, .{
        .id = "fetch",
        .name = "web_fetch",
        .arguments_json = "{\"url\":1}",
    });
    try std.testing.expectEqualStrings("web_fetch field \"url\" must be a string", result.failure);
}

test "ACP finalization maps failed turns and provider length" {
    const cases = [_]struct {
        outcome: types.TurnPresentationOutcome,
        disposition: ?types.ProviderCompletionDisposition,
        expected: acp_types.StopReason,
    }{
        .{ .outcome = .completed, .disposition = .length_limited, .expected = .max_output_tokens },
        .{ .outcome = .failed, .disposition = .length_limited, .expected = .max_output_tokens },
        .{ .outcome = .failed, .disposition = null, .expected = .refused },
    };

    for (cases) |case| {
        const alloc = std.testing.allocator;
        var state = try initTestAcpState(alloc, "/tmp/workspace", .ask);
        defer state.deinit();
        var ctx = AcpContext{ .alloc = alloc, .state = &state, .session_id = "session_1" };
        const deps = agentRuntimeDeps(&ctx);

        try deps.finalize_turn(deps.ctx, 8, case.outcome, case.disposition);

        try std.testing.expectEqual(case.expected, ctx.stop_reason);
    }
}

test "ACP default user commands require configured authority or review" {
    const alloc = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var state = try initTestAcpState(alloc, "/tmp/workspace", .ask);
    defer state.deinit();
    var ctx = AcpContext{ .alloc = alloc, .state = &state, .session_id = "session_1" };

    const direct = (try requestToolPermissionOutcome(&ctx, arena, .{
        .id = "direct",
        .name = "terminal",
        .arguments_json = "{\"action\":\"exec\",\"command\":\"pwd\"}",
    }, .ask, &.{}, &.{}));
    try std.testing.expectEqual(ToolPermissionDecision.permission_required, direct.decision);
    try std.testing.expect(direct.execution_authority == null);

    const blocked = (try requestToolPermissionOutcome(&ctx, arena, .{
        .id = "blocked",
        .name = "terminal",
        .arguments_json = "{\"action\":\"exec\",\"command\":\"touch blocked.txt\"}",
    }, .ask, &.{}, &.{}));
    try std.testing.expectEqual(ToolPermissionDecision.permission_required, blocked.decision);
    try std.testing.expect(blocked.execution_authority == null);

    state.active_session.?.permission_rules = try testPermissionRuleSet(alloc, "bash", "touch *", .allow);
    const configured = (try requestToolPermissionOutcome(&ctx, arena, .{
        .id = "configured",
        .name = "terminal",
        .arguments_json = "{\"action\":\"exec\",\"command\":\"touch configured.txt\"}",
    }, .ask, &.{}, &.{}));
    switch ((configured.execution_authority orelse return error.TestExpectedEqual).run_command) {
        .direct_only => return error.TestExpectedShellAllowed,
        .shell_allowed => |authority| try std.testing.expectEqual(command_admission.ShellAuthorizationSource.configured_rule, authority.source),
    }

    state.active_session.?.permission_rules.deinit(alloc);
    state.active_session.?.permission_rules = .{};
    const automatic = (try requestToolPermissionOutcome(&ctx, arena, .{
        .id = "automatic",
        .name = "terminal",
        .arguments_json = "{\"action\":\"exec\",\"command\":\"touch automatic.txt\"}",
    }, .auto, &.{}, &.{}));
    try std.testing.expectEqual(ToolPermissionDecision.deny, automatic.decision);
    try std.testing.expectEqual(types.ToolPermissionDenialReason.auto_denied, automatic.denial_reason.?);
    try std.testing.expect(automatic.execution_authority == null);
}

test "ACP auto mode uses automatic review allow and ask without prompting" {
    const FakeClassifier = struct {
        calls: usize = 0,
        decision: permission_auto_classifier.Decision = .allow,
        root_text: []const u8 = "",

        fn classify(
            raw_ctx: *anyopaque,
            alloc: Allocator,
            request: permission_auto_classifier.ReviewRequest,
        ) anyerror!permission_auto_classifier.ParseOutcome {
            const self: *@This() = @ptrCast(@alignCast(raw_ctx));
            self.calls += 1;
            self.root_text = request.review_turn.current_root_request;
            return .{ .valid = .{
                .risk = if (self.decision == .allow) .low else .high,
                .authorization = if (self.decision == .allow) .medium else .low,
                .decision = self.decision,
                .rationale = try alloc.dupe(u8, "test reviewer rationale"),
            } };
        }
    };

    const alloc = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var state = try initTestAcpState(alloc, "/tmp/workspace", .ask);
    defer state.deinit();
    var fake = FakeClassifier{ .decision = .allow };
    var ctx = AcpContext{
        .alloc = alloc,
        .state = &state,
        .session_id = "session_1",
        .auto_classifier = permission_auto_classifier.Classifier.withOverride(
            @ptrCast(&fake),
            FakeClassifier.classify,
        ),
    };

    const direct_call: ToolCall = .{
        .id = "direct",
        .name = "terminal",
        .arguments_json = "{\"action\":\"exec\",\"command\":\"pwd\"}",
    };
    var direct_review = TestReviewTurn.init("Inspect the workspace.", direct_call);
    const direct = try requestToolPermissionOutcomeWithRequest(
        &ctx,
        arena,
        direct_call,
        direct_review.context(),
        .auto,
        &.{},
        null,
        null,
        &.{},
    );
    try std.testing.expectEqual(
        command_admission.ShellAuthorizationSource.auto_classifier,
        direct.execution_authority.?.run_command.shell_allowed.source,
    );
    try std.testing.expectEqual(@as(usize, 1), fake.calls);

    const accepted_call: ToolCall = .{
        .id = "accepted",
        .name = "terminal",
        .arguments_json = "{\"action\":\"exec\",\"command\":\"touch accepted.txt\"}",
    };
    var accepted_review = TestReviewTurn.init("Create accepted.txt.", accepted_call);
    const accepted = try requestToolPermissionOutcomeWithRequest(&ctx, arena, accepted_call, accepted_review.context(), .auto, &.{}, null, null, &.{});
    switch ((accepted.execution_authority orelse return error.TestExpectedEqual).run_command) {
        .direct_only => return error.TestExpectedShellAllowed,
        .shell_allowed => |authority| try std.testing.expectEqual(
            command_admission.ShellAuthorizationSource.auto_classifier,
            authority.source,
        ),
    }
    try std.testing.expectEqual(@as(usize, 2), fake.calls);
    try std.testing.expectEqualStrings(
        "Create accepted.txt.",
        fake.root_text,
    );

    fake.decision = .ask;
    const blocked_call: ToolCall = .{
        .id = "check",
        .name = "terminal",
        .arguments_json = "{\"action\":\"exec\",\"command\":\"touch check.txt\"}",
    };
    var blocked_review = TestReviewTurn.init("Check whether this is allowed.", blocked_call);
    const blocked = try requestToolPermissionOutcomeWithRequest(&ctx, arena, blocked_call, blocked_review.context(), .auto, &.{}, null, null, &.{});
    try std.testing.expectEqual(ToolPermissionDecision.deny, blocked.decision);
    try std.testing.expectEqual(types.ToolPermissionDenialReason.auto_denied, blocked.denial_reason.?);
    try std.testing.expect(blocked.execution_authority == null);
    try std.testing.expectEqual(@as(usize, 3), fake.calls);
    const blocked_classifier = blocked.auto_review_result orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(permission_auto_classifier.Decision.ask, blocked_classifier.decision);
    try std.testing.expectEqualStrings("test reviewer rationale", blocked_classifier.rationale);
}

test "ACP auto mode automatic review allows or asks prepared external file mutation" {
    const FakeClassifier = struct {
        calls: usize = 0,
        decision: permission_auto_classifier.Decision = .allow,
        root_text: []const u8 = "",
        saw_file_mutation_context: bool = false,

        fn classify(
            raw_ctx: *anyopaque,
            alloc: Allocator,
            request: permission_auto_classifier.ReviewRequest,
        ) anyerror!permission_auto_classifier.ParseOutcome {
            const self: *@This() = @ptrCast(@alignCast(raw_ctx));
            self.calls += 1;
            self.root_text = request.review_turn.current_root_request;
            self.saw_file_mutation_context = std.meta.activeTag(request.action) == .file_mutation;
            return .{ .valid = .{
                .risk = if (self.decision == .allow) .low else .high,
                .authorization = if (self.decision == .allow) .medium else .low,
                .decision = self.decision,
                .rationale = try alloc.dupe(u8, "test reviewer rationale"),
            } };
        }
    };

    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    try tmp.dir.createDirPath(io_mod.getIo(), "external");
    const workspace = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "workspace");
    defer alloc.free(workspace);
    const external = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "external");
    defer alloc.free(external);

    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var state = try initTestAcpState(alloc, workspace, .auto);
    defer state.deinit();
    var fake = FakeClassifier{ .decision = .allow };
    var ctx = AcpContext{
        .alloc = alloc,
        .state = &state,
        .session_id = "session_1",
        .auto_classifier = permission_auto_classifier.Classifier.withOverride(
            @ptrCast(&fake),
            FakeClassifier.classify,
        ),
    };

    const target_path = try std.fs.path.join(arena, &.{ external, "desktop-test.txt" });
    const arguments_json = try std.fmt.allocPrint(
        arena,
        "{{\"path\":\"{s}\",\"content\":\"hello\\n\"}}",
        .{target_path},
    );
    const accepted_call: ToolCall = .{
        .id = "external-write",
        .name = "write_file",
        .arguments_json = arguments_json,
    };
    var accepted_review = TestReviewTurn.init("Create desktop-test.txt with hello.", accepted_call);
    const accepted = try requestToolPermissionOutcomeWithRequest(&ctx, arena, accepted_call, accepted_review.context(), .auto, &.{}, null, null, &.{});

    try std.testing.expectEqual(@as(usize, 0), fake.calls);
    try std.testing.expect(!fake.saw_file_mutation_context);
    try std.testing.expectEqualStrings("", fake.root_text);
    try std.testing.expectEqual(ToolPermissionDecision.once, accepted.decision);
    const authorization = switch (accepted.execution_authority orelse return error.TestExpectedEqual) {
        .file_mutation => |authorization| authorization,
        else => return error.TestExpectedEqual,
    };
    try std.testing.expect(authorization.prepared != null);
    try std.testing.expectEqualStrings(target_path, authorization.input.path());

    {
        var existing = try tmp.dir.createFile(
            io_mod.getIo(),
            "external/desktop-test.txt",
            .{ .truncate = true },
        );
        defer existing.close(io_mod.getIo());
        try existing.writeStreamingAll(io_mod.getIo(), "existing\n");
    }
    fake.decision = .ask;
    const blocked_call: ToolCall = .{
        .id = "external-write-check",
        .name = "write_file",
        .arguments_json = arguments_json,
    };
    var blocked_review = TestReviewTurn.init("Create desktop-test.txt with hello.", blocked_call);
    const blocked = try requestToolPermissionOutcomeWithRequest(&ctx, arena, blocked_call, blocked_review.context(), .auto, &.{}, null, null, &.{});
    try std.testing.expectEqual(@as(usize, 1), fake.calls);
    try std.testing.expectEqual(ToolPermissionDecision.deny, blocked.decision);
    try std.testing.expectEqual(types.ToolPermissionDenialReason.auto_denied, blocked.denial_reason.?);
    try std.testing.expect(blocked.execution_authority == null);
    const blocked_classifier = blocked.auto_review_result orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(permission_auto_classifier.Decision.ask, blocked_classifier.decision);
    try std.testing.expectEqualStrings("test reviewer rationale", blocked_classifier.rationale);
}

test "ACP admits default-safe web fetch without a rule" {
    const alloc = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var state = try initTestAcpState(alloc, "/tmp/workspace", .auto);
    defer state.deinit();
    var ctx = AcpContext{ .alloc = alloc, .state = &state, .session_id = "session_1" };

    const call: ToolCall = .{
        .id = "fetch",
        .name = "web_fetch",
        .arguments_json = "{\"url\":\"https://example.com/docs\"}",
    };
    const default_outcome = try requestToolPermissionOutcome(&ctx, arena, call, .auto, &.{}, &.{});
    try std.testing.expectEqual(ToolPermissionDecision.once, default_outcome.decision);
    try std.testing.expect(default_outcome.execution_authority != null);

    state.active_session.?.permission_rules = try testPermissionRuleSet(alloc, "web_fetch", "domain:example.com", .ask);
    const asked_outcome = try requestToolPermissionOutcome(&ctx, arena, call, .auto, &.{}, &.{});
    try std.testing.expectEqual(ToolPermissionDecision.permission_required, asked_outcome.decision);

    state.active_session.?.permission_rules.deinit(alloc);
    state.active_session.?.permission_rules = try testPermissionRuleSet(alloc, "web_fetch", "domain:example.com", .deny);
    const denied_outcome = try requestToolPermissionOutcome(&ctx, arena, call, .auto, &.{}, &.{});
    try std.testing.expectEqual(ToolPermissionDecision.policy_denied, denied_outcome.decision);
    state.active_session.?.permission_rules.deinit(alloc);
    state.active_session.?.permission_rules = .{};
}

test "ACP auto mode requires review when only one copy target is configured" {
    const alloc = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    try tmp.dir.createDirPath(io_mod.getIo(), "external");
    {
        var source = try tmp.dir.createFile(io_mod.getIo(), "workspace/source.txt", .{ .truncate = true });
        defer source.close(io_mod.getIo());
        try source.writeStreamingAll(io_mod.getIo(), "source\n");
    }
    const workspace = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "workspace");
    defer alloc.free(workspace);
    const external = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "external");
    defer alloc.free(external);

    var state = try initTestAcpState(alloc, workspace, .auto);
    defer state.deinit();
    const pattern = try std.fmt.allocPrint(arena, "{s}/**", .{external});
    state.active_session.?.permission_rules = try testPermissionRuleSet(alloc, "copy_file", pattern, .allow);
    defer state.active_session.?.permission_rules.deinit(alloc);
    var ctx = AcpContext{ .alloc = alloc, .state = &state, .session_id = "session_1" };

    const source = try std.fs.path.join(arena, &.{ workspace, "source.txt" });
    const destination = try std.fs.path.join(arena, &.{ external, "copied.txt" });
    const args = try std.fmt.allocPrint(arena, "{{\"source\":\"{s}\",\"destination\":\"{s}\"}}", .{ source, destination });
    const decision = (try requestToolPermissionOutcome(&ctx, arena, .{
        .id = "call_1",
        .name = "copy_file",
        .arguments_json = args,
    }, .auto, &.{}, &.{})).decision;

    try std.testing.expectEqual(ToolPermissionDecision.deny, decision);
}

test "ACP permission rejects semantic_search outside workspace target" {
    const alloc = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var workspace_tmp = std.testing.tmpDir(.{});
    defer workspace_tmp.cleanup();
    try workspace_tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    var external_tmp = std.testing.tmpDir(.{});
    defer external_tmp.cleanup();
    {
        var file = try external_tmp.dir.createFile(io_mod.getIo(), "outside.txt", .{ .truncate = true });
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), "needle external\n");
    }
    const workspace = try io_mod.dirRealpathAlloc(alloc, workspace_tmp.dir, "workspace");
    defer alloc.free(workspace);
    const external = try io_mod.dirRealpathAlloc(alloc, external_tmp.dir, ".");
    defer alloc.free(external);

    var state = try initTestAcpState(alloc, workspace, .auto);
    defer state.deinit();
    var ctx = AcpContext{ .alloc = alloc, .state = &state, .session_id = "session_1" };

    const args = try semanticSearchArgsJson(arena, "needle", external);
    const decision = (try requestToolPermissionOutcome(&ctx, arena, .{
        .id = "semantic",
        .name = "semantic_search",
        .arguments_json = args,
    }, .auto, &.{}, &.{})).decision;

    try std.testing.expectEqual(ToolPermissionDecision.policy_denied, decision);
}

test "ACP admits default-safe web_search before execution" {
    const alloc = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var state = try initTestAcpState(alloc, "/tmp/workspace", .auto);
    defer state.deinit();
    var ctx = AcpContext{ .alloc = alloc, .state = &state, .session_id = "session_1" };

    const decision = (try requestToolPermissionOutcome(&ctx, arena, .{
        .id = "search",
        .name = "web_search",
        .arguments_json = "{\"query\":\"current news\"}",
    }, .auto, &.{}, &.{})).decision;

    try std.testing.expectEqual(ToolPermissionDecision.once, decision);
}

test "ACP admits default-safe web_fetch before execution" {
    const alloc = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var state = try initTestAcpState(alloc, "/tmp/workspace", .auto);
    defer state.deinit();
    var ctx = AcpContext{ .alloc = alloc, .state = &state, .session_id = "session_1" };

    const decision = (try requestToolPermissionOutcome(&ctx, arena, .{
        .id = "fetch",
        .name = "web_fetch",
        .arguments_json = "{\"url\":\"https://example.com/docs\"}",
    }, .auto, &.{}, &.{})).decision;

    try std.testing.expectEqual(ToolPermissionDecision.once, decision);
}

test "ACP prompt agent config carries request options from active session" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "workspace");
    const workspace = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "workspace");
    defer alloc.free(workspace);

    var state = try initTestAcpState(alloc, workspace, .auto);
    defer state.deinit();
    state.context_limits.project_instruction_file_bytes = .{
        .value = .{ .bytes = 17 },
        .source = .command_line,
    };
    state.active_session.?.fast_mode = true;
    state.active_session.?.effort = types.ReasoningEffort.literal("high");

    const session = &state.active_session.?;
    const config = buildAgentConfig(&state, session, .{
        .skills_prompt_section = "",
        .explicit_skills_prompt_section = "",
        .gateway_tools_json = "[]",
        .custom_tool_guidance = "acp custom tool guidance",
    });

    try std.testing.expect(config.fast_mode);
    try std.testing.expectEqual(types.ReasoningEffort.literal("high"), config.effort);
    try std.testing.expectEqual(@as(usize, 17), config.context_limits.project_instruction_file_bytes.effectiveBytes());
    try std.testing.expectEqual(config_runtime.context_limits.Source.command_line, config.context_limits.project_instruction_file_bytes.source);
    try std.testing.expectEqualStrings("[]", config.gateway_tools_json);
    try std.testing.expectEqualStrings("acp custom tool guidance", config.custom_tool_guidance);
    try std.testing.expectEqualStrings("ACP test model overlay", config.model_prompt_overlay.?);
    var ctx = AcpContext{ .alloc = alloc, .state = &state, .session_id = "session_1" };
    const tool_ctx = ctx.toolContext();
    try std.testing.expect(!tool_ctx.web_search_runtime_ready);
    try std.testing.expect(tool_ctx.web_search_backend != null);
    try std.testing.expect(state.web_search_runtime.provider.?.execute_fn == state.cfg.gateway_provider.web_search.execute_fn);
    try std.testing.expect(state.web_search_runtime.provider.?.preferred_backends_fn == state.cfg.gateway_provider.web_search.preferred_backends_fn);
    try std.testing.expect(tool_ctx.web_fetch_runtime.? == &state.web_fetch_runtime);
    try std.testing.expectEqualStrings(session.model, state.web_search_runtime.worker_model);
    try std.testing.expectEqual(state.cfg.gateway_retry_count, state.web_search_runtime.gateway_retry_count);
    try std.testing.expectEqualStrings(state.cfg.gateway_chat_url, state.web_search_runtime.gateway_chat_url);
    try std.testing.expectEqualStrings("/models", tool_ctx.gateway_models_path);
}
