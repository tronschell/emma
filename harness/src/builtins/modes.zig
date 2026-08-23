const std = @import("std");

const builtin_tools = @import("tools.zig");
const mode_contract = @import("../core/modes/mode_contract.zig");
const mode_registry = @import("../core/modes/mode_registry.zig");
const tool_set_contract = @import("../core/tooling/tool_set.zig");

pub const ModeSpec = mode_contract.ModeSpec;
pub const ToolPolicy = mode_contract.ToolPolicy;
pub const default_mode_id = "ask";

/// Emma's picker and this table are the same four rungs, in the same order, so a
/// mode means one thing across the app and the harness. Upstream shipped only
/// `ask` and `code`; `code` is `acceptEdits` under its real behaviour, since
/// `.auto` still gates commands, and `plan` and `full` are the ends it lacked.
pub const all = [_]ModeSpec{
    .{
        .id = "plan",
        .name = "Plan",
        .description = "Read and reason, change nothing",
        .permission_mode = .ask,
        .tool_policy = .read_only,
        .tool_policy_denial_message = "Plan mode is read-only. Say what you would do, and the user can switch modes to let you do it.",
    },
    .{ .id = "ask", .name = "Ask", .description = "Request permission before making any changes", .permission_mode = .ask },
    .{ .id = "acceptEdits", .name = "Accept edits", .description = "Edit files without asking, but ask before running anything", .permission_mode = .auto },
    .{ .id = "full", .name = "Full", .description = "Run unattended, asking for nothing", .permission_mode = .yolo },
};

pub const registry = mode_registry.Registry{
    .default_mode_id = default_mode_id,
    .modes = all[0..],
};

pub fn lookup(id: []const u8) ?*const ModeSpec {
    return registry.lookup(id);
}

test "built-in modes register exact ACP order and permission policy" {
    // Order is the ladder, least power first, because it is what the picker shows.
    const expected_ids = [_][]const u8{ "plan", "ask", "acceptEdits", "full" };
    try std.testing.expectEqual(expected_ids.len, all.len);
    for (expected_ids, all) |expected, mode| {
        try std.testing.expectEqualStrings(expected, mode.id);
    }

    try std.testing.expectEqualStrings("ask", default_mode_id);
    try std.testing.expectEqualStrings(default_mode_id, registry.default_mode_id);
    const Mode = @TypeOf(all[0].permission_mode);
    try std.testing.expectEqual(@as(Mode, .ask), lookup("plan").?.permission_mode);
    try std.testing.expectEqual(@as(Mode, .ask), lookup("ask").?.permission_mode);
    try std.testing.expectEqual(@as(Mode, .auto), lookup("acceptEdits").?.permission_mode);
    // The unattended rung is the only one that asks for nothing; if this ever
    // reads .auto again, "full" silently starts prompting a job nobody is watching.
    try std.testing.expectEqual(@as(Mode, .yolo), lookup("full").?.permission_mode);
    // Plan is the only rung that may not reach a tool that changes the machine.
    try std.testing.expectEqual(ToolPolicy.read_only, lookup("plan").?.tool_policy);
    try std.testing.expectEqual(ToolPolicy.full, lookup("ask").?.tool_policy);
    try std.testing.expectEqual(ToolPolicy.full, lookup("acceptEdits").?.tool_policy);
    try std.testing.expectEqual(ToolPolicy.full, lookup("full").?.tool_policy);
    try std.testing.expect(lookup("unknown") == null);
    // Upstream's id is gone rather than aliased, so a stale caller fails loudly.
    try std.testing.expect(lookup("code") == null);
}

test "every mode opens with the search door and nothing else" {
    // The whole catalog now waits behind `search_tools`, so what a turn starts
    // with is two tools whatever rung it is on. Plan included: it used to be the
    // one mode with a shorter list, and an empty one would strand it.
    inline for (&.{ "plan", "ask", "acceptEdits", "full" }) |mode_id| {
        var projection = try registry.buildGatewayToolProjection(
            std.testing.allocator,
            builtin_tools.advertisement_set,
            mode_id,
            .{},
        );
        defer projection.deinit(std.testing.allocator);

        var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, projection.tools_json, .{});
        defer parsed.deinit();
        const advertised = parsed.value.array.items;
        try std.testing.expectEqual(@as(usize, 2), advertised.len);
        try std.testing.expectEqualStrings("search_tools", advertised[0].object.get("name").?.string);
        try std.testing.expectEqualStrings("select_tool", advertised[1].object.get("name").?.string);
        // Nothing custom is left to advertise, so no tool contributes guidance.
        try std.testing.expectEqualStrings("", projection.custom_guidance);
    }
}

test "built-in mode projections use the supplied tool set" {
    var read_file = builtin_tools.lookup("read_file") orelse return error.TestExpectedEqual;
    // The supplied set is what is under test, not the advertisement policy.
    read_file.advertisement = .always;
    const tools = [_]builtin_tools.ToolSpec{read_file};
    const ordered_names = [_][]const u8{ "write_file", "read_file" };
    const read_only_names = [_][]const u8{ "write_file", "read_file" };
    const tool_set = tool_set_contract.ToolSet{
        .registry = .{ .tools = tools[0..] },
        .order = ordered_names[0..],
        .read_only_tool_names = read_only_names[0..],
    };

    var projection = try registry.buildGatewayToolProjection(std.testing.allocator, tool_set, "ask", .{});
    defer projection.deinit(std.testing.allocator);
    const json = projection.tools_json;

    try std.testing.expect(std.mem.find(u8, json, "\"name\":\"read_file\"") != null);
    try std.testing.expect(std.mem.find(u8, json, "\"name\":\"write_file\"") == null);
    try std.testing.expectEqualStrings("", projection.custom_guidance);
}
