# Concepts

Emma's vocabulary, one entry each. Where an entry has more to it than a
paragraph, that detail lives in the feature's own doc, linked.

## Thread

**A timeline that outlives every run inside it.** The unit the sidebar
lists, the unit a permission mode is set on, and the unit that gets a file on
disk: one Markdown file at `<data root>/threads/{id}.md`, written to `.{id}.tmp`
and renamed over the destination so a half-written thread never exists
([`crates/core/src/thread.rs`](../crates/core/src/thread.rs)). The record is
`{ id, title, parent_thread_id, kind, scheduled_job_id, created_at, updated_at,
archived_at, goal, messages, traces }`; `kind` is `main` or `subagent` and `goal`
is present only on a thread pursuing one. Front matter is versioned as
`emma-thread-format` — 13 today, and every older version still parses.
Ceilings: `MAX_THREAD_MESSAGES` 1024, `MAX_THREAD_TRACES` 64,
`MAX_TRACE_BYTES` 16 KiB. `traces` is `#[serde(skip)]`, so it never rides a
snapshot.

A thread can be **pinned**: right-click the row, or use the pin that appears on
hover. Pinned threads leave their project group and stand in a `Pinned` section
above every project, each row prefixed with the name of the folder it is filed
under. The list is local to the machine (`emma.threadPins.v1` in the renderer's
storage), most recently pinned first.

## Run · turn

**One agent loop inside a thread: a prompt in, an answer recorded, spans left
behind.** A thread persists; a run dissolves when its job is done — that is the
whole distinction. The loop itself is the harness, driven over ACP from
[`desktop/main/harness.ts`](../desktop/main/harness.ts); Electron main keeps the
agent rail, the durable traces, the permission channel, and four tools it answers
itself (`OWN_TOOLS` = `read_trace`, `threads`, `agents`, `advisor`). "Turn" is
the request-shaped view of the same thing: every surface — composer, Quick Ask, a
quick action, a due scheduled job — funnels through one `sendMessage`
interception in `main.ts`, so the mode, the gate table and the trace writer exist
once. When a turn finishes, `recordTurn` appends the prompt and the answer, and
the assistant message carries `output_tokens`, `duration_milliseconds`,
`input_tokens` and `model`.

## Queue · steer · stop

**Three doors into a turn already running, and they are not the same door.**
The composer never blocks: Enter always queues, and
[`runs.ts`](../desktop/src/runs.ts) drains the queue one turn at a time, so a
second message waits for the first turn to end.

⤳ **steers.** ⌘Enter in the composer, or `steer` on a queued line, sends the
text over `session/steer`, and it cuts in: the tool call or model stream in
flight is aborted, the partial answer and the aborted call are written to
history the way a stop writes them, and the same turn carries straight on with
the text as its next user message. The turn never ends, so nothing queued behind
it fires and the model keeps the work it had already done. At most 8 messages,
4096 characters each, and there has to be a turn running. A stop that lands on
the same turn wins.

Esc, and ■ **stop.** The turn is cancelled — the partial answer, the tool call
it was in, and what it had already finished are all written to history, so
nothing is lost — and everything still queued behind it is *held* rather than
fired at a thread whose direction just changed. Held messages sit above the
composer with ↑ to send and × to drop. With text typed, Esc stops and sends what
you typed as the next turn.

A subagent has its own composer, and its own door: `session/steer_child`, which
lands with the child's next tool result.

## Subagent

**A worker that dissolves once it answers.** It is the harness's own tool, not
Emma's — a child runs inside the `emma-cli` process, so it does not queue behind
its parent's turn. Emma sees it because its updates ride the parent's ACP stream
tagged `_meta.fx.child`, and gives it a thread with `kind: subagent` so it gets a
real transcript and telemetry, opened from the Subagents component of the context
bar or from the sidebar's agent rail. It is not in the sidebar's thread list, and
it takes no tab: the thread tab strip carries threads — this one, its parent, and
the sub-threads under it. It inherits the parent's permission mode and cannot
exceed it.

## Sub-thread

**A conversation that stays.** `threads spawn` creates an ordinary thread —
`kind: main` — owned by the spawning thread and nested under it in the sidebar.
With a prompt it starts work immediately, beside the calling turn rather than
inside it, and nothing comes back. `MAX_LIVE_THREADS` is 8, counting top-level
runs. The spawn's result carries `[threads:{id}:{title}]` on its first line,
which is what the transcript draws its card from
([`desktop/shared/agents.ts`](../desktop/shared/agents.ts)).

## Artifact

**A file Emma produced that outlives the conversation**, stored at
`<userData>/artifacts/<id>/` as `meta.json` plus `content.<ext>` — Electron's,
not the host's. Seven kinds: `markdown`, `code`, `html`, `app`, `svg`, `mermaid`,
`react`. `html` and `app` are framed `sandbox="allow-scripts"` over the
`emma-artifact://` scheme with their own CSP; `svg` is framed with scripting off;
`code` and `react` are shown as highlighted source and never executed. Limits in
[`shared/artifacts.ts`](../desktop/shared/artifacts.ts): `MAX_ARTIFACTS` 512,
`MAX_ARTIFACT_BYTES` 512 KiB, `MAX_ARTIFACT_FILES` 16, `MAX_ARTIFACT_DB_BYTES`
16 MiB. The `artifact` tool takes `list`, `get`, `create`, `update`, `rewrite`;
deleting is the user's, on the Artifacts page. `visualize` is *not* an artifact —
it draws an inline page in the transcript and saves nothing until the user keeps
it.

## Component

**A widget in Emma's own interface that Emma built.** Not an artifact: it does
not outlive the interface, it *is* the interface, and it never appears on the
Artifacts page. Stored at `<userData>/components/<id>/` as `meta.json`,
`module.js` and `shot.png`, served over the `emma-component://` scheme, and
mounted into the running React tree by `createPortal`.

There is one place it can go: the context bar, under the built-in widgets and in
their chrome, so a component gets the column's padding and reveal rather than its
own. That is enforced in main, not asked for in the prompt — a component that can
land anywhere is a component that can break the layout it lands in.

It reads the app through `emma` and the outside through `fetch`, which goes out
through main against public https only. Secrets are environment variable names it
declares in `variables`; the user fills them in **Settings → Built by Emma** and
the module writes `{{NAME}}` into a url, header or body. The values never reach
the renderer.

`expand` gives it a ⤢ that opens it over the whole window and hands it
`expanded`, for what will not read in 288px. Each `rewrite` bumps the version, the
module URL carries it, and the mounted copy reloads in place — that is the
iteration loop. A new version wipes in behind a left-to-right ASCII reveal.

Deleting is the user's, from the ⋯ in the component's own header or from
**Settings → Built by Emma**, which shows each one's picture, switches it off,
fills in its variables, and sends it back to a thread as an attachment to keep
working on. Limits in
[`shared/components.ts`](../desktop/shared/components.ts): `MAX_COMPONENTS` 64,
`MAX_COMPONENT_CHARS` 64 KiB, `MAX_COMPONENT_VARIABLES` 8.

## Context

**Everything a turn carries besides the user's sentence.** One attached folder
per thread, which is the directory `emma-cli` is spawned in and the grant that
makes file and shell tools mean anything; a thread with no folder has no
filesystem at all. In the composer `/` names a capability and `@` names a file
([`shared/slash.ts`](../desktop/shared/slash.ts)); `buildAttachedContext` in
[`src/context.ts`](../desktop/src/context.ts) assembles folder listings, `@`
files, attachments and artifacts into one bounded block. A listing is capped at
`MAX_FOLDER_FILES` (400) per folder and six levels deep; `listFolderFiles`
returns that page with the total it counted, so the Files picker reads
`Showing 400 of N` instead of looking empty. Any file can still be read by path
past the cap. Emma's own standing
text goes to two files under the `HOME` she hands the harness: the resolved
Settings prompt to `<userData>/harness/.fx/system-prompt.md`, which stands in for
the agent's own built-in prompt, and kept Agent-page improvements to
`<userData>/harness/.fx/AGENTS.md` under it. A notch capture travels as an image
plus a note naming the app and window that were in front.

## Inspector

**The right-hand column, as components you arrange.** Ten widgets — Thread
stats, Context window, Timeline, Plan, Subagents, Sub threads, Git, and three
machine components (numbers, sparklines, meters) — over up to
`MAX_CONTEXT_PAGES` (4) named pages, each widget at most once per page
([`shared/context-bar.ts`](../desktop/shared/context-bar.ts)). Settings → Context
bar arranges them by dragging the real components around a column of the real
width, 288px; four pages is the ceiling because a fifth tab would not fit it. The
timeline, the prompt ledger and the Git panel are all covered in
[context-bar.md](context-bar.md).

## Knowledge base · vault

**"Knowledge base" is the label; the vault is the storage.** The user picks an
[Obsidian](https://obsidian.md) vault or any plain folder, and Emma writes one
Markdown note per save into `<vault>/knowledge-base` (`DEFAULT_VAULT_FOLDER`)
with attachments under `attachments/`. There is no second copy and no mirror —
the vault *is* the store, readable and editable without Emma. Limits in
[`shared/vault.ts`](../desktop/shared/vault.ts): `MAX_NOTE_BYTES` 256 KiB,
`MAX_ATTACHMENT_BYTES` 8 MiB, `MAX_TAGS` 8, `MAX_VAULT_NOTES` 2000. See
[knowledge.md](knowledge.md).

## Keep

**The one way anything reaches the vault.** The `keep` tool — and the Keep button
on a visual — writes a single note whose kind is `screenshot`, `selection`,
`page` or `note`, with front matter `title`, `kind`, `saved`, optional `source`
and `application`, and `tags`. Tags are filled in afterwards by
[`main/vault-tags.ts`](../desktop/main/vault-tags.ts). Every path is checked to
stay inside the chosen folder before anything is written
([`main/vault.ts`](../desktop/main/vault.ts)).

## Plan

**A tool, not a mode.** `plan` breaks a job into steps in a Markdown file at
`<userData>/plans/<id>.md`, each step a subagent's brief wired to the steps it
waits on. Steps whose dependencies are all `done` are a *wave*, and `plan run`
hands out one brief per step in the wave for the model to spawn subagents
against, capped at `MAX_LIVE_SUBAGENTS` (8). Markdown is the store, not an export
of one, so [`shared/plan.ts`](../desktop/shared/plan.ts) never throws on a
hand-edited file. `MAX_PLAN_STEPS` 24, `MAX_STEP_TASKS` 100, `MAX_PLANS` 64,
`MAX_PLAN_BYTES` 128 KiB. There is no `plan` permission mode — the modes are
`ask`, `acceptEdits`, `auto`, `full` (see [Mode](#mode)).

## Task list

`task_list` is the durable checklist for complex work one agent is doing itself.
Its Markdown record lives at `<userData>/task-lists/<id>.md`; every task has a
stable id, status, and any number of nested subtasks. Rewriting the tree keeps
the status of ids that remain. Use `plan` when the point is parallel subagents.

## Goal

**One objective a thread keeps working at on its own.** Set one and Emma re-drives
the thread turn after turn without being asked again, stopping when the objective
is met *with evidence*, when the same blocker has stood three consecutive goal
turns, or when the allowance — 200,000 tokens and 40 turns by default — runs out.
The record lives on the thread itself
([`crates/core/src/thread.rs`](../crates/core/src/thread.rs)), and so do the
invariants: completion is rejected without evidence, a blocker only sticks at
three, and every turn's tokens are folded in by `record_turn`. Status is one of
`active`, `paused`, `complete`, `blocked`, `budgetLimited`, `usageLimited`. The
loop hangs off `driveTurn`; the transcript draws a card from the `[goal:<id>]`
marker a goal tool call leaves, and pressing it opens the thread's Goal tab. Full
detail in [goals.md](goals.md).

## Mode

**How much a turn may do without asking.** Four rungs, set per thread and carried
by a scheduled job as the mode it was saved with: `ask` ◈ (every write, command
and click asks), `acceptEdits` ◆ (file edits go through, commands and the pointer
still ask), `auto` ⬗ (a separate verifier model reads each gated call and
anything it will not clear still asks), `full` ⬥ (nothing asks; Escape still
stops a run). Default is `ask`. One table in
[`shared/permissions.ts`](../desktop/shared/permissions.ts) decides what each
rung advertises and what it gates; a subagent inherits the mode and cannot exceed
it. Full matrix in [permissions.md](permissions.md).

## Workflow

**A scheduled job's body: a graph of nodes, not a single prompt.** Four kinds —
`agent` runs a turn, `script` runs a fixed local file, `set` computes a value,
`if` branches — passing `{{name}}`
variables between them. The trigger is a five-field UTC cron expression,
`manual`, `after <job-id>`, or `on <event>`. One implementation in
[`shared/workflow.ts`](../desktop/shared/workflow.ts) serves three callers: main
runs it, the `workflow` tool dry-runs it, the workspace draws it and refuses a
bad edit. Core stores the graph as opaque JSON. `MAX_WORKFLOW_NODES` 24,
`MAX_WORKFLOW_STEPS` 32, `MAX_VARIABLE_CHARS` 8192. Jobs run only while Emma is
open. See [jobs.md](jobs.md).

## Autoresearch

**A long experiment loop against a git project on this computer.** The agent proposes
one change, Emma runs the eval command (`MAX_EVAL_MS` 15 minutes), reads the
metric out of its output, and keeps or reverts the commit — until a time, token
or spend budget stops it. The metric's name, kind and direction are immutable for
the life of the job, and every iteration is appended to `results.tsv` in the
project itself, readable outside Emma. Core stores the job and its iterations and
never runs one; the loop is in
[`main/research.ts`](../desktop/main/research.ts). See
[autoresearch.md](autoresearch.md).

## Computer use

**Emma operating an approved app on this computer.** The agent loop asks;
Electron main executes, because it is the process that owns the screen. The
`computer` tool requires a separate approval for the named running app in every
permission mode. Every ceiling applies in *every* mode:
`MAX_RUN_STEPS` 20, `MAX_RUN_ACTIONS` 400, `MIN_ACTION_INTERVAL_MS` 40,
`MAX_RUN_MS` 10 minutes, `MAX_TYPED_CHARACTERS` 4096, `MAX_WAIT_SECONDS` 300,
`MAX_KEY_REPEAT` 32, `HELPER_TIMEOUT_MS` 5000 — plus the always-on-top banner,
the per-action log line, and Escape as a system-wide kill switch registered only
for the life of a run. Screenshots stay in Emma's process and the tool answers in
text; `vision` is the deliberate exception that posts an image to a model. See
[computer-use.md](computer-use.md).

## Skill · MCP server · tool

A **skill** is a folder with a `SKILL.md` that Emma can attach to a turn; seven
ship in [`desktop/skills/`](../desktop/skills). An **MCP server** is an external
process the harness starts and calls tools on — Emma speaks no
[MCP](https://github.com/modelcontextprotocol/modelcontextprotocol) herself, she parses the configured
servers and hands them to the harness at `session/new`. A **tool** is one
callable the agent may reach for: Emma's own 26 are in `AGENT_TOOLS` and
`TOOL_CATALOG` ([`shared/permissions.ts`](../desktop/shared/permissions.ts)), the
harness has its own builtins (file read/write/edit, ripgrep search, shell,
subagent, skills, MCP), and Emma can write more with `write_tool`. See
[tools.md](tools.md) and [plugins.md](plugins.md).

## See also

- [architecture.md](architecture.md) — process boundaries and the trust model
- [permissions.md](permissions.md) — the four modes and the full gate matrix
- [tools.md](tools.md) — every tool a turn can call
- [context-bar.md](context-bar.md) — the inspector's widgets in detail
- [goals.md](goals.md) — the ledger, the continuation loop, evidence and the blocked audit
- [knowledge.md](knowledge.md) — the vault, keeping, and tags
- [jobs.md](jobs.md) · [autoresearch.md](autoresearch.md) · [computer-use.md](computer-use.md)
- [development.md](development.md) — repo map, checks, builds, packaging
- [data.md](data.md) — every file on disk and every environment variable
