const std = @import("std");
const tool_dispatch = @import("tool_dispatch.zig");

const Allocator = std.mem.Allocator;

pub const max_option_bytes: usize = 16 * 1024;
pub const max_hint_bytes: usize = 2 * 1024;

pub const Hint = struct {
    name: []const u8,
    description: []const u8,
};

pub const Overrides = struct {
    hints: []const Hint = &.{},
    preselect: []const []const u8 = &.{},

    pub fn hintFor(self: Overrides, name: []const u8) ?[]const u8 {
        for (self.hints) |hint| {
            if (std.mem.eql(u8, hint.name, name)) return hint.description;
        }
        return null;
    }

    pub fn preselects(self: Overrides, name: []const u8) bool {
        for (self.preselect) |candidate| {
            if (std.mem.eql(u8, candidate, name)) return true;
        }
        return false;
    }

    pub fn apply(self: Overrides, tool: *tool_dispatch.Tool) void {
        if (self.hintFor(tool.name)) |description| {
            tool.description = description;
            tool.gateway_schema.description = description;
        }
        if (tool.advertisement == .on_select and self.preselects(tool.name))
            tool.advertisement = .always;
    }
};

pub const Hints = struct {
    items: []Hint = &.{},

    pub fn deinit(self: *Hints, alloc: Allocator) void {
        for (self.items) |hint| {
            alloc.free(hint.name);
            alloc.free(hint.description);
        }
        alloc.free(self.items);
        self.* = .{};
    }
};

pub const Names = struct {
    items: [][]const u8 = &.{},

    pub fn deinit(self: *Names, alloc: Allocator) void {
        for (self.items) |name| alloc.free(name);
        alloc.free(self.items);
        self.* = .{};
    }
};

pub fn parseHints(alloc: Allocator, value: []const u8) !Hints {
    const trimmed = std.mem.trim(u8, value, " \n\r\t");
    if (trimmed.len == 0) return .{};
    if (trimmed.len > max_option_bytes) return error.InvalidValue;

    var parsed = std.json.parseFromSlice(std.json.Value, alloc, trimmed, .{}) catch
        return error.InvalidValue;
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidValue;

    var hints: std.ArrayList(Hint) = .empty;
    errdefer {
        for (hints.items) |hint| {
            alloc.free(hint.name);
            alloc.free(hint.description);
        }
        hints.deinit(alloc);
    }

    var entries = parsed.value.object.iterator();
    while (entries.next()) |entry| {
        if (entry.value_ptr.* != .string) return error.InvalidValue;
        const description = entry.value_ptr.string;
        if (entry.key_ptr.*.len == 0 or description.len == 0) return error.InvalidValue;
        if (description.len > max_hint_bytes) return error.InvalidValue;
        const name = try alloc.dupe(u8, entry.key_ptr.*);
        errdefer alloc.free(name);
        const owned = try alloc.dupe(u8, description);
        errdefer alloc.free(owned);
        try hints.append(alloc, .{ .name = name, .description = owned });
    }

    return .{ .items = try hints.toOwnedSlice(alloc) };
}

pub fn parseNames(alloc: Allocator, value: []const u8) !Names {
    if (value.len > max_option_bytes) return error.InvalidValue;

    var names: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (names.items) |name| alloc.free(name);
        names.deinit(alloc);
    }

    var fields = std.mem.splitScalar(u8, value, ',');
    while (fields.next()) |raw| {
        const name = std.mem.trim(u8, raw, " \n\r\t");
        if (name.len == 0) continue;
        const owned = try alloc.dupe(u8, name);
        errdefer alloc.free(owned);
        try names.append(alloc, owned);
    }

    return .{ .items = try names.toOwnedSlice(alloc) };
}

test "tool hints parse into name and description pairs and an empty value clears them" {
    const alloc = std.testing.allocator;
    var hints = try parseHints(alloc, "{\"threads\":\"Read the timeline.\"}");
    defer hints.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 1), hints.items.len);
    try std.testing.expectEqualStrings("threads", hints.items[0].name);
    try std.testing.expectEqualStrings("Read the timeline.", hints.items[0].description);

    var cleared = try parseHints(alloc, "");
    defer cleared.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 0), cleared.items.len);
}

test "tool hints refuse malformed JSON and oversized text" {
    const alloc = std.testing.allocator;
    try std.testing.expectError(error.InvalidValue, parseHints(alloc, "{\"threads\":"));
    try std.testing.expectError(error.InvalidValue, parseHints(alloc, "[\"threads\"]"));
    try std.testing.expectError(error.InvalidValue, parseHints(alloc, "{\"threads\":7}"));

    const long_hint = "{\"threads\":\"" ++ "x" ** (max_hint_bytes + 1) ++ "\"}";
    try std.testing.expectError(error.InvalidValue, parseHints(alloc, long_hint));

    const long_option = "{\"" ++ "x" ** max_option_bytes ++ "\":\"ok\"}";
    try std.testing.expectError(error.InvalidValue, parseHints(alloc, long_option));
}

test "preselect names split on commas and an empty value clears them" {
    const alloc = std.testing.allocator;
    var names = try parseNames(alloc, "threads, knowledge ,");
    defer names.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 2), names.items.len);
    try std.testing.expectEqualStrings("threads", names.items[0]);
    try std.testing.expectEqualStrings("knowledge", names.items[1]);

    var cleared = try parseNames(alloc, "");
    defer cleared.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 0), cleared.items.len);
}
