const std = @import("std");
const client_mod = @import("../../core/lsp/client.zig");
const io_mod = @import("../../core/shared/io.zig");
const pathing = @import("../../core/workspace/pathing.zig");
const pool = @import("../../core/lsp/pool.zig");
const servers = @import("../../core/lsp/servers.zig");
const tool_dispatch = @import("../../core/tooling/tool_dispatch.zig");

const Allocator = std.mem.Allocator;

const max_source_bytes: usize = 4 * 1024 * 1024;
const max_reported_items: usize = 200;
const default_timeout_ms: u32 = 20_000;
const max_timeout_ms: u32 = 120_000;
const initialize_timeout_ms: u32 = 60_000;

pub const Action = enum {
    diagnostics,
    definition,
    type_definition,
    implementation,
    references,
    hover,
    document_symbols,
    workspace_symbols,
    servers,
};

pub const Input = struct {
    action: Action,
    path: ?[]u8 = null,
    line: ?u32 = null,
    character: ?u32 = null,
    symbol: ?[]u8 = null,
    timeout_ms: ?u32 = null,

    pub fn deinit(self: *Input, alloc: Allocator) void {
        if (self.path) |value| alloc.free(value);
        if (self.symbol) |value| alloc.free(value);
        self.* = .{ .action = .servers };
    }
};

pub fn decode(
    ctx: tool_dispatch.DispatchContext,
    args_json: []const u8,
) tool_dispatch.DispatchError!tool_dispatch.DecodeResult {
    var parsed = std.json.parseFromSlice(std.json.Value, ctx.allocator, args_json, .{}) catch {
        return .{ .failure = try ctx.allocator.dupe(u8, "lsp arguments must be valid JSON") };
    };
    defer parsed.deinit();
    if (parsed.value != .object) {
        return .{ .failure = try ctx.allocator.dupe(u8, "lsp arguments must be an object") };
    }

    const action_value = parsed.value.object.get("action") orelse {
        return .{ .failure = try ctx.allocator.dupe(u8, "lsp requires string field \"action\"") };
    };
    if (action_value != .string) {
        return .{ .failure = try ctx.allocator.dupe(u8, "lsp field \"action\" must be a string") };
    }
    const action = std.meta.stringToEnum(Action, action_value.string) orelse {
        return .{ .failure = try std.fmt.allocPrint(
            ctx.allocator,
            "lsp action \"{s}\" is not supported",
            .{action_value.string},
        ) };
    };

    const line = switch (try optionalPositive(ctx.allocator, parsed.value.object, "line")) {
        .failure => |body| return .{ .failure = body },
        .value => |value| value,
    };
    const character = switch (try optionalPositive(ctx.allocator, parsed.value.object, "character")) {
        .failure => |body| return .{ .failure = body },
        .value => |value| value,
    };
    const timeout_ms = switch (try optionalPositive(ctx.allocator, parsed.value.object, "timeout_ms")) {
        .failure => |body| return .{ .failure = body },
        .value => |value| value,
    };

    const path = switch (try optionalString(ctx.allocator, parsed.value.object, "path")) {
        .failure => |body| return .{ .failure = body },
        .value => |value| value,
    };
    errdefer if (path) |owned| ctx.allocator.free(owned);
    const symbol = switch (try optionalString(ctx.allocator, parsed.value.object, "symbol")) {
        .failure => |body| {
            if (path) |owned| ctx.allocator.free(owned);
            return .{ .failure = body };
        },
        .value => |value| value,
    };
    errdefer if (symbol) |owned| ctx.allocator.free(owned);

    const input = try ctx.allocator.create(Input);
    errdefer ctx.allocator.destroy(input);
    input.* = .{
        .action = action,
        .path = path,
        .line = line,
        .character = character,
        .symbol = symbol,
        .timeout_ms = timeout_ms,
    };
    return .{ .input = .{ .ptr = input, .deinit_fn = inputDeinit } };
}

const OptionalString = union(enum) {
    value: ?[]u8,
    failure: []u8,
};

const OptionalPositive = union(enum) {
    value: ?u32,
    failure: []u8,
};

fn optionalString(
    alloc: Allocator,
    object: std.json.ObjectMap,
    name: []const u8,
) tool_dispatch.DispatchError!OptionalString {
    const value = object.get(name) orelse return .{ .value = null };
    if (value == .null) return .{ .value = null };
    if (value != .string) {
        return .{ .failure = try std.fmt.allocPrint(
            alloc,
            "lsp field \"{s}\" must be a string",
            .{name},
        ) };
    }
    if (value.string.len == 0) return .{ .value = null };
    return .{ .value = try alloc.dupe(u8, value.string) };
}

fn optionalPositive(
    alloc: Allocator,
    object: std.json.ObjectMap,
    name: []const u8,
) tool_dispatch.DispatchError!OptionalPositive {
    const value = object.get(name) orelse return .{ .value = null };
    if (value == .null) return .{ .value = null };
    if (value != .integer or value.integer <= 0) {
        return .{ .failure = try std.fmt.allocPrint(
            alloc,
            "lsp field \"{s}\" must be a positive integer",
            .{name},
        ) };
    }
    return .{ .value = std.math.cast(u32, value.integer) orelse std.math.maxInt(u32) };
}

fn inputDeinit(ptr: *anyopaque, alloc: Allocator) void {
    const input: *Input = @ptrCast(@alignCast(ptr));
    input.deinit(alloc);
    alloc.destroy(input);
}

pub fn validate(
    ctx: tool_dispatch.DispatchContext,
    erased: tool_dispatch.ToolInput,
) tool_dispatch.DispatchError!?[]u8 {
    const input = erased.as(Input);
    switch (input.action) {
        .servers => return null,
        .workspace_symbols => {
            if (input.symbol == null) {
                return try ctx.allocator.dupe(u8, "lsp workspace_symbols requires \"symbol\" as the query");
            }
            if (input.path == null) {
                return try ctx.allocator.dupe(u8, "lsp workspace_symbols requires \"path\" to pick the language server");
            }
            return null;
        },
        .diagnostics, .document_symbols => {
            if (input.path == null) {
                return try ctx.allocator.dupe(u8, "lsp requires string field \"path\"");
            }
            return null;
        },
        .definition, .type_definition, .implementation, .references, .hover => {
            if (input.path == null) {
                return try ctx.allocator.dupe(u8, "lsp requires string field \"path\"");
            }
            if (input.line == null) {
                return try ctx.allocator.dupe(u8, "lsp requires the 1-based \"line\" of the symbol");
            }
            if (input.character == null and input.symbol == null) {
                return try ctx.allocator.dupe(u8, "lsp requires \"symbol\" or the 1-based \"character\" on that line");
            }
            return null;
        },
    }
}

pub fn call(
    ctx: tool_dispatch.DispatchContext,
    erased: tool_dispatch.ToolInput,
) tool_dispatch.DispatchError!tool_dispatch.ToolResult {
    const input = erased.as(Input);
    var arena_state = std.heap.ArenaAllocator.init(ctx.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    if (input.action == .servers) {
        return .{ .success = try renderServers(ctx.allocator, arena) };
    }

    const requested_path = input.path orelse
        return .{ .failure = try ctx.allocator.dupe(u8, "lsp requires string field \"path\"") };

    if (ctx.workspace_root.len == 0) {
        return .{ .failure = try ctx.allocator.dupe(u8, "lsp failed: no workspace root is available") };
    }

    const target = pathing.resolveWorkspaceOrExternalPath(arena, ctx.workspace_root, requested_path) catch |err| {
        if (err == error.OutOfMemory) return error.OutOfMemory;
        return .{ .failure = try std.fmt.allocPrint(
            ctx.allocator,
            "lsp failed: {s}: {s}",
            .{ @errorName(err), requested_path },
        ) };
    };

    const server = servers.forPath(target) orelse {
        return .{ .failure = try std.fmt.allocPrint(
            ctx.allocator,
            "lsp failed: no language server is registered for {s}. Run lsp with action=servers to list what is supported.",
            .{std.fs.path.basename(target)},
        ) };
    };
    if (!servers.isInstalled(arena, server)) {
        return .{ .failure = try std.fmt.allocPrint(
            ctx.allocator,
            "lsp failed: {s} is not installed. Install it with: {s}",
            .{ server.id, server.install },
        ) };
    }

    var file = std.Io.Dir.openFileAbsolute(io_mod.getIo(), target, .{}) catch |err| {
        return .{ .failure = try std.fmt.allocPrint(
            ctx.allocator,
            "lsp failed: cannot open {s}: {s}",
            .{ requested_path, @errorName(err) },
        ) };
    };
    const source = io_mod.readFileToEnd(arena, &file, max_source_bytes) catch |err| {
        file.close(io_mod.getIo());
        return .{ .failure = try std.fmt.allocPrint(
            ctx.allocator,
            "lsp failed: cannot read {s}: {s}",
            .{ requested_path, @errorName(err) },
        ) };
    };
    file.close(io_mod.getIo());

    const position = resolvePosition(source, input) catch |err| {
        return .{ .failure = try std.fmt.allocPrint(
            ctx.allocator,
            "lsp failed: {s}",
            .{positionErrorText(err, input)},
        ) };
    };

    var startup_failure: ?[]const u8 = null;
    const client = pool.acquire(
        arena,
        server,
        ctx.workspace_root,
        initialize_timeout_ms,
        &startup_failure,
    ) catch |err| {
        if (startup_failure) |message| {
            return .{ .failure = try std.fmt.allocPrint(
                ctx.allocator,
                "lsp failed: {s} refused to start: {s}",
                .{ server.id, message },
            ) };
        }
        return .{ .failure = try std.fmt.allocPrint(
            ctx.allocator,
            "lsp failed: {s} did not start ({s}). Install or repair it with: {s}",
            .{ server.id, @errorName(err), server.install },
        ) };
    };

    const timeout_ms = @min(input.timeout_ms orelse default_timeout_ms, max_timeout_ms);
    const uri = client_mod.pathToUri(arena, target) catch return error.OutOfMemory;
    const display = displayPath(arena, ctx.workspace_root, target) catch return error.OutOfMemory;

    openDocument(client, arena, uri, server.language_id, source) catch |err| {
        return .{ .failure = try std.fmt.allocPrint(
            ctx.allocator,
            "lsp failed: {s} closed the connection ({s})",
            .{ server.id, @errorName(err) },
        ) };
    };
    defer closeDocument(client, arena, uri);

    const outcome = execute(ctx, arena, client, .{
        .input = input,
        .server = server,
        .uri = uri,
        .display = display,
        .position = position,
        .timeout_ms = timeout_ms,
    }) catch |err| {
        if (err == error.OutOfMemory) return error.OutOfMemory;
        return .{ .failure = try std.fmt.allocPrint(
            ctx.allocator,
            "lsp failed: {s} did not answer {s} ({s})",
            .{ server.id, @tagName(input.action), @errorName(err) },
        ) };
    };
    return outcome;
}

const Request = struct {
    input: *Input,
    server: servers.Server,
    uri: []const u8,
    display: []const u8,
    position: Position,
    timeout_ms: u32,
};

fn execute(
    ctx: tool_dispatch.DispatchContext,
    arena: Allocator,
    client: *client_mod.Client,
    request: Request,
) !tool_dispatch.ToolResult {
    return switch (request.input.action) {
        .servers => unreachable,
        .diagnostics => try renderDiagnostics(ctx, arena, client, request),
        .definition => try renderLocations(ctx, arena, client, request, "textDocument/definition"),
        .type_definition => try renderLocations(ctx, arena, client, request, "textDocument/typeDefinition"),
        .implementation => try renderLocations(ctx, arena, client, request, "textDocument/implementation"),
        .references => try renderReferences(ctx, arena, client, request),
        .hover => try renderHover(ctx, arena, client, request),
        .document_symbols => try renderDocumentSymbols(ctx, arena, client, request),
        .workspace_symbols => try renderWorkspaceSymbols(ctx, arena, client, request),
    };
}

fn openDocument(
    client: *client_mod.Client,
    arena: Allocator,
    uri: []const u8,
    language_id: []const u8,
    source: []const u8,
) !void {
    const params = try std.fmt.allocPrint(
        arena,
        "{{\"textDocument\":{{\"uri\":{f},\"languageId\":{f},\"version\":1,\"text\":{f}}}}}",
        .{
            std.json.fmt(uri, .{}),
            std.json.fmt(language_id, .{}),
            std.json.fmt(source, .{}),
        },
    );
    try client.notify("textDocument/didOpen", params);
}

fn closeDocument(client: *client_mod.Client, arena: Allocator, uri: []const u8) void {
    const params = std.fmt.allocPrint(
        arena,
        "{{\"textDocument\":{{\"uri\":{f}}}}}",
        .{std.json.fmt(uri, .{})},
    ) catch return;
    client.notify("textDocument/didClose", params) catch {};
}

fn positionParams(arena: Allocator, uri: []const u8, position: Position, extra: []const u8) ![]u8 {
    return std.fmt.allocPrint(
        arena,
        "{{\"textDocument\":{{\"uri\":{f}}},\"position\":{{\"line\":{d},\"character\":{d}}}{s}}}",
        .{ std.json.fmt(uri, .{}), position.line, position.character, extra },
    );
}

fn resultValue(parsed: std.json.Value) !std.json.Value {
    if (parsed != .object) return error.LspInvalidFrame;
    if (parsed.object.get("error")) |failure| {
        _ = failure;
        return error.LspServerError;
    }
    return parsed.object.get("result") orelse .null;
}

fn renderDiagnostics(
    ctx: tool_dispatch.DispatchContext,
    arena: Allocator,
    client: *client_mod.Client,
    request: Request,
) !tool_dispatch.ToolResult {
    client.forgetDiagnostics(request.uri);
    const pull_params = try std.fmt.allocPrint(
        arena,
        "{{\"textDocument\":{{\"uri\":{f}}}}}",
        .{std.json.fmt(request.uri, .{})},
    );

    var items: ?std.json.Value = null;
    var pulled_parse: ?std.json.Parsed(std.json.Value) = null;
    defer if (pulled_parse) |*parsed| parsed.deinit();

    const pull_timeout_ms = @max(request.timeout_ms / 2, @min(request.timeout_ms, 2_000));
    if (client.request("textDocument/diagnostic", pull_params, pull_timeout_ms)) |body| {
        defer client.alloc.free(body);
        var parsed = try std.json.parseFromSlice(std.json.Value, arena, body, .{});
        if (resultValue(parsed.value)) |result| {
            if (result == .object) {
                if (result.object.get("items")) |list| {
                    if (list == .array) {
                        items = list;
                        pulled_parse = parsed;
                    }
                }
            }
        } else |_| {}
        if (pulled_parse == null) parsed.deinit();
    } else |_| {}

    var pushed_parse: ?std.json.Parsed(std.json.Value) = null;
    defer if (pushed_parse) |*parsed| parsed.deinit();
    if (items == null) {
        const pushed = try client.waitForDiagnostics(arena, request.uri, request.timeout_ms);
        if (pushed) |body| {
            var parsed = try std.json.parseFromSlice(std.json.Value, arena, body, .{});
            if (parsed.value == .array) {
                items = parsed.value;
                pushed_parse = parsed;
            } else {
                parsed.deinit();
            }
        }
    }

    const list = items orelse {
        return .{ .success = try std.fmt.allocPrint(
            ctx.allocator,
            "{s} reported no diagnostics for {s} within {d}ms. Large projects can still be indexing; retry with a longer timeout_ms.\n",
            .{ request.server.id, request.display, request.timeout_ms },
        ) };
    };

    var out: std.Io.Writer.Allocating = .init(ctx.allocator);
    defer out.deinit();
    if (list.array.items.len == 0) {
        out.writer.print(
            "no diagnostics: {s} ({s})\n",
            .{ request.display, request.server.id },
        ) catch return error.OutOfMemory;
        return .{ .success = try out.toOwnedSlice() };
    }

    out.writer.print(
        "diagnostics: {s} ({s})\n",
        .{ request.display, request.server.id },
    ) catch return error.OutOfMemory;
    var reported: usize = 0;
    for (list.array.items) |entry| {
        if (reported >= max_reported_items) break;
        if (entry != .object) continue;
        const start = rangeStart(entry.object.get("range")) orelse Position{ .line = 0, .character = 0 };
        const message = stringField(entry.object, "message") orelse "";
        out.writer.print("{s} [{d}:{d}] {s}", .{
            severityLabel(entry.object.get("severity")),
            start.line + 1,
            start.character + 1,
            trimmed(message),
        }) catch return error.OutOfMemory;
        if (entry.object.get("code")) |code| {
            switch (code) {
                .string => |text| out.writer.print(" ({s})", .{text}) catch return error.OutOfMemory,
                .integer => |value| out.writer.print(" ({d})", .{value}) catch return error.OutOfMemory,
                else => {},
            }
        }
        out.writer.writeAll("\n") catch return error.OutOfMemory;
        reported += 1;
    }
    if (list.array.items.len > reported) {
        out.writer.print(
            "... {d} more diagnostics not shown\n",
            .{list.array.items.len - reported},
        ) catch return error.OutOfMemory;
    }
    return .{ .success = try out.toOwnedSlice() };
}

fn renderLocations(
    ctx: tool_dispatch.DispatchContext,
    arena: Allocator,
    client: *client_mod.Client,
    request: Request,
    method: []const u8,
) !tool_dispatch.ToolResult {
    const params = try positionParams(arena, request.uri, request.position, "");
    const body = try client.request(method, params, request.timeout_ms);
    defer client.alloc.free(body);
    var parsed = try std.json.parseFromSlice(std.json.Value, arena, body, .{});
    defer parsed.deinit();
    const result = try resultValue(parsed.value);

    var out: std.Io.Writer.Allocating = .init(ctx.allocator);
    defer out.deinit();
    const count = try writeLocations(&out.writer, arena, ctx.workspace_root, result);
    if (count == 0) {
        return .{ .success = try std.fmt.allocPrint(
            ctx.allocator,
            "{s} found no {s} for {s}:{d}\n",
            .{ request.server.id, @tagName(request.input.action), request.display, request.position.line + 1 },
        ) };
    }
    return .{ .success = try out.toOwnedSlice() };
}

fn renderReferences(
    ctx: tool_dispatch.DispatchContext,
    arena: Allocator,
    client: *client_mod.Client,
    request: Request,
) !tool_dispatch.ToolResult {
    const params = try positionParams(
        arena,
        request.uri,
        request.position,
        ",\"context\":{\"includeDeclaration\":true}",
    );
    const body = try client.request("textDocument/references", params, request.timeout_ms);
    defer client.alloc.free(body);
    var parsed = try std.json.parseFromSlice(std.json.Value, arena, body, .{});
    defer parsed.deinit();
    const result = try resultValue(parsed.value);

    var out: std.Io.Writer.Allocating = .init(ctx.allocator);
    defer out.deinit();
    const count = try writeLocations(&out.writer, arena, ctx.workspace_root, result);
    if (count == 0) {
        return .{ .success = try std.fmt.allocPrint(
            ctx.allocator,
            "{s} found no references for {s}:{d}\n",
            .{ request.server.id, request.display, request.position.line + 1 },
        ) };
    }
    return .{ .success = try out.toOwnedSlice() };
}

fn renderHover(
    ctx: tool_dispatch.DispatchContext,
    arena: Allocator,
    client: *client_mod.Client,
    request: Request,
) !tool_dispatch.ToolResult {
    const params = try positionParams(arena, request.uri, request.position, "");
    const body = try client.request("textDocument/hover", params, request.timeout_ms);
    defer client.alloc.free(body);
    var parsed = try std.json.parseFromSlice(std.json.Value, arena, body, .{});
    defer parsed.deinit();
    const result = try resultValue(parsed.value);
    if (result != .object) {
        return .{ .success = try std.fmt.allocPrint(
            ctx.allocator,
            "{s} has no hover information for {s}:{d}\n",
            .{ request.server.id, request.display, request.position.line + 1 },
        ) };
    }

    var out: std.Io.Writer.Allocating = .init(ctx.allocator);
    defer out.deinit();
    out.writer.print("hover: {s}:{d}\n", .{ request.display, request.position.line + 1 }) catch
        return error.OutOfMemory;
    try writeHoverContents(&out.writer, result.object.get("contents"));
    return .{ .success = try out.toOwnedSlice() };
}

fn writeHoverContents(writer: *std.Io.Writer, contents: ?std.json.Value) !void {
    const value = contents orelse return;
    switch (value) {
        .string => |text| try writeHoverText(writer, text),
        .object => |object| {
            if (object.get("value")) |inner| {
                if (inner == .string) try writeHoverText(writer, inner.string);
            }
        },
        .array => |items| {
            for (items.items) |item| try writeHoverContents(writer, item);
        },
        else => {},
    }
}

fn writeHoverText(writer: *std.Io.Writer, text: []const u8) !void {
    const body = std.mem.trim(u8, text, " \t\r\n");
    if (body.len == 0) return;
    writer.print("{s}\n", .{body}) catch return error.OutOfMemory;
}

fn renderDocumentSymbols(
    ctx: tool_dispatch.DispatchContext,
    arena: Allocator,
    client: *client_mod.Client,
    request: Request,
) !tool_dispatch.ToolResult {
    const params = try std.fmt.allocPrint(
        arena,
        "{{\"textDocument\":{{\"uri\":{f}}}}}",
        .{std.json.fmt(request.uri, .{})},
    );
    const body = try client.request("textDocument/documentSymbol", params, request.timeout_ms);
    defer client.alloc.free(body);
    var parsed = try std.json.parseFromSlice(std.json.Value, arena, body, .{});
    defer parsed.deinit();
    const result = try resultValue(parsed.value);
    if (result != .array or result.array.items.len == 0) {
        return .{ .success = try std.fmt.allocPrint(
            ctx.allocator,
            "{s} reported no symbols in {s}\n",
            .{ request.server.id, request.display },
        ) };
    }

    var out: std.Io.Writer.Allocating = .init(ctx.allocator);
    defer out.deinit();
    out.writer.print("symbols: {s} ({s})\n", .{ request.display, request.server.id }) catch
        return error.OutOfMemory;
    var reported: usize = 0;
    try writeSymbolTree(&out.writer, result.array.items, 0, &reported);
    return .{ .success = try out.toOwnedSlice() };
}

fn writeSymbolTree(
    writer: *std.Io.Writer,
    items: []const std.json.Value,
    depth: usize,
    reported: *usize,
) !void {
    for (items) |item| {
        if (reported.* >= max_reported_items) return;
        if (item != .object) continue;
        const name = stringField(item.object, "name") orelse continue;
        const kind = symbolKindLabel(item.object.get("kind"));
        const start = rangeStart(item.object.get("selectionRange")) orelse
            rangeStart(item.object.get("range")) orelse
            locationStart(item.object.get("location")) orelse
            Position{ .line = 0, .character = 0 };
        for (0..depth) |_| writer.writeAll("  ") catch return error.OutOfMemory;
        writer.print("{s} {s} [{d}]\n", .{ kind, name, start.line + 1 }) catch
            return error.OutOfMemory;
        reported.* += 1;
        if (item.object.get("children")) |children| {
            if (children == .array) {
                try writeSymbolTree(writer, children.array.items, depth + 1, reported);
            }
        }
    }
}

fn renderWorkspaceSymbols(
    ctx: tool_dispatch.DispatchContext,
    arena: Allocator,
    client: *client_mod.Client,
    request: Request,
) !tool_dispatch.ToolResult {
    const query = request.input.symbol orelse "";
    const params = try std.fmt.allocPrint(
        arena,
        "{{\"query\":{f}}}",
        .{std.json.fmt(query, .{})},
    );
    const body = try client.request("workspace/symbol", params, request.timeout_ms);
    defer client.alloc.free(body);
    var parsed = try std.json.parseFromSlice(std.json.Value, arena, body, .{});
    defer parsed.deinit();
    const result = try resultValue(parsed.value);
    if (result != .array or result.array.items.len == 0) {
        return .{ .success = try std.fmt.allocPrint(
            ctx.allocator,
            "{s} found no workspace symbol matching \"{s}\"\n",
            .{ request.server.id, query },
        ) };
    }

    var out: std.Io.Writer.Allocating = .init(ctx.allocator);
    defer out.deinit();
    out.writer.print("workspace symbols: \"{s}\" ({s})\n", .{ query, request.server.id }) catch
        return error.OutOfMemory;
    var reported: usize = 0;
    for (result.array.items) |item| {
        if (reported >= max_reported_items) break;
        if (item != .object) continue;
        const name = stringField(item.object, "name") orelse continue;
        const kind = symbolKindLabel(item.object.get("kind"));
        const location = item.object.get("location") orelse continue;
        const where = try locationText(arena, ctx.workspace_root, location);
        out.writer.print("{s} {s} {s}\n", .{ kind, name, where }) catch return error.OutOfMemory;
        reported += 1;
    }
    return .{ .success = try out.toOwnedSlice() };
}

fn writeLocations(
    writer: *std.Io.Writer,
    arena: Allocator,
    workspace_root: []const u8,
    result: std.json.Value,
) !usize {
    var count: usize = 0;
    switch (result) {
        .object => {
            const text = try locationText(arena, workspace_root, result);
            writer.print("{s}\n", .{text}) catch return error.OutOfMemory;
            count = 1;
        },
        .array => |items| {
            for (items.items) |item| {
                if (count >= max_reported_items) break;
                if (item != .object) continue;
                const text = try locationText(arena, workspace_root, item);
                writer.print("{s}\n", .{text}) catch return error.OutOfMemory;
                count += 1;
            }
        },
        else => {},
    }
    return count;
}

fn locationText(arena: Allocator, workspace_root: []const u8, value: std.json.Value) ![]const u8 {
    if (value != .object) return "unknown";
    const uri = stringField(value.object, "uri") orelse
        stringField(value.object, "targetUri") orelse
        return "unknown";
    const range = value.object.get("range") orelse
        value.object.get("targetSelectionRange") orelse
        value.object.get("targetRange");
    const start = rangeStart(range) orelse Position{ .line = 0, .character = 0 };
    const path = try client_mod.uriToPath(arena, uri);
    const display = try displayPath(arena, workspace_root, path);
    return std.fmt.allocPrint(arena, "{s}:{d}:{d}", .{ display, start.line + 1, start.character + 1 });
}

fn renderServers(alloc: Allocator, arena: Allocator) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    out.writer.writeAll("language servers (installed ones are used automatically):\n") catch
        return error.OutOfMemory;
    for (servers.table) |server| {
        const installed = servers.isInstalled(arena, server);
        if (installed) {
            out.writer.print("installed {s} ({s})\n", .{ server.id, server.language_id }) catch
                return error.OutOfMemory;
        } else {
            out.writer.print("missing   {s} ({s}) install: {s}\n", .{
                server.id,
                server.language_id,
                server.install,
            }) catch return error.OutOfMemory;
        }
    }
    return out.toOwnedSlice();
}

pub const Position = struct {
    line: u32,
    character: u32,
};

const PositionError = error{
    LineOutOfRange,
    SymbolNotOnLine,
};

fn positionErrorText(err: PositionError, input: *Input) []const u8 {
    return switch (err) {
        error.LineOutOfRange => "line is past the end of the file",
        error.SymbolNotOnLine => if (input.symbol != null)
            "symbol was not found on that line"
        else
            "character is past the end of that line",
    };
}

pub fn resolvePosition(source: []const u8, input: *Input) PositionError!Position {
    const line_number = input.line orelse return .{ .line = 0, .character = 0 };
    const line_text = lineAt(source, line_number) orelse return error.LineOutOfRange;
    const zero_based_line = line_number - 1;

    if (input.symbol) |symbol| {
        const byte_offset = std.mem.indexOf(u8, line_text, symbol) orelse return error.SymbolNotOnLine;
        return .{ .line = zero_based_line, .character = utf16Offset(line_text, byte_offset) };
    }

    const column = input.character orelse 1;
    const byte_offset = column - 1;
    if (byte_offset > line_text.len) return error.SymbolNotOnLine;
    return .{ .line = zero_based_line, .character = utf16Offset(line_text, byte_offset) };
}

fn lineAt(source: []const u8, line_number: u32) ?[]const u8 {
    var remaining = source;
    var index: u32 = 1;
    while (true) : (index += 1) {
        const end = std.mem.indexOfScalar(u8, remaining, '\n') orelse {
            if (index == line_number) return remaining;
            return null;
        };
        if (index == line_number) return std.mem.trimEnd(u8, remaining[0..end], "\r");
        remaining = remaining[end + 1 ..];
    }
}

fn utf16Offset(line_text: []const u8, byte_offset: usize) u32 {
    const bounded = @min(byte_offset, line_text.len);
    const prefix = line_text[0..bounded];
    const units = std.unicode.calcUtf16LeLen(prefix) catch return @intCast(bounded);
    return std.math.cast(u32, units) orelse std.math.maxInt(u32);
}

fn rangeStart(range: ?std.json.Value) ?Position {
    const value = range orelse return null;
    if (value != .object) return null;
    const start = value.object.get("start") orelse return null;
    if (start != .object) return null;
    const line = start.object.get("line") orelse return null;
    const character = start.object.get("character") orelse return null;
    if (line != .integer or character != .integer) return null;
    return .{
        .line = std.math.cast(u32, line.integer) orelse 0,
        .character = std.math.cast(u32, character.integer) orelse 0,
    };
}

fn locationStart(location: ?std.json.Value) ?Position {
    const value = location orelse return null;
    if (value != .object) return null;
    return rangeStart(value.object.get("range"));
}

fn stringField(object: std.json.ObjectMap, name: []const u8) ?[]const u8 {
    const value = object.get(name) orelse return null;
    if (value != .string) return null;
    return value.string;
}

fn trimmed(text: []const u8) []const u8 {
    var single = text;
    if (std.mem.indexOfScalar(u8, single, '\n')) |index| single = single[0..index];
    return std.mem.trim(u8, single, " \t\r");
}

fn severityLabel(severity: ?std.json.Value) []const u8 {
    const value = severity orelse return "error";
    if (value != .integer) return "error";
    return switch (value.integer) {
        1 => "error",
        2 => "warning",
        3 => "info",
        4 => "hint",
        else => "error",
    };
}

fn symbolKindLabel(kind: ?std.json.Value) []const u8 {
    const value = kind orelse return "symbol";
    if (value != .integer) return "symbol";
    return switch (value.integer) {
        1 => "file",
        2 => "module",
        3 => "namespace",
        4 => "package",
        5 => "class",
        6 => "method",
        7 => "property",
        8 => "field",
        9 => "constructor",
        10 => "enum",
        11 => "interface",
        12 => "function",
        13 => "variable",
        14 => "constant",
        15 => "string",
        16 => "number",
        17 => "boolean",
        18 => "array",
        19 => "object",
        20 => "key",
        21 => "null",
        22 => "enum-member",
        23 => "struct",
        24 => "event",
        25 => "operator",
        26 => "type-parameter",
        else => "symbol",
    };
}

fn displayPath(arena: Allocator, workspace_root: []const u8, absolute: []const u8) ![]const u8 {
    if (workspace_root.len == 0) return absolute;
    if (!std.mem.startsWith(u8, absolute, workspace_root)) return absolute;
    if (absolute.len == workspace_root.len) return absolute;
    const rest = absolute[workspace_root.len..];
    const relative = if (rest.len > 0 and rest[0] == '/') rest[1..] else rest;
    return arena.dupe(u8, relative);
}

pub fn readsOnly(_: tool_dispatch.ToolInput) bool {
    return true;
}

pub fn isIrreversible(_: tool_dispatch.ToolInput) bool {
    return false;
}

test "lsp decodes actions and rejects malformed arguments" {
    const alloc = std.testing.allocator;
    const decoded = try decode(
        .{ .allocator = alloc },
        "{\"action\":\"definition\",\"path\":\"src/main.zig\",\"line\":12,\"symbol\":\"main\"}",
    );
    const erased = switch (decoded) {
        .input => |value| value,
        .failure => |body| {
            defer alloc.free(body);
            return error.TestExpectedDecodedInput;
        },
    };
    defer erased.deinit(alloc);
    const input = erased.as(Input);
    try std.testing.expectEqual(Action.definition, input.action);
    try std.testing.expectEqualStrings("src/main.zig", input.path.?);
    try std.testing.expectEqual(@as(u32, 12), input.line.?);
    try std.testing.expect(try validate(.{ .allocator = alloc }, erased) == null);

    const cases = [_][]const u8{
        "{",
        "[]",
        "{\"path\":\"a.zig\"}",
        "{\"action\":42}",
        "{\"action\":\"rename\"}",
        "{\"action\":\"hover\",\"path\":1}",
        "{\"action\":\"hover\",\"path\":\"a.zig\",\"line\":0}",
    };
    for (cases) |case| {
        const result = try decode(.{ .allocator = alloc }, case);
        switch (result) {
            .failure => |body| alloc.free(body),
            .input => |value| {
                value.deinit(alloc);
                return error.TestExpectedDecodeFailure;
            },
        }
    }
}

test "lsp validation demands a position for position requests" {
    const alloc = std.testing.allocator;
    const decoded = try decode(.{ .allocator = alloc }, "{\"action\":\"hover\",\"path\":\"a.zig\"}");
    const erased = switch (decoded) {
        .input => |value| value,
        .failure => |body| {
            defer alloc.free(body);
            return error.TestExpectedDecodedInput;
        },
    };
    defer erased.deinit(alloc);
    const reason = try validate(.{ .allocator = alloc }, erased) orelse
        return error.TestExpectedValidationFailure;
    defer alloc.free(reason);
    try std.testing.expectEqualStrings("lsp requires the 1-based \"line\" of the symbol", reason);
}

test "positions resolve from a symbol or a column and count utf-16 units" {
    const source = "const a = 1;\nconst caf\xc3\xa9 = fn_name();\n";
    var by_symbol = Input{ .action = .definition, .line = 2, .symbol = @constCast("fn_name") };
    const found = try resolvePosition(source, &by_symbol);
    try std.testing.expectEqual(@as(u32, 1), found.line);
    try std.testing.expectEqual(@as(u32, 13), found.character);

    var by_column = Input{ .action = .definition, .line = 1, .character = 7 };
    const column = try resolvePosition(source, &by_column);
    try std.testing.expectEqual(@as(u32, 0), column.line);
    try std.testing.expectEqual(@as(u32, 6), column.character);

    var missing = Input{ .action = .definition, .line = 1, .symbol = @constCast("nope") };
    try std.testing.expectError(error.SymbolNotOnLine, resolvePosition(source, &missing));

    var past_end = Input{ .action = .definition, .line = 9, .symbol = @constCast("a") };
    try std.testing.expectError(error.LineOutOfRange, resolvePosition(source, &past_end));
}
