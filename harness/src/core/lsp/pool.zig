const std = @import("std");
const client_mod = @import("client.zig");
const io_mod = @import("../shared/io.zig");
const servers = @import("servers.zig");

const Allocator = std.mem.Allocator;
const Client = client_mod.Client;

const Entry = struct {
    server_id: []const u8,
    root: []u8,
    client: *Client,
};

var mutex: std.Io.Mutex = .init;
var entries: std.ArrayList(*Entry) = .empty;
var stopped: bool = false;

fn poolAllocator() Allocator {
    return std.heap.c_allocator;
}

pub fn acquire(
    arena: Allocator,
    server: servers.Server,
    root: []const u8,
    initialize_timeout_ms: u32,
    failure_message: *?[]const u8,
) !*Client {
    const io = io_mod.getIo();
    mutex.lockUncancelable(io);
    defer mutex.unlock(io);
    if (stopped) return error.LspConnectionClosed;

    for (entries.items) |entry| {
        if (std.mem.eql(u8, entry.server_id, server.id) and std.mem.eql(u8, entry.root, root)) {
            return entry.client;
        }
    }

    const alloc = poolAllocator();
    const client = try Client.spawn(alloc, server, root);
    errdefer client.deinit();
    try client.initialize(arena, initialize_timeout_ms, failure_message);
    client.waitUntilIdle(initialize_timeout_ms);

    const entry = try alloc.create(Entry);
    errdefer alloc.destroy(entry);
    const owned_root = try alloc.dupe(u8, root);
    errdefer alloc.free(owned_root);
    entry.* = .{ .server_id = server.id, .root = owned_root, .client = client };
    try entries.append(alloc, entry);
    return client;
}

pub fn shutdownAll() void {
    const io = io_mod.getIo();
    mutex.lockUncancelable(io);
    const owned = entries;
    entries = .empty;
    stopped = true;
    mutex.unlock(io);

    const alloc = poolAllocator();
    var list = owned;
    for (list.items) |entry| {
        entry.client.deinit();
        alloc.free(entry.root);
        alloc.destroy(entry);
    }
    list.deinit(alloc);
}

pub fn liveServerCount() usize {
    const io = io_mod.getIo();
    mutex.lockUncancelable(io);
    defer mutex.unlock(io);
    return entries.items.len;
}
