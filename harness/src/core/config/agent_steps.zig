const std = @import("std");

pub const default_max_agent_steps: usize = 1000;

pub fn resolveMaxAgentSteps(configured: ?usize, default_value: usize) usize {
    return configured orelse default_value;
}

pub fn parseMaxAgentSteps(raw: ?[]const u8) ?usize {
    const trimmed = std.mem.trim(u8, raw orelse return null, " \t\r\n");
    if (trimmed.len == 0) return null;
    return std.fmt.parseUnsigned(usize, trimmed, 10) catch null;
}

pub fn resolveMaxAgentStepsWithOverride(
    configured: ?usize,
    default_value: usize,
    process_override: ?[]const u8,
) usize {
    return parseMaxAgentSteps(process_override) orelse resolveMaxAgentSteps(configured, default_value);
}

pub fn allowsStep(limit: usize, completed_steps: usize) bool {
    return limit == 0 or completed_steps < limit;
}

pub fn deadlineReached(deadline_ms: ?i64, now_ms: i64) bool {
    const deadline = deadline_ms orelse return false;
    return now_ms >= deadline;
}

pub fn resolveRuntimeMs(default_ms: i64, process_override: ?[]const u8) i64 {
    const trimmed = std.mem.trim(u8, process_override orelse return default_ms, " \t\r\n");
    if (trimmed.len == 0) return default_ms;
    const seconds = std.fmt.parseUnsigned(u32, trimmed, 10) catch return default_ms;
    return @as(i64, seconds) * std.time.ms_per_s;
}

test "resolve max agent steps preserves explicit unbounded zero" {
    try std.testing.expectEqual(@as(usize, 25), resolveMaxAgentSteps(null, 25));
    try std.testing.expectEqual(@as(usize, 0), resolveMaxAgentSteps(0, 25));
    try std.testing.expectEqual(@as(usize, 50), resolveMaxAgentSteps(50, 25));
}

test "parse max agent steps accepts zero and rejects invalid input" {
    try std.testing.expectEqual(@as(usize, 0), parseMaxAgentSteps("0").?);
    try std.testing.expectEqual(@as(usize, 24), parseMaxAgentSteps("24").?);
    try std.testing.expect(parseMaxAgentSteps(null) == null);
    try std.testing.expect(parseMaxAgentSteps("") == null);
    try std.testing.expect(parseMaxAgentSteps("abc") == null);
}

test "process overrides resolve with configured and compiled defaults" {
    try std.testing.expectEqual(default_max_agent_steps, resolveMaxAgentStepsWithOverride(null, default_max_agent_steps, null));
    try std.testing.expectEqual(@as(usize, 0), resolveMaxAgentStepsWithOverride(0, 24, null));
    try std.testing.expectEqual(@as(usize, 24), resolveMaxAgentStepsWithOverride(null, 0, "24"));
    try std.testing.expectEqual(@as(usize, 0), resolveMaxAgentStepsWithOverride(24, 8, "0"));
    try std.testing.expectEqual(@as(usize, 24), resolveMaxAgentStepsWithOverride(24, 8, "invalid"));
    try std.testing.expectEqual(@as(usize, 24), resolveMaxAgentStepsWithOverride(24, 8, "  \t\n"));
}

test "agent step policy treats zero as unbounded and positives as exact caps" {
    try std.testing.expect(allowsStep(0, 0));
    try std.testing.expect(allowsStep(0, 25));
    try std.testing.expect(allowsStep(2, 0));
    try std.testing.expect(allowsStep(2, 1));
    try std.testing.expect(!allowsStep(2, 2));
}

test "agent runtime deadline is inert when unset and fires once reached" {
    try std.testing.expect(!deadlineReached(null, 1_000));
    try std.testing.expect(!deadlineReached(1_000, 999));
    try std.testing.expect(deadlineReached(1_000, 1_000));
    try std.testing.expect(deadlineReached(1_000, 1_001));
}

test "agent runtime override parses seconds and falls back on anything else" {
    const default_ms: i64 = 900_000;
    try std.testing.expectEqual(default_ms, resolveRuntimeMs(default_ms, null));
    try std.testing.expectEqual(default_ms, resolveRuntimeMs(default_ms, ""));
    try std.testing.expectEqual(default_ms, resolveRuntimeMs(default_ms, "abc"));
    try std.testing.expectEqual(@as(i64, 20_000), resolveRuntimeMs(default_ms, "20"));
    try std.testing.expectEqual(@as(i64, 0), resolveRuntimeMs(default_ms, "0"));
}

test "compiled default agent step limit is a real cap" {
    try std.testing.expect(default_max_agent_steps > 0);
    try std.testing.expect(allowsStep(default_max_agent_steps, default_max_agent_steps - 1));
    try std.testing.expect(!allowsStep(default_max_agent_steps, default_max_agent_steps));
}
