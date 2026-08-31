const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("../../core/shared/io.zig");
const debug_trace = @import("../../core/shared/debug_trace.zig");
const host_target = @import("../../core/hosts/target.zig");
const jsonrpc = @import("../../acp/jsonrpc.zig");

const windows_response = if (builtin.os.tag == .windows) struct {
    const windows = std.os.windows;
    const PollFd = extern struct {
        fd: usize,
        events: i16,
        revents: i16,
    };

    extern "ws2_32" fn setsockopt(
        socket: usize,
        level: c_int,
        option_name: c_int,
        option_value: [*]const u8,
        option_length: c_int,
    ) callconv(.winapi) c_int;
    extern "ws2_32" fn WSAPoll(
        fds: *PollFd,
        count: u32,
        timeout_ms: i32,
    ) callconv(.winapi) c_int;
} else struct {};

pub const State = enum { idle, working, blocked };

const custom_status_max = 32;

const source = "custom:fx";
const agent_name = "fx";

const Request = union(enum) {
    report: struct { state: State, custom_status: ?[]const u8 },
    session: []const u8,
    pane_rename: ?[]const u8,
    agent_rename: ?[]const u8,
    clear_authority,
};

pub const Client = struct {
    enabled: bool = false,
    mutex: std.Io.Mutex = .init,
    alloc: ?std.mem.Allocator = null,
    socket_path: []u8 = &.{},
    pane_id: []u8 = &.{},
    next_id: u64 = 1,

    pub fn shouldEnable(
        fx_herdr: ?[]const u8,
        socket_path: ?[]const u8,
        pane_id: ?[]const u8,
    ) bool {
        if (fx_herdr) |val| {
            if (std.mem.eql(u8, val, "0") or std.ascii.eqlIgnoreCase(val, "false"))
                return false;
        }
        const path = socket_path orelse return false;
        const pane = pane_id orelse return false;
        return path.len > 0 and pane.len > 0;
    }

    pub fn initFromEnv(self: *Client, alloc: std.mem.Allocator) void {
        const socket_path = io_mod.getenv("HERDR_SOCKET_PATH");
        const pane_id = io_mod.getenv("HERDR_PANE_ID");
        if (!shouldEnable(io_mod.getenv("FX_HERDR"), socket_path, pane_id)) {
            debug_trace.logf("herdr", "disabled socket={s} pane={s} fx_herdr={s}", .{
                socket_path orelse "(unset)",
                pane_id orelse "(unset)",
                io_mod.getenv("FX_HERDR") orelse "(unset)",
            });
            return;
        }

        const path_copy = alloc.dupe(u8, socket_path.?) catch return;
        const pane_copy = alloc.dupe(u8, pane_id.?) catch {
            alloc.free(path_copy);
            return;
        };
        self.alloc = alloc;
        self.socket_path = path_copy;
        self.pane_id = pane_copy;
        self.enabled = true;
        debug_trace.logf("herdr", "enabled socket={s} pane_id={s}", .{ path_copy, pane_copy });
    }

    pub fn deinit(self: *Client) void {
        self.release();
        const io = io_mod.getIo();
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        if (self.alloc) |alloc| {
            if (self.socket_path.len > 0) alloc.free(self.socket_path);
            if (self.pane_id.len > 0) alloc.free(self.pane_id);
        }
        self.socket_path = &.{};
        self.pane_id = &.{};
        self.alloc = null;
        self.enabled = false;
    }

    pub fn reportState(self: *Client, state: State, custom_status: ?[]const u8) void {
        self.send(.{ .report = .{ .state = state, .custom_status = clampStatus(custom_status) } });
    }

    pub fn reportSession(self: *Client, session_id: []const u8) void {
        if (session_id.len == 0) return;
        self.send(.{ .session = session_id });
    }

    pub fn announce(self: *Client) void {
        self.sendAll(&.{
            .{ .pane_rename = agent_name },
            .{ .agent_rename = agent_name },
        });
    }

    pub fn release(self: *Client) void {
        self.sendAll(&.{
            .{ .agent_rename = null },
            .clear_authority,
            .{ .pane_rename = null },
        });
    }

    fn send(self: *Client, request: Request) void {
        self.sendAll(&.{request});
    }

    fn sendAll(self: *Client, requests: []const Request) void {
        if (comptime host_target.is_wasm) return;
        if (!self.enabled) return;
        const io = io_mod.getIo();
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        for (requests) |request| {
            self.sendLocked(request) catch |err| {
                debug_trace.logf(
                    "herdr",
                    "send failed kind={s} err={s}",
                    .{ @tagName(request), @errorName(err) },
                );
            };
        }
    }

    fn sendLocked(self: *Client, request: Request) !void {
        const io = io_mod.getIo();
        var stream = try self.connectLocked();
        defer stream.close(io);
        applyResponseTimeout(stream);

        var buffer: [1024]u8 = undefined;
        var stream_writer = stream.writer(io, &buffer);
        const w = &stream_writer.interface;
        const id = self.takeIdLocked();
        switch (request) {
            .report => |r| try writeReportAgent(w, id, self.pane_id, r.state, r.custom_status),
            .session => |session_id| try writeReportAgentSession(w, id, self.pane_id, session_id),
            .pane_rename => |label| try writeRename(w, id, "pane.rename", "pane_id", self.pane_id, "label", label),
            .agent_rename => |name| try writeRename(w, id, "agent.rename", "target", self.pane_id, "name", name),
            .clear_authority => try writeClearAuthority(w, id, self.pane_id),
        }
        try w.flush();
        drainResponse(stream);
        debug_trace.logf("herdr", "sent {s} pane_id={s}", .{ @tagName(request), self.pane_id });
    }

    fn connectLocked(self: *Client) !std.Io.net.Stream {
        const address = try std.Io.net.UnixAddress.init(self.socket_path);
        return address.connect(io_mod.getIo());
    }

    fn takeIdLocked(self: *Client) u64 {
        const id = self.next_id;
        self.next_id += 1;
        return id;
    }
};

fn applyResponseTimeout(stream: std.Io.net.Stream) void {
    if (comptime builtin.os.tag == .windows) {
        setWindowsResponseTimeout(stream, response_timeout_ms);
        return;
    }
    const response_timeout = std.posix.timeval{ .sec = 0, .usec = 250_000 };
    std.posix.setsockopt(
        stream.socket.handle,
        std.posix.SOL.SOCKET,
        std.posix.SO.RCVTIMEO,
        std.mem.asBytes(&response_timeout),
    ) catch {};
}

fn setWindowsResponseTimeout(stream: std.Io.net.Stream, timeout_ms: i32) void {
    var value: c_int = timeout_ms;
    _ = windows_response.setsockopt(
        @intFromPtr(stream.socket.handle),
        @intCast(std.os.windows.ws2_32.SOL.SOCKET),
        @intCast(std.os.windows.ws2_32.SO.RCVTIMEO),
        @ptrCast(&value),
        @sizeOf(c_int),
    );
}

fn clampStatus(custom_status: ?[]const u8) ?[]const u8 {
    const status = custom_status orelse return null;
    if (status.len == 0) return null;
    return status[0..@min(status.len, custom_status_max)];
}

const response_timeout_ms: i32 = 250;

fn drainResponse(stream: std.Io.net.Stream) void {
    if (comptime builtin.os.tag == .windows) {
        drainResponseWindows(stream);
        return;
    }
    var buffer: [512]u8 = undefined;
    var stream_reader = stream.reader(io_mod.getIo(), &buffer);
    _ = stream_reader.interface.takeDelimiterInclusive('\n') catch {};
}

fn drainResponseWindows(stream: std.Io.net.Stream) void {
    const io = io_mod.getIo();
    const deadline = std.Io.Clock.Timestamp.fromNow(io, .{
        .clock = .awake,
        .raw = .fromMilliseconds(response_timeout_ms),
    });
    const poll_in: i16 = 0x0100;
    const poll_err: i16 = 0x0001;
    const poll_hup: i16 = 0x0002;
    var buffer: [512]u8 = undefined;
    var stream_reader = stream.reader(io_mod.getIo(), &buffer);
    var byte: [1]u8 = undefined;
    var read_count: usize = 0;
    while (read_count < buffer.len) {
        if (stream_reader.interface.buffered().len == 0) {
            const timeout_ms = responseRemainingMs(io, deadline);
            if (timeout_ms <= 0) return;
            setWindowsResponseTimeout(stream, timeout_ms);
            var fd = windows_response.PollFd{
                .fd = @intFromPtr(stream.socket.handle),
                .events = poll_in,
                .revents = 0,
            };
            const poll_result = windows_response.WSAPoll(&fd, 1, timeout_ms);
            if (poll_result <= 0 or fd.revents & (poll_in | poll_err | poll_hup) == 0) return;
        }
        const count = stream_reader.interface.readSliceShort(&byte) catch return;
        if (count == 0 or byte[0] == '\n') return;
        read_count += count;
    }
}

fn responseRemainingMs(io: std.Io, deadline: std.Io.Clock.Timestamp) i32 {
    if (!std.Io.Clock.Timestamp.compare(
        std.Io.Clock.Timestamp.now(io, .awake),
        .lt,
        deadline,
    )) return 0;
    const remaining = deadline.durationFromNow(io).raw.nanoseconds;
    const nanoseconds_per_millisecond: i96 = std.time.ns_per_ms;
    const milliseconds = @divFloor(
        remaining + nanoseconds_per_millisecond - 1,
        nanoseconds_per_millisecond,
    );
    return @intCast(@min(milliseconds, @as(i96, response_timeout_ms)));
}

fn writeId(w: *std.Io.Writer, id: u64) !void {
    try w.writeAll("{\"id\":\"");
    try w.print("{d}", .{id});
    try w.writeAll("\"");
}

fn writeReportAgent(
    w: *std.Io.Writer,
    id: u64,
    pane_id: []const u8,
    state: State,
    custom_status: ?[]const u8,
) !void {
    try writeId(w, id);
    try w.writeAll(",\"method\":\"pane.report_agent\",\"params\":{\"pane_id\":");
    try jsonrpc.writeJsonStr(pane_id, w);
    try w.writeAll(",\"source\":");
    try jsonrpc.writeJsonStr(source, w);
    try w.writeAll(",\"agent\":");
    try jsonrpc.writeJsonStr(agent_name, w);
    try w.writeAll(",\"state\":");
    try jsonrpc.writeJsonStr(@tagName(state), w);
    if (custom_status) |status| {
        try w.writeAll(",\"custom_status\":");
        try jsonrpc.writeJsonStr(status, w);
    }
    try w.writeAll("}}\n");
}

fn writeReportAgentSession(
    w: *std.Io.Writer,
    id: u64,
    pane_id: []const u8,
    session_id: []const u8,
) !void {
    try writeId(w, id);
    try w.writeAll(",\"method\":\"pane.report_agent_session\",\"params\":{\"pane_id\":");
    try jsonrpc.writeJsonStr(pane_id, w);
    try w.writeAll(",\"source\":");
    try jsonrpc.writeJsonStr(source, w);
    try w.writeAll(",\"agent\":");
    try jsonrpc.writeJsonStr(agent_name, w);
    try w.writeAll(",\"agent_session_id\":");
    try jsonrpc.writeJsonStr(session_id, w);
    try w.writeAll("}}\n");
}

fn writeRename(
    w: *std.Io.Writer,
    id: u64,
    method: []const u8,
    target_key: []const u8,
    target: []const u8,
    value_key: []const u8,
    value: ?[]const u8,
) !void {
    try writeId(w, id);
    try w.writeAll(",\"method\":");
    try jsonrpc.writeJsonStr(method, w);
    try w.writeAll(",\"params\":{");
    try jsonrpc.writeJsonStr(target_key, w);
    try w.writeAll(":");
    try jsonrpc.writeJsonStr(target, w);
    try w.writeAll(",");
    try jsonrpc.writeJsonStr(value_key, w);
    try w.writeAll(":");
    if (value) |v| try jsonrpc.writeJsonStr(v, w) else try w.writeAll("null");
    try w.writeAll("}}\n");
}

fn writeClearAuthority(w: *std.Io.Writer, id: u64, pane_id: []const u8) !void {
    try writeId(w, id);
    try w.writeAll(",\"method\":\"pane.clear_agent_authority\",\"params\":{\"pane_id\":");
    try jsonrpc.writeJsonStr(pane_id, w);
    try w.writeAll(",\"source\":");
    try jsonrpc.writeJsonStr(source, w);
    try w.writeAll("}}\n");
}

test "shouldEnable requires both socket path and pane id" {
    try std.testing.expect(Client.shouldEnable(null, "/tmp/herdr.sock", "w1:p1"));
    try std.testing.expect(!Client.shouldEnable(null, null, "w1:p1"));
    try std.testing.expect(!Client.shouldEnable(null, "/tmp/herdr.sock", null));
    try std.testing.expect(!Client.shouldEnable(null, "", "w1:p1"));
    try std.testing.expect(!Client.shouldEnable(null, "/tmp/herdr.sock", ""));
}

test "shouldEnable honors FX_HERDR opt-out" {
    try std.testing.expect(!Client.shouldEnable("0", "/tmp/herdr.sock", "w1:p1"));
    try std.testing.expect(!Client.shouldEnable("false", "/tmp/herdr.sock", "w1:p1"));
    try std.testing.expect(!Client.shouldEnable("FALSE", "/tmp/herdr.sock", "w1:p1"));
    try std.testing.expect(Client.shouldEnable("1", "/tmp/herdr.sock", "w1:p1"));
}

test "report_agent serializes a single newline-delimited json line" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try writeReportAgent(&out.writer, 7, "w1:p1", .working, "editing");
    try std.testing.expectEqualStrings(
        "{\"id\":\"7\",\"method\":\"pane.report_agent\",\"params\":{\"pane_id\":\"w1:p1\"," ++
            "\"source\":\"custom:fx\",\"agent\":\"fx\",\"state\":\"working\"," ++
            "\"custom_status\":\"editing\"}}\n",
        out.written(),
    );
}

test "report_agent omits custom_status when null" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try writeReportAgent(&out.writer, 1, "w1:p1", .idle, null);
    try std.testing.expectEqualStrings(
        "{\"id\":\"1\",\"method\":\"pane.report_agent\",\"params\":{\"pane_id\":\"w1:p1\"," ++
            "\"source\":\"custom:fx\",\"agent\":\"fx\",\"state\":\"idle\"}}\n",
        out.written(),
    );
}

test "report_agent escapes pane id" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try writeReportAgent(&out.writer, 2, "pane\"x", .blocked, null);
    try std.testing.expectEqualStrings(
        "{\"id\":\"2\",\"method\":\"pane.report_agent\",\"params\":{\"pane_id\":\"pane\\\"x\"," ++
            "\"source\":\"custom:fx\",\"agent\":\"fx\",\"state\":\"blocked\"}}\n",
        out.written(),
    );
}

test "pane.rename labels the pane" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try writeRename(&out.writer, 4, "pane.rename", "pane_id", "w1:p1", "label", "fx");
    try std.testing.expectEqualStrings(
        "{\"id\":\"4\",\"method\":\"pane.rename\",\"params\":{\"pane_id\":\"w1:p1\",\"label\":\"fx\"}}\n",
        out.written(),
    );
}

test "agent.rename names the agent" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try writeRename(&out.writer, 5, "agent.rename", "target", "w1:p1", "name", "fx");
    try std.testing.expectEqualStrings(
        "{\"id\":\"5\",\"method\":\"agent.rename\",\"params\":{\"target\":\"w1:p1\",\"name\":\"fx\"}}\n",
        out.written(),
    );
}

test "rename with null value clears the label" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try writeRename(&out.writer, 6, "pane.rename", "pane_id", "w1:p1", "label", null);
    try std.testing.expectEqualStrings(
        "{\"id\":\"6\",\"method\":\"pane.rename\",\"params\":{\"pane_id\":\"w1:p1\",\"label\":null}}\n",
        out.written(),
    );
}

test "clear_agent_authority removes fx from the pane" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try writeClearAuthority(&out.writer, 7, "w1:p1");
    try std.testing.expectEqualStrings(
        "{\"id\":\"7\",\"method\":\"pane.clear_agent_authority\",\"params\":{\"pane_id\":\"w1:p1\",\"source\":\"custom:fx\"}}\n",
        out.written(),
    );
}

test "report_agent_session serializes session identity" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try writeReportAgentSession(&out.writer, 3, "w1:p1", "session-42");
    try std.testing.expectEqualStrings(
        "{\"id\":\"3\",\"method\":\"pane.report_agent_session\",\"params\":{\"pane_id\":\"w1:p1\"," ++
            "\"source\":\"custom:fx\",\"agent\":\"fx\",\"agent_session_id\":\"session-42\"}}\n",
        out.written(),
    );
}

test "clampStatus caps to 32 bytes and normalizes empty" {
    try std.testing.expect(clampStatus(null) == null);
    try std.testing.expect(clampStatus("") == null);
    const long = "0123456789012345678901234567890123456789";
    const clamped = clampStatus(long).?;
    try std.testing.expectEqual(@as(usize, custom_status_max), clamped.len);
}

test "herdr response wait is bounded" {
    try std.testing.expectEqual(@as(i32, 250), response_timeout_ms);
}
