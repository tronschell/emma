const std = @import("std");

pub noinline fn zeroAndFree(alloc: std.mem.Allocator, value: []u8) void {
    if (value.len == 0) return;
    std.crypto.secureZero(u8, @volatileCast(value));
    alloc.free(value);
}

test "zeroAndFree releases owned allocations and accepts empty slices" {
    zeroAndFree(std.testing.allocator, try std.testing.allocator.dupe(u8, "secret"));
    zeroAndFree(std.testing.allocator, &.{});
}
