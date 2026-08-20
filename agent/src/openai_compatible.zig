const std = @import("std");

pub const max_request_bytes = 1024 * 1024;
pub const max_response_bytes = 1024 * 1024;
pub const max_content_bytes = 64 * 1024;
const max_credential_bytes = 8 * 1024;
const request_timeout_seconds = 60;

pub const Config = struct {
    base_url: []const u8,
    model: []const u8,
    credential_env: []const u8,
};

pub const Reply = struct {
    content: []u8,
    input_tokens: usize,
    output_tokens: usize,

    pub fn deinit(self: Reply, alloc: std.mem.Allocator) void {
        alloc.free(self.content);
    }
};

pub const Transport = struct {
    context: ?*anyopaque = null,
    send_fn: *const fn (?*anyopaque, std.mem.Allocator, Config, []const u8) anyerror!Reply = unavailable,

    pub const unavailable_transport: Transport = .{};

    pub fn http(context: *HttpContext) Transport {
        return .{ .context = context, .send_fn = sendHttp };
    }

    pub fn send(self: Transport, alloc: std.mem.Allocator, config: Config, payload: []const u8) !Reply {
        return self.send_fn(self.context, alloc, config, payload);
    }
};

pub const HttpContext = struct {
    io: std.Io,
    environ: *const std.process.Environ.Map,
};

pub fn validateConfig(config: Config) error{InvalidProviderConfig}!void {
    if (config.base_url.len == 0 or config.model.len == 0 or config.credential_env.len == 0) return error.InvalidProviderConfig;
    if (!std.unicode.utf8ValidateSlice(config.base_url) or !std.unicode.utf8ValidateSlice(config.model)) return error.InvalidProviderConfig;
    if (!validEnvName(config.credential_env)) return error.InvalidProviderConfig;

    const uri = std.Uri.parse(config.base_url) catch return error.InvalidProviderConfig;
    if (uri.host == null or uri.user != null or uri.password != null or uri.query != null or uri.fragment != null) return error.InvalidProviderConfig;
    if (std.ascii.eqlIgnoreCase(uri.scheme, "https")) return;
    if (!std.ascii.eqlIgnoreCase(uri.scheme, "http")) return error.InvalidProviderConfig;

    var host_buffer: [std.Io.net.HostName.max_len]u8 = undefined;
    const host = (uri.getHost(&host_buffer) catch return error.InvalidProviderConfig).bytes;
    if (!std.ascii.eqlIgnoreCase(host, "localhost") and
        !std.ascii.eqlIgnoreCase(host, "localhost.") and
        !std.mem.eql(u8, host, "127.0.0.1")) return error.InvalidProviderConfig;
}

pub fn buildRequest(
    alloc: std.mem.Allocator,
    model: []const u8,
    history: anytype,
    pending_user_content: []const u8,
) ![]u8 {
    const buffer = try alloc.alloc(u8, max_request_bytes + 1);
    errdefer alloc.free(buffer);
    var writer = std.Io.Writer.fixed(buffer);
    writeRequest(&writer, model, history, pending_user_content) catch return error.ProviderRequestTooLarge;
    if (writer.end > max_request_bytes) return error.ProviderRequestTooLarge;
    return try alloc.realloc(buffer, writer.end);
}

fn writeRequest(writer: *std.Io.Writer, model: []const u8, history: anytype, pending_user_content: []const u8) !void {
    try writer.writeAll("{\"model\":");
    try std.json.Stringify.value(model, .{}, writer);
    try writer.writeAll(",\"messages\":[");
    for (history, 0..) |message, index| {
        if (index != 0) try writer.writeByte(',');
        try writeMessage(writer, message.role, message.content);
    }
    if (history.len != 0) try writer.writeByte(',');
    try writeMessage(writer, "user", pending_user_content);
    try writer.writeAll("],\"stream\":false}");
}

fn writeMessage(writer: *std.Io.Writer, role: []const u8, content: []const u8) !void {
    try writer.writeAll("{\"role\":");
    try std.json.Stringify.value(role, .{}, writer);
    try writer.writeAll(",\"content\":");
    try std.json.Stringify.value(content, .{}, writer);
    try writer.writeByte('}');
}

pub fn parseResponse(alloc: std.mem.Allocator, body: []const u8) !Reply {
    var parsed = std.json.parseFromSlice(std.json.Value, alloc, body, .{}) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidProviderResponse,
    };
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidProviderResponse;

    const choices = parsed.value.object.get("choices") orelse return error.InvalidProviderResponse;
    if (choices != .array or choices.array.items.len == 0 or choices.array.items[0] != .object) return error.InvalidProviderResponse;
    const choice = choices.array.items[0].object;
    if (choice.get("finish_reason")) |finish_reason| {
        if (finish_reason == .string and
            (std.mem.eql(u8, finish_reason.string, "tool_calls") or std.mem.eql(u8, finish_reason.string, "function_call")))
            return error.ProviderToolCallsUnsupported;
    }

    const message = choice.get("message") orelse return error.InvalidProviderResponse;
    if (message != .object) return error.InvalidProviderResponse;
    if (hasCalls(message.object.get("tool_calls")) or hasCalls(message.object.get("function_call"))) return error.ProviderToolCallsUnsupported;
    const content = message.object.get("content") orelse return error.InvalidProviderResponse;
    if (content != .string or content.string.len == 0 or content.string.len > max_content_bytes or !std.unicode.utf8ValidateSlice(content.string))
        return error.InvalidProviderResponse;

    var input_tokens: usize = 0;
    var output_tokens: usize = 0;
    if (parsed.value.object.get("usage")) |usage| {
        if (usage != .null) {
            if (usage != .object) return error.InvalidProviderResponse;
            input_tokens = try tokenCount(usage.object.get("prompt_tokens"));
            output_tokens = try tokenCount(usage.object.get("completion_tokens"));
        }
    }
    return .{
        .content = try alloc.dupe(u8, content.string),
        .input_tokens = input_tokens,
        .output_tokens = output_tokens,
    };
}

fn hasCalls(value: ?std.json.Value) bool {
    const calls = value orelse return false;
    return switch (calls) {
        .null => false,
        .array => calls.array.items.len != 0,
        else => true,
    };
}

fn tokenCount(value: ?std.json.Value) error{InvalidProviderResponse}!usize {
    const count = value orelse return 0;
    if (count != .integer or count.integer < 0) return error.InvalidProviderResponse;
    return std.math.cast(usize, count.integer) orelse error.InvalidProviderResponse;
}

fn validEnvName(name: []const u8) bool {
    if (name.len == 0 or !(std.ascii.isAlphabetic(name[0]) or name[0] == '_')) return false;
    for (name[1..]) |byte| if (!(std.ascii.isAlphanumeric(byte) or byte == '_')) return false;
    return true;
}

fn unavailable(_: ?*anyopaque, _: std.mem.Allocator, _: Config, _: []const u8) anyerror!Reply {
    return error.ProviderUnavailable;
}

const Attempt = union(enum) {
    reply: Reply,
    failure: anyerror,
};

const Race = union(enum) {
    attempt: Attempt,
    deadline: void,
};

fn sendHttp(raw_context: ?*anyopaque, alloc: std.mem.Allocator, config: Config, payload: []const u8) !Reply {
    const context: *HttpContext = @ptrCast(@alignCast(raw_context orelse return error.ProviderUnavailable));
    var race_buffer: [2]Race = undefined;
    var select = std.Io.Select(Race).init(context.io, &race_buffer);
    select.async(.attempt, httpAttempt, .{ context, alloc, config, payload });
    select.async(.deadline, waitForDeadline, .{context.io});
    const first = try select.await();
    defer while (select.cancel()) |remaining| deinitRace(alloc, remaining);
    return switch (first) {
        .attempt => |attempt| switch (attempt) {
            .reply => |reply| reply,
            .failure => |err| return err,
        },
        .deadline => error.ProviderTimeout,
    };
}

fn httpAttempt(context: *HttpContext, alloc: std.mem.Allocator, config: Config, payload: []const u8) Attempt {
    return .{ .reply = sendHttpDirect(context, alloc, config, payload) catch |err| return .{ .failure = err } };
}

fn waitForDeadline(io: std.Io) void {
    std.Io.Timeout.sleep(.{ .duration = .{ .raw = .fromSeconds(request_timeout_seconds), .clock = .awake } }, io) catch {};
}

fn deinitRace(alloc: std.mem.Allocator, race: Race) void {
    switch (race) {
        .attempt => |attempt| switch (attempt) {
            .reply => |reply| reply.deinit(alloc),
            .failure => {},
        },
        .deadline => {},
    }
}

fn sendHttpDirect(context: *HttpContext, alloc: std.mem.Allocator, config: Config, payload: []const u8) !Reply {
    const credential = context.environ.get(config.credential_env) orelse return error.ProviderCredentialUnavailable;
    if (!validCredential(credential)) return error.ProviderCredentialUnavailable;

    const authorization = try std.mem.concat(alloc, u8, &.{ "Bearer ", credential });
    defer {
        std.crypto.secureZero(u8, authorization);
        alloc.free(authorization);
    }
    const endpoint = try completionEndpoint(alloc, config.base_url);
    defer alloc.free(endpoint);
    const response_buffer = try alloc.alloc(u8, max_response_bytes + 1);
    defer alloc.free(response_buffer);
    var response_writer = std.Io.Writer.fixed(response_buffer);

    var client: std.http.Client = .{ .allocator = alloc, .io = context.io };
    defer client.deinit();
    const extra_headers = [_]std.http.Header{.{ .name = "Accept", .value = "application/json" }};
    const result = client.fetch(.{
        .location = .{ .url = endpoint },
        .method = .POST,
        .payload = payload,
        .keep_alive = false,
        .redirect_behavior = .unhandled,
        .response_writer = &response_writer,
        .headers = .{
            .authorization = .{ .override = authorization },
            .content_type = .{ .override = "application/json" },
        },
        .extra_headers = &extra_headers,
    }) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.WriteFailed => if (response_writer.end == response_buffer.len)
            return error.ProviderResponseTooLarge
        else
            return error.ProviderUnavailable,
        error.Canceled => return error.ProviderUnavailable,
        else => return error.ProviderUnavailable,
    };
    if (response_writer.end > max_response_bytes) return error.ProviderResponseTooLarge;

    return switch (@intFromEnum(result.status)) {
        200...299 => parseResponse(alloc, response_writer.buffered()),
        401, 403 => error.ProviderAuthenticationFailed,
        429 => error.ProviderRateLimited,
        else => error.ProviderHttpError,
    };
}

fn validCredential(credential: []const u8) bool {
    if (credential.len == 0 or credential.len > max_credential_bytes) return false;
    for (credential) |byte| if (byte <= ' ' or byte == 0x7f) return false;
    return true;
}

fn completionEndpoint(alloc: std.mem.Allocator, base_url: []const u8) ![]u8 {
    return std.mem.concat(alloc, u8, &.{ std.mem.trimEnd(u8, base_url, "/"), "/chat/completions" });
}
