const builtin = @import("builtin");
const std = @import("std");
const windows_paths = if (builtin.os.tag == .windows)
    @import("windows_paths.zig")
else
    struct {};

pub const Prepared = struct {
    argv: []const []const u8,
    owned_argv: ?[]const []const u8 = null,
    owned_command: ?[]const u8 = null,
    owned_comspec: ?[]const u8 = null,

    pub fn deinit(self: *Prepared, alloc: std.mem.Allocator) void {
        if (self.owned_argv) |argv| alloc.free(argv);
        if (self.owned_command) |command| alloc.free(command);
        if (self.owned_comspec) |comspec| alloc.free(comspec);
        self.* = undefined;
    }
};

pub fn prepare(alloc: std.mem.Allocator, argv: []const []const u8) !Prepared {
    if (comptime builtin.os.tag != .windows) return .{ .argv = argv };
    return prepareForWindows(alloc, argv);
}

pub fn prepareForWindows(alloc: std.mem.Allocator, argv: []const []const u8) !Prepared {
    if (argv.len == 0 or !isCmdShim(argv[0])) return .{ .argv = argv };
    var command = std.ArrayList(u8).empty;
    errdefer command.deinit(alloc);
    try appendCommand(&command, alloc, argv[0]);
    for (argv[1..]) |arg| try appendArgument(&command, alloc, arg);
    const command_owned = try command.toOwnedSlice(alloc);
    var owned_comspec: ?[]const u8 = null;
    const comspec = if (comptime builtin.os.tag == .windows) blk: {
        const value = windows_paths.system32Executable(alloc, "cmd.exe") catch
            return error.WindowsExecutableUnavailable;
        owned_comspec = value;
        break :blk value;
    } else "C:\\Windows\\System32\\cmd.exe";
    errdefer if (owned_comspec) |value| alloc.free(value);
    const wrapped = std.fmt.allocPrint(alloc, "\"{s}\"", .{command_owned}) catch |err| {
        alloc.free(command_owned);
        return err;
    };
    errdefer alloc.free(wrapped);
    alloc.free(command_owned);
    const launch_argv = try alloc.alloc([]const u8, 6);
    launch_argv[0] = comspec;
    launch_argv[1] = "/d";
    launch_argv[2] = "/v:off";
    launch_argv[3] = "/s";
    launch_argv[4] = "/c";
    launch_argv[5] = wrapped;
    return .{
        .argv = launch_argv,
        .owned_argv = launch_argv,
        .owned_command = wrapped,
        .owned_comspec = owned_comspec,
    };
}

pub fn isCmdShim(command: []const u8) bool {
    const base = basename(command);
    return std.ascii.endsWithIgnoreCase(base, ".cmd") or
        std.ascii.endsWithIgnoreCase(base, ".bat");
}

fn basename(path: []const u8) []const u8 {
    var index = path.len;
    while (index > 0) {
        index -= 1;
        if (path[index] == '/' or path[index] == '\\') return path[index + 1 ..];
    }
    return path;
}

fn appendCommand(
    command: *std.ArrayList(u8),
    alloc: std.mem.Allocator,
    arg: []const u8,
) !void {
    if (arg.len == 0) return error.InvalidWindowsCommandArgument;
    try appendSeparator(command, alloc);
    try appendEscapedMeta(command, alloc, arg);
}

fn appendArgument(
    command: *std.ArrayList(u8),
    alloc: std.mem.Allocator,
    arg: []const u8,
) !void {
    try appendSeparator(command, alloc);
    try appendEscapedArgument(command, alloc, arg);
}

fn appendSeparator(command: *std.ArrayList(u8), alloc: std.mem.Allocator) !void {
    if (command.items.len != 0) try command.append(alloc, ' ');
}

fn appendEscapedArgument(
    command: *std.ArrayList(u8),
    alloc: std.mem.Allocator,
    arg: []const u8,
) !void {
    var raw = std.ArrayList(u8).empty;
    defer raw.deinit(alloc);
    try raw.append(alloc, '"');
    var slashes: usize = 0;
    for (arg) |byte| {
        if (byte == 0 or byte == '\r' or byte == '\n') {
            return error.InvalidWindowsCommandArgument;
        }
        if (byte == '\\') {
            slashes += 1;
            continue;
        }
        if (byte == '"') {
            try appendRepeated(&raw, alloc, '\\', slashes * 2 + 1);
            try raw.append(alloc, '"');
        } else {
            try appendRepeated(&raw, alloc, '\\', slashes);
            try raw.append(alloc, byte);
        }
        slashes = 0;
    }
    try appendRepeated(&raw, alloc, '\\', slashes * 2);
    try raw.append(alloc, '"');
    var escaped = std.ArrayList(u8).empty;
    defer escaped.deinit(alloc);
    try appendEscapedMeta(&escaped, alloc, raw.items);
    try appendEscapedMeta(command, alloc, escaped.items);
}

fn appendEscapedMeta(
    command: *std.ArrayList(u8),
    alloc: std.mem.Allocator,
    arg: []const u8,
) !void {
    for (arg) |byte| {
        if (byte == 0 or byte == '\r' or byte == '\n') {
            return error.InvalidWindowsCommandArgument;
        }
        if (isWindowsMeta(byte)) try command.append(alloc, '^');
        try command.append(alloc, byte);
    }
}

fn isWindowsMeta(byte: u8) bool {
    return switch (byte) {
        '(', ')', '[', ']', '%', '!', '^', '"', '`', '<', '>', '&', '|', ';', ',', ' ', '*', '?' => true,
        else => false,
    };
}

fn appendRepeated(
    command: *std.ArrayList(u8),
    alloc: std.mem.Allocator,
    byte: u8,
    count: usize,
) !void {
    for (0..count) |_| try command.append(alloc, byte);
}

test "Windows command shim preparation preserves argv boundaries" {
    try std.testing.expect(isCmdShim("C:\\tools\\server.CMD"));
    try std.testing.expect(isCmdShim("server.bAt"));
    try std.testing.expect(!isCmdShim("server.exe"));
    var prepared = try prepareForWindows(std.testing.allocator, &.{
        "C:\\tools\\server.cmd",
        "value with spaces",
        "quote\\\"value",
    });
    defer prepared.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 6), prepared.argv.len);
    try std.testing.expectEqual(builtin.os.tag == .windows, prepared.owned_comspec != null);
    try std.testing.expectEqualStrings("/v:off", prepared.argv[2]);
    try std.testing.expectEqualStrings("/c", prepared.argv[4]);
    try std.testing.expect(std.mem.startsWith(u8, prepared.argv[5], "\"C:\\tools\\server.cmd"));
    try std.testing.expectError(
        error.InvalidWindowsCommandArgument,
        prepareForWindows(std.testing.allocator, &.{ "server.cmd", "bad\nvalue" }),
    );
}

test "Windows command shim escaping protects hostile argv values" {
    var prepared = try prepareForWindows(std.testing.allocator, &.{
        "C:\\tools\\server.cmd",
        "spaces and (groups)",
        "%PATH% !delayed! ^caret^ &pipe |or <in >out",
        "quote\\\"value\\",
        "marker & echo INJECTION",
    });
    defer prepared.deinit(std.testing.allocator);
    const command = prepared.argv[5];
    try std.testing.expect(std.mem.indexOf(u8, command, "%PATH%") == null);
    try std.testing.expect(std.mem.indexOf(u8, command, "!delayed!") == null);
    try std.testing.expect(std.mem.indexOf(u8, command, "marker & echo INJECTION") == null);
    try std.testing.expect(std.mem.indexOf(u8, command, "^^^%PATH^^^%") != null);
    try std.testing.expect(std.mem.indexOf(u8, command, "^^^!delayed^^^!") != null);
}
