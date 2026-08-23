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
                    .json_type = .number,
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

const context_description =
    "Your own context window: how many tokens the last turn carried, how large the window is, and what share of it is gone. Nothing else in this conversation tells you that — check it before starting something long, and whenever the user asks you to keep an eye on the context.\n" ++
    "compact true folds this thread's earlier turns into one summary. It lands on your next turn, not this one: the turn you are in is already carrying its history. So compact, say in one line what you did, and stop — the next thing you are asked runs with room again.\n" ++
    "The summary replaces those turns for good. Write anything you still need down first, in the answer or in a file.";

pub const context = ToolSpec{
    .name = "context",
    .description = context_description,
    .gateway_schema = .{
        .name = "context",
        .description = context_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "compact",
                    .json_type = .boolean,
                    .description = "Fold the earlier turns into one summary, from the next turn onward. Omit to only read the window.",
                },
            },
            .required = &.{},
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    // Reading the window is the whole tool without arguments; compacting only
    // schedules the next turn's own history, never the user's thread.
    .activity_kind = .read,
    .requires_approval = false,
    .action_label = "Checking context",
    .completed_action_label = "Checked context",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    .irreversible_fn = bridge.isReversible,
};

const task_description =
    "Hand a self-contained piece of work to a subagent with its own transcript and the same permissions. Use it for work that can run on its own; you get its final answer back. Say everything it needs — it cannot see this conversation.";

pub const task = ToolSpec{
    .name = "task",
    .description = task_description,
    .gateway_schema = .{
        .name = "task",
        .description = task_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "title",
                    .json_type = .string,
                    .description = "Three or four words naming the job, for the agent list.",
                },
                .{
                    .name = "prompt",
                    .json_type = .string,
                    .description = "The complete instructions, including any file paths and context it needs.",
                },
            },
            .required = &.{ "title", "prompt" },
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .write,
    .requires_approval = false,
    .action_label = "Running a subagent",
    .completed_action_label = "Ran a subagent",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    .irreversible_fn = bridge.isReversible,
};

const plan_description =
    "Break a large job into steps, write them down in a durable markdown file, and hand each step to its own subagent. Steps that wait on nothing run at the same time, so a plan is how several subagents work in parallel instead of one doing everything in sequence. The user watches it in the thread's inspector.\n" ++
    "Reach for it when the work is more than one subagent's worth, when parts of it can go at once, or when the user asks for a plan. Use task instead for a single self-contained job.\n" ++
    "Actions:\n" ++
    "read — with id, one plan as its markdown; without, every plan and how far along it is. Read before you update: the file is what the last wave left behind.\n" ++
    "write — create the plan, or rewrite its whole shape. steps is a JSON array, as a string: id, title, brief, tasks, and needs naming the steps it waits on. Rewriting keeps what has already happened — a step that keeps its id keeps its status, a task that keeps its text keeps its tick — so restructuring halfway is safe.\n" ++
    "run — hand every step whose dependencies are done to a subagent, all at once, and write back what each answered. One wave per call: call it again for the next one.\n" ++
    "update — the state, not the shape: a step's status, its result, or check to tick its nth task off. This is how a subagent reports where it is inside its own step.\n" ++
    "delete — remove a finished plan.\n" ++
    "Write the brief as if to a stranger, because it is one: the subagent has its own transcript and cannot see this conversation. Say which files, which folder, and what \"done\" looks like.";

pub const plan = ToolSpec{
    .name = "plan",
    .description = plan_description,
    .gateway_schema = .{
        .name = "plan",
        .description = plan_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "action",
                    .json_type = .string,
                    .description = "read, write, run, update or delete. Defaults to read.",
                    .shape = &.{ .enum_values = &.{ "read", "write", "run", "update", "delete" } },
                },
                .{
                    .name = "id",
                    .json_type = .string,
                    .description = "The plan to act on, as read reports it. Omit on write to start a new plan, and on read to list them all.",
                },
                .{
                    .name = "title",
                    .json_type = .string,
                    .description = "What the plan is called. Required by write.",
                },
                .{
                    .name = "goal",
                    .json_type = .string,
                    .description = "What the whole plan is for, in a sentence or two. Every subagent is told it.",
                },
                .{
                    .name = "steps",
                    .json_type = .string,
                    .description = "The steps, as a JSON array in a string: [{\"id\":\"survey\",\"title\":\"Survey the callers\",\"brief\":\"Read every caller of send() in src/ and list what each expects.\",\"tasks\":[\"src/net\",\"src/ui\"],\"needs\":[]},{\"id\":\"port\",\"title\":\"Port the callers\",\"brief\":\"…\",\"needs\":[\"survey\"]}]. A step with no needs is in the first wave; two steps with the same needs run together.",
                },
                .{
                    .name = "step",
                    .json_type = .string,
                    .description = "Which step update is about, by its id.",
                },
                .{
                    .name = "status",
                    .json_type = .string,
                    .description = "The step's new state. Set failed when a step cannot finish, so the plan stops rather than waiting forever.",
                    .shape = &.{ .enum_values = &.{ "todo", "running", "done", "failed" } },
                },
                .{
                    .name = "result",
                    .json_type = .string,
                    .description = "One line saying what that step produced, kept in the file for the steps that wait on it.",
                },
                .{
                    .name = "check",
                    .json_type = .number,
                    .description = "Tick the step's nth task off, counting from 1. Send a negative number to untick it.",
                },
            },
            .required = &.{},
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .write,
    .requires_approval = false,
    .action_label = "Planning",
    .completed_action_label = "Planned",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    // delete removes the plan file, and the record of what every wave did with it.
    .irreversible_fn = bridge.isIrreversible,
};

const agents_description =
    "See and steer what is running right now: every live agent and subagent, with its thread, status, mode, model, tool count, token spend and what it is doing this moment. Call it with no arguments for the list. Give agent and message to send a message into a run already in flight — it arrives with that agent's next batch of tool results, which is how you correct one without losing its work. Give agent and stop to end one and everything under it. Use threads for the durable conversations themselves, running or not.";

pub const agents = ToolSpec{
    .name = "agents",
    .description = agents_description,
    .gateway_schema = .{
        .name = "agents",
        .description = agents_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "agent",
                    .json_type = .string,
                    .description = "The thread ID of the agent to steer or stop, as the list reports it. Omit to list.",
                },
                .{
                    .name = "message",
                    .json_type = .string,
                    .description = "What to send it. Requires agent.",
                },
                .{
                    .name = "stop",
                    .json_type = .boolean,
                    .description = "Stop that agent and anything running under it. Requires agent.",
                },
            },
            .required = &.{},
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    // Listing is the argument-free call, but steering and stopping change a run
    // in flight, and this reads the same way as its sibling `threads`.
    .activity_kind = .write,
    .requires_approval = false,
    .action_label = "Working with agents",
    .completed_action_label = "Worked with agents",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    // A stopped agent can be asked again; nothing already written is lost.
    .irreversible_fn = bridge.isReversible,
};

const read_trace_description =
    "Read the execution traces of past turns in this thread: every tool call, every subagent, and every subagent's own calls, nested, with arguments, durations and outcomes. Use it when a run went wrong or took far longer than it should have, or when the user points at a numbered span. If you find a mistake worth not repeating, write it up with write_skill.";

pub const read_trace = ToolSpec{
    .name = "read_trace",
    .description = read_trace_description,
    .gateway_schema = .{
        .name = "read_trace",
        .description = read_trace_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "thread",
                    .json_type = .string,
                    .description = "Thread ID to read. Omit for this thread.",
                },
                .{
                    .name = "limit",
                    .json_type = .number,
                    .description = "How many of the most recent traces to read. Default 3.",
                },
            },
            .required = &.{},
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .read,
    .requires_approval = false,
    .action_label = "Reading the trace",
    .completed_action_label = "Read the trace",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsOnly,
    .irreversible_fn = bridge.isReversible,
};

pub const all = [_]ToolSpec{ threads, context, task, plan, agents, read_trace };
