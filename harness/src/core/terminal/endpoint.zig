const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("../shared/io.zig");
const windows_console = if (builtin.os.tag == .windows)
    @import("../../ui/terminal/windows_console.zig")
else
    struct {};

pub const unix_path_max: usize = 108;

pub const Error = error{
    EndpointNameTooLong,
    EndpointListenFailed,
    EndpointConnectFailed,
};

const winsock = struct {
    const invalid_socket: usize = std.math.maxInt(usize);
    const socket_error: c_int = -1;
    const overlapped_flag: u32 = 0x01;

    extern "ws2_32" fn WSAStartup(
        version: u16,
        data: *align(8) [408]u8,
    ) callconv(.winapi) c_int;
    extern "ws2_32" fn WSASocketW(
        family: c_int,
        socket_type: c_int,
        protocol: c_int,
        protocol_info: ?*anyopaque,
        group: u32,
        flags: u32,
    ) callconv(.winapi) usize;
    extern "ws2_32" fn bind(
        socket: usize,
        address: *const anyopaque,
        address_len: c_int,
    ) callconv(.winapi) c_int;
    extern "ws2_32" fn listen(
        socket: usize,
        backlog: c_int,
    ) callconv(.winapi) c_int;
    extern "ws2_32" fn accept(
        socket: usize,
        address: ?*anyopaque,
        address_len: ?*c_int,
    ) callconv(.winapi) usize;
    extern "ws2_32" fn connect(
        socket: usize,
        address: *const anyopaque,
        address_len: c_int,
    ) callconv(.winapi) c_int;
    extern "ws2_32" fn closesocket(socket: usize) callconv(.winapi) c_int;
    extern "ws2_32" fn send(
        socket: usize,
        buffer: [*]const u8,
        length: c_int,
        flags: c_int,
    ) callconv(.winapi) c_int;
    extern "ws2_32" fn recv(
        socket: usize,
        buffer: [*]u8,
        length: c_int,
        flags: c_int,
    ) callconv(.winapi) c_int;

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

const SocketAddressUnix = extern struct {
    family: u16,
    path: [unix_path_max]u8,
};

fn socketAddressUnix(path: []const u8) Error!struct { SocketAddressUnix, c_int } {
    if (path.len >= unix_path_max) return error.EndpointNameTooLong;
    var address: SocketAddressUnix = .{ .family = 1, .path = @splat(0) };
    @memcpy(address.path[0..path.len], path);
    return .{
        address,
        @intCast(@offsetOf(SocketAddressUnix, "path") + path.len + 1),
    };
}

fn windowsSocket() Error!usize {
    winsock.ready();
    const handle = winsock.WSASocketW(
        1,
        1,
        0,
        null,
        0,
        winsock.overlapped_flag,
    );
    if (handle == winsock.invalid_socket) return error.EndpointListenFailed;
    return handle;
}

fn wrapStream(handle: usize) std.Io.net.Stream {
    return .{ .socket = .{
        .handle = @ptrFromInt(handle),
        .address = .{ .ip4 = .loopback(0) },
    } };
}

pub fn listen(path: []const u8) !std.Io.net.Server {
    if (comptime builtin.os.tag == .windows) {
        const address, const address_len = try socketAddressUnix(path);
        const handle = try windowsSocket();
        errdefer _ = winsock.closesocket(handle);
        if (winsock.bind(handle, &address, address_len) == winsock.socket_error) {
            return error.EndpointListenFailed;
        }
        if (winsock.listen(handle, 32) == winsock.socket_error) {
            return error.EndpointListenFailed;
        }
        return .{
            .socket = .{
                .handle = @ptrFromInt(handle),
                .address = .{ .ip4 = .loopback(0) },
            },
            .options = .{ .mode = .stream, .protocol = null },
        };
    }
    const address = try std.Io.net.UnixAddress.init(path);
    return address.listen(io_mod.getIo(), .{});
}

pub fn accept(server: *std.Io.net.Server) !std.Io.net.Stream {
    if (comptime builtin.os.tag == .windows) {
        const handle = winsock.accept(
            @intFromPtr(server.socket.handle),
            null,
            null,
        );
        if (handle == winsock.invalid_socket) return error.SocketNotListening;
        return wrapStream(handle);
    }
    return server.accept(io_mod.getIo());
}

pub fn connect(path: []const u8) !std.Io.net.Stream {
    if (comptime builtin.os.tag == .windows) {
        const address, const address_len = try socketAddressUnix(path);
        const handle = try windowsSocket();
        errdefer _ = winsock.closesocket(handle);
        if (winsock.connect(handle, &address, address_len) == winsock.socket_error) {
            return error.EndpointConnectFailed;
        }
        return wrapStream(handle);
    }
    const address = try std.Io.net.UnixAddress.init(path);
    return address.connect(io_mod.getIo());
}

pub fn closeStream(stream: std.Io.net.Stream) void {
    if (comptime builtin.os.tag == .windows) {
        _ = winsock.closesocket(@intFromPtr(stream.socket.handle));
        return;
    }
    var owned = stream;
    owned.close(io_mod.getIo());
}

pub fn closeServer(server: *std.Io.net.Server) void {
    if (comptime builtin.os.tag == .windows) {
        _ = winsock.closesocket(@intFromPtr(server.socket.handle));
        server.* = undefined;
        return;
    }
    server.deinit(io_mod.getIo());
}

pub fn sendAll(socket: std.Io.net.Socket, bytes: []const u8) !void {
    if (comptime builtin.os.tag == .windows) {
        var offset: usize = 0;
        while (offset < bytes.len) {
            const sent = winsock.send(
                @intFromPtr(socket.handle),
                bytes[offset..].ptr,
                @intCast(@min(bytes.len - offset, std.math.maxInt(c_int))),
                0,
            );
            if (sent <= 0) return error.ConnectionResetByPeer;
            offset += @intCast(sent);
        }
        return;
    }
    return (std.Io.File{
        .handle = socket.handle,
        .flags = .{ .nonblocking = false },
    }).writeStreamingAll(io_mod.getIo(), bytes);
}

pub fn receiveTimeout(
    socket: std.Io.net.Socket,
    destination: []u8,
    timeout_ms: i64,
) !usize {
    if (comptime builtin.os.tag == .windows) {
        const poll = windows_console.pollSocketWithInterest(
            socket.handle,
            @intCast(@min(timeout_ms, std.math.maxInt(i32))),
            true,
            false,
        );
        if (poll.has_error) return error.ConnectionResetByPeer;
        if (poll.hung_up and !poll.readable) return 0;
        if (!poll.readable) return error.Timeout;
        const received = winsock.recv(
            @intFromPtr(socket.handle),
            destination.ptr,
            @intCast(@min(destination.len, std.math.maxInt(c_int))),
            0,
        );
        if (received == winsock.socket_error) return error.ConnectionResetByPeer;
        return @intCast(received);
    }
    const incoming = try socket.receiveTimeout(
        io_mod.getIo(),
        destination,
        .{ .duration = .{
            .clock = .awake,
            .raw = .fromMilliseconds(timeout_ms),
        } },
    );
    return incoming.data.len;
}

test "unix endpoint addresses carry the path and a trailing terminator" {
    const address, const address_len = try socketAddressUnix("/tmp/fx.sock");
    try std.testing.expectEqual(@as(u16, 1), address.family);
    try std.testing.expectEqualStrings(
        "/tmp/fx.sock",
        std.mem.sliceTo(&address.path, 0),
    );
    try std.testing.expectEqual(@as(c_int, 2 + 12 + 1), address_len);
    try std.testing.expectError(
        error.EndpointNameTooLong,
        socketAddressUnix("x" ** unix_path_max),
    );
}

test "endpoint accepts a connection and moves bytes both ways" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const alloc = std.testing.allocator;
    const root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, ".");
    defer alloc.free(root);
    const path = try std.fs.path.join(alloc, &.{ root, "accept.sock" });
    defer alloc.free(path);
    if (path.len >= unix_path_max) return error.SkipZigTest;

    var server = try listen(path);
    defer closeServer(&server);

    const Peer = struct {
        fn run(endpoint_path: []const u8) void {
            var stream = connect(endpoint_path) catch return;
            defer closeStream(stream);
            var write_buffer: [16]u8 = undefined;
            var writer = stream.writer(io_mod.getIo(), &write_buffer);
            writer.interface.writeAll("ping") catch return;
            writer.interface.flush() catch return;
            var reply: [4]u8 = undefined;
            _ = receiveTimeout(stream.socket, &reply, 2_000) catch return;
        }
    };
    var peer = try std.Thread.spawn(.{}, Peer.run, .{path});
    defer peer.join();

    var accepted = try accept(&server);
    defer closeStream(accepted);
    var request: [4]u8 = undefined;
    try std.testing.expectEqual(
        @as(usize, 4),
        try receiveTimeout(accepted.socket, &request, 2_000),
    );
    try std.testing.expectEqualStrings("ping", &request);
    var write_buffer: [16]u8 = undefined;
    var writer = accepted.writer(io_mod.getIo(), &write_buffer);
    try writer.interface.writeAll("pong");
    try writer.interface.flush();
}
