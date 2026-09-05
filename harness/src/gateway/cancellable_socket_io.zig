const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("../core/shared/io.zig");
const windows_console = if (builtin.os.tag == .windows)
    @import("../ui/terminal/windows_console.zig")
else
    struct {};

const poll_interval_ms: i32 = 20;

pub const Scope = if (builtin.os.tag == .windows) WindowsScope else PassthroughScope;

const PassthroughScope = struct {
    pub fn begin(_: *std.atomic.Value(bool)) PassthroughScope {
        return .{};
    }

    pub fn io(_: *PassthroughScope) std.Io {
        return io_mod.getIo();
    }

    pub fn end(_: *PassthroughScope) void {}
};

threadlocal var active_cancel_flag: ?*std.atomic.Value(bool) = null;

const WindowsScope = struct {
    vtable: std.Io.VTable,
    userdata: ?*anyopaque,
    restore: ?*std.atomic.Value(bool),

    pub fn begin(cancel_flag: *std.atomic.Value(bool)) WindowsScope {
        const base = io_mod.getIo();
        var vtable = base.vtable.*;
        vtable.netConnectIp = connectIp;
        vtable.netRead = read;
        vtable.netWrite = write;
        vtable.netClose = close;
        vtable.netShutdown = shutdownSocket;
        const restore = active_cancel_flag;
        active_cancel_flag = cancel_flag;
        return .{ .vtable = vtable, .userdata = base.userdata, .restore = restore };
    }

    pub fn io(self: *WindowsScope) std.Io {
        return .{ .userdata = self.userdata, .vtable = &self.vtable };
    }

    pub fn end(self: *WindowsScope) void {
        active_cancel_flag = self.restore;
    }
};

fn cancelRequested() bool {
    const flag = active_cancel_flag orelse return false;
    return flag.load(.seq_cst);
}

const winsock = struct {
    const invalid_socket: usize = std.math.maxInt(usize);
    const socket_error: c_int = -1;
    const af_inet: c_int = 2;
    const af_inet6: c_int = 23;
    const sock_stream: c_int = 1;
    const fionbio: c_long = @bitCast(@as(c_ulong, 0x8004667e));

    const access_denied: c_int = 10013;
    const process_fd_quota: c_int = 10024;
    const would_block: c_int = 10035;
    const address_family_unsupported: c_int = 10047;
    const address_unavailable: c_int = 10049;
    const network_down: c_int = 10050;
    const network_unreachable: c_int = 10051;
    const network_reset: c_int = 10052;
    const connection_aborted: c_int = 10053;
    const connection_reset: c_int = 10054;
    const no_buffer_space: c_int = 10055;
    const not_connected: c_int = 10057;
    const already_shutdown: c_int = 10058;
    const timed_out: c_int = 10060;
    const connection_refused: c_int = 10061;
    const host_unreachable: c_int = 10065;

    extern "ws2_32" fn WSAStartup(version: u16, data: *align(8) [408]u8) callconv(.winapi) c_int;
    extern "ws2_32" fn WSAGetLastError() callconv(.winapi) c_int;
    extern "ws2_32" fn socket(family: c_int, socket_type: c_int, protocol: c_int) callconv(.winapi) usize;
    extern "ws2_32" fn connect(socket: usize, address: *const anyopaque, address_len: c_int) callconv(.winapi) c_int;
    extern "ws2_32" fn closesocket(socket: usize) callconv(.winapi) c_int;
    extern "ws2_32" fn shutdown(socket: usize, how: c_int) callconv(.winapi) c_int;
    extern "ws2_32" fn ioctlsocket(socket: usize, command: c_long, argument: *c_ulong) callconv(.winapi) c_int;
    extern "ws2_32" fn recv(socket: usize, buffer: [*]u8, length: c_int, flags: c_int) callconv(.winapi) c_int;
    extern "ws2_32" fn send(socket: usize, buffer: [*]const u8, length: c_int, flags: c_int) callconv(.winapi) c_int;

    var startup_mutex: std.Io.Mutex = .init;
    var startup_done: bool = false;

    fn ready() void {
        const zio = io_mod.getIo();
        startup_mutex.lockUncancelable(zio);
        defer startup_mutex.unlock(zio);
        if (startup_done) return;
        var data: [408]u8 align(8) = undefined;
        _ = WSAStartup(0x0202, &data);
        startup_done = true;
    }
};

const SocketAddressIp4 = extern struct {
    family: u16,
    port: u16,
    address: [4]u8,
    zero: [8]u8 = @splat(0),
};

const SocketAddressIp6 = extern struct {
    family: u16,
    port: u16,
    flow: u32,
    address: [16]u8,
    scope_id: u32,
};

fn connectIp(
    _: ?*anyopaque,
    address: *const std.Io.net.IpAddress,
    options: std.Io.net.IpAddress.ConnectOptions,
) std.Io.net.IpAddress.ConnectError!std.Io.net.Socket {
    if (options.mode != .stream or options.timeout != .none) return error.OptionUnsupported;
    if (cancelRequested()) return error.Canceled;
    winsock.ready();

    const family: c_int = switch (address.*) {
        .ip4 => winsock.af_inet,
        .ip6 => winsock.af_inet6,
    };
    const handle = winsock.socket(family, winsock.sock_stream, 0);
    if (handle == winsock.invalid_socket) return connectFailure(winsock.WSAGetLastError());
    errdefer _ = winsock.closesocket(handle);

    const connected = switch (address.*) {
        .ip4 => |ip4| winsock.connect(handle, &SocketAddressIp4{
            .family = @intCast(winsock.af_inet),
            .port = std.mem.nativeToBig(u16, ip4.port),
            .address = ip4.bytes,
        }, @sizeOf(SocketAddressIp4)),
        .ip6 => |ip6| winsock.connect(handle, &SocketAddressIp6{
            .family = @intCast(winsock.af_inet6),
            .port = std.mem.nativeToBig(u16, ip6.port),
            .flow = ip6.flow,
            .address = ip6.bytes,
            .scope_id = ip6.interface.index,
        }, @sizeOf(SocketAddressIp6)),
    };
    if (connected == winsock.socket_error) return connectFailure(winsock.WSAGetLastError());

    var nonblocking: c_ulong = 1;
    if (winsock.ioctlsocket(handle, winsock.fionbio, &nonblocking) == winsock.socket_error) {
        return connectFailure(winsock.WSAGetLastError());
    }
    return .{ .handle = @ptrFromInt(handle), .address = address.* };
}

fn connectFailure(code: c_int) std.Io.net.IpAddress.ConnectError {
    return switch (code) {
        winsock.connection_refused => error.ConnectionRefused,
        winsock.connection_reset, winsock.network_reset => error.ConnectionResetByPeer,
        winsock.timed_out => error.Timeout,
        winsock.network_unreachable => error.NetworkUnreachable,
        winsock.host_unreachable => error.HostUnreachable,
        winsock.network_down => error.NetworkDown,
        winsock.address_unavailable => error.AddressUnavailable,
        winsock.address_family_unsupported => error.AddressFamilyUnsupported,
        winsock.access_denied => error.AccessDenied,
        winsock.process_fd_quota => error.ProcessFdQuotaExceeded,
        winsock.no_buffer_space => error.SystemResources,
        else => error.Unexpected,
    };
}

fn read(
    _: ?*anyopaque,
    handle: std.Io.net.Socket.Handle,
    data: [][]u8,
) std.Io.net.Stream.Reader.Error!usize {
    var destination: []u8 = &.{};
    for (data) |buffer| {
        if (buffer.len != 0) {
            destination = buffer;
            break;
        }
    }
    if (destination.len == 0) return 0;
    while (true) {
        if (cancelRequested()) return error.Canceled;
        try io_mod.getIo().checkCancel();
        const poll = windows_console.pollSocketWithInterest(handle, poll_interval_ms, true, false);
        if (poll.has_error) return error.ConnectionResetByPeer;
        if (!poll.readable) {
            if (poll.hung_up) return 0;
            continue;
        }
        const received = winsock.recv(
            @intFromPtr(handle),
            destination.ptr,
            @intCast(@min(destination.len, std.math.maxInt(c_int))),
            0,
        );
        if (received != winsock.socket_error) return @intCast(received);
        const code = winsock.WSAGetLastError();
        if (code == winsock.would_block) continue;
        return readFailure(code);
    }
}

fn readFailure(code: c_int) std.Io.net.Stream.Reader.Error {
    return switch (code) {
        winsock.connection_reset,
        winsock.connection_aborted,
        winsock.network_reset,
        => error.ConnectionResetByPeer,
        winsock.timed_out => error.Timeout,
        winsock.not_connected, winsock.already_shutdown => error.SocketUnconnected,
        winsock.network_down => error.NetworkDown,
        winsock.no_buffer_space => error.SystemResources,
        else => error.Unexpected,
    };
}

fn write(
    _: ?*anyopaque,
    handle: std.Io.net.Socket.Handle,
    header: []const u8,
    data: []const []const u8,
    splat: usize,
) std.Io.net.Stream.Writer.Error!usize {
    const chunk = firstChunk(header, data, splat) orelse return 0;
    while (true) {
        if (cancelRequested()) return error.Canceled;
        try io_mod.getIo().checkCancel();
        const poll = windows_console.pollSocketWithInterest(handle, poll_interval_ms, false, true);
        if (poll.has_error) return error.ConnectionResetByPeer;
        if (!poll.writable) continue;
        const sent = winsock.send(
            @intFromPtr(handle),
            chunk.ptr,
            @intCast(@min(chunk.len, std.math.maxInt(c_int))),
            0,
        );
        if (sent != winsock.socket_error) return @intCast(sent);
        const code = winsock.WSAGetLastError();
        if (code == winsock.would_block) continue;
        return writeFailure(code);
    }
}

fn writeFailure(code: c_int) std.Io.net.Stream.Writer.Error {
    return switch (code) {
        winsock.connection_reset,
        winsock.connection_aborted,
        winsock.network_reset,
        => error.ConnectionResetByPeer,
        winsock.connection_refused => error.ConnectionRefused,
        winsock.network_unreachable => error.NetworkUnreachable,
        winsock.host_unreachable => error.HostUnreachable,
        winsock.not_connected, winsock.already_shutdown => error.SocketUnconnected,
        winsock.network_down => error.NetworkDown,
        winsock.no_buffer_space => error.SystemResources,
        else => error.Unexpected,
    };
}

fn firstChunk(header: []const u8, data: []const []const u8, splat: usize) ?[]const u8 {
    if (header.len != 0) return header;
    if (data.len == 0) return null;
    for (data[0 .. data.len - 1]) |bytes| {
        if (bytes.len != 0) return bytes;
    }
    const pattern = data[data.len - 1];
    if (splat == 0 or pattern.len == 0) return null;
    return pattern;
}

fn close(_: ?*anyopaque, handles: []const std.Io.net.Socket.Handle) void {
    for (handles) |handle| _ = winsock.closesocket(@intFromPtr(handle));
}

fn shutdownSocket(
    _: ?*anyopaque,
    handle: std.Io.net.Socket.Handle,
    how: std.Io.net.ShutdownHow,
) std.Io.net.ShutdownError!void {
    const direction: c_int = switch (how) {
        .recv => 0,
        .send => 1,
        .both => 2,
    };
    if (winsock.shutdown(@intFromPtr(handle), direction) == winsock.socket_error) {
        return switch (winsock.WSAGetLastError()) {
            winsock.not_connected => error.SocketUnconnected,
            winsock.connection_aborted => error.ConnectionAborted,
            winsock.connection_reset => error.ConnectionResetByPeer,
            winsock.network_down => error.NetworkDown,
            else => error.Unexpected,
        };
    }
}

test "winsock failures keep refusal and reset distinct from an unexpected code" {
    try std.testing.expectEqual(error.ConnectionRefused, connectFailure(winsock.connection_refused));
    try std.testing.expectEqual(error.ConnectionResetByPeer, connectFailure(winsock.connection_reset));
    try std.testing.expectEqual(error.Timeout, connectFailure(winsock.timed_out));
    try std.testing.expectEqual(error.Unexpected, connectFailure(1));

    try std.testing.expectEqual(error.ConnectionResetByPeer, readFailure(winsock.connection_reset));
    try std.testing.expectEqual(error.ConnectionResetByPeer, readFailure(winsock.connection_aborted));
    try std.testing.expectEqual(error.SocketUnconnected, readFailure(winsock.already_shutdown));
    try std.testing.expectEqual(error.Unexpected, readFailure(1));

    try std.testing.expectEqual(error.ConnectionResetByPeer, writeFailure(winsock.connection_reset));
    try std.testing.expectEqual(error.ConnectionRefused, writeFailure(winsock.connection_refused));
    try std.testing.expectEqual(error.Unexpected, writeFailure(1));
}

test "socket writes consume the first non-empty region of a drain" {
    try std.testing.expectEqualStrings("head", firstChunk("head", &.{"body"}, 1).?);
    try std.testing.expectEqualStrings("body", firstChunk("", &.{ "", "body" }, 1).?);
    try std.testing.expectEqualStrings("pad", firstChunk("", &.{ "", "pad" }, 3).?);
    try std.testing.expect(firstChunk("", &.{ "", "pad" }, 0) == null);
    try std.testing.expect(firstChunk("", &.{""}, 4) == null);
    try std.testing.expect(firstChunk("", &.{}, 1) == null);
}

test "a stalled socket read abandons the peer within a poll interval of cancellation" {
    if (comptime builtin.os.tag != .windows) return error.SkipZigTest;

    const zio = io_mod.getIo();
    var address = try std.Io.net.IpAddress.parse("127.0.0.1", 0);
    var server = try address.listen(zio, .{ .reuse_address = true });
    defer server.deinit(zio);

    var cancel_flag = std.atomic.Value(bool).init(false);
    var scope: Scope = .begin(&cancel_flag);
    defer scope.end();

    const socket = try connectIp(
        null,
        &.{ .ip4 = .loopback(server.socket.address.getPort()) },
        .{ .mode = .stream },
    );
    defer close(null, &.{socket.handle});

    const Cancel = struct {
        fn run(flag: *std.atomic.Value(bool)) void {
            var backend: std.Io.Threaded = .init_single_threaded;
            backend.io().sleep(.fromMilliseconds(20), .real) catch {};
            flag.store(true, .seq_cst);
        }
    };
    const cancel_thread = try std.Thread.spawn(.{}, Cancel.run, .{&cancel_flag});
    defer cancel_thread.join();

    var buffer: [64]u8 = undefined;
    var regions = [_][]u8{&buffer};
    const started = std.Io.Clock.Timestamp.now(zio, .awake);
    const result = read(null, socket.handle, &regions);
    const elapsed_ms = started.durationTo(std.Io.Clock.Timestamp.now(zio, .awake)).raw.toMilliseconds();

    try std.testing.expectError(error.Canceled, result);
    try std.testing.expect(elapsed_ms < 20 + 4 * poll_interval_ms);
}
