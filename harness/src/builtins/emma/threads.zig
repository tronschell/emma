//! Emma's threads and the agents running in them.
//!
//! Every spec here executes in the Electron host through `tools/emma/bridge.zig`.
//! What lives in this file is only what the model sees: the name, the wording,
//! and the argument schema. They are `.on_select` because Emma ships enough
//! tools that advertising all of them would cost more context than the turn.

const tool_dispatch = @import("../../core/tooling/tool_dispatch.zig");
const bridge = @import("../../tools/emma/bridge.zig");

const ToolSpec = tool_dispatch.Tool;

const threads_description =
    "Emma's threads: the durable conversations in the user's sidebar. A thread keeps its whole history and outlives every run inside it, so it is what the user comes back to. Actions:\n" ++
    "spawn — start a thread of its own in this project, owned by this one. With prompt, a main agent of its own starts work in it immediately and in parallel with this turn; nothing comes back here, so say it is running and check on it later. Without prompt the thread is created empty for the user to pick up.\n" ++
    "list — every thread with its owner, message count and whether an agent is working in it right now.\n" ++
    "read — one thread's most recent messages, by ID. This is how you pick up what another conversation already worked out.\n" ++
    "message — send text into another thread: it steers the agent working there if one is, and starts a turn if none is.\n" ++
    "rename — rename the thread this turn is in, so its sidebar row says what it is about. Do this once on your own when a thread still called \"New thread\" has settled into a subject.\n" ++
    "Use task instead when you need an answer inside this turn: a subagent is a worker that dissolves once it answers, a thread is a conversation that stays.";

pub const threads = ToolSpec{
    .name = "threads",
    .description = threads_description,
    .gateway_schema = .{
        .name = "threads",
        .description = threads_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "action",
                    .json_type = .string,
                    .description = "What to do: spawn, list, read, message or rename.",
                    .shape = &.{ .enum_values = &.{ "spawn", "list", "read", "message", "rename" } },
                },
                .{
                    .name = "title",
                    .json_type = .string,
                    .description = "Three or four words naming the thread. Required by spawn and rename.",
                },
                .{
                    .name = "thread",
                    .json_type = .string,
                    .description = "The thread ID to act on, as list reports it. Required by read and message.",
                },
                .{
                    .name = "prompt",
                    .json_type = .string,
                    .description = "What to say: the first instruction for a spawned thread's own agent, or the text sent by message.",
                },
                .{
                    .name = "limit",
                    .json_type = .integer,
                    .description = "How many of the most recent messages read returns. Default 20.",
                },
            },
            .required = &.{"action"},
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .write,
    // Emma gates its own tools at execution, by thread mode and by Settings →
    // Tools, so a second prompt here would only ask the user twice.
    .requires_approval = false,
    .action_label = "Working with threads",
    .completed_action_label = "Worked with threads",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    .irreversible_fn = bridge.isReversible,
};

pub const all = [_]ToolSpec{threads};
