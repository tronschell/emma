//! The Emma tools whose names collide with an fx builtin.
//!
//! `Registry.lookup` returns the first match, so a duplicate name is a
//! programmer bug, not a fallback. `memory` and `web_search` win their names
//! because the fx version is wrong for Emma: fx's `memory` is a single
//! `~/.fx/memories.json` where Emma's is a directory tree under
//! `<userData>/memories`, and fx's `web_search` is already dead on the ACP path,
//! which hardcodes `.web_search_runtime_ready = false`.
//!
//! Two names went the other way. `web_fetch` stays fx's: theirs is wired on the
//! ACP path with an artifact store and progress, and carries the same
//! untrusted-content warning. And `vision` stays fx's because it is not a tool
//! the model picks — the gateway looks it up by that exact name and forces it
//! when a model that cannot see images is handed one; see `all` in
//! `builtins/tools.zig`. Emma's image tool is `look_at_image`, which is what it
//! does: ask a written question about one file or URL.

const tool_dispatch = @import("../../core/tooling/tool_dispatch.zig");
const gateway_schema = @import("../../core/tooling/gateway_schema.zig");
const bridge = @import("../../tools/emma/bridge.zig");

const ToolSpec = tool_dispatch.Tool;

/// tools.ts spells this once as `FOLDER_FIELD` and spreads it into every schema
/// that takes a path.
const folder_field = gateway_schema.Property{
    .name = "folder",
    .json_type = .string,
    .description = "Name of this thread's connected folder. A thread works in exactly one, so omit this.",
};

const memory_description =
    "Your own memory directory, kept between conversations. Check it before starting anything, and write down what you work out as you go — this thread's context can end at any moment, and only what is in here survives it.\n" ++
    "Every path starts with /memories. Commands:\n" ++
    "view — a directory's contents, or a file's, with line numbers. view_range [start, end] reads part of a long file; [start, -1] reads to the end.\n" ++
    "create — write path with file_text, creating or overwriting it.\n" ++
    "str_replace — swap old_str for new_str in path. old_str must appear exactly once, verbatim. Omit new_str to delete it.\n" ++
    "insert — put insert_text after line insert_line in path. Line 0 puts it at the top.\n" ++
    "delete — remove a file or directory. You cannot delete /memories itself.\n" ++
    "rename — move old_path to new_path. You cannot rename /memories itself.\n" ++
    "Keep it organised: rewrite and delete notes that no longer hold, and do not add a file where an existing one belongs.";

pub const memory = ToolSpec{
    .name = "memory",
    .description = memory_description,
    .gateway_schema = .{
        .name = "memory",
        .description = memory_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "command",
                    .json_type = .string,
                    .description = "Which memory operation to perform.",
                    // `MEMORY_COMMANDS` in desktop/main/memory.ts.
                    .shape = &.{ .enum_values = &.{ "view", "create", "str_replace", "insert", "delete", "rename" } },
                },
                .{
                    .name = "path",
                    .json_type = .string,
                    .description = "The file or directory, starting with /memories. Not used by rename.",
                },
                .{
                    .name = "file_text",
                    .json_type = .string,
                    .description = "The file's complete contents, for create.",
                },
                .{
                    .name = "view_range",
                    .json_type = .array,
                    .description = "[start_line, end_line] for view; end -1 reads to the end of the file.",
                    .shape = &.{ .array_values = .{ .json_type = .number } },
                },
                .{
                    .name = "old_str",
                    .json_type = .string,
                    .description = "The exact text to replace, for str_replace.",
                },
                .{
                    .name = "new_str",
                    .json_type = .string,
                    .description = "What replaces it. Omit to delete old_str.",
                },
                .{
                    .name = "insert_line",
                    .json_type = .number,
                    .description = "Insert after this line number, for insert. 0 is the top of the file.",
                },
                .{
                    .name = "insert_text",
                    .json_type = .string,
                    .description = "The text to insert.",
                },
                .{
                    .name = "old_path",
                    .json_type = .string,
                    .description = "The path to move, for rename.",
                },
                .{
                    .name = "new_path",
                    .json_type = .string,
                    .description = "Where it moves to, for rename.",
                },
            },
            .required = &.{"command"},
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .write,
    // Emma gates its own tools at execution, by thread mode and by Settings →
    // Tools, so a second prompt here would only ask the user twice.
    .requires_approval = false,
    .action_label = "Working with memory",
    .completed_action_label = "Worked with memory",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    // `delete` takes a file or a whole directory away, and nothing here restores it.
    .irreversible_fn = bridge.isIrreversible,
};

const look_at_image_description =
    "Look at an image through a vision model and get an answer back in words. Use it whenever the work involves a picture: a screenshot, a photo, a mockup, a chart, a scanned page, a diagram — including when you cannot see images at all, which is most of the time.\n" ++
    "Name the image with path (a file in a connected folder, or the absolute path of one the user attached to their message) or url (a public image URL), and ask one specific question. Specific questions get specific answers: \"what error is in this dialog, quoted exactly\" beats \"what is this\".\n" ++
    "It can identify what is in the image, read the text in it, and locate things — ask for a bounding box and you get [x0, y0, x1, y1] in pixels with the image size, which is what you need before clicking anything.\n" ++
    "Ask again with a narrower question rather than assuming: the model that looked is not you, and it can misread. Never state as fact something it said it could not tell.";

pub const look_at_image = ToolSpec{
    .name = "look_at_image",
    .description = look_at_image_description,
    .gateway_schema = .{
        .name = "look_at_image",
        .description = look_at_image_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "question",
                    .json_type = .string,
                    .description = "What you want to know about the image. One specific question; name the boxes, the text or the objects you want back.",
                },
                .{
                    .name = "path",
                    .json_type = .string,
                    .description = "Image file relative to a connected folder's root, e.g. screenshots/error.png — or the absolute path an attached image was given.",
                },
                .{
                    .name = "url",
                    .json_type = .string,
                    .description = "Public URL of the image, when it is not on this Mac. Use path for a local file.",
                },
                folder_field,
            },
            .required = &.{"question"},
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .read,
    .requires_approval = false,
    .action_label = "Looking at the image",
    .completed_action_label = "Looked at the image",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsOnly,
    .irreversible_fn = bridge.isReversible,
};

const web_search_description =
    "Search the web and get back a ranked list of titles, links and snippets. Use it when the answer depends on something current, or on a page you do not have. A snippet is a hint, not the answer — follow the promising one with web_fetch before you rely on it.";

pub const web_search = ToolSpec{
    .name = "web_search",
    .description = web_search_description,
    .gateway_schema = .{
        .name = "web_search",
        .description = web_search_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "query",
                    .json_type = .string,
                    .description = "What to search for, in the words a person would type.",
                },
                .{
                    .name = "limit",
                    .json_type = .number,
                    .description = "How many results to return. Default 8, at most 20.",
                },
            },
            .required = &.{"query"},
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .read,
    .requires_approval = false,
    .action_label = "Searching the web",
    .completed_action_label = "Searched the web",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsOnly,
    .irreversible_fn = bridge.isReversible,
};

pub const all = [_]ToolSpec{ memory, look_at_image, web_search };
