//! One implementation behind every Emma tool.
//!
//! Emma's tools run in the Electron host — they read and write its durable
//! Markdown stores, its threads and its screen grants — so the harness never
//! executes one. It advertises the tool, checks that the arguments are an
//! object, and hands the raw JSON back over ACP as `_emma/callTool`. That keeps
//! twenty-odd tool schemas in one place instead of mirrored in two languages.
//!
//! What differs per tool is only its spec: name, description, schema, and
//! whether it reads or writes. Those come from `tool_dispatch.Tool`, not here.

const std = @import("std");
const tool_dispatch = @import("../../core/tooling/tool_dispatch.zig");

const Allocator = std.mem.Allocator;

/// The arguments exactly as the model produced them. The client owns the
/// schema, so decoding here would only be a second place to keep it correct.
pub const Input = struct {
    arguments_json: []u8,

    fn deinit(self: *Input, alloc: Allocator) void {
        alloc.free(self.arguments_json);
    }
};

pub fn decode(
    ctx: tool_dispatch.DispatchContext,
    args_json: []const u8,
) tool_dispatch.DispatchError!tool_dispatch.DecodeResult {
    // An object is the whole contract the harness can check without the schema:
    // the client rejects the rest, and says so in its own words.
    const trimmed = std.mem.trim(u8, args_json, " \t\r\n");
    const body = if (trimmed.len == 0) "{}" else trimmed;
    if (body[0] != '{') return .{ .failure = try ctx.allocator.dupe(
        u8,
        "Arguments must be a JSON object.",
    ) };
    if (!try std.json.validate(ctx.allocator, body)) return .{ .failure = try ctx.allocator.dupe(
        u8,
        "Arguments must be valid JSON.",
    ) };

    const owned = try ctx.allocator.dupe(u8, body);
    errdefer ctx.allocator.free(owned);
    const input = try ctx.allocator.create(Input);
    input.* = .{ .arguments_json = owned };
    return .{ .input = .{ .ptr = input, .deinit_fn = inputDeinit } };
}

fn inputDeinit(raw: *anyopaque, alloc: Allocator) void {
    const input: *Input = @ptrCast(@alignCast(raw));
    input.deinit(alloc);
    alloc.destroy(input);
}

pub fn validate(
    _: tool_dispatch.DispatchContext,
    _: tool_dispatch.ToolInput,
) tool_dispatch.DispatchError!?[]u8 {
    return null;
}

pub fn call(
    ctx: tool_dispatch.DispatchContext,
    input: tool_dispatch.ToolInput,
) tool_dispatch.DispatchError!tool_dispatch.ToolResult {
    const responder = ctx.emma_tool_responder orelse {
        return .{ .failure = try ctx.allocator.dupe(
            u8,
            "This tool is only available inside Emma.",
        ) };
    };
    const body = responder.call(
        ctx.allocator,
        ctx.tool_call_name,
        input.as(Input).arguments_json,
    ) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.Cancelled => return error.Cancelled,
        // The tool itself reports failure as text; reaching here means the call
        // never got there, which the model can only recover from by retrying.
        else => return .{ .failure = try std.fmt.allocPrint(
            ctx.allocator,
            "Emma could not run {s}: {s}.",
            .{ ctx.tool_call_name, @errorName(err) },
        ) },
    };
    return .{ .success = body };
}

/// Per-tool read/write is spec data, but `reads_only_fn` only sees the input,
/// so each tool gets its own zero-cost instantiation of the same constant.
pub fn constantFn(comptime value: bool) tool_dispatch.ReadsOnlyFn {
    return struct {
        fn answer(_: tool_dispatch.ToolInput) bool {
            return value;
        }
    }.answer;
}

pub const readsOnly = constantFn(true);
pub const readsAndWrites = constantFn(false);
pub const isIrreversible = constantFn(true);
pub const isReversible = constantFn(false);

test "arguments reach the client untouched, and a non-object never leaves the harness" {
    const alloc = std.testing.allocator;
    const Recorder = struct {
        seen_name: []const u8 = "",
        seen_args: []const u8 = "",
        fn run(raw: *anyopaque, out: Allocator, name: []const u8, args: []const u8) anyerror![]u8 {
            const self: *@This() = @ptrCast(@alignCast(raw));
            self.seen_name = name;
            self.seen_args = args;
            return out.dupe(u8, "done");
        }
    };
    var recorder = Recorder{};
    const ctx = tool_dispatch.DispatchContext{
        .allocator = alloc,
        .tool_call_name = "threads",
        .emma_tool_responder = .{ .context = @ptrCast(&recorder), .call_fn = Recorder.run },
    };

    const decoded = try decode(ctx, "{\"action\":\"list\"}");
    const decoded_input = decoded.input;
    defer decoded_input.deinit(alloc);
    const result = try call(ctx, decoded_input);
    defer result.deinit(alloc);
    try std.testing.expectEqualStrings("threads", recorder.seen_name);
    try std.testing.expectEqualStrings("{\"action\":\"list\"}", recorder.seen_args);
    try std.testing.expectEqualStrings("done", result.success);

    // A bare array or a truncated object is a decode failure, not a wire call.
    for ([_][]const u8{ "[1,2]", "{\"a\":" }) |bad| {
        const rejected = try decode(ctx, bad);
        alloc.free(rejected.failure);
    }
    // Empty arguments are the common "no options" call, not an error.
    const empty = try decode(ctx, "  ");
    defer empty.input.deinit(alloc);
    try std.testing.expectEqualStrings("{}", empty.input.as(Input).arguments_json);
}

test "a tool called outside Emma fails with text rather than killing the turn" {
    const alloc = std.testing.allocator;
    const ctx = tool_dispatch.DispatchContext{ .allocator = alloc, .tool_call_name = "threads" };
    const decoded = try decode(ctx, "{}");
    defer decoded.input.deinit(alloc);
    const result = try call(ctx, decoded.input);
    defer result.deinit(alloc);
    try std.testing.expectEqualStrings("This tool is only available inside Emma.", result.failure);
}
