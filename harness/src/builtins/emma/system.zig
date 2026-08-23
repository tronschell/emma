//! The Mac underneath Emma: other coding CLIs, the pointer, the advisor, MCP.
//!
//! Every spec here executes in the Electron host through `tools/emma/bridge.zig`.
//! What lives in this file is only what the model sees: the name, the wording,
//! and the argument schema. They are `.on_select` because Emma ships enough
//! tools that advertising all of them would cost more context than the turn.

const tool_dispatch = @import("../../core/tooling/tool_dispatch.zig");
const bridge = @import("../../tools/emma/bridge.zig");

const ToolSpec = tool_dispatch.Tool;

const cli_description =
    "Run another coding CLI on this Mac — Claude Code, Codex, Pi, OpenCode, Cursor — inside a connected folder, and take turns with it. Its terminal appears pinned at the top of this thread and in its own tab, so the user watches it work.\n" ++
    "action \"run\" starts a conversation with a CLI and returns its run id once the first turn finishes; \"send\" gives an existing run the next prompt, continuing the same session with everything it already knows.\n" ++
    "Check first with cli_runs {} which CLIs are installed — running one that is not there is the common failure.\n" ++
    "Say everything the CLI needs in prompt: it does not see this conversation, only the folder. Prefer it over doing the work yourself when the user names a CLI, when they want a second agent's answer on the same code, or when that CLI is set up for this project and Emma is not.\n" ++
    "unattended passes that CLI's own skip-approvals flag, so it edits and runs commands without stopping. It is the difference between a real run and one that stalls on a question nobody sees — but it is the user's Mac, so leave it off unless they asked for a hands-off run.";

pub const cli = ToolSpec{
    .name = "cli",
    .description = cli_description,
    .gateway_schema = .{
        .name = "cli",
        .description = cli_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "action",
                    .json_type = .string,
                    .description = "Start a conversation, or send the next turn of one. Defaults to run.",
                    .shape = &.{ .enum_values = &.{ "run", "send" } },
                },
                .{
                    .name = "cli",
                    .json_type = .string,
                    .description = "Which CLI to run: claude, codex, pi, opencode or cursor. Required for run.",
                },
                .{
                    .name = "id",
                    .json_type = .string,
                    .description = "The run to send to, as cli returned it. Required for send.",
                },
                .{
                    .name = "prompt",
                    .json_type = .string,
                    .description = "What to ask it. The whole instruction — it cannot see this conversation.",
                },
                .{
                    .name = "unattended",
                    .json_type = .boolean,
                    .description = "Pass that CLI's skip-approvals flag so it never stops to ask. Off by default.",
                },
                .{
                    .name = "folder",
                    .json_type = .string,
                    .description = "Name of this thread's connected folder. A thread works in exactly one, so omit this.",
                },
            },
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .command,
    // Emma gates its own tools at execution, by thread mode and by Settings →
    // Tools, so a second prompt here would only ask the user twice.
    .requires_approval = false,
    .action_label = "Running CLI",
    .completed_action_label = "Ran CLI",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    // Another coding agent editing and running commands in the user's folder,
    // with its own approvals possibly skipped. Nothing here can be taken back.
    .irreversible_fn = bridge.isIrreversible,
};

const cli_runs_description =
    "Look after the CLI runs started with cli: call it with no arguments to see which CLIs are installed on this Mac and list every run and its state, with an id to read that run's terminal output, or with stop to kill the turn it is working on. A run stays readable between turns — that is how you check whether one has finished before sending it more.";

pub const cli_runs = ToolSpec{
    .name = "cli_runs",
    .description = cli_runs_description,
    .gateway_schema = .{
        .name = "cli_runs",
        .description = cli_runs_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "id",
                    .json_type = .string,
                    .description = "Run id, as cli returned it. Omit to list the installed CLIs and every run.",
                },
                .{
                    .name = "stop",
                    .json_type = .boolean,
                    .description = "Kill the turn that run is working on instead of reading it.",
                },
            },
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .read,
    .requires_approval = false,
    .action_label = "Checking CLI runs",
    .completed_action_label = "Checked CLI runs",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    // Listing and reading are the two common shapes, but `stop` kills a turn,
    // which is a write however it is spelled.
    .reads_only_fn = bridge.readsAndWrites,
    // A stopped run can be sent the same prompt again.
    .irreversible_fn = bridge.isReversible,
};

const advisor_description =
    "Consult a stronger reviewer that sees your whole conversation: the task, every tool call you have made, every result you have read. You do not pass any of that — it is forwarded for you.\n" ++
    "Call it BEFORE substantive work: before writing, before committing to an interpretation, before building on an assumption. Finding files and reading them is orientation, not substantive work — do that first, then ask.\n" ++
    "Also call it when you believe the task is done (write the file or commit the change first, so a result survives even if this call does not), when you are stuck, and when you are considering a change of approach.\n" ++
    "Give the advice serious weight. If a step fails in practice, or you have evidence in front of you that contradicts it, adapt — but do not silently switch: ask once more with the conflict named.";

pub const advisor = ToolSpec{
    .name = "advisor",
    .description = advisor_description,
    .gateway_schema = .{
        .name = "advisor",
        .description = advisor_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "question",
                    .json_type = .string,
                    .description = "Optional. One line naming what you want decided, when the transcript alone would not make it obvious.",
                },
            },
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    // A second opinion on the transcript. Nothing on this Mac changes.
    .activity_kind = .read,
    .requires_approval = false,
    .action_label = "Consulting advisor",
    .completed_action_label = "Consulted advisor",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsOnly,
    .irreversible_fn = bridge.isReversible,
};

const install_mcp_description =
    "Install an MCP server into Emma's own configuration. The harness connects it when the next turn starts, and its tools are found from then on with mcp_search_tools — not in the turn that installs it. Take the stdio command straight from the server's own README (npx, uvx, a binary on this Mac). Installing a name that already exists replaces it, which is how a wrong command gets fixed. Prefer this over telling the user to edit a config file by hand.";

pub const install_mcp = ToolSpec{
    .name = "install_mcp",
    .description = install_mcp_description,
    .gateway_schema = .{
        .name = "install_mcp",
        .description = install_mcp_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "name",
                    .json_type = .string,
                    .description = "Short name for the server: letters, digits, dot, dash or underscore.",
                },
                .{
                    .name = "command",
                    .json_type = .string,
                    .description = "The executable to run, e.g. npx.",
                },
                .{
                    .name = "args",
                    .json_type = .array,
                    .description = "Its arguments, e.g. [\"-y\", \"@modelcontextprotocol/server-filesystem\", \"/Users/me/notes\"].",
                    .shape = &.{ .array_values = .{ .json_type = .string } },
                },
                .{
                    .name = "env",
                    .json_type = .object,
                    .description = "Environment variables the server needs. Values are stored on this Mac and appear in this transcript, so ask the user before putting a secret here.",
                },
            },
            .required = &.{ "name", "command" },
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .write,
    .requires_approval = false,
    .action_label = "Installing MCP server",
    .completed_action_label = "Installed MCP server",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    // A wrong entry is fixed by installing over it, which is what the tool's own
    // description tells the model to do.
    .irreversible_fn = bridge.isReversible,
};

const computer_description =
    "Take over this Mac's real pointer and keyboard. Only for work that has no other route: driving a GUI app, or looking at the screen. Never for files or code — use read_file, write_file and terminal. The user must have asked for it, or you must ask them first and get a yes in the conversation; a granted permission dialog is not that ask. Call with action \"screenshot\" first, then use the returned pixel coordinates. Coordinates are [x, y] in screenshot pixels, top-left origin. Use \"zoom\" on a region when small text is hard to read.";

pub const computer = ToolSpec{
    .name = "computer",
    .description = computer_description,
    .gateway_schema = .{
        .name = "computer",
        .description = computer_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "action",
                    .json_type = .string,
                    // The `computer_toolset_20260801` vocabulary, aliases included,
                    // so a model that already knows the Anthropic tool needs no
                    // retraining. Undescribed there and undescribed here.
                    .shape = &.{ .enum_values = &.{
                        "screenshot",
                        "zoom",
                        "cursor_position",
                        "wait",
                        "mouse_move",
                        "left_click",
                        "right_click",
                        "middle_click",
                        "double_click",
                        "triple_click",
                        "left_mouse_down",
                        "left_mouse_up",
                        "left_click_drag",
                        "scroll",
                        "type",
                        "key",
                        "hold_key",
                        "move",
                        "click",
                    } },
                },
                .{
                    .name = "coordinate",
                    .json_type = .array,
                    .description = "[x, y] in screenshot pixels. Required for mouse_move, the clicks, scroll, and the end of left_click_drag.",
                    .shape = &.{ .array_values = .{ .json_type = .number } },
                },
                .{
                    .name = "start_coordinate",
                    .json_type = .array,
                    .description = "[x, y] the drag starts from, for left_click_drag.",
                    .shape = &.{ .array_values = .{ .json_type = .number } },
                },
                .{
                    .name = "region",
                    .json_type = .array,
                    .description = "[x0, y0, x1, y1] in screenshot pixels, for zoom. The next screenshot shows only this box, magnified.",
                    .shape = &.{ .array_values = .{ .json_type = .number } },
                },
                .{
                    .name = "text",
                    .json_type = .string,
                    .description = "For \"type\", the text to type. For \"key\" and \"hold_key\", a combo such as cmd+s, ctrl+shift+tab, Return. On a click or scroll, the modifiers to hold, such as shift or cmd+alt.",
                },
                .{
                    .name = "scroll_direction",
                    .json_type = .string,
                    .description = "Which way to scroll.",
                    .shape = &.{ .enum_values = &.{ "up", "down", "left", "right" } },
                },
                .{
                    .name = "scroll_amount",
                    .json_type = .number,
                    .description = "Wheel lines to scroll, 1 to 50.",
                },
                .{
                    .name = "duration",
                    .json_type = .number,
                    .description = "Seconds, for wait and hold_key. At most 300.",
                },
                .{
                    .name = "repeat",
                    .json_type = .number,
                    .description = "Press the key this many times, for \"key\". At most 32.",
                },
            },
            .required = &.{"action"},
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .write,
    .requires_approval = false,
    .action_label = "Using computer",
    .completed_action_label = "Used computer",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    // A real click on a real screen. Whatever it hit already happened.
    .irreversible_fn = bridge.isIrreversible,
};

pub const all = [_]ToolSpec{ cli, cli_runs, computer, advisor, install_mcp };
