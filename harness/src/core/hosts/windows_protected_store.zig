const builtin = @import("builtin");
const std = @import("std");

const windows = std.os.windows;

const max_plaintext_bytes: usize = 1024 * 1024;
const envelope_prefix = "FXDPAPI1";
const max_envelope_bytes: usize = max_plaintext_bytes + 4096;
const cryptprotect_ui_forbidden: u32 = 0x1;

pub const Error = error{
    InvalidProtectedData,
    NotProtected,
    OutOfMemory,
    PayloadTooLarge,
    ProtectFailed,
    UnsupportedPlatform,
};

const DataBlob = extern struct {
    cbData: u32,
    pbData: ?[*]u8,
};

extern "crypt32" fn CryptProtectData(
    data_in: *const DataBlob,
    description: ?[*:0]const u16,
    entropy: ?*const DataBlob,
    reserved: ?*anyopaque,
    prompt: ?*anyopaque,
    flags: u32,
    data_out: *DataBlob,
) callconv(.winapi) windows.BOOL;

extern "crypt32" fn CryptUnprotectData(
    data_in: *const DataBlob,
    description: ?*?[*:0]u16,
    entropy: ?*const DataBlob,
    reserved: ?*anyopaque,
    prompt: ?*anyopaque,
    flags: u32,
    data_out: *DataBlob,
) callconv(.winapi) windows.BOOL;

extern "kernel32" fn LocalFree(memory: ?*anyopaque) ?*anyopaque;

pub fn protect(alloc: std.mem.Allocator, plaintext: []const u8) Error![]u8 {
    if (comptime builtin.os.tag != .windows) return error.UnsupportedPlatform;
    if (!payloadLengthValid(plaintext.len)) return error.PayloadTooLarge;
    var input = DataBlob{
        .cbData = @intCast(plaintext.len),
        .pbData = @constCast(plaintext.ptr),
    };
    var output: DataBlob = undefined;
    if (!CryptProtectData(&input, null, null, null, null, cryptprotect_ui_forbidden, &output).toBool()) {
        return error.ProtectFailed;
    }
    defer _ = LocalFree(output.pbData);
    const protected = output.pbData orelse return error.ProtectFailed;
    if (output.cbData == 0 or output.cbData > max_envelope_bytes - envelope_prefix.len) {
        return error.ProtectFailed;
    }
    const result = try alloc.alloc(u8, envelope_prefix.len + output.cbData);
    @memcpy(result[0..envelope_prefix.len], envelope_prefix);
    @memcpy(result[envelope_prefix.len..], protected[0..output.cbData]);
    return result;
}

pub fn unprotect(alloc: std.mem.Allocator, envelope: []const u8) Error![]u8 {
    if (comptime builtin.os.tag != .windows) return error.UnsupportedPlatform;
    if (!isProtected(envelope)) return error.NotProtected;
    const encrypted = envelope[envelope_prefix.len..];
    if (encrypted.len == 0 or encrypted.len > max_envelope_bytes - envelope_prefix.len) {
        return error.InvalidProtectedData;
    }
    var input = DataBlob{
        .cbData = @intCast(encrypted.len),
        .pbData = @constCast(encrypted.ptr),
    };
    var output: DataBlob = undefined;
    var description: ?[*:0]u16 = null;
    if (!CryptUnprotectData(
        &input,
        &description,
        null,
        null,
        null,
        cryptprotect_ui_forbidden,
        &output,
    ).toBool()) {
        return error.InvalidProtectedData;
    }
    defer _ = LocalFree(output.pbData);
    defer {
        if (description) |value| _ = LocalFree(value);
    }
    const protected = output.pbData orelse return error.InvalidProtectedData;
    if (output.cbData == 0 or output.cbData > max_plaintext_bytes) {
        return error.InvalidProtectedData;
    }
    return alloc.dupe(u8, protected[0..output.cbData]);
}

pub fn isProtected(envelope: []const u8) bool {
    return envelope.len > envelope_prefix.len and
        std.mem.startsWith(u8, envelope, envelope_prefix);
}

pub fn payloadLengthValid(length: usize) bool {
    return length > 0 and length <= max_plaintext_bytes;
}

pub fn maxStoredBytes() usize {
    return max_envelope_bytes;
}

test "DPAPI envelope accepts values larger than Credential Manager blobs" {
    const length: usize = 4096;
    try std.testing.expect(length > 5 * 512);
    try std.testing.expect(payloadLengthValid(length));
    try std.testing.expect(!isProtected(&[_]u8{'{'}));
}

test "DPAPI round trip supports values larger than Credential Manager blobs" {
    if (comptime builtin.os.tag != .windows) return error.SkipZigTest;
    const plaintext = try std.testing.allocator.alloc(u8, 4096);
    defer std.testing.allocator.free(plaintext);
    for (plaintext, 0..) |*byte, index| byte.* = @truncate(index);
    const encrypted = try protect(std.testing.allocator, plaintext);
    defer std.testing.allocator.free(encrypted);
    const restored = try unprotect(std.testing.allocator, encrypted);
    defer std.testing.allocator.free(restored);
    try std.testing.expectEqualSlices(u8, plaintext, restored);
}
