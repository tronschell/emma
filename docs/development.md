# Development

How to build Emma, how to check it, and where things live. [`AGENTS.md`](../AGENTS.md)
is the rules file — this page restates it and adds the detail a first change needs.

## Repository map

```text
emma/
├── AGENTS.md              The rules. Read it before you change anything.
├── Cargo.toml             Rust workspace: crates/core + crates/host
├── rust-toolchain.toml    Pins Rust 1.97.1
├── justfile               Thin wrappers over the npm scripts
├── package.json           Root shims: dev, check, package:mac
├── agent/                 Zig sidecar (emma-agent)
├── crates/                Rust
├── desktop/               Electron app
├── harness/               emma-cli, the fork of vercel-labs/fx
├── docs/                  This directory
└── website/               Separate public site
```

### desktop/

| Directory | Who owns what |
| --- | --- |
| [`main/`](../desktop/main) | Electron main process: app lifecycle, windows, global shortcuts, trusted IPC, the preload bridge, and every runtime that touches the filesystem, a process, the network, or a model. 40 files. |
| [`src/`](../desktop/src) | Sandboxed React 19 renderer. Views, presentation state, markdown/highlight/document parsing. No Node, no Electron imports. |
| [`src/styles/`](../desktop/src/styles) | One stylesheet per region — `tokens.css` holds the design tokens, the rest are `sidebar`, `conversation`, `panels`, `settings`, `overlay`, `agents`, `artifacts`, `context-bar`, `markdown`, `research`, `timeline`. |
| [`shared/`](../desktop/shared) | Types and tables both processes agree on: `permissions.ts`, `settings.ts`, `artifacts.ts`, `plan.ts`, `workflow.ts`, `trace.ts`, `usage.ts`, `voice.ts`, `cli.ts`, `folders.ts`, `git.ts`. Importable from either side, so nothing in here may import Electron. |
| [`test/`](../desktop/test) | 37 `node --test` files plus `fake-acp-agent.mjs`. |
| [`native/`](../desktop/native) | Two ObjC helpers built with `clang`: `quick_ask.m` → `emma-option-tap` (the ⌥⌥ listener and pointer driver), `transcribe.m` → `emma-transcribe` (macOS Speech.framework). Plus `Info.extra.plist`, merged into the app bundle at package time. |
| [`scripts/`](../desktop/scripts) | Build and dev tooling: `dev.mjs`, `vendor-ripgrep.mjs`, `seed-catalog.mjs`, and three CDP drivers (`drive.mjs`, `shot.mjs`, `dismiss.mjs`). |
| [`skills/`](../desktop/skills) | Seven bundled skills, one `SKILL.md` each: `artifact`, `autoresearch`, `building-emma`, `installing-capabilities`, `meta-harness`, `scheduled-tasks`, `threads`. Copied into the user's skill root at every launch. |
| [`assets/`](../desktop/assets) | Departure Mono woff2 + its license, `brands/` (provider marks), `filetypes/`, `BRANDS-NOTICES.md`. |
| `vendor/` | Gitignored. `npm run vendor:ripgrep` downloads `rg` here. |

### crates/

| File | What it holds |
| --- | --- |
| [`core/src/lib.rs`](../crates/core/src/lib.rs) | Crate root and the integration tests: round-trips, limits, atomicity. |
| [`core/src/thread.rs`](../crates/core/src/thread.rs) | `Thread` / `ThreadStore`. Durable conversation timelines, ids, roles, kinds, messages, traces, generation telemetry. |
| [`core/src/knowledge.rs`](../crates/core/src/knowledge.rs) | Knowledge bases and pages: categories, cited sources, artifact blocks, the plain-Markdown mirror, atomic `KnowledgeStore`. |
| [`core/src/live.rs`](../crates/core/src/live.rs) | The live agent protocol and `start_live_runtime`. The biggest file in the crate. |
| [`core/src/scheduled.rs`](../crates/core/src/scheduled.rs) | `ScheduledJob` / `ScheduledJobStore` and due-job listing. |
| [`core/src/research.rs`](../crates/core/src/research.rs) | `ResearchJob` / `ResearchJobStore` and per-iteration history. |
| [`host/src/main.rs`](../crates/host/src/main.rs) | The `emma-host` binary: a stdio NDJSON-RPC server, one JSON request per line, dispatching named methods onto `emma-core`. |
| [`host/src/runtime.rs`](../crates/host/src/runtime.rs) | The `Sidecar`: spawns and supervises `emma-agent`, builds `ProviderConfig` from the environment, tells OpenRouter routes from loopback ones, bounds imported text. |

### agent/

| File | What it holds |
| --- | --- |
| [`src/main.zig`](../agent/src/main.zig) | The `emma-agent` sidecar. NDJSON on stdin/stdout, echoes request ids, streams `delta` lines. 256 KiB line ceiling, 64 KiB text ceiling. |
| [`src/openai_compatible.zig`](../agent/src/openai_compatible.zig) | OpenAI-compatible Chat Completions client, plus the model-catalog fetch (8 MiB cap, 60 s timeout). |
| [`emma`](../agent/emma) | A bash script, not a binary: the terminal front end. Mkfifos an in/out pair, keeps one `emma-agent` alive, speaks NDJSON so the terminal never sees JSON. `emma "prompt"` is one shot, no args is a REPL, `--install` symlinks it onto `PATH`. |

### harness/

`emma-cli` is Emma's fork of [vercel-labs/fx](https://github.com/vercel-labs/fx),
Apache-2.0. Read [`FORK.md`](../harness/FORK.md) before touching it — it records
what the fork changed and why, and keeping it honest is a rule.

| Directory | Who owns what |
| --- | --- |
| [`src/acp/`](../harness/src/acp) | Agent Client Protocol server: JSON-RPC framing, session lifecycle, prompt turns, MCP advertisement. This is the door `desktop/main/harness.ts` knocks on. |
| [`src/builtins/`](../harness/src/builtins) | The registry: which tools, commands, hooks, modes, skills and providers ship by default. |
| [`src/builtins/emma/`](../harness/src/builtins/emma) | Emma's tool *schemas* only — `threads.zig`, `knowledge.zig`, `system.zig`, `extensions.zig`, `overrides.zig`. Every one executes in Electron. |
| `src/builtins/gateway/` | `permission_reviewer.zig`, model-backed classification of permission requests. |
| `src/builtins/hooks/` | Bundled lifecycle hooks: the herdr socket reporter, and notifications. |
| [`src/core/`](../harness/src/core) | The engine, ~35 subdirectories. Agent loop (`agent/`, `app/`, `execution/`, `subagent/`); models and config (`config/`, `gateway/`, `auth/`); safety (`permissions/`, `modes/`, `shell_command/`, `hooks/`); state (`session/`, `workspace/`, `background/`, `tasks/`); tools and integrations (`tooling/`, `mcp/`, `skills/`, `slash_commands/`, `mods/`, `github/`); platform (`hosts/`, `terminal/`, `input/`, `output/`, `images/`, `notifications/`, `shared/`, `cli/`, `upgrade/`). |
| [`src/gateway/`](../harness/src/gateway) | Model transport: HTTP streaming client, `emma_openai.zig` (Chat Completions, replacing upstream's Vercel AI Gateway protocol), the model catalog, web search. |
| [`src/tools/`](../harness/src/tools) | Tool implementations by domain: `filesystem/`, `web/`, `agent/`, `terminal/`, `shell/`, `skills/`, `memory/`, `session/`. |
| [`src/tools/emma/bridge.zig`](../harness/src/tools/emma/bridge.zig) | The one implementation behind every Emma tool: validate args, forward raw JSON to Electron as `_emma/callTool`. |
| [`src/ui/`](../harness/src/ui) | The terminal UI Emma does not use but the fork still ships: screens, `render_engine/`, `transcript/`, `footer/`, `input/`, `terminal/`, `assistant/`, `subagent/`. |
| `tests/`, `benchmarks/`, `scripts/`, `sdk/` | E2E and eval suites, Zig micro-benchmarks, the PGSO size pipeline, and the `libfx` npm package. |

### website/

[`website/src/`](../website/src) is the public site and shares nothing with the
app: `App.tsx` (the whole page, plus a hardcoded features array), `index.css`
(Tailwind v4 entry and theme), `main.tsx`, `vite-env.d.ts`. React 19 + Vite 8 +
Tailwind 4 + TypeScript 6, with its own `dev`, `build`, `typecheck`, `lint`,
`format` and `check` scripts.

## House rules

These come from [`AGENTS.md`](../AGENTS.md). They are not suggestions.

### No comments

No comments. Not in TypeScript, Rust, Zig, CSS, shell, JSON5, or config. No file
headers, no section banners, no `TODO`, no `ponytail:` markers, no commented-out
code, no explanatory notes above a function, no restating what the next line
does. Doc comments — `///`, `/** */`, JSDoc — are comments too.

Delete comments you find in code you are already editing. If something needs
explaining, rename it, split it, or write it down in `docs/`.

The only exceptions are lines a tool refuses to run without:

- shebangs and `#!/usr/bin/env`
- license headers a vendored file's original license requires
- directives like `// @ts-expect-error`, `#![allow(...)]`, `eslint-disable`

A directive carries no prose.

> Heads up: much of `desktop/` still carries doc comments and `ponytail:` markers
> from before this rule. They are debt, not precedent. Delete them when you edit
> the file they are in.

### Keep the process boundaries visible

Electron owns windows and the sandboxed presentation. Rust owns durable data and
the host boundary. Zig owns the agent harness. Don't blur them.

- `desktop/main` — lifecycle, windows, global shortcuts, trusted IPC, the narrow preload bridge.
- `desktop/src` — sandboxed React views and presentation state. No Node access.
- `crates/host` — NDJSON bridge, provider adapter, the Zig process boundary.
- `crates/core` — thread and knowledge records, validation, atomic Markdown persistence.
- `agent` — the Zig agent runtime and its wire protocol. It never renders UI and never writes the durable stores.
- `harness` — `emma-cli`, driven over ACP from `desktop/main/harness.ts`.
- `website` — separate React and Tailwind public site.

### No boundary until a second implementation needs it

Do not add a crate, a trait, a service locator, or a plugin framework until a
second real implementation needs the boundary. One implementation behind an
interface is an interface nobody asked for.

### Nothing heavy in the renderer

Keep filesystem, process, network, image, and model work outside `desktop/src`.
The renderer asks main; main does it. That is what the preload bridge is for.

### Validate at every trust boundary

Every IPC message and every NDJSON line is untrusted until it has been checked.
[`ipc.ts`](../desktop/main/ipc.ts) declares each method's exact field list and
refuses anything else; [`ndjson.ts`](../desktop/main/ndjson.ts) frames and bounds
the host stream; `crates/host` re-checks everything the sidecar sends back.
A new channel gets the same treatment or it does not ship.

### Launch it

Visible or platform work is not complete until the real app has been launched and
the changed interaction exercised. Report unverified shortcuts, privacy
permissions, VoiceOver behavior, display geometry, signing, and non-macOS paths.

## Toolchains

| | Version | Pinned in |
| --- | --- | --- |
| macOS | Apple silicon | — |
| Node | 24+ | [README](../README.md); no `engines` field |
| Rust | 1.97.1, minimal profile, `clippy` + `rustfmt` | [`rust-toolchain.toml`](../rust-toolchain.toml) |
| Rust edition | 2024, `rust-version = "1.97"` | [`Cargo.toml`](../Cargo.toml) |
| Zig | 0.16.0 minimum | [`harness/build.zig.zon`](../harness/build.zig.zon) |
| Electron | 43.4.0 | [`desktop/package.json`](../desktop/package.json) |
| TypeScript | 6.0.3 | same |
| React | 19.2.8 | same |
| Vite | 8.2.2 | same |
| Tailwind | 4.3.3 | same |
| ESLint | 10.0.1 | same |
| Xcode CLT | whatever ships `clang` | builds the two native helpers |

`agent/build.zig` sets no minimum of its own; it uses the same Zig you build the
harness with.

Get set up:

```sh
npm install --prefix desktop
npm run dev
```

## Checks

The list every change has to pass, exactly as [`AGENTS.md`](../AGENTS.md) states
it:

```sh
npm --prefix desktop run check
cargo fmt --all -- --check
cargo check --workspace --locked --all-targets
cargo test --workspace --locked
cargo clippy --workspace --locked --all-targets -- -D warnings
zig build test -Doptimize=ReleaseSafe --build-file agent/build.zig
(cd harness && zig build test)
```

Roughly: the npm check is tens of seconds, the Rust four are a couple of minutes
cold and seconds warm, the agent Zig test is seconds, and the harness test suite
is the long pole — it compiles a 25 MB binary's worth of Zig.

### npm scripts

Everything lives in [`desktop/package.json`](../desktop/package.json). The root
`package.json` and the [`justfile`](../justfile) just forward to it.

| Script | What it does |
| --- | --- |
| `check` | `test` + `typecheck` + `lint` + `build:renderer`. The one to run before you push. |
| `test` | `build:main`, then `node --test dist-main/test/*.test.js`. ~1.5 s for 286 tests once compiled. |
| `typecheck` | `tsc --noEmit` over both projects: `tsconfig.main.json` and `tsconfig.renderer.json`. |
| `lint` | `eslint . --max-warnings 0`. Browser globals for `src/`, Node globals for `main/`, `test/` and `scripts/`. |
| `build:main` | `tsc -p tsconfig.main.json` → `dist-main/`. Emits CommonJS. |
| `build:renderer` | `vite build` → `dist-renderer/`. React + Tailwind, `base: "./"`. |
| `build` | `build:main` then `build:renderer`. |
| `build:host` | `cargo build --locked -p emma-host`, then `zig build --build-file ../agent/build.zig`, then `build:harness`. All three sidecars. |
| `build:harness` | `(cd ../harness && zig build)` → `harness/zig-out/bin/emma-cli`. Nothing else builds it. |
| `build:native` | `clang` twice: `native/quick_ask.m` → `dist-native/emma-option-tap` (then runs `--self-test`), and `native/transcribe.m` → `dist-native/emma-transcribe`. Both `-mmacosx-version-min=12.0 -fobjc-arc`. |
| `vendor:ripgrep` | Downloads ripgrep 14.1.1 for this arch into `desktop/vendor/rg`, checked against a pinned SHA-256, and stamps `vendor/rg.version`. Re-running with the stamp present is a no-op. On a non-darwin host it warns and skips — the tool falls back to `rg` on PATH, then to `grep`. |
| `seed:catalog` | Fetches OpenRouter's tool-capable model list and rewrites [`main/catalog-seed.ts`](../desktop/main/catalog-seed.ts) — the offline first-launch model list. Needs no key. |
| `dev` | `node scripts/dev.mjs`. See below. |
| `start` | `build:host` + `build:native` + `vendor:ripgrep` + `build`, then `electron .`. No Vite dev server; the renderer is the built bundle. |
| `package:mac` | Release build and `electron-packager`. See [Packaging](#packaging). |

### justfile

[`justfile`](../justfile) has five targets, all wrappers:

| Target | Runs |
| --- | --- |
| `just check` | `npm --prefix desktop run check` and `cargo check --workspace --locked --all-targets` |
| `just test` | `cargo test --workspace --locked` |
| `just dev` / `just run` | `npm --prefix desktop run dev` |
| `just package` | `npm --prefix desktop run package:mac` |

Note `just check` is not the full check list — it skips `cargo fmt`, `clippy`,
and both Zig suites. Run the seven commands above.

## Tests

### desktop — compile, then test

`node --test` runs JavaScript, and the tests are TypeScript, so `npm test` is two
steps: `tsc -p tsconfig.main.json` writes `dist-main/`, then `node --test
dist-main/test/*.test.js` runs the output.

[`tsconfig.main.json`](../desktop/tsconfig.main.json) has `rootDir: "."` and
`include: ["main/**/*.ts", "test/**/*.ts"]`, so `shared/` and the `.ts` half of
`src/` get pulled in transitively and emitted too. That is why a renderer module
like `src/runs.ts` can be unit-tested at all. There is no `"type": "module"`, so
Node16 emits CommonJS — which is what lets a test stub Electron by poisoning
`require.cache`.

Two consequences worth knowing:

- **Run it from `desktop/`.** `harness.test.ts` builds `path.join(process.cwd(), "test", "fake-acp-agent.mjs")`, and that `.mjs` is never compiled or copied. `panes.test.ts` reads the real CSS out of `../../src/styles/`.
- **Anything in `shared/` or `src/` that no `main/` or `test/` file imports is not typechecked by this project.** `npm run typecheck` covers the rest through `tsconfig.renderer.json`.

Isolation is by argument, not by environment: the stores take their root as a
parameter, and eleven test files hand them a fresh `mkdtemp` directory. For
example [`memory.test.ts`](../desktop/test/memory.test.ts) uses
`mkdtemp(path.join(tmpdir(), "emma-memories-"))` and removes it in a `finally`.
No test sets `EMMA_DATA_DIR`.

[`fake-acp-agent.mjs`](../desktop/test/fake-acp-agent.mjs) stands in for `emma-cli
acp`. Only `harness.test.ts` uses it, spawned as `process.execPath` with the
script as its argument. It speaks real ACP over stdio — `initialize`,
`session/new`, `session/resume`, `session/set_mode`, `session/compact`,
`session/steer_child`, `session/cancel`, `session/prompt` — and branches on the
prompt text: `"slow"` streams past the idle window, `"subagent"` emits
`_meta.fx.child`-tagged updates, `"emmatool"` calls back with `_emma/callTool`.
It deliberately keeps one session and prompts against it whatever `sessionId`
arrives, so the two-threads-one-process bug stays covered.

#### What each test file covers

| File | Covers |
| --- | --- |
| `agent.test.ts` | `main/agent-loop.ts` + `main/tools.ts` + `shared/permissions.ts`: tool advertisement per mode, arg validation, the bare-grep carve-out, name/description/schema/output byte ceilings, steering and stopping a run. |
| `artifacts.test.ts` | `main/artifacts.ts`: read/write/update/delete round-trips, path escapes out of the artifact root, the single-statement SQL bridge and its caps, corrupt-DB tolerance, region ownership. |
| `attachments.test.ts` | `main/attachments.ts`: picked files copied under userData by basename, only attached paths readable, images carry a path not bytes, binaries refused. |
| `background.test.ts` | `main/background.ts`: a backgrounded command returns immediately, keeps streaming, stops on request. |
| `capabilities.test.ts` | `main/capabilities.ts`: builtin skill seeding into both roots, thread-bound skill attachments, Emma-authored tools, stdio MCP review/search/call/cleanup, Codex TOML, JSONC trailing commas. |
| `catalog.test.ts` | `main/catalog.ts`: on-disk catalog caching, change reporting, surviving a dead fetch, OpenRouter parse/price/filter, free-chain ordering. |
| `cli.test.ts` | `shared/cli.ts` + `main/tools.ts`: ANSI stripping with line rewrites, each harness's start/resume argv, and that starting a CLI is bash-gated while watching one is not. |
| `clip.test.ts` | `main/clip.ts` (Electron stubbed): browser allowlisting for front-tab AppleScript, clip image ordering and resize rules, byte-wise text trimming. |
| `computer.test.ts` | `main/computer.ts`: action validation before anything touches the screen, the `quick_ask.m` payload shape, zoom-crop cursor readback, abort poisoning, step/rate/log ceilings. |
| `document.test.ts` | `src/document.ts`: markdown → document structure, real links only, image carousels, identifier underscores are not emphasis. |
| `folders.test.ts` | `main/folders.ts` + `shared/folders.ts`: grant listing skips vendored and binary files, reads cannot climb out, duplicate grants dedupe, context blocks drop whole sections at budget. |
| `git.test.ts` | `shared/git.ts` + `main/git.ts` against a real temp repo: diff splitting and per-file caps, moving a thread onto a worktree and back, surfacing a git refusal. |
| `harness.test.ts` | `main/harness.ts` end-to-end against the fake agent: workspace escape detection, streaming deltas, tool-call reporting, permission allow/deny, subagent fan-out, Emma-side callbacks, session displacement, turn serialization, compaction ordering, idle-window survival, experiment options. |
| `highlight.test.ts` | `src/highlight.ts`: highlighting never loses or reorders a character; `#` is a comment only where the language says so. |
| `improvement.test.ts` | `shared/improvement.ts` + `shared/trace.ts`: reading a turn back off its own trace, requiring both arms and a real gap before calling a trial. |
| `ipc.test.ts` | The widest one — `main/ipc.ts`, `overlay.ts`, `ndjson.ts`, `imports.ts`, `plugins.ts`, `shared/settings.ts`, `shared/voice.ts`, plus renderer `layout`/`activity`/`drafts`: exact-payload IPC validation, trusted sender origin, HTTP(S)-only navigation, bounded NDJSON framing, one-shot bounded JPEG screen context, CSS-only UI plugins, settings round-trips. |
| `knowledge-author.test.ts` | `main/knowledge-author.ts`: a page authored from model output, the deterministic local scaffold with no model, refusal of non-JSON output, defensive block reading. |
| `markdown.test.ts` | `src/markdown-parse.ts`: pipe tables need a dashed row, verbatim fenced code, inline spans, clickable file paths vs prose in backticks. |
| `memory.test.ts` | `main/memory.ts` + `main/advisor.ts`: every memory command round-trips, error strings match what the model was told, nothing escapes the memory root, an unconfigured advisor returns directions. |
| `panes.test.ts` | Not a module test: reads `src/styles/conversation.css` and `agents.css` and asserts `grid-template-columns: minmax(0, 1fr)` so no wide child can widen a pane. |
| `plan.test.ts` | `shared/plan.ts` + `main/plans.ts`: the markdown file *is* the plan, thread ownership, wave layout and folding, cycle detection, mid-run rewrite, concurrent ticks losing nothing. |
| `research.test.ts` | `main/research.ts`: last-printed metric wins and a missing one is a crash, judge-answer parsing, keep/revert both ways, budget exhaustion naming the culprit, `results.tsv` format, micro-dollar math. |
| `runs.test.ts` | `src/runs.ts` + `src/context.ts`: typed-while-running turns queue in order, blocks stay in arrival order with reasoning in its own block, landed turns survive restart, a host-refused turn hands its text back once. |
| `search.test.ts` | `main/search.ts`: ripgrep and the grep fallback find identical lines, path/glob narrowing works in both, a search cannot climb out of a grant. |
| `setup.test.ts` | `main/setup.ts` + `shared/setup.ts`: every advertised permission maps to a real macOS privacy pane URL, the chosen knowledge folder persists and is created, writability is proved by writing. |
| `slash.test.ts` | `shared/slash.ts` + `src/context.ts`: `/` and `@` open only at word starts, prefix-beats-contains ranking, insertion and caret placement, `@path` tokens, artifacts listed ahead of disk files. |
| `system-prompt.test.ts` | `main/system-prompt.ts` + `main/connections.ts`: only the on-trial change rides the turn and only on its arm, the harness instructions file matches the block, only enabled-and-installed connections reach the agent. |
| `thinking.test.ts` | `shared/thinking.ts`: a leading scratchpad splits off the answer, plain replies pass through, an unclosed block is all scratchpad. |
| `threads.test.ts` | `src/threads.ts` + `main/tagger.ts` (with a faked `localStorage`): sidebar ordering, sub-threads nesting and bubbling, auto-tagging only after enough hand tags, guesses never overriding a user tag. |
| `trace.test.ts` | `shared/trace.ts`: depth-first span layout, open spans running to the clock, context-growth axis, encode/decode round-trip, oversized traces losing their middle, round-number ticks. |
| `usage.test.ts` | `shared/usage.ts`: repeated segments count turns and keep the latest size, the cell grid stays full, the unobserved half of a turn is a residual, speed pools per context doubling. |
| `verifier.test.ts` | `main/verifier.ts` + `main/agent-loop.ts`: retry on empty verdicts and give up rather than guess, the review prompt carrying goal and exact command, refusal of a cleartext endpoint, `auto` gating exactly what `ask` gates. |
| `vision.test.ts` | `main/vision.ts`: the image travels as an image content part beside the question, in-image text framed as content never instructions, exactly one image per call. |
| `visualize.test.ts` | `shared/visualize.ts`: a visualization is refused before it can draw claims the numbers don't support, the picture rides in the tool *arguments* because results are cut at 200 bytes. |
| `web-search.test.ts` | `main/web-search.ts` (`net.fetch` stubbed): 4get parsing, fallback to a second 4get instance and only for 4get, in-window cache hits, key-requiring providers saying so. |
| `web.test.ts` | `main/ipc.ts` `publicUrl` + `main/tools.ts`: a model-chosen URL cannot reach the local network; the web tools accept exactly the arguments they advertise. |
| `workflow.test.ts` | `shared/workflow.ts`: legacy single-prompt jobs migrate to one agent step, broken graphs are refused with a reason, condition parsing, variable round-trip with byte cap, cron preset round-trips, Sunday is 0. |

Filenames are sometimes indirect: `agent.test.ts` tests `main/agent-loop.ts`,
`web.test.ts` tests `publicUrl` out of `main/ipc.ts`, `panes.test.ts` tests CSS.

### Rust

```sh
cargo test --workspace --locked
```

Unit tests live beside the code in `#[cfg(test)] mod tests`; the crate-level
integration tests are at the bottom of [`crates/core/src/lib.rs`](../crates/core/src/lib.rs).
`--locked` is part of the check list — a change that needs a `Cargo.lock` update
should update it deliberately.

### Zig

Two separate suites, two separate build files:

```sh
zig build test -Doptimize=ReleaseSafe --build-file agent/build.zig
(cd harness && zig build test)
```

`agent/build.zig` defines exactly one step, `test`, over `src/main.zig`.
`harness/build.zig` defines many; `test` is the one the check list runs, and it
also pulls in the UI-activity benchmark tests. The others are opt-in:
`run-json-schema-corpus`, `run-mcp-stdio-dispatcher-e2e`, `bench-file-index`,
`bench-ui-activity`, `bench-approval-review`, `pgso-ir`, `libfx-napi`, and a
generated `<name>-wasm` per WASM target.

## The dev loop

[`scripts/dev.mjs`](../desktop/scripts/dev.mjs) is 24 lines and strictly
sequential. Each step waits for the previous one to exit zero:

1. `npm run build:host` — `cargo build -p emma-host`, then `zig build` for the agent, then `zig build` for the harness.
2. `npm run build:native` — the two clang helpers, and `emma-option-tap --self-test`.
3. `npm run build:main` — `tsc -p tsconfig.main.json`.
4. `npm exec vite -- --host 127.0.0.1` — the renderer dev server, left running.
5. After an 800 ms wait, `npm exec electron .` with `EMMA_DEV_SERVER_URL=http://127.0.0.1:5173`.

When Electron exits, Vite gets `SIGTERM` and the script exits with Electron's
code.

**What reloads on change:**

- `desktop/src/**` — Vite HMR. Save and look.

**What does not:**

- `desktop/main/**`, `desktop/shared/**` — compiled once in step 3. Quit Emma and rerun `npm run dev`.
- `crates/**`, `agent/**`, `harness/**` — compiled once in step 1. Same.
- `desktop/native/**` — compiled once in step 2. Same.

There is no watcher. Anything outside `src/` means a full restart.

`npm run vendor:ripgrep` is *not* in the dev path — `npm start` and
`npm run package:mac` run it, `npm run dev` does not. On a fresh clone the
`ripgrep` tool falls through to whatever `rg` is on your PATH, then to `grep`.

Two dev instances fight over the user data directory. Give the second one its
own with `--user-data-dir`.

## Adding things

### A new agent tool

Four places, in this order.

**1. Declare it.** In [`shared/permissions.ts`](../desktop/shared/permissions.ts):

- add the name to `AGENT_TOOLS`
- add a row to the `GATES` table — one `ToolGate` (`"hidden"`, `"ask"`, `"auto"`) per mode in `plan`, `ask`, `acceptEdits`, `full`. There is no `auto` column: `auto` reads `ask`'s and sends the question to the verifier model instead of the user.
- add an entry to `TOOL_CATALOG` — label, one-line blurb, group. Settings → Tools renders this. A test asserts `GATES` and `TOOL_CATALOG` cover exactly the same names, so skipping either fails.

Pick the gate by blast radius, not by how it sounds. Reads are `auto`
everywhere. Anything that writes inside Emma's own data folder sits with
`write_skill` (`hidden` in `plan`, `auto` elsewhere). Anything that runs code or
reaches the user's machine sits with `bash` (`hidden`/`ask`/`ask`/`auto`) and
never lower.

**2. Describe it.** In [`main/tools.ts`](../desktop/main/tools.ts): add a
`ToolDefinition` to `DEFINITIONS` with a `needs` field (`"always"`, `"folders"`,
`"computer"`, `"mcp"`, `"canSpawn"`), add a variant to the `ToolCall` union, and
add its argument parsing. The file is pure — no Electron — so the gate, the
schemas, and the refusal messages are all testable.

Ceilings, all asserted by tests: `MAX_ADVERTISED_TOOLS` 32, `MAX_TOOL_NAME_BYTES`
128, `MAX_TOOL_DESCRIPTION_BYTES` 4 KiB, `MAX_TOOL_SCHEMA_BYTES` 8 KiB,
`MAX_TOOL_OUTPUT_BYTES` 16 KiB.

**3. Run it.** In [`main/main.ts`](../desktop/main/main.ts), next to the runtime
that owns the resource. This is where Electron, the filesystem, and the pointer
live.

**4. Bridge it.** The harness has to advertise the tool to the model. Add a
`ToolSpec` to the right group in
[`harness/src/builtins/emma/`](../harness/src/builtins/emma) — `threads.zig`,
`knowledge.zig`, `system.zig`, `extensions.zig`, or `overrides.zig` — and the
group's `all` array flows into
[`emma_tools.zig`](../harness/src/builtins/emma_tools.zig). Every spec must have
`executor_kind = .emma`, `advertisement = .on_select`, `requires_approval =
false` (Emma gates it on its own side), and `gateway_schema.name` equal to
`name`. Tests in `emma_tools.zig` assert all of that plus the description cap.
The schema is duplicated between `tools.ts` and the Zig spec — keep the wording
identical.

At runtime the harness calls `_emma/callTool` back down the ACP pipe, and
[`harness.ts`](../desktop/main/harness.ts) routes it into main's dispatch.
Nothing in `harness/src/tools/emma/` executes anything itself.

### A new IPC channel

Three files, plus a validator.

1. **[`main/ipc.ts`](../desktop/main/ipc.ts)** for a host-RPC method: add the name to `methods`, its required params to `fields`, any optional ones to `optionalFields`. `validateRequest` refuses unknown keys, non-strings, blanks, anything over the per-key length cap, and any request whose serialized form passes 128 KiB. For a channel that does not reach the host, write the validator next to the handler and call it first.
2. **[`main/main.ts`](../desktop/main/main.ts)**: register `ipcMain.handle` or `ipcMain.on`. Start with the sender check — `event.senderFrame !== event.sender.mainFrame || !trustedSender(event.senderFrame.url, app.getAppPath(), process.env.EMMA_DEV_SERVER_URL)` — then validate the payload, then act.
3. **[`main/preload.ts`](../desktop/main/preload.ts)**: add one method to the object handed to `contextBridge.exposeInMainWorld("emma", …)`. Keep it narrow: pass values, not objects the renderer built. For a main→renderer event, expose an `onX(listener)` that returns its own unsubscribe and drops any payload that fails a shape check inside the wrapper.
4. **[`src/types.ts`](../desktop/src/types.ts)**: declare it on the `window.emma` type so the renderer can call it.

### A renderer view

Views live in [`desktop/src`](../desktop/src) as `.tsx` files —
`artifacts.tsx`, `agents.tsx`, `schedule.tsx`, `research.tsx`, `plan.tsx`,
`git.tsx`, `cli.tsx`, `editors.tsx`, `timeline.tsx` are the pattern. Add the
file, wire it into the pane switch in [`App.tsx`](../desktop/src/App.tsx), and
put its styles in a new `src/styles/<view>.css` importing tokens from
`tokens.css`. Read [`design-system.md`](design-system.md) first — it is the
contract for spacing, type and color.

No Node. No Electron import. Anything that touches disk, a process, the network
or a model goes through `window.emma`.

### A settings field

[`shared/settings.ts`](../desktop/shared/settings.ts):

1. Add the field to the `UserSettings` interface.
2. Give it a value in `defaultSettings`.
3. Validate it in `validateSettings` — and return it in the object at the end, or it silently vanishes on the next save.
4. If it is optional in older stores, fall back rather than throw: `const x = settings.x ?? defaultSettings.x`. A store written before your field existed is not corrupt.
5. Add the control in `App.tsx`'s settings pane.

Settings are stored in the renderer's `localStorage` under `emma.settings.v1`,
validated on read and on write. Anything main needs is pushed to it over IPC —
the overlay preferences and the tool settings are the two existing channels.

## Debugging

**Renderer.** DevTools is a normal Electron window. In a `npm run dev` session
the renderer is served from `http://127.0.0.1:5173`, so source maps and HMR work.

**Main.** `console.log`/`console.error` from `desktop/main` go to the terminal
that ran `npm run dev`. There is no log file. `emma-cli`'s stderr is forwarded
line by line with an `emma-cli: ` prefix; the Rust host prints `emma-agent fault:`
and `emma-agent error code:` lines when the sidecar misbehaves.

**The NDJSON stream.** Electron ↔ `emma-host` is newline-delimited JSON over
stdio: one request object per line, one response envelope per line, plus `delta`
lines while a turn streams. Framing and bounds are in
[`ndjson.ts`](../desktop/main/ndjson.ts) (128 KiB per request) and
[`runtime.rs`](../crates/host/src/runtime.rs) (256 KiB per response line). A
response whose `id` does not match the request is a protocol fault, not something
to pass on. You can run `emma-host` by hand and type JSON at it — set
`EMMA_PROVIDER_BASE_URL`, `EMMA_PROVIDER_MODEL` and `EMMA_PROVIDER_CREDENTIAL_ENV`
together, or leave all three unset for the local fallback.

**Driving the running app over CDP.** Three scripts in `desktop/scripts`, all
talking to a debugger port (`EMMA_CDP_PORT`, default 9222 for `drive.mjs`, 9223
for the other two):

```sh
node desktop/scripts/drive.mjs 'await window.emma.request("snapshot", {})'
node desktop/scripts/shot.mjs 9223 /tmp/emma-shots 1440 900
node desktop/scripts/dismiss.mjs 9223
```

`drive.mjs` evaluates an expression in the main window against the real
`window.emma` bridge, so it exercises the same IPC path a click does — including
settings writes, which are just `localStorage` under `emma.settings.v1`.
`shot.mjs` captures screenshots. `dismiss.mjs` marks the first-launch import
dialog seen and reloads.

## Packaging

```sh
npm run package:mac
```

That runs, in order: `cargo build --locked --release -p emma-host`, `zig build
-Doptimize=ReleaseSafe` for the agent, the same for the harness,
`npm run build:native`, `npm run vendor:ripgrep`, `npm run build`, then
`electron-packager`.

The packager call is `electron-packager . Emma --platform=darwin --arch=arm64
--out=release --overwrite --asar`. Apple silicon only.

**What it excludes:**

```
^/(assets|src|main|shared|test|screenshots|native|scripts|skills|vendor|node_modules)(/|$)
^/dist-main/(src|test)(/|$)
^/(index\.html|eslint\.config\.mjs|vite\.config\.mts|tsconfig\.(main|renderer)\.json|\.package-lock\.json)$
```

Source, tests, and configs never ship. `dist-main/main` and `dist-main/shared`
do; `dist-main/src` and `dist-main/test` do not.

**What it adds as extra resources**, all landing in
`Emma.app/Contents/Resources/`:

| Resource | From |
| --- | --- |
| `emma-host` | `../target/release/emma-host` |
| `emma-agent` | `../agent/zig-out/bin/emma-agent` |
| `emma-cli` | `../harness/zig-out/bin/emma-cli` |
| `emma` | `../agent/emma` (the bash front end) |
| `rg` | `vendor/rg` |
| `emma-option-tap` | `dist-native/emma-option-tap` |
| `emma-transcribe` | `dist-native/emma-transcribe` |
| `skills` | `skills/` |

`--extend-info=native/Info.extra.plist` merges
`NSSpeechRecognitionUsageDescription` into the bundle's `Info.plist`. TCC reads
the *responsible* process's plist, and for the spawned `emma-transcribe` helper
that is Emma.app — so the string has to be there and not in the helper.
`--app-bundle-id=dev.local.emma` sets the identifier.

At runtime, `binary(name)` in `main.ts` resolves each of these from
`process.resourcesPath` when packaged, and from the build outputs
(`target/debug/emma-host`, `agent/zig-out/bin/emma-agent`,
`harness/zig-out/bin/emma-cli`, `desktop/vendor/rg`) when not.

### Release blockers

Emma is not release-ready. Open items:

- **`dev.local.emma` is provisional.** It is a development identifier, not a publisher one.
- **No publisher-owned bundle ID.** Nobody owns the reverse-DNS prefix.
- **No declared minimum macOS version of Emma's own.** The bundle reports `LSMinimumSystemVersion 12.0`, but that is Electron's default carried through — Emma has not stated and tested a floor. The two native helpers are built `-mmacosx-version-min=12.0`.
- **No signing identity.** The build is unsigned and unnotarized, so Gatekeeper blocks it on any Mac but the one that built it. Unsigned dev builds also never get macOS notification permission.
- **No distribution and no update owner.** There is no channel and no updater. `emma-cli` ships inside the app and its self-update path returns `null` on purpose.

## Licensing

| Component | License |
| --- | --- |
| [`harness/`](../harness) | Apache-2.0. [`LICENSE`](../harness/LICENSE), obligations tracked in [`FORK.md`](../harness/FORK.md) and [`THIRD_PARTY_NOTICES.md`](../harness/THIRD_PARTY_NOTICES.md). Apache-2.0 §4 requires keeping both, and that survives renaming — the fork may not drop them. |
| `crates/` | Declares `license = "Apache-2.0"` in [`Cargo.toml`](../Cargo.toml). Not published (`publish = false`). |
| Departure Mono | SIL Open Font License 1.1, © 2022–2024 Helena Zhang. [`DepartureMono-LICENSE.txt`](../desktop/assets/DepartureMono-LICENSE.txt). |
| Brand assets | [`BRANDS-NOTICES.md`](../desktop/assets/BRANDS-NOTICES.md) and [`icon-sources.md`](icon-sources.md). Mostly Simple Icons (CC0 1.0) and official press kits. Trademarks stay with their owners; do not recolor, redraw or combine with Emma branding. |
| ripgrep | Downloaded at build time, not vendored in git. MIT/Unlicense, BurntSushi. |

**There is no root `LICENSE` file.** The repository as a whole is unlicensed
until one lands. That is an open item, not an oversight to work around: `harness/`
carries its own license and `crates/` declares one in metadata, but `desktop/`,
`agent/`, `website/` and `docs/` have no stated terms.

## See also

- [getting-started.md](getting-started.md) — install and first run
- [architecture.md](architecture.md) — how the processes fit together
- [concepts.md](concepts.md) — threads, agents, knowledge, artifacts
- [data.md](data.md) — every file and environment variable
- [harness.md](harness.md) — `emma-cli` and the ACP session
- [cli.md](cli.md) — the `emma` terminal front end
- [permissions.md](permissions.md) — the modes and the gate table
- [tools.md](tools.md) — what each agent tool does
- [models.md](models.md) — providers, routing, the catalog
- [plugins.md](plugins.md) — UI plugins and MCP servers
- [design-system.md](design-system.md) — the renderer's visual contract
- [autoresearch.md](autoresearch.md) — the experiment loop
- [jobs.md](jobs.md) — scheduled workflows
- [knowledge.md](knowledge.md) — the knowledge base and its Markdown mirror
- [computer-use.md](computer-use.md) — pointer and screen control
- [notch.md](notch.md) — Quick Ask
- [voice.md](voice.md) — dictation
- [privacy.md](privacy.md) — what leaves the Mac
- [icon-sources.md](icon-sources.md) — where the brand marks came from
- [troubleshooting.md](troubleshooting.md) — when it breaks
