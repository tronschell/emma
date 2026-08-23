# Product and architecture contract

## Process boundary

```text
sandboxed React renderer
        | allowlisted IPC
Electron main / preload
        | newline-delimited JSON over stdio
Rust host -> emma-core -> Markdown stores
        |
Zig agent -> OpenAI-compatible providers and lazy MCP tools
```

The renderer holds a live projection only. Electron owns windows, the global
shortcut, trusted-sender validation, and the narrow preload API. `emma-core`
owns parsing, validation, atomic persistence, and domain invariants. The Zig
sidecar owns transient agent runs, tool selection, and usage accounting; it can
mutate durable data only through an explicit validated host command.

Assistant text streams back along the same stdio path, out of band of the
request/response pairing: the sidecar parses the provider's SSE itself and emits
`{"id","delta"}` lines against the in-flight request, the host re-tags them
`{"threadId","delta"}` onto its own stdout, and main broadcasts them as
`emma:delta`. An empty delta means the host is retrying on a fallback provider
and the renderer must drop what it has buffered. The turn's durable message is
still the response envelope; a delta is never persisted.

Both renderer windows use `sandbox: true`, `contextIsolation: true`, and
`nodeIntegration: false`. A restrictive content-security policy is applied and
unused Electron permissions are denied. New windows are denied; validated
HTTP(S) links open in the system browser. Electron's single-instance lock keeps
the Markdown stores under one host writer.

## Threads and knowledge

Ordinary work belongs to a durable thread. Each thread has one destination
knowledge base for explicit writes and a deduplicated set of read-only source
bases for bounded retrieval. Saving remains explicit. A saved page is an
editable, exportable Markdown document with category, source-thread provenance,
added/analyzed timestamps, model, token counts, and subagent count. Each new
assistant message also keeps its output-token count and elapsed generation time
so the transcript can show that response's tokens-per-second rate.

Thread format 4 adds per-message generation telemetry; format 3 stores the
destination and sources, while formats 1–2 migrate to the destination as their
sole source. Knowledge-base format 2 stores user category
slugs; format 1 migrates with none. Learned categories are derived from pages.
Removing a user category never removes a page. The activity heatmap is computed
from durable message and page timestamps.

The Agent dashboard is a deterministic 60-day projection of those same local
records. It ranks collected source domains and repeated base/category mappings,
keeps page titles as expandable evidence, and never writes on its own. An
approved discovery proposal creates an atomic Markdown scheduled-job record.

A scheduled job is a workflow: one validated trigger and one node graph. The
trigger is a five-field UTC cron expression, `manual`, `after <job-id>` when
another job finishing is what fires it, or `on <event>` for an app event Emma
raises (`launch`, `page-saved`); only a cron job carries a next run, so the
worker's clock owns exactly the jobs that have one. The worker evaluates cron
while Emma is running, claims each occurrence before starting work, and opens a
normal durable thread for the result; a job finishing fires whatever waits
`after` it, bounded at three hops so two jobs cannot trigger each other forever.
The graph is opaque JSON to core: its grammar — `agent`, `set` and `if` nodes,
`{{name}}` templates, conditions and the variables a run leaves behind — lives
once in `desktop/shared/workflow.ts`, where Electron main walks it for a real
run, the `workflow` tool dry-runs it, and the workspace draws it and refuses a
bad edit before it is stored. Jobs never save knowledge or create skills
silently; save, delete, run and enable/disable all cross the same validated host
boundary, and the `workflow` tool is gated like a write in every mode below
`full`.

## Dynamic knowledge artifacts

A knowledge page is an ordered, agent-authored artifact document, not a flat
note. One page can interleave captured source material, summaries, citations,
tables, graphs, generated visuals, and plugin-defined interactive views. Every
artifact block keeps its type, version, source provenance, and a portable
Markdown/data fallback so export never depends on Emma or a particular plugin.

The agent decides how the material is best presented, within a fixed reading
order: a `summary` block as the lede, key figures and a chart where the material
carries real numbers, the captured pictures directly under the summary, the
supporting sections, its citations, and a closing `how-to-apply`. Reading mode
renders that as a document — Markdown as real headings and lists, charts drawn
from the block's own data, neighbouring pictures gathered into one scrollable
carousel — while block types, ids and versions stay in the editor where they are
the thing being edited.

Capture may start from a browser page, selected text, a file or folder, a
screenshot or annotation, or context explicitly shared from another app. The
user's capture/save action authorizes a durable write; sending that material to
a model or connector remains a separate permission boundary. The agent may add,
edit, remove, and reorder blocks through validated host commands, including when
it revisits research and produces a better visualization or synthesis.

Built-in blocks stay declarative. A plugin renderer receives only its validated
artifact payload and declared capabilities, never ambient filesystem access,
provider credentials, or the full knowledge store. Unknown or unavailable block
types render their portable fallback instead of making the page unreadable.

## Artifacts

An artifact is the other kind of thing a conversation leaves behind, and it is
not a knowledge page. A page is material Emma captured and analyzed; an artifact
is work Emma *produced* that is worth keeping — a document, a code snippet, a
single-page site, a drawing, a diagram, a component. The two share a word and
nothing else: the artifact *blocks* above are regions inside one page, while an
artifact is a standalone file with its own tab, its own folder and its own tool.

Emma makes one when the content is significant and self-contained, is something
the user will want to edit or reuse outside the conversation, stands on its own
without the surrounding turns, and is worth referring back to. The bar is
deliberately high and the instruction is to err against creating one: a brief
snippet, an explanation, or commentary on an artifact that already exists all
belong in the reply. `/artifact` is the deterministic door for when the user has
already decided.

Storage is Electron's, not the host's — `<userData>/artifacts/<id>/` holding
`meta.json` and `content.<ext>`, one directory per artifact, written atomically.
The extension follows the kind, so revealing one in Finder opens it in whatever
owns that file type. Nothing about an artifact goes through the NDJSON bridge or
the Rust stores: it is a folder of files main owns, which is why the renderer
reaches it over named IPC channels rather than through `snapshot`.

The `artifact` tool is what writes them, so anything that gets an agent turn can
— a thread, a subagent, or a scheduled job firing at 09:00 with nobody watching.
`update` is a targeted `old_str`/`new_str` replacement and fails loudly when the
text does not match exactly once, because a silent no-op leaves the model
carrying on from a version that never existed. `rewrite` replaces the whole
content and bumps the version. That pair is what lets a scheduled task own a
document and keep it current rather than mailing a fresh copy every morning.

Rendering is by kind, and the sandbox is the boundary. Markdown renders through
the same element-building parser the transcript uses. An SVG is a picture, so it
is framed from `srcDoc` with `sandbox=""` — the file preview's frame, which runs
nothing. An HTML artifact is meant to run, so it is framed from the
`emma-artifact://<id>` scheme instead, with `sandbox="allow-scripts"` and never
`allow-same-origin` alongside it, which would let the page reach out and rewrite
the attribute holding it. The scheme exists for one reason: a `srcdoc` document
inherits the embedder's content policy, and the workspace's is
`script-src 'self'`, so an interactive page loaded that way renders and then
quietly does nothing. Main serves it as a real response carrying its own policy —
inline script and style, no network, no frames — and the workspace's own policy
allows framing that scheme and no other.

Code and React artifacts are stored, highlighted and editable but not executed:
Emma ships no in-app transpiler and will not reach a CDN for one, so the
interactive case is carried by HTML. Diagrams go through a lazily-loaded Mermaid
module, kept out of the main bundle the same way charts are.

The skill that teaches all of this ships in `desktop/skills/artifact/` and is
the one bundled skill seeded only when absent, so a user who tailors it keeps
their version across launches.

## Plans

A plan is how Emma takes on a job too big for one agent: a markdown file naming
the steps, what each one waits on, and the tasks underneath it. One step is one
subagent. Steps whose dependencies are all `done` are a *wave*, and a wave is
what `plan run` delegates — `Promise.all` over `AgentRuntime.delegate`, which is
the only way tool calls inside one model step ever overlap, since they are
otherwise strictly sequential. A row of the drawn graph is literally a wave.
One call runs one wave and returns, so a long plan stays
inside `MAX_TURN_MS` and the model stays in the loop between them; the wave is
capped at `MAX_LIVE_SUBAGENTS` and the tool says which steps it held back rather
than quietly truncating.

Reaching for it at all is the part a schema cannot carry, since a model only
reads the `plan` schema once it is already planning — so `PLANNING_PROTOCOL`
rides the turn's system context the way `MEMORY_PROTOCOL` does, on root turns
that are actually offered the tool. Not in Plan mode, where it is hidden, and
not at depth: a step's subagent has `stepBrief`, and a plan of its own would be
a plan inside a plan.

Markdown is the store, not an export of one. `<userData>/plans/<id>.md` is what
the tool rewrites, what the widget parses, and what opens in any editor — so
`shared/plan.ts` never throws on a hand-edited file: an unreadable status falls
back to `todo`, a `needs` pointing at nothing is dropped, and a heading that is
not `## <id> · <title>` stays the prose it looks like. Storage is Electron's for
the same reason artifacts are, and reaches the renderer over `emma:list-plans`
and an `emma:plans-changed` broadcast rather than `snapshot`.

The plan is watched where the thread is: `plan` is a context-bar widget
(`src/plan.tsx`, registered in `shared/context-bar.ts`), not a section of its
own, and a `thread:` line in the file says whose inspector it belongs in — a
subagent's write files under `parentThreadId`, and `mergePlan` keeps the
original owner so a rewrite cannot re-home the plan into a sub thread nobody is
looking at. The widget draws the graph itself: `planLayout` places a wave per
row (x in percent so one graph fits the 210–360px column, y in px so a node is
the same size in either), edges are an SVG behind real buttons, and pressing a
node lights its whole wave and pages that step's tasks underneath. The label
row's expand opens the file itself, rendered from the parsed plan because the
store *is* the render. Like every widget that fetches its own data, it takes a
`sample` prop so the Settings arranger can draw a real plan.

Two invariants make a plan safe to edit while it is running. `mergePlan` keeps
what the old file lived through — a step keeps its status and result by id, a
task keeps its tick by text — so restructuring the graph mid-run does not untick
every box or re-run finished steps. And every write goes through one queue in
`main/plans.ts`, because a wave is up to eight subagents ticking their own steps
in the same file and a read-modify-write with an `await` in the middle is a lost
update.

## Windows and shortcuts

The library is a resizable three-pane workspace with independently collapsible,
bounded, locally persisted rail widths. A double-tap of the physical left Option
key toggles a compact
always-on-top agent surface. The `emma-option-tap` helper also reports each
display's real camera-housing bounds (`--screens`, from AppKit's auxiliary top
areas), so the single island hangs off the actual notch, covering the menu bar on
both sides of it. Displays without a
housing fall back to a validated 120–260 point virtual notch. A dithered sparkle
wave spills out of the housing — quiet ink while it waits, accent while a turn
runs — and stops under reduced motion. Enter submits an
ordinary thread message. Only this session's turns render, below the composer;
the main process grows the window by a clamped, finite height until a bounded cap,
after which the transcript scrolls and offers to hand the thread to the full
workspace. Whatever the thread held before the notch opened stays in it. The three
settings-backed quick actions live outside it: they hang below the island as
orbs while the pointer sits inside a triangle that opens under the island
toward the orb row, so a diagonal swipe never loses the target, and they also
orbit the cursor in a separate ring window opened with the island. That ring is
user-defined: one to eight orbs, six by default, each bound to a command from a
fixed catalog (a quick action by index, screen capture, drawing, saving the front
browser page, or opening the workspace). Saving the page hides the overlay long
enough to ask AppleScript which whitelisted browser is in front, reads that URL as
text in the main process, and downloads its favicon and lead pictures into one
capture — the favicon first, so it leads the card. Emma only files that capture
into a category once one of the base's categories holds five examples to learn
from; until then it lands unfiled and the overlay says how far off that is. Settings edits it through the same ring component the cursor window
renders, and the main process validates every ring message against that catalog
rather than trusting the renderer. Both command surfaces can be disabled; the ring
switch travels in the same validated overlay preferences as the notch gap, so the
window is never created when it is off. The ring includes
a screenshot action that captures the visible screen in the main process and
attaches it as a one-shot thumbnail, so context needs no drawing pass. A
non-focusable sliver over the housing stays click-through until a 120 ms cursor
poll finds the pointer inside it, which keeps the menu bar usable while still
letting a click on the notch open Quick Ask. The actions stay on `Command-1/2/3`
and reveal on keyboard focus too; each can choose a destination, category,
prompt, and whether to save the analyzed result.

The overlay BrowserWindow is created lazily and destroyed on dismissal so a
hidden Chromium renderer is not retained. Its unsent draft remains in renderer
local storage and is restored on the next activation. If dismissal occurs while
a request is running, the hidden renderer is destroyed as soon as that request
settles so successful prompts cannot replay.

## Models and extensions

Provider configuration consists of an OpenAI-compatible base URL, model, and
credential environment-variable name. There is no Vercel login surface. The
OpenRouter catalog is fetched lazily through Zig and offers every tool-capable
model, free and paid, each flagged with which it is — the listing endpoint is
public, so browsing models needs no key and only running one does. Electron
caches the result under the user's data directory and diffs each reload against
it, so the page paints offline and a reload reports what changed; a bundled seed
covers a first launch that has neither cache nor network. Selected turns require
no provider data collection and zero retention; otherwise they fail closed.

## Agent turns

Every prompt is a full agent turn. Electron main intercepts `sendMessage` once,
so the thread composer, Quick Ask, a quick action, a page chat and a due
scheduled job all enter the same loop rather than each growing their own. The
loop advertises tools to the sidecar, executes the calls it asks for, and
submits the results back over `thread_tool_result` until the model answers,
bounded at 120 steps, 30 minutes, and 8 calls per step.

The composer's picker sets the mode: `plan` advertises only tools that cannot
change this machine, `ask` gates writes and commands behind a dialog,
`acceptEdits` writes files but still asks before running anything, and `full`
runs unattended. One table in `desktop/shared/permissions.ts` decides what each
mode advertises and what it gates, and the `emma` terminal command reads those
same four names out of `EMMA_MODE`. Scheduled jobs store their mode in the job
record, so a job fires under the mode it was approved with.

Two different things are owned child threads, and `kind` on the thread record is
what tells them apart. A **thread** is a durable timeline: the event stream is
stored, it outlives every run in it, and it stays in the sidebar to be picked up
again. An **agent** is the loop working inside one, and it dissolves when its job
is done. A `task` call spawns a **subagent**: `kind: subagent`, several to a
thread, its transcript, telemetry and tab all coming from the machinery threads
already have, and kept out of the projects list because nobody opened it. A
`threads` call with `spawn` starts a **sub thread**: `kind: main`, a thread of
its own with its own main agent, listed in the sidebar nested under the thread
that started it. With a prompt, that agent starts work immediately, through the
same door every other surface uses — so it runs on the coding harness whenever
Emma is running on it, in the project its owner works out of, under the mode the
spawning turn was given. The rest of the tool is the same one door: `list` and
`read` see any thread, which is how a subagent spawned without sight of the
conversation it came from goes and finds it; `message` steers the agent working
in a thread, or starts a turn there when none is; `rename` titles the thread the
turn is in. A spawn's result carries the new thread's id and title on its first
line, which is what the transcript draws its live card from.

Live agents appear in the sidebar with an assigned color, at most
eight at once and one level deep. Every file a turn writes is logged with its
before/after text, which is what the inspector's `+N −M` diff tab reads and
reverts from.

## The coding harness

`harness/` is Emma's fork of [vercel-labs/fx](https://github.com/vercel-labs/fx),
built as `emma-cli`. Its provenance, the Apache-2.0 obligations that come with
it, and everything the fork changes are recorded in `harness/FORK.md`. It exists
so Emma does not maintain a second implementation of the agent loop, tool
sandboxing, hooks, skills and subagents.

Upstream speaks the Vercel AI SDK's language-model protocol to two hard-wired
providers. Emma replaces that transport rather than wrapping it:
`harness/src/gateway/emma_openai.zig` implements the fork's own
`stream_provider.Provider` interface against OpenAI Chat Completions, so any
compatible endpoint works and `EMMA_PROVIDER_CHAT_URL` chooses one. That is a
new file plus a five-line change in `builtins/gateway.zig`, not a rewrite of the
26 MB of upstream around it. `harness/scripts/mock-openai.mjs` is the end-to-end
check: it asserts the request carries OpenAI vocabulary, drives one real tool
round trip, and fails if AI SDK field names leak back in.

Emma drives the fork over the Agent Client Protocol — newline-delimited
JSON-RPC on stdio — from `desktop/main/harness.ts`. The harness owns the live
session and every tool call; Emma owns the window, the answer to every
permission question, and the durable Markdown thread. Permission requests come
back over ACP and go to the same dialog and the same timeout the built-in loop
uses, through `AgentRuntime.question`; a refused or unanswered question is a
denial, never a silent allow. A turn runs inside the thread's connected folder,
or a scratch directory under `userData/workspaces` when there is none, so a
harness with no folder attached is not loose in the user's home.

State syncs one way. The harness keeps its own session; when a turn finishes,
main calls `recordTurn` on the host, which appends the prompt and the finished
answer to the thread in one save. Core never drives the model for these turns —
`Runtime::record_turn` exists precisely so the Markdown store stays the record
of what was said without pretending it ran the agent.

The harness path is off by default and opts in with `EMMA_HARNESS=1`. The fork
does not yet reach Emma's folder, computer-use, MCP and knowledge tools, so
making it unconditional would trade one set of abilities for another; the flag
goes away when it reaches parity.

## Computer use

Emma can drive this Mac: it captures the display it is working on, moves the
real pointer, clicks, scrolls, and types. The agent loop lives in the Zig
sidecar, which asks for `computer` and `write_skill` calls; execution lives in
Electron main, which owns the screen, the input helper, and the permission gate.
The sidecar never performs an action itself — the same split MCP already uses.

There is no separate approval flow: `computer` is an ordinary tool, so the
thread's permission mode is the gate. It is hidden in `plan`, asks the user in
`ask` and `acceptEdits`, goes to the verifier model in `auto`, and runs through
in `full` — the same table every other tool answers to. The first cleared call
starts the run lazily. Whatever the mode, the twenty-step ceiling, the
400-action ceiling, the minimum interval between actions, the ten-minute run
ceiling, the per-action log line, the always-on-top banner, and the system-wide
Escape kill switch all apply. Escape is
registered globally only for the life of a run, because the agent will be
clicking in other apps. Pointer actions are refused until a screenshot has been
taken, since screenshot pixels are what coordinates are mapped from.

A run that hits a dead end or finds a better route calls `write_skill`, which
writes `<userData>/skills/<slug>/SKILL.md` through the ordinary imported-skill
path. That folder is an implicit import source, so learned skills survive
re-running the import dialog and are keyword-matched against every prompt
`sendMessage` carries, so the next turn starts with the lesson already in it —
an explicitly attached skill still wins. The
skill is the lesson; there is no separate memory store.

When the lesson is executable rather than written, `write_tool` puts one script
in `<userData>/tools/<slug>/run` and `run_tool` lists and runs it in any later
thread. Writing sits with `write_skill` and never asks; running is arbitrary code
on the user's Mac and gates exactly where `bash` does.

MCP servers remain disconnected until needed. The model searches server/tool
metadata first and receives only the selected tool schema. First launch and
Settings can register existing agent skill/MCP locations without copying config
secrets. Local CSS-only plugins provide an immediately useful UI-overhaul seam;
remote resources are blocked. Executable extension behavior remains in selected
skills and MCP tools so its permission and context boundaries stay visible. See
`docs/plugins.md`.

## Current limits

The hotkey surface can capture a user-initiated display frame and draw yellow
highlights over it. A drawing attaches itself to the quick composer once the
strokes settle, and the whole visible frame goes to the selected endpoint with
the next ask unless the user discards the chip first.
Pages now persist bounded ordered declarative artifact blocks with rich-text,
stats, list, citations/table, and chart/data payloads plus portable fallbacks;
v1/v2 pages migrate on load. The Markdown a rich-text block may use is a subset:
headings, lists, quotes, code, bold/italic, and http(s) links. Plugin renderer execution and a generalized artifact
renderer SDK are not implemented yet, so unknown blocks use their fallback.
Generalized file/web capture is still outside this slice. Scheduled jobs run only while Emma is open; missed
occurrences coalesce into one due run when Emma next starts. A generalized
quick-action executor is outside this slice. Computer use is foreground only and
macOS only: a run is started by the user from a thread and watched by the
banner. A due scheduled job is handed out of the Rust worker thread as an event
and its graph walked in Electron main, each agent node an ordinary agent turn on
that job's thread under the permission mode the job was saved with, so an
unattended run does reach the same tools; screen
control still opens the banner and still needs the machine unlocked and awake. Local
Whisper/Parakeet-compatible
endpoint settings are present, but microphone capture and audio transport remain
disabled. Signing, notarization, VoiceOver verification, and non-macOS support
are release work.
