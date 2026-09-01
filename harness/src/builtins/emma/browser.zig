const std = @import("std");
const tool_args = @import("../../core/tooling/tool_args.zig");
const tool_dispatch = @import("../../core/tooling/tool_dispatch.zig");
const core_types = @import("../../core/shared/types.zig");
const bridge = @import("../../tools/emma/bridge.zig");

const ToolSpec = tool_dispatch.Tool;

const Step = struct {
    action: []const u8,
    kind: core_types.ToolActivityKind,
    label: []const u8,
    completed: []const u8,
    arg: tool_dispatch.LabelArgKind,
    default: []const u8,
};

const steps = [_]Step{
    .{ .action = "open", .kind = .command, .label = "Opening", .completed = "Opened", .arg = .url, .default = "a page" },
    .{ .action = "snapshot", .kind = .read, .label = "Reading", .completed = "Read", .arg = .none, .default = "the page" },
    .{ .action = "click", .kind = .command, .label = "Clicking", .completed = "Clicked", .arg = .selector, .default = "the page" },
    .{ .action = "fill", .kind = .command, .label = "Filling in", .completed = "Filled in", .arg = .selector, .default = "a field" },
    .{ .action = "type", .kind = .command, .label = "Typing into", .completed = "Typed into", .arg = .selector, .default = "the page" },
    .{ .action = "press", .kind = .command, .label = "Pressing", .completed = "Pressed", .arg = .key, .default = "a key" },
    .{ .action = "hover", .kind = .command, .label = "Hovering over", .completed = "Hovered over", .arg = .selector, .default = "the page" },
    .{ .action = "scroll", .kind = .command, .label = "Scrolling", .completed = "Scrolled", .arg = .none, .default = "the page" },
    .{ .action = "get", .kind = .read, .label = "Reading", .completed = "Read", .arg = .selector, .default = "the page" },
    .{ .action = "eval", .kind = .command, .label = "Running JavaScript in", .completed = "Ran JavaScript in", .arg = .none, .default = "the page" },
    .{ .action = "screenshot", .kind = .read, .label = "Taking a picture of", .completed = "Took a picture of", .arg = .none, .default = "the page" },
    .{ .action = "wait", .kind = .read, .label = "Waiting for", .completed = "Waited for", .arg = .selector, .default = "the page" },
    .{ .action = "back", .kind = .command, .label = "Going", .completed = "Went", .arg = .none, .default = "back" },
    .{ .action = "forward", .kind = .command, .label = "Going", .completed = "Went", .arg = .none, .default = "forward" },
    .{ .action = "reload", .kind = .command, .label = "Reloading", .completed = "Reloaded", .arg = .none, .default = "the page" },
    .{ .action = "close", .kind = .command, .label = "Closing", .completed = "Closed", .arg = .none, .default = "the browser" },
};

pub fn presentation(args: std.json.ObjectMap) ?tool_dispatch.CallPresentation {
    const action = tool_args.optionalStringArg(args, "action") orelse return null;
    for (steps) |step| {
        if (!std.mem.eql(u8, step.action, action)) continue;
        return .{
            .activity_kind = step.kind,
            .action_label = step.label,
            .completed_action_label = step.completed,
            .label_arg_kind = step.arg,
            .label_arg_default = step.default,
        };
    }
    return null;
}

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
    .action_label = "Using",
    .completed_action_label = "Used",
    .label_arg_default = "the browser",
    .presentation_fn = presentation,
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    .irreversible_fn = bridge.isIrreversible,
};

pub const all = [_]ToolSpec{browser};

test "browser advertises every action agent-browser can be driven with" {
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

test "every browser action says what it is doing" {
    for (browser.gateway_schema.input_schema.properties) |property| {
        if (!std.mem.eql(u8, property.name, "action")) continue;
        for (property.shape.?.enum_values) |action| {
            var buf: [64]u8 = undefined;
            const json = try std.fmt.bufPrint(&buf, "{{\"action\":\"{s}\"}}", .{action});
            var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, json, .{});
            defer parsed.deinit();
            const shown = presentation(parsed.value.object) orelse return error.ActionUnlabelled;
            try std.testing.expect(shown.action_label.len > 0);
            try std.testing.expect(shown.label_arg_kind != .none or shown.label_arg_default.len > 0);
        }
        return;
    }
    return error.ActionPropertyMissing;
}
