const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    const exe = b.addExecutable(.{ .name = "emma-agent", .root_module = module });
    b.installArtifact(exe);

    const tests = b.addTest(.{ .root_module = module });
    const test_step = b.step("test", "Run agent tests");
    test_step.dependOn(&b.addRunArtifact(tests).step);
}
