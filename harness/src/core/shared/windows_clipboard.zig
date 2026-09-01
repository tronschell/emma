const std = @import("std");
const windows = std.os.windows;

extern "user32" fn OpenClipboard(owner: ?windows.HWND) callconv(.winapi) windows.BOOL;
extern "user32" fn EmptyClipboard() callconv(.winapi) windows.BOOL;
extern "user32" fn SetClipboardData(format: u32, data: windows.HANDLE) callconv(.winapi) ?windows.HANDLE;
extern "user32" fn CloseClipboard() callconv(.winapi) windows.BOOL;
extern "kernel32" fn GlobalAlloc(flags: u32, bytes: usize) callconv(.winapi) ?windows.HANDLE;
extern "kernel32" fn GlobalLock(memory: windows.HANDLE) callconv(.winapi) ?*anyopaque;
extern "kernel32" fn GlobalUnlock(memory: windows.HANDLE) callconv(.winapi) windows.BOOL;
extern "kernel32" fn GlobalFree(memory: windows.HANDLE) callconv(.winapi) ?windows.HANDLE;
extern "kernel32" fn Sleep(milliseconds: u32) callconv(.winapi) void;

const cf_unicode_text: u32 = 13;
const cf_hdrop: u32 = 15;
const gmem_moveable: u32 = 0x0002;
const gmem_zeroinit: u32 = 0x0040;
const global_flags = gmem_moveable | gmem_zeroinit;

const drop_files = extern struct {
    files_offset: u32,
    point_x: i32,
    point_y: i32,
    non_client_area: windows.BOOL,
    wide: windows.BOOL,
};

pub const Error = error{
    ClipboardUnavailable,
    InvalidPath,
    InvalidText,
    OutOfMemory,
};

fn open() Error!void {
    for (0..20) |_| {
        if (OpenClipboard(null).toBool()) return;
        Sleep(5);
    }
    return error.ClipboardUnavailable;
}

pub fn copyText(alloc: std.mem.Allocator, text: []const u8) Error!void {
    if (std.mem.findScalar(u8, text, 0) != null) return error.InvalidText;
    const utf16 = std.unicode.utf8ToUtf16LeAlloc(alloc, text) catch |err| switch (err) {
        error.InvalidUtf8 => return error.InvalidText,
        error.OutOfMemory => return error.OutOfMemory,
    };
    defer alloc.free(utf16);
    const memory = GlobalAlloc(global_flags, (utf16.len + 1) * @sizeOf(u16)) orelse
        return error.OutOfMemory;
    errdefer _ = GlobalFree(memory);
    const locked = GlobalLock(memory) orelse return error.ClipboardUnavailable;
    const units: [*]u16 = @ptrCast(@alignCast(locked));
    @memcpy(units[0..utf16.len], utf16);
    units[utf16.len] = 0;
    _ = GlobalUnlock(memory);
    try open();
    defer _ = CloseClipboard();
    if (!EmptyClipboard().toBool()) return error.ClipboardUnavailable;
    if (SetClipboardData(cf_unicode_text, memory) == null) return error.ClipboardUnavailable;
    return;
}

pub fn copyFile(alloc: std.mem.Allocator, path: []const u8) Error!void {
    if (!isWindowsAbsolute(path) or std.mem.findScalar(u8, path, 0) != null) {
        return error.InvalidPath;
    }
    const utf16 = std.unicode.utf8ToUtf16LeAlloc(alloc, path) catch |err| switch (err) {
        error.InvalidUtf8 => return error.InvalidPath,
        error.OutOfMemory => return error.OutOfMemory,
    };
    defer alloc.free(utf16);
    const total_units = utf16.len + 2;
    const memory = GlobalAlloc(
        global_flags,
        @sizeOf(drop_files) + total_units * @sizeOf(u16),
    ) orelse return error.OutOfMemory;
    errdefer _ = GlobalFree(memory);
    const locked = GlobalLock(memory) orelse return error.ClipboardUnavailable;
    const bytes: [*]u8 = @ptrCast(locked);
    const header: *drop_files = @ptrCast(@alignCast(bytes));
    header.* = .{
        .files_offset = @sizeOf(drop_files),
        .point_x = 0,
        .point_y = 0,
        .non_client_area = @enumFromInt(0),
        .wide = @enumFromInt(1),
    };
    const units: [*]u16 = @ptrCast(@alignCast(bytes + @sizeOf(drop_files)));
    @memcpy(units[0..utf16.len], utf16);
    units[utf16.len] = 0;
    units[utf16.len + 1] = 0;
    _ = GlobalUnlock(memory);
    try open();
    defer _ = CloseClipboard();
    if (!EmptyClipboard().toBool()) return error.ClipboardUnavailable;
    if (SetClipboardData(cf_hdrop, memory) == null) return error.ClipboardUnavailable;
}

fn isWindowsAbsolute(path: []const u8) bool {
    if (path.len >= 3 and std.ascii.isAlphabetic(path[0]) and path[1] == ':' and
        (path[2] == '\\' or path[2] == '/')) return true;
    return path.len >= 2 and path[0] == '\\' and path[1] == '\\';
}

test "Windows clipboard rejects embedded file path terminators" {
    if (comptime @import("builtin").os.tag != .windows) return error.SkipZigTest;
    try std.testing.expectError(
        error.InvalidPath,
        copyFile(std.testing.allocator, "C:\\tmp\\bad\x00name"),
    );
    try std.testing.expectError(
        error.InvalidPath,
        copyFile(std.testing.allocator, "relative\\path"),
    );
    try std.testing.expectError(
        error.InvalidText,
        copyText(std.testing.allocator, "bad\x00text"),
    );
}
