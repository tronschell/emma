# Concepts

Emma's vocabulary. Each section names one thing, defines it in a line, then says
what it is made of and where that lives in the code.

## Thread

**A durable timeline that outlives every run inside it.**

A thread is what the user comes back to. Runs start and finish inside it; the
thread stays. It is the unit the sidebar lists, the unit a permission mode is
set on, the unit a knowledge base is selected on, and the unit that gets a file
on disk.

The record is [`crates/core/src/thread.rs`](../crates/core/src/thread.rs):

| Field | What it holds |
|---|---|
| `id` | 16–96 bytes of `[a-z0-9-]`. Generated as `{unix_seconds}-{pid:x}-{nanos:x}-{sequence:x}` |
| `title` | The sidebar row |
| `parent_thread_id` | The thread that owns this one, or none |
| `kind` | `Main` or `Subagent` |
| `scheduled_job_id` | Set when a due job opened this thread |
| `knowledge_base_id` | The one base this thread writes to |
| `source_knowledge_base_ids` | The bases retrieval may read from |
| `created_at`, `updated_at`, `archived_at` | Timestamps; `archived_at` empty means live |
| `messages` | The transcript |
| `traces` | Finished turns as spans, `#[serde(skip)]` so they never cross the wire with a snapshot |

`kind` and `parent_thread_id` together are what tell the two nested shapes apart.
Both a sub-thread and a subagent carry a parent. `Main` is a thread the user
talks to — a root thread, or a sub-thread another main thread started and owns.
`Subagent` is the transcript of one harness child.

A new thread defaults its destination base to `default` and its sources to
`[default]`. `select_knowledge_base` and `select_source_knowledge_bases` both
keep the destination present in the sources, deduplicated.

### What is persisted

Ceilings, all enforced in `crates/core`:

| Constant | Value |
|---|---|
| `MAX_THREAD_MESSAGES` | 1024 |
| `MAX_THREAD_SOURCE_BASES` | 256 |
| `MAX_THREAD_TRACES` | 64 |
| `MAX_TRACE_BYTES` | 16 KiB |
| `MAX_MODEL_NAME_CHARS` | 128 |
| `MAX_AGENT_MESSAGE_BYTES` | 64 KiB, in [`live.rs`](../crates/core/src/live.rs) |

A message is `{ role, content, timestamp, generation }`. `role` is `user`,
`assistant` or `system`. `generation` is only on assistant messages and carries
`output_tokens`, `duration_milliseconds`, `input_tokens` and `model` — the model
the picker was on when that turn ran. The renderer's mirror of the same shape is
in [`desktop/src/types.ts`](../desktop/src/types.ts).

An oversized message or trace is elided in the middle, not refused: `record_turn`
runs `elide_middle`, which keeps the head and the tail and drops the rest behind
`… N lines elided …`. Refusing would have written neither half of an exchange,
leaving the run's work on disk with nothing in the thread.

### The file on disk

One Markdown file per thread, under `<data root>/threads/{id}.md`. The data root
is `$EMMA_DATA_DIR`, or `~/Library/Application Support/Emma` when that is unset
([`crates/host/src/runtime.rs`](../crates/host/src/runtime.rs)).

```text
---
emma-thread-format: 11
id: "…"
title: "…"
parent-thread-id: "…"
kind: "…"
scheduled-job-id: "…"
knowledge-base-id: "…"
source-knowledge-base-count: 1
source-0-id: "default"
created-at: "…"
updated-at: "…"
archived-at: ""
message-count: 4
trace-count: 2
---

## Message 1

Role: user

Time: …

Generation: none

> the message text, quoted

## Trace 1

Time: …

> the encoded spans, quoted
```

An assistant message writes `Generation: present` followed by `Output-Tokens`,
`Duration-Milliseconds`, `Input-Tokens` and `Model`.

The format is versioned and every older version still parses. Format 11 is
current. Before 11 there was no model on a generation; before 10, no
scheduled-job id; before 9 any parent meant a subagent; before 8, no traces;
before 7, input tokens read as 0; before 6, no parent at all; before 5, no
archived-at; before 3, a single source base; format 1 had no base and gets the
default.

`ThreadStore::save` writes `.{id}.tmp` and renames it over `{id}.md`, so a
half-written thread never exists. `list()` sorts by `updated_at` descending, then
by id descending. A malformed file is collected as a warning, not a fatal error —
one bad thread does not take the library down with it.

### In the renderer

[`desktop/src/threads.ts`](../desktop/src/threads.ts) is the presentation side:

- `threadLabel` falls back to the first user message when a thread has no title
  of its own, cut to 48 characters with the last one an ellipsis.
- `nested` orders a tree parent-first, ranking each branch by the newest activity
  anywhere under it.
- `since` reads an age as `<1m`, `12m`, `3h`, `5d`.
- `threadDepth` caps at 8.

## Run / turn

**One agent loop inside a thread: a prompt in, an answer recorded, spans left
behind.**

The loop itself is the harness — `emma-cli`, driven over ACP from
[`desktop/main/harness.ts`](../desktop/main/harness.ts). What Electron keeps is
the agent rail and its spans, the durable traces, the permission channel with its
Auto verifier, and four tools it answers itself:

```ts
export const OWN_TOOLS = new Set(["read_trace", "threads", "agents", "advisor"]);
```

A turn is a `TurnRequest` in
[`desktop/main/agent-loop.ts`](../desktop/main/agent-loop.ts):
`{ threadId, content, mode, title, model?, parentThreadId?, depth?, subagent?, params?, parentSpanId? }`.

### The one interception point

Every input surface funnels through a single place in Electron main. In
[`desktop/main/main.ts`](../desktop/main/main.ts), inside
`ipcMain.handle("emma:request", …)` after the sender has been validated:

```ts
const result = request.method === "sendMessage"
  ? await driveTurn({ threadId, content, mode: threadMode(threadId), title: "This thread", model: threadModel(threadId), params: { ...await skillParams(content), ...extra } })
  : await answerRequest(request.method, request.params);
```

`answerRequest` is the other door: most methods it forwards to the host
untouched, but it answers the model picker itself against Electron's own
OpenRouter catalog, and it answers the knowledge-page methods as a provider call
between two store calls — see [knowledge.md](knowledge.md).

The thread composer, Quick Ask, a quick action, the one-line send on a thread
card and the Agent page's hand-over all send `sendMessage`, so all of them
arrive here. The other entry points call `driveTurn` directly:

| Surface | Where |
|---|---|
| Composer, Quick Ask, quick action, thread card, Agent page hand-over | `emma:request` → `sendMessage` |
| `threads spawn` and `threads message` | `spawnTurn` in the `AgentRuntime` deps |
| Autoresearch iteration | `configureResearch({ turn: (request) => driveTurn(request) })` |
| Due scheduled job | `runScheduledWorkflow` |

This matters because one place decides the step budget and what has to ask. A
prompt that became an agent turn at its own call site would need the permission
mode, the tool gate, the trial arm and the trace writer repeated four times, and
the fourth copy would drift. `driveTurn` does the same four things every time:
clears any finished run on the thread, fills in the thread's subagent route,
writes the standing instructions to the harness's own `AGENTS.md`, and hands the
turn over with its trial arm attached.

`writeHarnessPrompt` puts the user's Settings text at
`<userData>/harness/.fx/AGENTS.md`; the harness loads `$HOME/.fx/AGENTS.md` from
the HOME Emma gives it. It is handed the turn's model, folder and mode, because
the text is resolved per turn: the global prompt, then whatever conditional
prompts that model matches, with each `{variable}` filled in. Only the A/B arm rides the turn itself, because the arm
is a coin flip per turn — see
[`desktop/main/system-prompt.ts`](../desktop/main/system-prompt.ts).

### What a run produces

`AgentRuntime` registers the run, counts deltas, usage and tool calls, and at
depth 0 flushes a trace onto the thread: the spans encoded with a
`{ thread, model, arm }` header, through `recordTrace`. `runOnHarness` then calls
`recordTurn` with the prompt, the response, the duration, and the input, output
and model figures — which is what becomes the assistant message's `generation`.

Permission questions take one channel — `question(ask)`. In `auto` mode it
consults the verifier model first, records a `verifier` span and emits a step. A
question waits at most `MAX_ASK_MS`, ten minutes.

In the renderer, [`desktop/src/runs.ts`](../desktop/src/runs.ts) keeps run state
outside React. A run is a list of blocks — `text`, `thinking`, `step`, `notice` —
plus `landed`, `queue` and `draft`. `wire()` subscribes to `onAgents`, `onDelta`,
`onStep` and `onContextExperiment`; `adoptForeign` picks up a turn another window
started, so a run begun in Quick Ask keeps rendering when the workspace opens.

## Subagent vs sub-thread

**A subagent is a worker that dissolves once it answers. A sub-thread is a
conversation that stays.**

They are different tools with different lifetimes.

| | `subagent` — subagent | `threads spawn` — sub-thread |
|---|---|---|
| Thread `kind` | `subagent` | `main` |
| Awaited by the caller | Only if it asks: `create` returns at once, `inspect.wait` blocks | No — it runs beside the turn |
| Owner | The calling thread | `parentThreadId ?? threadId` |
| In the sidebar | No; it appears in the live agent rail | Yes, as its own row |
| In the transcript | A step | A card |
| Where the user reads it | Its own tab beside the parent thread | Its own thread |
| Steerable | Yes, from its tab | Yes, from its card or its thread |
| Ends when | It answers | Never; runs inside it end, it does not |
| Ceiling | The harness's own; `plan run` hands out at most `MAX_LIVE_SUBAGENTS` = 8 briefs a wave | `MAX_LIVE_THREADS` = 8, top-level runs only |

The tool descriptions in
[`harness/src/builtins/emma/threads.zig`](../harness/src/builtins/emma/threads.zig)
draw the line for the model: *"Spawn a subagent instead when you need an answer
inside this turn: a subagent is a worker that dissolves once it answers, a thread
is a conversation that stays."*

### `subagent`

The harness owns delegation. `subagent` is one of its own tools — create, inspect,
message, relate, configure, control — and Emma never spawns a turn for it. A child
runs inside the harness process, so it does not queue behind the parent's turn the
way a second `session/prompt` would.

Emma sees a child because its updates ride the parent's ACP stream tagged
`_meta.fx.child`. `Harness.handleUpdate` in
[`harness.ts`](../desktop/main/harness.ts) fans them out: first sight of a tag
calls `onChildStart`, which creates a thread with `kind: "subagent"` and adopts a
run for the rail; `child.ended` calls `onChildEnd`, which records the child's turn
against that thread. Text, thoughts, tool calls and usage all arrive through the
same callbacks a root turn uses, against the child's thread id.

The child inherits the parent's permission mode and cannot exceed it, so its own
writes and commands hit the gate table again rather than escaping through the
spawn. It reaches Emma's own tools too: `runSubagentChild` in
[`prompt.zig`](../harness/src/acp/prompt.zig) gives the child's tool context the
same `_emma/callTool` responder the parent gets, which is what lets a step's
subagent tick its own tasks off with `plan update`.

The subagent's transcript is a real thread, so its tab renders the same transcript
any thread gets, plus the numbers the parent's header cannot show:

```
Model · Mode · Speed (tok/s) · Tokens (in · out) · Tool calls · Steps · Elapsed · Doing
```

That panel is `AgentPanel` in
[`desktop/src/agents.tsx`](../desktop/src/agents.tsx). Its composer steers rather
than sends: text is delivered with the agent's next tool results, and it is
enabled for as long as the agent is alive. Steering never interrupts a call in
flight.

Colours come from `AGENT_COLORS` in
[`desktop/shared/agents.ts`](../desktop/shared/agents.ts) — eight hues, assigned
by index. The same colour is the dot in the sidebar rail, the dot on the tab, the
square in the inspector's Subagents rail, and the dot on any permission dialog
that agent raises.

### `threads spawn`

`AgentRuntime.spawnThread(turn, title, prompt?)` creates a thread with no `kind`,
so it is `Main`, owned by `turn.parentThreadId ?? turn.threadId`. It counts only
top-level running runs against `MAX_LIVE_THREADS`. It returns a marker:

```
[threads:{id}:{title}]
```

matched by `THREADS_MARKER` in `shared/agents.ts`, which is what the transcript
draws a `ThreadCard` from. With a `prompt` it calls `start(...)` and does not
await it — the new thread runs beside this turn and nothing comes back here. The
model is told to say it is running and check later.

A `ThreadCard` gives the user the same levers the agent has through the `threads`
tool: current activity, Open, Stop, and one line to send. A line goes wherever it
can be read — steered into the agent working there if one is, started as a turn
of its own if the thread is quiet. A message that arrives from another thread is
prefixed `[thread {id} messaged]`.

The inspector draws both, as two separate rails:
`SubagentRail` ("Nothing delegated yet — a subagent gets a row here the moment it starts") and
`SubthreadRail` ("Nothing branched off yet — Emma opens one per `threads spawn`")
in [`desktop/src/context-bar.tsx`](../desktop/src/context-bar.tsx). The subagent
rail is squares into tabs; the sub-thread rail is rows that stay after their work
stops and say how long ago that was.

## Artifact

**A file Emma writes into her own data folder, rendered rather than listed.**

An artifact is worth making when the thing is significant and self-contained
(typically more than 15 lines), when the user will edit or iterate on it, when it
stands on its own away from the conversation, and when it is worth referring back
to. Those four criteria are the bundled skill's, in
[`desktop/skills/artifact/SKILL.md`](../desktop/skills/artifact/SKILL.md).

### The seven kinds

`ARTIFACT_KINDS` in
[`desktop/shared/artifacts.ts`](../desktop/shared/artifacts.ts):

| Kind | Label | Extension | How it renders |
|---|---|---|---|
| `markdown` | Document | `.md` | Parsed and rendered |
| `code` | Code | `.txt` | Highlighted source, never executed |
| `html` | Web page | `.html` | Sandboxed frame, may script |
| `app` | App | `.html` | Sandboxed frame, may script, gets a SQLite file |
| `svg` | Drawing | `.svg` | Framed with scripting off entirely |
| `mermaid` | Diagram | `.mmd` | Rendered by mermaid, `securityLevel: "strict"` |
| `react` | React component | `.jsx` | Highlighted source, never executed |

No model-written React ever runs: `code` and `react` are shown as source. See
[`desktop/src/artifacts.tsx`](../desktop/src/artifacts.tsx) and
[`desktop/src/mermaid-artifact.tsx`](../desktop/src/mermaid-artifact.tsx).

### Sandboxing

Artifacts are served over a custom scheme, `emma-artifact://<id>`, registered in
[`main.ts`](../desktop/main/main.ts). Every frame is `sandbox="allow-scripts"` and
nothing else — never `allow-same-origin`, `allow-forms` or `allow-popups`. The
origin is opaque, which is why the `emma.sql` postMessage bridge replies to `"*"`
and answers only for the artifact id that asked.

The Content-Security-Policy the protocol handler sends:

- `app`: `default-src 'none'; script-src 'unsafe-inline' <own>; style-src 'unsafe-inline' <own>; img-src data: <own>; font-src data:`
- `html`: the same without the own-origin allowance — no sibling files
- `svg`: rendered in a `sandbox=""` srcDoc, so it runs nothing at all
- `code`, `react`, `markdown`, `mermaid`: never framed

So an `html` artifact has no CDN, no webfonts, no network images, no `fetch`, no
storage and no form submission. `/module.js` is served only
for a `code` artifact that has been given a surface.

### Sizes and storage

One directory per artifact under `<userData>/artifacts/<id>/`, holding `meta.json`
and `content.<ext>`, plus any sibling files and `data.sqlite`
([`desktop/main/artifacts.ts`](../desktop/main/artifacts.ts)).

| Limit | Value |
|---|---|
| `MAX_ARTIFACTS` | 512 |
| `MAX_ARTIFACT_BYTES` | 512 KiB |
| `MAX_ARTIFACT_TITLE_CHARS` | 200 |
| `MAX_ARTIFACT_FILES` | 16 |
| `MAX_ARTIFACT_DB_BYTES` | 16 MiB |
| `MAX_ARTIFACT_SQL_CHARS` | 8 KiB |
| `MAX_ARTIFACT_SQL_PARAMS` | 64 |
| `MAX_ARTIFACT_ROWS` | 2000 |

Sibling files are flat names matching `^[a-z0-9][a-z0-9_-]{0,31}\.[a-z0-9]{1,8}$`
with an allowlisted type: `js`, `css`, `json`, `html`, `svg`, `txt`, `md`, `csv`.
Only an `app` may have them, and only an `app` gets `data.sqlite` and the
`emma.sql` bridge — one statement per call, always parameters, booleans as 0/1.

`writeArtifact` keeps `createdAt` and increments `version`. `updateArtifact` and
`updateArtifactFile` replace exactly one verbatim occurrence of `old_str` and
report line numbers when there are several. `surfaceFor` mounts an artifact into
one of Emma's own regions — `navbar`, `chat`, `notch`, `context`, labelled
Sidebar, Thread, Notch, Context bar — one module per region, `"none"` unmounts.

### Making one

`/artifact` in a thread is the entry point; the Artifacts page says so as its
empty state. It resolves to the one bundled skill Emma seeds only when it is
missing — `seedBuiltinSkills(..., ["artifact"])` preserves it on reseed — so the
user's own edits to `SKILL.md` survive.

The `artifact` tool takes `list`, `get`, `create`, `update` and `rewrite`. There
is no delete action: deleting is the user's, on the Artifacts page.

Because the tool is available to any turn, a scheduled job can own a document and
keep it current. The skill's pattern for that is: get the artifact, then search,
read and compute, then update or rewrite it. A flight tracker that searches each
morning and updates the same board is one job and one artifact, not a new
document a day.

The card clip heights are 150px in a transcript and 190px on the Artifacts page.

`visualize` is not an artifact. It draws a chart inline in the transcript
([`desktop/src/chart-artifact.tsx`](../desktop/src/chart-artifact.tsx)), saves
nothing, and belongs to the answer it explains.

## Context

**Everything a turn carries besides the user's sentence.**

### Attached folders

One folder per thread. It is the working directory `emma-cli` is spawned in, and
the grant that makes `read_file`, `write_file`, `ripgrep` and `bash` mean
anything. A thread with no folder is General — Emma can chat there and has no
filesystem at all. The mapping lives in
[`desktop/src/context.ts`](../desktop/src/context.ts) under
`emma.threadFolders.v1`.

### `/` and `@`

In the composer, `/` names a capability and `@` names a file. The grammar is in
[`desktop/shared/slash.ts`](../desktop/shared/slash.ts). The kinds a token can
resolve to are `tool`, `skill`, `mcp`, `builtin`, `file`, `category`, `artifact`
and `page`; the menu shows at most 20.

Picking a `/` tool only writes the token — the turn already advertises the tool,
so naming it points the agent at one rather than calling it. `buildAttachedContext`
in `context.ts` assembles the rest into one bounded block: folder listings, `@`
files, attachments (an image goes in as a path, for the `vision` tool), artifacts,
pages and categories. It returns the text and a list of uses.

An unattended run — a scheduled job, an autoresearch iteration — has nobody at the
composer to resolve its tokens, so `resolveMentions` in
[`main.ts`](../desktop/main/main.ts) does it: the named skill is attached to the
run's thread, and every named artifact, knowledge page and folder file is read
into the same block, looked up in that order.

Everything Emma adds — the resolved system prompt from Settings, the connections
block, and any kept lesson from the Agent page — is written to
`<userData>/harness/.fx/AGENTS.md`, each bounded by `MAX_SYSTEM_PROMPT_CHARS`.

### System prompt

Settings → System prompt is the whole text, not an addition to one: a global
prompt that rides every turn, plus any number of prompts in
[`desktop/shared/prompts.ts`](../desktop/shared/prompts.ts) pinned to a model
family (`family:opus`) or a single model (`model:openrouter:…`). The matching
ones are read after the global, narrowest last, so a pinned prompt wins where
the two disagree. `{available_tools}`, `{model}`, `{model_family}`,
`{workspace}`, `{os}`, `{date}`, `{mode}` and `{connections}` are filled from
the turn; anything else in braces is left as written.

The harness's own prompt in
[`harness/src/builtins/context.zig`](../harness/src/builtins/context.zig) still
sits underneath this one — it carries the tool contracts, so the tools keep
working however the Settings text is rewritten.

### Screen context

A capture from the notch travels as an image plus a note naming the app and
window the user had in front, so the model has a referent for "this"
([`desktop/shared/screen-context.ts`](../desktop/shared/screen-context.ts)). The
store hands out one attachment at a time and clears it once it is delivered.

### The context ledger

The inspector's ledger measures what the thread's turns actually carried. It is
built once, in `useContextLedger`
([`desktop/src/context-bar.tsx`](../desktop/src/context-bar.tsx)), and read by two
widgets so they cannot disagree.

Characters are counted on this Mac and divided by `CHARS_PER_TOKEN` — 4 — to read
as tokens. Every figure is an estimate. The rows are:

| Kind | Row |
|---|---|
| `knowledge` | Prompt, tools & retrieval — the residual |
| `history` | Transcript, plus the turn in flight as its own row |
| `attachment` | An attached file |
| `skill` | An attached skill |

The bar is 48 cells. "Prompt, tools & retrieval" is the residual: whatever the
provider's own input count reports that no measured segment accounts for — the
harness's system prompt, the tool schemas it advertised, retrieved knowledge,
injected skills, resent steps. Free space is only drawn when the model states a
window; on the fallback and local routes the shares are of what the thread has
sent.

Every row is measured off a turn that happened, never off a projection of one
that might. A thread with nothing in it reads zero, which is what it sent.

## Inspector

**The right-hand column, as components you arrange.**

The inspector is data, not a fixed stack.
[`desktop/shared/context-bar.ts`](../desktop/shared/context-bar.ts) defines seven
widgets — Thread stats, Context window, Timeline, Plan, Subagents, Sub threads,
Git — and up to `MAX_CONTEXT_PAGES` (4) named pages holding them, each widget at
most once per page. Settings → Context bar arranges them by dragging the real
components around a column the real width, 288px. Four is the ceiling because a
fifth tab would not fit that column. Page 1 is "Context" and page 2 is "Run".

### The span waterfall

Every turn is a span tree: one span for the run, one per model request, one per
tool call, one per subagent. `AgentRuntime` is the only writer.
[`desktop/shared/trace.ts`](../desktop/shared/trace.ts) owns the geometry and the
storage format; [`desktop/src/timeline.tsx`](../desktop/src/timeline.tsx) draws it.

A span is `{ id, parentId?, name, kind, startedAt, endedAt?, status, input?, output?, tokens? }`.
`kind` is `agent` for a run, `model` for a request, otherwise the tool's kind.
`status` is `running`, `ok` or `failed`.

Two sources feed one list: the turn in flight arrives over `onSpans`, and earlier
turns are read back off the thread with `threadTraces`. They hang under a
synthesised "Overall" root, laid end to end — the gaps between turns are the user
reading and typing, and an axis that included them would squeeze every bar to a
sliver. Within a turn the geometry is exact.

The axis has two readings. **Time** is how long each span took. **Context** is
what each span put in the window, laid end to end, so a two-second call that read
a whole file is a sliver of time and a third of the turn's growth. The Context
toggle only appears when a span actually reported a size. On that axis a parent's
unaccounted remainder is its own share — the flame-graph reading — and Overall's
tail is everything the ledger counts that no span can see.

Expanded, it adds a legend, round tick marks, and the counts: turns, lifetime,
agent time and its percentage, model requests, tool calls, failed spans, and where
tool time went. Clicking a span opens its detail under its own bar, with the
arguments the model sent and what came back.

Stored traces are one span per line of JSON behind a header line. `encodeSpans`
writes them, `decodeSpans` reads them back, and both this side's `clampTrace` and
`crates/core`'s `elide_middle` cut whole spans out of the middle, so whatever
survives still parses. `renderTrace` is the same tree as an indented outline for a
model to read — roughly a third of the tokens of JSON — with `#N` ids that are
depth-first positions, which is what makes "look at span 7" mean something after
the live ids are gone.

### The prompt ledger

The Context window widget, above. Expanded, it becomes a table: segment, kind,
chars, tokens, share, turns — plus free space when the model states a window.

### Git

[`desktop/src/git.tsx`](../desktop/src/git.tsx) over
[`desktop/main/git.ts`](../desktop/main/git.ts). The Changes tab only knows what
Emma's own `write_file` did; git knows what the harness and a `bash` one-liner did
too. The snapshot is the branch, whether this checkout is a linked worktree, the
branch list (newest-committed first, capped at 200), the diff, and whether the
diff was truncated.

The diff is `git diff HEAD`, plus each untracked file diffed against `/dev/null`
so a new file is all green through the same parser. Up to 20 untracked files, and
the whole diff is cut on a line boundary at 512 KiB with the panel saying so. Git
never stages, commits or discards from here; the only two writes are adding a
worktree and switching a branch, and a branch name is put to
`git check-ref-format` rather than to a regex.

The panel draws twice: narrow in the inspector rail with a per-file line cap, and
full width in its own tab where the cap comes off. Either way each file can be
handed to an editor.

### The `+N −M` diff

The Changes tab is everything this thread's agents rewrote, most recent first,
with a revert per file (`ChangesPanel` in
[`desktop/src/agents.tsx`](../desktop/src/agents.tsx)). `diffLines` in
`shared/agents.ts` is a line-level LCS with the common head and tail trimmed;
`diffStat` totals it. Revert restores the text from before the turn. A file Emma
created has nothing to put back, so its Revert is disabled — deleting it is the
user's call, not a button's.

## Mode

**How much a turn may do without asking.**

Four rungs — `ask`, `acceptEdits`, `auto`, `full` — set per thread on the
picker beside ＋, and carried by a scheduled job as the mode it was saved with.
One table in
[`desktop/shared/permissions.ts`](../desktop/shared/permissions.ts) decides what
each rung advertises and what it gates, so the label the user picked and the check
that enforces it cannot drift. A subagent inherits the mode. The full matrix, the
`auto` verifier, and what each tool costs in each mode are in
[permissions.md](permissions.md).

## Skill, MCP server, tool

A **skill** is a folder with a `SKILL.md` that Emma can attach to a turn. Emma
ships her own in [`desktop/skills/`](../desktop/skills), and can import
references to Codex, Claude, Antigravity, Pi, OpenCode, Cursor, Windsurf and Devin
locations without copying their config. See [plugins.md](plugins.md).

An **MCP server** is an external process the harness starts and calls tools on.
Emma speaks no MCP herself: she parses the configured servers and hands them to
the harness at `session/new`, which holds their tools behind `mcp_search_tools`
until the model asks for one. See [plugins.md](plugins.md).

A **tool** is one callable the agent may reach for. The built-ins are listed in
`AGENT_TOOLS` and described in `TOOL_CATALOG`, both in
[`desktop/shared/permissions.ts`](../desktop/shared/permissions.ts); their schemas
are in [`desktop/main/tools.ts`](../desktop/main/tools.ts). Emma can also write
her own with `write_tool` and run them with `run_tool`. See
[tools.md](tools.md).

## Quick action, orb, island

A **quick action** is one of exactly three prompts stored in Settings and bound to
`Command-1/2/3`. Each carries its own destination knowledge base, its own
category, and a switch for whether to save the analyzed result.

An **orb** is a quick action drawn as a circle: they hang under the island when
the pointer swipes below it, and orbit the cursor in a ring when Quick Ask opens.
Main validates the command behind an orb against a fixed catalog rather than
trusting the renderer.

The **island** is Quick Ask itself — one surface that takes over the menu bar on
both sides of the camera housing and hangs below it. Each exchange extends it;
past a bounded height the thread scrolls and Emma offers to continue in the full
app. See [notch.md](notch.md).

## Scheduled job, autoresearch job

A **scheduled job** is a workflow: one validated trigger and a graph of three node
kinds — `agent` runs a prompt, `set` stores a value, `if` branches on a
condition. Triggers are five-field UTC cron, `manual`, `after <job-id>`, or
an app event; only cron has a next run. Jobs run only while Emma is open, open
normal threads under the permission mode they were saved with, and never save
knowledge or write a skill silently. A due job is claimed exactly once, so a tick
that fires twice in one window does not run the same unattended turn twice. See
[jobs.md](jobs.md).

An **autoresearch job** is a long-running experiment loop against a git project on
this Mac: the agent proposes one change, Emma runs the eval command, reads the
metric, and keeps or reverts the commit until a time, token or spend budget stops
it. The metric — its name, kind, direction and folder — is immutable for the life
of the job. See [autoresearch.md](autoresearch.md).

## See also

- [getting-started.md](getting-started.md) — install, run, first turn
- [architecture.md](architecture.md) — process boundaries and the product contract
- [permissions.md](permissions.md) — the four modes and the full gate matrix
- [tools.md](tools.md) — every tool a turn can call
- [knowledge.md](knowledge.md) — bases, save & analyze, the Markdown mirror
- [models.md](models.md) — providers, credentials, the OpenRouter catalog
- [privacy.md](privacy.md) — what leaves this Mac
- [notch.md](notch.md) — Quick Ask, the island, orbs, the radial ring
- [voice.md](voice.md) — dictation engines and drawing
- [jobs.md](jobs.md) — scheduled workflows, triggers, node graphs
- [autoresearch.md](autoresearch.md) — the experiment loop and its immutable metric
- [computer-use.md](computer-use.md) — driving the Mac, and every safety rail
- [plugins.md](plugins.md) — skills, MCP servers, tools Emma writes, CSS plugins
- [design-system.md](design-system.md) — tokens, density, and the visual language
- [harness.md](harness.md) — the fx fork, ACP, and what it reaches today
- [cli.md](cli.md) — the `emma` command and driving other CLIs
- [development.md](development.md) — repo map, house rules, builds, tests
- [data.md](data.md) — every file on disk and every environment variable
- [troubleshooting.md](troubleshooting.md) — when it doesn't work
- [icon-sources.md](icon-sources.md) — where the marks come from
