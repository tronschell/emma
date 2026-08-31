const builtin = @import("builtin");
const std = @import("std");
const windows_paths = @import("windows_paths.zig");

const windows = std.os.windows;

const dacl_security_information: windows.DWORD = 0x00000004;
const owner_security_information: windows.DWORD = 0x00000001;
const protected_dacl_security_information: windows.DWORD = 0x80000000;
const security_descriptor_revision: windows.DWORD = 1;
const security_descriptor_dacl_protected: u16 = 0x1000;
const acl_size_information_class: c_int = 2;
const access_allowed_ace_type: u8 = 0;
const object_inherit_ace: u8 = 0x01;
const container_inherit_ace: u8 = 0x02;
const inherit_only_ace: u8 = 0x08;
const inherited_ace: u8 = 0x10;
const generic_all: u32 = 0x10000000;
const file_all_access: u32 = 0x001f01ff;
const file_attribute_directory: windows.DWORD = 0x00000010;
const file_attribute_reparse_point: windows.DWORD = 0x00000400;
const file_flag_open_reparse_point: windows.DWORD = 0x00200000;
const file_flag_backup_semantics: windows.DWORD = 0x02000000;
const file_attribute_tag_info: windows.DWORD = 9;
const reparse_tag_af_unix: windows.DWORD = 0x80000023;
const open_existing: windows.DWORD = 3;
const file_share_all: windows.DWORD = 0x00000007;
const file_read_attributes: windows.DWORD = 0x00000080;
const read_control: windows.DWORD = 0x00020000;
const write_dac: windows.DWORD = 0x00040000;
const delete_access: windows.DWORD = 0x00010000;
const file_object: windows.DWORD = 1;
const file_disposition_info: windows.DWORD = 4;
const process_query_limited_information: windows.DWORD = 0x1000;
const token_query: windows.DWORD = 0x0008;
const token_user_information_class: windows.DWORD = 1;
const private_directory_sddl = std.unicode.utf8ToUtf16LeStringLiteral("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;OW)");
const private_file_sddl = std.unicode.utf8ToUtf16LeStringLiteral("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;OW)");
const system_sid_text = std.unicode.utf8ToUtf16LeStringLiteral("S-1-5-18");
const administrators_sid_text = std.unicode.utf8ToUtf16LeStringLiteral("S-1-5-32-544");
const owner_rights_sid_text = std.unicode.utf8ToUtf16LeStringLiteral("S-1-3-4");

const AceHeader = extern struct {
    ace_type: u8,
    ace_flags: u8,
    ace_size: u16,
};

const AclSizeInformation = extern struct {
    ace_count: windows.DWORD,
    acl_bytes_in_use: windows.DWORD,
    acl_bytes_free: windows.DWORD,
};

const SidAndAttributes = extern struct {
    sid: ?*anyopaque,
    attributes: windows.DWORD,
};

const TokenUser = extern struct {
    user: SidAndAttributes,
};

const ByHandleFileInformation = extern struct {
    file_attributes: windows.DWORD,
    creation_time: windows.FILETIME,
    last_access_time: windows.FILETIME,
    last_write_time: windows.FILETIME,
    volume_serial_number: windows.DWORD,
    file_size_high: windows.DWORD,
    file_size_low: windows.DWORD,
    number_of_links: windows.DWORD,
    file_index_high: windows.DWORD,
    file_index_low: windows.DWORD,
};

const FileAttributeTagInfo = extern struct {
    file_attributes: windows.DWORD,
    reparse_tag: windows.DWORD,
};

const FileDispositionInfo = extern struct {
    delete_file: windows.BOOL,
};

const HandlePolicy = enum {
    regular,
    af_unix_endpoint,
};

extern "advapi32" fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
    string_security_descriptor: [*:0]const u16,
    string_sd_revision: windows.DWORD,
    security_descriptor: *?*anyopaque,
    security_descriptor_size: ?*windows.DWORD,
) callconv(.winapi) windows.BOOL;

extern "advapi32" fn GetSecurityDescriptorControl(
    security_descriptor: *anyopaque,
    control: *u16,
    revision: *windows.DWORD,
) callconv(.winapi) windows.BOOL;

extern "advapi32" fn GetSecurityDescriptorDacl(
    security_descriptor: *anyopaque,
    dacl_present: *windows.BOOL,
    dacl: *?*anyopaque,
    dacl_defaulted: *windows.BOOL,
) callconv(.winapi) windows.BOOL;

extern "advapi32" fn GetSecurityDescriptorOwner(
    security_descriptor: *anyopaque,
    owner: *?*anyopaque,
    owner_defaulted: *windows.BOOL,
) callconv(.winapi) windows.BOOL;

extern "advapi32" fn GetAclInformation(
    acl: *anyopaque,
    acl_information: *anyopaque,
    acl_information_length: windows.DWORD,
    acl_information_class: c_int,
) callconv(.winapi) windows.BOOL;

extern "advapi32" fn GetAce(
    acl: *anyopaque,
    ace_index: windows.DWORD,
    ace: *?*anyopaque,
) callconv(.winapi) windows.BOOL;

extern "advapi32" fn EqualSid(first: *anyopaque, second: *anyopaque) callconv(.winapi) windows.BOOL;

extern "advapi32" fn IsValidSid(sid: *anyopaque) callconv(.winapi) windows.BOOL;

extern "advapi32" fn GetLengthSid(sid: *anyopaque) callconv(.winapi) windows.DWORD;

extern "advapi32" fn OpenProcessToken(
    process: windows.HANDLE,
    desired_access: windows.DWORD,
    token: *windows.HANDLE,
) callconv(.winapi) windows.BOOL;

extern "advapi32" fn GetTokenInformation(
    token: windows.HANDLE,
    token_information_class: windows.DWORD,
    token_information: ?*anyopaque,
    token_information_length: windows.DWORD,
    return_length: *windows.DWORD,
) callconv(.winapi) windows.BOOL;

extern "advapi32" fn GetSecurityInfo(
    handle: windows.HANDLE,
    object_type: windows.DWORD,
    security_info: windows.DWORD,
    owner: ?*?*anyopaque,
    group: ?*?*anyopaque,
    dacl: ?*?*anyopaque,
    sacl: ?*?*anyopaque,
    security_descriptor: *?*anyopaque,
) callconv(.winapi) windows.DWORD;

extern "advapi32" fn SetSecurityInfo(
    handle: windows.HANDLE,
    object_type: windows.DWORD,
    security_info: windows.DWORD,
    owner: ?*anyopaque,
    group: ?*anyopaque,
    dacl: ?*anyopaque,
    sacl: ?*anyopaque,
) callconv(.winapi) windows.DWORD;

extern "advapi32" fn ConvertStringSidToSidW(
    string_sid: [*:0]const u16,
    sid: *?*anyopaque,
) callconv(.winapi) windows.BOOL;

extern "kernel32" fn LocalFree(memory: ?*anyopaque) ?*anyopaque;

extern "kernel32" fn CreateFileW(
    file_name: [*:0]const u16,
    desired_access: windows.DWORD,
    share_mode: windows.DWORD,
    security_attributes: ?*anyopaque,
    creation_disposition: windows.DWORD,
    flags_and_attributes: windows.DWORD,
    template_file: ?windows.HANDLE,
) callconv(.winapi) windows.HANDLE;

extern "kernel32" fn GetFileInformationByHandle(
    handle: windows.HANDLE,
    information: *ByHandleFileInformation,
) callconv(.winapi) windows.BOOL;

extern "kernel32" fn GetFileInformationByHandleEx(
    handle: windows.HANDLE,
    file_information_class: windows.DWORD,
    file_information: *anyopaque,
    buffer_size: windows.DWORD,
) callconv(.winapi) windows.BOOL;

extern "kernel32" fn SetFileInformationByHandle(
    handle: windows.HANDLE,
    file_information_class: windows.DWORD,
    file_information: *anyopaque,
    buffer_size: windows.DWORD,
) callconv(.winapi) windows.BOOL;

extern "kernel32" fn ReOpenFile(
    original_file: windows.HANDLE,
    desired_access: windows.DWORD,
    share_mode: windows.DWORD,
    flags_and_attributes: windows.DWORD,
) callconv(.winapi) windows.HANDLE;

extern "kernel32" fn OpenProcess(
    desired_access: windows.DWORD,
    inherit_handle: windows.BOOL,
    process_id: windows.DWORD,
) callconv(.winapi) ?windows.HANDLE;

fn widePath(path: []const u8) ![:0]u16 {
    const normalized = try windows_paths.normalizeLongPath(std.heap.page_allocator, path);
    defer std.heap.page_allocator.free(normalized);
    return std.unicode.wtf8ToWtf16LeAllocZ(std.heap.page_allocator, normalized);
}

const DescriptorMatch = struct {
    matched: bool,
    inherited: bool,
    protected: bool,
};

fn noMatch(protected: bool) DescriptorMatch {
    return .{ .matched = false, .inherited = false, .protected = protected };
}

fn tokenUserSid(alloc: std.mem.Allocator, token: windows.HANDLE) ![]u8 {
    var size: windows.DWORD = 0;
    if (GetTokenInformation(
        token,
        token_user_information_class,
        null,
        0,
        &size,
    ).toBool() or windows.GetLastError() != .INSUFFICIENT_BUFFER or size < @sizeOf(TokenUser)) {
        return error.SecurityApiFailed;
    }
    const info = try alloc.alignedAlloc(u8, std.mem.Alignment.of(TokenUser), size);
    defer alloc.free(info);
    if (!GetTokenInformation(
        token,
        token_user_information_class,
        info.ptr,
        size,
        &size,
    ).toBool()) return error.SecurityApiFailed;
    const user: *const TokenUser = @ptrCast(@alignCast(info.ptr));
    const sid = user.user.sid orelse return error.SecurityApiFailed;
    if (!IsValidSid(sid).toBool()) return error.SecurityApiFailed;
    const sid_length = GetLengthSid(sid);
    if (sid_length == 0 or sid_length > size) return error.SecurityApiFailed;
    const copy = try alloc.alloc(u8, sid_length);
    @memcpy(copy, @as([*]const u8, @ptrCast(sid))[0..sid_length]);
    return copy;
}

fn currentProcessSid(alloc: std.mem.Allocator) ![]u8 {
    var token: windows.HANDLE = undefined;
    if (!OpenProcessToken(windows.current_process, token_query, &token).toBool()) {
        return error.SecurityApiFailed;
    }
    defer windows.CloseHandle(token);
    return tokenUserSid(alloc, token);
}

fn tokenUsersMatch(
    alloc: std.mem.Allocator,
    first: windows.HANDLE,
    second: windows.HANDLE,
) !bool {
    const first_sid = try tokenUserSid(alloc, first);
    defer alloc.free(first_sid);
    const second_sid = try tokenUserSid(alloc, second);
    defer alloc.free(second_sid);
    return EqualSid(
        @ptrCast(first_sid.ptr),
        @ptrCast(second_sid.ptr),
    ).toBool();
}

pub fn peerProcessMatchesCurrentUser(process_id: u32) !bool {
    const process = OpenProcess(
        process_query_limited_information,
        @enumFromInt(0),
        process_id,
    ) orelse return error.SecurityApiFailed;
    defer windows.CloseHandle(process);
    var token: windows.HANDLE = undefined;
    if (!OpenProcessToken(process, token_query, &token).toBool()) {
        return error.SecurityApiFailed;
    }
    defer windows.CloseHandle(token);
    const current_process_token = blk: {
        var current: windows.HANDLE = undefined;
        if (!OpenProcessToken(windows.current_process, token_query, &current).toBool()) {
            return error.SecurityApiFailed;
        }
        break :blk current;
    };
    defer windows.CloseHandle(current_process_token);
    return tokenUsersMatch(std.heap.page_allocator, token, current_process_token);
}

fn descriptorOwnerMatches(descriptor: *anyopaque) !bool {
    var owner: ?*anyopaque = null;
    var owner_defaulted: windows.BOOL = .FALSE;
    if (!GetSecurityDescriptorOwner(descriptor, &owner, &owner_defaulted).toBool()) {
        return error.SecurityApiFailed;
    }
    const owner_sid = owner orelse return false;
    if (!IsValidSid(owner_sid).toBool()) return false;
    const current_sid = try currentProcessSid(std.heap.page_allocator);
    defer std.heap.page_allocator.free(current_sid);
    return EqualSid(owner_sid, @ptrCast(current_sid.ptr)).toBool();
}

fn descriptorMatches(descriptor: *anyopaque, directory: bool) !DescriptorMatch {
    var control: u16 = 0;
    var revision: windows.DWORD = 0;
    if (!GetSecurityDescriptorControl(descriptor, &control, &revision).toBool()) {
        return error.SecurityApiFailed;
    }
    const protected = control & security_descriptor_dacl_protected != 0;
    if (!(try descriptorOwnerMatches(descriptor))) return noMatch(protected);

    var dacl_present: windows.BOOL = .FALSE;
    var dacl: ?*anyopaque = null;
    var dacl_defaulted: windows.BOOL = .FALSE;
    if (!GetSecurityDescriptorDacl(descriptor, &dacl_present, &dacl, &dacl_defaulted).toBool()) {
        return error.SecurityApiFailed;
    }
    const acl = dacl orelse return noMatch(protected);
    if (!dacl_present.toBool()) return noMatch(protected);

    var system_sid: ?*anyopaque = null;
    defer {
        if (system_sid) |sid| _ = LocalFree(sid);
    }
    if (!ConvertStringSidToSidW(system_sid_text, &system_sid).toBool()) return error.SecurityApiFailed;
    const system = system_sid orelse return error.SecurityApiFailed;

    var administrators_sid: ?*anyopaque = null;
    defer {
        if (administrators_sid) |sid| _ = LocalFree(sid);
    }
    if (!ConvertStringSidToSidW(administrators_sid_text, &administrators_sid).toBool()) {
        return error.SecurityApiFailed;
    }
    const administrators = administrators_sid orelse return error.SecurityApiFailed;

    var owner_rights_sid: ?*anyopaque = null;
    defer {
        if (owner_rights_sid) |sid| _ = LocalFree(sid);
    }
    if (!ConvertStringSidToSidW(owner_rights_sid_text, &owner_rights_sid).toBool()) {
        return error.SecurityApiFailed;
    }
    const owner_rights = owner_rights_sid orelse return error.SecurityApiFailed;

    var acl_info: AclSizeInformation = undefined;
    if (!GetAclInformation(
        acl,
        @ptrCast(&acl_info),
        @sizeOf(AclSizeInformation),
        acl_size_information_class,
    ).toBool()) return error.SecurityApiFailed;

    var found_system = false;
    var found_administrators = false;
    var found_owner = false;
    var found_inherited = false;
    for (0..acl_info.ace_count) |index| {
        var ace: ?*anyopaque = null;
        if (!GetAce(acl, @intCast(index), &ace).toBool()) return error.SecurityApiFailed;
        const ace_pointer = ace orelse return error.SecurityApiFailed;
        const header = @as(*const AceHeader, @ptrCast(@alignCast(ace_pointer))).*;
        if (header.ace_size < 12) return noMatch(protected);
        if (header.ace_type != access_allowed_ace_type) return noMatch(protected);
        if (header.ace_flags & inherit_only_ace != 0) return noMatch(protected);

        const base = @intFromPtr(ace_pointer);
        const mask = @as(*const u32, @ptrFromInt(base + 4)).*;
        const sid = @as(*anyopaque, @ptrFromInt(base + 8));
        const full_access = (mask & generic_all != 0) or (mask & file_all_access) == file_all_access;
        if (!full_access) return noMatch(protected);

        const is_system = EqualSid(sid, system).toBool();
        const is_administrators = EqualSid(sid, administrators).toBool();
        const is_owner = EqualSid(sid, owner_rights).toBool();
        if (!is_system and !is_administrators and !is_owner) return noMatch(protected);
        found_system = found_system or is_system;
        found_administrators = found_administrators or is_administrators;
        found_owner = found_owner or is_owner;
        found_inherited = found_inherited or (header.ace_flags & inherited_ace != 0);
        if (directory and header.ace_flags & (object_inherit_ace | container_inherit_ace) !=
            (object_inherit_ace | container_inherit_ace)) return noMatch(protected);
    }
    return .{
        .matched = found_system and found_administrators and found_owner,
        .inherited = found_inherited,
        .protected = protected,
    };
}

fn isAllowedReparsePoint(
    attributes: windows.DWORD,
    reparse_tag: windows.DWORD,
    policy: HandlePolicy,
) bool {
    return switch (policy) {
        .regular => attributes & file_attribute_reparse_point == 0,
        .af_unix_endpoint => attributes & file_attribute_reparse_point != 0 and
            reparse_tag == reparse_tag_af_unix,
    };
}

fn allowedReparsePoint(
    handle: windows.HANDLE,
    attributes: windows.DWORD,
    policy: HandlePolicy,
) !bool {
    if (attributes & file_attribute_reparse_point == 0) {
        return policy == .regular;
    }
    var tag_info: FileAttributeTagInfo = undefined;
    if (!GetFileInformationByHandleEx(
        handle,
        file_attribute_tag_info,
        @ptrCast(&tag_info),
        @sizeOf(FileAttributeTagInfo),
    ).toBool()) return error.SecurityApiFailed;
    return isAllowedReparsePoint(
        tag_info.file_attributes,
        tag_info.reparse_tag,
        policy,
    );
}

fn fileInformation(handle: windows.HANDLE, policy: HandlePolicy) !ByHandleFileInformation {
    var information: ByHandleFileInformation = undefined;
    if (!GetFileInformationByHandle(handle, &information).toBool()) {
        return error.SecurityApiFailed;
    }
    if (!(try allowedReparsePoint(handle, information.file_attributes, policy))) {
        return error.SecurityApiFailed;
    }
    return information;
}

fn sameFile(first: ByHandleFileInformation, second: ByHandleFileInformation) bool {
    return first.volume_serial_number == second.volume_serial_number and
        first.file_index_high == second.file_index_high and
        first.file_index_low == second.file_index_low;
}

fn reopenForSecurity(
    handle: windows.HANDLE,
    desired_access: windows.DWORD,
    policy: HandlePolicy,
) !windows.HANDLE {
    const original = try fileInformation(handle, policy);
    const reopened = ReOpenFile(
        handle,
        desired_access,
        file_share_all,
        file_flag_open_reparse_point | file_flag_backup_semantics,
    );
    if (reopened == windows.INVALID_HANDLE_VALUE) return error.SecurityApiFailed;
    errdefer windows.CloseHandle(reopened);
    const reopened_info = try fileInformation(reopened, policy);
    if (!sameFile(original, reopened_info)) return error.SecurityApiFailed;
    return reopened;
}

fn descriptorForHandle(handle: windows.HANDLE, policy: HandlePolicy) !struct {
    descriptor: *anyopaque,
    directory: bool,
} {
    const information = try fileInformation(handle, policy);
    var descriptor: ?*anyopaque = null;
    if (GetSecurityInfo(
        handle,
        file_object,
        dacl_security_information | owner_security_information,
        null,
        null,
        null,
        null,
        &descriptor,
    ) != 0) return error.SecurityApiFailed;
    return .{
        .descriptor = descriptor orelse return error.SecurityApiFailed,
        .directory = information.file_attributes & file_attribute_directory != 0,
    };
}

pub fn applyHandle(handle: windows.HANDLE) !void {
    const security_handle = try reopenForSecurity(
        handle,
        read_control | write_dac | file_read_attributes,
        .regular,
    );
    defer windows.CloseHandle(security_handle);
    const information = try fileInformation(security_handle, .regular);
    try applySecurityHandle(security_handle, information);
}

pub fn applyEndpointHandle(handle: windows.HANDLE) !void {
    const security_handle = try reopenForSecurity(
        handle,
        read_control | write_dac | file_read_attributes,
        .af_unix_endpoint,
    );
    defer windows.CloseHandle(security_handle);
    const information = try fileInformation(security_handle, .af_unix_endpoint);
    try applySecurityHandle(security_handle, information);
}

fn applySecurityHandle(handle: windows.HANDLE, information: ByHandleFileInformation) !void {
    const sddl = if (information.file_attributes & file_attribute_directory != 0)
        private_directory_sddl
    else
        private_file_sddl;

    var descriptor: ?*anyopaque = null;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl,
        security_descriptor_revision,
        &descriptor,
        null,
    ).toBool()) return error.SecurityApiFailed;
    defer _ = LocalFree(descriptor);
    const value = descriptor orelse return error.SecurityApiFailed;
    var dacl_present: windows.BOOL = .FALSE;
    var dacl: ?*anyopaque = null;
    var dacl_defaulted: windows.BOOL = .FALSE;
    if (!GetSecurityDescriptorDacl(value, &dacl_present, &dacl, &dacl_defaulted).toBool() or
        !dacl_present.toBool()) return error.SecurityApiFailed;
    if (SetSecurityInfo(
        handle,
        file_object,
        dacl_security_information | protected_dacl_security_information,
        null,
        null,
        dacl,
        null,
    ) != 0) return error.SecurityApiFailed;
}

pub fn matchesHandle(handle: windows.HANDLE) !bool {
    const security_handle = try reopenForSecurity(
        handle,
        read_control | file_read_attributes,
        .regular,
    );
    defer windows.CloseHandle(security_handle);
    const fetched = try descriptorForHandle(security_handle, .regular);
    defer _ = LocalFree(fetched.descriptor);
    return (try descriptorMatches(fetched.descriptor, fetched.directory)).matched;
}

pub fn matchesEndpointHandle(handle: windows.HANDLE) !bool {
    const security_handle = try reopenForSecurity(
        handle,
        read_control | file_read_attributes,
        .af_unix_endpoint,
    );
    defer windows.CloseHandle(security_handle);
    const fetched = try descriptorForHandle(security_handle, .af_unix_endpoint);
    defer _ = LocalFree(fetched.descriptor);
    return (try descriptorMatches(fetched.descriptor, fetched.directory)).matched;
}

pub fn deleteEndpointHandle(handle: windows.HANDLE) !void {
    const deletion_handle = try reopenForSecurity(
        handle,
        delete_access | file_read_attributes,
        .af_unix_endpoint,
    );
    defer windows.CloseHandle(deletion_handle);
    var disposition = FileDispositionInfo{ .delete_file = .TRUE };
    if (!SetFileInformationByHandle(
        deletion_handle,
        file_disposition_info,
        @ptrCast(&disposition),
        @sizeOf(FileDispositionInfo),
    ).toBool()) return error.SecurityApiFailed;
}

fn openPathHandle(path: []const u8, desired_access: windows.DWORD) !windows.HANDLE {
    const wide_path = try widePath(path);
    defer std.heap.page_allocator.free(wide_path);
    const handle = CreateFileW(
        wide_path.ptr,
        desired_access,
        file_share_all,
        null,
        open_existing,
        file_flag_open_reparse_point | file_flag_backup_semantics,
        null,
    );
    if (handle == windows.INVALID_HANDLE_VALUE) return error.SecurityApiFailed;
    return handle;
}

pub fn apply(path: []const u8) !void {
    const handle = try openPathHandle(path, read_control | write_dac | file_read_attributes);
    defer windows.CloseHandle(handle);
    try applyHandle(handle);
}

fn pathMatch(path: []const u8) !DescriptorMatch {
    const handle = try openPathHandle(path, read_control | file_read_attributes);
    defer windows.CloseHandle(handle);
    const fetched = try descriptorForHandle(handle, .regular);
    defer _ = LocalFree(fetched.descriptor);
    return descriptorMatches(fetched.descriptor, fetched.directory);
}

pub fn matches(path: []const u8) !bool {
    const result = try pathMatch(path);
    if (!result.matched) return false;
    if (result.protected) return true;
    if (!result.inherited) return false;
    const parent = std.fs.path.dirname(path) orelse return false;
    return matches(parent);
}

fn hasInheritedAce(path: []const u8) !bool {
    const result = try pathMatch(path);
    if (!result.matched or !result.inherited) return false;
    if (result.protected) return true;
    const parent = std.fs.path.dirname(path) orelse return false;
    return matches(parent);
}

test "Windows ACL protects a directory and inherited child" {
    if (comptime builtin.os.tag != .windows) return error.SkipZigTest;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDir(std.testing.io, "private", .default_dir);
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path_len = try tmp.dir.realPath(std.testing.io, &path_buf);
    const private_path = try std.fs.path.join(std.testing.allocator, &.{ path_buf[0..path_len], "private" });
    defer std.testing.allocator.free(private_path);
    try apply(private_path);
    try std.testing.expect(try matches(private_path));

    var private_dir = try tmp.dir.openDir(std.testing.io, "private", .{ .iterate = true });
    defer private_dir.close(std.testing.io);
    try private_dir.createDir(std.testing.io, "child", .default_dir);
    try private_dir.writeFile(std.testing.io, .{ .sub_path = "child.txt", .data = "secret" });

    const child_dir = try std.fs.path.join(std.testing.allocator, &.{ private_path, "child" });
    defer std.testing.allocator.free(child_dir);
    const child_file = try std.fs.path.join(std.testing.allocator, &.{ private_path, "child.txt" });
    defer std.testing.allocator.free(child_file);
    var child_file_handle = try private_dir.openFile(std.testing.io, "child.txt", .{
        .mode = .read_write,
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer child_file_handle.close(std.testing.io);
    try applyHandle(child_file_handle.handle);
    try std.testing.expect(try matchesHandle(child_file_handle.handle));
    try std.testing.expect(try matches(child_dir));
    try std.testing.expect(try matches(child_file));
    try std.testing.expect(try hasInheritedAce(child_dir));
    try std.testing.expect(try hasInheritedAce(child_file));
}

test "AF_UNIX reparse points are endpoint-only" {
    try std.testing.expect(isAllowedReparsePoint(0, 0, .regular));
    try std.testing.expect(!isAllowedReparsePoint(
        file_attribute_reparse_point,
        reparse_tag_af_unix,
        .regular,
    ));
    try std.testing.expect(isAllowedReparsePoint(
        file_attribute_reparse_point,
        reparse_tag_af_unix,
        .af_unix_endpoint,
    ));
    try std.testing.expect(!isAllowedReparsePoint(
        file_attribute_reparse_point,
        0x80000001,
        .af_unix_endpoint,
    ));
    try std.testing.expect(!isAllowedReparsePoint(0, 0, .af_unix_endpoint));
}
