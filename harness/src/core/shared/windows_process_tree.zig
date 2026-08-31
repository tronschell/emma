const std = @import("std");
const windows = std.os.windows;
const windows_process = @import("windows_process.zig");

const Allocator = std.mem.Allocator;

const process_entry = extern struct {
    size: windows.DWORD,
    usage: windows.DWORD,
    process_id: windows.DWORD,
    default_heap: windows.ULONG_PTR,
    module_id: windows.DWORD,
    threads: windows.DWORD,
    parent_process_id: windows.DWORD,
    priority: windows.LONG,
    flags: windows.DWORD,
    executable: [260]u16,
};

extern "kernel32" fn CreateToolhelp32Snapshot(
    flags: windows.DWORD,
    process_id: windows.DWORD,
) callconv(.winapi) windows.HANDLE;

extern "kernel32" fn Process32FirstW(
    snapshot: windows.HANDLE,
    entry: *process_entry,
) callconv(.winapi) windows.BOOL;

extern "kernel32" fn Process32NextW(
    snapshot: windows.HANDLE,
    entry: *process_entry,
) callconv(.winapi) windows.BOOL;

const snapshot_processes: windows.DWORD = 0x00000002;
const max_path: usize = 260;

pub const Entry = struct {
    process_id: u32,
    parent_process_id: u32,
    creation_time: u64,
};

pub fn list(alloc: Allocator) ![]Entry {
    const snapshot = CreateToolhelp32Snapshot(snapshot_processes, 0);
    if (snapshot == windows.INVALID_HANDLE_VALUE) return error.ProcessTreeInspectionFailed;
    defer windows.CloseHandle(snapshot);

    var entries: std.ArrayList(Entry) = .empty;
    errdefer entries.deinit(alloc);
    var item = process_entry{
        .size = @sizeOf(process_entry),
        .usage = 0,
        .process_id = 0,
        .default_heap = 0,
        .module_id = 0,
        .threads = 0,
        .parent_process_id = 0,
        .priority = 0,
        .flags = 0,
        .executable = [_]u16{0} ** max_path,
    };
    if (!Process32FirstW(snapshot, &item).toBool()) {
        return error.ProcessTreeInspectionFailed;
    }
    while (true) {
        const creation_time = processCreationTime(item.process_id) catch 0;
        try entries.append(alloc, .{
            .process_id = item.process_id,
            .parent_process_id = item.parent_process_id,
            .creation_time = creation_time,
        });
        if (!Process32NextW(snapshot, &item).toBool()) break;
    }
    return entries.toOwnedSlice(alloc);
}

pub fn creationTimeForId(alloc: Allocator, process_id: u32) !u64 {
    const entries = try list(alloc);
    defer alloc.free(entries);
    for (entries) |entry| {
        if (entry.process_id != process_id) continue;
        if (entry.creation_time == 0) return error.ProcessIdentityUnavailable;
        return entry.creation_time;
    }
    return error.ProcessNotFound;
}

fn processCreationTime(process_id: u32) !u64 {
    const handle = try windows_process.open(process_id);
    defer windows_process.close(handle);
    return windows_process.creationTime(handle);
}

test "Windows process enumeration includes the current process" {
    if (comptime @import("builtin").os.tag != .windows) return error.SkipZigTest;
    const alloc = std.testing.allocator;
    const entries = try list(alloc);
    defer alloc.free(entries);
    const current = windows.GetCurrentProcessId();
    var found = false;
    for (entries) |entry| {
        if (entry.process_id == current) {
            found = true;
            break;
        }
    }
    try std.testing.expect(found);
}
