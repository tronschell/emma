# Data and environment

Every path Emma reads or writes, and every environment variable it reads.

## Roots

| Root | Default | Written by | Holds |
| --- | --- | --- | --- |
| Rust data root | Electron's `userData` root by default: `%APPDATA%/Emma` on Windows, `~/Library/Application Support/Emma` on macOS | `emma-host` | `threads/`, `scheduled/` |
| Electron `userData` | `app.getPath("userData")`, normally `%APPDATA%/Emma` on Windows or `~/Library/Application Support/Emma` on macOS | Electron main | everything else Emma owns |
| Your vault | wherever you picked | Electron main | your Markdown notes — **yours, not Emma's** |

`EMMA_DATA_DIR` moves the Rust root ([runtime.rs:6](../crates/host/src/runtime.rs#L6)).
When it is unset, the host follows the platform defaults; in a packaged app
those normally coincide with Electron's `userData` (`%APPDATA%/Emma` on
Windows). Settings → Reset all data removes both
([main.ts:2545](../desktop/main/main.ts#L2545)).
The vault is outside both and is never deleted.

## Environment variables

### Emma's runtime variables

| Variable | Read by | What it does | Default |
| --- | --- | --- | --- |
| `EMMA_DATA_DIR` | `emma-host`, Electron main | Root for `threads/`, `scheduled/`. | `%APPDATA%/Emma` on Windows; `$HOME/Library/Application Support/Emma` on macOS. A standalone host errors when its platform home variables are unset |
| `EMMA_DEV_SERVER_URL` | Electron main | Windows `loadURL` the dev server instead of `loadFile`, **and** that origin joins the trusted-sender set gating every privileged IPC handler ([ipc.ts:240](../desktop/main/ipc.ts#L240)). Set by `scripts/dev.mjs`. | unset → `file://` only |
| `EMMA_PROVIDER_API_KEY` | `emma-cli` | The harness's **only** credential source — no OAuth, no login ([credentials.zig:9](../harness/src/core/auth/credentials.zig#L9)). Whitespace-only counts as absent. Electron sets it at spawn from the stored `OPENROUTER_API_KEY`. | unset → public catalog only |
| `EMMA_PROVIDER_CHAT_URL` | `emma-cli` | Chat-completions URL override ([emma_openai.zig:41](../harness/src/gateway/emma_openai.zig#L41)). Empty is treated as unset. | OpenRouter |
| `EMMA_OPENROUTER_ZDR` | `emma-cli` | Demands zero-data-retention routing for OpenRouter harness requests. A selected model with no qualifying endpoint fails. Settings → Models toggles it and closes idle harnesses so the next spawn sees it. | unset → off |
| `EMMA_UPDATE_URL` | Electron main | Origin of the Squirrel.Mac update server, replacing `https://update.electronjs.org`. Origin only — scheme and host, no path or query — and `http://` only on loopback, or it is discarded ([shared/update.ts](../desktop/shared/update.ts)). The feed is that origin plus `/tronschell/emma/darwin-arm64/<version>` | unset → `https://update.electronjs.org` |
| `EMMA_UPGRADE_BASE_URL` | `emma-cli` | Self-update CDN base. Discarded unless it is loopback HTTP with an explicit port and no path, query or fragment — so self-update is off in practice, and Emma ships `emma-cli` in the bundle anyway. | unset → disabled |

`EMMA_UPDATE_FAKE` is a development-only notice preview: an unpackaged build
announces a newer version to the workspace without downloading anything. Its
install button does not install or restart, and a packaged build ignores it.
Use two signed disposable bundles and a local `EMMA_UPDATE_URL` feed for a real
installation rehearsal; see [releases.md](releases.md).

`EMMA_KNOWLEDGE_DIR` no longer exists. Neither does the `~/Documents/Emma Knowledge`
mirror it pointed at — the vault replaced both. There is no `EMMA_TOOLS`: a
`grep EMMA_[A-Z_]*` matches it inside `MAX_EMMA_TOOLS`, a plain constant in
[capabilities.ts:19](../desktop/main/capabilities.ts#L19).

`EMMA_CDP_PORT` is a development helper variable, read only by
[scripts/drive.mjs](../desktop/scripts/drive.mjs), a dev helper that attaches to
a running Emma over CDP. Default `9222`.

### Other names Emma reads or writes

| Variable | Role |
| --- | --- |
| `OPENROUTER_API_KEY` | Emma's one shipped remote route, and the default `credentialEnv` for the verifier, tagger, advisor and vision models. Decrypted from `credentials.json` into `process.env` on every host start ([credentials.ts](../desktop/main/credentials.ts)) |
| `TINYFISH_API_KEY`, `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY` | The names Settings pre-fills for ranked `web_search` providers. New settings try free TinyFish first and keyless 4get second; SearXNG and keyed providers are added explicitly ([settings.ts](../desktop/shared/settings.ts)) |
| `AI_GATEWAY_API_KEY` | **Dead write.** [harness.ts:316](../desktop/main/harness.ts#L316) sets it beside `EMMA_PROVIDER_API_KEY`; nothing in `harness/src` reads it |
| `HOME` | The base for nearly every path. Electron **overrides it for the harness** — `emma-cli` is spawned with `HOME=<userData>/harness`, so it never touches your real `~/.fx` |
| `PATH` | MCP command resolution (the harness refuses a bare name) and every CLI child. On macOS, [cli.ts](../desktop/main/cli.ts) reads the login shell's `$PATH` via `bash -lc` first, so `~/.local/bin` is found; Windows uses the inherited `PATH` |
| `TMPDIR`, `SHELL`, `USER`, `LANG`, `TERM`, `TERM_PROGRAM`, `COLORTERM`, `COLORFGBG`, `COLUMNS`, `NO_COLOR`, `TMUX`, `TMUX_PANE` | Read by `emma-cli` for scratch paths, the project context block, the secure credential-store account name, and terminal capability detection |

There are no `XDG_*` variables and `NODE_ENV` is never read.

### `FX_*` — the harness's own

`emma-cli` is Emma's fork of [vercel-labs/fx](https://github.com/vercel-labs/fx);
[FORK.md](../harness/FORK.md) says the `FX_*` names were kept deliberately.
These are the ones a shipped binary reads:

| Variable | What it does | Default |
| --- | --- | --- |
| `FX_MODEL` | Model id override. Trimmed; empty ignored. `/doctor` then reports source `process_override` | settings |
| `FX_PERMISSION_MODE` | Permission mode. An unrecognized value falls back silently | settings |
| `FX_MAX_AGENT_STEPS` | Step ceiling. **`0` means unbounded**, not zero | `0` |
| `FX_GATEWAY_BASE_URL` | Gateway base. The base carries the bearer token, so a non-loopback-HTTP override is logged and discarded | OpenRouter |
| `FX_WEB_SEARCH_BACKEND` | `perplexity_search` or `parallel_search`. Any other non-empty value is an error, not a fallback | first of the default order |
| `FX_AUTO_UPGRADE` | Off-switch only: `0`/`false` disables ([main.zig:626](../harness/src/main.zig#L626)) | on |
| `FX_DISABLE_KEYCHAIN` | `1`/`true` turns off OS secure storage for MCP OAuth credentials (macOS Keychain or Windows credential protection) | unset |
| `FX_SKILL_SYMLINK_AUTHORITIES` | Colon-separated absolute roots trusted as skill symlink targets. Relative entries and anything with `..` are skipped | empty |
| `FX_TRACE`, `FX_TRACE_LOG`, `FX_TRACE_STDERR`, `FX_TRACE_SCOPES` | Tracing. A relative `FX_TRACE_LOG` joins the workspace root; empty is an error. Scopes in use: `input`, `permission`, `stream`, `herdr`, `keychain`, `ui_observer` | off |
| `FX_THEME`, `FX_SOUND`, `FX_SYNC_UPDATES` | TUI theme, sound, and DECSET 2026 synchronized updates. Only reachable when you run `emma-cli` yourself | unset |
| `FX_RECORD`, `FX_RECORD_INPUT` | Write a `.fxtape` recording; the second also records raw keystrokes | off |
| `FX_HERDR`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID` | The herdr hook. Enabling needs **both** socket and pane id non-empty | disabled |
| `FX_BENCH` | With zero CLI args, runs a benchmark path instead of the TUI | unset |

Everything else matching `FX_E2E_*`, `FX_TERMINAL_TEST_*`, `FX_TEST_*` and the
various `*_SENTINEL` names is test-only fault injection and has no effect unless
a test sets it.

## Your vault

The user picks an Obsidian vault or any plain folder. Emma writes into it
directly — **there is no second copy and no mirror.** Obsidian, Spotlight,
Finder and your backups read the same files Emma wrote.

| Path | What it is |
| --- | --- |
| `<vault>/<folder>/` | The notes folder. `folder` defaults to `knowledge-base` (`DEFAULT_VAULT_FOLDER`) and is editable during setup |
| `<vault>/<folder>/<slug>.md` | One note per save. Collisions become `<slug>-2.md`, `-3.md`, … |
| `<vault>/<folder>/attachments/<slug>.<ext>` | A screenshot note's image, embedded as `![[attachments/<slug>.png]]` |
| `<vault>/<folder>/.emma-write-check` | Momentary probe file — written and deleted to test the Files & Folders grant, because TCC has no query API |

Note frontmatter ([vault.ts:236](../desktop/main/vault.ts#L236)) — JSON-quoted
scalars, only the fields that have a value:

```markdown
---
title: "Ling-3.0-flash tokenizer config"
kind: "page"
saved: "2026-08-22T02:56:46Z"
source: "https://huggingface.co/inclusionAI/Ling-3.0-flash"
application: "Safari"
tags: ["tokenizers", "inference"]
---
```

`tags` is written empty and filled in afterwards by the auto-tagger
([vault-tags.ts](../desktop/main/vault-tags.ts)), which rewrites only the
frontmatter block. A note with no frontmatter is skipped, not rewritten.

| Limit | Value | Constant |
| --- | --- | --- |
| Note body | 256 KiB | `MAX_NOTE_BYTES` |
| Attachment | 8 MiB | `MAX_ATTACHMENT_BYTES` |
| Tags per note | 8 | `MAX_TAGS` |
| Tag length | 48 bytes, `^[a-z0-9][a-z0-9/-]*$` | `MAX_TAG_BYTES`, `validTag` |
| Title | 120 bytes | `MAX_TITLE_BYTES` |
| Notes listed / name collisions tried | 2000 | `MAX_VAULT_NOTES` |
| Text sent to the tagger | 6000 chars | `MAX_TAG_TEXT_CHARS` |

Kinds are `screenshot`, `selection`, `page`, `note` — all in
[shared/vault.ts](../desktop/shared/vault.ts). The tool that writes them is
`keep`. An Obsidian vault also gets a working `obsidian://open?vault=…&file=…`
link back.

## Rust data root

| Path | What it is |
| --- | --- |
| `threads/<id>.md` | One thread: front matter, then `## Message N` and `## Trace N` blocks |
| `scheduled/job-<id>.md` | One scheduled job: cron line, prompt, workflow nodes, last run, last thread |

Ids look like `1787453493-cbe6-18ce4f7b7b4713c8-0` — seconds, a short random
tag, a monotonic component, a counter.
Every write is atomic: temp file, then rename.

### Thread — `threads/<id>.md`

```markdown
---
emma-thread-format: 13
id: "1787453493-cbe6-18ce4f7b7b4713c8-0"
title: "New thread"
parent-thread-id: ""
kind: "main"
scheduled-job-id: ""
created-at: "2026-08-23T02:51:33Z"
updated-at: "2026-08-23T02:51:33Z"
archived-at: ""
message-count: 0
trace-count: 0
---
```

Format is `13` ([thread.rs:108](../crates/core/src/thread.rs#L108)); a file
claiming a higher one is rejected. A thread pursuing a goal carries twelve more
front-matter keys between `archived-at` and `message-count` — `goal-objective`,
`goal-status`, `goal-evidence`, `goal-blocked-reason`, `goal-blocked-streak`,
`goal-blocked-at-turn`, `goal-token-budget`, `goal-tokens-used`,
`goal-time-used-seconds`, `goal-turns`, `goal-created-at` and `goal-updated-at`
— and a thread without one carries none of them ([goals.md](goals.md)). Messages carry `Role:`, `Time:`,
`Generation: present|none` and, when a model produced them, `Output-Tokens:`,
`Duration-Milliseconds:`, `Input-Tokens:`, `Model:`, then the quoted content.
There are no `knowledge-base-id` fields any more.

Scheduled jobs are `emma-scheduled-job-format: 4`.

## Electron `userData`

| Path | Mode | What it is |
| --- | --- | --- |
| `vault.json` | `0600` | `{root, folder, kind, name}` — which vault you picked ([vault.ts:81](../desktop/main/vault.ts#L81)) |
| `credentials.json` | `0600` in `0700` | `{"OPENROUTER_API_KEY": "<base64 safeStorage ciphertext>"}`. Emma refuses to save when `safeStorage.isEncryptionAvailable()` is false or a `decryptString(encryptString(…))` round trip fails. Each entry is decrypted on its own: one that fails is kept as opaque ciphertext, rewritten verbatim on the next save, never applied to `process.env`, and listed as `readable: false` until you paste that key again or remove the slot. On host start the readable ones decrypt into `process.env` and names it no longer holds are unset |
| `Local State` | Chromium | Chromium's own prefs, including the profile encryption key that `credentials.json` is sealed with, DPAPI-wrapped under `os_crypt.encrypted_key` on Windows. Chromium mints a fresh key when the file has none and persists it only at a clean shutdown, so a key pasted into a process that is killed first — the Windows installer's `--squirrel-firstrun` relaunch is the one that bites — cannot be decrypted again. Deleting this file makes every stored key unreadable |
| `folders.json` | `0600` | `[{id, path, name}]`. The renderer only ever names a grant by `id`; every read re-checks the real path |
| `mcp.json` | `0600` | `{"mcpServers": {…}}`, written whole and re-parsed before the rename. Reading also accepts JSONC and TOML, and root keys `mcp_servers`, `servers`, `mcp`. Bare command names are refused |
| `imports.json` | | What was imported from Codex, Claude, Antigravity, Pi, OpenCode, Cursor, Windsurf and Devin at first launch. Paths only, and only ones that existed |
| `installed-plugins.json` | | Plugins installed from the Plugins page: id, marketplace, version, contributed skill and MCP paths |
| `plugin-hooks.json` | | Hash of each plugin lifecycle hook you reviewed. Nothing runs without a match, so editing a hook on disk turns it off |
| `mobile-peers.json` | `0600` in `0700` | A list of up to three `{key, name, addr, pin, verified, pairedAt}` records, one per paired phone, where `pairedAt` doubles as the device's id. A single-object `mobile-peer.json` written by an older Emma is read once and retired. `key` is base64 `safeStorage` ciphertext and `pin` is a scrypt hash, never the PIN; pairing is refused outright when the keychain is unavailable. A record that fails to decrypt, whose `addr` is not a `ws://host:port`, or that was never proved with a PIN, loads as no pairing ([pairing.ts](../desktop/main/pairing.ts)) |
| `openrouter-catalog.json` | `0600` | `{fetchedAt, models[]}`. Prices are micro-dollars per million tokens so the math stays integer. The offline first-launch list is compiled into [catalog-seed.ts](../desktop/main/catalog-seed.ts); `npm --prefix desktop run seed:catalog` refreshes it |
| `artifacts/<id>/meta.json` | `0600` in `0700` | `{id, title, kind, language, createdAt, updatedAt, version, surface?, sourceThreadId?, sourceJobId?}` |
| `artifacts/<id>/content.<ext>` | `0600` | `markdown`→`md`, `code`→`txt`, `html`/`app`→`html`, `svg`→`svg`, `mermaid`→`mmd`, `react`→`jsx`. An `app` artifact may also hold `data.sqlite` |
| `components/<id>/meta.json` | `0600` in `0700` | `{id, title, createdAt, updatedAt, version, expands?, variables?, disabled?, sourceThreadId?}` |
| `components/<id>/module.js` | `0600` | The module served at `emma-component://<id>/module.js?v=<version>`. `shot.png` beside it is the picture Settings → Built by Emma shows |
| `plans/<id>.md` | | One plan. The Markdown **is** the record — `parsePlan(renderPlan(p))` round-trips |
| `task-lists/<id>.md` | `0600` in `0700` | One nested task list. The Markdown is the record and remains hand-editable |
| `skills/<slug>/SKILL.md` | `0600` in `0700` | The seven bundled skills plus anything written or imported |
| `tools/<slug>/run` | `0700` | An Emma-authored tool. Must start with `#!` |
| `tools/<slug>/about.txt` | `0600` | That tool's description |
| `memories/` | | The `memory` tool's root. The model's `/memories/...` prefix is a fiction mapped onto this directory. 256 KiB per file, 256 files |
| `attachments/<uuid>-<name>` | `0600` in `0700` | Files dropped or pasted into the composer. Files picked in the native dialog are read where they are and never copied |
| `workspaces/<threadId>/` | | Scratch working directory for a thread with no folder attached |
| `plugins/<id>/plugin.json` | | A UI plugin manifest: `id`, `name`, semver `version`, `uiStylesheet` |
| `plugins/<id>/<name>.css` | | Its stylesheet. Capped at 128 KiB; rejected if it contains `@import` or `url(` |
| `plugin-data/<marketplace>/<plugin>/` | `0700` | `PLUGIN_DATA` — the one directory a trusted hook may write in. Emma never reads it |
| `marketplaces/sources.json` | `0600` | Marketplaces you added: id, origin, ref, sparse paths, local flag |
| `marketplaces/<id>/` | | A Git marketplace's shallow checkout. A local marketplace is read where it sits |
| `marketplaces/.remote/<marketplace>/<plugin>/` | | A plugin whose entry points elsewhere: cloned there, or unpacked under `package/` from `npm pack`. Replaced wholesale on reinstall |
| `marketplaces/emma/` | | The marketplace Emma writes into: `.agents/plugins/marketplace.json` plus `plugins/<name>/` per `write_plugin` |
| `update-ready.json` | | `{version}` of an update Squirrel downloaded, so the notice survives a quit. Deleted once the running version is no longer older ([update.ts](../desktop/main/update.ts)) |
| `harness/` | | `emma-cli`'s entire `HOME` — see below |

Chromium adds `Cache`, `Code Cache`, `Cookies`, `Local Storage`,
`Session Storage`, `Preferences`, `GPUCache`, `blob_storage`, `SingletonLock`
and friends to the same directory. Emma writes none of those.

Two things Emma deliberately keeps **off** disk: `visualize` output lives in an
in-memory `Map` served over the `emma-visual:` scheme
([visuals.ts](../desktop/main/visuals.ts)), and terminal sessions
([terminal.ts](../desktop/main/terminal.ts)) write nothing. Git worktrees the
agent creates go to `<parent>/<repo>-worktrees/<name>`, beside your checkout,
not into `userData` ([git.ts:97](../desktop/main/git.ts#L97)).

### Renderer state — `localStorage`

Inside `Local Storage/`, not a file of Emma's own.

| Key | Holds | Written by |
| --- | --- | --- |
| `emma.settings.v1` | The whole `UserSettings` object | `App.tsx` |
| `emma.layout.v2` | Pane layout | `App.tsx` |
| `emma.setupSeen.v1` | Setup walkthrough dismissed | `App.tsx` |
| `emma.importsSeen.v1` | First-launch import dialog dismissed | `App.tsx` |
| `emma.freeModelsOnly.v1` | The free-models filter | `App.tsx` |
| `emma.overlayDraft.v1` | Unsent Quick Ask text | `App.tsx` |
| `emma.overlayMode.v2` | Quick Ask permission mode, migrated once out of `emma.overlayMode.v1` | `context.ts` |
| `emma.contextPage.v1` | The pinned context page | `context-bar.tsx` |
| `emma.improvements.v1` | System-prompt improvements | `improvements.ts` |
| `emma.threadFolders.v1`, `emma.threadModes.v1`, `emma.threadDraft.v1`, `emma.threadTags.v1`, `emma.threadAttachments.v1`, `emma.threadBlocks.v1`, `emma.threadCleared.v1`, `emma.threadExperiments.v1`, `emma.threadContextUses.v2`, `emma.threadContextBreakdown.v1` | Per-thread renderer state | `context.ts` |

`validateSettings` ([settings.ts](../desktop/shared/settings.ts)) validates on
both read and write. Ceilings: exactly 3 `quickActions` (label ≤ 40 chars,
prompt ≤ 4096); `favoriteModels` ≤ 6; `cursorOrbs` 1–8; `notchGap` 120–260;
`systemPrompt` and each saved prompt ≤ 24576 chars; secrets ≤ 512 chars;
`uiScale` 80–150; disabled tool/skill lists ≤ 256 entries.

### The harness home — `<userData>/harness`

`emma-cli` is spawned with `HOME` pointed here, so its whole profile lives
inside Emma's data. Names from
[profile_paths.zig](../harness/src/core/shared/profile_paths.zig).

| Path | What it is |
| --- | --- |
| `.fx/system-prompt-<hash>.md` | The resolved system prompt for one model key — model, workspace, mode, disabled tools, kept improvements. Named to the child in `EMMA_SYSTEM_PROMPT` ([system-prompt.ts](../desktop/main/system-prompt.ts)) |
| `.fx/AGENTS.md` | Written empty every turn |
| `.fx/skills/<slug>/SKILL.md` | A mirror of every skill Emma can see, minus anything disabled. Rewritten on every capability change; a slug the mirror no longer covers is deleted |
| `.fx/sessions/<id>/` | One harness session: `session.json`, `events.jsonl`, `checkpoint.json`, `authority.json`, `usage-v2.json`, lock files, `artifacts/`, `subagent/` |
| `.fx/settings.json`, `.fx/mcp.json` | The harness's own settings and MCP config |
| `.fx/auth.json`, `.fx/chatgpt-auth.json`, `.fx/api-key` | Credential files the fork still supports. Emma uses `EMMA_PROVIDER_API_KEY` instead |
| `.fx/mcp-credentials/credentials.json` | MCP OAuth credentials, when OS secure credential storage is disabled |
| `.fx/usage.jsonl`, `.fx/usage.lock`, `.fx/usage-recovery/` | Append-only usage log and its crash recovery |
| `.fx/history.jsonl` | Prompt history |
| `.fx/logs/trace.log`, `.fx/recordings/`, `.fx/backups/` | Trace log, `.fxtape` recordings, backups |

`~/.codex/config.toml` and the other agent-tool config files are **read** at
import time ([imports.ts](../desktop/main/imports.ts)), and
`~/.codex/auth.json` is read on every ChatGPT-plan turn
([chatgpt.ts](../desktop/main/chatgpt.ts)); Emma writes nothing into them and
copies nothing here.

## Inside the app bundle

On macOS, `Emma.app/Contents/Resources/` contains bundled helpers, skills,
notices, and the asar. A Windows package keeps the same resources under its
Electron `resources/` directory:

| Resource | What it is |
| --- | --- |
| `emma-host` | The Rust NDJSON host |
| `emma-cli` | The Zig harness, the agent behind every turn |
| `rg` | [ripgrep](https://github.com/BurntSushi/ripgrep) 15.2.0, SHA-256 pinned at download, no Homebrew dependency |
| `emma-option-tap` / `emma-option-tap.exe` | The macOS ⌥⌥ or Windows left-Alt listener and pointer driver |
| `emma-computer` / `emma-computer.exe` | App-scoped accessibility or UI Automation controls |
| `emma-transcribe` / `emma-transcribe.exe` | The macOS Speech.framework or Windows speech dictation helper |
| `emma-pty` | The terminal helper |
| `skills/` | The seven bundled skills |
| `notices/` | Emma, harness, renderer, Rust, ripgrep, font, and brand license notices |
| `app.asar` | `dist-main/main`, `dist-main/shared`, `dist-renderer` |

On macOS, `Contents/Info.plist` carries the macOS 12 minimum, microphone usage,
and `NSSpeechRecognitionUsageDescription`, merged at
package time from [native/Info.extra.plist](../desktop/native/Info.extra.plist).
It has to be on `Emma.app` rather than the helper, because TCC reads the
*responsible* process's plist.

## See also

- [getting-started.md](getting-started.md) — install and first run
- [troubleshooting.md](troubleshooting.md) — the errors these paths produce
- [architecture.md](architecture.md) — how the three processes fit together
- [privacy.md](privacy.md) — what leaves this computer
- [permissions.md](permissions.md) — the four modes and the gate table
- [models.md](models.md) — providers, routing, the catalog
- [harness.md](harness.md) — `emma-cli`, Emma's fork of [vercel-labs/fx](https://github.com/vercel-labs/fx)
- [plugins.md](plugins.md) — UI plugins, marketplaces, MCP servers
- [tools.md](tools.md) — what each agent tool does
