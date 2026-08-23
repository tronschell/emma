//! What Emma adds to itself: tools it writes and runs, skills it records, and
//! the tools other people's MCP servers advertise.
//!
//! Every spec here executes in the Electron host through `tools/emma/bridge.zig`.
//! What lives in this file is only what the model sees: the name, the wording,
//! and the argument schema. They are `.on_select` because Emma ships enough
//! tools that advertising all of them would cost more context than the turn.

const tool_dispatch = @import("../../core/tooling/tool_dispatch.zig");
const gateway_schema = @import("../../core/tooling/gateway_schema.zig");
const bridge = @import("../../tools/emma/bridge.zig");

const ToolSpec = tool_dispatch.Tool;

const write_tool_description =
    "Write a tool of your own: an executable script kept in Emma's own data folder and callable by name from any thread afterwards, with run_tool. Use it whenever the user asks you to build or write a tool, and whenever you notice yourself repeating the same fiddly sequence of commands — write it once, then call it.\n" ++
    "code is the whole script and must start with a #! line naming its interpreter (#!/usr/bin/env bash, python3, node). It is run with one argument — the input string run_tool was called with — and whatever it prints, on stdout or stderr, is the tool's result.\n" ++
    "Writing a name that already exists replaces it, which is how a tool gets fixed. Nothing is installed on this Mac and nothing is added to the user's project: it is one file in Emma's own folder. Say what you wrote and check it with a real run_tool call before reporting it works.";

pub const write_tool = ToolSpec{
    .name = "write_tool",
    .description = write_tool_description,
    .gateway_schema = .{
        .name = "write_tool",
        .description = write_tool_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "name",
                    .json_type = .string,
                    .description = "Short slug naming the tool: lowercase letters, digits and dashes.",
                },
                .{
                    .name = "description",
                    .json_type = .string,
                    .description = "One line saying what it does and what it expects as input. This is all you will see when you list your tools later, so write it for a reader who has forgotten this conversation.",
                },
                .{
                    .name = "code",
                    .json_type = .string,
                    .description = "The complete script, starting with its #! line.",
                },
            },
            .required = &.{ "name", "description", "code" },
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    // One file lands in Emma's own folder — a write, not a run: the script is
    // only executed later, by run_tool.
    .activity_kind = .write,
    // Emma gates its own tools at execution, by thread mode and by Settings →
    // Tools, so a second prompt here would only ask the user twice.
    .requires_approval = false,
    .action_label = "Writing tool",
    .completed_action_label = "Wrote tool",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    // Rewriting a name replaces that script, but nothing outside Emma's own
    // folder changes and the fix is another write_tool call.
    .irreversible_fn = bridge.isReversible,
};

const run_tool_description =
    "Run one of the tools you wrote with write_tool. Call it with no arguments first to list them — name and description — then with name, and input if the script takes one. It runs in this thread's connected folder when there is one. Returns what the script printed, truncated.";

pub const run_tool = ToolSpec{
    .name = "run_tool",
    .description = run_tool_description,
    .gateway_schema = .{
        .name = "run_tool",
        .description = run_tool_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "name",
                    .json_type = .string,
                    .description = "The tool's name, as write_tool saved it. Omit to list the tools instead.",
                },
                .{
                    .name = "input",
                    .json_type = .string,
                    .description = "The single argument handed to the script. Omit for a tool that takes none.",
                },
            },
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .command,
    .requires_approval = false,
    .action_label = "Running tool",
    .completed_action_label = "Ran tool",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    // The script is arbitrary and runs in the connected folder, so whatever it
    // does to that folder is done.
    .irreversible_fn = bridge.isIrreversible,
};

const write_skill_description =
    "Record a durable lesson as a skill so future runs avoid a mistake or reuse a better route. Rewrite an existing name to correct an earlier lesson.";

pub const write_skill = ToolSpec{
    .name = "write_skill",
    .description = write_skill_description,
    .gateway_schema = .{
        .name = "write_skill",
        .description = write_skill_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "name",
                    .json_type = .string,
                    .description = "Lowercase hyphenated slug, for example safari-download-pdf",
                },
                .{
                    .name = "instructions",
                    .json_type = .string,
                    .description = "Markdown starting with a one-line summary, then the concrete steps that worked",
                },
            },
            .required = &.{ "name", "instructions" },
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .write,
    .requires_approval = false,
    .action_label = "Writing skill",
    .completed_action_label = "Wrote skill",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    // Rewriting a name is how a lesson gets corrected, and the file is one of
    // Emma's own notes rather than anything of the user's.
    .irreversible_fn = bridge.isReversible,
};

const write_plugin_skill_schema = gateway_schema.ObjectSchema{
    .properties = &.{
        .{ .name = "name", .json_type = .string, .description = "Lowercase hyphenated slug naming this skill." },
        .{ .name = "description", .json_type = .string, .description = "When to use this skill. This is what makes it findable later." },
        .{ .name = "instructions", .json_type = .string, .description = "The skill's Markdown body: when the workflow applies, the steps that work, and what a good result looks like. Frontmatter is written for you unless this already starts with ---." },
    },
    .required = &.{ "name", "description", "instructions" },
};

const write_plugin_description =
    "Package several skills as a plugin — the ChatGPT and Codex format, .codex-plugin/plugin.json plus a skills folder — and install it into Emma in the same call. Use it when the user asks you to make, build or package a plugin, and when several related skills only make sense together as one installable thing that could be handed to someone else.\n" ++
    "One lesson on its own is write_skill; this is for the bundle. The folder it writes is a valid plugin for any agent that reads the format, not just Emma.\n" ++
    "It lands in Emma's own marketplace and is listed on the Plugins page, where the user can uninstall it. Its skills are searchable from the next turn, not this one. Writing a name that already exists replaces it, which is how a plugin that came out wrong gets fixed.";

pub const write_plugin = ToolSpec{
    .name = "write_plugin",
    .description = write_plugin_description,
    .gateway_schema = .{
        .name = "write_plugin",
        .description = write_plugin_description,
        .input_schema = .{
            .properties = &.{
                .{ .name = "name", .json_type = .string, .description = "Short kebab-case name for the plugin, for example meeting-follow-up." },
                .{ .name = "description", .json_type = .string, .description = "One line saying what the plugin is for. This is what the user reads on the Plugins page." },
                .{ .name = "category", .json_type = .string, .description = "How it is filed: Productivity, Developer tools, Data and analytics, and so on. Defaults to Productivity." },
                .{ .name = "skills", .json_type = .array, .min_items = 1, .max_items = 64, .description = "The skills the plugin carries. Each becomes skills/<name>/SKILL.md.", .shape = &.{ .array_objects = &write_plugin_skill_schema } },
            },
            .required = &.{ "name", "description", "skills" },
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .write,
    .requires_approval = false,
    .action_label = "Writing plugin",
    .completed_action_label = "Wrote plugin",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    .irreversible_fn = bridge.isReversible,
};

pub const all = [_]ToolSpec{ write_tool, run_tool, write_skill, write_plugin };
