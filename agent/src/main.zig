const std = @import("std");
const openai = @import("openai_compatible.zig");

const max_line_bytes = 256 * 1024;
const max_text_bytes = openai.max_content_bytes;
const max_tools = 256;
const max_imported_messages = 256;
const max_imported_content_bytes = 96 * 1024;
/// The live conversation's own ceiling, kept apart from the import guard above and
/// far above it: six full tool results cross 96 KB, so trimming a running turn there
/// deleted the prompt it was working on. Only a memory backstop — `compact` is what
/// actually keeps a thread inside a window it knows the size of.
const max_live_messages = 4096;
const max_live_content_bytes = 4 * 1024 * 1024;
const max_relevant_pages = 4;
const max_screen_context_bytes = 96 * 1024;
const max_skill_context_bytes = 64 * 1024;
const jpeg_data_url_prefix = "data:image/jpeg;base64,";
const max_advertised_tools = 32;
const max_tool_result_bytes = 16 * 1024;
/// Ceiling on model steps in one turn. The turn ends with a plain message, never
/// silently. High enough to build something real; the caller stops well before it.
const max_tool_steps = 200;
const max_categories = 64;
const max_category_bytes = 128;
/// How full the model's context window gets before the oldest half of a thread is
/// summarised away. Well short of the wall, because the turn about to be sent still
/// has to fit alongside everything kept.
const compaction_percent = 70;
/// Matches `MAX_SIDECAR_DOCUMENT_BLOCKS` in crates/host; the host rejects anything longer.
const max_document_blocks = 64;
const max_document_points = 12;

const RequestError = error{
    InvalidRequest,
    InvalidField,
    CatalogTooLarge,
    DuplicateTool,
    NoSearchResult,
    ToolNotFound,
    ThreadNotFound,
    ScreenContextRequiresProvider,
    SkillRequiresProvider,
    ToolsRequireProvider,
    NoPendingToolCalls,
    UnexpectedToolResult,
    RevisionRequiresProvider,
};

const Tool = struct {
    server: []u8,
    name: []u8,
    description: []u8,
    schema_json: []u8,

    fn deinit(self: Tool, alloc: std.mem.Allocator) void {
        alloc.free(self.server);
        alloc.free(self.name);
        alloc.free(self.description);
        alloc.free(self.schema_json);
    }
};

const Message = struct {
    id: []u8,
    role: []const u8,
    content: []u8,
    /// Raw `tool_calls` array from an assistant step, replayed verbatim on the next request.
    tool_calls_json: ?[]u8 = null,
    /// Set on a `tool` role message; names the call this result answers.
    tool_call_id: ?[]u8 = null,

    fn deinit(self: Message, alloc: std.mem.Allocator) void {
        alloc.free(self.id);
        alloc.free(self.content);
        if (self.tool_calls_json) |value| alloc.free(value);
        if (self.tool_call_id) |value| alloc.free(value);
    }
};

const Thread = struct {
    id: []u8,
    title: []u8,
    messages: std.ArrayList(Message) = .empty,
    /// Tool-call IDs awaiting results, and the step count, for the turn in flight.
    pending_calls: std.ArrayList([]u8) = .empty,
    steps: usize = 0,
    /// The window the last provider step reported, which decides who bounds this
    /// history: `compact` when it is known, `trimHistory` when it is not.
    context_length: usize = 0,

    fn deinit(self: *Thread, alloc: std.mem.Allocator) void {
        alloc.free(self.id);
        alloc.free(self.title);
        for (self.messages.items) |message| message.deinit(alloc);
        self.messages.deinit(alloc);
        self.clearPending(alloc);
        self.pending_calls.deinit(alloc);
    }

    fn clearPending(self: *Thread, alloc: std.mem.Allocator) void {
        for (self.pending_calls.items) |id| alloc.free(id);
        self.pending_calls.clearRetainingCapacity();
    }

    fn isPending(self: *Thread, id: []const u8) bool {
        for (self.pending_calls.items) |pending| if (std.mem.eql(u8, pending, id)) return true;
        return false;
    }

    fn trimHistory(self: *Thread, alloc: std.mem.Allocator) void {
        // A provider that reports its window is compacted against that window, so
        // trimming here would only race `compact` and delete what it was about to
        // summarise. Without one, this is the only thing keeping a turn's own tool
        // results from growing past what any model would take.
        const limit: usize = if (self.context_length != 0) max_live_content_bytes else max_imported_content_bytes;
        var content_bytes: usize = 0;
        for (self.messages.items) |message| content_bytes += message.content.len;
        while ((self.messages.items.len > max_live_messages or content_bytes > limit) and self.messages.items.len > 1) {
            const removed = self.messages.orderedRemove(0);
            content_bytes -= removed.content.len;
            removed.deinit(alloc);
        }
        self.dropLeadingOrphan(alloc);
    }

    /// A tool result whose assistant tool_calls message was trimmed away is unsendable.
    fn dropLeadingOrphan(self: *Thread, alloc: std.mem.Allocator) void {
        while (self.messages.items.len > 1 and self.messages.items[0].tool_call_id != null) {
            self.messages.orderedRemove(0).deinit(alloc);
        }
    }

    fn dropOldest(self: *Thread, alloc: std.mem.Allocator, count: usize) void {
        for (0..count) |_| {
            if (self.messages.items.len <= 1) break;
            self.messages.orderedRemove(0).deinit(alloc);
        }
        self.dropLeadingOrphan(alloc);
    }

    fn contentBytes(self: *const Thread) usize {
        var bytes: usize = 0;
        for (self.messages.items) |message| bytes += message.content.len;
        return bytes;
    }
};

/// Four bytes to a token, the same estimate the local fallback and the streaming
/// path use when the provider sends no usage of its own.
fn estimateTokens(bytes: usize) usize {
    return (bytes + 3) / 4;
}

/// Everything one delta line needs: which request it belongs to, and the handle
/// to push it out on. Lives on `providerStep`'s frame for the length of the call.
const DeltaContext = struct {
    io: std.Io,
    alloc: std.mem.Allocator,
    request_id: []const u8,
};

/// Writes one `{"id":…,"delta":…}` line ahead of the request's own response.
/// Best effort by construction: a delta that cannot be encoded or written is
/// dropped, because the turn's real result still goes out on the response line.
fn emitDelta(raw_context: ?*anyopaque, text: []const u8) void {
    const context: *DeltaContext = @ptrCast(@alignCast(raw_context orelse return));
    var out: std.Io.Writer.Allocating = .init(context.alloc);
    defer out.deinit();
    (writeDelta(&out.writer, context.request_id, text) catch return);
    std.Io.File.stdout().writeStreamingAll(context.io, out.written()) catch {};
}

fn writeDelta(writer: *std.Io.Writer, request_id: []const u8, text: []const u8) !void {
    try writer.writeAll("{\"id\":");
    try jsonString(writer, request_id);
    try writer.writeAll(",\"delta\":");
    try jsonString(writer, text);
    try writer.writeAll("}\n");
}

const State = struct {
    tools: std.ArrayList(Tool) = .empty,
    last_results: std.ArrayList([]const u8) = .empty,
    threads: std.ArrayList(Thread) = .empty,
    next_thread_id: usize = 1,
    provider_transport: openai.Transport = openai.Transport.unavailable_transport,
    /// Set only by `main`. Its absence is what keeps the test fixtures — and any
    /// caller without a real stdout — on the whole-response path.
    io: ?std.Io = null,

    fn deinit(self: *State, alloc: std.mem.Allocator) void {
        self.clearTools(alloc);
        self.tools.deinit(alloc);
        self.last_results.deinit(alloc);
        for (self.threads.items) |*thread| thread.deinit(alloc);
        self.threads.deinit(alloc);
    }

    fn clearTools(self: *State, alloc: std.mem.Allocator) void {
        for (self.tools.items) |tool| tool.deinit(alloc);
        self.tools.clearRetainingCapacity();
        self.last_results.clearRetainingCapacity();
    }

    fn handle(self: *State, alloc: std.mem.Allocator, line: []const u8) ![]u8 {
        var parsed = std.json.parseFromSlice(std.json.Value, alloc, line, .{}) catch
            return responseError(alloc, null, "invalid_json", "request is not valid JSON");
        defer parsed.deinit();

        if (parsed.value != .object) return responseError(alloc, null, "invalid_request", "request must be an object");
        const object = parsed.value.object;
        const id_value = object.get("id");
        const id = validId(id_value) catch
            return responseError(alloc, null, "invalid_id", "id must be a non-empty string of at most 128 bytes");
        const kind = requiredString(object, "type", 64) catch
            return responseError(alloc, id, "invalid_request", "type must be a non-empty string");

        if (std.mem.eql(u8, kind, "health")) return self.health(alloc, id);
        if (std.mem.eql(u8, kind, "thread_create")) return self.threadCreate(alloc, id, object) catch |err| requestFailure(alloc, id, err, self.provider_transport.detail());
        if (std.mem.eql(u8, kind, "thread_list")) return self.threadList(alloc, id);
        if (std.mem.eql(u8, kind, "thread_get")) return self.threadGet(alloc, id, object) catch |err| requestFailure(alloc, id, err, self.provider_transport.detail());
        if (std.mem.eql(u8, kind, "thread_message")) return self.threadMessage(alloc, id, object) catch |err| requestFailure(alloc, id, err, self.provider_transport.detail());
        if (std.mem.eql(u8, kind, "thread_tool_result")) return self.threadToolResult(alloc, id, object) catch |err| requestFailure(alloc, id, err, self.provider_transport.detail());
        if (std.mem.eql(u8, kind, "analyze") or std.mem.eql(u8, kind, "save_to_knowledge")) return self.analyze(alloc, id, object) catch |err| requestFailure(alloc, id, err, self.provider_transport.detail());
        if (std.mem.eql(u8, kind, "revise_document")) return self.reviseDocument(alloc, id, object) catch |err| requestFailure(alloc, id, err, self.provider_transport.detail());
        if (std.mem.eql(u8, kind, "openrouter_models")) return self.openrouterModels(alloc, id, object) catch |err| requestFailure(alloc, id, err, self.provider_transport.detail());
        if (std.mem.eql(u8, kind, "mcp_catalog")) return self.catalog(alloc, id, object) catch |err| requestFailure(alloc, id, err, self.provider_transport.detail());
        if (std.mem.eql(u8, kind, "mcp_search_tools")) return self.search(alloc, id, object) catch |err| requestFailure(alloc, id, err, self.provider_transport.detail());
        if (std.mem.eql(u8, kind, "mcp_select_tool")) return self.select(alloc, id, object) catch |err| requestFailure(alloc, id, err, self.provider_transport.detail());
        return responseError(alloc, id, "unknown_request", "unsupported request type");
    }

    fn health(self: *State, alloc: std.mem.Allocator, id: []const u8) ![]u8 {
        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try responseStart(&out.writer, id);
        try out.writer.writeAll("{\"status\":\"ok\",\"protocol\":1,\"thread_count\":");
        try out.writer.print(
            "{d},\"tool_count\":{d}",
            .{ self.threads.items.len, self.tools.items.len },
        );
        try out.writer.writeAll(",\"requests\":[\"health\",\"thread_create\",\"thread_list\",\"thread_get\",\"thread_message\",\"thread_tool_result\",\"analyze\",\"save_to_knowledge\",\"revise_document\",\"openrouter_models\",\"mcp_catalog\",\"mcp_search_tools\",\"mcp_select_tool\"]}}\n");
        return out.toOwnedSlice();
    }

    fn threadCreate(self: *State, alloc: std.mem.Allocator, id: []const u8, object: std.json.ObjectMap) ![]u8 {
        if (self.threads.items.len == 1024) return error.InvalidField;
        const title = try optionalString(object.get("title"), "New thread", 256);
        const thread_id = try std.fmt.allocPrint(alloc, "thread-{d}", .{self.next_thread_id});
        const owned_title = alloc.dupe(u8, title) catch |err| {
            alloc.free(thread_id);
            return err;
        };
        var thread: Thread = .{ .id = thread_id, .title = owned_title };
        errdefer thread.deinit(alloc);
        if (object.get("messages")) |messages| try importMessages(alloc, &thread, messages);
        try self.threads.append(alloc, thread);
        self.next_thread_id += 1;

        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try responseStart(&out.writer, id);
        try writeThreadSummary(&out.writer, self.threads.items[self.threads.items.len - 1]);
        try out.writer.writeAll("}\n");
        return out.toOwnedSlice();
    }

    fn threadList(self: *State, alloc: std.mem.Allocator, id: []const u8) ![]u8 {
        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try responseStart(&out.writer, id);
        try out.writer.writeAll("{\"threads\":[");
        for (self.threads.items, 0..) |thread, index| {
            if (index != 0) try out.writer.writeByte(',');
            try writeThreadSummary(&out.writer, thread);
        }
        try out.writer.writeAll("]}}\n");
        return out.toOwnedSlice();
    }

    fn threadGet(self: *State, alloc: std.mem.Allocator, id: []const u8, object: std.json.ObjectMap) ![]u8 {
        const thread_id = try requiredString(object, "thread_id", 128);
        const thread = self.findThread(thread_id) orelse return error.ThreadNotFound;
        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try responseStart(&out.writer, id);
        try out.writer.writeAll("{\"id\":");
        try jsonString(&out.writer, thread.id);
        try out.writer.writeAll(",\"title\":");
        try jsonString(&out.writer, thread.title);
        try out.writer.writeAll(",\"messages\":[");
        for (thread.messages.items, 0..) |message, index| {
            if (index != 0) try out.writer.writeByte(',');
            try writeMessage(&out.writer, message);
        }
        try out.writer.writeAll("]}}\n");
        return out.toOwnedSlice();
    }

    fn threadMessage(self: *State, alloc: std.mem.Allocator, id: []const u8, object: std.json.ObjectMap) ![]u8 {
        const thread_id = try requiredString(object, "thread_id", 128);
        const content = try requiredString(object, "content", max_text_bytes);
        if (!std.unicode.utf8ValidateSlice(content)) return error.InvalidField;
        const provider = try parseProvider(object.get("provider"));
        const screen_context = try parseScreenContext(object.get("screen_context"));
        const skill_context = try parseSkillContext(object.get("skill_context"));
        if (screen_context != null and provider == null) return error.ScreenContextRequiresProvider;
        if (skill_context != null and provider == null) return error.SkillRequiresProvider;
        var tools: ToolSpecs = .{};
        defer tools.deinit(alloc);
        try parseToolSpecs(alloc, object.get("tools"), &tools);
        if (tools.specs.items.len != 0 and provider == null) return error.ToolsRequireProvider;
        var knowledge_buffer: [max_relevant_pages]openai.KnowledgePage = undefined;
        const knowledge = try parseKnowledge(object.get("knowledge"), &knowledge_buffer);
        const thread = self.findThread(thread_id) orelse return error.ThreadNotFound;

        // A new user turn always starts a fresh run; nothing from a prior turn stays pending.
        thread.clearPending(alloc);
        thread.steps = 0;

        if (provider) |config| {
            return self.providerStep(alloc, id, thread, config, content, knowledge, screen_context, skill_context, tools.specs.items);
        }

        var input_bytes = content.len;
        for (knowledge) |page| input_bytes += page.id.len + page.title.len + page.summary.len + page.body.len;
        const input_tokens = (input_bytes + 3) / 4;
        const assistant_content = try fallbackReply(alloc, content, knowledge);
        errdefer alloc.free(assistant_content);
        const output_tokens = (assistant_content.len + 3) / 4;
        return finishTurn(alloc, id, thread, "local-fallback", content, assistant_content, null, input_tokens, output_tokens);
    }

    /// One model step. Returns either an ordinary assistant message or the tool calls the
    /// permissioned caller must execute before submitting results.
    fn providerStep(
        self: *State,
        alloc: std.mem.Allocator,
        id: []const u8,
        thread: *Thread,
        config: openai.Config,
        user_content: []const u8,
        knowledge: []const openai.KnowledgePage,
        screen_context: ?[]const u8,
        skill_context: ?[]const u8,
        tools: []const openai.ToolSpec,
    ) ![]u8 {
        thread.context_length = config.context_length;
        self.compact(alloc, thread, config);
        var delta_context: DeltaContext = undefined;
        var sink: ?openai.DeltaSink = null;
        if (self.io) |io| {
            delta_context = .{ .io = io, .alloc = alloc, .request_id = id };
            sink = .{ .context = &delta_context, .emit_fn = emitDelta };
        }
        const payload = try openai.buildRequest(alloc, config, thread.messages.items, user_content, knowledge, screen_context, skill_context, tools, sink != null);
        defer alloc.free(payload);
        const reply = try self.provider_transport.send(alloc, config, payload, tools.len != 0, sink);
        defer reply.deinit(alloc);

        if (reply.tool_calls.len == 0) {
            const assistant_content = try alloc.dupe(u8, reply.content);
            errdefer alloc.free(assistant_content);
            thread.clearPending(alloc);
            return finishTurn(alloc, id, thread, config.model, user_content, assistant_content, null, reply.input_tokens, reply.output_tokens);
        }

        const replay = try replayToolCalls(alloc, reply.tool_calls);
        errdefer alloc.free(replay);
        const assistant_content = try alloc.dupe(u8, reply.content);
        errdefer alloc.free(assistant_content);
        thread.steps += 1;
        thread.clearPending(alloc);
        try thread.pending_calls.ensureUnusedCapacity(alloc, reply.tool_calls.len);
        for (reply.tool_calls) |call| thread.pending_calls.appendAssumeCapacity(try alloc.dupe(u8, call.id));
        return finishTurn(alloc, id, thread, config.model, user_content, assistant_content, .{ .calls = reply.tool_calls, .replay = replay, .step = thread.steps }, reply.input_tokens, reply.output_tokens);
    }

    /// Past 70% of the model's context window, the oldest half of the thread becomes one
    /// system message summarising it. Everything here fails soft: an unknown window or a
    /// summary the provider will not write falls back to dropping the oldest messages,
    /// because losing the start of a thread beats losing the turn.
    fn compact(self: *State, alloc: std.mem.Allocator, thread: *Thread, config: openai.Config) void {
        if (config.context_length == 0) return;
        if (estimateTokens(thread.contentBytes()) * 100 <= config.context_length * compaction_percent) return;

        var count = thread.messages.items.len / 2;
        // Never cut between an assistant's tool_calls and the results answering them.
        while (count < thread.messages.items.len and thread.messages.items[count].tool_call_id != null) count += 1;
        if (count == 0 or count == thread.messages.items.len) return;
        var dropped_bytes: usize = 0;
        for (thread.messages.items[0..count]) |message| dropped_bytes += message.content.len;

        const summary = self.summarize(alloc, config, thread.messages.items[0..count]) catch {
            thread.dropOldest(alloc, count);
            return;
        };
        defer alloc.free(summary);
        // A summary no smaller than what it replaces buys nothing and would be paid for
        // again on the next turn.
        if (summary.len >= dropped_bytes) {
            thread.dropOldest(alloc, count);
            return;
        }
        const content = std.fmt.allocPrint(alloc, "Earlier in this conversation:\n{s}", .{summary}) catch {
            thread.dropOldest(alloc, count);
            return;
        };
        const id = std.fmt.allocPrint(alloc, "message-summary-{d}", .{thread.messages.items.len}) catch {
            alloc.free(content);
            thread.dropOldest(alloc, count);
            return;
        };
        thread.dropOldest(alloc, count);
        thread.messages.insert(alloc, 0, .{ .id = id, .role = "system", .content = content }) catch {
            alloc.free(id);
            alloc.free(content);
        };
    }

    /// One shot at the same provider, with no tools and nothing streamed, for the plain
    /// text that stands in for the messages being dropped.
    fn summarize(self: *State, alloc: std.mem.Allocator, config: openai.Config, messages: []const Message) ![]u8 {
        var prompt: std.Io.Writer.Allocating = .init(alloc);
        defer prompt.deinit();
        try prompt.writer.writeAll("Summarise the conversation below in at most 200 words of plain text: what the user asked for, what was decided, what was done, and anything still open. Reply with the summary only.\n\n");
        for (messages) |message| try prompt.writer.print("{s}: {s}\n", .{ message.role, message.content });
        const payload = try openai.buildRequest(alloc, config, &[_]Message{}, prompt.written(), &.{}, null, null, &.{}, false);
        defer alloc.free(payload);
        const reply = try self.provider_transport.send(alloc, config, payload, false, null);
        defer reply.deinit(alloc);
        if (reply.content.len == 0) return error.InvalidProviderResponse;
        return alloc.dupe(u8, reply.content);
    }

    /// Submits the results of the pending tool calls and takes the next model step.
    fn threadToolResult(self: *State, alloc: std.mem.Allocator, id: []const u8, object: std.json.ObjectMap) ![]u8 {
        const thread_id = try requiredString(object, "thread_id", 128);
        const config = (try parseProvider(object.get("provider"))) orelse return error.ToolsRequireProvider;
        const screen_context = try parseScreenContext(object.get("screen_context"));
        const skill_context = try parseSkillContext(object.get("skill_context"));
        const content = try optionalString(object.get("content"), "Continue.", max_text_bytes);
        var tools: ToolSpecs = .{};
        defer tools.deinit(alloc);
        try parseToolSpecs(alloc, object.get("tools"), &tools);
        const thread = self.findThread(thread_id) orelse return error.ThreadNotFound;
        if (thread.pending_calls.items.len == 0) return error.NoPendingToolCalls;

        const results = object.get("results") orelse return error.InvalidField;
        if (results != .array or results.array.items.len == 0 or results.array.items.len > openai.max_tool_calls_per_step) return error.InvalidField;
        for (results.array.items) |result| {
            if (result != .object) return error.InvalidField;
            const call_id = try requiredString(result.object, "id", 128);
            if (!thread.isPending(call_id)) return error.UnexpectedToolResult;
            const output = try requiredString(result.object, "content", max_tool_result_bytes);
            if (!std.unicode.utf8ValidateSlice(output)) return error.InvalidField;
            try appendToolMessage(alloc, thread, call_id, output);
        }
        thread.clearPending(alloc);

        if (thread.steps >= max_tool_steps) {
            const stopped = try std.fmt.allocPrint(alloc, "I stopped after {d} tool steps without finishing this task. Ask me to continue if the remaining work is still worth doing.", .{thread.steps});
            errdefer alloc.free(stopped);
            return finishTurn(alloc, id, thread, config.model, "", stopped, null, 0, (stopped.len + 3) / 4);
        }
        return self.providerStep(alloc, id, thread, config, content, &.{}, screen_context, skill_context, tools.specs.items);
    }

    fn analyze(self: *State, alloc: std.mem.Allocator, id: []const u8, object: std.json.ObjectMap) ![]u8 {
        const thread_id = try requiredString(object, "thread_id", 128);
        if (self.findThread(thread_id) == null) return error.ThreadNotFound;
        const text = try requiredString(object, "text", max_text_bytes);
        if (!std.unicode.utf8ValidateSlice(text)) return error.InvalidField;
        const provider = try parseProvider(object.get("provider"));
        const sources = try validateSources(object.get("sources"));
        const categories = try parseCategories(object.get("categories"));
        if (provider) |config| return self.authorDocument(alloc, id, thread_id, config, text, categories, sources);

        const title = titleFrom(text);
        const category = chooseCategory(categories, text);
        const input_tokens = (text.len + 3) / 4;
        const output_tokens = (title.len + 95) / 4;

        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try responseStart(&out.writer, id);
        try out.writer.writeAll("{\"destination\":\"knowledge\",\"artifact\":{\"source_thread_id\":");
        try jsonString(&out.writer, thread_id);
        try out.writer.writeAll(",\"category\":");
        try jsonString(&out.writer, category);
        try out.writer.writeAll(",\"title\":");
        try jsonString(&out.writer, title);
        try out.writer.writeAll(",\"summary\":");
        try out.writer.writeAll("\"Deterministic local analysis generated without provider credentials.\"");
        try out.writer.writeAll(",\"interesting_points\":[\"The input was classified using explicit local keyword rules.\",\"No network or model call was required.\"]");
        try out.writer.writeAll(",\"counterarguments\":[\"Keyword classification can miss context and nuance.\"]");
        try out.writer.writeAll(",\"cited_sources\":[");
        for (sources, 0..) |source, index| {
            if (index != 0) try out.writer.writeByte(',');
            try jsonString(&out.writer, source.string);
        }
        try out.writer.print(
            "],\"model\":\"local-fallback\",\"input_tokens\":{d},\"output_tokens\":{d},\"subagent_count\":0",
            .{ input_tokens, output_tokens },
        );
        try out.writer.writeAll("}}}\n");
        return out.toOwnedSlice();
    }

    /// Asks the model to author the whole page — prose, tables, charts — instead of filling a
    /// fixed scaffold. `emma_core` validates every block, so a malformed one loses its block,
    /// not the page.
    fn authorDocument(
        self: *State,
        alloc: std.mem.Allocator,
        id: []const u8,
        thread_id: []const u8,
        config: openai.Config,
        text: []const u8,
        categories: []const std.json.Value,
        sources: []const std.json.Value,
    ) ![]u8 {
        const prompt = try documentPrompt(alloc, text, categories);
        defer alloc.free(prompt);
        var parsed = try self.askForJson(alloc, config, prompt);
        defer parsed.value.deinit();
        const document = parsed.value.value.object;

        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try responseStart(&out.writer, id);
        try out.writer.writeAll("{\"destination\":\"knowledge\",\"artifact\":{\"source_thread_id\":");
        try jsonString(&out.writer, thread_id);
        try out.writer.writeAll(",\"category\":");
        try jsonString(&out.writer, modelString(document.get("category"), chooseCategory(categories, text), max_category_bytes));
        try out.writer.writeAll(",\"title\":");
        try jsonString(&out.writer, modelString(document.get("title"), titleFrom(text), 256));
        try out.writer.writeAll(",\"summary\":");
        try jsonString(&out.writer, modelString(document.get("summary"), "The model returned no summary for this page.", 4 * 1024));
        try out.writer.writeAll(",\"interesting_points\":");
        try writeStringArray(&out.writer, document.get("interesting_points"));
        try out.writer.writeAll(",\"counterarguments\":");
        try writeStringArray(&out.writer, document.get("counterarguments"));
        try out.writer.writeAll(",\"cited_sources\":[");
        for (sources, 0..) |source, index| {
            if (index != 0) try out.writer.writeByte(',');
            try jsonString(&out.writer, source.string);
        }
        try out.writer.writeAll("],\"blocks\":");
        try writeBlocks(alloc, &out.writer, document.get("blocks"));
        try out.writer.writeAll(",\"model\":");
        try jsonString(&out.writer, config.model);
        try out.writer.print(
            ",\"input_tokens\":{d},\"output_tokens\":{d},\"subagent_count\":0",
            .{ parsed.input_tokens, parsed.output_tokens },
        );
        try out.writer.writeAll("}}}\n");
        return out.toOwnedSlice();
    }

    /// Rewrites an existing page from a chat instruction. The whole page comes back so the
    /// caller can show one diff and apply it in one durable write.
    fn reviseDocument(self: *State, alloc: std.mem.Allocator, id: []const u8, object: std.json.ObjectMap) ![]u8 {
        const thread_id = try requiredString(object, "thread_id", 128);
        if (self.findThread(thread_id) == null) return error.ThreadNotFound;
        const instruction = try requiredString(object, "instruction", max_text_bytes);
        if (!std.unicode.utf8ValidateSlice(instruction)) return error.InvalidField;
        const config = (try parseProvider(object.get("provider"))) orelse return error.RevisionRequiresProvider;
        const document = object.get("document") orelse return error.InvalidField;
        if (document != .array or document.array.items.len > max_document_blocks) return error.InvalidField;

        const current = try stringifyValue(alloc, document);
        defer alloc.free(current);
        const prompt = try revisionPrompt(alloc, instruction, current);
        defer alloc.free(prompt);
        var parsed = try self.askForJson(alloc, config, prompt);
        defer parsed.value.deinit();

        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try responseStart(&out.writer, id);
        try out.writer.writeAll("{\"blocks\":");
        try writeBlocks(alloc, &out.writer, parsed.value.value.object.get("blocks"));
        try out.writer.writeAll("}}\n");
        return out.toOwnedSlice();
    }

    /// One shot at the provider with no thread history, expecting a bare JSON object back.
    fn askForJson(self: *State, alloc: std.mem.Allocator, config: openai.Config, prompt: []const u8) !JsonReply {
        // Document authoring wants one whole JSON object, not a repaint stream.
        const payload = try openai.buildRequest(alloc, config, &[_]Message{}, prompt, &.{}, null, null, &.{}, false);
        defer alloc.free(payload);
        const reply = try self.provider_transport.send(alloc, config, payload, false, null);
        defer reply.deinit(alloc);

        const span = jsonSpan(reply.content) orelse return error.InvalidProviderResponse;
        const parsed = std.json.parseFromSlice(std.json.Value, alloc, span, .{}) catch
            return error.InvalidProviderResponse;
        errdefer parsed.deinit();
        if (parsed.value != .object) return error.InvalidProviderResponse;
        return .{ .value = parsed, .input_tokens = reply.input_tokens, .output_tokens = reply.output_tokens };
    }

    fn openrouterModels(self: *State, alloc: std.mem.Allocator, id: []const u8, object: std.json.ObjectMap) ![]u8 {
        const config = (try parseProvider(object.get("provider"))) orelse return error.InvalidField;
        const models = try self.provider_transport.listModels(alloc, config);
        defer models.deinit(alloc);

        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try responseStart(&out.writer, id);
        try out.writer.writeAll("{\"models\":[");
        for (models.models, 0..) |model, index| {
            if (index != 0) try out.writer.writeByte(',');
            try out.writer.writeAll("{\"id\":");
            try jsonString(&out.writer, model.id);
            try out.writer.writeAll(",\"name\":");
            try jsonString(&out.writer, model.name);
            try out.writer.print(",\"context_length\":{d},\"input_modalities\":[", .{model.context_length});
            var written: usize = 0;
            inline for (.{ "image", "file", "audio" }, .{ model.input_modalities.image, model.input_modalities.file, model.input_modalities.audio }) |name, present| {
                if (present) {
                    if (written != 0) try out.writer.writeByte(',');
                    try jsonString(&out.writer, name);
                    written += 1;
                }
            }
            try out.writer.writeAll("],\"reasoning_efforts\":[");
            written = 0;
            for (openai.effort_names, 0..) |name, effort| {
                if (!model.reasoning.has(@intCast(effort))) continue;
                if (written != 0) try out.writer.writeByte(',');
                try jsonString(&out.writer, name);
                written += 1;
            }
            try out.writer.print(
                "],\"reasoning_mandatory\":{},\"free\":{},\"prompt_micro_usd_per_mtok\":{d},\"completion_micro_usd_per_mtok\":{d}}}",
                .{ model.reasoning.mandatory, model.free, model.prompt_micro_usd_per_mtok, model.completion_micro_usd_per_mtok },
            );
        }
        try out.writer.writeAll("]}}\n");
        return out.toOwnedSlice();
    }

    fn findThread(self: *State, id: []const u8) ?*Thread {
        for (self.threads.items) |*thread| if (std.mem.eql(u8, thread.id, id)) return thread;
        return null;
    }

    fn catalog(self: *State, alloc: std.mem.Allocator, id: []const u8, object: std.json.ObjectMap) ![]u8 {
        if (object.get("servers")) |servers_value| try self.replaceCatalog(alloc, servers_value);

        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try responseStart(&out.writer, id);
        try out.writer.writeAll("{\"servers\":[");
        var emitted: usize = 0;
        for (self.tools.items, 0..) |tool, index| {
            var prior = false;
            for (self.tools.items[0..index]) |candidate| {
                if (std.mem.eql(u8, candidate.server, tool.server)) {
                    prior = true;
                    break;
                }
            }
            if (prior) continue;
            var count: usize = 0;
            for (self.tools.items) |candidate| if (std.mem.eql(u8, candidate.server, tool.server)) {
                count += 1;
            };
            if (emitted != 0) try out.writer.writeByte(',');
            try out.writer.writeAll("{\"name\":");
            try jsonString(&out.writer, tool.server);
            try out.writer.print(",\"availability\":\"ready\",\"tool_count\":{d}}}", .{count});
            emitted += 1;
        }
        try out.writer.writeAll("],\"schemas_advertised\":0}}\n");
        return out.toOwnedSlice();
    }

    fn replaceCatalog(self: *State, alloc: std.mem.Allocator, value: std.json.Value) !void {
        if (value != .array or value.array.items.len > 32) return error.InvalidField;
        var replacement: std.ArrayList(Tool) = .empty;
        errdefer {
            for (replacement.items) |tool| tool.deinit(alloc);
            replacement.deinit(alloc);
        }
        for (value.array.items) |server_value| {
            if (server_value != .object) return error.InvalidField;
            const server = try requiredString(server_value.object, "name", 128);
            const tools_value = server_value.object.get("tools") orelse return error.InvalidField;
            if (tools_value != .array) return error.InvalidField;
            for (tools_value.array.items) |tool_value| {
                if (replacement.items.len == max_tools) return error.CatalogTooLarge;
                if (tool_value != .object) return error.InvalidField;
                const name = try requiredString(tool_value.object, "name", 128);
                const description = try requiredString(tool_value.object, "description", 1024);
                const schema = tool_value.object.get("input_schema") orelse return error.InvalidField;
                if (schema != .object) return error.InvalidField;
                for (replacement.items) |existing| if (std.mem.eql(u8, existing.name, name)) return error.DuplicateTool;
                const schema_json = try stringifyValue(alloc, schema);
                errdefer alloc.free(schema_json);
                const owned_server = try alloc.dupe(u8, server);
                errdefer alloc.free(owned_server);
                const owned_name = try alloc.dupe(u8, name);
                errdefer alloc.free(owned_name);
                const owned_description = try alloc.dupe(u8, description);
                errdefer alloc.free(owned_description);
                try replacement.append(alloc, .{
                    .server = owned_server,
                    .name = owned_name,
                    .description = owned_description,
                    .schema_json = schema_json,
                });
            }
        }
        self.clearTools(alloc);
        self.tools.deinit(alloc);
        self.tools = replacement;
    }

    fn search(self: *State, alloc: std.mem.Allocator, id: []const u8, object: std.json.ObjectMap) ![]u8 {
        const query = try requiredString(object, "query", 256);
        const limit = try optionalLimit(object.get("limit"));
        self.last_results.clearRetainingCapacity();

        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try responseStart(&out.writer, id);
        try out.writer.writeAll("{\"tools\":[");
        var count: usize = 0;
        for (self.tools.items) |tool| {
            if (!matches(tool, query)) continue;
            if (count == limit) break;
            try self.last_results.append(alloc, tool.name);
            if (count != 0) try out.writer.writeByte(',');
            try out.writer.writeAll("{\"server\":");
            try jsonString(&out.writer, tool.server);
            try out.writer.writeAll(",\"name\":");
            try jsonString(&out.writer, tool.name);
            try out.writer.writeAll(",\"description\":");
            try jsonString(&out.writer, tool.description);
            try out.writer.writeByte('}');
            count += 1;
        }
        try out.writer.writeAll("],\"schemas_advertised\":0}}\n");
        return out.toOwnedSlice();
    }

    fn select(self: *State, alloc: std.mem.Allocator, id: []const u8, object: std.json.ObjectMap) ![]u8 {
        const name = try requiredString(object, "name", 128);
        var was_searched = false;
        for (self.last_results.items) |result| if (std.mem.eql(u8, result, name)) {
            was_searched = true;
            break;
        };
        if (!was_searched) return error.NoSearchResult;
        const tool = for (self.tools.items) |candidate| {
            if (std.mem.eql(u8, candidate.name, name)) break candidate;
        } else return error.ToolNotFound;

        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try responseStart(&out.writer, id);
        try out.writer.writeAll("{\"advertise_on_next_model_step\":{\"type\":\"function\",\"name\":");
        try jsonString(&out.writer, tool.name);
        try out.writer.writeAll(",\"description\":");
        try jsonString(&out.writer, tool.description);
        try out.writer.writeAll(",\"inputSchema\":");
        try out.writer.writeAll(tool.schema_json);
        try out.writer.writeAll("}}}\n");
        self.last_results.clearRetainingCapacity();
        return out.toOwnedSlice();
    }
};

pub fn main(init: std.process.Init) !void {
    const alloc = init.gpa;
    const io = init.io;
    var read_buffer: [4096]u8 = undefined;
    var reader = std.Io.File.stdin().reader(io, &read_buffer);
    var http_context: openai.HttpContext = .{ .io = io, .environ = init.environ_map };
    var state: State = .{ .provider_transport = .http(&http_context), .io = io };
    defer state.deinit(alloc);

    while (true) {
        const line = readLine(alloc, &reader.interface) catch |err| {
            if (err == error.LineTooLarge) {
                const response = try responseError(alloc, null, "line_too_large", "NDJSON line exceeds 262144 bytes");
                defer alloc.free(response);
                try std.Io.File.stdout().writeStreamingAll(io, response);
                continue;
            }
            return err;
        } orelse break;
        defer alloc.free(line);
        if (line.len == 0) continue;
        const response = try state.handle(alloc, line);
        defer alloc.free(response);
        try std.Io.File.stdout().writeStreamingAll(io, response);
    }
}

fn readLine(alloc: std.mem.Allocator, reader: *std.Io.Reader) !?[]u8 {
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(alloc);
    var oversized = false;
    while (true) {
        const fragment = reader.takeDelimiter('\n') catch |err| switch (err) {
            error.StreamTooLong => {
                const buffered = reader.buffered();
                if (!oversized and out.items.len + buffered.len > max_line_bytes) oversized = true;
                if (!oversized) try out.appendSlice(alloc, buffered);
                reader.tossBuffered();
                continue;
            },
            error.ReadFailed => return error.ReadFailed,
        } orelse {
            if (out.items.len == 0 and !oversized) return null;
            break;
        };
        if (!oversized and out.items.len + fragment.len > max_line_bytes) oversized = true;
        if (!oversized) try out.appendSlice(alloc, fragment);
        break;
    }
    if (oversized) return error.LineTooLarge;
    if (out.items.len > 0 and out.items[out.items.len - 1] == '\r') _ = out.pop();
    return try out.toOwnedSlice(alloc);
}

/// Tools advertised for one step. `specs` borrows names and descriptions from the parsed
/// request; `schemas` owns the stringified JSON schemas they point at.
const ToolSpecs = struct {
    specs: std.ArrayList(openai.ToolSpec) = .empty,
    schemas: std.ArrayList([]u8) = .empty,

    fn deinit(self: *ToolSpecs, alloc: std.mem.Allocator) void {
        for (self.schemas.items) |schema| alloc.free(schema);
        self.schemas.deinit(alloc);
        self.specs.deinit(alloc);
    }
};

fn parseToolSpecs(alloc: std.mem.Allocator, value: ?std.json.Value, out: *ToolSpecs) !void {
    const tools = value orelse return;
    if (tools != .array or tools.array.items.len > max_advertised_tools) return error.InvalidField;
    for (tools.array.items) |item| {
        if (item != .object) return error.InvalidField;
        const name = try requiredString(item.object, "name", 128);
        const description = try requiredString(item.object, "description", 4 * 1024);
        const schema = item.object.get("input_schema") orelse return error.InvalidField;
        if (schema != .object) return error.InvalidField;
        for (out.specs.items) |existing| if (std.mem.eql(u8, existing.name, name)) return error.DuplicateTool;
        try out.schemas.ensureUnusedCapacity(alloc, 1);
        try out.specs.ensureUnusedCapacity(alloc, 1);
        const schema_json = try stringifyValue(alloc, schema);
        if (schema_json.len > 8 * 1024) {
            alloc.free(schema_json);
            return error.InvalidField;
        }
        out.schemas.appendAssumeCapacity(schema_json);
        out.specs.appendAssumeCapacity(.{ .name = name, .description = description, .schema_json = schema_json });
    }
}

const StepCalls = struct {
    calls: []const openai.ToolCall,
    replay: []u8,
    step: usize,
};

/// Rebuilds the provider's own `tool_calls` array so the next request replays this step exactly.
fn replayToolCalls(alloc: std.mem.Allocator, calls: []const openai.ToolCall) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    try out.writer.writeByte('[');
    for (calls, 0..) |call, index| {
        if (index != 0) try out.writer.writeByte(',');
        try out.writer.writeAll("{\"id\":");
        try jsonString(&out.writer, call.id);
        try out.writer.writeAll(",\"type\":\"function\",\"function\":{\"name\":");
        try jsonString(&out.writer, call.name);
        try out.writer.writeAll(",\"arguments\":");
        try jsonString(&out.writer, call.arguments_json);
        try out.writer.writeAll("}}");
    }
    try out.writer.writeByte(']');
    return out.toOwnedSlice();
}

fn appendToolMessage(alloc: std.mem.Allocator, thread: *Thread, call_id: []const u8, output: []const u8) !void {
    try thread.messages.ensureUnusedCapacity(alloc, 1);
    const message_id = try std.fmt.allocPrint(alloc, "message-{d}", .{thread.messages.items.len + 1});
    errdefer alloc.free(message_id);
    const content = try alloc.dupe(u8, output);
    errdefer alloc.free(content);
    const owned_id = try alloc.dupe(u8, call_id);
    thread.messages.appendAssumeCapacity(.{ .id = message_id, .role = "tool", .content = content, .tool_call_id = owned_id });
}

/// Serializes the turn result, then commits the new messages. `assistant_content` and any
/// `step.replay` become owned by the thread on success.
fn finishTurn(
    alloc: std.mem.Allocator,
    id: []const u8,
    thread: *Thread,
    model: []const u8,
    user_content: []const u8,
    assistant_content: []u8,
    step: ?StepCalls,
    input_tokens: usize,
    output_tokens: usize,
) ![]u8 {
    const has_user = user_content.len != 0;
    const user_id = if (has_user) try std.fmt.allocPrint(alloc, "message-{d}", .{thread.messages.items.len + 1}) else null;
    errdefer if (user_id) |value| alloc.free(value);
    const user_copy = if (has_user) try alloc.dupe(u8, user_content) else null;
    errdefer if (user_copy) |value| alloc.free(value);
    const assistant_id = try std.fmt.allocPrint(alloc, "message-{d}", .{thread.messages.items.len + @as(usize, if (has_user) 2 else 1)});
    errdefer alloc.free(assistant_id);
    try thread.messages.ensureUnusedCapacity(alloc, 2);

    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    try responseStart(&out.writer, id);
    try out.writer.writeAll("{\"message\":");
    try writeMessage(&out.writer, .{ .id = assistant_id, .role = "assistant", .content = assistant_content });
    try out.writer.writeAll(",\"model\":");
    try jsonString(&out.writer, model);
    try out.writer.writeAll(",\"events\":[],\"tool_calls\":[");
    if (step) |value| for (value.calls, 0..) |call, index| {
        if (index != 0) try out.writer.writeByte(',');
        try out.writer.writeAll("{\"id\":");
        try jsonString(&out.writer, call.id);
        try out.writer.writeAll(",\"name\":");
        try jsonString(&out.writer, call.name);
        try out.writer.writeAll(",\"arguments\":");
        try jsonString(&out.writer, call.arguments_json);
        try out.writer.writeByte('}');
    };
    try out.writer.writeAll("],\"permission_requests\":[]");
    try out.writer.print(",\"step\":{d},\"input_tokens\":{d},\"output_tokens\":{d}", .{ if (step) |value| value.step else 0, input_tokens, output_tokens });
    try out.writer.writeAll("}}\n");
    const response = try out.toOwnedSlice();
    if (user_id) |value| thread.messages.appendAssumeCapacity(.{ .id = value, .role = "user", .content = user_copy.? });
    thread.messages.appendAssumeCapacity(.{
        .id = assistant_id,
        .role = "assistant",
        .content = assistant_content,
        .tool_calls_json = if (step) |value| value.replay else null,
    });
    thread.trimHistory(alloc);
    return response;
}

fn validId(value: ?std.json.Value) RequestError![]const u8 {
    const id = value orelse return error.InvalidRequest;
    if (id != .string or id.string.len == 0 or id.string.len > 128) return error.InvalidRequest;
    return id.string;
}

fn requiredString(object: std.json.ObjectMap, key: []const u8, max: usize) RequestError![]const u8 {
    const value = object.get(key) orelse return error.InvalidField;
    if (value != .string or value.string.len == 0 or value.string.len > max) return error.InvalidField;
    return value.string;
}

fn optionalString(value: ?std.json.Value, default: []const u8, max: usize) RequestError![]const u8 {
    const text = value orelse return default;
    if (text != .string or text.string.len == 0 or text.string.len > max or !std.unicode.utf8ValidateSlice(text.string)) return error.InvalidField;
    return text.string;
}

fn optionalLimit(value: ?std.json.Value) RequestError!usize {
    const limit = value orelse return 10;
    if (limit != .integer or limit.integer < 1 or limit.integer > 20) return error.InvalidField;
    return @intCast(limit.integer);
}

fn parseProvider(value: ?std.json.Value) RequestError!?openai.Config {
    const provider = value orelse return null;
    if (provider != .object) return error.InvalidField;
    const config: openai.Config = .{
        .base_url = try requiredString(provider.object, "base_url", 2048),
        .model = try requiredString(provider.object, "model", 128),
        .credential_env = try optionalCredentialEnv(provider.object.get("credential_env")),
        .protect_data = try optionalBool(provider.object.get("protect_data"), false),
        .zero_retention = try optionalBool(provider.object.get("zero_retention"), false),
        .reasoning_effort = try optionalReasoningEffort(provider.object.get("reasoning_effort")),
        .context_length = try optionalContextLength(provider.object.get("context_length")),
    };
    openai.validateConfig(config) catch return error.InvalidField;
    return config;
}

/// The thinking knob, as the model publishes it. An unknown value is a rejected request
/// rather than a silently dropped setting: the model would 400 on it anyway.
fn optionalReasoningEffort(value: ?std.json.Value) RequestError![]const u8 {
    const effort = value orelse return "";
    if (effort == .null) return "";
    if (effort != .string) return error.InvalidField;
    if (effort.string.len == 0) return "";
    if (!std.mem.eql(u8, effort.string, "off") and openai.effortIndex(effort.string) == null) return error.InvalidField;
    return effort.string;
}

/// The selected model's context window. Absent or `0` means the host has no catalog entry
/// for it — a local model — and compaction stays off for the thread.
fn optionalContextLength(value: ?std.json.Value) RequestError!usize {
    const length = value orelse return 0;
    if (length == .null) return 0;
    if (length != .integer or length.integer < 0) return error.InvalidField;
    return std.math.cast(usize, length.integer) orelse return error.InvalidField;
}

fn optionalCredentialEnv(value: ?std.json.Value) RequestError![]const u8 {
    const credential = value orelse return "";
    if (credential == .null) return "";
    if (credential != .string or credential.string.len > 128 or !std.unicode.utf8ValidateSlice(credential.string)) return error.InvalidField;
    if (credential.string.len == 0) return "";
    if (!std.ascii.isAlphabetic(credential.string[0]) and credential.string[0] != '_') return error.InvalidField;
    for (credential.string[1..]) |byte| if (!std.ascii.isAlphanumeric(byte) and byte != '_') return error.InvalidField;
    return credential.string;
}

fn optionalBool(value: ?std.json.Value, default: bool) RequestError!bool {
    const boolean = value orelse return default;
    if (boolean != .bool) return error.InvalidField;
    return boolean.bool;
}

fn parseScreenContext(value: ?std.json.Value) RequestError!?[]const u8 {
    const context = value orelse return null;
    if (context != .string or context.string.len > max_screen_context_bytes or !std.unicode.utf8ValidateSlice(context.string)) return error.InvalidField;
    if (!std.mem.startsWith(u8, context.string, jpeg_data_url_prefix)) return error.InvalidField;
    const encoded = context.string[jpeg_data_url_prefix.len..];
    if (encoded.len == 0 or encoded.len % 4 != 0) return error.InvalidField;
    var padding: usize = 0;
    for (encoded, 0..) |byte, index| {
        switch (byte) {
            'A'...'Z', 'a'...'z', '0'...'9', '+', '/' => if (padding != 0) return error.InvalidField,
            '=' => {
                padding += 1;
                if (padding > 2 or index < encoded.len - 2) return error.InvalidField;
            },
            else => return error.InvalidField,
        }
    }
    return context.string;
}

fn parseSkillContext(value: ?std.json.Value) RequestError!?[]const u8 {
    const context = value orelse return null;
    if (context != .string or context.string.len == 0 or context.string.len > max_skill_context_bytes or !std.unicode.utf8ValidateSlice(context.string) or std.mem.trim(u8, context.string, " \t\r\n").len == 0) return error.InvalidField;
    for (context.string) |byte| if ((byte < ' ' and byte != '\t' and byte != '\r' and byte != '\n') or byte == 0x7f) return error.InvalidField;
    return context.string;
}

fn parseKnowledge(
    value: ?std.json.Value,
    buffer: *[max_relevant_pages]openai.KnowledgePage,
) RequestError![]const openai.KnowledgePage {
    const pages = value orelse return buffer[0..0];
    if (pages != .array or pages.array.items.len > max_relevant_pages) return error.InvalidField;
    for (pages.array.items, 0..) |page, index| {
        if (page != .object) return error.InvalidField;
        buffer[index] = .{
            .id = try requiredString(page.object, "id", 96),
            .title = try requiredString(page.object, "title", 256),
            .summary = try requiredString(page.object, "summary", 4 * 1024),
            .body = try requiredString(page.object, "body", max_text_bytes),
        };
        if (!std.unicode.utf8ValidateSlice(buffer[index].title) or
            !std.unicode.utf8ValidateSlice(buffer[index].summary) or
            !std.unicode.utf8ValidateSlice(buffer[index].body)) return error.InvalidField;
    }
    return buffer[0..pages.array.items.len];
}

fn importMessages(alloc: std.mem.Allocator, thread: *Thread, value: std.json.Value) !void {
    if (value != .array or value.array.items.len > max_imported_messages) return error.InvalidField;
    try thread.messages.ensureUnusedCapacity(alloc, value.array.items.len);
    var total_bytes: usize = 0;
    for (value.array.items) |entry| {
        if (entry != .object) return error.InvalidField;
        const role = try canonicalRole(try requiredString(entry.object, "role", 16));
        const content = try requiredString(entry.object, "content", max_text_bytes);
        if (!std.unicode.utf8ValidateSlice(content)) return error.InvalidField;
        total_bytes = std.math.add(usize, total_bytes, content.len) catch return error.InvalidField;
        if (total_bytes > max_imported_content_bytes) return error.InvalidField;

        const message_id = try std.fmt.allocPrint(alloc, "message-{d}", .{thread.messages.items.len + 1});
        const owned_content = alloc.dupe(u8, content) catch |err| {
            alloc.free(message_id);
            return err;
        };
        thread.messages.appendAssumeCapacity(.{ .id = message_id, .role = role, .content = owned_content });
    }
}

fn canonicalRole(role: []const u8) RequestError![]const u8 {
    if (std.mem.eql(u8, role, "user")) return "user";
    if (std.mem.eql(u8, role, "assistant")) return "assistant";
    if (std.mem.eql(u8, role, "system")) return "system";
    return error.InvalidField;
}

fn validateSources(value: ?std.json.Value) RequestError![]const std.json.Value {
    const sources = value orelse return &.{};
    if (sources != .array or sources.array.items.len > 16) return error.InvalidField;
    for (sources.array.items) |source| {
        if (source != .string or source.string.len == 0 or source.string.len > 2048) return error.InvalidField;
    }
    return sources.array.items;
}

fn titleFrom(text: []const u8) []const u8 {
    const trimmed = std.mem.trim(u8, text, " \t\r\n");
    var end = std.mem.indexOfAny(u8, trimmed, ".\n") orelse trimmed.len;
    end = @min(end, 120);
    while (end > 0 and !std.unicode.utf8ValidateSlice(trimmed[0..end])) end -= 1;
    if (end == 0) return "Untitled page";
    return trimmed[0..end];
}

const JsonReply = struct {
    value: std.json.Parsed(std.json.Value),
    input_tokens: usize,
    output_tokens: usize,
};

/// Models wrap JSON in prose or a code fence often enough that trusting the whole body is
/// not worth it; take the outermost braces and let the parser reject the rest.
fn jsonSpan(text: []const u8) ?[]const u8 {
    const start = std.mem.indexOfScalar(u8, text, '{') orelse return null;
    const end = std.mem.lastIndexOfScalar(u8, text, '}') orelse return null;
    if (end < start) return null;
    return text[start .. end + 1];
}

/// Model output is best effort: a missing, wrong-typed, or oversized field falls back to
/// `default` rather than costing the user the whole page.
fn modelString(value: ?std.json.Value, default: []const u8, max: usize) []const u8 {
    const text = value orelse return default;
    if (text != .string) return default;
    const trimmed = std.mem.trim(u8, text.string, " \t\r\n");
    if (trimmed.len == 0 or trimmed.len > max or !std.unicode.utf8ValidateSlice(trimmed)) return default;
    return trimmed;
}

fn parseCategories(value: ?std.json.Value) RequestError![]const std.json.Value {
    const categories = value orelse return &.{};
    if (categories != .array or categories.array.items.len > max_categories) return error.InvalidField;
    for (categories.array.items) |category| {
        if (category != .string or category.string.len == 0 or
            category.string.len > max_category_bytes or
            !std.unicode.utf8ValidateSlice(category.string)) return error.InvalidField;
    }
    return categories.array.items;
}

/// The base's own taxonomy wins over the built-in keyword rules: a base the user curated
/// should not gain a category it has never used just because no provider was configured.
// ponytail: substring match over the user's categories; the provider path does the real thing.
fn chooseCategory(categories: []const std.json.Value, text: []const u8) []const u8 {
    if (categories.len == 0) return classify(text);
    const guess = classify(text);
    for (categories) |category| if (std.ascii.eqlIgnoreCase(category.string, guess)) return category.string;
    for (categories) |category| if (containsIgnoreCase(text, category.string)) return category.string;
    return categories[0].string;
}

const block_types_help =
    \\Each block needs a unique kebab-case id and a "fallback" holding the same content as plain Markdown. Use exactly these types and payload keys:
    \\- "rich-text": {"markdown": string} — a written section. Headings (##), bold, links and lists render; keep to that subset.
    \\- "stats": {"items": [{"label": string, "value": string, "detail": string}]} — at most 4 figures lifted from the material, never invented.
    \\- "list": {"items": [string], "ordered": boolean}
    \\- "table": {"headers": [string], "rows": [[string]]}
    \\- "chart": {"kind": "bar" | "line" | "area", "labels": [string], "values": [number], "caption": string} — at most 8 points, and only when the material carries real numbers. Bars compare things, lines and areas show a series over time. Never invent data.
    \\- "citations": {"items": [{"title": string, "url": string}]}
;

const document_shape_help =
    \\Decide the best way to present this particular material, then author as many blocks as it deserves, in reading order:
    \\1. A "rich-text" block with the id "summary": two or three sentences on what this is and why it is worth keeping. Always first.
    \\2. A "stats" block when the material pins down figures, and a "chart" whenever it carries numbers that can be compared or tracked.
    \\3. The supporting detail, in sections: "rich-text" blocks that each open with a "## heading", plus "list" and "table" blocks wherever they read better than prose.
    \\4. A "citations" block when the material names sources it draws on.
    \\5. A closing block with the id "how-to-apply": what the reader should do with this.
;

fn documentPrompt(alloc: std.mem.Allocator, text: []const u8, categories: []const std.json.Value) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    try out.writer.writeAll(
        \\You are building one page for the user's personal knowledge base. Reply with a single JSON object and nothing else — no prose around it, no code fence.
        \\
        \\{"title": string, "category": string, "summary": string, "interesting_points": [string], "counterarguments": [string], "blocks": [{"id": string, "type": string, "payload": object, "fallback": string}]}
        \\
        \\"blocks" is the page itself. Pictures from the source are added around your blocks, so never describe images.
        \\
    );
    try out.writer.writeAll(document_shape_help);
    try out.writer.writeAll("\n\n");
    try out.writer.writeAll(block_types_help);
    try out.writer.writeByte('\n');
    if (categories.len != 0) {
        try out.writer.writeAll("\nFile this under one of the categories the user already keeps: ");
        for (categories, 0..) |category, index| {
            if (index != 0) try out.writer.writeAll(", ");
            try jsonString(&out.writer, category.string);
        }
        try out.writer.writeAll(". Propose a new category only when none of them fit.\n");
    }
    try out.writer.print("\nMaterial to turn into the page:\n{s}\n", .{text});
    return out.toOwnedSlice();
}

fn revisionPrompt(alloc: std.mem.Allocator, instruction: []const u8, current: []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    try out.writer.writeAll(
        \\You are editing one page in the user's knowledge base. Reply with a single JSON object and nothing else — no prose around it, no code fence.
        \\
        \\{"blocks": [{"id": string, "type": string, "payload": object, "fallback": string}]}
        \\
        \\Return the complete page after the edit, not only the blocks you changed, and keep the id of every block you leave alone.
        \\
    );
    try out.writer.writeAll(block_types_help);
    try out.writer.print("\n\nCurrent page:\n{s}\n\nRequested change:\n{s}\n", .{ current, instruction });
    return out.toOwnedSlice();
}

fn writeStringArray(writer: *std.Io.Writer, value: ?std.json.Value) !void {
    try writer.writeByte('[');
    const items = value orelse {
        try writer.writeByte(']');
        return;
    };
    if (items == .array) {
        var emitted: usize = 0;
        for (items.array.items) |item| {
            if (emitted == max_document_points) break;
            const text = modelString(item, "", 2048);
            if (text.len == 0) continue;
            if (emitted != 0) try writer.writeByte(',');
            try jsonString(writer, text);
            emitted += 1;
        }
    }
    try writer.writeByte(']');
}

/// Copies through the blocks that are structurally whole and drops the rest. A model that
/// mangles one block costs the user that block, not the document.
fn writeBlocks(alloc: std.mem.Allocator, writer: *std.Io.Writer, value: ?std.json.Value) !void {
    try writer.writeByte('[');
    const blocks = value orelse {
        try writer.writeByte(']');
        return;
    };
    if (blocks == .array) {
        var emitted: usize = 0;
        for (blocks.array.items) |block| {
            if (emitted == max_document_blocks) break;
            if (block != .object) continue;
            const block_id = modelString(block.object.get("id"), "", 96);
            const block_type = modelString(block.object.get("type"), "", 64);
            const fallback = modelString(block.object.get("fallback"), "", max_text_bytes);
            if (block_id.len == 0 or block_type.len == 0 or fallback.len == 0) continue;
            const payload = block.object.get("payload") orelse continue;
            if (payload != .object) continue;
            const payload_json = try stringifyValue(alloc, payload);
            defer alloc.free(payload_json);

            if (emitted != 0) try writer.writeByte(',');
            try writer.writeAll("{\"id\":");
            try jsonString(writer, block_id);
            try writer.writeAll(",\"type\":");
            try jsonString(writer, block_type);
            try writer.writeAll(",\"payload\":");
            try writer.writeAll(payload_json);
            try writer.writeAll(",\"fallback\":");
            try jsonString(writer, fallback);
            try writer.writeByte('}');
            emitted += 1;
        }
    }
    try writer.writeByte(']');
}

fn classify(text: []const u8) []const u8 {
    // ponytail: Keyword fallback is context-blind; replace it when provider-backed analysis lands.
    if (containsIgnoreCase(text, "arxiv") or containsIgnoreCase(text, "paper") or containsIgnoreCase(text, "research") or containsIgnoreCase(text, "study")) return "research";
    if (containsIgnoreCase(text, "bug") or containsIgnoreCase(text, "code") or containsIgnoreCase(text, "software")) return "technology";
    if (containsIgnoreCase(text, "money") or containsIgnoreCase(text, "market") or containsIgnoreCase(text, "finance")) return "finance";
    if (containsIgnoreCase(text, "health") or containsIgnoreCase(text, "medical")) return "health";
    return "general";
}

fn fallbackReply(
    alloc: std.mem.Allocator,
    content: []const u8,
    knowledge: []const openai.KnowledgePage,
) ![]u8 {
    const subject = titleFrom(content);
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    try out.writer.print("I received your message about \"{s}\".", .{subject});
    if (knowledge.len != 0) {
        try out.writer.print(" I found {d} relevant knowledge page", .{knowledge.len});
        if (knowledge.len != 1) try out.writer.writeByte('s');
        try out.writer.writeAll(": ");
        for (knowledge, 0..) |page, index| {
            if (index != 0) try out.writer.writeAll(", ");
            try out.writer.print("\"{s}\"", .{page.title});
        }
        try out.writer.writeByte('.');
    }
    try out.writer.writeAll(" This local fallback keeps the conversation in this thread; connect a provider for a model-generated answer.");
    return out.toOwnedSlice();
}

fn matches(tool: Tool, query: []const u8) bool {
    return containsIgnoreCase(tool.name, query) or containsIgnoreCase(tool.description, query) or containsIgnoreCase(tool.server, query);
}

fn containsIgnoreCase(haystack: []const u8, needle: []const u8) bool {
    return std.ascii.indexOfIgnoreCase(haystack, needle) != null;
}

fn stringifyValue(alloc: std.mem.Allocator, value: std.json.Value) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    try std.json.Stringify.value(value, .{}, &out.writer);
    return out.toOwnedSlice();
}

fn jsonString(writer: *std.Io.Writer, value: []const u8) !void {
    try std.json.Stringify.value(value, .{}, writer);
}

fn writeMessage(writer: *std.Io.Writer, message: Message) !void {
    try writer.writeAll("{\"id\":");
    try jsonString(writer, message.id);
    try writer.writeAll(",\"role\":");
    try jsonString(writer, message.role);
    try writer.writeAll(",\"content\":");
    try jsonString(writer, message.content);
    try writer.writeByte('}');
}

fn writeThreadSummary(writer: *std.Io.Writer, thread: Thread) !void {
    try writer.writeAll("{\"id\":");
    try jsonString(writer, thread.id);
    try writer.writeAll(",\"title\":");
    try jsonString(writer, thread.title);
    try writer.print(",\"message_count\":{d}}}", .{thread.messages.items.len});
}

fn responseStart(writer: *std.Io.Writer, id: []const u8) !void {
    try writer.writeAll("{\"id\":");
    try jsonString(writer, id);
    try writer.writeAll(",\"ok\":true,\"result\":");
}

fn responseError(alloc: std.mem.Allocator, id: ?[]const u8, code: []const u8, message: []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    try out.writer.writeAll("{\"id\":");
    if (id) |value| try jsonString(&out.writer, value) else try out.writer.writeAll("null");
    try out.writer.writeAll(",\"ok\":false,\"error\":{\"code\":");
    try jsonString(&out.writer, code);
    try out.writer.writeAll(",\"message\":");
    try jsonString(&out.writer, message);
    try out.writer.writeAll("}}\n");
    return out.toOwnedSlice();
}

/// The wire code and message for an error, plus whatever the provider itself said about
/// it. That last part is the difference between "provider rejected the request" and the
/// sentence naming the model, the policy, or the field that was wrong.
fn requestFailure(alloc: std.mem.Allocator, id: []const u8, err: anyerror, detail: []const u8) ![]u8 {
    const Failure = struct { code: []const u8, message: []const u8 };
    const failure: Failure = switch (err) {
        error.CatalogTooLarge => .{ .code = "catalog_too_large", .message = "catalog exceeds 256 tools" },
        error.DuplicateTool => .{ .code = "duplicate_tool", .message = "tool names must be globally unique" },
        error.NoSearchResult => .{ .code = "tool_not_searched", .message = "select an exact result from the preceding search" },
        error.ToolNotFound => .{ .code = "tool_not_found", .message = "selected tool is no longer available" },
        error.ScreenContextRequiresProvider => .{ .code = "screen_context_requires_provider", .message = "pick a model before sending a screenshot: Emma's built-in reply cannot look at one" },
        error.SkillRequiresProvider => .{ .code = "skill_requires_provider", .message = "pick a model before using a skill: Emma's built-in reply cannot run one" },
        error.ToolsRequireProvider => .{ .code = "tools_require_provider", .message = "pick a model before using tools: Emma's built-in reply cannot call them" },
        error.NoPendingToolCalls => .{ .code = "no_pending_tool_calls", .message = "this thread has no tool calls awaiting results" },
        error.UnexpectedToolResult => .{ .code = "unexpected_tool_result", .message = "tool result does not answer a pending tool call" },
        error.RevisionRequiresProvider => .{ .code = "revision_requires_provider", .message = "rewriting a document requires a configured model endpoint" },
        error.ThreadNotFound => .{ .code = "thread_not_found", .message = "thread does not exist in this process" },
        error.InvalidRequest, error.InvalidField => .{ .code = "invalid_field", .message = "request contains a missing, invalid, or oversized field" },
        // Its own arm, because it is the one a person causes by hand: a pasted endpoint.
        error.InvalidProviderConfig => .{ .code = "invalid_field", .message = "Emma will not send to that endpoint: use an OpenRouter https address, or an http address on this Mac such as http://localhost:11434/v1" },
        error.ProviderRequestTooLarge => .{ .code = "provider_request_too_large", .message = "this conversation is too long to send — start a new thread, or pick a model with a bigger context window" },
        error.ProviderResponseTooLarge => .{ .code = "provider_response_too_large", .message = "the reply was longer than Emma can accept — ask for a shorter answer, or pick another model" },
        error.ProviderCredentialUnavailable => .{ .code = "provider_credential_unavailable", .message = "no usable API key for this model — add one in Settings, then try again" },
        error.ProviderAuthenticationFailed => .{ .code = "provider_authentication_failed", .message = "the provider rejected your API key — check it is correct and still active in your provider account" },
        error.ProviderRateLimited => .{ .code = "provider_rate_limited", .message = "you are sending faster than this model allows — wait a moment and try again" },
        error.ProviderTimeout => .{ .code = "provider_timeout", .message = "no answer within 60 seconds — the model may be loading or overloaded; try again or pick a smaller model" },
        error.ProviderUnavailable => .{ .code = "provider_unavailable", .message = "could not reach the model — if it runs on this Mac, start it; otherwise check the endpoint address and your connection" },
        error.ProviderRequestRejected => .{ .code = "provider_request_rejected", .message = "provider rejected the request: the model id may be wrong or the model may not accept the attached images, tools, or reasoning setting" },
        error.ProviderPaymentRequired => .{ .code = "provider_payment_required", .message = "provider requires credit for this model: pick a free model or top up the account" },
        error.ProviderServerError => .{ .code = "provider_server_error", .message = "provider had a server-side failure; the upstream model may be down" },
        error.ProviderStreamError => .{ .code = "provider_stream_error", .message = "the model stopped partway through its answer — try again, or pick another model" },
        // `redirect_behavior` is `.unhandled`, so in practice this is a 3xx: an endpoint
        // that redirects, which is a base URL with the wrong scheme or a missing /v1.
        error.ProviderHttpError => .{ .code = "provider_http_error", .message = "the endpoint redirected the request — use its exact address, including https and the /v1 path" },
        error.InvalidProviderResponse => .{ .code = "invalid_provider_response", .message = "Emma could not read this model's reply — it may not support tools; try a different model" },
        else => return err,
    };
    if (detail.len == 0) return responseError(alloc, id, failure.code, failure.message);
    const message = try std.fmt.allocPrint(alloc, "{s} · {s}", .{ failure.message, detail });
    defer alloc.free(message);
    return responseError(alloc, id, failure.code, message);
}

fn expectValidResponse(response: []const u8) !void {
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, std.mem.trimEnd(u8, response, "\n"), .{});
    defer parsed.deinit();
    try std.testing.expect(parsed.value == .object);
}

test "parser preserves valid ids and returns structured field errors" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);
    const response = try state.handle(std.testing.allocator, "{\"id\":\"req-7\",\"type\":\"analyze\",\"text\":42}");
    defer std.testing.allocator.free(response);
    try expectValidResponse(response);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"id\":\"req-7\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"code\":\"invalid_field\"") != null);
}

test "NDJSON reader rejects oversized lines" {
    const input = try std.testing.allocator.alloc(u8, max_line_bytes + 2);
    defer std.testing.allocator.free(input);
    @memset(input, 'x');
    input[input.len - 1] = '\n';
    var reader = std.Io.Reader.fixed(input);
    try std.testing.expectError(error.LineTooLarge, readLine(std.testing.allocator, &reader));
}

test "thread messages persist user and general assistant roles" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);
    const created = try state.handle(std.testing.allocator, "{\"id\":\"1\",\"type\":\"thread_create\",\"title\":\"General\"}");
    defer std.testing.allocator.free(created);
    try expectValidResponse(created);
    const turn = try state.handle(std.testing.allocator, "{\"id\":\"2\",\"type\":\"thread_message\",\"thread_id\":\"thread-1\",\"content\":\"What should I do next?\",\"knowledge\":[{\"id\":\"page-00000000000\",\"title\":\"Release checklist\",\"summary\":\"Ship safely\",\"body\":\"Run every check\"}]}");
    defer std.testing.allocator.free(turn);
    try expectValidResponse(turn);
    try std.testing.expect(std.mem.indexOf(u8, turn, "\"role\":\"assistant\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, turn, "\"tool_calls\":[]") != null);
    try std.testing.expect(std.mem.indexOf(u8, turn, "found 1 relevant knowledge page") != null);
    const fetched = try state.handle(std.testing.allocator, "{\"id\":\"3\",\"type\":\"thread_get\",\"thread_id\":\"thread-1\"}");
    defer std.testing.allocator.free(fetched);
    try expectValidResponse(fetched);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, fetched, "\"role\":\"user\""));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, fetched, "\"role\":\"assistant\""));
}

test "a turn's own tool results do not trim the prompt away" {
    const alloc = std.testing.allocator;
    // Eight full tool results: well past the 96 KB import guard, which is what used
    // to eat the opening prompt and leave the next queued message reading as the
    // first thing ever said in the thread.
    const Fixture = struct {
        fn load(window: usize) !Thread {
            var thread: Thread = .{
                .id = try alloc.dupe(u8, "thread-1"),
                .title = try alloc.dupe(u8, "Shooter"),
                .context_length = window,
            };
            errdefer thread.deinit(alloc);
            try thread.messages.append(alloc, .{ .id = try alloc.dupe(u8, "message-1"), .role = "user", .content = try alloc.dupe(u8, "build the shooter") });
            for (0..8) |index| {
                const content = try alloc.alloc(u8, max_tool_result_bytes);
                @memset(content, 'x');
                try thread.messages.append(alloc, .{ .id = try std.fmt.allocPrint(alloc, "message-{d}", .{index + 2}), .role = "assistant", .content = content });
                thread.trimHistory(alloc);
            }
            return thread;
        }
    };
    var known = try Fixture.load(200_000);
    defer known.deinit(alloc);
    try std.testing.expectEqualStrings("build the shooter", known.messages.items[0].content);
    // No reported window means nothing compacts, so the old guard is still the only
    // thing standing between a long turn and a request no provider would take.
    var unknown = try Fixture.load(0);
    defer unknown.deinit(alloc);
    try std.testing.expect(unknown.contentBytes() <= max_imported_content_bytes);
}

test "cached thread history stays inside rehydration limits" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);
    const created = try state.handle(std.testing.allocator, "{\"id\":\"1\",\"type\":\"thread_create\"}");
    defer std.testing.allocator.free(created);

    for (0..140) |index| {
        const request = try std.fmt.allocPrint(std.testing.allocator, "{{\"id\":\"turn-{d}\",\"type\":\"thread_message\",\"thread_id\":\"thread-1\",\"content\":\"hello\"}}", .{index});
        defer std.testing.allocator.free(request);
        const response = try state.handle(std.testing.allocator, request);
        defer std.testing.allocator.free(response);
    }
    const large_content = try std.testing.allocator.alloc(u8, 60 * 1024);
    defer std.testing.allocator.free(large_content);
    @memset(large_content, 'x');
    for (0..2) |index| {
        const request = try std.fmt.allocPrint(std.testing.allocator, "{{\"id\":\"large-{d}\",\"type\":\"thread_message\",\"thread_id\":\"thread-1\",\"content\":\"{s}\"}}", .{ index, large_content });
        defer std.testing.allocator.free(request);
        const response = try state.handle(std.testing.allocator, request);
        defer std.testing.allocator.free(response);
    }
    const thread = state.findThread("thread-1").?;
    var content_bytes: usize = 0;
    for (thread.messages.items) |message| content_bytes += message.content.len;
    try std.testing.expect(thread.messages.items.len <= max_live_messages);
    try std.testing.expect(content_bytes <= max_live_content_bytes);
    try std.testing.expectEqualStrings("assistant", thread.messages.items[thread.messages.items.len - 1].role);
}

test "provider request keeps retrieved knowledge read-only" {
    const Fixture = struct {
        fn send(_: ?*anyopaque, alloc: std.mem.Allocator, _: openai.Config, payload: []const u8, tools_advertised: bool, _: ?openai.DeltaSink) anyerror!openai.Reply {
            var parsed = try std.json.parseFromSlice(std.json.Value, alloc, payload, .{});
            defer parsed.deinit();
            try std.testing.expect(parsed.value.object.get("tools") == null);
            const messages = parsed.value.object.get("messages").?.array.items;
            try std.testing.expectEqualStrings("system", messages[0].object.get("role").?.string);
            try std.testing.expect(std.mem.indexOf(u8, messages[0].object.get("content").?.string, "page-00000000000") != null);
            try std.testing.expect(std.mem.indexOf(u8, messages[0].object.get("content").?.string, "read-only") != null);

            return openai.parseResponse(
                alloc,
                "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"Read-only answer\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":13,\"completion_tokens\":4}}",
                tools_advertised,
            );
        }
    };

    var state: State = .{ .provider_transport = .{ .send_fn = Fixture.send } };
    defer state.deinit(std.testing.allocator);
    const created = try state.handle(std.testing.allocator, "{\"id\":\"1\",\"type\":\"thread_create\"}");
    defer std.testing.allocator.free(created);
    const turn = try state.handle(std.testing.allocator, "{\"id\":\"2\",\"type\":\"thread_message\",\"thread_id\":\"thread-1\",\"content\":\"Update it\",\"knowledge\":[{\"id\":\"page-00000000000\",\"title\":\"Page\",\"summary\":\"Summary\",\"body\":\"Body\"}],\"provider\":{\"base_url\":\"http://localhost:9999/v1\",\"model\":\"fixture\",\"credential_env\":\"EMMA_FIXTURE_KEY\"}}");
    defer std.testing.allocator.free(turn);
    try expectValidResponse(turn);
    try std.testing.expect(std.mem.indexOf(u8, turn, "Read-only answer") != null);
    try std.testing.expect(std.mem.indexOf(u8, turn, "knowledge_mutation") == null);

    const tool_call = "{\"choices\":[{\"message\":{\"content\":null,\"tool_calls\":[{\"type\":\"function\"}]},\"finish_reason\":\"tool_calls\"}]}";
    try std.testing.expectError(
        error.InvalidProviderResponse,
        openai.parseResponse(std.testing.allocator, tool_call, false),
    );
}

test "analyze files into the user's categories and authors real document blocks" {
    const Fixture = struct {
        fn send(_: ?*anyopaque, alloc: std.mem.Allocator, _: openai.Config, payload: []const u8, tools_advertised: bool, _: ?openai.DeltaSink) anyerror!openai.Reply {
            var parsed = try std.json.parseFromSlice(std.json.Value, alloc, payload, .{});
            defer parsed.deinit();
            const messages = parsed.value.object.get("messages").?.array.items;
            const prompt = messages[messages.len - 1].object.get("content").?.string;
            try std.testing.expect(std.mem.indexOf(u8, prompt, "\"Reading list\"") != null);
            try std.testing.expect(std.mem.indexOf(u8, prompt, "Attention is all you need") != null);
            // Prose around the JSON, plus one unusable block, is the realistic case.
            return openai.parseResponse(alloc,
                \\{"choices":[{"message":{"role":"assistant","content":"Here you go:\n{\"title\":\"Transformers\",\"category\":\"Reading list\",\"summary\":\"A short read.\",\"interesting_points\":[\"Self-attention scales\"],\"counterarguments\":[],\"blocks\":[{\"id\":\"overview\",\"type\":\"rich-text\",\"payload\":{\"markdown\":\"## Overview\"},\"fallback\":\"## Overview\"},{\"id\":\"broken\",\"type\":\"chart\",\"payload\":\"not-an-object\",\"fallback\":\"x\"},{\"id\":\"speedup\",\"type\":\"chart\",\"payload\":{\"kind\":\"bar\",\"label\":\"Speedup\",\"points\":[{\"label\":\"v1\",\"value\":2}]},\"fallback\":\"v1: 2\"}]}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}
            , tools_advertised);
        }
    };

    var state: State = .{ .provider_transport = .{ .send_fn = Fixture.send } };
    defer state.deinit(std.testing.allocator);
    const created = try state.handle(std.testing.allocator, "{\"id\":\"1\",\"type\":\"thread_create\"}");
    defer std.testing.allocator.free(created);

    const provider = "\"provider\":{\"base_url\":\"http://localhost:9999/v1\",\"model\":\"fixture\",\"credential_env\":\"EMMA_FIXTURE_KEY\"}";
    const analyzed = try state.handle(std.testing.allocator, "{\"id\":\"2\",\"type\":\"analyze\",\"thread_id\":\"thread-1\",\"text\":\"Attention is all you need\",\"categories\":[\"Reading list\",\"Recipes\"]," ++ provider ++ "}");
    defer std.testing.allocator.free(analyzed);
    try expectValidResponse(analyzed);
    try std.testing.expect(std.mem.indexOf(u8, analyzed, "\"category\":\"Reading list\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, analyzed, "\"model\":\"fixture\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, analyzed, "\"id\":\"speedup\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, analyzed, "\"broken\"") == null);
    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, analyzed, "\"fallback\":"));

    // Without a provider the page still lands in the user's taxonomy, never in an invented one.
    var offline: State = .{};
    defer offline.deinit(std.testing.allocator);
    const offline_thread = try offline.handle(std.testing.allocator, "{\"id\":\"1\",\"type\":\"thread_create\"}");
    defer std.testing.allocator.free(offline_thread);
    const local = try offline.handle(std.testing.allocator, "{\"id\":\"2\",\"type\":\"analyze\",\"thread_id\":\"thread-1\",\"text\":\"A paper on attention\",\"categories\":[\"Reading list\",\"Recipes\"]}");
    defer std.testing.allocator.free(local);
    try std.testing.expect(std.mem.indexOf(u8, local, "\"category\":\"Reading list\"") != null);

    const revised = try offline.handle(std.testing.allocator, "{\"id\":\"3\",\"type\":\"revise_document\",\"thread_id\":\"thread-1\",\"instruction\":\"Add a chart\",\"document\":[]}");
    defer std.testing.allocator.free(revised);
    try std.testing.expect(std.mem.indexOf(u8, revised, "revision_requires_provider") != null);
}

test "OpenRouter model catalog stays behind the provider transport" {
    const Fixture = struct {
        fn list(_: ?*anyopaque, alloc: std.mem.Allocator, config: openai.Config) !openai.ModelCatalog {
            try std.testing.expect(config.protect_data);
            try std.testing.expectEqualStrings("https://openrouter.ai/api/v1", config.base_url);
            return openai.parseModelCatalog(alloc,
                \\{"data":[{"id":"openai/gpt-oss-20b:free","name":"OpenAI: gpt-oss-20b (free)","context_length":131072,"architecture":{"input_modalities":["text","image","file"]},"pricing":{"prompt":"0","completion":"0"},"supported_parameters":["tools"]}]}
            );
        }
    };
    var state: State = .{ .provider_transport = .{ .list_models_fn = Fixture.list } };
    defer state.deinit(std.testing.allocator);
    const response = try state.handle(std.testing.allocator, "{\"id\":\"models-1\",\"type\":\"openrouter_models\",\"provider\":{\"base_url\":\"https://openrouter.ai/api/v1\",\"model\":\"openrouter/free\",\"credential_env\":\"OPENROUTER_API_KEY\",\"protect_data\":true}}");
    defer std.testing.allocator.free(response);
    try expectValidResponse(response);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"id\":\"openai/gpt-oss-20b:free\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"context_length\":131072") != null);
    // Text is universal and never listed; the extra inputs are what the picker marks.
    try std.testing.expect(std.mem.indexOf(u8, response, "\"input_modalities\":[\"image\",\"file\"]") != null);
}

test "provider fixture receives thread history and returns parsed content and usage" {
    const Fixture = struct {
        calls: usize = 0,

        fn send(raw_context: ?*anyopaque, alloc: std.mem.Allocator, config: openai.Config, payload: []const u8, tools_advertised: bool, _: ?openai.DeltaSink) anyerror!openai.Reply {
            const fixture: *@This() = @ptrCast(@alignCast(raw_context.?));
            fixture.calls += 1;
            try std.testing.expectEqualStrings("fixture-model", config.model);
            try std.testing.expect(std.mem.indexOf(u8, payload, config.credential_env) == null);
            try std.testing.expect(std.mem.indexOf(u8, payload, "image_url") == null);

            var parsed = try std.json.parseFromSlice(std.json.Value, alloc, payload, .{});
            defer parsed.deinit();
            const messages = parsed.value.object.get("messages").?.array.items;
            try std.testing.expectEqual(@as(usize, 4), messages.len);
            try std.testing.expectEqualStrings("system", messages[0].object.get("role").?.string);
            try std.testing.expectEqualStrings("Keep it brief", messages[0].object.get("content").?.string);
            try std.testing.expectEqualStrings("user", messages[1].object.get("role").?.string);
            try std.testing.expectEqualStrings("Start here", messages[1].object.get("content").?.string);
            try std.testing.expectEqualStrings("assistant", messages[2].object.get("role").?.string);
            try std.testing.expectEqualStrings("Prior answer", messages[2].object.get("content").?.string);
            try std.testing.expectEqualStrings("user", messages[3].object.get("role").?.string);
            try std.testing.expectEqualStrings("Continue", messages[3].object.get("content").?.string);

            return openai.parseResponse(
                alloc,
                "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"Fixture answer\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":7}}",
                tools_advertised,
            );
        }
    };

    var fixture: Fixture = .{};
    var state: State = .{ .provider_transport = .{ .context = &fixture, .send_fn = Fixture.send } };
    defer state.deinit(std.testing.allocator);
    const created = try state.handle(std.testing.allocator, "{\"id\":\"1\",\"type\":\"thread_create\",\"title\":\"Provider\",\"messages\":[{\"role\":\"system\",\"content\":\"Keep it brief\"},{\"role\":\"user\",\"content\":\"Start here\"},{\"role\":\"assistant\",\"content\":\"Prior answer\"}]}");
    defer std.testing.allocator.free(created);
    try std.testing.expect(std.mem.indexOf(u8, created, "\"message_count\":3") != null);
    const turn = try state.handle(std.testing.allocator, "{\"id\":\"2\",\"type\":\"thread_message\",\"thread_id\":\"thread-1\",\"content\":\"Continue\",\"provider\":{\"base_url\":\"http://127.0.0.1:9999/v1\",\"model\":\"fixture-model\",\"credential_env\":\"EMMA_FIXTURE_KEY\"}}");
    defer std.testing.allocator.free(turn);
    try expectValidResponse(turn);
    try std.testing.expectEqual(@as(usize, 1), fixture.calls);
    try std.testing.expect(std.mem.indexOf(u8, turn, "\"content\":\"Fixture answer\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, turn, "\"model\":\"fixture-model\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, turn, "\"input_tokens\":11,\"output_tokens\":7") != null);

    const rejected = try state.handle(std.testing.allocator, "{\"id\":\"3\",\"type\":\"thread_message\",\"thread_id\":\"thread-1\",\"content\":\"No plaintext remote request\",\"provider\":{\"base_url\":\"http://example.test/v1\",\"model\":\"fixture-model\",\"credential_env\":\"EMMA_FIXTURE_KEY\"}}");
    defer std.testing.allocator.free(rejected);
    try std.testing.expect(std.mem.indexOf(u8, rejected, "\"code\":\"invalid_field\"") != null);
    try std.testing.expectEqual(@as(usize, 1), fixture.calls);
}

/// A thread whose history alone is past 70% of a 200-token window: 20 turns of 40 bytes
/// is ~200 estimated tokens against a 140-token threshold.
fn fillThread(state: *State, turns: usize) !void {
    const created = try state.handle(std.testing.allocator, "{\"id\":\"1\",\"type\":\"thread_create\"}");
    defer std.testing.allocator.free(created);
    const thread = state.findThread("thread-1").?;
    for (0..turns) |index| {
        const content = try std.fmt.allocPrint(std.testing.allocator, "turn {d} said something worth summarising", .{index});
        errdefer std.testing.allocator.free(content);
        const id = try std.fmt.allocPrint(std.testing.allocator, "message-{d}", .{index + 1});
        try thread.messages.append(std.testing.allocator, .{
            .id = id,
            .role = if (index % 2 == 0) "user" else "assistant",
            .content = content,
        });
    }
}

const narrow_provider = "\"provider\":{\"base_url\":\"http://127.0.0.1:9999/v1\",\"model\":\"fixture\",\"credential_env\":\"EMMA_FIXTURE_KEY\",\"context_length\":200}";

test "a thread past 70% of the context window is compacted into one system summary" {
    const Fixture = struct {
        calls: usize = 0,

        fn send(raw_context: ?*anyopaque, alloc: std.mem.Allocator, _: openai.Config, payload: []const u8, tools_advertised: bool, _: ?openai.DeltaSink) anyerror!openai.Reply {
            const fixture: *@This() = @ptrCast(@alignCast(raw_context.?));
            fixture.calls += 1;
            if (fixture.calls == 1) {
                // The summary call carries the dropped turns and advertises nothing.
                try std.testing.expect(std.mem.indexOf(u8, payload, "Summarise the conversation below") != null);
                try std.testing.expect(std.mem.indexOf(u8, payload, "turn 0 said") != null);
                return openai.parseResponse(alloc, "{\"choices\":[{\"message\":{\"content\":\"They talked about turns.\"}}]}", tools_advertised);
            }
            var parsed = try std.json.parseFromSlice(std.json.Value, alloc, payload, .{});
            defer parsed.deinit();
            const messages = parsed.value.object.get("messages").?.array.items;
            try std.testing.expectEqualStrings("system", messages[0].object.get("role").?.string);
            try std.testing.expect(std.mem.startsWith(u8, messages[0].object.get("content").?.string, "Earlier in this conversation:"));
            try std.testing.expect(std.mem.indexOf(u8, payload, "turn 0 said") == null);
            return openai.parseResponse(alloc, "{\"choices\":[{\"message\":{\"content\":\"Compacted answer\"}}]}", tools_advertised);
        }
    };

    var fixture: Fixture = .{};
    var state: State = .{ .provider_transport = .{ .context = &fixture, .send_fn = Fixture.send } };
    defer state.deinit(std.testing.allocator);
    try fillThread(&state, 20);
    const turn = try state.handle(std.testing.allocator, "{\"id\":\"2\",\"type\":\"thread_message\",\"thread_id\":\"thread-1\",\"content\":\"Carry on\"," ++ narrow_provider ++ "}");
    defer std.testing.allocator.free(turn);
    try expectValidResponse(turn);
    try std.testing.expectEqual(@as(usize, 2), fixture.calls);
    const thread = state.findThread("thread-1").?;
    try std.testing.expectEqualStrings("system", thread.messages.items[0].role);
    try std.testing.expect(std.mem.indexOf(u8, thread.messages.items[0].content, "They talked about turns.") != null);
    // Half the turns went, and the summary stands in their place.
    try std.testing.expectEqual(@as(usize, 13), thread.messages.items.len);
}

test "a failed summary falls back to dropping the oldest messages" {
    const Fixture = struct {
        calls: usize = 0,

        fn send(raw_context: ?*anyopaque, alloc: std.mem.Allocator, _: openai.Config, payload: []const u8, tools_advertised: bool, _: ?openai.DeltaSink) anyerror!openai.Reply {
            const fixture: *@This() = @ptrCast(@alignCast(raw_context.?));
            fixture.calls += 1;
            if (std.mem.indexOf(u8, payload, "Summarise the conversation below") != null) return error.ProviderServerError;
            return openai.parseResponse(alloc, "{\"choices\":[{\"message\":{\"content\":\"Answer anyway\"}}]}", tools_advertised);
        }
    };

    var fixture: Fixture = .{};
    var state: State = .{ .provider_transport = .{ .context = &fixture, .send_fn = Fixture.send } };
    defer state.deinit(std.testing.allocator);
    try fillThread(&state, 20);
    const turn = try state.handle(std.testing.allocator, "{\"id\":\"2\",\"type\":\"thread_message\",\"thread_id\":\"thread-1\",\"content\":\"Carry on\"," ++ narrow_provider ++ "}");
    defer std.testing.allocator.free(turn);
    try expectValidResponse(turn);
    // The turn still answers, on the oldest-half-dropped history.
    try std.testing.expect(std.mem.indexOf(u8, turn, "Answer anyway") != null);
    const thread = state.findThread("thread-1").?;
    try std.testing.expectEqual(@as(usize, 12), thread.messages.items.len);
    try std.testing.expect(std.mem.indexOf(u8, thread.messages.items[0].content, "turn 10 said") != null);
}

test "screen context fails closed without a provider" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);
    const created = try state.handle(std.testing.allocator, "{\"id\":\"1\",\"type\":\"thread_create\"}");
    defer std.testing.allocator.free(created);
    const rejected = try state.handle(std.testing.allocator, "{\"id\":\"2\",\"type\":\"thread_message\",\"thread_id\":\"thread-1\",\"content\":\"Look\",\"screen_context\":\"data:image/jpeg;base64,/9j/\"}");
    defer std.testing.allocator.free(rejected);
    try std.testing.expect(std.mem.indexOf(u8, rejected, "screen_context_requires_provider") != null);
}

test "skill context fails closed without a provider" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);
    const created = try state.handle(std.testing.allocator, "{\"id\":\"1\",\"type\":\"thread_create\"}");
    defer std.testing.allocator.free(created);
    const rejected = try state.handle(std.testing.allocator, "{\"id\":\"2\",\"type\":\"thread_message\",\"thread_id\":\"thread-1\",\"content\":\"Use it\",\"skill_context\":\"Follow the selected procedure.\"}");
    defer std.testing.allocator.free(rejected);
    try std.testing.expect(std.mem.indexOf(u8, rejected, "skill_requires_provider") != null);
}

test "provider payload includes screen context only when explicitly attached" {
    const Fixture = struct {
        calls: usize = 0,

        fn send(raw_context: ?*anyopaque, alloc: std.mem.Allocator, _: openai.Config, payload: []const u8, tools_advertised: bool, _: ?openai.DeltaSink) anyerror!openai.Reply {
            const fixture: *@This() = @ptrCast(@alignCast(raw_context.?));
            fixture.calls += 1;
            var parsed = try std.json.parseFromSlice(std.json.Value, alloc, payload, .{});
            defer parsed.deinit();
            const messages = parsed.value.object.get("messages").?.array.items;
            const user = messages[messages.len - 1].object;
            if (fixture.calls == 1) {
                try std.testing.expect(user.get("content").? == .array);
                const parts = user.get("content").?.array.items;
                try std.testing.expectEqualStrings("image_url", parts[1].object.get("type").?.string);
                try std.testing.expectEqualStrings("data:image/jpeg;base64,/9j/", parts[1].object.get("image_url").?.object.get("url").?.string);
            } else {
                try std.testing.expect(user.get("content").? == .string);
            }
            return openai.parseResponse(alloc, "{\"choices\":[{\"message\":{\"content\":\"ok\"}}]}", tools_advertised);
        }
    };

    var fixture: Fixture = .{};
    var state: State = .{ .provider_transport = .{ .context = &fixture, .send_fn = Fixture.send } };
    defer state.deinit(std.testing.allocator);
    const created = try state.handle(std.testing.allocator, "{\"id\":\"1\",\"type\":\"thread_create\"}");
    defer std.testing.allocator.free(created);
    const attached = try state.handle(std.testing.allocator, "{\"id\":\"2\",\"type\":\"thread_message\",\"thread_id\":\"thread-1\",\"content\":\"Look\",\"screen_context\":\"data:image/jpeg;base64,/9j/\",\"provider\":{\"base_url\":\"http://127.0.0.1:9999/v1\",\"model\":\"fixture\",\"credential_env\":\"EMMA_FIXTURE_KEY\"}}");
    defer std.testing.allocator.free(attached);
    const ordinary = try state.handle(std.testing.allocator, "{\"id\":\"3\",\"type\":\"thread_message\",\"thread_id\":\"thread-1\",\"content\":\"Again\",\"provider\":{\"base_url\":\"http://127.0.0.1:9999/v1\",\"model\":\"fixture\",\"credential_env\":\"EMMA_FIXTURE_KEY\"}}");
    defer std.testing.allocator.free(ordinary);
    try std.testing.expectEqual(@as(usize, 2), fixture.calls);
}

const computer_tool = "\"tools\":[{\"name\":\"click\",\"description\":\"Click the screen\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"x\":{\"type\":\"number\"}}}}]";
const computer_provider = "\"provider\":{\"base_url\":\"http://127.0.0.1:9999/v1\",\"model\":\"fixture\",\"credential_env\":\"EMMA_FIXTURE_KEY\"}";
const tool_call_body = "{\"choices\":[{\"message\":{\"content\":null,\"tool_calls\":[{\"id\":\"call-a\",\"type\":\"function\",\"function\":{\"name\":\"click\",\"arguments\":\"{\\\"x\\\":10}\"}}]},\"finish_reason\":\"tool_calls\"}]}";

test "tool calls are accepted only when the request advertised tools" {
    const Fixture = struct {
        fn send(_: ?*anyopaque, alloc: std.mem.Allocator, _: openai.Config, payload: []const u8, tools_advertised: bool, _: ?openai.DeltaSink) anyerror!openai.Reply {
            var parsed = try std.json.parseFromSlice(std.json.Value, alloc, payload, .{});
            defer parsed.deinit();
            try std.testing.expectEqual(tools_advertised, parsed.value.object.get("tools") != null);
            return openai.parseResponse(alloc, tool_call_body, tools_advertised);
        }
    };

    var state: State = .{ .provider_transport = .{ .send_fn = Fixture.send } };
    defer state.deinit(std.testing.allocator);
    const created = try state.handle(std.testing.allocator, "{\"id\":\"1\",\"type\":\"thread_create\"}");
    defer std.testing.allocator.free(created);

    const advertised = try state.handle(std.testing.allocator, "{\"id\":\"2\",\"type\":\"thread_message\",\"thread_id\":\"thread-1\",\"content\":\"Open the browser\"," ++ computer_tool ++ "," ++ computer_provider ++ "}");
    defer std.testing.allocator.free(advertised);
    try expectValidResponse(advertised);
    try std.testing.expect(std.mem.indexOf(u8, advertised, "\"tool_calls\":[{\"id\":\"call-a\",\"name\":\"click\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, advertised, "\"step\":1") != null);

    const bare = try state.handle(std.testing.allocator, "{\"id\":\"3\",\"type\":\"thread_message\",\"thread_id\":\"thread-1\",\"content\":\"No tools here\"," ++ computer_provider ++ "}");
    defer std.testing.allocator.free(bare);
    try std.testing.expect(std.mem.indexOf(u8, bare, "invalid_provider_response") != null);

    const no_provider = try state.handle(std.testing.allocator, "{\"id\":\"4\",\"type\":\"thread_message\",\"thread_id\":\"thread-1\",\"content\":\"Local only\"," ++ computer_tool ++ "}");
    defer std.testing.allocator.free(no_provider);
    try std.testing.expect(std.mem.indexOf(u8, no_provider, "tools_require_provider") != null);
}

test "the tool step ceiling ends the turn with a real message" {
    const Fixture = struct {
        fn send(_: ?*anyopaque, alloc: std.mem.Allocator, _: openai.Config, _: []const u8, tools_advertised: bool, _: ?openai.DeltaSink) anyerror!openai.Reply {
            return openai.parseResponse(alloc, tool_call_body, tools_advertised);
        }
    };

    var state: State = .{ .provider_transport = .{ .send_fn = Fixture.send } };
    defer state.deinit(std.testing.allocator);
    const created = try state.handle(std.testing.allocator, "{\"id\":\"1\",\"type\":\"thread_create\"}");
    defer std.testing.allocator.free(created);
    const first = try state.handle(std.testing.allocator, "{\"id\":\"2\",\"type\":\"thread_message\",\"thread_id\":\"thread-1\",\"content\":\"Keep going\"," ++ computer_tool ++ "," ++ computer_provider ++ "}");
    defer std.testing.allocator.free(first);
    try expectValidResponse(first);

    const submit = "{\"id\":\"3\",\"type\":\"thread_tool_result\",\"thread_id\":\"thread-1\",\"results\":[{\"id\":\"call-a\",\"content\":\"clicked\"}]," ++ computer_tool ++ "," ++ computer_provider ++ "}";
    var step: usize = 0;
    while (step < max_tool_steps) : (step += 1) {
        const response = try state.handle(std.testing.allocator, submit);
        defer std.testing.allocator.free(response);
        try expectValidResponse(response);
        if (step + 1 < max_tool_steps) {
            try std.testing.expect(std.mem.indexOf(u8, response, "\"name\":\"click\"") != null);
            continue;
        }
        // The ceiling turn is a plain assistant message with no further calls.
        try std.testing.expect(std.mem.indexOf(u8, response, "\"tool_calls\":[]") != null);
        const ceiling = try std.fmt.allocPrint(std.testing.allocator, "I stopped after {d} tool steps", .{max_tool_steps});
        defer std.testing.allocator.free(ceiling);
        try std.testing.expect(std.mem.indexOf(u8, response, ceiling) != null);
    }

    const orphan = try state.handle(std.testing.allocator, submit);
    defer std.testing.allocator.free(orphan);
    try std.testing.expect(std.mem.indexOf(u8, orphan, "no_pending_tool_calls") != null);
}

test "search returns compact metadata without schemas" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);
    const catalog = try state.handle(std.testing.allocator, "{\"id\":\"1\",\"type\":\"mcp_catalog\",\"servers\":[{\"name\":\"files\",\"tools\":[{\"name\":\"read_file\",\"description\":\"Read workspace text\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}}}}]}]}");
    defer std.testing.allocator.free(catalog);
    const response = try state.handle(std.testing.allocator, "{\"id\":\"2\",\"type\":\"mcp_search_tools\",\"query\":\"workspace\"}");
    defer std.testing.allocator.free(response);
    try expectValidResponse(response);
    try std.testing.expect(std.mem.indexOf(u8, response, "read_file") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "inputSchema") == null);
    try std.testing.expect(std.mem.indexOf(u8, response, "properties") == null);
}

test "selection requires the preceding search and advertises exactly one schema" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);
    const catalog = try state.handle(std.testing.allocator, "{\"id\":\"1\",\"type\":\"mcp_catalog\",\"servers\":[{\"name\":\"files\",\"tools\":[{\"name\":\"read_file\",\"description\":\"Read\",\"input_schema\":{\"type\":\"object\"}}]}]}");
    defer std.testing.allocator.free(catalog);
    const rejected = try state.handle(std.testing.allocator, "{\"id\":\"2\",\"type\":\"mcp_select_tool\",\"name\":\"read_file\"}");
    defer std.testing.allocator.free(rejected);
    try std.testing.expect(std.mem.indexOf(u8, rejected, "tool_not_searched") != null);
    const search = try state.handle(std.testing.allocator, "{\"id\":\"3\",\"type\":\"mcp_search_tools\",\"query\":\"read\"}");
    defer std.testing.allocator.free(search);
    const selected = try state.handle(std.testing.allocator, "{\"id\":\"4\",\"type\":\"mcp_select_tool\",\"name\":\"read_file\"}");
    defer std.testing.allocator.free(selected);
    try expectValidResponse(selected);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, selected, "inputSchema"));
}

test "analysis classifies research before its broader domain" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);
    const created = try state.handle(std.testing.allocator, "{\"id\":\"1\",\"type\":\"thread_create\",\"title\":\"Research\"}");
    defer std.testing.allocator.free(created);
    const response = try state.handle(std.testing.allocator, "{\"id\":\"2\",\"type\":\"analyze\",\"thread_id\":\"thread-1\",\"text\":\"A software research paper\"}");
    defer std.testing.allocator.free(response);
    try expectValidResponse(response);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"category\":\"research\"") != null);
}
