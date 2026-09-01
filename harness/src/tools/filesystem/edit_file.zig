const std = @import("std");
const file_mutation_contract = @import("../../core/tooling/file_mutation_contract.zig");
const tool_dispatch = @import("../../core/tooling/tool_dispatch.zig");

const Allocator = std.mem.Allocator;
const Edit = file_mutation_contract.Edit;
const max_content_bytes: usize = 4 * 1024 * 1024;

pub const Input = struct {
    path: []u8,
    edits: []Edit,

    pub fn deinit(self: *Input, alloc: Allocator) void {
        alloc.free(self.path);
        freeEdits(alloc, self.edits);
        self.* = .{ .path = &.{}, .edits = &.{} };
    }
};

fn freeEdits(alloc: Allocator, edits: []Edit) void {
    for (edits) |item| {
        alloc.free(item.old_string);
        alloc.free(item.new_string);
    }
    alloc.free(edits);
}

const CollectResult = union(enum) {
    edits: []Edit,
    failure: []const u8,
};

fn collectEdits(alloc: Allocator, object: std.json.ObjectMap) Allocator.Error!CollectResult {
    var collected: std.ArrayList(Edit) = .empty;
    errdefer {
        freeEdits(alloc, collected.items);
        collected.items = &.{};
        collected.deinit(alloc);
    }

    if (object.get("edits")) |edits_value| {
        if (edits_value != .array) {
            return .{ .failure = "edit_file field \"edits\" must be an array" };
        }
        if (edits_value.array.items.len == 0) {
            return .{ .failure = "edit_file field \"edits\" must not be empty" };
        }
        for (edits_value.array.items) |entry| {
            if (entry != .object) {
                freeEdits(alloc, try collected.toOwnedSlice(alloc));
                return .{ .failure = "edit_file field \"edits\" entries must be objects" };
            }
            const old_value = entry.object.get("old_string") orelse .null;
            const new_value = entry.object.get("new_string") orelse .null;
            if (old_value != .string or new_value != .string) {
                freeEdits(alloc, try collected.toOwnedSlice(alloc));
                return .{ .failure = "edit_file field \"edits\" entries require string fields \"old_string\" and \"new_string\"" };
            }
            const owned_old = try alloc.dupe(u8, old_value.string);
            errdefer alloc.free(owned_old);
            const owned_new = try alloc.dupe(u8, new_value.string);
            errdefer alloc.free(owned_new);
            try collected.append(alloc, .{
                .old_string = owned_old,
                .new_string = owned_new,
            });
        }
        return .{ .edits = try collected.toOwnedSlice(alloc) };
    }

    const old_value = object.get("old_string") orelse {
        return .{ .failure = "edit_file requires string field \"old_string\"" };
    };
    if (old_value != .string) {
        return .{ .failure = "edit_file field \"old_string\" must be a string" };
    }
    const new_value = object.get("new_string") orelse {
        return .{ .failure = "edit_file requires string field \"new_string\"" };
    };
    if (new_value != .string) {
        return .{ .failure = "edit_file field \"new_string\" must be a string" };
    }
    const owned_old = try alloc.dupe(u8, old_value.string);
    errdefer alloc.free(owned_old);
    const owned_new = try alloc.dupe(u8, new_value.string);
    errdefer alloc.free(owned_new);
    try collected.append(alloc, .{
        .old_string = owned_old,
        .new_string = owned_new,
    });
    return .{ .edits = try collected.toOwnedSlice(alloc) };
}

pub fn decode(
    ctx: tool_dispatch.DispatchContext,
    args_json: []const u8,
) tool_dispatch.DispatchError!tool_dispatch.DecodeResult {
    var parsed = std.json.parseFromSlice(
        std.json.Value,
        ctx.allocator,
        args_json,
        .{},
    ) catch {
        return .{ .failure = try ctx.allocator.dupe(
            u8,
            "edit_file arguments must be valid JSON",
        ) };
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        return .{ .failure = try ctx.allocator.dupe(
            u8,
            "edit_file arguments must be an object",
        ) };
    }

    const path_value = parsed.value.object.get("path") orelse {
        return .{ .failure = try ctx.allocator.dupe(
            u8,
            "edit_file requires string field \"path\"",
        ) };
    };
    if (path_value != .string) {
        return .{ .failure = try ctx.allocator.dupe(
            u8,
            "edit_file field \"path\" must be a string",
        ) };
    }

    const edits = switch (try collectEdits(ctx.allocator, parsed.value.object)) {
        .failure => |reason| return .{ .failure = try ctx.allocator.dupe(u8, reason) },
        .edits => |edits| edits,
    };
    errdefer freeEdits(ctx.allocator, edits);

    const input = try ctx.allocator.create(Input);
    errdefer ctx.allocator.destroy(input);
    const owned_path = try ctx.allocator.dupe(u8, path_value.string);
    input.* = .{ .path = owned_path, .edits = edits };
    return .{ .input = .{ .ptr = input, .deinit_fn = inputDeinit } };
}

fn inputDeinit(ptr: *anyopaque, alloc: Allocator) void {
    const input: *Input = @ptrCast(@alignCast(ptr));
    input.deinit(alloc);
    alloc.destroy(input);
}

pub fn takeFileMutationInput(
    tool_input: tool_dispatch.ToolInput,
    alloc: Allocator,
) file_mutation_contract.FileMutationInput {
    const input = tool_input.as(Input);
    const moved = file_mutation_contract.EditInput{
        .path = input.path,
        .edits = input.edits,
    };
    alloc.destroy(input);
    return .{ .edit = moved };
}

pub fn validate(
    ctx: tool_dispatch.DispatchContext,
    tool_input: tool_dispatch.ToolInput,
) tool_dispatch.DispatchError!?[]u8 {
    const input = tool_input.as(Input);
    if (input.path.len > std.Io.Dir.max_path_bytes) {
        return try ctx.allocator.dupe(
            u8,
            "file mutation preparation failed: path exceeds the preparation limit",
        );
    }
    for (input.edits) |item| {
        if (item.old_string.len > max_content_bytes) {
            return try ctx.allocator.dupe(
                u8,
                "edit_file failed: old_string exceeds the 4 MiB preparation limit",
            );
        }
        if (item.new_string.len > max_content_bytes) {
            return try ctx.allocator.dupe(
                u8,
                "edit_file failed: new_string exceeds the 4 MiB preparation limit",
            );
        }
    }
    return null;
}

pub fn call(
    ctx: tool_dispatch.DispatchContext,
    _: tool_dispatch.ToolInput,
) tool_dispatch.DispatchError!tool_dispatch.ToolResult {
    return .{ .failure = try ctx.allocator.dupe(
        u8,
        "edit_file execution requires canonical tool runtime authorization",
    ) };
}

pub fn readsOnly(_: tool_dispatch.ToolInput) bool {
    return false;
}

pub fn isIrreversible(_: tool_dispatch.ToolInput) bool {
    return true;
}

fn noopInputDeinit(_: *anyopaque, _: Allocator) void {}

test "edit_file decodes invalid argument shapes as failures" {
    const cases = [_]struct {
        json: []const u8,
        reason: []const u8,
    }{
        .{ .json = "{", .reason = "edit_file arguments must be valid JSON" },
        .{ .json = "[]", .reason = "edit_file arguments must be an object" },
        .{ .json = "{\"old_string\":\"a\",\"new_string\":\"b\"}", .reason = "edit_file requires string field \"path\"" },
        .{ .json = "{\"path\":1,\"old_string\":\"a\",\"new_string\":\"b\"}", .reason = "edit_file field \"path\" must be a string" },
        .{ .json = "{\"path\":\"/tmp/x\",\"new_string\":\"b\"}", .reason = "edit_file requires string field \"old_string\"" },
        .{ .json = "{\"path\":\"/tmp/x\",\"old_string\":1,\"new_string\":\"b\"}", .reason = "edit_file field \"old_string\" must be a string" },
        .{ .json = "{\"path\":\"/tmp/x\",\"old_string\":\"a\"}", .reason = "edit_file requires string field \"new_string\"" },
        .{ .json = "{\"path\":\"/tmp/x\",\"old_string\":\"a\",\"new_string\":1}", .reason = "edit_file field \"new_string\" must be a string" },
        .{ .json = "{\"path\":\"/tmp/x\",\"edits\":{}}", .reason = "edit_file field \"edits\" must be an array" },
        .{ .json = "{\"path\":\"/tmp/x\",\"edits\":[]}", .reason = "edit_file field \"edits\" must not be empty" },
        .{ .json = "{\"path\":\"/tmp/x\",\"edits\":[1]}", .reason = "edit_file field \"edits\" entries must be objects" },
        .{
            .json = "{\"path\":\"/tmp/x\",\"edits\":[{\"old_string\":\"a\",\"new_string\":\"b\"},{\"old_string\":\"c\"}]}",
            .reason = "edit_file field \"edits\" entries require string fields \"old_string\" and \"new_string\"",
        },
    };

    for (cases) |case| {
        const decoded = try decode(
            .{ .allocator = std.testing.allocator },
            case.json,
        );
        switch (decoded) {
            .failure => |reason| {
                defer std.testing.allocator.free(reason);
                try std.testing.expectEqualStrings(case.reason, reason);
            },
            .input => |input| {
                input.deinit(std.testing.allocator);
                return error.TestExpectedDecodeFailure;
            },
        }
    }
}

test "edit_file decodes owned typed input" {
    const decoded = try decode(
        .{ .allocator = std.testing.allocator },
        "{\"path\":\"file.txt\",\"old_string\":\"old\",\"new_string\":\"new\"}",
    );
    const erased = switch (decoded) {
        .input => |input| input,
        .failure => |reason| {
            defer std.testing.allocator.free(reason);
            return error.TestExpectedDecodedInput;
        },
    };
    defer erased.deinit(std.testing.allocator);
    const input = erased.as(Input);
    try std.testing.expectEqualStrings("file.txt", input.path);
    try std.testing.expectEqual(@as(usize, 1), input.edits.len);
    try std.testing.expectEqualStrings("old", input.edits[0].old_string);
    try std.testing.expectEqualStrings("new", input.edits[0].new_string);
    try std.testing.expect(
        try validate(.{ .allocator = std.testing.allocator }, erased) == null,
    );
}

test "edit_file decodes an edits array" {
    const decoded = try decode(
        .{ .allocator = std.testing.allocator },
        "{\"path\":\"file.txt\",\"edits\":[{\"old_string\":\"a\",\"new_string\":\"A\"},{\"old_string\":\"b\",\"new_string\":\"B\"}]}",
    );
    const erased = switch (decoded) {
        .input => |input| input,
        .failure => |reason| {
            defer std.testing.allocator.free(reason);
            return error.TestExpectedDecodedInput;
        },
    };
    defer erased.deinit(std.testing.allocator);
    const input = erased.as(Input);
    try std.testing.expectEqual(@as(usize, 2), input.edits.len);
    try std.testing.expectEqualStrings("a", input.edits[0].old_string);
    try std.testing.expectEqualStrings("B", input.edits[1].new_string);
}

test "edit_file validation enforces independent preparation limits" {
    const alloc = std.testing.allocator;
    const oversized_path = try alloc.alloc(u8, std.Io.Dir.max_path_bytes + 1);
    defer alloc.free(oversized_path);
    @memset(oversized_path, 'p');
    const oversized_value = try alloc.alloc(u8, 4 * 1024 * 1024 + 1);
    defer alloc.free(oversized_value);
    @memset(oversized_value, 'x');

    var default_edits = [_]Edit{.{
        .old_string = @constCast("old"),
        .new_string = @constCast("new"),
    }};
    var oversized_old = [_]Edit{.{
        .old_string = oversized_value,
        .new_string = @constCast("new"),
    }};
    var oversized_new = [_]Edit{.{
        .old_string = @constCast("old"),
        .new_string = oversized_value,
    }};

    const cases = [_]struct {
        input: Input,
        reason: []const u8,
    }{
        .{
            .input = .{ .path = oversized_path, .edits = &default_edits },
            .reason = "file mutation preparation failed: path exceeds the preparation limit",
        },
        .{
            .input = .{ .path = @constCast("file.txt"), .edits = &oversized_old },
            .reason = "edit_file failed: old_string exceeds the 4 MiB preparation limit",
        },
        .{
            .input = .{ .path = @constCast("file.txt"), .edits = &oversized_new },
            .reason = "edit_file failed: new_string exceeds the 4 MiB preparation limit",
        },
    };

    for (cases) |case| {
        var input = case.input;
        const erased = tool_dispatch.ToolInput{
            .ptr = &input,
            .deinit_fn = noopInputDeinit,
        };
        const reason = try validate(.{ .allocator = alloc }, erased) orelse
            return error.TestExpectedValidationFailure;
        defer alloc.free(reason);
        try std.testing.expectEqualStrings(case.reason, reason);
    }
}
