const tool_dispatch = @import("../core/tooling/tool_dispatch.zig");
const gateway_schema = @import("../core/tooling/gateway_schema.zig");
const threads_group = @import("emma/threads.zig");
const task_list_group = @import("emma/task_list.zig");
const knowledge_group = @import("emma/knowledge.zig");
const system_group = @import("emma/system.zig");
const browser_group = @import("emma/browser.zig");
const extensions_group = @import("emma/extensions.zig");
const overrides_group = @import("emma/overrides.zig");
const shortcuts_group = @import("emma/shortcuts.zig");

pub const all = threads_group.all ++
    task_list_group.all ++
    knowledge_group.all ++
    system_group.all ++
    browser_group.all ++
    extensions_group.all ++
    shortcuts_group.all ++
    overrides_group.all;

test "every Emma tool is dispatched by the client, and only task_list is advertised" {
    const std = @import("std");
    for (all) |tool| {
        try std.testing.expectEqual(tool_dispatch.ExecutorKind.emma, tool.executor_kind);
        const expected: tool_dispatch.Advertisement = if (std.mem.eql(u8, tool.name, "task_list")) .always else .on_select;
        try std.testing.expectEqual(expected, tool.advertisement);
        try std.testing.expect(!tool.requires_approval);
        try std.testing.expect(tool.name.len > 0 and tool.description.len > 0);
        try std.testing.expectEqualStrings(tool.name, tool.gateway_schema.name);
    }
}

test "no Emma tool's wording is cut short of the model" {
    const std = @import("std");
    for (all) |tool| {
        std.testing.expect(tool.description.len <= gateway_schema.description_max_bytes) catch |err| {
            std.debug.print("{s}: {d} bytes, cap is {d}\n", .{ tool.name, tool.description.len, gateway_schema.description_max_bytes });
            return err;
        };
    }
}
