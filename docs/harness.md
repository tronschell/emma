# The harness

`emma-cli` is the coding agent that runs every Emma turn. It is a Zig program in [`harness/`](../harness), forked from [vercel-labs/fx](https://github.com/vercel-labs/fx), and Emma drives it over the Agent Client Protocol from [harness.ts](../desktop/main/harness.ts).

## Where it came from

| | |
| --- | --- |
| Upstream | https://github.com/vercel-labs/fx |
| Forked at | `580a0c5da9386317251968c09c1cee69e763487a` |
| Upstream version | 0.0.4 |
| License | Apache-2.0 |
| Binary name | `emma-cli` (upstream ships `fx`) |

[harness/FORK.md](../harness/FORK.md) is the provenance record: what the fork changes, what it deleted, and what it deliberately kept. Read it before touching vendored files.

Apache-2.0 §4 requires three things, and the fork does all three:

- [`harness/LICENSE`](../harness/LICENSE) stays, unmodified.
- [`harness/THIRD_PARTY_NOTICES.md`](../harness/THIRD_PARTY_NOTICES.md) stays — it covers cuelume (MIT, interface sounds) and Unicode data tables.
- Every Apache-2.0 file header and copyright line stays, and `FORK.md` lists the changes.

Renaming and rebranding does not end that obligation. Do not drop those files.

The short version of what changed: the binary name, the model transport (Vercel AI Gateway's language-model v3 protocol becomes OpenAI-compatible Chat Completions), and authentication (all Vercel and ChatGPT OAuth removed; one environment variable instead). fx's agent loop, permission model, hooks, skills, subagents, tools and MCP client are untouched.

## Who owns what

The harness owns the agent loop, tool execution, permission gating, hooks, skills and subagents for one turn. Emma owns the window, the durable Markdown thread, and the answer to every permission question.

That split is why [harness.ts](../desktop/main/harness.ts) is a client and not a second loop. Emma used to run its own loop beside this one; two loops meant every rule was written twice and the second copy drifted. The loop in [agent-loop.ts](../desktop/main/agent-loop.ts) is gone. What is left there is the agent rail, the durable traces, the permission channel, Auto mode's verifier, and four tools whose answers are that file's own records — `threads`, `read_trace`, `agents`, `advisor`.

Emma keeps a few things away from the harness on purpose:

- **The granted folder.** The harness resolves `../` and `~` itself and will mutate anything its policy allows. `callEscapesWorkspace` in [harness.ts](../desktop/main/harness.ts) checks every path-shaped argument against the workspace root — realpath'd, resolved down to the deepest existing ancestor, unresolvable treated as an escape — and an escape is denied outright, in every mode.
- **Permission modes.** All four of Emma's modes map to the harness's `ask`, so every decision comes back over the wire. `harnessModeId` looks like an identity map and is not: routing `acceptEdits` to the harness's `auto` skipped the folder check and handed shell commands to a hardcoded in-harness reviewer model, and `full` to `yolo` kept no floor at all.
- **The model.** Emma's picker is re-applied per turn rather than trusted to persist in harness settings.
- **The context window.** The harness recognises only a handful of model-id prefixes; Emma has the real number from the OpenRouter catalog and sends it.

### It is no longer opt-in

`EMMA_HARNESS=1` is gone. There is no such check anywhere in `desktop/`, `harness/` or `agent/` on this branch — grep it and the only hits are prose: the root `README.md`, `desktop/skills/building-emma/SKILL.md`, [architecture.md](architecture.md), [autoresearch.md](autoresearch.md), and `harness/README.md`. All five are stale on this point.

The harness is the only agent loop. A missing binary is a broken install, not a fallback:

```
Emma could not find its agent at <path>. The install is incomplete —
reinstall Emma, or run npm run build:harness from the repo.
```

## What reaches Emma's tools today

The old gap — "the fork does not yet reach Emma's folder, computer-use, MCP, and knowledge tools" — is closed. Twenty-three of Emma's tools are registered natively in the harness registry, appended to fx's own in [`builtins/tools.zig`](../harness/src/builtins/tools.zig) as `++ emma_tools.all`:

| Group | File | Tools |
| --- | --- | --- |
| Threads and agents | [`emma/threads.zig`](../harness/src/builtins/emma/threads.zig) | `threads`, `context`, `task`, `plan`, `agents`, `read_trace` |
| Knowledge | [`emma/knowledge.zig`](../harness/src/builtins/emma/knowledge.zig) | `save_page`, `artifact`, `workflow`, `visualize`, `autoresearch` |
| System | [`emma/system.zig`](../harness/src/builtins/emma/system.zig) | `cli`, `cli_runs`, `advisor`, `install_mcp`, `computer` |
| Extensions | [`emma/extensions.zig`](../harness/src/builtins/emma/extensions.zig) | `write_tool`, `run_tool`, `mcp_tool`, `write_skill` |
| Name collisions | [`emma/overrides.zig`](../harness/src/builtins/emma/overrides.zig) | `memory`, `look_at_image`, `web_search` |

`overrides.zig` holds the three whose names collide with an fx builtin. `Registry.lookup` returns the first match, so a duplicate name is a bug, not a fallback. `memory` and `web_search` win their names because fx's are wrong here: fx's `memory` is one `~/.fx/memories.json` where Emma's is a directory tree under `<userData>/memories`, and fx's `web_search` is dead on the ACP path (`.web_search_runtime_ready = false`). Two names went the other way — `web_fetch` stays fx's because theirs is wired with an artifact store and progress, and `vision` stays fx's because the gateway looks it up by that exact name and forces it when a model that cannot see images is handed one. Emma's image tool is therefore called `look_at_image`, and `HARNESS_TOOL_NAMES` in [main.ts](../desktop/main/main.ts) maps it back to Emma's internal `vision`.

What Emma does **not** delegate: `read_file`, `list_files`, `ripgrep`, `write_file`, `bash` and `background`. The harness covers those with its own `read_file`, `list_files`, `grep_files`, `write_file` and `terminal`, which enforce their own workspace root.

### Availability is an answer, not an absence

A native tool is registered for the whole process, so Emma cannot hide one by leaving it off a per-turn list. `whyUnavailable` in [main.ts](../desktop/main/main.ts) answers in words the model can read instead:

- `cli` with no connected folder — "Ask the user to connect one."
- `computer` off macOS — "controls this Mac, and this is not a Mac."
- `mcp_tool` with no imported server — "Use install_mcp to add one first."

`runEmmaTool` also re-applies `toolGate(turn.mode, name, disabledTools)` before running anything, because a filtered list is not an enforced one: the harness caches its catalog and the model can guess a name.

## The ACP wire

Newline-delimited JSON-RPC 2.0 over the child's stdio. Emma spawns `emma-cli acp` once per workspace directory with:

- `cwd` set to the workspace. The harness resolves its workspace root from its own cwd at startup and ignores the per-session `cwd`, so one process per workspace is what actually contains a run. `prompt()` refuses a turn whose `cwd` does not match.
- `HOME` set to `<userData>/harness`, a profile of Emma's own, so the harness never reads the user's `~/.fx`.
- `AI_GATEWAY_API_KEY` and `EMMA_PROVIDER_API_KEY` both set from `OPENROUTER_API_KEY` in Emma's environment. Both names, because the fork still reads upstream's while the Vercel vocabulary is being removed.

At most `MAX_HARNESSES = 4` processes are alive at once. Map order is least-recently-used; `reapHarnesses` closes the front of the queue and never one with a call in flight.

Line frames are capped at 8 MiB. A call is abandoned after `MAX_IDLE_MS` — 30 minutes — of **silence**, not wall clock: any inbound message refreshes every pending timer, so a long build streaming the whole time survives, and only a genuinely wedged peer trips it.

### Methods Emma calls

`AcpMethod.parse` in [`acp/server.zig`](../harness/src/acp/server.zig) accepts thirteen:

| Method | What it does |
| --- | --- |
| `initialize` | Once per process. Emma sends `protocolVersion: 1` and `clientCapabilities.fs = {readTextFile: false, writeTextFile: false}`. The harness also reads `terminal` and elicitation capabilities from this. A second call is an error. |
| `session/new` | Takes `cwd` and `mcpServers`, returns `sessionId`, and makes it active. |
| `session/load` | Loads a saved session. |
| `session/resume` | Re-activates a session this process displaced. Emma calls this rather than making a new one, so a thread keeps its history. |
| `session/close` | Flushes usage and drops the active session. |
| `session/list`, `session/remove` | Session store queries. |
| `session/prompt` | Runs one turn. |
| `session/compact` | Folds the session's history. Refused mid-turn — rewriting history a running turn is reading is a data race. |
| `session/set_config_option` | `configId` is one of `model`, `mode`, `context_window`, `context_experiments`. |
| `session/set_mode` | `modeId` from [`builtins/modes.zig`](../harness/src/builtins/modes.zig): `plan`, `ask`, `acceptEdits`, `full`. Mid-turn changes apply to the next prompt. |
| `session/cancel` | Sent as a notification, not a request — cancellation has no reply and must not hang on a wedged peer. |
| `session/steer_child` | Queues a message for one running subagent by `childId`. Deliberately not queued behind the active prompt: the whole point is reaching a child while its parent turn is running. |

`session/list`, `session/remove`, `session/prompt`, `session/compact` and `session/set_config_option` are refused with "Prompt already in progress" while a turn is in flight. The rest run beside it.

### One session at a time

The harness holds exactly one active session. `session/prompt` runs against `state.active_session` and ignores the `sessionId` the call names, and `session/new` swaps it without waiting for a running prompt. So [harness.ts](../desktop/main/harness.ts) tracks the active session itself, resumes a displaced one before prompting its thread again, and serialises turns per process — a turn that starts while another is in flight runs *instead of* it, not beside it.

### What comes back

Notifications on `session/update`, one JSON object per line, written by [`acp/types.zig`](../harness/src/acp/types.zig):

| `sessionUpdate` | Emma does |
| --- | --- |
| `agent_message_chunk` | `onDelta` — the answer, streamed. |
| `agent_thought_chunk` | `onThought` — reasoning, on its own channel. Folding the two together made the harness look like it thought silently then blurted a result. |
| `tool_call` | `onToolCall` — the whole call, arguments included. |
| `tool_call_update` | `onToolCall` — only what changed. Emma merges it over the last full state per `threadId:toolCallId`, or every step reverted to an untitled "other" the moment it progressed. |
| `plan` | `onPlan`. |
| `available_commands_update` | ignored. |
| `session_info_update` | Carries `_meta.fx.contextExperiment` (a fired context lever) or `_meta.fx.modelResponseRecovery` (retry and backoff state, written to the thinking channel so a run waiting out a 503 is not mistaken for a hang). |

Subagents ride the parent's stream. ACP has no nested sessions, so a child tags its updates with `_meta.fx.child` — `{id, title, state}` — and `childTag` fans them back out onto an Emma thread of the child's own. Untagged, a subagent's words land in the parent's durable answer as if the parent said them.

### One prompt turn

1. `session/set_mode`, then `session/set_config_option` for `model`, `context_window` and `context_experiments` if set. Experiments are sent every turn even when everything is off, because the harness holds them per session and a lever switched off in Settings has to be switched off there too.
2. `session/compact` if Emma asked for one last turn. Best effort.
3. `session/prompt` with `prompt` as content blocks. Skills, attached folders, files and knowledge ride as a separate leading text block rather than a prefix on the user's words, so the harness's own transcript keeps them apart.
4. The harness runs the turn on its own thread. Updates stream. Permission requests and Emma-tool calls come back as requests.
5. The response resolves with `{stopReason, usage: {inputTokens, outputTokens}}`.

`usage` on the prompt result is an Emma extension — upstream ACP has no such field — and it is the only place a harness turn's real token counts exist on Emma's side.

Stop reasons, from `StopReason` in [`acp/types.zig`](../harness/src/acp/types.zig): `end_turn`, `cancelled`, `refused`, `max_output_tokens`, `max_model_turns`. `failedTurn` treats `refused` as a failure, and that check matters: the harness reports a provider or auth failure as ordinary assistant text and still resolves the call, so without it the error string is written into the thread as though Emma had said it.

### Permission

`requestAcpPermission` in [`acp/prompt.zig`](../harness/src/acp/prompt.zig) sends a `session/request_permission` request:

```json
{
  "sessionId": "...",
  "toolCall": { "toolCallId": "...", "title": "...", "kind": "...", "status": "pending", "rawInput": { } },
  "options": [
    { "optionId": "allow_once",   "name": "Allow once",             "kind": "allow_once" },
    { "optionId": "allow_always", "name": "Allow for this session", "kind": "allow_always" },
    { "optionId": "reject_once",  "name": "Reject",                 "kind": "reject_once" }
  ]
}
```

The prompt thread blocks on `awaitPermissionDecision`. Emma answers with `{"outcome": {"outcome": "selected", "optionId": "..."}}` or `{"outcome": {"outcome": "cancelled"}}`. `parsePermissionDecision` maps `allow_once` → once, `allow_always` → always, `reject_once` → deny, `cancelled` → deny; **anything it cannot parse is a deny**. At most 32 outbound requests may be pending at once.

Emma's side, in `onPermission` in [main.ts](../desktop/main/main.ts):

1. `context.outsideWorkspace` → deny, with a `blocked: <tool> is outside the connected folder` step in the transcript. Not overridable, because a dialog offering to allow it would be a worse promise than the picker already makes.
2. `full` → allow.
3. `acceptEdits` with `kind === "edit"` → allow. Commands still ask.
4. Otherwise `AgentRuntime.question`, which is where Auto mode's verifier sits.

Options are picked by preferred `kind` in order, never by list position: `find` over a list of kinds returns whichever the harness happened to send first, and one reordering upstream would turn "Allow once" into a session-wide grant. A denial picks `reject_once` so the turn continues with a "no"; cancelling would end the run and lose everything before it. A refused or unanswered question is always a denial.

A permission dialog titled `file_mutation` is retitled with the path — `describePath` reads `path`, `new_path`, `destination`, `old_path`, `source` in that order.

### Emma's own tools: `_emma/callTool`

Emma's tools read and write Electron's durable stores, so the harness never executes one. It advertises the tool, checks the arguments are a JSON object, and hands the raw JSON to the client.

The mechanism, from most recent to oldest:

- **Now:** a native outbound request. [`tools/emma/bridge.zig`](../harness/src/tools/emma/bridge.zig) is one shared implementation behind all twenty-three tools — what differs per tool is only its spec. `callEmmaTool` in [`acp/prompt.zig`](../harness/src/acp/prompt.zig) writes `_emma/callTool` with `{sessionId, toolCallId, name, arguments}` on the same outbound registry permission and elicitation use, then blocks. There is no deadline: connecting a folder or running a thread can legitimately take minutes, so the only way out other than a reply is the user cancelling.
- **Before that:** a localhost MCP server in `desktop/main/bridge.ts` — one HTTP server, modern MCP, one JSON-RPC object in and one out. The harness's only door for a tool it does not ship is MCP, so Emma used that door, and its tools reached the model under the `mcp_emma` server prefix. That file is deleted. The MCP hop cost an HTTP round trip, a bearer token and a second protocol.

Arguments are embedded rather than re-encoded, so the client sees exactly what the model wrote. Emma replies with `{"output": "..."}` and nothing else; a reply shaped any other way is the client's bug, and the model cannot fix it by retrying. A tool that refuses or throws answers with `output` **text**, not a JSON-RPC error — the model recovers from the first and the harness treats the second as the channel being broken. The error path is only for a request that never named a live thread (`-32602 Unknown session or tool`).

Called outside Emma — plain `emma-cli` in a terminal, with no responder — an Emma tool fails with `This tool is only available inside Emma.` as text, so the turn survives.

### Emma's MCP servers

The user's configured MCP servers are read fresh and passed on `session/new` and `session/resume`, in `HarnessMcpServer` shape (stdio or http). `harnessMcpServers` in [capabilities.ts](../desktop/main/capabilities.ts) resolves each command against PATH, because the harness rejects a bare name (`CommandNotAbsolute` in [`acp/mcp_servers.zig`](../harness/src/acp/mcp_servers.zig)), and drops a bad entry rather than losing the whole session — the harness fails all of `session/new` on one.

The harness only takes MCP servers at session creation, so `forgetSession` / `forgetAllSessions` drop a thread's session and let the next turn build a new one. That is what makes a mid-turn `install_mcp` mean anything. Only the forward map is dropped: clearing the reverse routing would silence the rest of the running turn.

## Tool discovery: two tools, then the rest

Every tool in the registry except two is marked `.on_select`. The base advertisement is exactly `search_tools` and `select_tool`; `vision` is `.never` (reachable only by the gateway forcing it by name). Everything else — every file tool, `terminal`, `subagent`, `skill`, all twenty-three Emma tools — costs nothing until the model asks for it.

[`tool_native_dispatch.zig`](../harness/src/core/tooling/tool_native_dispatch.zig) implements the pair, mirroring `mcp_search_tools` / `mcp_select_tool`:

- **`search_tools {query, limit}`** returns names and descriptions only. An input schema here would defeat the entire mechanism. Default limit 8, hard cap 20, `more_available: true` when there are more. Scoring is per query token, case-insensitive substring: 8 points for a hit in the name, 1 in the description, tokens under 3 characters ignored (they are prepositions and match everything). An empty query returns the whole searchable set. It is scored rather than filtered because it used to require *every* token to match, and "list the threads in this workspace" matched nothing at all.
- **`select_tool {name}`** splices one exact schema into the next model step through the same sink MCP selection uses. No preceding search is needed. A denied tool, a `.never` tool and an unknown name all answer `Tool not found: <name>`; an already-advertised one answers "is already available; call it directly."

This is a prompt-cost mechanism, **not** a security boundary. A hidden tool is still registered and still runs under exactly the permission rules it would have had.

## Limits the code enforces

| Limit | Value | Where |
| --- | --- | --- |
| Tool description, to the model | 4 KiB, then `... [truncated]` | `description_max_bytes`, [`gateway_schema.zig`](../harness/src/core/tooling/gateway_schema.zig) |
| Tool result, to the model | 64 KiB default | `default_max_tool_result_bytes`, [`tool_result_limits.zig`](../harness/src/core/tooling/tool_result_limits.zig) |
| Tool output in a `tool_call_update` | 200 bytes, UTF-8 safe | `toolUpdateContentText`, [`acp/prompt.zig`](../harness/src/acp/prompt.zig) |
| Emma tool output over `_emma/callTool` | 64 KiB | `MAX_TOOL_OUTPUT_BYTES`, [harness.ts](../desktop/main/harness.ts) |
| One JSON-RPC line | 8 MiB | `MAX_LINE_BYTES`, [harness.ts](../desktop/main/harness.ts) |
| Tool arguments kept for the transcript | 4096 chars | `rawInput`, [harness.ts](../desktop/main/harness.ts) |
| Pending outbound requests | 32 | `max_pending_outbound`, [`acp/server.zig`](../harness/src/acp/server.zig) |

The description cap was fx's 1024 and is now 4 KiB, matching `MAX_TOOL_DESCRIPTION_BYTES` in [tools.ts](../desktop/main/tools.ts). `cappedDescriptionAlloc` truncates silently, and at 1024 `plan` lost its `update` and `delete` lines and `threads` lost the sentence telling the model when to reach for `task`. A test in [`emma_tools.zig`](../harness/src/builtins/emma_tools.zig) fails the build if any Emma description grows past the cap.

The 200-byte preview is why `unwrapMcpResult` and `cutMcpText` exist in [harness.ts](../desktop/main/harness.ts): an MCP result arrives wrapped in `{"server":…,"tool":…,"result":{"content":[…]}}` and the envelope header eats about 110 of the 200 bytes, so the JSON is usually unparseable and the transcript showed a brace-and-quote fragment. Emma's native tools answer as plain text and get all 200.

Binary or non-UTF-8 output is replaced with `binary or non-utf8 tool output omitted`. A permission-denied result is sent whole, not previewed.

## Standing instructions

Emma does not send its system prompt over the wire. `writeHarnessPrompt` in [system-prompt.ts](../desktop/main/system-prompt.ts) writes it to `<userData>/harness/.fx/AGENTS.md`, which [`builtins/context.zig`](../harness/src/builtins/context.zig) loads as `<global-rules>` beside its own built-in prompt (`$HOME/.fx/AGENTS.md`, joined at line 312). The block is the user's Settings prompt, the connections block, and any kept Agent-page improvement — written per turn, but only when it changed.

The one thing that cannot go in that file is the A/B arm a turn landed on, which is a coin flip per turn. That rides the turn's skill context instead.

Skills work the same way: `mirrorSkillsToHarness` in [capabilities.ts](../desktop/main/capabilities.ts) copies every skill Emma can see into `<harnessHome>/.fx/skills`. Copied, not symlinked — the harness drops symlinked skill directories. Disabled skills are filtered out here because the harness has no notion of one being off.

## `harness/src/` map

| Directory | Owns |
| --- | --- |
| `acp/` | The JSON-RPC server. `server.zig` (dispatch, session state, outbound registry), `prompt.zig` (one turn, 4600 lines), `sessions.zig` (new/load/resume/list/remove), `types.zig` (update writers, stop reasons), `jsonrpc.zig` (framing), `mcp_servers.zig` (parsing `mcpServers`). |
| `builtins/` | The registries. `tools.zig` (the tool table and `advertisement_set`), `emma_tools.zig` + `emma/` (Emma's twenty-three), `modes.zig`, `skills.zig`, `hooks.zig`, `mcp.zig`, `commands.zig`, `context.zig` (the system prompt and `AGENTS.md`), `providers.zig`, `gateway.zig`. |
| `core/` | Everything with state. `agent/` (the loop: `runtime/orchestrator.zig`, `runtime/gateway_step.zig`, `runtime/context_experiments.zig`), `tooling/` (dispatch, admission, advertisement, result limits, MCP and native discovery), `permissions/`, `session/`, `mcp/`, `skills/`, `hooks/`, `subagent/`, `config/`, `modes/`, `gateway/`, `cli/` (`acp_runner.zig`, `cli_ask.zig`, `cli_surface.zig`, `doctor_runtime.zig`), `workspace/`, `background/`, `terminal/`, `execution/`, `auth/`, `output/`, `shared/`, plus smaller ones. |
| `gateway/` | Provider transport only. `emma_openai.zig` is the OpenAI-compatible Chat Completions client and holds `default_chat_url` and `chat_url_env`; also `client.zig`, `web_search.zig`, `generation_usage.zig`, and the JS-host stream and catalog providers for the WASM build. |
| `tools/` | Tool implementations: `filesystem/`, `shell/`, `web/`, `terminal/`, `agent/` (`subagent.zig`, `vision.zig`, `ask_user_question.zig`), `skills/`, `session/`, `memory/`, and `emma/bridge.zig`. Specs live in `builtins/tools.zig`, not here. |
| `ui/` | The terminal front end, and no product state: `render_engine/`, `transcript/`, `footer/`, `input/`, `terminal/`, `assistant/`, `subagent/`. Emma never sees any of it. |

Top level: `main.zig` is the composition root — no leaf feature logic. `wasm_core_main.zig`, `wasm_term_main.zig` and `napi_core_main.zig` are the SDK entry points.

## Building it

Zig 0.16.0 or later.

```bash
npm --prefix desktop run build:harness   # the one script for emma-cli
(cd harness && zig build)                # the same thing, directly
(cd harness && zig build test)           # the Zig unit tests
```

`build:harness` is just `(cd ../harness && zig build)`. Two other scripts reach it: `build:host` chains it after `emma-host` and `emma-agent`, and `package:mac` runs `zig build -Doptimize=ReleaseSafe` in `harness/` inline. Nothing else builds `emma-cli` — `npm start`, `npm run build` and `npm run check` do not, so a stale binary survives all three.

A checkout uses `harness/zig-out/bin/emma-cli`, from `DEV_BINARIES` in [main.ts](../desktop/main/main.ts).

## Testing against a fake provider

[`harness/scripts/mock-openai.mjs`](../harness/scripts/mock-openai.mjs) is a stand-in Chat Completions endpoint, so the transport can be proven end to end with no credential and no network. It asserts the request shape — `messages[]` present, AI-SDK `prompt` and `toolChoice` absent, `model` a non-empty string, `tools[]` non-empty — then drives one real round trip: turn one asks for a `bash` call, turn two answers with text. Any mismatch is a non-zero exit.

```bash
node harness/scripts/mock-openai.mjs 8099 &
EMMA_PROVIDER_API_KEY=anything \
EMMA_PROVIDER_CHAT_URL=http://127.0.0.1:8099/v1/chat/completions \
  harness/zig-out/bin/emma-cli acp
```

`EMMA_PROVIDER_CHAT_URL` is read by `chatUrl()` in [`gateway/emma_openai.zig`](../harness/src/gateway/emma_openai.zig). Empty or unset falls back to `default_chat_url`, `https://openrouter.ai/api/v1/chat/completions`. The same variable points at a local llama-server.

Two other credential-adjacent variables: `EMMA_PROVIDER_API_KEY` is the only credential source there is (there is no sign-in surface), and `EMMA_OPENROUTER_ZDR`, set to any non-empty value, adds OpenRouter's `data_collection: "deny"` and `zdr: true` routing flags. It stays opt-in because most free endpoints offer neither and would fail the turn. Emma toggles it on `process.env` from Settings, in [main.ts](../desktop/main/main.ts).

### The larger suites

- [`harness/tests/e2e/`](../harness/tests/e2e) — TypeScript, run with `bun test` from that directory (`bun test acp.test.ts`, `test:tui`, `test:cli`). They spawn the built binary with a fake key like `EMMA_PROVIDER_API_KEY: "fake-mcp-stdio-key"` and never reach a provider. Every root `*.test.ts` must be classified in `harness/scripts/pgso/corpus.json` as training, verification-only, or an intentional exclusion; CI rejects a missing or stale entry.
- [`harness/tests/evals/`](../harness/tests/evals) — model-backed. These need a real `EMMA_PROVIDER_API_KEY` and cost money.
- [`harness/benchmarks/`](../harness/benchmarks) — `startup.sh`, `file_index_bench.zig`, `activity_progress.zig`, `approval_review.zig`, with `check_budgets.py` and `summarize.py` over `benchmarks/results`.

## `harness/sdk/`

Upstream's `libfx` npm package — the harness embedded in a JavaScript host, not something Emma uses. It ships native Node addons for Linux and macOS on x64 and arm64, `fx-core.wasm` for headless agents, `fx-term.wasm` for the interactive terminal, and a dependency-free JS host layer. Exports are `createFxAgent()`, `createFxTerminal()`, `supportsJspi()`, `xtermAdapter()` and `encodeXtermKeyEvent()`.

It needs Node 20+, and Chrome or Edge 137+ with JSPI for the browser path. The WebAssembly SDK is marked experimental. See [`harness/sdk/README.md`](../harness/sdk/README.md) and [`harness/sdk/NAPI.md`](../harness/sdk/NAPI.md). Nothing in `desktop/` imports it.

## Where it lives in a packaged app

`package:mac` passes `--extra-resource=../harness/zig-out/bin/emma-cli`, so a built app has it at:

```
Emma.app/Contents/Resources/emma-cli
```

`binary("emma-cli")` in [main.ts](../desktop/main/main.ts) resolves to `process.resourcesPath` when packaged and `harness/zig-out/bin/emma-cli` in a checkout. (`harness/README.md` says the packaged app does not bundle this binary. It does.)

## See also

- [architecture.md](architecture.md) — how the harness sits beside `emma-host` and the renderer
- [cli.md](cli.md) — the `emma` terminal command, which is a different program
- [permissions.md](permissions.md) — the modes the harness maps onto
- [tools.md](tools.md) — what each of Emma's tools does
- [development.md](development.md) — building and testing the rest of the repo
- [plugins.md](plugins.md) — the other extension surface
- [autoresearch.md](autoresearch.md) — one of the tools the harness now reaches
- [troubleshooting.md](troubleshooting.md) — when a run will not start
