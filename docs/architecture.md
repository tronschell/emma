# Architecture

Four processes, three trust boundaries. Every boundary validates its input.

## Process boundary

```text
┌─────────────────────────────────────────────────────────────┐
│ Renderer  (desktop/src)                                     │
│ sandbox: true · contextIsolation: true · nodeIntegration:   │
│ false · CSP default-src 'self'                              │
│ No disk, no network, no process, no model.                  │
└───────────────────────────┬─────────────────────────────────┘
                            │ window.emma  (contextBridge, desktop/main/preload.ts)
                            │ allowlisted channels only
┌───────────────────────────┴─────────────────────────────────┐
│ Electron main  (desktop/main)                               │
│ Windows, global shortcuts, screen, pointer, filesystem,     │
│ every provider call, every permission answer.               │
└──────┬───────────────────────────────────┬──────────────────┘
       │ NDJSON over stdio                 │ ACP over stdio
       │ one request/response per line     │ JSON-RPC, protocol version 1
┌──────┴──────────────────┐        ┌───────┴─────────────────────────┐
│ emma-host  (crates/host)│        │ emma-cli  (harness/, Zig)       │
│ → emma-core             │        │ Agent loop, tools, hooks,       │
│ → Markdown stores       │        │ skills, subagents, MCP client   │
│ No network. No child    │        │ → OpenAI-compatible providers   │
│ process. No model.      │        │ → MCP servers                   │
└─────────────────────────┘        └─────────────────────────────────┘
```

## Who may touch what

| | Filesystem | Network | Model | Screen / pointer |
| --- | --- | --- | --- | --- |
| Renderer | no | no | no | no |
| Electron main | yes | yes | yes | yes |
| `emma-host` | Markdown stores only | no | no | no |
| `emma-cli` | its workspace root | providers + MCP | yes | no |

`emma-host` depends on `serde` and `serde_json` and nothing else — it cannot
open a socket or spawn a child. The harness runs the agent loop but never drives
the pointer: `computer` calls come back down the ACP pipe as `_emma/callTool`
and execute in Electron main, which owns the screen and the kill switch. See
[computer-use.md](computer-use.md).

## Validation at each boundary

| Boundary | Checked by | What it enforces |
| --- | --- | --- |
| Renderer → main | `trustedFrame` in [`main.ts`](../desktop/main/main.ts) | Sender must be the main frame and its URL must be `<appPath>/dist-renderer/index.html`, or the `EMMA_DEV_SERVER_URL` origin (`trustedSender`) |
| Renderer → main | `validateRequest` in [`ipc.ts`](../desktop/main/ipc.ts) | Method must be in a 20-entry allowlist; exact required and optional field lists; every value a string; per-key length caps; whole envelope ≤ 128 KiB |
| Renderer → main | `keepRequest`, `vaultRequest`, `runCommandRequest`, `validJpegDataUrl` | Per-channel shape checks for the channels that do not reach the host |
| Main → host | `MAX_REQUEST_BYTES` 128 KiB in [`main.rs`](../crates/host/src/main.rs) | Oversize lines are refused with the request id recovered, not dropped silently |
| Host → main | serde `deny_unknown_fields` on every params struct | An unknown or misspelled field is an error, not a default |
| Host → main | `BoundedLines` in [`ndjson.ts`](../desktop/main/ndjson.ts) | 16 MiB per line, UTF-8 fatal decode, `parseHostLine` re-checks every envelope |
| Harness → main | `BoundedLines` in [`harness.ts`](../desktop/main/harness.ts) | 8 MiB per ACP line; unknown methods answered `-32601` |
| Model → user's Mac | `toolGate` in [`shared/permissions.ts`](../desktop/shared/permissions.ts) | Which tools ask, which run, per permission mode |

A refused or unanswered permission question is a denial. Nothing about that is
per-surface: the composer, Quick Ask, a quick action and a due scheduled job all
funnel through one `sendMessage` interception in `main.ts`, so the mode, the gate
table and the trace writer exist once.

## The two stdio protocols

**NDJSON to `emma-host`** — one JSON request object per line in, one
`{id, ok, result}` or `{id, ok, error}` envelope per line out. It is
request/response only, with one exception: the host pushes unsolicited
`{"dueJob": …}` lines when a scheduled job comes due. Nothing streams on this
path. Assistant text arrives from the harness instead, and main rebroadcasts it
as `emma:delta`; the durable message is written afterwards with `recordTurn`, so
a delta is never persisted. `recordTurn` is the one request with no natural
ceiling, so `recordedTurn` in `ndjson.ts` elides the middle of the prompt, the
reasoning and the answer separately to fit `MAX_RECORDED_TURN_BYTES` (120 KiB).

**ACP to `emma-cli`** — the
[Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol),
an external protocol from Zed Industries: newline-delimited JSON-RPC on stdio. Emma is the client and
the harness is the agent. Emma sends `initialize`, `session/new`, `session/prompt`,
`session/set_mode`, `session/set_config_option`, `session/compact`,
`session/cancel`; the harness sends `session/update`, `session/request_permission`
and the fork's own `_emma/callTool`. The harness is spawned with `HOME` pointed at
Emma's own directory so it never reads the user's `~/.fx`.

## Data on disk

`emma-core` owns parsing, validation and atomic persistence. `$EMMA_DATA_DIR`, or
`~/Library/Application Support/Emma` when unset, holds `threads/`, `scheduled/`
and `research/` — one Markdown file per record, written to `.{id}.tmp` and
renamed over the destination. Artifacts, plans, skills, tools and credentials are
Electron's, under `userData`, and reach the renderer over named IPC channels
rather than through the host. Kept notes go into the user's own vault, not into
Emma's data directory — see [knowledge.md](knowledge.md). Full inventory in
[data.md](data.md).

## Window and page hardening

- Every `BrowserWindow` is built by `secureWindow`: `sandbox: true`,
  `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`. The
  browser pane's `WebContentsView` uses the same four.
- `setWindowOpenHandler` denies every new window; an `http(s)` URL opens in the
  system browser instead. `will-navigate` is prevented for anything but the
  current URL.
- The workspace CSP is `default-src 'self'` with `object-src 'none'`,
  `base-uri 'none'` and `form-action 'none'` ([`index.html`](../desktop/index.html)).
- `setPermissionRequestHandler` and `setPermissionCheckHandler` answer through
  `pageMayAsk`: sanitized clipboard writes and audio-only media, from Emma's own
  windows. Everything else is refused.
- Two privileged schemes are registered. `emma-artifact://<id>` serves a stored
  artifact with its own restrictive CSP, framed `sandbox="allow-scripts"` and
  never `allow-same-origin`; `emma-visual://<id>` serves an inline visual the
  same way. The workspace CSP permits framing those two schemes and no other.
- `app.requestSingleInstanceLock()` keeps the Markdown stores under one host
  writer; a second launch focuses the first.

## Third-party

`harness/` is Emma's fork of [vercel-labs/fx](https://github.com/vercel-labs/fx)
(Apache-2.0, © Vercel, Inc. and fx contributors), forked at `580a0c5`, upstream
v0.0.4. Provenance is in [`harness/FORK.md`](../harness/FORK.md) and upstream
notices in [`harness/THIRD_PARTY_NOTICES.md`](../harness/THIRD_PARTY_NOTICES.md);
Apache-2.0 §4 requires both and that obligation survives the rename. The fork
keeps fx's agent loop, permissions, hooks, skills, subagents and MCP client, and
replaces the Vercel AI Gateway transport with OpenAI Chat Completions in
`harness/src/gateway/emma_openai.zig`.

Also third-party: [Electron](https://github.com/electron/electron),
[React](https://github.com/facebook/react), [Vite](https://github.com/vitejs/vite),
[Tailwind](https://github.com/tailwindlabs/tailwindcss),
[ripgrep](https://github.com/BurntSushi/ripgrep),
[xterm.js](https://github.com/xtermjs/xterm.js),
[mermaid](https://github.com/mermaid-js/mermaid),
[recharts](https://github.com/recharts/recharts), and the
Departure Mono font (SIL OFL 1.1, © 2022–2024 Helena Zhang,
[`DepartureMono-LICENSE.txt`](../desktop/assets/DepartureMono-LICENSE.txt)).
Vendor brand marks are credited in
[`desktop/assets/BRANDS-NOTICES.md`](../desktop/assets/BRANDS-NOTICES.md) and
[icon-sources.md](icon-sources.md).

## See also

- [concepts.md](concepts.md) — the vocabulary
- [development.md](development.md) — repo map, checks, builds, packaging
- [permissions.md](permissions.md) — the four modes and the gate table
- [harness.md](harness.md) — the fx fork and the ACP session
- [data.md](data.md) — every file and environment variable
- [privacy.md](privacy.md) — what leaves this Mac
