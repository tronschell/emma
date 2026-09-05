const std = @import("std");

const windows = std.os.windows;

const console_screen_buffer_info = extern struct {
    size: coord,
    cursor_position: coord,
    attributes: u16,
    window: small_rect,
    maximum_window_size: coord,
};

const coord = extern struct {
    x: i16,
    y: i16,
};

const small_rect = extern struct {
    left: i16,
    top: i16,
    right: i16,
    bottom: i16,
};

extern "kernel32" fn GetConsoleMode(handle: windows.HANDLE, mode: *u32) callconv(.winapi) windows.BOOL;
extern "kernel32" fn SetConsoleMode(handle: windows.HANDLE, mode: u32) callconv(.winapi) windows.BOOL;
extern "kernel32" fn GetConsoleScreenBufferInfo(handle: windows.HANDLE, info: *console_screen_buffer_info) callconv(.winapi) windows.BOOL;
extern "kernel32" fn GetFileType(handle: windows.HANDLE) callconv(.winapi) u32;
extern "kernel32" fn WaitForSingleObject(handle: windows.HANDLE, milliseconds: u32) callconv(.winapi) u32;
extern "kernel32" fn Sleep(milliseconds: u32) callconv(.winapi) void;
extern "kernel32" fn PeekNamedPipe(
    handle: windows.HANDLE,
    buffer: ?[*]u8,
    buffer_size: u32,
    bytes_read: ?*u32,
    bytes_available: ?*u32,
    bytes_left: ?*u32,
) callconv(.winapi) windows.BOOL;

const windows_pollfd = extern struct {
    fd: usize,
    events: i16,
    revents: i16,
};

extern "ws2_32" fn WSAPoll(fds: *windows_pollfd, count: u32, timeout_ms: i32) callconv(.winapi) i32;

const enable_processed_input: u32 = 0x0001;
const enable_line_input: u32 = 0x0002;
const enable_echo_input: u32 = 0x0004;
const enable_extended_flags: u32 = 0x0080;
const enable_virtual_terminal_input: u32 = 0x0200;
const wait_object: u32 = 0;
const wait_timeout: u32 = 0x102;
const wait_infinite: u32 = 0xffffffff;
const error_broken_pipe: u32 = 109;
const file_type_unknown: u32 = 0x0000;
const file_type_disk: u32 = 0x0001;
const file_type_char: u32 = 0x0002;
const file_type_pipe: u32 = 0x0003;
const poll_in: i16 = 0x0100;
const poll_out: i16 = 0x0010;
const poll_err: i16 = 0x0001;
const poll_hup: i16 = 0x0002;
const poll_nval: i16 = 0x0004;

pub const PollResult = struct {
    readable: bool = false,
    writable: bool = false,
    hung_up: bool = false,
    has_error: bool = false,
};

pub fn isConsole(handle: windows.HANDLE) bool {
    var mode: u32 = undefined;
    return GetConsoleMode(handle, &mode).toBool();
}

pub fn captureMode(handle: windows.HANDLE) !u32 {
    var mode: u32 = undefined;
    if (!GetConsoleMode(handle, &mode).toBool()) return error.NotATerminal;
    return mode;
}

pub fn enableRawMode(handle: windows.HANDLE, original: u32) !void {
    const mode = original & ~(enable_line_input | enable_echo_input | enable_processed_input) |
        enable_extended_flags | enable_virtual_terminal_input;
    if (!SetConsoleMode(handle, mode).toBool()) return error.RawModeUnavailable;
}

pub fn restoreMode(handle: windows.HANDLE, mode: u32) void {
    _ = SetConsoleMode(handle, mode);
}

pub fn poll(handle: windows.HANDLE, timeout_ms: i32) PollResult {
    return pollWithInterest(handle, timeout_ms, true, false);
}

pub fn pollWithInterest(
    handle: windows.HANDLE,
    timeout_ms: i32,
    want_read: bool,
    want_write: bool,
) PollResult {
    const file_type = GetFileType(handle);
    if (pollFileType(file_type, want_read, want_write)) |result| return result;
    return switch (file_type) {
        file_type_pipe => pollPipe(handle, timeout_ms, want_read, want_write),
        file_type_char => pollConsole(handle, timeout_ms, want_read, want_write),
        else => pollSocket(handle, timeout_ms, want_read, want_write),
    };
}

fn pollFileType(file_type: u32, want_read: bool, want_write: bool) ?PollResult {
    return switch (file_type) {
        file_type_disk => .{ .readable = want_read, .writable = want_write },
        file_type_unknown => .{},
        else => null,
    };
}

pub fn pollSocketWithInterest(
    handle: windows.HANDLE,
    timeout_ms: i32,
    want_read: bool,
    want_write: bool,
) PollResult {
    return pollSocket(handle, timeout_ms, want_read, want_write);
}

fn pollPipe(handle: windows.HANDLE, timeout_ms: i32, want_read: bool, want_write: bool) PollResult {
    if (!want_read) return .{ .writable = want_write };
    var remaining = timeout_ms;
    while (true) {
        var available: u32 = 0;
        if (!PeekNamedPipe(handle, null, 0, null, &available, null).toBool()) {
            if (@intFromEnum(windows.GetLastError()) == error_broken_pipe) {
                return .{ .hung_up = true };
            }
            return .{ .has_error = true };
        }
        if (available != 0) return .{ .readable = true, .writable = want_write };
        if (remaining == 0) return .{ .writable = want_write };
        const wait_ms: u32 = if (remaining < 0) 10 else @intCast(@min(remaining, 10));
        Sleep(wait_ms);
        if (remaining > 0) remaining -= @intCast(wait_ms);
    }
}

fn pollConsole(handle: windows.HANDLE, timeout_ms: i32, want_read: bool, want_write: bool) PollResult {
    if (!want_read) return .{ .writable = want_write };
    const timeout: u32 = if (timeout_ms < 0) wait_infinite else @intCast(timeout_ms);
    return switch (WaitForSingleObject(handle, timeout)) {
        wait_object => .{ .readable = true, .writable = want_write },
        wait_timeout => .{},
        else => .{ .has_error = true },
    };
}

fn pollSocket(handle: windows.HANDLE, timeout_ms: i32, want_read: bool, want_write: bool) PollResult {
    var descriptor = windows_pollfd{
        .fd = @intFromPtr(handle),
        .events = (if (want_read) poll_in else 0) | (if (want_write) poll_out else 0),
        .revents = 0,
    };
    const result = WSAPoll(&descriptor, 1, timeout_ms);
    if (result == 0) return .{};
    if (result < 0) return .{ .has_error = true };
    if ((descriptor.revents & poll_nval) != 0) return .{ .has_error = true };
    return .{
        .readable = descriptor.revents & poll_in != 0,
        .writable = descriptor.revents & poll_out != 0,
        .hung_up = descriptor.revents & poll_hup != 0,
        .has_error = descriptor.revents & poll_err != 0,
    };
}

pub fn windowSize(handle: windows.HANDLE) !struct { rows: u16, cols: u16 } {
    var info: console_screen_buffer_info = undefined;
    if (!GetConsoleScreenBufferInfo(handle, &info).toBool()) return error.UnableToReadTerminalSize;
    const cols_i32 = @as(i32, info.window.right) - @as(i32, info.window.left) + 1;
    const rows_i32 = @as(i32, info.window.bottom) - @as(i32, info.window.top) + 1;
    if (cols_i32 <= 0 or rows_i32 <= 0) return error.UnableToReadTerminalSize;
    return .{ .rows = std.math.cast(u16, rows_i32) orelse return error.UnableToReadTerminalSize, .cols = std.math.cast(u16, cols_i32) orelse return error.UnableToReadTerminalSize };
}

test "Windows poll dispatch keeps disk handles out of socket polling" {
    const disk = pollFileType(file_type_disk, true, false).?;
    try std.testing.expect(disk.readable);
    try std.testing.expect(!disk.writable);
    const unknown = pollFileType(file_type_unknown, true, true).?;
    try std.testing.expect(!unknown.has_error);
    try std.testing.expect(!unknown.readable);
    try std.testing.expect(!unknown.writable);
    try std.testing.expect(!unknown.hung_up);
    try std.testing.expect(pollFileType(file_type_pipe, true, true) == null);
}
