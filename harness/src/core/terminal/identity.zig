const std = @import("std");
const builtin = @import("builtin");
const io_mod = @import("../shared/io.zig");

pub fn profileUser(buffer: *[64]u8) ?[]const u8 {
    if (comptime builtin.os.tag == .macos or builtin.os.tag == .linux) {
        return std.fmt.bufPrint(buffer, "uid-{d}", .{io_mod.currentUserId()}) catch null;
    }
    if (comptime builtin.os.tag == .windows) {
        const username = io_mod.getenv("USERNAME") orelse "windows-user";
        if (username.len + 5 > buffer.len) return null;
        @memcpy(buffer[0..5], "user-");
        @memcpy(buffer[5 .. 5 + username.len], username);
        return buffer[0 .. 5 + username.len];
    }
    return null;
}

test "profile identity is available exactly on supported terminal hosts" {
    var buffer: [64]u8 = undefined;
    const value = profileUser(&buffer);
    if (comptime builtin.os.tag == .macos or builtin.os.tag == .linux) {
        try std.testing.expect(value != null);
        try std.testing.expect(std.mem.startsWith(u8, value.?, "uid-"));
    } else if (builtin.os.tag == .windows) {
        try std.testing.expect(value != null);
        try std.testing.expect(std.mem.startsWith(u8, value.?, "user-"));
    } else {
        try std.testing.expect(value == null);
    }
}
