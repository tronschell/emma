//! Every tool Emma owns, gathered for the registry.
//!
//! These used to reach the harness as an MCP server on localhost, because MCP
//! was the only door it left open for a tool it does not ship. They are native
//! now: the harness advertises and dispatches them, and the Electron host runs
//! them over `_emma/callTool`. See `tools/emma/bridge.zig` for the one shared
//! implementation behind all of them.
//!
//! Grouped by area, one file per group, so the whole set is not one file.

const tool_dispatch = @import("../core/tooling/tool_dispatch.zig");
const threads_group = @import("emma/threads.zig");

pub const all = threads_group.all;

test "every Emma tool is dispatched by the client and hidden until searched" {
    const std = @import("std");
    for (all) |tool| {
        try std.testing.expectEqual(tool_dispatch.ExecutorKind.emma, tool.executor_kind);
        try std.testing.expectEqual(tool_dispatch.Advertisement.on_select, tool.advertisement);
        // Emma applies its own gate when it runs the call, so a harness prompt
        // would be a second one for the same decision.
        try std.testing.expect(!tool.requires_approval);
        try std.testing.expect(tool.name.len > 0 and tool.description.len > 0);
        try std.testing.expectEqualStrings(tool.name, tool.gateway_schema.name);
    }
}
