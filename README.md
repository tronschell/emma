<div align="center">

<img src="desktop/assets/emma.webp" alt="Emma: a hand-drawn window with two eyes and a pink bow" width="200">

# Emma

**A macOS agent workspace that keeps what mattered as Markdown you own.**

Double-tap left Option. Ask. Keep the answer in your own vault.

[![Platform](https://img.shields.io/badge/platform-macOS%20·%20Apple%20silicon-1c1c1c?style=flat-square&logo=apple&logoColor=white)](#requirements)
[![Electron](https://img.shields.io/badge/Electron-43.4.0-2b2e3a?style=flat-square&logo=electron&logoColor=9feaf9)](desktop/package.json)
[![Rust](https://img.shields.io/badge/Rust-1.97.1-2b2119?style=flat-square&logo=rust&logoColor=e6683c)](rust-toolchain.toml)
[![Zig](https://img.shields.io/badge/Zig-0.16.0-2e2416?style=flat-square&logo=zig&logoColor=f7a41d)](harness/build.zig.zon)
[![Node](https://img.shields.io/badge/Node-24%2B-1f2a1f?style=flat-square&logo=nodedotjs&logoColor=5fa04e)](desktop/package.json)
[![Docs](https://img.shields.io/badge/docs-docs%2F-1c1c1c?style=flat-square)](docs/README.md)

<img src="desktop/screenshots/workspace-thread.png" alt="Emma running the Splitleaf release plan: threads and projects down the left, the answer in the middle with four finished subagents under it, and the context bar on the right showing thread stats, the context-window ledger, and the 24-step plan graph" width="900">

</div>

---

## What Emma is

- **One loop, every surface.** The composer, Quick Ask, a quick action, a scheduled job, and an autoresearch iteration all enter the same interception in Electron main — so exactly one place decides how many steps a turn gets and what has to ask first.
- **A real agent.** It reads and writes files in folders you attach, searches, runs shell commands, drives the screen, calls MCP tools, installs its own skills mid-turn, and spawns subagents.
- **A metaharness.** Her own agent harness runs every turn — and she directs Claude Code, Codex, Pi, OpenCode, and Cursor as workers in your folders, watching their terminals live and feeding them the next prompt.
- **She improves herself.** The Agent page reads her own traces, drafts a change about what keeps going wrong, runs it live against a control, and proves it on a replay bench before it rides every turn.
- **Notes you can walk away with.** Every save is one Markdown note in a vault or folder *you* picked. No second copy, no database, readable without Emma.
- **You hold the permission dial.** Four modes, one table, enforced in the trusted process. Escape stops a run in every one of them.

## Quickstart

```bash
npm install --prefix desktop
npm run dev
```

Then double-tap the physical **left Option** key. macOS will ask for Accessibility access so Emma can observe that modifier-only gesture — the listener discards every other key event.

Emma needs a model to answer: there is no offline fallback. Set a key and pick a model in **Settings → Models**, or:

```bash
export OPENROUTER_API_KEY=your-openrouter-key
```

New to the repo? Start at **[docs/getting-started.md](docs/getting-started.md)**.

### Requirements

| | |
|---|---|
| **OS** | macOS on Apple silicon |
| **Node** | 24+ |
| **Rust** | 1.97.1 (`rust-toolchain.toml` pins it) |
| **Zig** | 0.16.0 |
| **Xcode CLT** | `clang` builds three native helpers |

`npm run dev` builds the Rust host, the Zig harness, and the native helpers, then starts Vite and Electron against it. `npm --prefix desktop start` does the same without the dev server.

## A job, end to end

The thread at the top of this page is one piece of work: **Splitleaf**, a shared-expenses iOS app with an offline-first store and a small Rust sync server. Emma is running its release plan on **GLM 5.3 Flash** — 24 steps, nine waves, 35 edges — and the whole run is one Markdown file she wrote and keeps editing, `plans/ship-splitleaf-1-0.md`.

<img src="desktop/screenshots/plan-subagents.png" alt="The plan open fullscreen: the dependency graph on the left with 24 numbered nodes coloured by state, and the step list on the right showing each step's dependencies, brief, and checklist" width="900">

Five independent starts — the schema, the iOS shell, the sync model, the rate source, signing — and then it narrows twice: the schema and the sync model meet at the merge engine, the store and the endpoint meet at the sync wiring. Emma runs each wave's independent steps as **parallel subagents**, one brief each, and folds their results back into the same file.

Thirteen steps are done. Three are running. One is **failed**, and that is the point:

> **signing** — Stopped. The team has no distribution certificate and creating one needs your Apple ID at developer.apple.com. Building with `CODE_SIGNING_ALLOWED=NO` would produce an `.ipa` TestFlight rejects, so I did not.

A step Emma cannot finish stays red and keeps the two steps downstream of it waiting. Ask *what is actually blocking 1.0* and the answer comes off the graph: one certificate she is not allowed to create, and one test — two phones in a tunnel — that the last three waves all hang from.

## What a turn can do

The picker beside ＋ chooses how much Emma may do without asking:

| Mode | | What it means |
|---|---|---|
| `ask` | ◈ | Every write, command, and click asks first. **Default.** |
| `acceptEdits` | ◆ | File edits go through; commands and the pointer still ask. |
| `auto` | ⬗ | A separate verifier model reads each gated call; anything it won't clear still asks you. |
| `full` | ⬥ | Nothing asks. Escape still stops a run. |

One table in [`desktop/shared/permissions.ts`](desktop/shared/permissions.ts) decides what each mode advertises and what it gates, so the label you picked and the check that enforces it can't drift apart. A subagent inherits the mode. Of Emma's 26 tools, the gate table asks first on eight: `browser`, `cli`, `computer`, `install_mcp`, `run_tool`, `secret`, `workflow`, and `autoresearch`.

Emma's own tools are separate from the harness's builtins — file reads and writes, search, shell, and subagents belong to the harness.

Full catalog and the complete gate matrix: **[docs/tools.md](docs/tools.md)** · **[docs/permissions.md](docs/permissions.md)**

### Subagents and sub-threads

`plan` breaks a job into steps and runs the independent ones as parallel subagents. A running subagent opens in its own tab, where you can steer or stop it; when it finishes it collapses into a chip in the transcript that opens the same way. A `threads` call instead starts a full sub-thread nested under its parent, with an agent of its own.

## Controlling the Mac

Ask for something that needs the screen and Emma reaches for the `computer` tool: it captures the display, moves the pointer, clicks, and types until the task is done.

It is an ordinary tool, so the mode picker decides it. What the mode never changes — there is no switch for any of these:

| | |
|---|---|
| **Ceilings** | 20 steps, 400 actions, 10 minutes per run |
| **Pacing** | 40 ms minimum between actions |
| **Input caps** | 4096 characters typed, 300 s waits, 32 key repeats |
| **Always on** | The banner above every app, the action log, and Escape from anywhere |

Screenshots stay inside Emma's process; the tool answers in text. The `vision` tool is the deliberate exception that sends an image to a model.

Details: **[docs/computer-use.md](docs/computer-use.md)**

## The context bar

<img src="desktop/screenshots/settings-context-bar.png" alt="Settings → Context bar: page tabs, a list of components to drag in and out of the column, and a live preview of the bar at its default 288px width" width="900">

The panel down the right of a thread is components you arrange. Ten ship: thread stats, the context-window ledger, the turn timeline, the plan graph, subagents, sub-threads, Git, and three readings of one machine sampler — numbers, sparklines, and 16-cell meters.

| | |
|---|---|
| **Which, and in what order** | Drag any of the ten in or out; reorder by dragging. |
| **Layout** | Stats, context, subagents, and sub-threads read down the column or across it. |
| **Pages** | Up to four, each named, switched from the bar's own tabs. |
| **Width** | 260–360 px, 288 by default, or a 30 px collapsed rail. |

The arrangement is validated on the way in, so a hand-edited settings file can't produce a bar that won't paint. If none of the ten is what you want, a `code` artifact claiming the `context` surface *becomes* the bar, with the built-in as fallback.

The context-window ledger is the centerpiece: one `Ledger` object feeds every component on the page, so the stats tiles, the window table, and the timeline's context axis are three readings of one number and cannot disagree. Characters are counted on this Mac at ~4 per token, the system-prompt side is computed as the *residual* of the provider's own input count, and the `(i)` in the thread bar exports all of it as a folder of CSVs.

Details: **[docs/context-bar.md](docs/context-bar.md)**

## The timeline: every turn, on the record

Each finished turn leaves a **trace** — a span tree in the shape MLflow and LangSmith draw ([`desktop/shared/trace.ts`](desktop/shared/trace.ts)). One span for the run, one per model request, one per tool call, each with its wall clock, status, the arguments as the model sent them, and a token estimate of what it added to the window. The context-bar **Timeline** component lays them out as a waterfall on one shared axis; a second reading re-measures the same spans in **tokens instead of milliseconds**, so a bar's width becomes its share of the turn's context growth. The same tree is rendered as indented text by `read_trace`, which is how Emma reads what a past turn of hers actually did.

Traces are durable: appended to the thread's Markdown record, capped at 64 per thread and 16 KiB each. From them the thread stats compute tok/s, generation time, a rate-by-context curve, and the failure counts the Agent page reads.

## The Agent page: Emma improves herself

[`docs/agents.md`](docs/agents.md) — implemented in [`desktop/src/AgentView.tsx`](desktop/src/AgentView.tsx), [`desktop/shared/improvement.ts`](desktop/shared/improvement.ts), [`desktop/shared/bench.ts`](desktop/shared/bench.ts).

<img src="desktop/screenshots/agent-dashboard.png" alt="The Agent page: live threads, turns asked, subagents spawned and a day streak across the top, then a per-day activity strip, threads started over a month, projects over time, and the thread tree with each subagent under its parent" width="900">

Emma reads the span traces her own finished turns left behind, names the friction that keeps repeating, drafts one change about it, and then — this is the part that matters — tries to prove the change helped before keeping it.

- **Friction.** The page groups every failed tool call and verifier block from the last 30 days by tool, with the evidence lines on screen. Two turns makes a pattern.
- **A draft, two levers.** A proposed change edits one of two standing texts: `instructions` (what every turn carries) or the `verifier` rules (what Auto mode reviews a call against). You can also hand the drafting to Emma herself — *Ask Emma to write it* runs one turn and drops its answer into the draft.
- **A live trial.** Once you approve, subsequent turns are dealt arm A (without the change) or arm B (with it) at random, and the page shows a hint — `NO SIGNAL`, `WORTH BENCHING`, `TOO EARLY` — that is explicitly not a measurement.
- **The replay bench.** The proof is your own saved cases replayed under both arms back to back, at a case count declared before the run starts. A finished run needs both a paired t-test *and* an exact sign test to clear at six or more pairs; anything short is `stopped`, and a stopped run stays pending forever — there is no reading to peek at and no salvage rule.
- **Only a bench run can keep a change.** **Keep it** is the only button in the app that writes `Kept`. **Revert it** needs no evidence, at any time. Kept lessons ride every future turn; a kept change is retestable, and every attempt of a change is numbered on the record.

## Memory that travels

The `memory` tool is Anthropic's memory-tool contract against a real directory on this Mac: the model addresses `/memories/...` and [`desktop/main/memory.ts`](desktop/main/memory.ts) maps it onto `<userData>/memories`, with view/create/str_replace/insert/delete/rename over plain files (256 KiB each, 256 files). Every path is resolved and prefix-checked twice, so `/memories/../../secrets.env` is refused before any I/O. The tool's description rides every turn, but memory's *contents* never do — they enter a conversation only when the model calls the tool to read them, which is what makes them Emma's to curate.

## The notch surfaces

<img src="desktop/screenshots/notch-island.png" alt="Quick Ask open at the notch, wrapping the camera housing: a draft in the composer, the mode and model chips along the foot" width="820">

Emma measures the real camera housing per display through the `emma-option-tap` helper. Quick Ask takes over the menu bar on both sides of the housing and hangs below it. Displays without a housing fall back to a validated virtual notch, calibrated in Settings.

While Emma is idle a click-through sliver sits over the housing; hovering reveals a sparkle wave, and clicking opens Quick Ask. Dismissing an idle overlay destroys its renderer to release memory while preserving an unsent draft.

<img src="desktop/screenshots/notch-radial.png" alt="The radial command ring orbiting the cursor" width="420">

Three quick actions run from `Command-1/2/3`. The radial ring orbits the cursor, holding orbs bound to commands from a fixed catalog that **main validates rather than trusting the renderer**. Either surface can be switched off.

Details: **[docs/notch.md](docs/notch.md)** · **[docs/voice.md](docs/voice.md)**

## Knowledge base

<img src="desktop/screenshots/knowledge-base.png" alt="The knowledge view: one row per saved note — its kind, title, when it was saved, its tags, the source it came from, and the Markdown file it was written to" width="900">

Point Emma at an **Obsidian vault or any plain folder** you already own. The `keep` tool writes one Markdown note per save into `<vault>/knowledge-base`, with attachments alongside and YAML front matter on top. A small model titles and tags it.

There is no mirror and no second copy — the folder you picked *is* the storage, and Emma never reads it back to work. Saving a browser page pulls it out of whichever whitelisted browser is in front, keeping its favicon and lead images.

Details: **[docs/knowledge.md](docs/knowledge.md)**

## Jobs

<img src="desktop/screenshots/scheduled-jobs.png" alt="The Scheduled view: an overnight TestFlight report — its cron trigger, the prompt it runs, the mode it runs as, six steps including an if-branch on whether anything is on fire, and its past runs" width="900">

A **scheduled job** is one validated trigger plus a graph of three node kinds: `agent` runs a prompt, `set` stores a value, `if` branches. Triggers are five-field UTC cron, `manual`, `after <job-id>`, or an app event. Jobs run only while Emma is open, create normal threads under the mode they were saved with, and never keep a note or write a skill silently.

An **autoresearch job** is a long experiment loop against a git project on this Mac: propose one change, run the eval command, read the metric, keep or revert the commit, until a time, token, or spend budget stops it. The metric and its rubric are immutable for the life of the job.

Details: **[docs/jobs.md](docs/jobs.md)** · **[docs/autoresearch.md](docs/autoresearch.md)**

## Models and credentials

<img src="desktop/screenshots/model-picker.png" alt="The model picker open over the Splitleaf thread, filtered to glm: the live OpenRouter catalog with context lengths and starred favourites, provider marks down the side, and a thinking slider along the foot" width="900">

Point Emma at any OpenAI-compatible local or hosted endpoint from Settings → Models. The credential setting names an environment variable and never contains the key: a pasted key is encrypted with the OS keychain and reaches the harness only through its spawn environment — the renderer gets back a mask.

For **OpenRouter**, the model picker loads the live tool-capable catalog. Browsing needs no key because the listing endpoint is public; Electron caches it so the picker paints offline, and a bundled seed covers a first launch with neither.

Settings → Models has a **Private routing** switch. With it on, Emma demands endpoints that neither train on nor retain your prompts, so a turn fails rather than quietly routing to a provider that might keep it. It is off by default because no free OpenRouter endpoint qualifies. Account-level logging settings still sit above it — review them at <https://openrouter.ai/settings/privacy>.

Details: **[docs/models.md](docs/models.md)** · **[docs/privacy.md](docs/privacy.md)**

## Extending Emma

First launch and Settings can register existing Codex, Claude, Antigravity, Pi, OpenCode, Cursor, Windsurf, and Devin skill/MCP locations by reference, without copying their config. Emma ships her own skills in [`desktop/skills/`](desktop/skills) and owns two capability files under her user data, so a skill or MCP server she installs mid-turn is usable in that turn. CSS plugins can restyle the UI.

### Emma builds her own interface

[`docs/plugins.md`](docs/plugins.md) · concepts in [`docs/concepts.md`](docs/concepts.md) — the `component` and `artifact` tools in [`desktop/main/components.ts`](desktop/main/components.ts) and [`desktop/main/artifacts.ts`](desktop/main/artifacts.ts).

Emma can write parts of the app she is running in, and the location is always yours to choose:

- **Components.** `component {"action":"place"}` lights the window up so you click the zone the new thing belongs in — the sidebar, the context bar, or the composer — and `create` is refused until you have. The component is React, served over `emma-component://` and mounted by portal at your anchor; every `rewrite` bumps its version and reloads it in place, which is the iteration loop. Delete from the ⋯ in its corner or Settings → Built by Emma.
- **Artifact surfaces.** A `code` artifact claiming one of four surfaces — `navbar`, `chat`, `notch`, `context` — is loaded as a real module and *becomes* that region, handed the same props the built-in got. The built-in is the fallback the moment the module throws. The source sits on the Artifacts page like any other file, so you can read what is running and delete it.
- **Drawings, not artifacts.** `visualize` renders an inline page in the transcript — charts, panels, anything it can draw — and saves nothing until you press Keep.

Settings → Connections lists third-party CLIs Emma can lean on — `gh`, `glab`, `jira`, `todoist`, `obsidian-cli`. A connection is a line of system context and nothing more; the binary was already reachable through the shell.

Details: **[docs/plugins.md](docs/plugins.md)** · **[docs/cli.md](docs/cli.md)**

### Emma in a terminal

The same agent runs headless — the harness below, without the window:

```bash
/Applications/Emma.app/Contents/Resources/emma-cli ask "explain this repository"
```

Bare `emma-cli` is a REPL in the current directory; `sessions`, `tasks`, and `permissions` are its other subcommands. Everything it does it gates on the tty under the same permission modes.

### Emma drives other coding agents

[`docs/cli.md`](docs/cli.md) — the `cli` and `cli_runs` tools in [`desktop/main/cli.ts`](desktop/main/cli.ts), catalog in [`desktop/shared/cli.ts`](desktop/shared/cli.ts).

Emma does not reimplement Claude Code or Codex. She runs the one you already have, in the thread's folder, shows the terminal live, and feeds it the next prompt. Five are catalogued — **Claude Code, Codex, Pi, OpenCode, and Cursor CLI** — each as three strings: how to start a session, how to resume one, and its unattended flag. Discovery, spawn, output, and the kill switch are all Emma's; the coding is the other agent's.

A **run is a conversation**, not a command: the child exits at the end of a turn, the run goes idle holding its transcript and session id, and the next `cli send` resumes it. The `cli` call blocks until the turn finishes and returns the outcome plus that turn's output; `cli_runs` lists runs, tails a terminal, or stops one. Each run lands in the UI as a tab wearing its harness's logo, floats as a PIP, or watches from the sidebar. One caveat is stated in the tool result itself: CLIs that only resume "the newest session in this folder" (Codex, OpenCode, Cursor) can't run two at once in the same folder.

Connections in Settings are the lighter half of the same idea: a line of system context per third-party tool you already have (`gh`, `glab`, `jira`, `todoist`, `obsidian-cli`) — no tool at all, because the binary was already reachable through the shell.

### The harness

[`harness/`](harness) is Emma's fork of [vercel-labs/fx](https://github.com/vercel-labs/fx), built as `emma-cli` and driven over the [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) from [`desktop/main/harness.ts`](desktop/main/harness.ts). It owns the agent loop, tool execution, hooks, skills, subagents, and the MCP client; Emma owns the window, the Markdown thread, and the answer to every permission question. Every turn runs on it — there is no second loop.

Provenance and the Apache-2.0 obligations are in [`harness/FORK.md`](harness/FORK.md).

Details: **[docs/harness.md](docs/harness.md)**

## Credits

Emma is built on other people's work.

> **The fork** — [vercel-labs/fx](https://github.com/vercel-labs/fx), Apache-2.0, © Vercel, Inc. and fx contributors, forked at `580a0c5`, upstream v0.0.4.
> **Vendored** — [ripgrep](https://github.com/BurntSushi/ripgrep) (MIT/Unlicense).
> **Desktop** — [Electron](https://github.com/electron/electron), [React](https://github.com/facebook/react), [TypeScript](https://github.com/microsoft/TypeScript), [Vite](https://github.com/vitejs/vite), [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss), [xterm.js](https://github.com/xtermjs/xterm.js), [Mermaid](https://github.com/mermaid-js/mermaid), [Recharts](https://github.com/recharts/recharts), [dnd kit](https://github.com/clauderic/dnd-kit), [ESLint](https://github.com/eslint/eslint).
> **Rust** — [serde](https://github.com/serde-rs/serde) and its closure.
> **Protocols** — Agent Client Protocol, Model Context Protocol, OpenAI Chat Completions.
> **Font** — [Departure Mono](https://departuremono.com) by Helena Zhang, OFL 1.1.
> **Icons** — [Simple Icons](https://github.com/simple-icons/simple-icons) (CC0), [Lobe Icons](https://github.com/lobehub/lobe-icons) (MIT), [Lucide](https://github.com/lucide-icons/lucide) (ISC), and official vendor kits.
> **Prior art** — [karpathy/autoresearch](https://github.com/karpathy/autoresearch).

Every dependency, its license, and what Emma uses it for: **[docs/credits.md](docs/credits.md)**. Vendor marks: **[docs/icon-sources.md](docs/icon-sources.md)**.

## Documentation

Everything lives in **[`docs/`](docs/README.md)**.

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Install, run, first turn, macOS permissions |
| [Concepts](docs/concepts.md) | Threads, runs, subagents, artifacts, context |
| [Context bar](docs/context-bar.md) | The thread inspector and how to rearrange it |
| [Architecture](docs/architecture.md) | Process boundaries and the trust model |
| [Permissions](docs/permissions.md) | The four modes and the full gate matrix |
| [Tools](docs/tools.md) | Every tool a turn can call |
| [Models](docs/models.md) | Providers, credentials, the OpenRouter catalog |
| [Privacy](docs/privacy.md) | What leaves this Mac, and what doesn't |
| [Knowledge](docs/knowledge.md) | The vault, `keep`, tagging, the note format |
| [Notch surfaces](docs/notch.md) | Quick Ask, the island, orbs, the radial ring |
| [Voice](docs/voice.md) | Dictation engines and drawing |
| [Terminal](docs/terminal.md) | The shell panel under a thread |
| [Jobs](docs/jobs.md) | Scheduled workflows, triggers, node graphs |
| [Autoresearch](docs/autoresearch.md) | The experiment loop and its immutable metric |
| [Computer use](docs/computer-use.md) | Driving the Mac, and every safety rail |
| [Goals](docs/goals.md) | One objective a thread keeps working at, with a token budget |
| [Agents](docs/agents.md) | Self-improvement: friction, trials, the replay bench |
| [Browser](docs/browser.md) | The per-thread Chromium view, the PIP, and clipboard history |
| [Mobile](docs/mobile.md) | Pairing a phone, and the relay you deploy for it |
| [CLI](docs/cli.md) | Driving other coding CLIs, and Connections |
| [Harness](docs/harness.md) | The fx fork, ACP, and what it reaches today |
| [Plugins](docs/plugins.md) | Skills, MCP servers, tools Emma writes, CSS |
| [Design system](docs/design-system.md) | Tokens, density, one visual language |
| [Development](docs/development.md) | Repo map, toolchains, builds, tests, packaging |
| [Data](docs/data.md) | Every file on disk and every environment variable |
| [Credits](docs/credits.md) | Every dependency and its license |
| [Troubleshooting](docs/troubleshooting.md) | When it doesn't work |

[`AGENTS.md`](AGENTS.md) is the source of truth for anyone — human or agent — changing this repository.

## Repository layout

```text
desktop/        Electron main/preload and React 19 workspace
  main/           lifecycle, windows, shortcuts, trusted IPC, the preload bridge
  src/            sandboxed React views and presentation state — no Node access
  shared/         types and tables both sides agree on
  native/         emma-option-tap, emma-transcribe and emma-pty, built with clang
crates/core/    Markdown thread, scheduled and research records
crates/host/    NDJSON host bridge
harness/        emma-cli, Emma's fork of vercel-labs/fx, Apache-2.0
docs/           Product and architecture contracts
```

Electron owns windows and the sandboxed presentation, Rust owns durable data and the host boundary, and Zig owns the agent harness:

```text
     sandboxed React renderer
             │  allowlisted IPC
     Electron main / preload
             ├─ newline-delimited JSON over stdio
             │      Rust host ──► emma-core ──► Markdown stores
             └─ Agent Client Protocol over stdio
                    Zig harness ──► OpenAI-compatible providers and MCP tools
```

## Development

```bash
npm --prefix desktop run check       # test, typecheck, lint, renderer build
cargo test --workspace --locked
(cd harness && zig build test)
```

The full check list a change has to pass is in [`AGENTS.md`](AGENTS.md); `just check`, `just test`, and `just package` wrap the rest. `npm --prefix desktop run build:harness` builds `emma-cli`; nothing else does.

Build a macOS app with `npm run package:mac`.

> **Not release-ready.** `dev.local.emma` is the provisional development identity. A publisher-owned bundle ID, a minimum supported macOS version, a signing identity, distribution, and an update owner all remain release blockers.

Every PR runs the full check list on GitHub Actions, and its **title is the changelog entry** — conventional commits, `fix(notch): …`. `CHANGELOG.md` is generated by release-please and never hand-edited; merging the release PR tags the version and attaches the packaged app.

More: **[docs/development.md](docs/development.md)** · **[releasing](.claude/skills/releasing/SKILL.md)**

## License

There is **no root `LICENSE` file**, and the repository as a whole is unlicensed until one lands.

| | |
|---|---|
| `harness/` | Apache-2.0 — [`harness/LICENSE`](harness/LICENSE), [`harness/FORK.md`](harness/FORK.md) |
| `crates/` | Declares `Apache-2.0` in [`Cargo.toml`](Cargo.toml) |
| Departure Mono | SIL Open Font License — [`desktop/assets/DepartureMono-LICENSE.txt`](desktop/assets/DepartureMono-LICENSE.txt) |
| Brand assets | Per [`docs/icon-sources.md`](docs/icon-sources.md) |
