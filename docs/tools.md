# Tools

Two separate catalogs reach a turn. **Emma's own tools** run in Electron and are
gated by [permissions.ts](../desktop/shared/permissions.ts). **The harness's
builtins** run inside `emma-cli` and are gated over the ACP permission channel.
They are different lists with different names; do not conflate them.

## Emma's tools

The 27 names in `AGENT_TOOLS`. Schemas are in
[tools.ts](../desktop/main/tools.ts); `runEmmaTool` in
[main.ts](../desktop/main/main.ts) checks the gate and dispatches. Gate column:
`ask` means a dialog in `ask`/`acceptEdits`, the verifier in `auto`, and through
in `full`; `auto` means it never stops. `app approval` is an explicit human grant
for each running app per turn, in every mode. Full matrix in
[permissions.md](permissions.md).

| Tool | What it does | Gate | Implemented in |
| --- | --- | --- | --- |
| `browser` | Drives a real Chrome, mirrored in the browser pane. `snapshot` returns an accessibility tree with `@e1` refs; later actions take a ref or a CSS selector. | ask | [browser.ts](../desktop/main/browser.ts) |
| `cli` | Runs Claude Code, Codex, Pi, OpenCode or Cursor in a connected folder and takes turns with it. Needs a folder. | ask | [cli.ts](../desktop/main/cli.ts) |
| `cli_runs` | Lists installed CLIs and every run, reads one run's output, or stops its turn. | auto | [cli.ts](../desktop/main/cli.ts) |
| `computer` | Reads and operates approved running macOS or Windows apps through accessibility or UI Automation, in the background. No global pointer, screenshots or clipboard. | app approval | [computer.ts](../desktop/main/computer.ts) |
| `write_skill` | Records a durable lesson as `<userData>/skills/<slug>/SKILL.md`. | auto | [capabilities.ts](../desktop/main/capabilities.ts) |
| `write_tool` | Writes an executable script into Emma's data folder, callable later by name. `code` must start with a `#!` line. | auto | [capabilities.ts](../desktop/main/capabilities.ts) |
| `write_plugin` | Packages skills as a ChatGPT/Codex plugin and installs it on the Plugins page. | auto | [marketplace.ts](../desktop/main/marketplace.ts) |
| `run_tool` | Lists and runs the tools `write_tool` wrote. Runs in the thread's connected folder. | ask | [capabilities.ts](../desktop/main/capabilities.ts) |
| `memory` | Emma's own `/memories` directory, carried between conversations. Commands: `view`, `create`, `str_replace`, `insert`, `delete`, `rename`. | auto | [memory.ts](../desktop/main/memory.ts) |
| `advisor` | Forwards the whole transcript to a stronger model and returns its answer. Takes no arguments — the agent chooses when, never what it sees. | auto | [advisor.ts](../desktop/main/advisor.ts) |
| `vision` | Asks a vision model one question about one image, by `path` or `url`. **Advertised to the model as `look_at_image`.** | auto | [vision.ts](../desktop/main/vision.ts) |
| `secret` | Runs `command` on this computer and sends its output to the model set in Settings → Models under Secrets, with one question. Only that model's answer comes back; the output never enters the thread. | ask | [secret.ts](../desktop/main/secret.ts) |
| `web_search` | Query out to the configured provider; returns ranked titles, links and snippets. | auto | [web-search.ts](../desktop/main/web-search.ts) |
| `task_list` | Tracks one complex job as a durable Markdown tree of tasks and subtasks. Actions: `read`, `write`, `update`, `delete`. | auto | [task-lists.ts](../desktop/main/task-lists.ts) |
| `plan` | Breaks a job into steps in a durable markdown file and hands each to its own subagent; independent steps run at once. Actions: `read`, `write`, `run`, `update`, `delete`. | auto | [plans.ts](../desktop/main/plans.ts) |
| `goal` | The one objective this thread keeps working at, and the ledger under it. Actions: `set`, `get`, `update`, `extend`, `clear`. A subagent's call acts on its parent's goal. See [goals.md](goals.md). | auto | [main.ts](../desktop/main/main.ts) |
| `threads` | Emma's threads: `spawn`, `list`, `read`, `message`, `rename`. | auto | [agent-loop.ts](../desktop/main/agent-loop.ts) |
| `read_trace` | Reads past turns' execution traces in this thread, nested, with arguments and outcomes. | auto | [agent-loop.ts](../desktop/main/agent-loop.ts) |
| `context` | Reads how full this thread's context window is; `compact: true` folds earlier turns into one summary from the next turn on. | auto | [main.ts](../desktop/main/main.ts) |
| `keep` | Saves one Markdown note into the user's vault. Replaced the old knowledge-save tool. | auto | [vault.ts](../desktop/main/vault.ts) |
| `agents` | Lists what is running now; sends a message into a live run or stops it. | auto | [agent-loop.ts](../desktop/main/agent-loop.ts) |
| `install_mcp` | Adds an MCP server to Emma's config; the harness connects it on the next turn. | ask | [capabilities.ts](../desktop/main/capabilities.ts) |
| `workflow` | Builds and runs the Scheduled tasks: a trigger plus a node graph. | ask | [workflow.ts](../desktop/shared/workflow.ts) |
| `autoresearch` | Builds and runs the long experiment loops. | ask | [research.ts](../desktop/main/research.ts) |
| `artifact` | Documents, code, pages, drawings and apps on the Artifacts page. Actions: `list`, `get`, `create`, `update`, `rewrite`. No delete. | auto | [artifacts.ts](../desktop/main/artifacts.ts) |
| `component` | Widgets in Emma's own interface, built into the context bar. Actions: `list`, `get`, `create`, `rewrite`. No delete — the user switches one off or removes it from the ⋯ in its header. | auto | [components.ts](../desktop/main/components.ts) |
| `visualize` | Draws one self-contained HTML document inline in the conversation. Nothing is saved. | auto | [visuals.ts](../desktop/main/visuals.ts) |

### Availability, beyond the gate

`toolNeeds` marks two tools conditional. `cli` needs a connected folder; without
one the call answers *"cli needs a connected folder."* `computer` needs a
supported macOS or Windows host; elsewhere it answers that computer use is not
available on this platform. Both are checked in `whyUnavailable` after the gate.

Settings → Tools can switch any tool off, which makes it `hidden` in every mode.
`run_tool` is finer-grained: a single written tool is disabled by the key
`run_tool:<name>`.

### Shapes worth knowing

- `computer` — `list_apps` returns running-app metadata without an app grant.
  `get_app_state` asks for the exact app before returning accessibility text, a
  snapshot and element indices. `click`, `set_value`, `type_text`, `key` and
  `scroll` require that app's single-use snapshot and an element index. Snapshots
  expire after 60 seconds. App approval belongs only to the active parent turn;
  delegated harness agents cannot use `computer`. Menu bars are excluded, and
  grants never persist across turns. Full behavior and unsupported controls in
  [computer-use.md](computer-use.md).
- `keep` — `kind` is `page` | `note` | `selection` (a `screenshot` note exists but
  is not a tool argument). No arguments at all keeps the page in front of the
  user. The note lands immediately; a small model fills in title and tags a moment
  later, so do not call twice for the same thing.
- `plan` `steps` is a **JSON array inside a string**:
  `[{"id":"survey","title":"…","brief":"…","tasks":["src/net"],"needs":[]}]`.
  `needs` is the shape; two steps with the same `needs` run together. Rewriting
  keeps status and ticks for steps that keep their id.
- `task_list` `tasks` is a nested **JSON array inside a string**:
  `[{"id":"build","title":"Build it","subtasks":[{"id":"test","title":"Test it"}]}]`.
  Rewriting keeps the status of every task whose id remains.
- `workflow` `trigger` is a five-field UTC cron, `manual`, `after <job-id>`, or
  `on <event>`. `permissionMode` offers `ask` | `acceptEdits` | `full` only.
- `autoresearch` — `metricName`, `metricKind`, `direction` and `projectDir` are
  permanent and refused on a later save. `metricKind` `grep` reads a
  `^<metricName>:` line out of the eval output; `judge` scores it with a model.
  Budgets `maxSeconds`, `maxTokens`, `maxMicroDollars` ($1 = 1000000); 0 is no
  limit.
- `artifact` `surface` (`navbar`, `chat`, `notch`, `context`, `none`) replaces one
  whole region of Emma's own interface live, from a `code`/`js` artifact exporting
  `(api) => Component`. Adding something *new* to the interface is `component`
  instead, and is not an artifact.
- `component` builds into the context bar and nowhere else, which is enforced in
  main rather than asked for. Same module contract as a region —
  `export default (api) => Component`, no imports, no JSX — plus `fetch` and the
  `variables` it declared. Credential-bearing requests require native approval
  of the exact fixed-URL template; widget IDs are not isolated identities.
  Each `rewrite` bumps the version so the mounted
  copy reloads in place. `expand` gives it a ⤢ that opens it over the window. See
  [components.md](components.md).
- `visualize` and `artifact` writes lead with a `[visual:id]` / `[artifact:id]`
  token that Emma uses to render them. Leave it in place.

### Ceilings

| Constant | Value | Where |
| --- | --- | --- |
| `MAX_COMMAND_CHARS` | 4096 | [tools.ts](../desktop/main/tools.ts) |
| `MAX_TASK_PROMPT_CHARS` | 8192 | tools.ts |
| `MAX_CLI_PROMPT_CHARS` | 32 KiB | tools.ts |
| `MAX_WORKFLOW_NODE_CHARS` | 32 KiB | tools.ts |
| `MAX_TOOL_OUTPUT_BYTES` | 16 KiB | tools.ts |
| `MAX_TRACES_READ` | 8 | tools.ts |
| `MAX_MESSAGES_READ` | 60 | tools.ts |
| `MAX_COMMAND_MS` | 120 000 ms | [main.ts](../desktop/main/main.ts) |
| `MAX_COMMAND_OUTPUT` | 16 KiB | main.ts |

Computer-use ceilings are in [computer-use.md](computer-use.md); vault limits in
[knowledge.md](knowledge.md); component limits in [components.md](components.md).

## The harness's builtins

A different list, in a different process. `harness/` is Emma's fork of
[vercel-labs/fx](https://github.com/vercel-labs/fx) (Apache-2.0, Copyright Vercel,
Inc. and fx contributors; provenance in [FORK.md](../harness/FORK.md)). Specs are
`ToolSpec` values in [tools.zig](../harness/src/builtins/tools.zig). These are the
file, search and shell tools — Emma has none of her own.

| Tool | What it does |
| --- | --- |
| `read_file` | One UTF-8 text file, line-numbered, with optional `start_line`/`line_count`. |
| `write_file` | Create or overwrite with complete contents. |
| `edit_file` | Replace one exact `old_string` occurrence with `new_string`. |
| `delete_file` | Delete a file or empty directory. |
| `rename_file` · `copy_file` · `create_folder` · `file_info` | Move, copy, mkdir -p, and stat. |
| `list_files` | One directory level, no contents. |
| `glob_files` | Paths matching a glob; `mode=count` for counts without listing. |
| `open_file` | Open a file in the OS default app for the user. |
| `grep_files` | POSIX extended regular expression, matched per line: alternation, character classes, anchors, groups, `{m,n}`. No backreferences, lookaround, lazy quantifiers or the `\d`/`\w`/`\s` shorthands. Modes for lines, files-with-matches or counts, with `head_limit`/`offset`. |
| `semantic_search` | Lexical keyword ranking over workspace files. Not embeddings, despite the name. |
| `lsp` | Diagnostics, definition, references, hover, symbols from an installed language server. |
| `terminal` | Runs captured commands and drives durable interactive sessions, with monitors on exit, output, ports, paths. This is the shell. |
| `web_fetch` | Bounded text from a public HTTP(S) URL, returned as untrusted content. |
| `subagent` | Create, inspect, message, relate, configure and control child sessions. `permission_mode` inherits the caller and cannot exceed it. |
| `skill` · `install_skill` | Read an installed skill in bounded chunks; install one from a supported source. |
| `search_tools` · `select_tool` | Search unadvertised tools by name and description, then select one so its schema is advertised next step. |
| `mcp_search_tools` · `mcp_select_tool` · `mcp_features` | The same for configured MCP servers, plus MCP resources, prompts and completion. |
| `read_tool_result` | Read more of a large prior tool result by handle. |
| `ask_user_question` | 1–4 multiple-choice questions, interactive runs only. |
| `memory` · `web_search` · `vision` | Names that collide with Emma's. See below. |

Paths may be workspace-relative or external (absolute, `~/…`, or `../…`);
external access is subject to permission policy, and Emma denies anything outside
the connected folder before the mode is even consulted.

Every mode opens advertising only `search_tools` and `select_tool`, with the rest
behind a search. That is a prompt-cost mechanism, not a security boundary.

### The four colliding names

[overrides.zig](../harness/src/builtins/emma/overrides.zig) resolves them, and
`Registry.lookup` returns the first match — a duplicate is a bug, not a fallback.

- **`memory` — Emma's wins.** fx's is one `~/.fx/memories.json`; Emma's is a
  directory tree under `<userData>/memories`.
- **`web_search` — Emma's wins.** fx's is dead on the ACP path, which hardcodes
  `.web_search_runtime_ready = false`.
- **`web_fetch` — fx's wins.** Theirs is wired on the ACP path with an artifact
  store and progress, and carries the untrusted-content warning.
- **`vision` — fx's wins**, because it is not a tool the model picks: the gateway
  looks it up by that exact name and forces it when a model that cannot see is
  handed an image. Emma's image tool is therefore advertised as `look_at_image`.
  Both read one setting: Emma spawns the harness with Settings → Tools → Vision
  in `EMMA_VISION_MODEL`, `EMMA_VISION_CHAT_URL` and `EMMA_VISION_API_KEY`, so
  the forced tool asks the model the user chose over that model's own endpoint
  rather than asking the session's provider for a slug it does not serve.

## How a call reaches an implementation

The agent loop lives in the harness (`emma-cli acp`, see
[harness.md](harness.md)). Emma's tools are registered there as native specs
([emma_tools.zig](../harness/src/builtins/emma_tools.zig)) with
`executor_kind = .emma`, `advertisement = .on_select` and
`requires_approval = false`; the harness dispatches them back into Electron over
`_emma/callTool`, which lands in `runEmmaTool`. That function maps the wire name
(`look_at_image` → `vision`), checks `toolGate`, checks availability, parses the
arguments with `parseToolArgs`, raises the dialog on an ordinary `ask` gate, then
runs the call. `computer` instead resolves the app and obtains a human-only grant
inside its implementation, so neither Full access nor the Auto verifier bypasses
it. Before dispatch, the harness bridge rejects child computer calls and calls
without a current parent tool-call ID. Tool results return as one text string —
there is no image channel.

The harness's own tools never leave the harness process; their permission requests
come back over ACP to `onPermission` in [main.ts](../desktop/main/main.ts).

## See also

- [permissions.md](permissions.md) — the four modes, the gate matrix, the verifier
- [computer-use.md](computer-use.md) — the `computer` tool in full
- [harness.md](harness.md) — `emma-cli`, ACP, and the fork
- [knowledge.md](knowledge.md) — `keep` and the vault
- [plugins.md](plugins.md) · [cli.md](cli.md) · [jobs.md](jobs.md) · [autoresearch.md](autoresearch.md)
- [privacy.md](privacy.md) — what each tool sends off this computer
