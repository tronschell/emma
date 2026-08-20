const std = @import("std");
const openai = @import("openai_compatible.zig");

const max_line_bytes = 256 * 1024;
const max_text_bytes = openai.max_content_bytes;
const max_tools = 256;
const max_imported_messages = 256;
const max_imported_content_bytes = 96 * 1024;
const max_relevant_pages = 4;
const max_screen_context_bytes = 96 * 1024;
const max_skill_context_bytes = 64 * 1024;
const jpeg_data_url_prefix = "data:image/jpeg;base64,";

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

    fn deinit(self: Message, alloc: std.mem.Allocator) void {
        alloc.free(self.id);
        alloc.free(self.content);
    }
};

const Thread = struct {
    id: []u8,
    title: []u8,
    messages: std.ArrayList(Message) = .empty,

    fn deinit(self: *Thread, alloc: std.mem.Allocator) void {
        alloc.free(self.id);
        alloc.free(self.title);
        for (self.messages.items) |message| message.deinit(alloc);
        self.messages.deinit(alloc);
    }

    fn trimHistory(self: *Thread, alloc: std.mem.Allocator) void {
        var content_bytes: usize = 0;
        for (self.messages.items) |message| content_bytes += message.content.len;
        while ((self.messages.items.len > max_imported_messages or content_bytes > max_imported_content_bytes) and self.messages.items.len > 1) {
            const removed = self.messages.orderedRemove(0);
            content_bytes -= removed.content.len;
            removed.deinit(alloc);
        }
    }
};

const State = struct {
    tools: std.ArrayList(Tool) = .empty,
    last_results: std.ArrayList([]const u8) = .empty,
    threads: std.ArrayList(Thread) = .empty,
    next_thread_id: usize = 1,
    provider_transport: openai.Transport = openai.Transport.unavailable_transport,

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
        if (std.mem.eql(u8, kind, "thread_create")) return self.threadCreate(alloc, id, object) catch |err| requestFailure(alloc, id, err);
        if (std.mem.eql(u8, kind, "thread_list")) return self.threadList(alloc, id);
        if (std.mem.eql(u8, kind, "thread_get")) return self.threadGet(alloc, id, object) catch |err| requestFailure(alloc, id, err);
        if (std.mem.eql(u8, kind, "thread_message")) return self.threadMessage(alloc, id, object) catch |err| requestFailure(alloc, id, err);
        if (std.mem.eql(u8, kind, "analyze") or std.mem.eql(u8, kind, "save_to_knowledge")) return self.analyze(alloc, id, object) catch |err| requestFailure(alloc, id, err);
        if (std.mem.eql(u8, kind, "openrouter_models")) return self.openrouterModels(alloc, id, object) catch |err| requestFailure(alloc, id, err);
        if (std.mem.eql(u8, kind, "mcp_catalog")) return self.catalog(alloc, id, object) catch |err| requestFailure(alloc, id, err);
        if (std.mem.eql(u8, kind, "mcp_search_tools")) return self.search(alloc, id, object) catch |err| requestFailure(alloc, id, err);
        if (std.mem.eql(u8, kind, "mcp_select_tool")) return self.select(alloc, id, object) catch |err| requestFailure(alloc, id, err);
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
        try out.writer.writeAll(",\"requests\":[\"health\",\"thread_create\",\"thread_list\",\"thread_get\",\"thread_message\",\"analyze\",\"save_to_knowledge\",\"openrouter_models\",\"mcp_catalog\",\"mcp_search_tools\",\"mcp_select_tool\"]}}\n");
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
        var knowledge_buffer: [max_relevant_pages]openai.KnowledgePage = undefined;
        const knowledge = try parseKnowledge(object.get("knowledge"), &knowledge_buffer);
        const thread = self.findThread(thread_id) orelse return error.ThreadNotFound;
        var model: []const u8 = "local-fallback";
        var input_bytes = content.len;
        for (knowledge) |page| input_bytes += page.id.len + page.title.len + page.summary.len + page.body.len;
        var input_tokens = (input_bytes + 3) / 4;
        var output_tokens: usize = undefined;
        const assistant_content = if (provider) |config| content: {
            const payload = try openai.buildRequest(alloc, config, thread.messages.items, content, knowledge, screen_context, skill_context);
            defer alloc.free(payload);
            const reply = try self.provider_transport.send(alloc, config, payload);
            model = config.model;
            input_tokens = reply.input_tokens;
            output_tokens = reply.output_tokens;
            break :content reply.content;
        } else content: {
            const reply = try fallbackReply(alloc, content, knowledge);
            output_tokens = (reply.len + 3) / 4;
            break :content reply;
        };
        errdefer alloc.free(assistant_content);
        const user_id = try std.fmt.allocPrint(alloc, "message-{d}", .{thread.messages.items.len + 1});
        errdefer alloc.free(user_id);
        const user_content = alloc.dupe(u8, content) catch |err| {
            return err;
        };
        errdefer alloc.free(user_content);
        const assistant_id = std.fmt.allocPrint(alloc, "message-{d}", .{thread.messages.items.len + 2}) catch |err| {
            return err;
        };
        errdefer alloc.free(assistant_id);
        try thread.messages.ensureUnusedCapacity(alloc, 2);

        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try responseStart(&out.writer, id);
        try out.writer.writeAll("{\"message\":");
        try writeMessage(&out.writer, .{ .id = assistant_id, .role = "assistant", .content = assistant_content });
        try out.writer.writeAll(",\"model\":");
        try jsonString(&out.writer, model);
        try out.writer.writeAll(",\"events\":[],\"tool_calls\":[],\"permission_requests\":[]");
        try out.writer.writeAll(",\"input_tokens\":");
        try out.writer.print("{d},\"output_tokens\":{d}", .{ input_tokens, output_tokens });
        try out.writer.writeAll("}}\n");
        const response = try out.toOwnedSlice();
        thread.messages.appendAssumeCapacity(.{ .id = user_id, .role = "user", .content = user_content });
        thread.messages.appendAssumeCapacity(.{ .id = assistant_id, .role = "assistant", .content = assistant_content });
        thread.trimHistory(alloc);
        return response;
    }

    fn analyze(self: *State, alloc: std.mem.Allocator, id: []const u8, object: std.json.ObjectMap) ![]u8 {
        const thread_id = try requiredString(object, "thread_id", 128);
        if (self.findThread(thread_id) == null) return error.ThreadNotFound;
        const text = try requiredString(object, "text", max_text_bytes);
        if (!std.unicode.utf8ValidateSlice(text)) return error.InvalidField;
        _ = try parseProvider(object.get("provider"));
        const sources = try validateSources(object.get("sources"));
        const title = titleFrom(text);
        const category = classify(text);
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
            try out.writer.print(",\"context_length\":{d}}}", .{model.context_length});
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
    var state: State = .{ .provider_transport = .http(&http_context) };
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
    };
    openai.validateConfig(config) catch return error.InvalidField;
    return config;
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
    return trimmed[0..end];
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

fn requestFailure(alloc: std.mem.Allocator, id: []const u8, err: anyerror) ![]u8 {
    return switch (err) {
        error.CatalogTooLarge => responseError(alloc, id, "catalog_too_large", "catalog exceeds 256 tools"),
        error.DuplicateTool => responseError(alloc, id, "duplicate_tool", "tool names must be globally unique"),
        error.NoSearchResult => responseError(alloc, id, "tool_not_searched", "select an exact result from the preceding search"),
        error.ToolNotFound => responseError(alloc, id, "tool_not_found", "selected tool is no longer available"),
        error.ScreenContextRequiresProvider => responseError(alloc, id, "screen_context_requires_provider", "attached screen context requires a configured model endpoint"),
        error.SkillRequiresProvider => responseError(alloc, id, "skill_requires_provider", "an attached skill requires a configured model endpoint"),
        error.ThreadNotFound => responseError(alloc, id, "thread_not_found", "thread does not exist in this process"),
        error.InvalidRequest, error.InvalidField, error.InvalidProviderConfig => responseError(alloc, id, "invalid_field", "request contains a missing, invalid, or oversized field"),
        error.ProviderRequestTooLarge => responseError(alloc, id, "provider_request_too_large", "thread history exceeds the provider request limit"),
        error.ProviderResponseTooLarge => responseError(alloc, id, "provider_response_too_large", "provider response exceeds the configured limit"),
        error.ProviderCredentialUnavailable => responseError(alloc, id, "provider_credential_unavailable", "provider credential environment variable is missing, empty, or invalid"),
        error.ProviderAuthenticationFailed => responseError(alloc, id, "provider_authentication_failed", "provider rejected the configured credential"),
        error.ProviderRateLimited => responseError(alloc, id, "provider_rate_limited", "provider rate limit was reached"),
        error.ProviderTimeout => responseError(alloc, id, "provider_timeout", "provider request exceeded 60 seconds"),
        error.ProviderUnavailable => responseError(alloc, id, "provider_unavailable", "provider could not be reached securely"),
        error.ProviderHttpError => responseError(alloc, id, "provider_http_error", "provider returned a non-success HTTP status"),
        error.InvalidProviderResponse => responseError(alloc, id, "invalid_provider_response", "provider returned an invalid or unsupported Chat Completions response"),
        else => err,
    };
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
    try std.testing.expect(thread.messages.items.len <= max_imported_messages);
    try std.testing.expect(content_bytes <= max_imported_content_bytes);
    try std.testing.expectEqualStrings("assistant", thread.messages.items[thread.messages.items.len - 1].role);
}

test "provider request keeps retrieved knowledge read-only" {
    const Fixture = struct {
        fn send(_: ?*anyopaque, alloc: std.mem.Allocator, _: openai.Config, payload: []const u8) anyerror!openai.Reply {
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
        openai.parseResponse(std.testing.allocator, tool_call),
    );
}

test "OpenRouter model catalog stays behind the provider transport" {
    const Fixture = struct {
        fn list(_: ?*anyopaque, alloc: std.mem.Allocator, config: openai.Config) !openai.ModelCatalog {
            try std.testing.expect(config.protect_data);
            try std.testing.expectEqualStrings("https://openrouter.ai/api/v1", config.base_url);
            return openai.parseModelCatalog(alloc,
                \\{"data":[{"id":"openai/gpt-oss-20b:free","name":"OpenAI: gpt-oss-20b (free)","context_length":131072,"pricing":{"prompt":"0","completion":"0"},"supported_parameters":["tools"]}]}
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
}

test "provider fixture receives thread history and returns parsed content and usage" {
    const Fixture = struct {
        calls: usize = 0,

        fn send(raw_context: ?*anyopaque, alloc: std.mem.Allocator, config: openai.Config, payload: []const u8) anyerror!openai.Reply {
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

        fn send(raw_context: ?*anyopaque, alloc: std.mem.Allocator, _: openai.Config, payload: []const u8) anyerror!openai.Reply {
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
            return openai.parseResponse(alloc, "{\"choices\":[{\"message\":{\"content\":\"ok\"}}]}");
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
