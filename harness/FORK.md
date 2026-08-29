# Fork provenance

`emma-cli` is Emma's fork of [`vercel-labs/fx`](https://github.com/vercel-labs/fx),
a coding agent harness written in Zig.

| | |
| --- | --- |
| Upstream | https://github.com/vercel-labs/fx |
| Forked at | [`580a0c5da9386317251968c09c1cee69e763487a`](https://github.com/vercel-labs/fx/tree/580a0c5da9386317251968c09c1cee69e763487a) |
| Upstream version at fork | 0.0.4 |
| Upstream commits taken since | 22, individually, surveyed to `c864c67` (past v0.0.6) |
| Upstream license | Apache License 2.0 |

Copyright Vercel, Inc. and fx contributors. Licensed under the Apache License,
Version 2.0. The full license text is in [`LICENSE`](LICENSE) and upstream's
third-party notices are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
Both are retained because Apache-2.0 §4 requires it; that obligation survives
renaming and rebranding, so it is not something the fork may drop.

## What this fork changes

Emma keeps fx's agent loop, permission model, hooks, skills, subagents, tools,
and MCP client. It replaces the parts that tie fx to Vercel's hosted services:

- **Binary and package name.** `fx` becomes `emma-cli`. The `build.zig.zon`
  fingerprint is regenerated, because upstream's own comment on that field says
  a fork that keeps it is attempting to take over the original project's
  identity.
- **Model transport.** Upstream talks to Vercel AI Gateway over the AI SDK
  language-model v3 protocol (`prompt`/`toolChoice` at `/v3/ai/language-model`).
  Emma talks to any OpenAI-compatible Chat Completions endpoint, which is the
  provider seam the rest of Emma already uses. Replies are buffered rather than
  streamed token by token. Malformed tool-call replies and allocation failures
  release partially parsed calls and completion fields exactly once.
- **Authentication.** Upstream's Vercel device OAuth, ChatGPT Codex OAuth, team
  selection, and credit balance are removed. Emma supplies a base URL, a model,
  and the *name* of an environment variable holding the credential; there is no
  vendor login surface anywhere in Emma.
- **Branding and hosted endpoints.** `fx.sh` docs links, feedback and upgrade
  URLs, and telemetry paths are removed rather than repointed.
- **Terminal arguments.** Upstream's `terminal` tool rejects anything that is
  not the exact advertised shape, with one sentence that repeats no matter what
  is wrong, so a model that sends `{"command":"pwd"}` loops until the retry
  guard stops the turn. Emma normalizes the two shapes models actually send —
  a lone `{"request":{...}}` envelope, and a call carrying only a command,
  which runs as `exec` — reads `"None"`/`"nil"`/`"undefined"` as the absent
  field they mean, and names what is wrong when it still cannot run the call.
  Each action's branch requires only its own required fields instead of every
  field it allows, so a command no longer costs two dozen explicit nulls.
- **Subagent advertisement.** Upstream hides the `subagent` tool behind
  `search_tools` (`.advertisement = .on_select`); Emma advertises it whenever
  the session supports children. Delegation is a first-class Emma feature — the
  app draws every child as a thread of its own — and a tool the model has to go
  looking for is one it does not use. The `subagent_available` gate is untouched.
- **Workhorse advertisement.** The same reasoning, applied to the seven tools a
  coding turn needs whatever it was asked to do: `read_file`, `list_files`,
  `glob_files`, `grep_files`, `edit_file`, `write_file` and `terminal` are
  advertised rather than searched for. Upstream defers all of them, and
  `search_tools` ranks by keyword over a default of eight results, so a model
  whose query missed `grep_files` concludes there is no way to search a
  workspace and reads files one at a time instead — hundreds of calls to answer
  what one grep answers. The other eighteen searchable tools are unchanged, and
  they are where the deferral was ever worth its round trip.
- **Attached pictures.** Upstream's ACP server rejects every `image` prompt
  block, because fx only ever attaches a picture through its own TUI. Emma is an
  ACP client with a composer of its own, so a block naming a local `file://`
  image is loaded into the turn's attachment catalogue instead — the same
  catalogue `/image` fills — and snapshotted into the session's `images`
  directory the way every other surface snapshots one.
- **Model catalogue shape.** Upstream reads `vision` and `file-input` off a
  Vercel AI Gateway model's `tags`. OpenRouter publishes neither; it publishes
  `architecture.input_modalities`. Emma reads both shapes, so a model that can
  see is known to be able to.
- **Native vision gate.** Upstream routes a picture to the model itself only
  when it reports both vision *and* file input, then falls back to the forced
  `vision` tool. Emma gates on vision alone: the native part is an `image_url`,
  file input has nothing to do with it, and on OpenRouter a third of the models
  that can see do not claim it.
- **Vision approval.** A `vision` call naming `image_ids` resolves only against
  the catalogue the user themselves attached, so Emma admits it without a
  prompt. A call naming `paths` is the model choosing a file, and keeps its
  per-path gate.
- **Native Emma tools.** The twenty-three tools Emma owns are appended to fx's
  registry as `++ emma_tools.all` — specs in `src/builtins/emma_tools.zig` and
  `src/builtins/emma/`, one shared implementation in
  `src/tools/emma/bridge.zig`, and a new `ExecutorKind.emma`. The harness
  advertises and dispatches them but never runs one: `callEmmaTool` in
  `src/acp/prompt.zig` writes an outbound `_emma/callTool` request and blocks
  for the client's reply. They used to reach the model as a localhost MCP
  server, because MCP is the only door upstream leaves open for a tool it does
  not ship. `read_only_tool_names` in `src/builtins/tools.zig` had to gain them
  when they stopped being MCP servers: `Registry.toolAllowed` waves through
  anything the registry does not know, so bridging had made that list
  irrelevant to them.
- **App-scoped computer use.** `computer` advertises running-app discovery,
  accessibility state, and background actions against one exact app instance
  instead of global screenshots, pointer coordinates, and keyboard shortcuts.
  Mutations name an element from a single-use state snapshot. Calls still cross
  `_emma/callTool`; Emma owns the app approval and enforces it only for the current
  parent turn, regardless of full or auto mode. Child agents cannot use computer
  and must ask the parent to perform app actions. There is no
  activation, clipboard, or global-input fallback, and no Codex desktop runtime
  is copied or bundled.
- **Language servers.** `src/core/lsp/` and `src/tools/lsp/` are new — a
  JSON-RPC client with `Content-Length` framing, a process pool keyed by
  (server, workspace root), a data-only registry of about fifty servers in
  `src/core/lsp/servers.zig`, and the `lsp` tool's nine actions. An agent that
  can ask a real language server does not have to guess a definition from text.
- **Skill catalog budget.** `skill_catalog_bytes` defaults to 64 KiB instead
  of upstream's 16 KiB, which omitted `scheduled-tasks` and `threads` once
  imported skills filled the catalog. Per-description limits, explicit catalog
  overrides, and overflow warnings are unchanged.
- **Tool description cap.** `gateway_schema.description_max_bytes` was
  upstream's 1024 and is 4 KiB. `cappedDescriptionAlloc` truncates silently, so
  at 1024 `workflow` and `autoresearch` lost their last commands with nothing to
  show for it. A test in `src/builtins/emma_tools.zig` fails the build if a
  description outgrows the cap.
- **Cancelling one child.** `session/cancel_child` is added beside upstream's
  `session/steer_child`, so Emma can stop a single subagent without cancelling
  the parent turn that spawned it.

### De-Vercel pass (removals)

Commands and their plumbing: `login`, `logout`, `teams`, `credits`, `setup`, the
ChatGPT/Codex OAuth flow (`src/core/auth/chatgpt_oauth.zig`), and `/feedback`.
The credential model collapsed to a single source read from
`EMMA_PROVIDER_API_KEY` (`src/core/auth/credentials.zig`), and
`model_provider.ProviderId` to a single `gateway` variant.

Modules deleted: `src/builtins/devbox.zig` and
`src/core/execution/devbox_executor.zig` (Vercel Sandbox remote execution),
`src/core/hosts/native_secret_store.zig`, `src/core/feedback/runtime.zig`. The
gateway-API-key and OAuth-session halves of `src/core/hosts/native_keychain.zig`
went with them; the MCP OAuth half stays, because `src/core/mcp/` uses it.
`BackendKind.vercel` is gone from `src/core/shared/types.zig`, and the sandbox
`vercel` backend from `src/core/permissions/sandbox.zig`.

Release and hosting infrastructure: the Vercel Blob CDN workflows
(`cdn-backfill.yml`, `release.yml`, `dev-release.yml`, `prepare-release.yml`,
`publish-libfx.yml`). `upgrade_helpers.resolveCdnBase()` now returns `null`
unless the loopback E2E override is set, because emma-cli ships inside the
desktop app and has nothing to self-update from.

Renames: `AI_GATEWAY_API_KEY` → `EMMA_PROVIDER_API_KEY`,
`FX_E2E_UPGRADE_BASE_URL` → `EMMA_UPGRADE_BASE_URL`, `fx` → `emma-cli` in help,
usage, and error text, `fx.shared_model_context.v1` →
`emma.shared_model_context.v1`, and the `ai_gateway_*` web-search backend ids to
`perplexity_search`/`parallel_search` (local selector labels; the wire tool name
was already unprefixed).

Deliberately kept: the `LICENSE`, `THIRD_PARTY_NOTICES.md`, and every Apache-2.0
header and copyright line; `sandbox.retired_sandbox_config_message` and its
`vercel` parse arm, so an existing config naming that sandbox gets a real
diagnostic instead of a silent fallback; `"VERCEL_OIDC_TOKEN="` in the
`secret_prefixes` redaction allowlist in `src/core/shared/text_utils.zig`, since
dropping an entry only weakens redaction; the `~/.fx` config paths and `FX_*`
environment variables, which are fx branding rather than Vercel and are
user-settable; `sdk/`, upstream's `libfx` package, unrenamed and still pointing
at `vercel-labs/fx`, because Emma neither builds nor ships it — `build.zig.zon`
`.paths` does not list it and the WASM and N-API artifacts are opt-in build
options; and inert fixture strings naming `vercel-labs/agent-skills`,
`github.com/vercel-labs/fx` git remotes, and `vercel/v0` PR URLs.

## Merging upstream

Upstream is under active development, so this fork is a real maintenance cost —
that was a deliberate, accepted trade. Keep changes minimal and localized so a
future `git diff` against a newer upstream tag stays readable. Anything Emma
adds that is not a de-Vercel change belongs in Emma's own code where possible,
not scattered through vendored files.

Upstream is not merged wholesale. Between `580a0c5` and `c864c677` it landed 201
commits over 295 files, and a trial three-way merge conflicted in 82 of them —
almost all in the auth, provider, setup, and TUI surfaces this fork deleted.
Upstream also grew a Grok and Codex OAuth surface, which contradicts the rule
that there is no vendor login anywhere in Emma. So commits are taken one at a
time, each one built and tested before the next.

### Taken from upstream since the fork point

Upstream SHAs, in the order they were applied. Each landed as its own commit
here, so `git log` in this directory maps one to one.

| Upstream | Subject |
| --- | --- |
| `d8a88b1` | Load authorized linked skill metadata |
| `d0c26a1` | Close skill candidate on metadata OOM |
| `b4626ce` | Route clean reads through direct admission |
| `b3c0b82` | Bind clean command results by call ID |
| `3d104bb` | Stop repeated malformed tool argument loops |
| `8043b65` | Reject non-regular read_file targets |
| `715ced4` | Preserve corrupt memory stores |
| `5fdadd6` | Strip Caps Lock and Num Lock from kitty key modifiers |
| `f832493` | Test MCP approval argument preview |
| `950219e` | Cover stalled MCP cancellation recovery |
| `a585697` | Clarify terminal tool call guidance |
| `b646635` | Repair read_file regular file handling |
| `2c92ab0` | Normalize oversized image attachments |
| `e3de4b4` | Isolate MCP discovery and authentication failures |
| `48da8cd` | Preserve tool actions in transcript summaries |
| `c6d210b` | Clarify unavailable linked skill diagnostics |
| `ec240ff` | Apply permission mode changes to active turns |
| `cbb7f19` | Preserve sampled permission mode through execution |
| `65a3814` | Fix MCP credential, environment, and issuer handling |
| `b8ba84c` | Add remote HTTP servers through MCP add |
| `b199b8e` | Reduce MCP catalog memory |
| `16aa069` | Use bounded MCP search match storage |

Two carry Emma-side changes rather than a straight apply. `a585697` says a
terminal call must never pass an array; that sentence is kept, but the
surrounding paragraph is still Emma's, because this fork also lets a call omit
the fields its action does not use. `ec240ff` and `cbb7f19` are described
below.

### Deliberately not taken

- **`98be58b`, remove OS command sandboxing.** Emma keeps `sandbox-exec`. The
  permission-mode commits were written on top of that removal, so their
  `PermissionSnapshot` carries no `sandbox_backend` and drops the held turn
  pair entirely. Emma keeps `active_permission_snapshot` and both call sites
  in `app_agent_runtime.zig`, and takes only the live-mode sampling the
  orchestrator does at each action boundary. `setSandboxBackend` had to
  release `authority_mutex` before `syncQueuedPermissionSnapshot`, because
  `ec240ff` made `livePermissionSnapshot` take that same lock and Emma is the
  only side that still calls one from inside the other.
- **`3ad06b9`, bound terminal exec and retain command output**, and the two
  replay-hardening commits that build on it (`b129b6e`, `4c46572`). It makes a
  finite deadline mandatory on every `terminal exec` call, which is a tool
  contract change, and it introduces a paged agent replay store Emma does not
  have. The secret-boundary fixes protect only that store.
- **`7e4bed4` and `956301e`, the automatic review rewrite.** It removes 593
  lines from the orchestrator and rewrites `auto_classifier` and
  `tool_admission` against `src/acp/prompt.zig`, which is where `callEmmaTool`
  lives.
- **`b0b855f` and `70511ff`, compact tool schema records.** Restructuring the
  property record ripples into all twenty-three native tool specs, and the
  byte-exact schema oracles it adds are pinned to upstream's tool set.
- **`cd7da07`, terminal argument decoding.** Allocation count only, against the
  decoder this fork rewrote.
- Every Grok, Codex, Vercel OAuth, setup-hub, release-infrastructure, and
  TUI-presentation commit.

Upstream's byte-exact tool schema oracles are never taken: Emma advertises a
different tool set, so those hashes cannot match by construction.

### Edit review metadata

Pending `write_file` and `edit_file` ACP calls carry `_emma_filePath`, parsed
from their complete arguments before the 4 KiB display preview is truncated.
Emma retains this path across status updates to capture before/after file
contents for review and revert; history replay does not create new captures.
