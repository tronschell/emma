const std = @import("std");
const pathing = @import("../../core/workspace/pathing.zig");

pub fn workspaceRelative(
    arena: std.mem.Allocator,
    workspace_root: []const u8,
    absolute_path: []const u8,
) ![]const u8 {
    const rel = try pathing.workspaceRelativePath(arena, workspace_root, absolute_path);
    if (rel.len == 0) return ".";
    return slashSeparated(arena, rel);
}

pub fn slashSeparated(arena: std.mem.Allocator, path: []const u8) ![]const u8 {
    if (comptime std.fs.path.sep == '/') return path;
    if (std.fs.path.isAbsolute(path)) return path;
    const out = try arena.dupe(u8, path);
    std.mem.replaceScalar(u8, out, std.fs.path.sep, '/');
    return out;
}
