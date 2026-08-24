const tool_dispatch = @import("../../core/tooling/tool_dispatch.zig");
const bridge = @import("../../tools/emma/bridge.zig");

const ToolSpec = tool_dispatch.Tool;

const browser_description =
    "Drive a real Chrome browser: open pages, read them, click, fill and check your own work. The user watches the same browser in Emma's browser pane and can take the wheel, so what you do here is visible and what they do is yours to read.\n" ++
    "action \"open\" navigates; \"snapshot\" is how you see — it returns the page as an accessibility tree whose elements carry refs like @e1, and every later action takes a ref or a CSS selector. Snapshot first, then act on a ref: guessing a selector is the common failure.\n" ++
    "Use it to check a web project you are working on — open the dev server, look at the page, click through the change you just made — and to read a page when web_fetch or web_search could not.\n" ++
    "\"get\" reads one thing off the page: text, html, value, attr, title, url or count. \"eval\" runs JavaScript in the page when nothing else will do. \"close\" ends the session; leave it open between turns otherwise, the browser is this thread's and it keeps its cookies and its place.";

pub const browser = ToolSpec{
    .name = "browser",
    .description = browser_description,
    .gateway_schema = .{
        .name = "browser",
        .description = browser_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "action",
                    .json_type = .string,
                    .description = "What to do. snapshot first whenever the next step needs a selector; back, forward, reload and close take nothing else.",
                    .shape = &.{ .enum_values = &.{
                        "open",
                        "snapshot",
                        "click",
                        "fill",
                        "type",
                        "press",
                        "hover",
                        "scroll",
                        "get",
                        "eval",
                        "screenshot",
                        "wait",
                        "back",
                        "forward",
                        "reload",
                        "close",
                    } },
                },
                .{
                    .name = "url",
                    .json_type = .string,
                    .description = "Where to go, for open. http:// or https:// only.",
                },
                .{
                    .name = "selector",
                    .json_type = .string,
                    .description = "Which element to act on: a ref the last snapshot gave it, like @e1, or a CSS selector. Prefer the ref — a selector you guessed rather than read is the usual reason a click lands on nothing.",
                },
                .{
                    .name = "text",
                    .json_type = .string,
                    .description = "What to put in: fill replaces the value of the element at selector, type sends the keystrokes to that element, or to whatever has focus when you give no selector.",
                },
                .{
                    .name = "key",
                    .json_type = .string,
                    .description = "One key for press: Enter, Tab, Escape, ArrowDown, or a combination such as Control+A.",
                },
                .{
                    .name = "field",
                    .json_type = .string,
                    .description = "What get reads: text, html, value or attr off the element at selector, or title, url or count for the page. Defaults to text.",
                    .shape = &.{ .enum_values = &.{ "text", "html", "value", "attr", "title", "url", "count" } },
                },
                .{
                    .name = "direction",
                    .json_type = .string,
                    .description = "Which way scroll goes. Defaults to down.",
                    .shape = &.{ .enum_values = &.{ "up", "down", "left", "right" } },
                },
                .{
                    .name = "amount",
                    .json_type = .number,
                    .description = "How far scroll travels, in pixels. Defaults to one screenful.",
                },
                .{
                    .name = "name",
                    .json_type = .string,
                    .description = "Which attribute to read, for get with field \"attr\": href, src, aria-label.",
                },
                .{
                    .name = "js",
                    .json_type = .string,
                    .description = "JavaScript to run in the page, for eval, returning its result. It runs with the page's own signed-in session, so keep it to reading what snapshot and get cannot reach.",
                },
                .{
                    .name = "interactive",
                    .json_type = .boolean,
                    .description = "For snapshot, return only the elements you can act on. Smaller and usually enough; take the whole tree when you need the page's text.",
                },
            },
            .required = &.{"action"},
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .command,
    .requires_approval = false,
    .action_label = "Using the browser",
    .completed_action_label = "Used the browser",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    .irreversible_fn = bridge.isIrreversible,
};

pub const all = [_]ToolSpec{browser};

test "browser advertises every action agent-browser can be driven with" {
    const std = @import("std");
    const expected = [_][]const u8{
        "open", "snapshot", "click",      "fill", "type", "press",   "hover",  "scroll",
        "get",  "eval",     "screenshot", "wait", "back", "forward", "reload", "close",
    };
    for (browser.gateway_schema.input_schema.properties) |property| {
        if (!std.mem.eql(u8, property.name, "action")) continue;
        const values = property.shape.?.enum_values;
        try std.testing.expectEqual(expected.len, values.len);
        for (expected, values) |want, got| try std.testing.expectEqualStrings(want, got);
        return;
    }
    return error.ActionPropertyMissing;
}
