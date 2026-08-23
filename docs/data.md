# Data and environment

Every environment variable Emma reads, every file it writes, and what each file
looks like. If you want to know where something went, it is on this page.

## Two data roots

Emma keeps its data in two places, and they are not the same directory.

| Root | Default | Written by | Holds |
| --- | --- | --- | --- |
| **Rust data root** | `~/Library/Application Support/Emma` | `emma-host` | `threads/`, `knowledge/`, `scheduled/`, `research/` |
| **Electron userData** | `~/Library/Application Support/emma-desktop` | Electron main | everything else |

The Rust root moves with `EMMA_DATA_DIR`. The Electron root comes from
`app.getPath("userData")`, which Electron derives from `"name": "emma-desktop"`
in [`desktop/package.json`](../desktop/package.json) — there is no override.

Both get deleted when you reset ([`main.ts:2945`](../desktop/main/main.ts)):

```js
for (const root of [process.env.EMMA_DATA_DIR || path.join(homedir(), "Library/Application Support/Emma"), app.getPath("userData")])
  rmSync(root, { recursive: true, force: true });
```

## Environment variables

### Emma's own

| Variable | Read by | What it does | Default |
| --- | --- | --- | --- |
| `EMMA_DATA_DIR` | Rust host, Electron main | Root for `threads/`, `knowledge/`, `scheduled/`, `research/`. | `$HOME/Library/Application Support/Emma`. With `HOME` also unset, the host errors: `HOME is unset; set EMMA_DATA_DIR to a writable folder` |
| `EMMA_KNOWLEDGE_DIR` | Rust host, Electron main | Where the plain-Markdown mirror is written. **An empty string turns the mirror off.** Electron sets it from `knowledge-root.json` before every host spawn, so the folder you picked at first launch wins; the env var only applies when nothing was picked. | `$HOME/Documents/Emma Knowledge` |
| `OPENROUTER_API_KEY` | Electron main | Emma's one shipped remote route. Also the default `credentialEnv` for the verifier, tagger, advisor, vision and knowledge-page models. Decrypted from the credential store into `process.env` on every host restart, and read back out of it whenever main makes a provider call. | unset |
| `EMMA_PROVIDER_API_KEY` | `emma-cli` | The **only** credential source the forked harness has — no OAuth, no login. Whitespace-only counts as absent. Electron passes it when spawning `emma-cli`. | unset → catalog runs public-only |
| `EMMA_PROVIDER_CHAT_URL` | `emma-cli` | Full chat-completions URL override for the harness. Empty is treated as unset. | `https://openrouter.ai/api/v1/chat/completions` |
| `EMMA_OPENROUTER_ZDR` | `emma-cli` | Presence-checked, not parsed. Adds zero-data-retention routing to OpenRouter requests. Opt-in on purpose: most free models have no ZDR endpoint, so forcing it turns them into 404s. Toggled from Settings, which sets it in Electron's own environment and closes the idle harnesses so the next turn is spawned with it. | unset → off |
| `EMMA_DEV_SERVER_URL` | Electron main | Two jobs: windows `loadURL` the dev server instead of `loadFile`, and the origin joins the trusted-sender set that gates every privileged IPC handler. Set by `scripts/dev.mjs`. | unset → `file://` only |
| `EMMA_CDP_PORT` | `scripts/drive.mjs` | DevTools Protocol port to attach to. | `9222` |
| `EMMA_UPGRADE_BASE_URL` | `emma-cli` | Self-update CDN base. Emma ships `emma-cli` inside the bundle, so this is discarded unless it is loopback HTTP with an explicit port and no path, query or fragment — meaning self-update is off in practice. | unset → disabled |
| `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY` | Electron main | Bearer tokens for the `web_search` tool. These are the names Settings pre-fills when you pick Brave, Tavily or Exa. `fourget` and `searxng` are keyless. | unset; default provider is `fourget` |
| `AI_GATEWAY_API_KEY` | **nobody** | Written by `harness.ts` beside `EMMA_PROVIDER_API_KEY`. Nothing in `harness/src` reads it. See [Known dead ends](#known-dead-ends). | — |

`emma-host` reads exactly two of these, `EMMA_DATA_DIR` and
`EMMA_KNOWLEDGE_DIR`. It makes no provider call and spawns no child, so nothing
else in this table reaches it.

### Harness runtime — `FX_*`

`emma-cli` is a fork of `vercel-labs/fx`, and [`FORK.md`](../harness/FORK.md)
says the `FX_*` names were kept deliberately: they read as fx branding rather
than Vercel's, and users set them. All of these are read through
`harness/src/core/shared/io.zig`.

| Variable | What it does | Default |
| --- | --- | --- |
| `FX_MODEL` | Model id. Trimmed; empty is ignored. When it wins, `/doctor` reports the source as `process_override`. | settings, else `nvidia/nemotron-3-super-120b-a12b:free` |
| `FX_PERMISSION_MODE` | Permission mode. An unrecognized value falls back silently. | settings, else `auto` |
| `FX_MAX_AGENT_STEPS` | Step ceiling, above settings and compiled defaults. **`0` means unbounded**, not zero steps. Unparseable values fall through. | `0` |
| `FX_GATEWAY_BASE_URL` | Gateway base URL. The base carries the bearer token, so a non-loopback-HTTP override is logged and discarded. | `https://openrouter.ai/api` |
| `FX_WEB_SEARCH_BACKEND` | `perplexity_search` or `parallel_search`. Any other non-empty value is an error, not a fallback. | first of the default order |
| `FX_AUTO_UPGRADE` | Off-switch only: `0` or `false` disables. No value enables it. | unset |
| `FX_DISABLE_KEYCHAIN` | `1` or `true` turns off macOS Keychain storage for MCP OAuth credentials. | unset |
| `FX_SKILL_SYMLINK_AUTHORITIES` | Colon-separated absolute roots trusted as skill symlink targets. Relative entries and anything containing `..` are silently skipped. | empty |
| `FX_SOUND` | `max`, or `0`/`false`/`off`, or any other non-empty value for on. | unset → settings decide |
| `FX_THEME` | `light` or `dark`. Anything else falls through to the OSC-11 probe, then `COLORFGBG`, then dark. | unset |
| `FX_SYNC_UPDATES` | Forces terminal synchronized updates (DECSET 2026) on or off. | unset → `FLASH_SYNC_UPDATES`, then `TERM` sniffing |
| `FLASH_SYNC_UPDATES` | The pre-rename name. Consulted only when `FX_SYNC_UPDATES` is entirely unset. | unset |
| `FX_RECORD` | Path for a `.fxtape` recording. Empty plus `--record` auto-names `fx-record-{ms}-{hex}.fxtape`. | `""` |
| `FX_RECORD_INPUT` | `1`/`true`/`on` also records raw keystrokes into the tape. | unset |
| `FX_TRACE` | `1`/`true`/`yes`/`on` turns on tracing. | unset |
| `FX_TRACE_LOG` | Trace log path. **Relative paths join the workspace root.** Empty is an error. | `profile_paths.traceLogPath` |
| `FX_TRACE_STDERR` | Also mirror traces to stderr. | unset |
| `FX_TRACE_SCOPES` | Comma-separated scope allowlist, exact match per part. Scopes in use: `input`, `permission`, `stream`, `herdr`, `keychain`, `ui_observer`. | all |
| `FX_UI_OBSERVE_DIR` | Where the UI observer writes. **Must be absolute** — a relative path disables it. | unset |
| `FX_HERDR` | Off-switch only (`0`/`false`). Enabling requires **both** `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` non-empty. | disabled |
| `HERDR_SOCKET_PATH`, `HERDR_PANE_ID` | The herdr hook's socket and pane id. | unset |
| `FX_TERMINAL_HOST_PROTOCOL_MIN`, `_CURRENT`, `_CAPABILITIES`, `FX_TERMINAL_HOST_IDLE_MS` | Terminal host protocol negotiation. Unlike most vars here, **a parse failure is an error**, and an idle grace of `0` is rejected. | compiled contract values |
| `FX_BENCH` | With zero CLI args, takes a benchmark path instead of the TUI. | unset |

### Harness test hooks

Present in shipped code but only meaningful to the E2E suite. Nothing here has
an effect unless a test sets it.

| Group | Variables |
| --- | --- |
| Gateway redirection | `FX_E2E_GATEWAY_CHAT_URL`, `FX_E2E_GATEWAY_MODELS_URL`, `FX_E2E_GATEWAY_CREDITS_URL` |
| ACP barriers | `FX_E2E_ACP_PROMPT_TERMINAL_READY`, `FX_E2E_ACP_PROMPT_REAP_READY`, `FX_E2E_ACP_PROMPT_RELEASE`, `FX_E2E_SESSION_BOUNDARY`, `FX_E2E_SESSION_BOUNDARY_READY` |
| Tripwires | `FX_E2E_FAIL_ON_DURABLE_MUTATION` (exactly `1`; exits 86 the moment any durable write is attempted, proving a test never touched the real profile) |
| MCP | `FX_E2E_MCP_AUTH_AUTOMATE` (`1`/`true`, and **only ever for a loopback endpoint** — it cannot auto-approve a remote OAuth flow) |
| Terminal fault injection | 40 variables named `FX_TERMINAL_TEST_*`, `FX_TERMINAL_AUTHORITY_*`, `FX_TERMINAL_CAPABILITY_FIXTURE`, `FX_TERMINAL_OUTCOME_FIXTURE`, `FX_TERMINAL_COMPATIBILITY_EVIDENCE`. Each names a failure or delay point in `core/terminal/`. All default to no injection. |
| Stream fixtures | `FX_TEST_C04_STREAM_ANSI_OSC8_FIXTURE` |
| Test-only, compile-gated | `FX_TEST_PRODUCT_EXE` — behind `builtin.is_test`, never read in a release binary |

A further set — `EVAL_MODEL`, `FX_AB_*`, `FX_API_KEY`, `FX_APPROVAL_PROFILE_*`,
`FX_CTRL_O_*`, `FX_E2E_DISABLE_DOTENV`, `FX_E2E_REAL_API`, `FX_FILE_PICKER_*`,
`FX_LIFECYCLE_*`, `FX_LIVE_RENDER_STRESS`, `FX_MCP_*`, `FX_RENDER_LAB_*`,
`FX_REQUIRE_TMUX`, `FX_RESUME_*`, `FX_S11_EVIDENCE_DIR`, `FX_TEST_BIN`,
`FX_TUI_RESIZE_KEEP_ARTIFACTS`, `FX_UI_OBSERVER_ARTIFACT_DIR`, `FX_WASM_TRACE`,
`FX_WASI_TRACE`, `FX_WEB_FETCH_LIVE`, `FX_WORKSPACE_ACCESS_LIVE_MODEL`,
`LIBFX_STALE_TRACE_CHILD`, `CHROME_PATH`, `JSON_SCHEMA_TEST_SUITE`,
`MCP_CONFORMANCE_*` — lives entirely in `harness/tests/` and `harness/sdk/` and
never appears in a shipped binary.

### OS variables Emma reads

| Variable | Read by | What it does |
| --- | --- | --- |
| `HOME` | all three components | The base for nearly every path. **Electron overrides it for the harness**: `emma-cli` is spawned with `HOME` set to `<userData>/harness`, so it never reads the user's real `~/.fx`. Failure modes vary by call site — `error.HomeNotSet`, `null`, or `memory unavailable: HOME not set`. |
| `PATH` | Electron main, `emma-cli` | Resolving MCP server commands (the harness refuses a bare name) and the environment every CLI child gets. `desktop/main/cli.ts` reads the *login shell's* `$PATH` via `bash -lc` first, so `~/.local/bin` is found. |
| `SHELL` | `emma-cli` | Project context block; falls back to `COMSPEC`. |
| `TMPDIR` | `emma-cli`, Rust tests | Scratch paths. Every Zig call site defaults to the literal `/tmp`. |
| `USER` | `emma-cli` | Keychain account name. Authoritative when set — it is the only way to target a non-login account. Absent, the OS account name is used; only if that fails is it an error. |
| `TERM`, `TERM_PROGRAM`, `COLORTERM`, `COLORFGBG`, `COLUMNS`, `NO_COLOR` | `emma-cli` | Terminal capability and theme detection. `TERM=dumb` forces plain help. `COLUMNS` is only consulted when stdout is not a terminal. |
| `TMUX`, `TMUX_PANE` | `emma-cli` | Presence gates the tmux-passthrough variant of every escape sequence. `TMUX_PANE` is only read once `TMUX` is confirmed. |
| `LANG` | `emma-cli` | Printed in `/debug`. Nothing else. |
| `COMSPEC`, `USERPROFILE` | `emma-cli` | Windows fallbacks. Dead on macOS. |
| `HOMEBREW_NO_AUTO_UPDATE`, `HOMEBREW_NO_ENV_HINTS` | — | **Written, never read.** Both forced to `"1"` in the `bash -lc` probe environment so `command -v` detection isn't slowed by Homebrew chatter. |

There are **no `XDG_*` variables**. Every config and state path is built from
`HOME` directly. `NODE_ENV` is never read. The `website/` build reads nothing —
no `process.env`, no `VITE_*`.

### Known dead ends

Two findings from the sweep, listed so nobody chases them:

1. **`AI_GATEWAY_API_KEY` is a dead write.** [`harness.ts:267`](../desktop/main/harness.ts) sets it alongside `EMMA_PROVIDER_API_KEY`, and the comment above it says the fork still reads upstream's name. It does not — `harness/src` has zero read sites. The line puts a second copy of a live credential in the child environment for no consumer.
2. **`FX_SKIP_ONBOARDING` and `FX_GATEWAY_CHAT_URL` have no readers.** The first is set by three tests; the second sits in a `MIRRORED_ENV_KEYS` list. Both are fx leftovers the de-Vercel pass missed.

## On disk

### Rust data root — `~/Library/Application Support/Emma`

| Path | What it is |
| --- | --- |
| `threads/<id>.md` | One thread. Front matter plus `## Message N` and `## Trace N` blocks. |
| `knowledge/<id>.md` | One knowledge page. |
| `knowledge/bases/base-<id>.md` | One knowledge base: its name, categories, page count. |
| `knowledge/versions/<pageId>/` | Prior versions of a page, for `listPageVersions` and `restorePageVersion`. |
| `knowledge/assets/` | Images and files a page cites. |
| `scheduled/job-<id>.md` | One scheduled job: cron line, prompt, workflow nodes, last run, last thread. |
| `research/` | Autoresearch job records and per-iteration history. |

Ids look like `1787453493-cbe6-18ce4f7b7b4713c8-0` — seconds, a short random
tag, a monotonic component, and a counter. Every write is atomic: temp file,
then rename.

### Electron userData — `~/Library/Application Support/emma-desktop`

| Path | What it is |
| --- | --- |
| `artifacts/<id>/` | One artifact per directory: `meta.json` plus `content.<ext>`. The extension follows the kind — `markdown`→`md`, `code`→`txt`, `html`→`html`, `app`→`html`, `svg`→`svg`, `mermaid`→`mmd`, `react`→`jsx`. An `app` artifact may also hold `data.sqlite`. |
| `plans/<id>.md` | One plan. The Markdown file **is** the record — no sidecar, no database. Ids are lowercase letters, digits and dashes. |
| `skills/<slug>/SKILL.md` | Skills, both the seven bundled ones and anything the agent wrote or you imported. |
| `tools/<slug>/run` | An Emma-authored tool. Mode `0700`, must start with `#!`. |
| `tools/<slug>/about.txt` | That tool's description, mode `0600`. |
| `memories/` | The memory tool's root. The model addresses it as `/memories/...`; that prefix is a fiction mapped onto this directory. 256 KiB per file, 256 files. |
| `workspaces/<threadId>/` | A thread's scratch directory — the working directory the harness gets. |
| `attachments/<uuid>-<name>` | Files dropped or pasted into the composer. Files picked in the native dialog are read where they already are and never copied. |
| `plugins/<id>/plugin.json` | A UI plugin manifest: `id`, `name`, semver `version`, `uiStylesheet`. |
| `plugins/<id>/<name>.css` | Its stylesheet. Capped at 128 KiB, rejected if it contains `@import` or `url(`. |
| `credentials.json` | The encrypted credential store. Mode `0600` in a `0700` directory. |
| `folders.json` | Granted folders: `id`, `path`, `name`. |
| `knowledge-root.json` | Where you chose to keep the knowledge mirror: `{"path": "<abs>"}`. Mode `0600`. |
| `mcp.json` | Installed MCP servers, written as `{ "mcpServers": { … } }`. Mode `0600`. |
| `imports.json` | What was imported from other agent tools at first launch. |
| `installed-plugins.json` | The plugins installed from the Plugins page: id, marketplace, version, the skill and MCP paths each one contributes, and any ChatGPT-hosted app ids from its `.app.json`. Deliberately separate from `imports.json`, which is rewritten wholesale from the import selection. |
| `marketplaces/sources.json` | The plugin marketplaces you added: id, origin, ref, sparse paths, and whether it is a local folder. Mode `0600`. |
| `marketplaces/<name>/` | A Git marketplace's shallow checkout. A local marketplace is read where it sits and nothing is copied here. |
| `marketplaces/.remote/<marketplace>/<plugin>/` | A plugin whose marketplace entry points somewhere else: cloned there on install for a Git source, or unpacked there under `package/` from `npm pack` for an npm source. Replaced wholesale on reinstall. |
| `marketplaces/emma/` | The marketplace Emma writes into: `.agents/plugins/marketplace.json` plus `plugins/<name>/` for each plugin `write_plugin` made. |
| `plugin-hooks.json` | Which plugin lifecycle hooks you reviewed, as a hash of each trusted definition. Nothing runs without a match, so editing a hook on disk turns it off. Forgotten when the plugin or its marketplace is removed. |
| `plugin-data/<marketplace>/<plugin>/` | `PLUGIN_DATA` — the one directory a trusted hook is handed to write in. Created `0700` the first time that plugin's hooks run. Emma never reads it. |
| `openrouter-catalog.json` | The cached model catalog. |
| `harness/` | `emma-cli`'s entire `HOME`. See below. |

Chromium adds its own files to the same directory — `Cache`, `Code Cache`,
`Cookies`, `Local Storage`, `Session Storage`, `Preferences`, `GPUCache`,
`blob_storage`, `SingletonLock` and friends. Emma does not write those.

**Renderer settings are not a file in this list.** They live in the renderer's
`localStorage` (inside `Local Storage/`) under these keys:

| Key | Holds |
| --- | --- |
| `emma.settings.v1` | The whole `UserSettings` object |
| `emma.layout.v2` | Pane layout |
| `emma.importsSeen.v1` | First-launch import dialog dismissed |
| `emma.setupSeen.v1` | Setup walkthrough dismissed |
| `emma.freeModelsOnly.v1` | The free-models filter |
| `emma.overlayDraft.v1` | Unsent Quick Ask text |
| `emma.contextPage.v1` | The pinned context page |

### The harness home — `<userData>/harness`

Electron spawns `emma-cli` with `HOME` pointed here, so the harness keeps its
whole profile inside Emma's data and never touches your real `~/.fx`.

| Path | What it is |
| --- | --- |
| `.fx/AGENTS.md` | Instructions Emma writes for the harness — currently the connected third-party CLIs and how to call them. |
| `.fx/skills/<slug>/SKILL.md` | A mirror of every skill Emma can see — her own, imported ones, and installed plugins' — minus anything you disabled. Rewritten on every capability change; a slug the mirror no longer covers is deleted, so uninstalling takes a skill away rather than leaving it advertised. |
| `.fx/sessions/<id>/` | One harness session: `session.json`, `events.jsonl`, `checkpoint.json`, `authority.json`, `usage-v2.json`, `commit.*.json`, lock files, `artifacts/`, `subagent/`. |
| `.fx/sessions/index.pending` | The session index. |
| `.fx/usage.jsonl` | Append-only usage records, one JSON object per line. |
| `.fx/usage.lock`, `.fx/usage-recovery/` | Crash recovery for that log. |
| `.fx/terminal-host/host.lock` | The terminal host's lock. |
| `.codex/config.toml` | Per-project trust levels and tool switches. |

### The Markdown mirror

Every knowledge page is also written as plain Markdown to
`~/Documents/Emma Knowledge`, so Obsidian, Spotlight and every other Mac app can
read it. See [knowledge.md](knowledge.md).

## File formats

### Thread — `threads/<id>.md`

```markdown
---
emma-thread-format: 11
id: "1787453493-cbe6-18ce4f7b7b4713c8-0"
title: "New thread"
parent-thread-id: ""
kind: "main"
scheduled-job-id: ""
knowledge-base-id: "default"
source-knowledge-base-count: 1
source-0-id: "default"
created-at: "2026-08-23T02:51:33Z"
updated-at: "2026-08-23T02:51:33Z"
archived-at: ""
message-count: 0
trace-count: 0
---
```

Messages follow as `## Message N` blocks carrying `Role:`, `Time:`,
`Generation: present|none`, and — when a model produced it — `Model:`,
`Input-Tokens:`, `Output-Tokens:`, `Duration-Milliseconds:`, then the quoted
content. Traces follow as `## Trace N`.

### Knowledge page — `knowledge/<id>.md`

```markdown
---
emma-format: 4
id: "1787233696-46a3-18cd8793d187e790-0"
title: "Explicit knowledge capture"
category: "general"
knowledge-base-id: "base-1787233691-46a3-18cd8792bd056bb8-0"
added-at: "2026-08-20T13:48:16Z"
analyzed-at: "2026-08-20T13:48:16Z"
model: "local-fallback"
input-tokens: 48
output-tokens: 43
subagent-count: 0
source-application: "Emma"
source-url: null
source-thread-id: "1787233580-42ce-18cd8778d0049730-0"
cited-source-count: 0
---

## Captured context

"…"

## Analysis summary

"…"

## Analysis

"…"
```

Cited sources appear as numbered `cited-N-title` / `cited-N-url` pairs.
Artifacts appear as `artifact-count` plus `artifact-N-*` keys, with the body in
an `## Artifact document` section.

### Mirrored page — `~/Documents/Emma Knowledge/<slug>--<id>.md`

Different, simpler front matter. This one is meant for other apps.

```markdown
---
title: "Ling-3.0-flash tokenizer config"
category: "research"
source: "https://huggingface.co/inclusionAI/Ling-3.0-flash"
application: null
saved: "2026-08-22T02:56:46Z"
emma-page: "1787367406-e4de-18ce012fd032ea50-0"
---

# Ling-3.0-flash tokenizer config

…body…
```

### Scheduled job — `scheduled/job-<id>.md`

```markdown
---
emma-scheduled-job-format: 3
id: "job-1787433053-8631-18ce3ce44bf11370-0"
title: "Daily AI News append"
schedule: "0 14 * * *"
prompt: "Fetch today's top 10 artificial-intelligence news stories…"
nodes: ""
outputs: "{\"last\":\"…\"}"
created-at: "2026-08-22T21:10:53Z"
next-run-at: "2026-08-23T14:00:00Z"
last-run-at: "2026-08-23T02:23:45Z"
last-thread-id: "1787451825-62e0-18ce4df6fbd5e838-0"
permission-mode: "full"
enabled: true
source-domain-count: 0
---
```

`nodes` is empty for a plain prompt job and holds the serialized graph for a
workflow. `outputs` carries the last run's result.

### Plan — `plans/<id>.md`

The file is the plan. `parsePlan(renderPlan(plan))` gives the plan back.

```markdown
# Ship the export button

thread: 1787453493-cbe6-18ce4f7b7b4713c8-0

Add a one-click export to the artifact pane.

## design · Pick the file format `done`
needs: —

CSV, because every spreadsheet opens it.

- [x] Check what the pane already knows
- [x] Confirm CSV over JSON

**Result:** CSV, comma-separated, header row.

## build · Wire the button `running`
needs: design

- [ ] Add the button
- [ ] Handle the empty case
```

A step header is `## <id> · <title>` plus the status in backticks — one of
`todo`, `running`, `done`, `failed`. Under it comes a `needs:` line (`—` when it
waits on nothing), an optional brief, task checkboxes, and an optional
`**Result:**`. The `needs:` edges make the graph, and the graph makes the waves.

### Artifact — `artifacts/<id>/meta.json`

```json
{
  "id": "daily-ai-news-tracker",
  "title": "Daily AI News Tracker",
  "kind": "html",
  "language": "",
  "createdAt": "2026-08-22T21:10:39.819Z",
  "updatedAt": "2026-08-23T02:35:04.059Z",
  "version": 3,
  "sourceThreadId": "1787451825-62e0-18ce4df6fbd5e838-0"
}
```

`content.html` sits beside it. `version` increments on every rewrite.

### Settings — `localStorage["emma.settings.v1"]`

Validated by `validateSettings` in
[`settings.ts`](../desktop/shared/settings.ts) on both read and write. Abridged:

```json
{
  "selectedModel": "fallback",
  "favoriteModels": ["fallback"],
  "defaultPermissionMode": "ask",
  "quickActions": ["Summarize this", "What changed?", "Draft a reply"],
  "notchCommandsEnabled": true,
  "notchGap": 180,
  "notchModel": "",
  "notchConcurrency": "separate",
  "cursorOrbsEnabled": false,
  "cursorOrbs": [],
  "transcriptionEnabled": false,
  "transcriptionEngine": "apple",
  "transcriptionEndpoint": "",
  "transcriptionModel": "",
  "voiceHoldMs": 250,
  "voiceCleanup": false,
  "verifier": { "model": "liquid/lfm-2.5-2.6b:free" },
  "tagger": {},
  "tools": { "webSearch": { "provider": "fourget", "credentialEnv": "" } },
  "harnessExperiments": {},
  "localModels": [],
  "connections": [],
  "contextPages": [],
  "keybinds": {},
  "requireZeroRetention": false,
  "systemPrompt": "",
  "interfaceFont": "departure",
  "agentFont": "inter",
  "thinkingLevel": ""
}
```

Ceilings: `quickActions` is exactly 3, `favoriteModels` at most 6, `notchGap`
between 120 and 260, `systemPrompt` at most 4096 characters, secrets at most
512, connections at most 32, cursor orbs at most 8.

### `mcp.json`

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "/opt/homebrew/bin/obsidian-mcp",
      "args": ["--vault", "/Users/you/Notes"],
      "env": {}
    }
  }
}
```

Written whole, atomically, mode `0600`, and re-parsed before the rename to
prove it is valid. Reading is more forgiving than writing: JSON, JSONC with
trailing commas, and TOML all parse, and the root key may be `mcpServers`,
`mcp_servers`, `servers` or `mcp`. Bare command names are refused — the harness
needs an absolute path, so Emma resolves it against `PATH` first.

### `imports.json`

```json
{
  "version": 1,
  "importedAt": "2026-08-20T13:48:16.402Z",
  "sources": [
    {
      "id": "cursor",
      "skillRoots": ["/Users/you/.cursor/skills"],
      "mcpFiles": ["/Users/you/.cursor/mcp.json"]
    }
  ]
}
```

Only paths that exist at import time are recorded.

### `folders.json`

```json
[
  {
    "id": "99f8eb31-c6af-48d2-a9ef-ed2533396ebf",
    "path": "/Users/you/Documents/emma",
    "name": "emma"
  }
]
```

The renderer only ever names a grant by `id`, and every read is re-checked
against the grant's real path before a file is opened.

### `credentials.json`

```json
{
  "OPENROUTER_API_KEY": "<base64 of safeStorage.encryptString>"
}
```

Keys are variable names; values are base64 of Electron `safeStorage` ciphertext,
which on macOS is bound to the login Keychain. Mode `0600` in a `0700`
directory, written atomically. Emma refuses to save at all when
`safeStorage.isEncryptionAvailable()` is false. On host start the store
decrypts into `process.env` and deletes any name it previously set but no longer
holds.

### `openrouter-catalog.json`

```json
{
  "fetchedAt": "2026-08-23T03:14:43.985Z",
  "models": [
    {
      "id": "aion-labs/aion-2.0",
      "name": "AionLabs: Aion-2.0",
      "contextLength": 131072,
      "inputModalities": [],
      "reasoningEfforts": [],
      "reasoningMandatory": true,
      "free": false,
      "promptMicroUsdPerMtok": 800000,
      "completionMicroUsdPerMtok": 1600000
    }
  ]
}
```

Prices are micro-dollars per million tokens, so the math stays in integers. The
offline first-launch list is compiled into
[`catalog-seed.ts`](../desktop/main/catalog-seed.ts) and refreshed with
`npm run seed:catalog`.

## Inside the app bundle

`Emma.app/Contents/Resources/` holds:

| Resource | What it is |
| --- | --- |
| `emma-host` | The Rust NDJSON host |
| `emma-cli` | The Zig harness, and the agent behind every turn |
| `rg` | ripgrep 14.1.1, SHA-256 pinned at download |
| `emma-option-tap` | The ⌥⌥ listener and pointer driver |
| `emma-transcribe` | The Speech.framework dictation helper |
| `skills/` | The seven bundled skills |
| `app.asar` | `dist-main/main`, `dist-main/shared`, `dist-renderer` |

`Contents/Info.plist` carries `NSSpeechRecognitionUsageDescription`, merged in at
package time from [`native/Info.extra.plist`](../desktop/native/Info.extra.plist).
It has to be on Emma.app rather than on the helper, because TCC reads the
*responsible* process's plist.

## Resetting

Settings → Reset all data does exactly this:

```sh
rm -rf ~/Library/Application\ Support/Emma
rm -rf ~/Library/Application\ Support/emma-desktop
```

That destroys **every thread, every knowledge page, every artifact, every plan,
every scheduled job, all memories, your API keys, your folder grants, and the
whole harness profile.** There is no undo and no backup.

The `~/Documents/Emma Knowledge` mirror survives — it is outside both roots and
Emma never deletes it. If you want your knowledge back after a reset, that
folder is the copy you have.

Narrower resets:

```sh
rm -rf ~/Library/Application\ Support/emma-desktop/harness      # harness sessions and usage
rm  -f ~/Library/Application\ Support/emma-desktop/credentials.json  # stored API keys
rm  -f ~/Library/Application\ Support/emma-desktop/openrouter-catalog.json  # model catalog cache
rm -rf ~/Library/Application\ Support/emma-desktop/workspaces   # per-thread scratch
```

To wipe the renderer's settings without touching anything else, clear
`localStorage` from DevTools, or with the app running:

```sh
node desktop/scripts/drive.mjs 'localStorage.removeItem("emma.settings.v1")'
```

## See also

- [development.md](development.md) — building, checking, packaging
- [architecture.md](architecture.md) — how the processes fit together
- [concepts.md](concepts.md) — threads, agents, knowledge, artifacts
- [knowledge.md](knowledge.md) — the knowledge base and its Markdown mirror
- [privacy.md](privacy.md) — what leaves the Mac
- [models.md](models.md) — providers, routing, the catalog
- [harness.md](harness.md) — `emma-cli` and the ACP session
- [cli.md](cli.md) — the `cli` tools and Settings → Connections
- [permissions.md](permissions.md) — the modes and the gate table
- [tools.md](tools.md) — what each agent tool does
- [plugins.md](plugins.md) — UI plugins and MCP servers
- [jobs.md](jobs.md) — scheduled workflows
- [autoresearch.md](autoresearch.md) — the experiment loop
- [getting-started.md](getting-started.md) — install and first run
- [troubleshooting.md](troubleshooting.md) — when it breaks
