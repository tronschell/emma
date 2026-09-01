const std = @import("std");
const windows = std.os.windows;
const io_mod = @import("io.zig");

extern "kernel32" fn GetWindowsDirectoryW(buffer: [*]u16, size: u32) callconv(.winapi) u32;
extern "kernel32" fn GetFileAttributesW(path: [*:0]const u16) callconv(.winapi) u32;

const invalid_file_attributes: u32 = 0xffffffff;
const file_attribute_directory: u32 = 0x00000010;

pub const Error = error{
    BufferTooSmall,
    GitNotFound,
    InvalidWindowsDirectory,
    InvalidPath,
    OutOfMemory,
};

pub fn normalizeLongPathInto(buffer: []u8, path: []const u8) Error![]u8 {
    if (path.len == 0) return error.InvalidPath;
    if (std.mem.startsWith(u8, path, "\\\\.\\")) return error.InvalidPath;
    const prefix: []const u8 = if (std.mem.startsWith(u8, path, "\\\\?\\"))
        ""
    else if (std.mem.startsWith(u8, path, "\\\\"))
        "\\\\?\\UNC\\"
    else if (path.len >= 3 and path[1] == ':' and
        (path[2] == '\\' or path[2] == '/'))
        "\\\\?\\"
    else
        return error.InvalidPath;
    const start: usize = if (prefix.len == 0)
        0
    else if (std.mem.startsWith(u8, path, "\\\\"))
        2
    else
        0;
    const result = std.fmt.bufPrint(
        buffer,
        "{s}{s}",
        .{ prefix, path[start..] },
    ) catch return error.BufferTooSmall;
    for (result) |*byte| {
        if (byte.* == '/') byte.* = '\\';
    }
    return result;
}

pub fn normalizeLongPath(alloc: std.mem.Allocator, path: []const u8) Error![]u8 {
    const extra: usize = if (std.mem.startsWith(u8, path, "\\\\?\\"))
        0
    else if (std.mem.startsWith(u8, path, "\\\\"))
        6
    else
        4;
    const result = alloc.alloc(u8, path.len + extra) catch return error.OutOfMemory;
    errdefer alloc.free(result);
    return normalizeLongPathInto(result, path);
}

pub fn system32ExecutableInto(buffer: []u8, basename: []const u8) Error![]u8 {
    var root: [32768]u16 = undefined;
    const length = GetWindowsDirectoryW(&root, @intCast(root.len));
    if (length == 0 or length >= root.len) return error.InvalidWindowsDirectory;
    var root_utf8: [32768]u8 = undefined;
    const root_length = std.unicode.wtf16LeToWtf8(
        &root_utf8,
        root[0..length],
    );
    return std.fmt.bufPrint(
        buffer,
        "{s}\\System32\\{s}",
        .{ root_utf8[0..root_length], basename },
    ) catch error.BufferTooSmall;
}

pub fn gitExecutableInto(buffer: []u8) Error![]u8 {
    var candidate: [32768]u8 = undefined;
    const roots = [_]struct {
        path: ?[]const u8,
        local_app_data: bool,
    }{
        .{ .path = io_mod.getenv("ProgramW6432"), .local_app_data = false },
        .{ .path = io_mod.getenv("ProgramFiles"), .local_app_data = false },
        .{ .path = io_mod.getenv("ProgramFiles(x86)"), .local_app_data = false },
        .{ .path = io_mod.getenv("LOCALAPPDATA"), .local_app_data = true },
    };
    for (roots) |root| {
        const value = root.path orelse continue;
        const trimmed = std.mem.trimEnd(u8, value, "\\/");
        if (trimmed.len == 0) continue;
        const suffix = if (root.local_app_data)
            "\\Programs\\Git\\cmd\\git.exe"
        else
            "\\Git\\cmd\\git.exe";
        const candidate_path = std.fmt.bufPrint(
            &candidate,
            "{s}{s}",
            .{ trimmed, suffix },
        ) catch return error.BufferTooSmall;
        if (!isRegularFile(candidate_path)) continue;
        return std.fmt.bufPrint(buffer, "{s}", .{candidate_path}) catch error.BufferTooSmall;
    }
    return error.GitNotFound;
}

fn isRegularFile(path: []const u8) bool {
    var normalized: [32768]u8 = undefined;
    const normalized_path = normalizeLongPathInto(&normalized, path) catch return false;
    var utf16: [32768]u16 = undefined;
    const length = std.unicode.utf8ToUtf16Le(
        utf16[0 .. utf16.len - 1],
        normalized_path,
    ) catch return false;
    utf16[length] = 0;
    const attributes = GetFileAttributesW(utf16[0..length :0]);
    return attributes != invalid_file_attributes and
        attributes & file_attribute_directory == 0;
}

pub fn gitExecutable(alloc: std.mem.Allocator) Error![]u8 {
    var path: [32768]u8 = undefined;
    const value = try gitExecutableInto(&path);
    return alloc.dupe(u8, value) catch error.OutOfMemory;
}

pub fn system32Executable(alloc: std.mem.Allocator, basename: []const u8) Error![]u8 {
    var path: [32768]u8 = undefined;
    const value = try system32ExecutableInto(&path, basename);
    return alloc.dupe(u8, value) catch error.OutOfMemory;
}

test "Windows system executable uses the native Windows directory" {
    if (comptime @import("builtin").os.tag != .windows) return error.SkipZigTest;
    const path = try system32Executable(std.testing.allocator, "cmd.exe");
    defer std.testing.allocator.free(path);
    try std.testing.expect(std.mem.endsWith(u8, path, "\\System32\\cmd.exe"));
}

test "Windows long path normalization covers drive and UNC paths" {
    var buffer: [128]u8 = undefined;
    try std.testing.expectEqualStrings(
        "\\\\?\\C:\\folder\\file",
        try normalizeLongPathInto(&buffer, "C:/folder/file"),
    );
    try std.testing.expectEqualStrings(
        "\\\\?\\UNC\\server\\share\\file",
        try normalizeLongPathInto(&buffer, "\\\\server\\share\\file"),
    );
    try std.testing.expectEqualStrings(
        "\\\\?\\C:\\folder\\file",
        try normalizeLongPathInto(&buffer, "\\\\?\\C:/folder/file"),
    );
    try std.testing.expectError(error.InvalidPath, normalizeLongPathInto(&buffer, "relative\\file"));
}
