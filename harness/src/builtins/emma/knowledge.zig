//! What a conversation with Emma leaves behind: saved pages, artifacts,
//! scheduled tasks, charts and research jobs.
//!
//! Every spec here executes in the Electron host through `tools/emma/bridge.zig`.
//! What lives in this file is only what the model sees: the name, the wording,
//! and the argument schema. They are `.on_select` because Emma ships enough
//! tools that advertising all of them would cost more context than the turn.

const tool_dispatch = @import("../../core/tooling/tool_dispatch.zig");
const bridge = @import("../../tools/emma/bridge.zig");

const ToolSpec = tool_dispatch.Tool;

const keep_description =
    "Keep something in the user's knowledge base — their \"kb\" — as a plain Markdown note in the vault folder they chose, next to whatever else they write there. Use it whenever they say save this, keep this, clip this page, note this down, remember this, or add it to their kb.\n" ++
    "With no arguments it keeps the page they are looking at: the one in front in their browser, even while Emma is the window they are typing in.\n" ++
    "kind \"page\" keeps a web page, \"note\" keeps text you or they wrote out, \"selection\" keeps something they highlighted somewhere else. Screenshots are not yours to keep: Emma files those herself when the user presses the capture key.\n" ++
    "The note lands immediately; its title and tags are filled in a moment later by a small model, so leave title out unless they named it, do not wait for the result, and do not call again for the same thing.";

pub const keep = ToolSpec{
    .name = "keep",
    .description = keep_description,
    .gateway_schema = .{
        .name = "keep",
        .description = keep_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "kind",
                    .json_type = .string,
                    .description = "What is being kept. Omit to keep the page in front of them, or when \"text\" is the whole note.",
                    .shape = &.{ .enum_values = &.{ "page", "note", "selection" } },
                },
                .{
                    .name = "title",
                    .json_type = .string,
                    .description = "What to call it, only if the user named it. Otherwise Emma names it from the capture and a model retitles it.",
                },
                .{
                    .name = "text",
                    .json_type = .string,
                    .description = "The note itself, for kind \"note\", or the words they highlighted, for \"selection\".",
                },
                .{
                    .name = "url",
                    .json_type = .string,
                    .description = "The page to keep. Omit to keep the page the user has in front of them.",
                },
            },
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .write,
    .requires_approval = false,
    .action_label = "Keeping",
    .completed_action_label = "Kept",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    .irreversible_fn = bridge.isReversible,
};

const artifact_description =
    "Make and look after artifacts: a document, code, page, drawing, diagram or app the user keeps outside this conversation. They sit on the Artifacts page, and any later thread or scheduled task can read and rewrite one by its id. The artifact skill says when one is worth making; err strongly against making one.\n" ++
    "Actions: list — id, title, kind and when each last changed. get — one in full, by id. create — title, kind and content; the id comes back and is what you address it by afterwards. update — one replacement, where old_str appears exactly once, verbatim, and new_str takes its place. rewrite — whole new content for an id that exists. No delete: an artifact is the user's to remove, from the Artifacts page.\n" ++
    "An app is a page that keeps its own SQLite: await emma.sql(sql, ...params) returns rows, and it may hold files beside it. Set language on code.\n" ++
    "A write comes back starting with a [artifact:id] token, which is how Emma draws it in the transcript. Leave it there; do not repeat it in your prose.";

pub const artifact = ToolSpec{
    .name = "artifact",
    .description = artifact_description,
    .gateway_schema = .{
        .name = "artifact",
        .description = artifact_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "action",
                    .json_type = .string,
                    .description = "What to do. Defaults to list.",
                    .shape = &.{ .enum_values = &.{ "list", "get", "create", "update", "rewrite" } },
                },
                .{
                    .name = "id",
                    .json_type = .string,
                    .description = "The artifact to act on, as create or list reported it. Required for everything but list and create.",
                },
                .{
                    .name = "title",
                    .json_type = .string,
                    .description = "What it is called, in the user's words. Required on create.",
                },
                .{
                    .name = "kind",
                    .json_type = .string,
                    .description = "What it is, which decides how it is shown and what it is saved as. Required on create.",
                    // ARTIFACT_KINDS, from desktop/shared/artifacts.ts.
                    .shape = &.{ .enum_values = &.{ "markdown", "code", "html", "app", "svg", "mermaid", "react" } },
                },
                .{
                    .name = "language",
                    .json_type = .string,
                    .description = "Highlighting hint for kind \"code\", e.g. \"python\".",
                },
                .{
                    .name = "content",
                    .json_type = .string,
                    .description = "The artifact's whole text. Required on create and rewrite.",
                },
                .{
                    .name = "file",
                    .json_type = .string,
                    .description = "For an \"app\": a file beside its page, like \"app.js\" or \"style.css\", which get, rewrite and update address instead of the page itself. Its <script src> resolves to it.",
                },
                .{
                    .name = "surface",
                    .json_type = .string,
                    .description = "Makes this artifact one region of Emma's own interface, replacing the built-in one, live and without a relaunch: navbar (the sidebar), chat (the conversation pane), notch (the island), context (the thread inspector). It must be kind \"code\", language \"js\", and `export default (api) => Component` — api is { h, Fragment, useState, useEffect, useMemo, useRef, useCallback, emma }, h is React.createElement, and the component is handed the same props the built-in region had. One region per artifact; the built-in comes back if it throws. \"none\" hands the region back. Leave it off to keep it where it is. Read the artifact skill first.",
                    // ARTIFACT_SURFACES, from desktop/shared/artifacts.ts, plus "none".
                    .shape = &.{ .enum_values = &.{ "navbar", "chat", "notch", "context", "none" } },
                },
                .{
                    .name = "old_str",
                    .json_type = .string,
                    .description = "For update: the exact text to replace. It must appear exactly once, verbatim.",
                },
                .{
                    .name = "new_str",
                    .json_type = .string,
                    .description = "For update: what replaces it. Empty deletes old_str.",
                },
            },
            .required = &.{"action"},
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .write,
    .requires_approval = false,
    .action_label = "Working with artifacts",
    .completed_action_label = "Worked with artifacts",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    // There is deliberately no delete action: removing an artifact is the
    // user's own move, from the Artifacts page.
    .irreversible_fn = bridge.isReversible,
};

const component_description =
    "Build something into Emma's own interface — a panel, a counter, a button, a small tool — mounted where the user points, and reloading in place every time you rewrite it. This is what \"build yourself an X\" means. It is not an artifact: an artifact is a thing the user keeps outside the conversation, a component is a piece of Emma.\n" ++
    "The order is fixed and there is no way around it. place first — the window lights up and the user clicks the spot it belongs in: the sidebar, the context bar, or the composer, never the transcript, which is rebuilt for every thread. The result names what they picked, and they can drag it elsewhere afterwards. Then ask them whatever the request left open: what it shows, where its numbers come from, how it should behave. Only then create.\n" ++
    "code is one ES module: export default (api) => Component. api is { h, Fragment, useState, useEffect, useMemo, useRef, useCallback, emma }; h is React.createElement, so there is no JSX and nothing to import — h(\"div\", { className: \"…\" }, …). emma is the same bridge the app uses. Reuse the app's own class names wherever one fits, so it looks like it belongs there.\n" ++
    "Style it in Emma's design system, from her own tokens — never a colour, radius or face of your own. Ground: var(--bg) for the window, var(--surface-2) for a card, --surface-3 hover, --surface-4 active. Ink: var(--text), var(--text-2) for labels, var(--text-3) for captions. Rules are 1px var(--border), or var(--border-strong) for a region outline, and never both on one edge. var(--accent) is action, state and data only, never emphasis; var(--accent-soft) is the only accent fill over a large area; var(--danger) is destructive. Space on var(--s-1) 4px through var(--s-8) 32px, sizes from var(--fs-2xs) up. A control is 28px tall, 1px bordered, transparent. Every corner is square — no border-radius anywhere. var(--font-mono) is the interface face for anything on the grid: labels, values, buttons, counts, with uppercase labels tracked by var(--ls-caps). var(--font) is for sentences. Density is the point: if it looks cramped, take something out rather than adding padding.\n" ++
    "rewrite replaces the whole module of an id that exists and hot-reloads it, which is how you iterate: the user says what is wrong, you rewrite, they watch it change. Keep going until they are happy.\n" ++
    "No delete. A component is the user's to remove, from the ⋯ in its corner.";

pub const component = ToolSpec{
    .name = "component",
    .description = component_description,
    .gateway_schema = .{
        .name = "component",
        .description = component_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "action",
                    .json_type = .string,
                    .description = "What to do. place asks the user where it goes; create builds it there; rewrite replaces one whole; list and get read what is already built. Defaults to list.",
                    // COMPONENT_ACTIONS, from desktop/main/tools.ts.
                    .shape = &.{ .enum_values = &.{ "list", "get", "place", "create", "rewrite" } },
                },
                .{
                    .name = "id",
                    .json_type = .string,
                    .description = "The component to act on, as create or list reported it. Required for get and rewrite.",
                },
                .{
                    .name = "title",
                    .json_type = .string,
                    .description = "What the user would call it. Required on create, and shown in its ⋯ menu.",
                },
                .{
                    .name = "code",
                    .json_type = .string,
                    .description = "The whole module. Required on create and rewrite.",
                },
            },
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .write,
    .requires_approval = false,
    .action_label = "Building into Emma",
    .completed_action_label = "Built into Emma",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    .irreversible_fn = bridge.isReversible,
};

const workflow_description =
    "Build and look after the user's scheduled tasks — the workflows in the Scheduled tasks section. Call it with no arguments to list them, or set action to get, save, delete, run or test.\n" ++
    "A task is a trigger plus a graph of nodes. trigger is a five-field UTC cron expression (\"0 9 * * 1\"), \"manual\", \"after <job-id>\" to run when another task finishes, or \"on <event>\" for an app event (\"on launch\", \"on page-saved\").\n" ++
    "nodes is a JSON array. Each node has an id, a kind, and text: kind \"agent\" runs text as a full turn and can saveAs a variable; kind \"set\" stores text in saveAs without running anything; kind \"if\" reads text as a condition and goes to next when it holds, otherwise to otherwise.\n" ++
    "Templates: {{name}} anywhere in text becomes that variable. {{last}} is the previous agent step's answer. A task triggered \"after\" another starts with that task's saved variables.\n" ++
    "Conditions: <value> is|is not|contains|does not contain <value>, <value> is empty|is not empty, or a numeric >, <, >= or <=.\n" ++
    "Flow: a step with no next falls through to the next node in the array; \"next\": \"end\" finishes the run. A branch must say where both sides go.\n" ++
    "Always test before saving something the clock will run unattended: test walks the graph and reports the path it takes without running any turn.";

pub const workflow = ToolSpec{
    .name = "workflow",
    .description = workflow_description,
    .gateway_schema = .{
        .name = "workflow",
        .description = workflow_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "action",
                    .json_type = .string,
                    .description = "What to do. Defaults to list.",
                    .shape = &.{ .enum_values = &.{ "list", "get", "save", "delete", "run", "test" } },
                },
                .{
                    .name = "jobId",
                    .json_type = .string,
                    .description = "The task to act on. Omit on save to create a new one.",
                },
                .{
                    .name = "title",
                    .json_type = .string,
                    .description = "Short name for the task.",
                },
                .{
                    .name = "trigger",
                    .json_type = .string,
                    .description = "Cron, \"manual\", \"after <job-id>\", or \"on <event>\".",
                },
                .{
                    .name = "prompt",
                    .json_type = .string,
                    .description = "What the task does, for a one-step task. Also the summary shown for a graph.",
                },
                .{
                    .name = "nodes",
                    .json_type = .string,
                    .description = "The node graph as a JSON array. Omit for a one-step task that just runs prompt.",
                },
                .{
                    .name = "permissionMode",
                    .json_type = .string,
                    .description = "What the unattended run may do. Nobody is there to answer a question, so \"ask\" declines every gated call.",
                    .shape = &.{ .enum_values = &.{ "plan", "ask", "acceptEdits", "full" } },
                },
                .{
                    .name = "variables",
                    .json_type = .string,
                    .description = "A JSON object of starting variables, for run and test.",
                },
            },
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .write,
    .requires_approval = false,
    .action_label = "Working with tasks",
    .completed_action_label = "Worked with tasks",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    // delete takes a scheduled task and its history away for good.
    .irreversible_fn = bridge.isIrreversible,
};

const visualize_description =
    "Draw a picture inline in this conversation, where you are answering.\n" ++
    "Draw only when it makes a relationship materially easier to see than prose would: several exact mappings or repeated-field comparisons; one thing feeding three or more downstream branches; three or more dependent steps, or state changing across a sequence; hierarchy, ownership or layout; a bug whose parts do not explain linearly. Not merely because an answer has parts. A single fact, one step, or anything a short paragraph already settles stays prose.\n" ++
    "Draw the smallest thing that carries it — a table for mappings and comparisons, a flow or timeline for sequence and change, a tree for hierarchy and branching, a wireframe for layout, a chart for magnitude and trend.\n" ++
    "html is one whole self-contained document, and it can hold as many charts, panels and widgets as the answer needs. Write your own <style> and <script>; draw with inline SVG, canvas or CSS. There is no network: no CDN, no web fonts, no images by URL. The page is dark and Emma's palette arrives as CSS variables — --bg, --text, --text-2, --text-3, --border, --accent, and --rose, --orange, --lime, --teal, --blue, --violet for series. Use those, not your own.\n" ++
    "title is a short name for what it shows.\n" ++
    "Not an artifact: nothing is saved and it dies with this conversation, though the user can export a PNG or keep it from the buttons on it. Use artifact when they should keep what you made.\n" ++
    "The result leads with a [visual:id] token, which is how Emma draws it. Leave it there, and do not repeat in prose what the picture says.";

pub const visualize = ToolSpec{
    .name = "visualize",
    .description = visualize_description,
    .gateway_schema = .{
        .name = "visualize",
        .description = visualize_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "title",
                    .json_type = .string,
                    .description = "Short name for what this shows. Names the exported file, and the artifact if the user keeps it.",
                },
                .{
                    .name = "html",
                    .json_type = .string,
                    .description = "The whole document: markup, its own <style>, its own <script>. Self-contained — nothing is fetched.",
                },
            },
            .required = &.{ "title", "html" },
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .read,
    .requires_approval = false,
    .action_label = "Drawing",
    .completed_action_label = "Drew a picture",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsOnly,
    .irreversible_fn = bridge.isReversible,
};

const autoresearch_description =
    "Build and look after the user's autoresearch jobs — the long experiment loops in the Autoresearch section. Call it with no arguments to list them, or set action to get, save, delete, start or pause.\n" ++
    "A job is a git project folder plus a metric, an eval command, a brief for the proposer, a proposer model and three budgets. One iteration is: the agent makes one change, Emma commits it, runs evalCommand in the folder, reads the metric, and keeps the change only if the metric improved — otherwise git reset --hard.\n" ++
    "THE METRIC CANNOT BE CHANGED after the job is created. metricName, metricKind, direction and projectDir are refused on a later save, because changing what is being optimised makes every earlier iteration meaningless — create a new job instead.\n" ++
    "metricKind is \"grep\" or \"judge\". grep: Emma greps ^<metricName>: out of the eval command's output, so the run must print a line like \"val_bpb: 0.997900\". judge: a model scores that output against metricPrompt, the rubric, and answers with one number.\n" ++
    "direction is \"lower\" or \"higher\" and says which way is better.\n" ++
    "Budgets are maxSeconds (wall clock across the whole job), maxTokens and maxMicroDollars ($1 = 1000000). 0 means no limit. Hitting one pauses the job with a note saying which; raising it and starting again carries on where it stopped.\n" ++
    "Ask the user which metric kind they want before saving anything — the choice is permanent.";

pub const autoresearch = ToolSpec{
    .name = "autoresearch",
    .description = autoresearch_description,
    .gateway_schema = .{
        .name = "autoresearch",
        .description = autoresearch_description,
        .input_schema = .{
            .properties = &.{
                .{
                    .name = "action",
                    .json_type = .string,
                    .description = "What to do. Defaults to list.",
                    .shape = &.{ .enum_values = &.{ "list", "get", "save", "delete", "start", "pause" } },
                },
                .{
                    .name = "jobId",
                    .json_type = .string,
                    .description = "The job to act on. Omit on save to create a new one.",
                },
                .{
                    .name = "title",
                    .json_type = .string,
                    .description = "Short name for the experiment.",
                },
                .{
                    .name = "projectDir",
                    .json_type = .string,
                    .description = "Absolute path to the project folder. Must be a git repository with at least one commit.",
                },
                .{
                    .name = "metricName",
                    .json_type = .string,
                    .description = "The grep key, or the judge's label for the score. Permanent.",
                },
                .{
                    .name = "metricKind",
                    .json_type = .string,
                    .description = "How the number is read. Permanent.",
                    .shape = &.{ .enum_values = &.{ "grep", "judge" } },
                },
                .{
                    .name = "metricPrompt",
                    .json_type = .string,
                    .description = "The judge's rubric. Omit for a grep metric.",
                },
                .{
                    .name = "direction",
                    .json_type = .string,
                    .description = "Which way is better. Permanent.",
                    .shape = &.{ .enum_values = &.{ "lower", "higher" } },
                },
                .{
                    .name = "evalCommand",
                    .json_type = .string,
                    .description = "The command Emma runs in projectDir to measure one iteration.",
                },
                .{
                    .name = "prompt",
                    .json_type = .string,
                    .description = "The user's brief for the proposer: what to try, what to leave alone, what to read first. May name an imported skill as \"/name\" and a file in a granted folder as \"@path\", both resolved on every iteration. Editable at any time.",
                },
                .{
                    .name = "proposerModel",
                    .json_type = .string,
                    .description = "OpenRouter model id the iterations run on.",
                },
                .{
                    .name = "permissionMode",
                    .json_type = .string,
                    .description = "What an iteration may do. Nobody is watching, so \"ask\" declines every gated call — a job that edits files needs \"acceptEdits\" at least.",
                    .shape = &.{ .enum_values = &.{ "plan", "ask", "acceptEdits", "full" } },
                },
                .{
                    .name = "maxSeconds",
                    .json_type = .number,
                    .description = "Wall-clock budget for the whole job. 0 for no limit.",
                },
                .{
                    .name = "maxTokens",
                    .json_type = .number,
                    .description = "Token budget across every iteration. 0 for no limit.",
                },
                .{
                    .name = "maxMicroDollars",
                    .json_type = .number,
                    .description = "Spend budget in micro-dollars; $5 is 5000000. 0 for no limit.",
                },
            },
        },
    },
    .advertisement = .on_select,
    .executor_kind = .emma,
    .activity_kind = .write,
    .requires_approval = false,
    .action_label = "Working with experiments",
    .completed_action_label = "Worked with experiments",
    .permission_target_kind = .none,
    .decode = bridge.decode,
    .validate = bridge.validate,
    .call = bridge.call,
    .reads_only_fn = bridge.readsAndWrites,
    // delete takes a job and every iteration it ran away for good.
    .irreversible_fn = bridge.isIrreversible,
};

pub const all = [_]ToolSpec{ keep, artifact, component, workflow, visualize, autoresearch };
