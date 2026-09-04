const std = @import("std");
const model_context_encoding = @import("../shared/model_context_encoding.zig");
const permissions = @import("../permissions/permissions.zig");
const types = @import("../shared/types.zig");
const gateway_schema = @import("gateway_schema.zig");
const tool_dispatch = @import("tool_dispatch.zig");
const tool_specs = @import("tool_specs.zig");
const tool_overrides = @import("tool_overrides.zig");

const Allocator = std.mem.Allocator;

const default_search_limit: usize = 8;
const max_search_limit: usize = 20;
const max_advertised_names: usize = 4;

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
        ctx.tool_overrides,
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
    const found = ctx.tool_registry.lookup(input.name) orelse
        return notFound(ctx, input.name);
    var spec = found.*;
    ctx.tool_overrides.apply(&spec);
    if (spec.advertisement == .never or
        permissions.rulesDenyAllTargetsForTool(ctx.mcp_permission_rules, input.name))
        return notFound(ctx, input.name);
    if (spec.advertisement == .always) return .{ .failure = try std.fmt.allocPrint(
        ctx.allocator,
        "{s} is already available; call it directly.",
        .{spec.name},
    ) };

    const schema_json = tool_specs.toolGatewaySchemaJson(ctx.allocator, spec) catch
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

fn renderSearch(
    alloc: Allocator,
    registry: tool_dispatch.Registry,
    rules: types.PermissionRuleSet,
    overrides: tool_overrides.Overrides,
    query: []const u8,
    requested_limit: usize,
) ![]u8 {
    const limit = @min(
        if (requested_limit == 0) default_search_limit else requested_limit,
        max_search_limit,
    );

    var documents: std.ArrayList(Document) = .empty;
    defer {
        for (documents.items) |*document| document.deinit(alloc);
        documents.deinit(alloc);
    }
    var advertised: std.ArrayList([]const u8) = .empty;
    defer advertised.deinit(alloc);
    for (registry.tools) |registered| {
        var tool = registered;
        overrides.apply(&tool);
        if (permissions.rulesDenyAllTargetsForTool(rules, tool.name)) continue;
        if (tool.advertisement == .always) {
            if (advertised.items.len < max_advertised_names and queryNamesTool(query, tool.name))
                try advertised.append(alloc, tool.name);
            continue;
        }
        if (tool.advertisement != .on_select) continue;
        try documents.append(alloc, try Document.init(alloc, tool));
    }

    var ranked: std.ArrayList(Match) = .empty;
    defer ranked.deinit(alloc);
    try rank(alloc, documents.items, query, &ranked);
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
    if (advertised.items.len > 0) {
        try out.writer.writeAll(",\"already_advertised\":[");
        for (advertised.items, 0..) |name, index| {
            if (index > 0) try out.writer.writeByte(',');
            try std.json.Stringify.value(name, .{}, &out.writer);
        }
        try out.writer.writeAll("],\"note\":\"Already in your schema. Call these directly; do not select them.\"");
    }
    try out.writer.writeByte('}');
    return try out.toOwnedSlice();
}

const Match = struct {
    tool: tool_dispatch.Tool,
    score: f64,

    fn betterFirst(_: void, a: Match, b: Match) bool {
        return a.score > b.score;
    }
};

const name_field_weight: f64 = 8;
const body_field_weight: f64 = 1;
const bm25_k1: f64 = 1.2;
const bm25_b: f64 = 0.75;
const min_scored_token_len: usize = 3;
const indexed_schema_max_bytes: usize = 4096;
const indexed_schema_max_depth: usize = 4;

const TokenIterator = struct {
    text: []const u8,
    index: usize = 0,

    fn next(self: *TokenIterator) ?[]const u8 {
        while (self.index < self.text.len and !std.ascii.isAlphanumeric(self.text[self.index]))
            self.index += 1;
        const start = self.index;
        while (self.index < self.text.len and std.ascii.isAlphanumeric(self.text[self.index]))
            self.index += 1;
        return if (self.index > start) self.text[start..self.index] else null;
    }
};

const Document = struct {
    tool: tool_dispatch.Tool,
    body: []u8,
    name_len: f64,
    body_len: f64,

    fn init(alloc: Allocator, tool: tool_dispatch.Tool) !Document {
        var body: std.ArrayList(u8) = .empty;
        errdefer body.deinit(alloc);
        try appendIndexed(alloc, &body, tool.description);
        try appendSchemaText(alloc, &body, tool.gateway_schema.input_schema, 0);
        const owned = try body.toOwnedSlice(alloc);
        return .{
            .tool = tool,
            .body = owned,
            .name_len = @floatFromInt(tokenCount(tool.name)),
            .body_len = @floatFromInt(tokenCount(owned)),
        };
    }

    fn deinit(self: *Document, alloc: Allocator) void {
        alloc.free(self.body);
        self.* = undefined;
    }
};

fn appendIndexed(alloc: Allocator, out: *std.ArrayList(u8), text: []const u8) !void {
    if (text.len == 0 or out.items.len >= indexed_schema_max_bytes) return;
    const room = indexed_schema_max_bytes - out.items.len;
    try out.appendSlice(alloc, text[0..@min(text.len, room)]);
    try out.append(alloc, ' ');
}

fn appendSchemaText(
    alloc: Allocator,
    out: *std.ArrayList(u8),
    schema: gateway_schema.ObjectSchema,
    depth: usize,
) Allocator.Error!void {
    if (depth > indexed_schema_max_depth or out.items.len >= indexed_schema_max_bytes) return;
    for (schema.properties) |property| {
        try appendIndexed(alloc, out, property.name);
        try appendIndexed(alloc, out, property.description);
        try appendIndexed(alloc, out, property.nullable_description);
        if (property.shape) |shape| switch (shape.*) {
            .enum_values => |values| for (values) |value| try appendIndexed(alloc, out, value),
            .object => |nested| try appendSchemaText(alloc, out, nested.*, depth + 1),
            .array_values => |array| for (array.enum_values) |value| try appendIndexed(alloc, out, value),
            .array_objects => |nested| try appendSchemaText(alloc, out, nested.*, depth + 1),
        };
    }
    for (schema.one_of) |alternative| try appendSchemaText(alloc, out, alternative, depth + 1);
}

fn singularToken(token: []const u8) []const u8 {
    return if (token.len > min_scored_token_len and (token[token.len - 1] | 0x20) == 's')
        token[0 .. token.len - 1]
    else
        token;
}

fn queryNamesTool(query: []const u8, name: []const u8) bool {
    var named = false;
    var name_tokens = TokenIterator{ .text = name };
    while (name_tokens.next()) |name_token| {
        if (name_token.len < min_scored_token_len) continue;
        var query_tokens = TokenIterator{ .text = query };
        var found = false;
        while (query_tokens.next()) |query_token| {
            if (std.ascii.eqlIgnoreCase(singularToken(name_token), singularToken(query_token))) {
                found = true;
                break;
            }
        }
        if (!found) return false;
        named = true;
    }
    return named;
}

fn tokenCount(text: []const u8) usize {
    var tokens = TokenIterator{ .text = text };
    var count: usize = 0;
    while (tokens.next()) |_| count += 1;
    return count;
}

fn termFrequency(text: []const u8, term: []const u8) f64 {
    var tokens = TokenIterator{ .text = text };
    var count: usize = 0;
    while (tokens.next()) |token| {
        if (std.ascii.eqlIgnoreCase(token, term)) count += 1;
    }
    return @floatFromInt(count);
}

fn saturate(frequency: f64, length: f64, average_length: f64) f64 {
    if (frequency == 0) return 0;
    const normalized = if (average_length == 0) 1 else length / average_length;
    return frequency * (bm25_k1 + 1) /
        (frequency + bm25_k1 * (1 - bm25_b + bm25_b * normalized));
}

fn rank(
    alloc: Allocator,
    documents: []const Document,
    query: []const u8,
    ranked: *std.ArrayList(Match),
) !void {
    if (documents.len == 0) return;
    const total: f64 = @floatFromInt(documents.len);

    var average_name_len: f64 = 0;
    var average_body_len: f64 = 0;
    for (documents) |document| {
        average_name_len += document.name_len;
        average_body_len += document.body_len;
    }
    average_name_len /= total;
    average_body_len /= total;

    const scores = try alloc.alloc(f64, documents.len);
    defer alloc.free(scores);
    @memset(scores, 0);
    const name_frequencies = try alloc.alloc(f64, documents.len);
    defer alloc.free(name_frequencies);
    const body_frequencies = try alloc.alloc(f64, documents.len);
    defer alloc.free(body_frequencies);

    var scored_any = false;
    var terms = TokenIterator{ .text = query };
    while (terms.next()) |term| {
        if (term.len < min_scored_token_len) continue;
        scored_any = true;

        var matched: f64 = 0;
        for (documents, 0..) |document, index| {
            name_frequencies[index] = termFrequency(document.tool.name, term);
            body_frequencies[index] = termFrequency(document.body, term);
            if (name_frequencies[index] + body_frequencies[index] > 0) matched += 1;
        }
        if (matched == 0) continue;

        const inverse_document_frequency = @log(1 + (total - matched + 0.5) / (matched + 0.5));
        for (scores, 0..) |*score, index| {
            score.* += inverse_document_frequency *
                (name_field_weight * saturate(
                    name_frequencies[index],
                    documents[index].name_len,
                    average_name_len,
                ) + body_field_weight * saturate(
                    body_frequencies[index],
                    documents[index].body_len,
                    average_body_len,
                ));
        }
    }

    for (documents, 0..) |document, index| {
        const score = if (scored_any) scores[index] else 1;
        if (score <= 0) continue;
        try ranked.append(alloc, .{ .tool = document.tool, .score = score });
    }
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

fn notFound(
    ctx: tool_dispatch.DispatchContext,
    name: []const u8,
) tool_dispatch.DispatchError!tool_dispatch.ToolResult {
    var out: std.Io.Writer.Allocating = .init(ctx.allocator);
    defer out.deinit();
    out.writer.writeAll("Tool not found: ") catch return error.OutOfMemory;
    model_context_encoding.writeScalar(&out.writer, name) catch return error.OutOfMemory;
    if (std.mem.startsWith(u8, name, "mcp_")) {
        const hint = ". Use mcp_select_tool for a configured MCP server tool.";
        out.writer.writeAll(hint) catch return error.OutOfMemory;
    }
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

const test_default_input_schema = gateway_schema.ObjectSchema{
    .properties = &.{
        .{ .name = "path", .json_type = .string, .description = "Target path." },
    },
    .required = &.{"path"},
};

fn testTool(
    name: []const u8,
    description: []const u8,
    advertisement: tool_dispatch.Advertisement,
) tool_dispatch.Tool {
    return testSchemaTool(name, description, advertisement, test_default_input_schema);
}

fn testSchemaTool(
    name: []const u8,
    description: []const u8,
    advertisement: tool_dispatch.Advertisement,
    input_schema: gateway_schema.ObjectSchema,
) tool_dispatch.Tool {
    return .{
        .name = name,
        .description = description,
        .gateway_schema = .{
            .name = name,
            .description = description,
            .input_schema = input_schema,
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
    return searchOutputWithOverrides(alloc, tools, rules, .{}, args_json);
}

fn searchOutputWithOverrides(
    alloc: Allocator,
    tools: []const tool_dispatch.Tool,
    rules: types.PermissionRuleSet,
    overrides: tool_overrides.Overrides,
    args_json: []const u8,
) ![]u8 {
    var ctx = testContext(alloc, tools, rules);
    ctx.tool_overrides = overrides;
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

    const both = try searchOutput(alloc, test_tools[0..], .{}, "{\"query\":\"EMMA conversation\"}");
    defer alloc.free(both);
    try std.testing.expect(std.mem.startsWith(u8, both, "{\"tools\":[{\"name\":\"emma_threads\""));
    try std.testing.expect(std.mem.find(u8, both, "\"count\":3") != null);

    const partial = try searchOutput(alloc, test_tools[0..], .{}, "{\"query\":\"threads sasquatch\"}");
    defer alloc.free(partial);
    try std.testing.expect(std.mem.startsWith(u8, partial, "{\"tools\":[{\"name\":\"emma_threads\""));
    try std.testing.expect(std.mem.find(u8, partial, "\"count\":1") != null);

    const nothing = try searchOutput(alloc, test_tools[0..], .{}, "{\"query\":\"sasquatch\"}");
    defer alloc.free(nothing);
    try std.testing.expectEqualStrings("{\"tools\":[],\"count\":0}", nothing);
}

test "native tool search ranks the tool a written-out question is asking for" {
    const alloc = std.testing.allocator;
    const tools = [_]tool_dispatch.Tool{
        testTool("write_file", "Write the whole contents of a file in this workspace.", .on_select),
        testTool("knowledge", "Save a page in this workspace to the knowledge base.", .on_select),
        testTool("threads", "List, read and write the conversation threads.", .on_select),
    };

    const body = try searchOutput(alloc, tools[0..], .{}, "{\"query\":\"list the threads in this workspace\"}");
    defer alloc.free(body);
    try std.testing.expect(std.mem.startsWith(u8, body, "{\"tools\":[{\"name\":\"threads\""));

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

test "native tool search with an empty query returns the whole searchable set in registry order" {
    const alloc = std.testing.allocator;
    const body = try searchOutput(alloc, test_tools[0..], .{}, "{\"query\":\"\"}");
    defer alloc.free(body);
    try std.testing.expect(std.mem.find(u8, body, "\"count\":3") != null);
    var previous: usize = 0;
    for (test_tools) |tool| {
        const at = std.mem.find(u8, body, tool.name) orelse return error.TestExpectedEqual;
        try std.testing.expect(at >= previous);
        previous = at;
    }
}

test "native tool search scores whole words, not substrings inside another word" {
    const alloc = std.testing.allocator;
    const tools = [_]tool_dispatch.Tool{
        testTool("emma_threads", "Work with conversation threads.", .on_select),
        testTool("read_file", "Return the contents of one file.", .on_select),
    };

    const body = try searchOutput(alloc, tools[0..], .{}, "{\"query\":\"read a file\"}");
    defer alloc.free(body);
    try std.testing.expect(std.mem.startsWith(u8, body, "{\"tools\":[{\"name\":\"read_file\""));
    try std.testing.expect(std.mem.find(u8, body, "emma_threads") == null);
    try std.testing.expect(std.mem.find(u8, body, "\"count\":1") != null);
}

test "native tool search splits compound names into their parts" {
    const alloc = std.testing.allocator;
    const tools = [_]tool_dispatch.Tool{
        testTool("emma_knowledge", "Save a page.", .on_select),
        testTool("read_tool_result", "Page back through a stored payload.", .on_select),
    };

    const body = try searchOutput(alloc, tools[0..], .{}, "{\"query\":\"result\"}");
    defer alloc.free(body);
    try std.testing.expect(std.mem.startsWith(u8, body, "{\"tools\":[{\"name\":\"read_tool_result\""));
    try std.testing.expect(std.mem.find(u8, body, "\"count\":1") != null);
}

test "native tool search finds a term that appears only in the parameter schema" {
    const alloc = std.testing.allocator;
    const tools = [_]tool_dispatch.Tool{
        testTool("emma_knowledge", "Save a page into the knowledge base.", .on_select),
        testSchemaTool("terminal", "Run a shell command.", .on_select, .{
            .properties = &.{
                .{
                    .name = "detached",
                    .json_type = .boolean,
                    .description = "Keep the process running in the background after the call returns.",
                },
            },
        }),
    };

    const body = try searchOutput(alloc, tools[0..], .{}, "{\"query\":\"run a command in the background\"}");
    defer alloc.free(body);
    try std.testing.expect(std.mem.startsWith(u8, body, "{\"tools\":[{\"name\":\"terminal\""));
    try std.testing.expect(std.mem.find(u8, body, "background") == null);
}

test "native tool search ranks a name hit above a description hit" {
    const alloc = std.testing.allocator;
    const tools = [_]tool_dispatch.Tool{
        testTool("emma_archive", "Store older notes for later.", .on_select),
        testTool("emma_notes", "Store scratch text.", .on_select),
    };

    const body = try searchOutput(alloc, tools[0..], .{}, "{\"query\":\"notes\"}");
    defer alloc.free(body);
    try std.testing.expect(std.mem.startsWith(u8, body, "{\"tools\":[{\"name\":\"emma_notes\""));
    try std.testing.expect(std.mem.find(u8, body, "\"count\":2") != null);
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

    const dynamic = try selectResult(alloc, tools[0..], .{}, null, "mcp_lightpanda_search");
    defer dynamic.deinit(alloc);
    try std.testing.expectEqualStrings(
        "Tool not found: mcp_lightpanda_search. Use mcp_select_tool for a configured MCP server tool.",
        dynamic.failure,
    );

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

    for ([_][]const u8{ "emma_screen", "emma_knowledge" }) |name| {
        const result = try selectResult(alloc, test_tools[0..], .{}, &sink, name);
        defer result.deinit(alloc);
        try std.testing.expect(result == .success);
        try std.testing.expectEqualStrings(name, sink.name orelse return error.TestExpectedEqual);
    }
}

test "native tool search names the advertised tools the query is already asking for" {
    const alloc = std.testing.allocator;
    const tools = [_]tool_dispatch.Tool{
        testTool("emma_threads", "Work with conversation threads.", .on_select),
        testTool("read_file", "Read one file from disk.", .always),
        testTool("grep_files", "Search file contents.", .always),
        testTool("terminal", "Run a shell command.", .always),
    };

    const asking = try searchOutput(alloc, tools[0..], .{}, "{\"query\":\"read a file and grep files\"}");
    defer alloc.free(asking);
    try std.testing.expect(
        std.mem.find(u8, asking, "\"already_advertised\":[\"read_file\",\"grep_files\"]") != null,
    );
    try std.testing.expect(std.mem.find(u8, asking, "Call these directly") != null);
    try std.testing.expect(std.mem.find(u8, asking, "\"count\":0") != null);

    const unrelated = try searchOutput(alloc, tools[0..], .{}, "{\"query\":\"conversation threads\"}");
    defer alloc.free(unrelated);
    try std.testing.expect(std.mem.find(u8, unrelated, "already_advertised") == null);
    try std.testing.expect(std.mem.find(u8, unrelated, "emma_threads") != null);
}

test "native tool search does not name an advertised tool denied by a rule" {
    const alloc = std.testing.allocator;
    const tools = [_]tool_dispatch.Tool{
        testTool("emma_threads", "Work with conversation threads.", .on_select),
        testTool("terminal", "Run a shell command.", .always),
    };
    var rules = [_]types.PermissionRule{
        .{
            .permission = @constCast("terminal"),
            .pattern = @constCast("*"),
            .action = .deny,
        },
    };

    const body = try searchOutput(
        alloc,
        tools[0..],
        .{ .rules = &rules },
        "{\"query\":\"terminal\"}",
    );
    defer alloc.free(body);
    try std.testing.expect(std.mem.find(u8, body, "already_advertised") == null);
}

test "a hinted tool search result carries the hint, and a preselected one leaves the index" {
    const alloc = std.testing.allocator;
    const tools = [_]tool_dispatch.Tool{
        testTool("threads", "Work with conversation threads.", .on_select),
        testTool("knowledge", "Save a page to the knowledge base.", .on_select),
    };
    const hints = [_]tool_overrides.Hint{.{ .name = "threads", .description = "Hinted threads." }};

    const hinted = try searchOutputWithOverrides(alloc, tools[0..], .{}, .{ .hints = hints[0..] }, "{\"query\":\"threads\"}");
    defer alloc.free(hinted);
    try std.testing.expect(std.mem.find(u8, hinted, "Hinted threads.") != null);
    try std.testing.expect(std.mem.find(u8, hinted, "Work with conversation threads.") == null);

    const preselect = [_][]const u8{"threads"};
    const promoted = try searchOutputWithOverrides(alloc, tools[0..], .{}, .{ .preselect = preselect[0..] }, "{\"query\":\"threads\"}");
    defer alloc.free(promoted);
    try std.testing.expect(std.mem.find(u8, promoted, "\"tools\":[]") != null);
    try std.testing.expect(std.mem.find(u8, promoted, "already_advertised") != null);
}
