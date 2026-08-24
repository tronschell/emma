const std = @import("std");

pub fn parseToolArgsObject(alloc: std.mem.Allocator, args_json: []const u8) !std.json.ObjectMap {
    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, args_json, .{});
    if (parsed.value != .object) return error.InvalidToolArguments;
    return parsed.value.object;
}

pub fn requiredStringArg(args: std.json.ObjectMap, key: []const u8) ![]const u8 {
    const value = args.get(key) orelse return error.InvalidToolArguments;
    if (value != .string) return error.InvalidToolArguments;
    return value.string;
}

pub fn optionalStringArg(args: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = args.get(key) orelse return null;
    if (value != .string) return null;
    return value.string;
}

const null_placeholder_words = [_][]const u8{ "null", "none", "nil", "undefined" };

pub fn isNullPlaceholderText(text: []const u8) bool {
    const trimmed = std.mem.trim(u8, text, &std.ascii.whitespace);
    for (null_placeholder_words) |word| {
        if (std.ascii.eqlIgnoreCase(trimmed, word)) return true;
    }
    return false;
}

pub fn isNullPlaceholder(value: std.json.Value) bool {
    return switch (value) {
        .null => true,
        .string => |text| isNullPlaceholderText(text),
        else => false,
    };
}

pub fn normalizedTerminalArguments(
    alloc: std.mem.Allocator,
    args_json: []const u8,
) std.mem.Allocator.Error!?[]u8 {
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const root = std.json.parseFromSliceLeaky(
        std.json.Value,
        arena,
        args_json,
        .{ .allocate = .alloc_always },
    ) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return null,
    };
    if (root != .object) return null;

    var object = root.object;
    var changed = false;
    if (object.count() == 1) {
        const request = object.get("request") orelse .null;
        if (request == .object) {
            object = request.object;
            changed = true;
        }
    }
    if (impliesCapturedExec(object)) {
        try object.put(arena, "action", .{ .string = "exec" });
        changed = true;
    }
    if (!changed) return null;

    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    std.json.Stringify.value(
        std.json.Value{ .object = object },
        .{},
        &out.writer,
    ) catch return error.OutOfMemory;
    return try out.toOwnedSlice();
}

fn impliesCapturedExec(object: std.json.ObjectMap) bool {
    if (object.get("action")) |action| {
        if (!isNullPlaceholder(action)) return false;
    }
    const command = object.get("command") orelse return false;
    return command == .string and !isNullPlaceholderText(command.string);
}

pub fn nullablePlaceholderStringArg(args: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const text = optionalStringArg(args, key) orelse return null;
    if (isNullPlaceholderText(text)) return null;
    return text;
}

pub fn optionalBoolArg(args: std.json.ObjectMap, key: []const u8) ?bool {
    const value = args.get(key) orelse return null;
    if (value != .bool) return null;
    return value.bool;
}

pub fn optionalIntArg(args: std.json.ObjectMap, key: []const u8) ?i64 {
    const value = args.get(key) orelse return null;
    if (value != .integer) return null;
    return value.integer;
}

test "parseToolArgsObject parses object roots" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const args = try parseToolArgsObject(arena, "{\"path\":\"src/main.zig\"}");

    try std.testing.expectEqualStrings("src/main.zig", args.get("path").?.string);
}

test "parseToolArgsObject rejects non-object roots" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    try std.testing.expectError(error.InvalidToolArguments, parseToolArgsObject(arena, "[]"));
}

test "requiredStringArg rejects missing and wrong-type values" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const args = try parseToolArgsObject(arena, "{\"path\":\"src/main.zig\",\"count\":3}");

    try std.testing.expectEqualStrings("src/main.zig", try requiredStringArg(args, "path"));
    try std.testing.expectError(error.InvalidToolArguments, requiredStringArg(args, "missing"));
    try std.testing.expectError(error.InvalidToolArguments, requiredStringArg(args, "count"));
}

test "optional typed args return payloads only for matching tags" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const args = try parseToolArgsObject(arena, "{\"name\":\"fx\",\"enabled\":true,\"count\":3,\"other\":1.25}");

    try std.testing.expectEqualStrings("fx", optionalStringArg(args, "name").?);
    try std.testing.expect(optionalStringArg(args, "missing") == null);
    try std.testing.expect(optionalStringArg(args, "enabled") == null);

    try std.testing.expectEqual(true, optionalBoolArg(args, "enabled").?);
    try std.testing.expect(optionalBoolArg(args, "missing") == null);
    try std.testing.expect(optionalBoolArg(args, "name") == null);

    try std.testing.expectEqual(@as(i64, 3), optionalIntArg(args, "count").?);
    try std.testing.expect(optionalIntArg(args, "missing") == null);
    try std.testing.expect(optionalIntArg(args, "other") == null);
}

test "null placeholder reads treat textual nulls as absent" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const args = try parseToolArgsObject(
        arena,
        "{\"cwd\":\"null\",\"profile\":\" NULL \",\"shell\":null,\"command\":\"echo null\",\"dir\":\"nullify\"}",
    );

    try std.testing.expect(nullablePlaceholderStringArg(args, "cwd") == null);
    try std.testing.expect(nullablePlaceholderStringArg(args, "profile") == null);
    try std.testing.expect(nullablePlaceholderStringArg(args, "shell") == null);
    try std.testing.expect(nullablePlaceholderStringArg(args, "missing") == null);
    try std.testing.expectEqualStrings("echo null", nullablePlaceholderStringArg(args, "command").?);
    try std.testing.expectEqualStrings("nullify", nullablePlaceholderStringArg(args, "dir").?);
    try std.testing.expectEqualStrings("null", optionalStringArg(args, "cwd").?);
}

test "terminal argument normalization fills in the captured exec action" {
    const alloc = std.testing.allocator;

    const bare = (try normalizedTerminalArguments(alloc, "{\"command\":\"pwd\"}")).?;
    defer alloc.free(bare);
    try std.testing.expectEqualStrings("{\"command\":\"pwd\",\"action\":\"exec\"}", bare);

    const placeholder = (try normalizedTerminalArguments(
        alloc,
        "{\"action\":\"None\",\"command\":\"pwd\"}",
    )).?;
    defer alloc.free(placeholder);
    try std.testing.expectEqualStrings("{\"action\":\"exec\",\"command\":\"pwd\"}", placeholder);

    const nested = (try normalizedTerminalArguments(
        alloc,
        "{\"request\":{\"action\":\"exec\",\"command\":\"pwd\"}}",
    )).?;
    defer alloc.free(nested);
    try std.testing.expectEqualStrings("{\"action\":\"exec\",\"command\":\"pwd\"}", nested);

    const nested_bare = (try normalizedTerminalArguments(
        alloc,
        "{\"request\":{\"command\":\"pwd\"}}",
    )).?;
    defer alloc.free(nested_bare);
    try std.testing.expectEqualStrings("{\"command\":\"pwd\",\"action\":\"exec\"}", nested_bare);
}

test "terminal argument normalization leaves complete and unreadable calls alone" {
    const alloc = std.testing.allocator;

    try std.testing.expect(try normalizedTerminalArguments(
        alloc,
        "{\"action\":\"start\",\"command\":\"pwd\"}",
    ) == null);
    try std.testing.expect(try normalizedTerminalArguments(alloc, "{\"action\":\"list\"}") == null);
    try std.testing.expect(try normalizedTerminalArguments(alloc, "{}") == null);
    try std.testing.expect(try normalizedTerminalArguments(alloc, "not-json") == null);
    try std.testing.expect(try normalizedTerminalArguments(alloc, "[]") == null);
    try std.testing.expect(try normalizedTerminalArguments(
        alloc,
        "{\"request\":\"exec\"}",
    ) == null);
    try std.testing.expect(try normalizedTerminalArguments(
        alloc,
        "{\"request\":{\"action\":\"exec\"},\"action\":\"list\"}",
    ) == null);
}
