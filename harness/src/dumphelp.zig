const std = @import("std");
const builtin_commands = @import("builtins/commands.zig");
pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    const alloc = gpa.allocator();
    const text = try builtin_commands.renderTopLevelHelp(alloc, 80, "9.8.7");
    var buf: [1 << 16]u8 = undefined;
    var w = std.fs.File.stdout().writer(&buf);
    try w.interface.writeAll(text);
    try w.interface.flush();
}
