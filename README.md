# Emma

Emma is a macOS Electron agent workspace and exportable knowledge base. A global
shortcut opens a compact surface at the display notch and starts or continues
a normal agent thread with user-approved context. Saving an analyzed result as
portable Markdown is an explicit action, not the default for every turn.

Every input surface is the same loop. The thread composer, Quick Ask, a quick
action, a page chat, a due scheduled job, and an autoresearch iteration all
enter one interception in Electron main, so exactly one place decides how many
steps a turn gets and what has to ask first.

## Workspace

```text
desktop/        Electron main/preload and React 19 workspace
crates/core/    Durable Markdown knowledge, thread, scheduled and research domain
crates/host/    NDJSON host bridge and Zig sidecar adapter
agent/          Zig agent sidecar, based on fx's embeddable architecture
harness/        emma-cli, Emma's fork of vercel-labs/fx, Apache-2.0
website/        Separate React 19 + Tailwind 4 public site
docs/           Product and architecture contracts
```

The desktop uses Electron 43.4.0. Rust 1.97.1, Zig 0.16.0, and Node 24+ are
the development toolchains. `docs/architecture.md` is the process-boundary and
product contract, `docs/design-system.md` the visual one, `docs/plugins.md` and
`docs/autoresearch.md` cover the two extension surfaces, and `AGENTS.md` lists
the checks a change has to pass.

`dev.local.emma` is the provisional development identity. A publisher-owned
bundle ID, minimum supported macOS version, signing identity, distribution,
and update owner remain release blockers.

## Run it

Install dependencies, then launch Electron:

```sh
npm install --prefix desktop
npm run dev
```

`npm run dev` builds the Rust host, the Zig sidecar, and the macOS hotkey
helper, then starts Vite and Electron against it; `npm --prefix desktop start`
does the same without the dev server and also vendors ripgrep. The justfile
wraps the rest — `just check`, `just test`, `just package` — and
`npm --prefix desktop run check` is test, typecheck, lint, and a renderer build.
`npm --prefix desktop run build:harness` builds `emma-cli`; nothing else does.

Double-tap the physical left Option key to open the compact agent surface.
macOS asks for Accessibility access so Emma can observe that modifier-only gesture;
the listener discards every other key event. Settings → Keybinds can add
system-wide chords or held modifiers for Quick Ask, dictation, drawing, and each
quick action; the built-in gesture is never taken away. Threads are saved under
`~/Library/Application Support/Emma`; set `EMMA_DATA_DIR` for an isolated
store. Every thread selects one named knowledge base (the stable **Default**
base is used by older data). **Save & analyze** creates an exportable Markdown
page inside that selected base; page edits are separate explicit actions.

Every saved page is also mirrored as ordinary Markdown — YAML front matter and
the document Emma built — into `~/Documents/Emma Knowledge`, so the knowledge
base is readable by the user and by any other agent on the Mac without knowing
Emma's storage format. `EMMA_KNOWLEDGE_DIR` moves that folder; an empty value
turns the mirror off. The mirror is derived: Emma never reads it back.

The same agent runs headless in a terminal. Run
`/Applications/Emma.app/Contents/Resources/emma --install` (or
`agent/emma --install` from a checkout) once to get an `emma` command on
PATH, then `emma "your prompt"` or bare `emma` for a REPL. It talks to the same
sidecar and provider settings. With a provider configured it advertises exactly
one tool — `bash` — and gates each call on the tty under the same permission
modes the desktop uses; see `agent/README.md`.

## Models and credentials

Without a provider, Emma uses its deterministic local fallback. To use an
OpenAI-compatible local or hosted endpoint, set all three host settings; the
credential setting names an environment variable and never contains the key:

```sh
export EMMA_PROVIDER_BASE_URL=http://127.0.0.1:1234/v1
export EMMA_PROVIDER_MODEL=your-model
export EMMA_PROVIDER_CREDENTIAL_ENV=EMMA_API_KEY
export EMMA_API_KEY=your-key-or-local-placeholder
```

Settings → Models is the same thing without a shell: local endpoint profiles,
the selected model, favorites, and the provider keys. A pasted key is encrypted
with the OS keychain under the user's data directory and reaches the host and
its sidecar only through their spawn environment — the renderer gets back a mask
and never the value.

For OpenRouter, use the model picker in a thread's composer. Emma loads the
live tool-capable catalog — free and paid, each marked as such — and browsing
it needs no key, because the listing endpoint is public. Electron caches it and
diffs each reload against the cache, so the picker paints offline; a bundled
seed covers a first launch with neither. Running a model does need a key:

```sh
export OPENROUTER_API_KEY=your-openrouter-key
```

Selecting a free model shows a privacy warning. Settings → Privacy has a
zero-retention switch: with it on, Emma sends OpenRouter's
`provider.data_collection: "deny"` and `provider.zdr: true` on every model turn,
so a request fails instead of falling back to a provider that may collect or
retain the prompt. It is off by default because OpenRouter has no free
zero-retention endpoint, and requiring one would block the whole free catalog.
Account-level logging settings still apply; review them at
`https://openrouter.ai/settings/privacy`.

## What a turn can do

A thread's composer is a full agent, not a chat box: it reads and writes files
in the folders you attach, searches them with the bundled ripgrep, runs shell
commands, keeps long-running commands alive in the background, drives the
screen, calls connected MCP tools, installs a skill or MCP server for itself,
runs the user's other coding CLIs, and spawns subagents. `/` names a capability
and `@` names a file in the composer.

The picker beside ＋ chooses how much of that it may do without asking:
`plan` advertises only tools that cannot change this machine, `ask` gates every
write and command, `acceptEdits` writes files but still asks before running
anything, `auto` puts each gated call to a small separate verifier model and
falls back to asking when it will not clear one, and `full` runs unattended.
One table in `desktop/shared/permissions.ts` decides what each mode advertises
and what it gates. The `emma` terminal command reads `EMMA_MODE`, where it
understands the same names except `auto`.

Live subagents show in the sidebar under their own color and open in their own
tab, where you can steer or stop them and read their model, rate, tokens, and
tool calls; a `threads` call instead starts a full sub thread nested under its
parent, with an agent of its own working in it and a card in the transcript to
watch it, open it, stop it or send it a line. The inspector carries the turn as a span waterfall, a ledger of what
the prompt actually carried, a Git tab for the connected folder's working tree,
and a `+N −M` diff of everything Emma's own writes touched, with a revert per
file. A file path in a reply opens in Emma rather than in whatever app owns the
extension.

Settings → Connections lists third-party CLI tools Emma can lean on — `gh`,
`glab`, `jira`, `todoist`, `obsidian-cli`. A connection is a line of system
context and nothing more; the binary was already reachable through `bash`.
Settings also holds the standing instructions added to every turn, on both paths.

An **artifact** is work a conversation produced that outlives it — a document, a
code snippet, a single-page site, an SVG, a Mermaid diagram, a React component.
Emma offers one when the content is self-contained, worth editing or reusing
outside the thread, and worth coming back to; `/artifact` asks for one outright.
It appears inline in the reply that made it and on the **Artifacts** tab, where
every artifact is rendered rather than listed — a page runs in a sandboxed frame
that may script and reach nothing else, a drawing in one that runs nothing at
all, and code and React are highlighted but never executed. Editing one
opens a new thread with it already in context. Because the `artifact` tool is
available to any turn, a scheduled job can own a document and keep it current:
a flight tracker that searches each morning and updates the same board. The
skill behind it is the one bundled skill Emma seeds only when it is missing, so
your edits to it survive. Artifacts live in `<userData>/artifacts/`, one folder
each, in the file format their kind implies.

An **autoresearch** job is a long-running experiment loop against a git project
on this Mac: the agent proposes one change, Emma runs the eval command, reads
the metric, and keeps or reverts the commit, until a time, token, or spend
budget stops it. The metric is immutable for the life of a job. See
`docs/autoresearch.md`.

A **scheduled** job is a workflow — one validated trigger and a graph of agent,
set, and branch nodes. Triggers are five-field UTC cron, `manual`, `after
<job-id>`, or an app event. Jobs run only while Emma is open, create normal
threads under the permission mode they were saved with, and never save
knowledge or write a skill silently. **Agent** is a transparent local dashboard
over the last 60 days of durable knowledge: it shows the saved pages behind
repeated site and category patterns and can propose a bounded weekly discovery
job, which Emma creates only when you approve it.

Emma can also use the Mac itself. Describe a task under ＋ → Control this Mac
and approve the run: Emma captures the screen, moves the pointer, clicks, and
types until the task is done. A banner sits above every app with the current
action and a Stop button, and Escape aborts from anywhere. The YOLO toggle in
Settings → Privacy skips the approval dialog and nothing else — the step,
action, rate, and time ceilings, the action log, the banner, and Escape stay on
either way. A run that hits a dead end or finds a better route writes itself a
skill, so the next one starts knowing what this one learned.

## The notch surfaces

Emma measures the real camera housing per display through the `emma-option-tap`
helper. Quick Ask is a single island: it takes over the menu bar on both sides of
the housing and hangs below it, centered on the real notch. While Emma is idle a
click-through sliver sits over the housing; hovering it reveals a dithered
sparkle wave that spills out of the housing itself, and clicking it opens Quick
Ask. Displays without a housing fall back to a validated 120–260 point virtual
notch, calibrated in Settings. Each quick exchange hangs under the composer and
extends the island; past a bounded height the thread scrolls and Emma offers to
continue in the full app. Dismissing an idle overlay destroys its renderer to
release memory while preserving an unsent draft locally.

Settings stores exactly three quick actions locally. In the overlay they stay out
of the way until the pointer swipes below the island, then hang under it as
orbs; they also orbit the cursor in a ring when Quick Ask opens. `Command-1/2/3`
runs them at any time. The ring holds one to eight orbs — six by default — each
bound to a command from a fixed catalog that main validates rather than trusting
the renderer: a quick action by index, a screen capture attached as a one-shot
thumbnail, the drawing pen, saving the front browser page, or opening the
workspace. Settings edits it on a live copy of the ring itself, and either
surface can be switched off.

Saving the page reads it out of whichever whitelisted browser is in front, keeps
its favicon and the pictures it leads with, and writes it up as a document — a
summary as the lede, the figures worth pinning, a chart when the material
carries real numbers, the pictures in one strip, then the supporting sections
and its sources. It files that page into a category by itself once one of your
categories has five examples to learn from; before that it lands unfiled and
says how many more it needs.

Dictation is off until Settings → Voice turns it on. Recording happens in the
renderer and every stage stays on this Mac. Two engines hear it: the recognizer
macOS already ships, reached through Speech.framework by a small helper binary
and pinned to on-device recognition — nothing to install beyond switching
Dictation on in System Settings — or a local OpenAI-compatible
`/v1/audio/transcriptions` endpoint, which hears more accurately at the cost of
running a server. Either way an optional local text model then rewrites the
transcript as written English. Main enforces that every endpoint is local, and a
cleanup that fails hands back the raw transcript.

Departure Mono is bundled under the SIL Open Font License and is the interface
face — labels, values, nav, counts, anything on the grid. Prose stays on the
system sans stack. Settings → Appearance switches either face.

## Extending Emma

First launch and Settings can register existing Codex, Claude, Antigravity, Pi,
OpenCode, Cursor, Windsurf, and Devin skill/MCP locations without copying their
config contents; imported capabilities stay inactive references until selected.
Emma ships her own skills in `desktop/skills/` and owns exactly two capability
files under her user data, so a skill or MCP server she installs mid-turn is
usable in that turn. User-installed CSS plugins can overhaul the semantic
desktop UI; the bounded manifest contract is in `docs/plugins.md`.

`harness/` is Emma's fork of [vercel-labs/fx](https://github.com/vercel-labs/fx),
built as `emma-cli` and driven over the Agent Client Protocol from
`desktop/main/harness.ts`. It owns the agent loop, tool execution, hooks, skills
and subagents for a turn; Emma owns the window, the durable Markdown thread, and
the answer to every permission question. It is off by default and opts in with
`EMMA_HARNESS=1`, because the fork does not yet reach Emma's folder,
computer-use, MCP, and knowledge tools. Provenance and the Apache-2.0 obligations
are in `harness/FORK.md`; usage is in `harness/README.md`.

Build a macOS app with `npm run package:mac`.
