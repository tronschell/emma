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
│ Windows, global shortcuts, screen, app controls, files,     │
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

The renderer holds one snapshot and learns it is stale two ways: main's `changed()`
broadcast on `emma:changed`, and a `SNAPSHOT_REFRESH_MS` interval. Only the
interval stands down while the window is off screen — the broadcast always
reloads. On macOS an occluded window reports `visibilityState` as `hidden` just
as a minimised one does, so gating the broadcast on visibility left saving a job,
deleting one or starting an experiment invisible behind any other window until
something else refreshed.

## Who may touch what

| | Filesystem | Network | Model | Screen / app controls |
| --- | --- | --- | --- | --- |
| Renderer | no | no | no | no |
| Electron main | yes | yes | yes | yes |
| `emma-host` | Markdown stores only | no | no | no |
| `emma-cli` | permission-gated files and commands | providers + MCP | yes | no |

`emma-host` depends on `serde` and `serde_json`; its implementation does not
open a socket or spawn a child. This is a code boundary, not an OS sandbox.
The harness runs the agent loop; current parent-turn
`computer` calls return over ACP as `_emma/callTool`. Electron main owns exact-app
approval, the stop switch, and the native helper's app-scoped accessibility controls.
Child agents cannot use the grant. Computer use does not capture the screen or drive
the global pointer; screen-context and annotation capture are separate features. See
[computer-use.md](computer-use.md).

## Validation at each boundary

| Boundary | Checked by | What it enforces |
| --- | --- | --- |
| Renderer → main | `trustedFrame` in [`main.ts`](../desktop/main/main.ts) | Sender must be the main frame and its URL must be `<appPath>/dist-renderer/index.html`, or the `EMMA_DEV_SERVER_URL` origin (`trustedSender`) |
| Renderer → main | `validateRequest` in [`ipc.ts`](../desktop/main/ipc.ts) | Method must be in the allowlist; exact required and optional field lists; every value a string; per-key length caps; whole envelope ≤ 128 KiB |
| Renderer → main | `keepRequest`, `vaultRequest`, `runCommandRequest`, `validJpegDataUrl` | Per-channel shape checks for the channels that do not reach the host |
| Renderer → main | Component request validation and execution | Fixed public HTTPS destinations, bounded requests/responses, and native approval before credentials are sent; widgets share the renderer and are not isolated identities. See [components.md](components.md) |
| Main → host | `MAX_REQUEST_BYTES` 128 KiB in [`main.rs`](../crates/host/src/main.rs) | Oversize lines are refused with the request id recovered, not dropped silently |
| Host → main | serde `deny_unknown_fields` on every params struct | An unknown or misspelled field is an error, not a default |
| Host → main | `BoundedLines` in [`ndjson.ts`](../desktop/main/ndjson.ts) | 16 MiB per line, UTF-8 fatal decode, `parseHostLine` re-checks every envelope |
| Harness → main | `BoundedLines` in [`harness.ts`](../desktop/main/harness.ts) | 8 MiB per ACP line; unknown methods answered `-32601` |
| Model → user's computer | `toolGate` in [`shared/permissions.ts`](../desktop/shared/permissions.ts) | Which tools ask, which run, per permission mode |

A refused or unanswered permission question is a denial. Nothing about that is
per-surface: the composer, Quick Ask, a quick action and a due scheduled job all
funnel through one `sendMessage` interception in `main.ts`, so the mode, the gate
table and the trace writer exist once.

## The two stdio protocols

**NDJSON to `emma-host`** — one JSON request object per line in, one
`{id, ok, result}` or `{id, ok, error}` envelope per line out. It is
request/response only, with one exception: the host pushes unsolicited
`{"dueJob": …}` lines when a scheduled job comes due. Large responses use the
chunk framing described below. Assistant text arrives from the harness instead, and main rebroadcasts it
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
the platform default when unset (normally Electron's `userData`: `%APPDATA%/Emma`
on Windows and `~/Library/Application Support/Emma` on macOS), holds `threads/`, `scheduled/`
and `research/` — one Markdown file per record, written to `.{id}.tmp` and
renamed over the destination. Artifacts, components, plans, skills, tools and
credentials are also Electron's, under `userData`, and reach the renderer over
named IPC channels rather than through the host. Kept notes go into the user's
own vault, not into Emma's data directory — see [knowledge.md](knowledge.md).
Full inventory in [data.md](data.md).

Every write through the host client invalidates the main process's snapshot cache
and broadcasts `emma:changed`, so a record the harness writes mid-turn — a spawned
sub thread, a subagent's thread, a goal, a title — reaches the windows as it lands
rather than when the turn ends. Windows take that broadcast whether or not they
are frontmost; only the 60-second backstop poll waits for the page to be visible.
`thread` and `readTrace` are reads and broadcast nothing.

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
- Three privileged schemes are registered. `emma-artifact://<id>` serves a stored
  artifact with its own restrictive CSP, framed `sandbox="allow-scripts"` and
  never `allow-same-origin`; `emma-visual://<id>` serves an inline visual the
  same way; `emma-component://<id>` serves a context-bar widget's module and
  screenshot into the workspace itself. The workspace CSP permits framing the
  first two and no other.
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
- [privacy.md](privacy.md) — what leaves this computer

## Host response framing

The Rust host keeps responses up to 64 KiB as ordinary NDJSON envelopes. Larger responses are serialized intact, then emitted as `{id, chunk, sequence, end}` frames. Each `chunk` contains at most 64 KiB of UTF-8 JSON text, split only between Unicode characters. Sequences start at zero; `end: true` identifies the final frame. The output mutex covers one whole frame, allowing scheduled `dueJob` events between frames.

Electron retains the 16 MiB line limit and validates and assembles chunks by pending request ID. Missing, repeated, out-of-order, mismatched, or malformed frames fail the transport; EOF with unfinished chunks also fails it. A response exceeding 256 MiB of assembled UTF-8 text is discarded through its final frame and rejects only that request, leaving the host available. Histories, traces, metadata, and renderer snapshot semantics are unchanged below this explicit runtime limit. Serialization and final parsing still hold the complete response in memory; framing is not pagination.
