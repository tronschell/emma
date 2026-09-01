const tool_dispatch = @import("../../core/tooling/tool_dispatch.zig");
const tool_specs = @import("../../core/tooling/tool_specs.zig");
const bridge = @import("../../tools/emma/bridge.zig");

const ToolSpec = tool_dispatch.Tool;

const description =
    "Keep one complex job's execution checklist in a durable Markdown file. Tasks can contain nested subtasks. Use this before starting work that needs several meaningful steps when you will do the work yourself; keep it current as tasks start, finish, or block. Use plan instead when independent parts should run in parallel subagents, and skip both for simple work. Actions: read lists or one file; write creates or replaces the nested shape while preserving statuses for ids that remain; update changes one task's status; delete removes a finished list. tasks is a JSON array encoded as a string, with id, title, optional status, and optional subtasks.";

pub const task_list = ToolSpec{
    .name = "task_list",
    .description = description,
    .gateway_schema = .{
        .name = "task_list",
        .description = description,
        .input_schema = .{
            .properties = &.{
                .{ .name = "action", .json_type = .string, .description = "read, write, update or delete. Defaults to read.", .shape = &.{ .enum_values = &.{ "read", "write", "update", "delete" } } },
                .{ .name = "id", .json_type = .string, .description = "Task list id from read. Omit on a new write or to list all." },
                .{ .name = "title", .json_type = .string, .description = "Task list title. Required by write." },
                .{ .name = "goal", .json_type = .string, .description = "What completing the whole list achieves." },
                .{ .name = "tasks", .json_type = .string, .description = "Nested task array as a JSON string: [{\"id\":\"inspect\",\"title\":\"Inspect the flow\",\"subtasks\":[{\"id\":\"callers\",\"title\":\"Trace callers\"}]}]." },
                .{ .name = "task", .json_type = .string, .description = "Task id to update." },
                .{ .name = "status", .json_type = .string, .description = "New task state.", .shape = &.{ .enum_values = &.{ "pending", "in_progress", "completed", "blocked" } } },
            },
            .required = &.{},
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .write,
    .requires_approval = false,
    .action_label = "Tracking tasks",
    .completed_action_label = "Tracked tasks",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    .irreversible_fn = bridge.isIrreversible,
};

pub const all = [_]ToolSpec{task_list};

test "task list advertises nested tasks" {
    const std = @import("std");
    const schema = try tool_specs.toolGatewaySchemaJson(std.testing.allocator, task_list);
    defer std.testing.allocator.free(schema);
    try std.testing.expect(std.mem.find(u8, schema, "subtasks") != null);
    try std.testing.expect(std.mem.find(u8, schema, "in_progress") != null);
}
