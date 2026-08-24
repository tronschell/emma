# The harness

`emma-cli` is the coding agent that runs every Emma turn. It is a Zig program in
[`harness/`](../harness), driven over the Agent Client Protocol from
[`desktop/main/harness.ts`](../desktop/main/harness.ts). There is no second
agent loop; a missing binary is a broken install, not a fallback.

## Attribution

**`emma-cli` is a fork of [vercel-labs/fx](https://github.com/vercel-labs/fx),
Copyright Vercel, Inc. and fx contributors, Apache License 2.0.**

| | |
| --- | --- |
| Upstream | https://github.com/vercel-labs/fx |
| Forked at | [`580a0c5`](https://github.com/vercel-labs/fx/tree/580a0c5da9386317251968c09c1cee69e763487a) |
| Upstream version | 0.0.4 |
| License | Apache-2.0 — [`harness/LICENSE`](../harness/LICENSE) |
| Upstream notices | [`harness/THIRD_PARTY_NOTICES.md`](../harness/THIRD_PARTY_NOTICES.md) (cuelume, MIT; Unicode data) |
| Provenance | [`harness/FORK.md`](../harness/FORK.md) |

Renaming the binary does not end the Apache-2.0 §4 obligation. The license
text, the notices file, and every copyright header stay, and `FORK.md` records
the changes. Do not delete them. Wider credits are in [credits.md](credits.md).

fx's agent loop, permission model, hooks, skills, subagents, tool registry, MCP
client, and ACP server are upstream's. The fork's divergences, in short:

| Area | Change |
| --- | --- |
| Name | `fx` → `emma-cli`; `build.zig.zon` fingerprint regenerated |
| Transport | Vercel AI Gateway language-model v3 → OpenAI-compatible Chat Completions |
| Auth | All Vercel and ChatGPT OAuth removed; one env var, `EMMA_PROVIDER_API_KEY` |
| Branding | `fx.sh` links, feedback, upgrade, and telemetry endpoints removed |
| `terminal` args | Two real-world call shapes normalized; per-action required fields |
| `subagent` | Advertised whenever the session supports children, not hidden behind `search_tools` |
| Images | ACP `image` prompt blocks accepted into the turn's attachment catalogue |
| Vision | Model catalogue reads OpenRouter's `architecture.input_modalities`; gate is vision alone, not vision + file input |

[FORK.md](../harness/FORK.md) is the detailed record, including everything
deleted and everything deliberately kept. Read it before touching a vendored
file.

## Who owns what

The harness owns the agent loop, tool execution, permission gating, hooks,
skills, subagents, and the MCP client for one turn. Emma owns the window, the
durable Markdown thread, and the answer to every permission question.

Four things Emma keeps away from the harness:

| | Why |
| --- | --- |
| The granted folder | The harness resolves `../` and `~` itself and mutates whatever its policy allows. `callEscapesWorkspace` checks every path-shaped argument against the workspace root first: paths are realpath'd, a path that does not exist yet resolves to its deepest existing ancestor, and anything unresolvable is an escape. Denied in every mode |
| Permission modes | All four of Emma's modes map to the harness's `ask` (`HARNESS_MODE_ID`), so every decision comes back over the wire. Mapping `acceptEdits` → `auto` skipped the folder check; `full` → `yolo` left no floor at all |
| The model | Re-applied every turn rather than trusted to persist in harness settings |
| The context window | The harness recognises a handful of model-id prefixes; Emma has the real number from the OpenRouter catalog |

[`agent-loop.ts`](../desktop/main/agent-loop.ts) is not a loop: it starts and
tracks a run, keeps the durable traces, owns the permission channel and Auto
mode's verifier, and answers four tools from its own records — `threads`,
`read_trace`, `agents`, `advisor`.

## Tools

### The harness's own

Registered in [`builtins/tools.zig`](../harness/src/builtins/tools.zig):
`list_files`, `glob_files`, `grep_files`, `read_file`, `write_file`,
`edit_file`, `delete_file`, `rename_file`, `copy_file`, `create_folder`,
`file_info`, `semantic_search`, `lsp`, `open_file`, `web_fetch`, `terminal`,
`skill`, `install_skill`, `subagent`, `mcp_search_tools`, `mcp_select_tool`,
`mcp_features`, `ask_user_question`, `read_tool_result`, `search_tools`,
`select_tool`, `vision`.

Emma delegates file reading, writing, search, and shell entirely — she ships no
`bash` of her own. `lsp` asks a real language server about one file: nine
actions (`diagnostics`, `definition`, `type_definition`, `implementation`,
`references`, `hover`, `document_symbols`, `workspace_symbols`, `servers`) over
a registry of about fifty servers in
[`core/lsp/servers.zig`](../harness/src/core/lsp/servers.zig), one process per
(server, workspace root) for the life of the CLI. `line` is 1-based and
`symbol` finds the column, converted to LSP's 0-based UTF-16 positions on the
way out.

### Emma's, appended natively

Emma's 23 tools are appended to the same registry as `++ emma_tools.all`, so the
harness advertises and dispatches them and Electron runs them. One shared
implementation, [`tools/emma/bridge.zig`](../harness/src/tools/emma/bridge.zig);
only the spec differs per tool.

| Group | File | Tools |
| --- | --- | --- |
| Threads and agents | [`emma/threads.zig`](../harness/src/builtins/emma/threads.zig) | `threads`, `context`, `plan`, `agents`, `read_trace` |
| Knowledge | [`emma/knowledge.zig`](../harness/src/builtins/emma/knowledge.zig) | `keep`, `artifact`, `workflow`, `visualize`, `autoresearch` |
| System | [`emma/system.zig`](../harness/src/builtins/emma/system.zig) | `cli`, `cli_runs`, `computer`, `advisor`, `install_mcp` |
| Extensions | [`emma/extensions.zig`](../harness/src/builtins/emma/extensions.zig) | `write_tool`, `run_tool`, `write_skill`, `write_plugin` |
| Browser | [`emma/browser.zig`](../harness/src/builtins/emma/browser.zig) | `browser` |
| Name collisions | [`emma/overrides.zig`](../harness/src/builtins/emma/overrides.zig) | `memory`, `look_at_image`, `web_search` |

`Registry.lookup` returns the first match, so a duplicate name is a bug.
`memory` goes to Emma (fx's is one `~/.fx/memories.json`; Emma's is a directory
tree under `<userData>/memories`) and so does `web_search` (fx's is dead on the
ACP path — `.web_search_runtime_ready = false`). `web_fetch` stays fx's, already
wired with an artifact store and progress. `vision` stays fx's because the
gateway looks it up **by name** and forces it when a model that cannot see is
handed an image; its advertisement is `.never`. Emma's image tool is therefore
`look_at_image`, mapped back to Emma's internal `vision` by
`HARNESS_TOOL_NAMES` in [`main.ts`](../desktop/main/main.ts).

A native tool is registered process-wide, so Emma cannot hide one by omitting it
from a per-turn list. `runEmmaTool` re-applies `toolGate(turn.mode, name,
disabledTools)` before running anything, and `whyUnavailable` answers in words
the model can read — "`cli` needs a connected folder", "`computer` controls this
Mac, and this is not a Mac".

### Discovery: two tools, then the rest

The base advertisement is `search_tools`, `select_tool`, and `subagent`
(`.always`). `vision` is `.never` — reachable only by the gateway forcing it by
name. Every other registry entry is `.on_select` and costs nothing until asked
for.

- `search_tools {query, limit}` — names and descriptions only, never a schema.
  Default limit 8, hard cap 20, `more_available` when there are more. Scoring is
  per query token, case-insensitive substring: 8 points for a name hit, 1 for a
  description hit, tokens under 3 characters ignored. Scores rather than
  filters; requiring every token to match meant real sentences matched nothing.
- `select_tool {name}` — splices one exact schema into the next model step. No
  preceding search needed. A denied, `.never`, or unknown name answers
  `Tool not found: <name>`.

This is a prompt-cost mechanism, **not** a security boundary. A hidden tool is
still registered and still runs under exactly its usual permission rules.

## The ACP wire

Newline-delimited JSON-RPC 2.0 over the child's stdio. Emma spawns `emma-cli
acp` once per workspace directory, at most `MAX_HARNESSES = 4` alive at once
(least-recently-used; `reapHarnesses` never closes one with a call in flight).

- `cwd` is the workspace. The harness derives its workspace root from its own
  cwd at startup and ignores the per-session `cwd`, so the **process** is what a
  run is confined to; `prompt()` refuses a turn whose `cwd` does not match.
- `HOME` is `<userData>/harness`, a profile of Emma's own, so the harness never
  reads the user's `~/.fx`.
- `AI_GATEWAY_API_KEY` and `EMMA_PROVIDER_API_KEY` are both set from Emma's
  `OPENROUTER_API_KEY`; both names, while the Vercel vocabulary is being removed.

A call is abandoned after `MAX_IDLE_MS` — 30 minutes — of **silence**, not wall
clock; any inbound message refreshes every pending timer.

### Methods Emma calls

`AcpMethod.parse` in [`acp/server.zig`](../harness/src/acp/server.zig) accepts
fourteen:

| Method | What it does |
| --- | --- |
| `initialize` | Once per process. `protocolVersion: 1`, `clientCapabilities.fs = {readTextFile: false, writeTextFile: false}`. A second call is an error |
| `session/new` | Takes `cwd` and `mcpServers`, returns `sessionId`, makes it active |
| `session/load`, `session/list`, `session/remove` | Session store |
| `session/resume` | Re-activates a session this process displaced, so a thread keeps its history |
| `session/close` | Flushes usage, drops the active session |
| `session/prompt` | Runs one turn |
| `session/compact` | Folds history. Refused mid-turn |
| `session/set_config_option` | `model`, `mode`, `context_window`, `context_experiments` |
| `session/set_mode` | `modeId` from [`builtins/modes.zig`](../harness/src/builtins/modes.zig): `plan`, `ask`, `acceptEdits`, `full`. Emma always sends `ask` |
| `session/cancel` | A notification, not a request — cancellation has no reply and must not hang on a wedged peer |
| `session/steer_child` | Queues a message for one running subagent by `childId`, not queued behind the active prompt |
| `session/cancel_child` | Stops one running subagent by `childId` |

`session/list`, `session/remove`, `session/prompt`, `session/compact`, and
`session/set_config_option` are refused with "Prompt already in progress" while
a turn is in flight; the rest run beside it.

**One session at a time.** `session/prompt` runs against `state.active_session`
and ignores the `sessionId` the call names, and `session/new` swaps it without
waiting. So `harness.ts` tracks which session is active, resumes a displaced one
before prompting its thread again, and runs one turn at a time per process.

### What comes back

Notifications on `session/update`, written by
[`acp/types.zig`](../harness/src/acp/types.zig):

| `sessionUpdate` | Emma does |
| --- | --- |
| `agent_message_chunk` | `onDelta` — the answer, streamed |
| `agent_thought_chunk` | `onThought` — reasoning, on its own channel |
| `tool_call` | `onToolCall` — the whole call, arguments included |
| `tool_call_update` | `onToolCall` — only what changed, merged over the last full state per `threadId:toolCallId` |
| `plan` | `onPlan` |
| `session_info_update` | `_meta.fx.contextExperiment` (a context lever fired) or `_meta.fx.modelResponseRecovery` (retry and backoff, written to the thinking channel so a run waiting out a 503 is not read as a hang) |
| `available_commands_update` | ignored |

Subagents ride the parent's stream — ACP has no nested sessions. A child tags
its updates with `_meta.fx.child` (`{id, title, state}`) and `childTag` fans
them onto an Emma thread of the child's own. Untagged, a child's words would
land in the parent's durable answer.

### One prompt turn

1. `session/set_mode`, then `session/set_config_option` for `model`,
   `context_window`, and `context_experiments`. Experiments go out every turn
   even when all off — the harness holds them per session.
2. `session/compact` if Emma asked for one last turn. Best effort.
3. `session/prompt` with content blocks. Skills, folders, files, and notes ride
   as a separate leading text block, not glued to the user's words.
4. Updates stream; permission requests and Emma-tool calls come back as
   requests.
5. Resolves with `{stopReason, usage: {inputTokens, outputTokens}}`. `usage` is
   an Emma extension — upstream ACP has no such field, and it is the only place
   a turn's real token counts exist on Emma's side.

Stop reasons: `end_turn`, `cancelled`, `refused`, `max_output_tokens`,
`max_model_turns`. `failedTurn` treats `refused` as a failure, because the
harness reports a provider or auth failure as ordinary assistant text and still
resolves the call.

### Permission

`requestAcpPermission` in [`acp/prompt.zig`](../harness/src/acp/prompt.zig)
sends `session/request_permission` with the tool call and three options —
`allow_once`, `allow_always`, `reject_once` — and the prompt thread blocks.
Emma answers `{"outcome": {"outcome": "selected", "optionId": "..."}}` or
`{"outcome": {"outcome": "cancelled"}}`. `parsePermissionDecision` maps
`allow_once` → once, `allow_always` → always, `reject_once` and `cancelled` →
deny, and **anything unparseable → deny**. At most 32 outbound requests may be
pending.

`onPermission` in [`main.ts`](../desktop/main/main.ts), in order:

1. `context.outsideWorkspace` → deny, with a `blocked: <tool> is outside the
   connected folder` step. Not overridable.
2. `full` → allow.
3. `acceptEdits` with `kind === "edit"` → allow. Commands still ask.
4. Otherwise `AgentRuntime.question`, which is where Auto mode's verifier sits.

Options are picked by preferred `kind`, never by list position — one reordering
upstream would turn "Allow once" into a session-wide grant. A denial picks
`reject_once` so the turn carries on with a "no"; cancelling would end the run.
A permission dialog titled `file_mutation` is retitled with the path
(`describePath` reads `path`, `new_path`, `destination`, `old_path`, `source`).

### `_emma/callTool`

Emma's tools read and write Electron's durable stores, so the harness never
executes one. It advertises the tool, checks the arguments are a JSON object,
and writes `_emma/callTool` with `{sessionId, toolCallId, name, arguments}` on
the same outbound registry permission and elicitation use, then blocks. There is
no deadline — connecting a folder or running a thread can take minutes — and the
only way out other than a reply is the user cancelling.

Arguments are embedded rather than re-encoded, so the client sees exactly what
the model wrote. Emma replies with `{"output": "..."}` and nothing else. A tool
that refuses or throws answers with `output` **text**, not a JSON-RPC error: the
model recovers from the first and treats the second as a broken channel. The
error path is only for a request that never named a live thread
(`-32602 Unknown session or tool`). Run plain `emma-cli` with no responder and
an Emma tool answers `This tool is only available inside Emma.`, so the turn
survives.

This replaced a localhost MCP server (`desktop/main/bridge.ts`, deleted) that
cost an HTTP round trip, a bearer token, and a second protocol.

### MCP servers

The user's configured servers are read fresh and passed on `session/new` and
`session/resume` in `HarnessMcpServer` shape — stdio only, signalled by the
*absence* of a `type`, since the harness rejects `"stdio"` as a transport value.
`harnessMcpServers` in [`capabilities.ts`](../desktop/main/capabilities.ts)
resolves each command against PATH, because the harness rejects a bare name
(`CommandNotAbsolute`). A bad entry is dropped rather than failing the whole
`session/new`.

The harness takes MCP servers only at session creation, so `forgetSession` /
`forgetAllSessions` drop a thread's session and let the next turn build a new
one. That is what makes a mid-turn `install_mcp` mean anything. Only the forward
map is dropped; clearing the reverse routing would silence the running turn.

## Limits the code enforces

| Limit | Value | Where |
| --- | --- | --- |
| Tool description, to the model | 4 KiB, then `... [truncated]` | `description_max_bytes`, [`gateway_schema.zig`](../harness/src/core/tooling/gateway_schema.zig) |
| Tool result, to the model | 64 KiB | `default_max_tool_result_bytes`, [`tool_result_limits.zig`](../harness/src/core/tooling/tool_result_limits.zig) |
| Tool output in a `tool_call_update` | 200 bytes, UTF-8 safe | `toolUpdateContentText`, [`acp/prompt.zig`](../harness/src/acp/prompt.zig) |
| Emma tool output over `_emma/callTool` | 64 KiB | `MAX_TOOL_OUTPUT_BYTES`, [`harness.ts`](../desktop/main/harness.ts) |
| One JSON-RPC line | 8 MiB | `MAX_LINE_BYTES`, [`harness.ts`](../desktop/main/harness.ts) |
| Tool arguments kept for the transcript | 4096 chars | `rawInput`, [`harness.ts`](../desktop/main/harness.ts) |
| Pending outbound requests | 32 | `max_pending_outbound`, [`acp/server.zig`](../harness/src/acp/server.zig) |
| Live harness processes | 4 | `MAX_HARNESSES`, [`main.ts`](../desktop/main/main.ts) |
| Idle before a call is abandoned | 30 min of silence | `MAX_IDLE_MS`, [`harness.ts`](../desktop/main/harness.ts) |

The description cap was fx's 1024 and is now 4 KiB, matching
`MAX_TOOL_DESCRIPTION_BYTES` in [`tools.ts`](../desktop/main/tools.ts).
`cappedDescriptionAlloc` truncates silently, and at 1024 `plan` lost its
`update` and `delete` lines. A test in
[`emma_tools.zig`](../harness/src/builtins/emma_tools.zig) fails the build if
any Emma description grows past the cap.

Binary or non-UTF-8 output becomes `binary or non-utf8 tool output omitted`. A
permission-denied result is sent whole, not previewed.

## Standing instructions

Emma does not send her system prompt over the wire.
`writeHarnessPrompt` in
[`system-prompt.ts`](../desktop/main/system-prompt.ts) writes it to
`<userData>/harness/.fx/AGENTS.md`, which
[`builtins/context.zig`](../harness/src/builtins/context.zig) loads as
`<global-rules>` beside its own built-in prompt. The block is the user's
Settings prompt, the connections block, and any kept Agent-page improvement,
rewritten per turn only when it changed. The one thing that cannot live there is
a per-turn A/B arm; that rides the turn's skill context.

Skills work the same way — see
[plugins.md](plugins.md#bundled-skills) for `mirrorSkillsToHarness`.

## `harness/src/` map

| Directory | Owns |
| --- | --- |
| `acp/` | The JSON-RPC server: `server.zig` (dispatch, session state, outbound registry), `prompt.zig` (one turn), `sessions.zig`, `types.zig`, `jsonrpc.zig`, `mcp_servers.zig` |
| `builtins/` | The registries: `tools.zig`, `emma_tools.zig` + `emma/`, `modes.zig`, `skills.zig`, `hooks.zig`, `mcp.zig`, `commands.zig`, `context.zig` (system prompt and `AGENTS.md`) |
| `core/` | Everything with state: `agent/runtime/` (the loop), `tooling/`, `permissions/`, `session/`, `mcp/`, `lsp/`, `skills/`, `hooks/`, `subagent/`, `workspace/`, `terminal/`, `execution/` |
| `gateway/` | Provider transport only. `emma_openai.zig` holds `default_chat_url` and `chat_url_env` |
| `tools/` | Implementations. Specs live in `builtins/tools.zig`, not here |
| `ui/` | The terminal front end. Emma never sees any of it |

`main.zig` is the composition root. The `wasm_*` and `napi_*` entry points serve
upstream's `libfx` package in [`harness/sdk/`](../harness/sdk), which Emma
neither builds nor ships.

## Building and testing

Zig 0.16.0, declared as `minimum_zig_version` in `harness/build.zig.zon`. The
harness declares no Zig package dependencies.

```sh
npm --prefix desktop run build:harness   # the one script
(cd harness && zig build)                # the same thing
(cd harness && zig build test)           # the only Zig test suite in the repo
```

`build:host` chains it after `emma-host`, and `package:mac` runs
`zig build -Doptimize=ReleaseSafe` inline. Nothing else builds `emma-cli` —
`npm start`, `npm run build`, and `npm run check` do not, so a stale binary
survives all three. A checkout uses `harness/zig-out/bin/emma-cli`
(`DEV_BINARIES` in `main.ts`); a packaged app has it at
`Emma.app/Contents/Resources/emma-cli`.

### Against a fake provider

[`harness/scripts/mock-openai.mjs`](../harness/scripts/mock-openai.mjs) is a
stand-in Chat Completions endpoint that checks the request shape and drives one
real round trip, so the transport can be proven with no credential and no
network:

```sh
node harness/scripts/mock-openai.mjs 8099 &
EMMA_PROVIDER_API_KEY=anything \
EMMA_PROVIDER_CHAT_URL=http://127.0.0.1:8099/v1/chat/completions \
  harness/zig-out/bin/emma-cli acp
```

| Variable | Effect |
| --- | --- |
| `EMMA_PROVIDER_API_KEY` | The only credential source. There is no sign-in surface |
| `EMMA_PROVIDER_CHAT_URL` | Read by `chatUrl()` in [`gateway/emma_openai.zig`](../harness/src/gateway/emma_openai.zig). Unset falls back to `https://openrouter.ai/api/v1/chat/completions`. Also points at a local llama-server |
| `EMMA_OPENROUTER_ZDR` | Any non-empty value adds OpenRouter's `data_collection: "deny"` and `zdr: true`. Opt-in, because most free endpoints offer neither |
| `EMMA_UPGRADE_BASE_URL` | Loopback E2E override only; emma-cli ships inside the app and has nothing to self-update from |

Larger suites: [`harness/tests/e2e/`](../harness/tests/e2e) (TypeScript, `bun
test`, spawns the built binary with a fake key and never reaches a provider;
every root `*.test.ts` must be classified in `harness/scripts/pgso/corpus.json`
or CI rejects it), [`harness/tests/evals/`](../harness/tests/evals)
(model-backed, needs a real key), and
[`harness/benchmarks/`](../harness/benchmarks).

## See also

- [architecture.md](architecture.md) — how the harness sits beside `emma-host`
- [permissions.md](permissions.md) — the modes the harness maps onto
- [tools.md](tools.md) — what each of Emma's tools does
- [plugins.md](plugins.md) — skills, MCP, and the plugin format
- [credits.md](credits.md) — everything Emma is built on
