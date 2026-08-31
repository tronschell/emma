const tool_dispatch = @import("../../core/tooling/tool_dispatch.zig");
const bridge = @import("../../tools/emma/bridge.zig");

const ToolSpec = tool_dispatch.Tool;

const shortcut_description =
    "Create or replace a global shortcut that runs a Quick Action prompt when the user presses it anywhere on this Mac. Use it whenever the user asks in natural language to make, bind, or set up a keyboard shortcut. The result appears in Settings → Keybinds and works immediately. Emma has three Quick Action slots; matching the same label or combination updates that slot.\n" ++
    "Write accelerator in Electron form: Command, Control, Alt (the Option key), and Shift joined with +, followed by one key. Examples: Command+Alt+K, Control+Shift+Space. label is the short name shown in Settings; prompt is the complete instruction Emma runs when the shortcut fires.";

pub const shortcut = ToolSpec{
    .name = "shortcut",
    .description = shortcut_description,
    .gateway_schema = .{
        .name = "shortcut",
        .description = shortcut_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "accelerator",
                    .json_type = .string,
                    .description = "The key combination in Electron form, such as Command+Alt+K. Use Alt for the Option key.",
                },
                .{
                    .name = "label",
                    .json_type = .string,
                    .description = "Short name shown for this shortcut in Settings.",
                },
                .{
                    .name = "prompt",
                    .json_type = .string,
                    .description = "The complete natural-language instruction Emma runs when the shortcut fires.",
                },
            },
            .required = &.{ "accelerator", "label", "prompt" },
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .write,
    .requires_approval = false,
    .action_label = "Creating shortcut",
    .completed_action_label = "Created shortcut",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    .irreversible_fn = bridge.isReversible,
};

pub const all = [_]ToolSpec{shortcut};
