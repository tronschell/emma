//! Lazy discovery for the harness's own tools.
//!
//! `search_tools` and `select_tool` are the native twin of the MCP pair in
//! `tool_mcp_dispatch.zig`. A registered tool marked `.on_select` never enters
//! the base advertisement, so its schema costs nothing until the model asks for
//! it by name. Search hands back names and descriptions only — the whole point
//! is that two dozen input schemas stay out of every prompt — and select splices
//! one schema in through the same sink MCP selection already uses.
//!
//! This is a prompt-cost mechanism, not a security boundary. A hidden tool is
//! still registered and still runs under exactly the permission rules it would
//! have had when advertised; search and select only decide what the model is
//! told about.

const std = @import("std");
const model_context_encoding = @import("../shared/model_context_encoding.zig");
const permissions = @import("../permissions/permissions.zig");
const text_utils = @import("../shared/text_utils.zig");
const types = @import("../shared/types.zig");
const gateway_schema = @import("gateway_schema.zig");
const tool_dispatch = @import("tool_dispatch.zig");
const tool_specs = @import("tool_specs.zig");

const Allocator = std.mem.Allocator;

/// Matches the MCP search bounds so one door does not quietly cost more prompt
/// than the other.
const default_search_limit: usize = 8;
const max_search_limit: usize = 20;

const SearchInput = struct {
    query: []u8,
    limit: usize,

    fn deinit(self: *SearchInput, alloc: Allocator) void {
        alloc.free(self.query);
        self.* = .{ .query = &.{}, .limit = 0 };
    }
};

const SelectInput = struct {
    name: []u8,

    fn deinit(self: *SelectInput, alloc: Allocator) void {
        alloc.free(self.name);
        self.* = .{ .name = &.{} };
    }
};

pub fn decodeSearch(
    ctx: tool_dispatch.DispatchContext,
    args_json: []const u8,
) tool_dispatch.DispatchError!tool_dispatch.DecodeResult {
    var parsed = std.json.parseFromSlice(std.json.Value, ctx.allocator, args_json, .{}) catch {
        return .{ .failure = try ctx.allocator.dupe(u8, "Invalid search_tools arguments.") };
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        return .{ .failure = try ctx.allocator.dupe(u8, "Invalid search_tools arguments.") };
    }
    const query_value = parsed.value.object.get("query") orelse {
        return .{ .failure = try ctx.allocator.dupe(u8, "search_tools requires a string query.") };
    };
    if (query_value != .string) {
        return .{ .failure = try ctx.allocator.dupe(u8, "search_tools requires a string query.") };
    }

    const raw_limit = if (parsed.value.object.get("limit")) |value|
        if (value == .integer) value.integer else 0
    else
        0;
    const limit = if (raw_limit <= 0)
        0
    else
        std.math.cast(usize, raw_limit) orelse std.math.maxInt(usize);

    const query = try ctx.allocator.dupe(u8, query_value.string);
    errdefer ctx.allocator.free(query);
    const input = try ctx.allocator.create(SearchInput);
    errdefer ctx.allocator.destroy(input);
    input.* = .{ .query = query, .limit = limit };
    return .{ .input = .{ .ptr = input, .deinit_fn = searchInputDeinit } };
}

pub fn decodeSelect(
    ctx: tool_dispatch.DispatchContext,
    args_json: []const u8,
) tool_dispatch.DispatchError!tool_dispatch.DecodeResult {
    var parsed = std.json.parseFromSlice(std.json.Value, ctx.allocator, args_json, .{}) catch {
        return .{ .failure = try ctx.allocator.dupe(u8, "Invalid select_tool arguments.") };
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        return .{ .failure = try ctx.allocator.dupe(u8, "Invalid select_tool arguments.") };
    }
    const name_value = parsed.value.object.get("name") orelse {
        return .{ .failure = try ctx.allocator.dupe(u8, "select_tool requires an exact tool name.") };
    };
    if (name_value != .string) {
        return .{ .failure = try ctx.allocator.dupe(u8, "select_tool requires an exact tool name.") };
    }

    const name = try ctx.allocator.dupe(u8, name_value.string);
    errdefer ctx.allocator.free(name);
    const input = try ctx.allocator.create(SelectInput);
    errdefer ctx.allocator.destroy(input);
    input.* = .{ .name = name };
    return .{ .input = .{ .ptr = input, .deinit_fn = selectInputDeinit } };
}

pub fn validate(
    _: tool_dispatch.DispatchContext,
    _: tool_dispatch.ToolInput,
) tool_dispatch.DispatchError!?[]u8 {
    return null;
}

pub fn callSearch(
    ctx: tool_dispatch.DispatchContext,
    erased: tool_dispatch.ToolInput,
) tool_dispatch.DispatchError!tool_dispatch.ToolResult {
    const input = erased.as(SearchInput);
    const body = renderSearch(
        ctx.allocator,
        ctx.tool_registry,
        ctx.mcp_permission_rules,
        input.query,
        input.limit,
    ) catch return error.OutOfMemory;
    return .{ .success = body };
}

pub fn callSelect(
    ctx: tool_dispatch.DispatchContext,
    erased: tool_dispatch.ToolInput,
) tool_dispatch.DispatchError!tool_dispatch.ToolResult {
    const input = erased.as(SelectInput);
    const spec = ctx.tool_registry.lookup(input.name) orelse
        return notFound(ctx, input.name);
    // A denied tool is invisible to search, so it is not found here either.
    // `.never` is reachable only by name and is never selectable.
    if (spec.advertisement == .never or
        permissions.rulesDenyAllTargetsForTool(ctx.mcp_permission_rules, input.name))
        return notFound(ctx, input.name);
    if (spec.advertisement == .always) return .{ .failure = try std.fmt.allocPrint(
        ctx.allocator,
        "{s} is already available; call it directly.",
        .{spec.name},
    ) };

    const schema_json = tool_specs.toolGatewaySchemaJson(ctx.allocator, spec.*) catch
        return error.OutOfMemory;
    defer ctx.allocator.free(schema_json);
    try tool_dispatch.reportSelectedDynamicTool(ctx, spec.name, schema_json);

    return .{ .success = try std.fmt.allocPrint(
        ctx.allocator,
        "Selected tool `{s}`. Its executable schema will be available on the next " ++
            "model step; call `{s}` with arguments matching the selected schema.",
        .{ spec.name, spec.name },
    ) };
}

pub fn readsOnly(_: tool_dispatch.ToolInput) bool {
    return true;
}

pub fn isIrreversible(_: tool_dispatch.ToolInput) bool {
    return false;
}

/// Names and descriptions only. An input schema here would defeat the entire
/// mechanism, since the model would pay for every hidden tool on every turn.
fn renderSearch(
    alloc: Allocator,
    registry: tool_dispatch.Registry,
    rules: types.PermissionRuleSet,
    query: []const u8,
    requested_limit: usize,
) ![]u8 {
    const limit = @min(
        if (requested_limit == 0) default_search_limit else requested_limit,
        max_search_limit,
    );

    var ranked: std.ArrayList(Match) = .empty;
    defer ranked.deinit(alloc);
    for (registry.tools) |tool| {
        if (tool.advertisement != .on_select) continue;
        if (permissions.rulesDenyAllTargetsForTool(rules, tool.name)) continue;
        const score = matchScore(tool, query);
        if (score == 0) continue;
        try ranked.append(alloc, .{ .tool = tool, .score = score });
    }
    // Stable, so equally-scoring tools keep registry order — the order the
    // advertisement itself would have used.
    std.sort.insertion(Match, ranked.items, {}, Match.betterFirst);

    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.writeAll("{\"tools\":[");
    const shown = @min(limit, ranked.items.len);
    for (ranked.items[0..shown], 0..) |match, index| {
        if (index > 0) try out.writer.writeByte(',');
        try writeToolMetadataJson(alloc, &out.writer, match.tool);
    }
    try out.writer.print("],\"count\":{d}", .{shown});
    if (ranked.items.len > shown) try out.writer.writeAll(",\"more_available\":true");
    try out.writer.writeByte('}');
    return try out.toOwnedSlice();
}

const Match = struct {
    tool: tool_dispatch.Tool,
    score: usize,

    fn betterFirst(_: void, a: Match, b: Match) bool {
        return a.score > b.score;
    }
};

/// Weight for a token found in the tool's name rather than its description. A
/// name match is the strong signal: it is what the model is actually reaching
/// for, and it has to outrank the filler words a written-out question sprinkles
/// across every description in the registry.
const name_match_weight: usize = 8;
/// Below this, a token is a preposition or an article and matches nearly
/// everything, so it says nothing about which tool was meant.
const min_scored_token_len: usize = 3;

/// How well one tool answers a query: the sum over query tokens found in its
/// name or description, case-insensitively. Zero means it is not a result.
///
/// This is scored rather than filtered, and that is the whole point. It used to
/// require *every* token to appear, which is fine when search is an optional
/// extra door onto a handful of MCP tools — but it is now the only way the model
/// reaches any tool at all, and a written-out query like "list the threads in
/// this workspace" matched nothing whatsoever, leaving the model with two tools
/// and no way to find a third.
///
/// ponytail: substring matching with no stemming, so "thread" finds `threads`
/// but "threading" does not. Real tokenisation only if that starts costing a
/// model the tool it wanted.
fn matchScore(tool: tool_dispatch.Tool, query: []const u8) usize {
    var score: usize = 0;
    var scored_any = false;
    var start: usize = 0;
    var index: usize = 0;
    while (index <= query.len) : (index += 1) {
        if (index < query.len and isSearchByte(query[index])) continue;
        const token = query[start..index];
        start = index + 1;
        if (token.len < min_scored_token_len) continue;
        scored_any = true;
        if (text_utils.containsIgnoreCase(tool.name, token)) {
            score += name_match_weight;
        } else if (text_utils.containsIgnoreCase(tool.description, token)) {
            score += 1;
        }
    }
    // Nothing worth scoring was asked, so everything is equally an answer. This
    // is what makes an empty query list the whole searchable set.
    return if (scored_any) score else 1;
}

fn writeToolMetadataJson(
    alloc: Allocator,
    writer: *std.Io.Writer,
    tool: tool_dispatch.Tool,
) !void {
    const description = try gateway_schema.cappedDescriptionAlloc(alloc, tool.description);
    defer alloc.free(description);
    try writer.writeAll("{\"name\":");
    try std.json.Stringify.value(tool.name, .{}, writer);
    try writer.writeAll(",\"description\":");
    try std.json.Stringify.value(description, .{}, writer);
    try writer.writeByte('}');
}

fn isSearchByte(byte: u8) bool {
    return std.ascii.isAlphanumeric(byte) or byte == '_' or byte == '-';
}

fn notFound(
    ctx: tool_dispatch.DispatchContext,
    name: []const u8,
) tool_dispatch.DispatchError!tool_dispatch.ToolResult {
    var out: std.Io.Writer.Allocating = .init(ctx.allocator);
    defer out.deinit();
    out.writer.writeAll("Tool not found: ") catch return error.OutOfMemory;
    model_context_encoding.writeScalar(&out.writer, name) catch return error.OutOfMemory;
    return .{ .failure = out.toOwnedSlice() catch return error.OutOfMemory };
}

fn searchInputDeinit(ptr: *anyopaque, alloc: Allocator) void {
    const input: *SearchInput = @ptrCast(@alignCast(ptr));
    input.deinit(alloc);
    alloc.destroy(input);
}

fn selectInputDeinit(ptr: *anyopaque, alloc: Allocator) void {
    const input: *SelectInput = @ptrCast(@alignCast(ptr));
    input.deinit(alloc);
    alloc.destroy(input);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

fn testTool(
    name: []const u8,
    description: []const u8,
    advertisement: tool_dispatch.Advertisement,
) tool_dispatch.Tool {
    return .{
        .name = name,
        .description = description,
        .gateway_schema = .{
            .name = name,
            .description = description,
            .input_schema = .{
                .properties = &.{
                    .{ .name = "path", .json_type = .string, .description = "Target path." },
                },
                .required = &.{"path"},
            },
        },
        .advertisement = advertisement,
        .executor_kind = .emma,
        .decode = decodeSelect,
        .call = callSelect,
        .reads_only_fn = readsOnly,
        .irreversible_fn = isIrreversible,
    };
}

fn testContext(
    alloc: Allocator,
    tools: []const tool_dispatch.Tool,
    rules: types.PermissionRuleSet,
) tool_dispatch.DispatchContext {
    return .{
        .allocator = alloc,
        .tool_registry = .{ .tools = tools },
        .mcp_permission_rules = rules,
    };
}

fn searchOutput(
    alloc: Allocator,
    tools: []const tool_dispatch.Tool,
    rules: types.PermissionRuleSet,
    args_json: []const u8,
) ![]u8 {
    const ctx = testContext(alloc, tools, rules);
    const decoded = try decodeSearch(ctx, args_json);
    const input = switch (decoded) {
        .input => |value| value,
        .failure => |body| {
            alloc.free(body);
            return error.TestUnexpectedResult;
        },
    };
    defer input.deinit(alloc);
    const result = try callSearch(ctx, input);
    return switch (result) {
        .success => |body| body,
        .failure => |body| {
            alloc.free(body);
            return error.TestUnexpectedResult;
        },
    };
}

const SelectSink = struct {
    alloc: Allocator,
    name: ?[]u8 = null,
    schema_json: ?[]u8 = null,

    fn record(raw: ?*anyopaque, name: []const u8, schema_json: []const u8) error{OutOfMemory}!void {
        const self: *SelectSink = @ptrCast(@alignCast(raw.?));
        self.deinit();
        self.name = try self.alloc.dupe(u8, name);
        self.schema_json = try self.alloc.dupe(u8, schema_json);
    }

    fn deinit(self: *SelectSink) void {
        if (self.name) |value| self.alloc.free(value);
        if (self.schema_json) |value| self.alloc.free(value);
        self.name = null;
        self.schema_json = null;
    }
};

fn selectResult(
    alloc: Allocator,
    tools: []const tool_dispatch.Tool,
    rules: types.PermissionRuleSet,
    sink: ?*SelectSink,
    name: []const u8,
) !tool_dispatch.ToolResult {
    var ctx = testContext(alloc, tools, rules);
    if (sink) |state| {
        ctx.selected_dynamic_tool_ctx = state;
        ctx.on_selected_dynamic_tool = SelectSink.record;
    }
    const args = try std.fmt.allocPrint(alloc, "{{\"name\":\"{s}\"}}", .{name});
    defer alloc.free(args);
    const decoded = try decodeSelect(ctx, args);
    const input = switch (decoded) {
        .input => |value| value,
        .failure => |body| {
            alloc.free(body);
            return error.TestUnexpectedResult;
        },
    };
    defer input.deinit(alloc);
    return try callSelect(ctx, input);
}

const test_tools = [_]tool_dispatch.Tool{
    testTool("emma_threads", "Work with conversation threads.", .on_select),
    testTool("emma_knowledge", "Save a page into the knowledge base.", .on_select),
    testTool("emma_screen", "Read the authorized screen context.", .on_select),
};

test "native tool search matches tokens across name and description, case-insensitively" {
    const alloc = std.testing.allocator;

    // Tokens split across name and description, in mixed case. All three tools
    // are named `emma_*`, so the one that also answers `conversation` comes first.
    const both = try searchOutput(alloc, test_tools[0..], .{}, "{\"query\":\"EMMA conversation\"}");
    defer alloc.free(both);
    try std.testing.expect(std.mem.startsWith(u8, both, "{\"tools\":[{\"name\":\"emma_threads\""));
    try std.testing.expect(std.mem.find(u8, both, "\"count\":3") != null);

    // A token nothing answers to costs nothing; the rest of the query still finds
    // its tool. Requiring every token used to return the empty set here, which is
    // the one answer that leaves the model with no way forward.
    const partial = try searchOutput(alloc, test_tools[0..], .{}, "{\"query\":\"threads sasquatch\"}");
    defer alloc.free(partial);
    try std.testing.expect(std.mem.startsWith(u8, partial, "{\"tools\":[{\"name\":\"emma_threads\""));
    try std.testing.expect(std.mem.find(u8, partial, "\"count\":1") != null);

    // Nothing at all still means nothing at all.
    const nothing = try searchOutput(alloc, test_tools[0..], .{}, "{\"query\":\"sasquatch\"}");
    defer alloc.free(nothing);
    try std.testing.expectEqualStrings("{\"tools\":[],\"count\":0}", nothing);
}

test "native tool search ranks the tool a written-out question is asking for" {
    const alloc = std.testing.allocator;
    // The query that made this necessary. Every filler word here appears in some
    // description somewhere, so an all-tokens-must-match search returned nothing
    // and a rank-free one buried the answer under whatever matched "the".
    const tools = [_]tool_dispatch.Tool{
        testTool("write_file", "Write the whole contents of a file in this workspace.", .on_select),
        testTool("knowledge", "Save a page in this workspace to the knowledge base.", .on_select),
        testTool("threads", "List, read and write the conversation threads.", .on_select),
    };

    const body = try searchOutput(alloc, tools[0..], .{}, "{\"query\":\"list the threads in this workspace\"}");
    defer alloc.free(body);
    try std.testing.expect(std.mem.startsWith(u8, body, "{\"tools\":[{\"name\":\"threads\""));

    // One-and-two letter tokens are dropped rather than scored: `in` and `a`
    // appear inside half the words in the registry and say nothing about intent.
    const filler = try searchOutput(alloc, tools[0..], .{}, "{\"query\":\"in a to of\"}");
    defer alloc.free(filler);
    try std.testing.expect(std.mem.find(u8, filler, "\"count\":3") != null);
}

test "native tool search returns names and descriptions but never input schemas" {
    const alloc = std.testing.allocator;
    const body = try searchOutput(alloc, test_tools[0..], .{}, "{\"query\":\"emma\"}");
    defer alloc.free(body);

    try std.testing.expect(std.mem.find(u8, body, "\"name\":\"emma_threads\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "Work with conversation threads.") != null);
    // The context-cost contract: a schema here would put every hidden tool back
    // into every prompt, which is the exact cost this pair exists to avoid.
    try std.testing.expect(std.mem.find(u8, body, "inputSchema") == null);
    try std.testing.expect(std.mem.find(u8, body, "properties") == null);
}

test "native tool search caps at the default limit and reports more_available" {
    const alloc = std.testing.allocator;
    var many: [12]tool_dispatch.Tool = undefined;
    var names: [12][16]u8 = undefined;
    for (&many, 0..) |*tool, index| {
        const name = try std.fmt.bufPrint(&names[index], "emma_tool_{d:0>2}", .{index});
        tool.* = testTool(name, "Bulk searchable tool.", .on_select);
    }

    const capped = try searchOutput(alloc, many[0..], .{}, "{\"query\":\"emma\"}");
    defer alloc.free(capped);
    try std.testing.expect(std.mem.find(u8, capped, "\"count\":8") != null);
    try std.testing.expect(std.mem.find(u8, capped, "\"more_available\":true") != null);
    try std.testing.expect(std.mem.find(u8, capped, "emma_tool_08") == null);

    // An explicit limit is honoured up to the cap and no further.
    const explicit = try searchOutput(alloc, many[0..], .{}, "{\"query\":\"emma\",\"limit\":2}");
    defer alloc.free(explicit);
    try std.testing.expect(std.mem.find(u8, explicit, "\"count\":2") != null);
    try std.testing.expect(std.mem.find(u8, explicit, "\"more_available\":true") != null);

    const over_cap = try searchOutput(alloc, many[0..], .{}, "{\"query\":\"emma\",\"limit\":500}");
    defer alloc.free(over_cap);
    try std.testing.expect(std.mem.find(u8, over_cap, "\"count\":12") != null);
    try std.testing.expect(std.mem.find(u8, over_cap, "more_available") == null);
}

test "native tool search omits a tool denied by a global deny rule" {
    const alloc = std.testing.allocator;
    var rules = [_]types.PermissionRule{
        .{
            .permission = @constCast("emma_knowledge"),
            .pattern = @constCast("*"),
            .action = .deny,
        },
    };

    const body = try searchOutput(
        alloc,
        test_tools[0..],
        .{ .rules = &rules },
        "{\"query\":\"emma\"}",
    );
    defer alloc.free(body);
    try std.testing.expect(std.mem.find(u8, body, "emma_knowledge") == null);
    try std.testing.expect(std.mem.find(u8, body, "emma_threads") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"count\":2") != null);
}

test "native tool search never returns an already advertised tool" {
    const alloc = std.testing.allocator;
    const tools = [_]tool_dispatch.Tool{
        testTool("emma_threads", "Work with conversation threads.", .on_select),
        testTool("read_file", "Read one emma file from disk.", .always),
        testTool("emma_hidden", "Reachable by emma name only.", .never),
    };

    const body = try searchOutput(alloc, tools[0..], .{}, "{\"query\":\"emma\"}");
    defer alloc.free(body);
    try std.testing.expect(std.mem.find(u8, body, "read_file") == null);
    try std.testing.expect(std.mem.find(u8, body, "emma_hidden") == null);
    try std.testing.expect(std.mem.find(u8, body, "\"count\":1") != null);
}

test "native tool search with an empty query returns the whole searchable set" {
    const alloc = std.testing.allocator;
    const body = try searchOutput(alloc, test_tools[0..], .{}, "{\"query\":\"\"}");
    defer alloc.free(body);
    try std.testing.expect(std.mem.find(u8, body, "\"count\":3") != null);
    for (test_tools) |tool| {
        try std.testing.expect(std.mem.find(u8, body, tool.name) != null);
    }
}

test "native tool select reports the exact registry schema through the dynamic sink" {
    const alloc = std.testing.allocator;
    var sink = SelectSink{ .alloc = alloc };
    defer sink.deinit();

    const result = try selectResult(alloc, test_tools[0..], .{}, &sink, "emma_threads");
    defer result.deinit(alloc);
    try std.testing.expect(result == .success);
    try std.testing.expect(std.mem.find(u8, result.success, "emma_threads") != null);
    try std.testing.expect(std.mem.find(u8, result.success, "next model step") != null);

    try std.testing.expectEqualStrings("emma_threads", sink.name orelse return error.TestExpectedEqual);
    const expected = try tool_specs.toolGatewaySchemaJson(alloc, test_tools[0]);
    defer alloc.free(expected);
    try std.testing.expectEqualStrings(expected, sink.schema_json orelse return error.TestExpectedEqual);
    // The schema the sink carries is the executable one, unlike search output.
    try std.testing.expect(std.mem.find(u8, expected, "inputSchema") != null);
}

test "native tool select rejects unknown, already advertised and never advertised names" {
    const alloc = std.testing.allocator;
    const tools = [_]tool_dispatch.Tool{
        testTool("emma_threads", "Work with conversation threads.", .on_select),
        testTool("read_file", "Read one file from disk.", .always),
        testTool("emma_hidden", "Reachable by name only.", .never),
    };

    const unknown = try selectResult(alloc, tools[0..], .{}, null, "emma_nope");
    defer unknown.deinit(alloc);
    try std.testing.expectEqualStrings("Tool not found: emma_nope", unknown.failure);

    const hidden = try selectResult(alloc, tools[0..], .{}, null, "emma_hidden");
    defer hidden.deinit(alloc);
    try std.testing.expectEqualStrings("Tool not found: emma_hidden", hidden.failure);

    const advertised = try selectResult(alloc, tools[0..], .{}, null, "read_file");
    defer advertised.deinit(alloc);
    try std.testing.expectEqualStrings("read_file is already available; call it directly.", advertised.failure);

    var rules = [_]types.PermissionRule{
        .{
            .permission = @constCast("emma_threads"),
            .pattern = @constCast("*"),
            .action = .deny,
        },
    };
    const denied = try selectResult(alloc, tools[0..], .{ .rules = &rules }, null, "emma_threads");
    defer denied.deinit(alloc);
    try std.testing.expectEqualStrings("Tool not found: emma_threads", denied.failure);
}

test "native tool select does not require a preceding search" {
    const alloc = std.testing.allocator;
    var sink = SelectSink{ .alloc = alloc };
    defer sink.deinit();

    // No search has ever run against this context, and two unrelated selects
    // follow each other. Selection is a by-name lookup with no search memory,
    // exactly like the MCP pair it mirrors.
    for ([_][]const u8{ "emma_screen", "emma_knowledge" }) |name| {
        const result = try selectResult(alloc, test_tools[0..], .{}, &sink, name);
        defer result.deinit(alloc);
        try std.testing.expect(result == .success);
        try std.testing.expectEqualStrings(name, sink.name orelse return error.TestExpectedEqual);
    }
}
