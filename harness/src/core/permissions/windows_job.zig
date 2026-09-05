const builtin = @import("builtin");
const std = @import("std");
const windows_process = @import("../shared/windows_process.zig");

const windows = std.os.windows;

const job_object_extended_limit_information: u32 = 9;
const job_object_limit_kill_on_job_close: u32 = 0x2000;
const job_object_limit_breakaway_ok: u32 = 0x0800;

const BasicLimitInformation = extern struct {
    PerProcessUserTimeLimit: i64,
    PerJobUserTimeLimit: i64,
    LimitFlags: u32,
    MinimumWorkingSetSize: usize,
    MaximumWorkingSetSize: usize,
    ActiveProcessLimit: u32,
    Affinity: usize,
    PriorityClass: u32,
    SchedulingClass: u32,
};

const IoCounters = extern struct {
    ReadOperationCount: u64,
    WriteOperationCount: u64,
    OtherOperationCount: u64,
    ReadTransferCount: u64,
    WriteTransferCount: u64,
    OtherTransferCount: u64,
};

const ExtendedLimitInformation = extern struct {
    BasicLimitInformation: BasicLimitInformation,
    IoInfo: IoCounters,
    ProcessMemoryLimit: usize,
    JobMemoryLimit: usize,
    PeakProcessMemoryUsed: usize,
    PeakJobMemoryUsed: usize,
};

extern "kernel32" fn CreateJobObjectW(
    attributes: ?*anyopaque,
    name: ?[*:0]const u16,
) callconv(.winapi) ?windows.HANDLE;
extern "kernel32" fn SetInformationJobObject(
    job: windows.HANDLE,
    info_class: c_int,
    info: *anyopaque,
    info_length: u32,
) callconv(.winapi) windows.BOOL;
extern "kernel32" fn AssignProcessToJobObject(
    job: windows.HANDLE,
    process: windows.HANDLE,
) callconv(.winapi) windows.BOOL;
extern "kernel32" fn TerminateJobObject(
    job: windows.HANDLE,
    exit_code: u32,
) callconv(.winapi) windows.BOOL;
extern "kernel32" fn IsProcessInJob(
    process: windows.HANDLE,
    job: windows.HANDLE,
    result: *windows.BOOL,
) callconv(.winapi) windows.BOOL;
extern "kernel32" fn GetLastError() callconv(.winapi) windows.DWORD;
extern "kernel32" fn CloseHandle(handle: windows.HANDLE) callconv(.winapi) windows.BOOL;
extern "kernel32" fn ResumeThread(thread: windows.HANDLE) callconv(.winapi) windows.DWORD;

pub const Error = error{
    AssignFailed,
    CreateFailed,
    ConfigureFailed,
    ResumeFailed,
    TrackFailed,
    UnsupportedPlatform,
};

const tracked_job_capacity: usize = 128;
const error_already_exists: windows.DWORD = 183;
const TrackedJob = struct {
    process_id: u32,
    creation_time: u64,
    handle: windows.HANDLE,
    detached: bool = false,
};

var tracked_jobs: [tracked_job_capacity]?TrackedJob = [_]?TrackedJob{null} ** tracked_job_capacity;
var tracked_jobs_lock: std.atomic.Mutex = .unlocked;

fn lockTrackedJobs() void {
    while (!tracked_jobs_lock.tryLock()) std.atomic.spinLoopHint();
}

fn unlockTrackedJobs() void {
    tracked_jobs_lock.unlock();
}

fn limitFlags(kill_on_close: bool) u32 {
    return job_object_limit_breakaway_ok |
        (if (kill_on_close) job_object_limit_kill_on_job_close else 0);
}

fn trackJob(job: TrackedJob) Error!void {
    lockTrackedJobs();
    defer unlockTrackedJobs();
    for (&tracked_jobs) |*slot| {
        if (slot.* == null) {
            slot.* = job;
            return;
        }
    }
    return error.TrackFailed;
}

fn untrackJob(handle: windows.HANDLE) void {
    lockTrackedJobs();
    defer unlockTrackedJobs();
    for (&tracked_jobs) |*slot| {
        if (slot.*) |entry| {
            if (entry.handle == handle) slot.* = null;
        }
    }
}

fn detachJob(handle: windows.HANDLE) void {
    lockTrackedJobs();
    defer unlockTrackedJobs();
    for (&tracked_jobs) |*slot| {
        if (slot.*) |*entry| {
            if (entry.handle == handle) entry.detached = true;
        }
    }
}

fn jobName(buffer: *[64]u16, process_id: u32, creation_time: u64) windows.LPCWSTR {
    const prefix = "Local\\EmmaFxJob-";
    var length: usize = 0;
    for (prefix) |byte| {
        buffer[length] = byte;
        length += 1;
    }
    var shift: u5 = 28;
    for (0..8) |index| {
        const digit = (process_id >> shift) & 0xf;
        buffer[length + index] = if (digit < 10)
            '0' + @as(u16, @intCast(digit))
        else
            'a' + @as(u16, @intCast(digit - 10));
        if (shift == 0) break;
        shift -= 4;
    }
    length += 8;
    buffer[length] = '-';
    length += 1;
    var creation_shift: u6 = 60;
    for (0..16) |index| {
        const digit = (creation_time >> creation_shift) & 0xf;
        buffer[length + index] = if (digit < 10)
            '0' + @as(u16, @intCast(digit))
        else
            'a' + @as(u16, @intCast(digit - 10));
        if (creation_shift == 0) break;
        creation_shift -= 4;
    }
    length += 16;
    buffer[length] = 0;
    return buffer[0..length :0];
}

const WindowsJob = struct {
    handle: windows.HANDLE,

    pub fn init(process: windows.HANDLE, kill_on_close: bool) Error!WindowsJob {
        if (comptime builtin.os.tag != .windows) return error.UnsupportedPlatform;
        const process_id = windows_process.id(process);
        const creation_time = windows_process.creationTime(process) catch
            return error.TrackFailed;
        var name_buffer: [64]u16 = undefined;
        const name = jobName(&name_buffer, process_id, creation_time);
        const handle = CreateJobObjectW(null, name) orelse return error.CreateFailed;
        errdefer _ = CloseHandle(handle);
        if (GetLastError() == error_already_exists) return error.CreateFailed;
        var limits = std.mem.zeroes(ExtendedLimitInformation);
        limits.BasicLimitInformation.LimitFlags = limitFlags(kill_on_close);
        if (!SetInformationJobObject(
            handle,
            job_object_extended_limit_information,
            @ptrCast(&limits),
            @sizeOf(ExtendedLimitInformation),
        ).toBool()) return error.ConfigureFailed;
        if (!AssignProcessToJobObject(handle, process).toBool()) return error.AssignFailed;
        var member: windows.BOOL = .FALSE;
        if (!IsProcessInJob(process, handle, &member).toBool() or !member.toBool()) {
            return error.AssignFailed;
        }
        try trackJob(.{
            .process_id = process_id,
            .creation_time = creation_time,
            .handle = handle,
        });
        return .{ .handle = handle };
    }

    pub fn terminate(self: *WindowsJob) void {
        _ = TerminateJobObject(self.handle, 1);
    }

    pub fn terminateForProcess(process_id: u32, creation_time: u64) bool {
        var detached_handle: ?windows.HANDLE = null;
        var terminated = false;
        lockTrackedJobs();
        for (&tracked_jobs) |*slot| {
            if (slot.*) |tracked| {
                if (tracked.process_id == process_id and
                    tracked.creation_time == creation_time)
                {
                    terminated = TerminateJobObject(tracked.handle, 1).toBool();
                    if (terminated and tracked.detached) {
                        detached_handle = tracked.handle;
                        slot.* = null;
                    }
                    break;
                }
            }
        }
        unlockTrackedJobs();
        if (detached_handle) |value| _ = CloseHandle(value);
        return terminated;
    }

    pub fn detach(self: *WindowsJob) void {
        detachJob(self.handle);
        self.* = undefined;
    }

    pub fn deinit(self: *WindowsJob) void {
        untrackJob(self.handle);
        _ = CloseHandle(self.handle);
        self.* = undefined;
    }

    pub fn resumeThread(thread: windows.HANDLE) Error!void {
        if (ResumeThread(thread) == 0xffffffff) return error.ResumeFailed;
    }
};

const NoJob = struct {
    pub fn init(_: anytype, _: bool) Error!NoJob {
        return error.UnsupportedPlatform;
    }

    pub fn terminate(_: *NoJob) void {}

    pub fn deinit(_: *NoJob) void {}

    pub fn detach(_: *NoJob) void {}

    pub fn terminateForProcess(_: u32, _: u64) bool {
        return false;
    }

    pub fn resumeThread(_: anytype) Error!void {
        return error.UnsupportedPlatform;
    }
};

pub const Job = if (builtin.os.tag == .windows) WindowsJob else NoJob;

pub fn available() bool {
    return builtin.os.tag == .windows;
}

test "Windows job object uses kill on close" {
    try std.testing.expectEqual(
        job_object_limit_kill_on_job_close,
        @as(u32, 0x2000),
    );
}

test "Windows durable job object does not kill on close" {
    try std.testing.expectEqual(job_object_limit_breakaway_ok, limitFlags(false));
}

test "Windows job object lets a deliberate child break away" {
    try std.testing.expectEqual(
        job_object_limit_breakaway_ok | job_object_limit_kill_on_job_close,
        limitFlags(true),
    );
}
