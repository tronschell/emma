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
const gateway_schema = @import("../core/tooling/gateway_schema.zig");
const threads_group = @import("emma/threads.zig");
const knowledge_group = @import("emma/knowledge.zig");
const system_group = @import("emma/system.zig");
const browser_group = @import("emma/browser.zig");
const extensions_group = @import("emma/extensions.zig");
const overrides_group = @import("emma/overrides.zig");

pub const all = threads_group.all ++
    knowledge_group.all ++
    system_group.all ++
    browser_group.all ++
    extensions_group.all ++
    overrides_group.all;

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

test "no Emma tool's wording is cut short of the model" {
    const std = @import("std");
    // `cappedDescriptionAlloc` truncates silently, so a description that grew
    // past the cap loses its last commands with nothing to show for it — which
    // is exactly what happened to `workflow` and `autoresearch` under fx's
    // 1024. Two names to change if this ever fails: this one and the source in
    // desktop/main/tools.ts.
    for (all) |tool| {
        std.testing.expect(tool.description.len <= gateway_schema.description_max_bytes) catch |err| {
            std.debug.print("{s}: {d} bytes, cap is {d}\n", .{ tool.name, tool.description.len, gateway_schema.description_max_bytes });
            return err;
        };
    }
}
