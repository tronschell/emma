const std = @import("std");

const windows = std.os.windows;

extern "kernel32" fn OpenProcess(
    desired_access: windows.DWORD,
    inherit_handle: windows.BOOL,
    process_id: windows.DWORD,
) callconv(.winapi) ?windows.HANDLE;

extern "kernel32" fn GetProcessId(handle: windows.HANDLE) callconv(.winapi) windows.DWORD;

extern "kernel32" fn GetProcessTimes(
    process: windows.HANDLE,
    creation: *windows.FILETIME,
    exit_time: *windows.FILETIME,
    kernel_time: *windows.FILETIME,
    user_time: *windows.FILETIME,
) callconv(.winapi) windows.BOOL;

extern "kernel32" fn WaitForSingleObject(
    handle: windows.HANDLE,
    milliseconds: windows.DWORD,
) callconv(.winapi) windows.DWORD;

const process_query_limited_information: windows.DWORD = 0x1000;
const process_synchronize: windows.DWORD = 0x00100000;
const wait_object: windows.DWORD = 0;
const wait_timeout: windows.DWORD = 0x102;
const wait_failed: windows.DWORD = 0xffffffff;

pub fn open(process_id: u32) !windows.HANDLE {
    const handle = OpenProcess(
        process_query_limited_information | process_synchronize,
        @enumFromInt(0),
        process_id,
    );
    return handle orelse error.ProcessNotFound;
}

pub fn close(handle: windows.HANDLE) void {
    windows.CloseHandle(handle);
}

pub fn id(handle: windows.HANDLE) u32 {
    return GetProcessId(handle);
}

pub fn creationTime(handle: windows.HANDLE) !u64 {
    var creation: windows.FILETIME = undefined;
    var exit_time: windows.FILETIME = undefined;
    var kernel_time: windows.FILETIME = undefined;
    var user_time: windows.FILETIME = undefined;
    if (!GetProcessTimes(handle, &creation, &exit_time, &kernel_time, &user_time).toBool()) {
        return error.ProcessIdentityUnavailable;
    }
    return (@as(u64, creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
}

pub fn waitForExit(handle: windows.HANDLE, timeout_ms: i64) !bool {
    const timeout: windows.DWORD = if (timeout_ms < 0)
        0xffffffff
    else
        std.math.cast(windows.DWORD, timeout_ms) orelse return error.SystemResources;
    return switch (WaitForSingleObject(handle, timeout)) {
        wait_object => true,
        wait_timeout => false,
        wait_failed => error.ProcessIdentityUnavailable,
        else => error.ProcessIdentityUnavailable,
    };
}

test "Windows process creation identity is stable for the current process" {
    if (comptime @import("builtin").os.tag != .windows) return error.SkipZigTest;
    const handle = try open(windows.GetCurrentProcessId());
    defer close(handle);
    try std.testing.expect(id(handle) == windows.GetCurrentProcessId());
    try std.testing.expect((try creationTime(handle)) != 0);
}
