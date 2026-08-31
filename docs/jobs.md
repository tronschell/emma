# Scheduled jobs

Work the clock runs instead of you. A job is one trigger plus a graph of steps;
every run opens its own thread you can read afterwards.

The interface says **tasks**, the code says **jobs** (`workflow` tool,
`ScheduledJob` in the store). Same thing.

The grammar lives in [workflow.ts](../desktop/shared/workflow.ts) and has four
callers: main runs it for real, the `workflow` tool dry-runs it, the workspace
draws it and refuses a bad edit. `crates/core` stores the JSON and never looks
inside it.

## Nodes

Four kinds. Leave the graph empty and the job is one `agent` step on its prompt.

| Kind | What it does | Fields it uses |
| --- | --- | --- |
| `agent` | Runs `text` as a full agent turn on the run's thread. The answer becomes `{{last}}`. | `text`, `saveAs`, `next` |
| `script` | Runs the fixed absolute file in `text` from a connected folder. Optional templated `input` is sent on stdin. | `text`, `input`, `saveAs`, `next` |
| `set` | Stores `text` in a variable. Nothing runs. | `text`, `saveAs` (required), `next` |
| `if` | Reads `text` as a condition. True takes `next`, false takes `otherwise`. | `text`, `next`, `otherwise` |

| Field | Rule |
| --- | --- |
| `id` | `/^[a-z0-9][a-z0-9-]{0,31}$/`, unique in the graph |
| `kind` | `agent`, `script`, `set` or `if` |
| `text` | Prompt, fixed script path, value or condition. ≤ 8192 characters |
| `input` | `script` only. A template sent on stdin. ≤ 8192 characters |
| `saveAs` | `/^[a-z][a-z0-9_]{0,31}$/`. Not allowed on `if` |
| `next` | A node id, or `end` |
| `otherwise` | The false branch. `if` only |

**Variables.** `{{name}}` in ordinary node `text` or script `input` expands to
that variable, or to an empty string if it was never set. `{{last}}` is the
previous `agent` answer. Every stored value is cut at `MAX_VARIABLE_CHARS`
(8192).

**Scripts.** A script path cannot contain a template and must resolve inside a
folder connected to Emma. Python, JavaScript, sh and zsh files run through their
matching interpreter without a shell command; any other file runs directly and
therefore needs an executable bit and shebang. Stdout is the result, stderr is
labelled alongside it, and non-zero exits or the 120-second timeout are appended
to the result. `saveAs` makes that result available to a later agent node:
`{"id":"analyze","kind":"agent","text":"Analyze {{script_output}}"}`.

**Conditions.** Operators are matched longest first, so `is not empty` is never
read as `is`. Anything `parseCondition` cannot read evaluates to **false** — a
branch never guesses.

| Form | Example |
| --- | --- |
| `is` / `is not` | `{{status}} is done` — case-insensitive |
| `contains` / `does not contain` | `{{digest}} contains error` — case-insensitive |
| `is empty` / `is not empty` | `{{digest}} is not empty` |
| `>` `<` `>=` `<=` | `{{count}} >= 3` — false unless both sides are finite numbers |

**Flow.** The walk starts at the first node in the array, not at anything called
`start`. A node with no `next` falls through to the next node written, so a plain
list of steps needs no wiring. `"next": "end"` finishes the run. An `if` whose
landing side is empty ends the run rather than falling through.

## Triggers

One string, four shapes, capped at 128 characters. `triggerProblem` checks the
shape in the renderer; `validate_schedule` in
[scheduled.rs](../crates/core/src/scheduled.rs) checks it again and owns whether
the cron fields mean anything.

| Trigger | Fires |
| --- | --- |
| `0 9 * * 1` | Five cron fields, **UTC** |
| `manual` | Run now, or `workflow` with `action: "run"` |
| `after <job-id>` | When that job finishes, starting from its saved variables |
| `on <event>` | When Emma raises that app event |

### Cron

Five fields in UTC — minute (0–59), hour (0–23), day of month (1–31), month
(1–12), day of week (0–7, both 0 and 7 Sunday). Each takes `*`, a number, a
comma list (`1,3,5`), a range (`1-5`) or a step (`*/15`, `1-5/2`); a step of `0`
is rejected. `next_run` scans 527,040 minutes — one year — and refuses a schedule
with no occurrence in that window: *"schedule has no occurrence in the next
year"*.

The Trigger picker ([schedule.tsx](../desktop/src/schedule.tsx)) writes the
expression for you — Every N minutes / Hourly / Daily / Weekly on… / Monthly /
Yearly / Manually / Cron — and reads a stored one back. Anything it cannot model
round-trips verbatim as a raw cron string. It is labelled **At (UTC)** and prints
your local equivalent underneath.

### App events

`on <event>` matches the whole trigger string, so `on launch` fires only for
`launch`. Emma raises exactly two, both from [main.ts](../desktop/main/main.ts):

| Event | Raised when | Starting variables |
| --- | --- | --- |
| `launch` | The app has finished starting up | none |
| `note-kept` | A note has been kept into the vault and tagged | `title`, `tags` |

The grammar accepts any 1–64 character name of lowercase letters, digits and
dashes, so `on anything` saves cleanly and never fires. Firing is best effort: an
event that cannot reach the store is logged and dropped.

## What gets rejected

`parseWorkflow` returns every problem it found as plain sentences — the model
reads them back as a tool result, you read them under the editor. The rules:
valid unique `id`; a known `kind`; non-empty `text` of at most 8192 characters; a
`saveAs` that matches the variable pattern and is absent on `if`; `set` must have
a `saveAs`; `input` only on `script`; a fixed absolute path on `script`;
`otherwise` only on `if`; a readable condition on `if`; and every
`next`/`otherwise` must name a node or `end`. Over 24 nodes, or not a non-empty
JSON array, and nothing else is checked.

**There is no cycle detection.** A graph may point backwards and the editor saves
it. The run is what stops it: `runWorkflow` walks at most 32 node visits and
returns whatever it has. (Plans do refuse a cycle outright — see
[plan.ts](../desktop/shared/plan.ts).)

**Permission mode.** Core accepts three: `ask`, `acceptEdits`, `full`. A job
stored as `plan` — the mode that no longer exists — loads as `ask`. See
[permissions.md](permissions.md).

| Limit | Value | Where |
| --- | --- | --- |
| Nodes in one graph | 24 | `MAX_WORKFLOW_NODES` |
| Node visits in one run | 32 | `MAX_WORKFLOW_STEPS` |
| Characters kept per variable | 8192 | `MAX_VARIABLE_CHARS` |
| Variables written back | 16 KB | `MAX_VARIABLES_BYTES` / `MAX_WORKFLOW_OUTPUT_BYTES` |
| Whole graph on disk | 32 KB | `MAX_WORKFLOW_NODE_BYTES` |
| Title | 128 characters | `ScheduledJob::new` |
| Prompt | 8 KB | `ScheduledJob::new` |
| Trigger string | 128 characters | `validate_schedule` |
| Trigger fan-out depth | 3 | `MAX_TRIGGER_DEPTH` |
| Source domains on a job | 32 | `MAX_SCHEDULED_SOURCE_DOMAINS` |
| Starting variables read back | 64 entries | `parseVariables` |

Over the 16 KB output ceiling, `packVariables` keeps every variable **name** and
halves the longest value until it fits: which variables exist is what the next
job branches on.

## How a run happens

The clock is a Rust thread. It wakes every 30 seconds
([live.rs](../crates/core/src/live.rs)) and calls `run_due_jobs`. `claim_run`
checks the job is enabled and due, stamps `lastRunAt`, and **books the next
occurrence before returning true**, so overlapping ticks cannot fire the same
occurrence twice. `hand_out_run` then creates a thread, tags it with the job id,
saves it, and pushes a `dueJob` event to Electron. Core never drives a model.

In Electron, `runScheduledWorkflow` ([main.ts](../desktop/main/main.ts)) parses
the graph and walks it. Each `script` node runs locally first; each `agent` node
resolves its `/skill` and `@thing` tokens the way the composer would, then runs
an ordinary turn. At the end,
`finishScheduledJob` stores the packed variables and fires anything triggered
`after` this job.

**Jobs run only while Emma is open.** The tick is a thread inside the running
app: nothing is installed in the operating system scheduler, nothing wakes the
computer. Miss four Mondays
and you get **one** run when Emma next starts — a past-due `nextRunAt` fires once
and is rebooked from now.

**Runs are ordinary threads.** Each is a real thread in the sidebar under
Scheduled tasks, with the job's title, full transcript and durable trace. Nothing
is special about it except the `scheduledJobId` tag.

**The saved mode is the only gate.** Nobody is there to answer at 09:00, so:

- On `ask` and `acceptEdits` a gated tool (`run_tool`, `cli`, `computer`,
  `browser`, `install_mcp`, `workflow`, `autoresearch`, plus the harness's own
  file mutations, which `acceptEdits` lets through) still raises the dialog in
  the main window. Answer it if you are at the computer. Unanswered it times out after
  `MAX_ASK_MS` (10 minutes) and counts as a refusal, and the job sits on that
  step until then.
- A harness tool call that reaches outside the connected folder is refused in
  every mode, `full` included, and recorded as a blocked step.
- On `full` nothing asks.
- Tools gated `auto` run unasked in **every** mode — including `keep`,
  `write_skill`, `write_tool`, `memory` and `artifact`. An unattended run on
  `ask` can still file a note into your vault and write a skill. Both land in the
  run's thread and trace; nothing stops them. Table:
  [permissions.ts](../desktop/shared/permissions.ts).

If the graph does not parse nothing runs, but the thread is still created and
gets one message saying why: *"This task did not run: its graph will not run as
written."*

## Chaining

When a job finishes, `finish_scheduled_job` saves its outputs and fires every
enabled job whose trigger is exactly `after <that id>`, handing them those
outputs. The loop breaker is depth, not cycle detection: a cron or event run
starts at depth 0, each `after` hop adds one, and past `MAX_TRIGGER_DEPTH` (3)
nothing fires.

| How a run started | Starting variables |
| --- | --- |
| Cron | none |
| Run now | none |
| `after <job-id>` | the upstream job's saved outputs |
| `on <event>` | the event's variables |
| Test, in the editor | this job's own last saved outputs |

## The editor

| Button | Does |
| --- | --- |
| **Save** / **Create task** | Writes the job. Disabled until title, prompt, trigger and graph are all valid |
| **Test** | Walks the graph with every agent turn and script stood in for — validates script paths, no model call, no process, no thread |
| **Run now** | Fires it immediately, at depth 0, with no starting variables. Works on a paused job |
| **Pause** / **Resume** | Flips `enabled`. A paused job is skipped by the tick and by `after`/`on` |
| **Delete** | Two presses; the second reads "Delete for good" |

The header shows `Next run <date> · <time>` in **local** time, or "Waits for its
trigger" for `manual`, `after` and `on`. Under it: the **Runs** list (threads
tagged with this job, newest first, 8 shown) and up to 12 last-run variables —
exactly what a downstream job will read.

An edit keeps created-at, `enabled`, `lastRunAt`, `lastThreadId` and `outputs`.
Change the trigger and `nextRunAt` is recomputed; edit only the prompt and
tomorrow's booking stands.

Each job carries the model its runs use, picked in the editor next to the title
from the same picker the composer uses. It is stored as the desktop's model key
(`openrouter:<id>`, or empty for whichever model the app is set to when the job
fires) and core never interprets it. Local model profiles are not offered: one
is chosen for the app as a whole, not for a single unattended run.

`sourceDomains` is still validated in core and written to disk, but the editor
only ever saves back what the job already had.

On disk each job is one Markdown file with front matter
(`emma-scheduled-job-format: 4`) under `scheduled/` in Emma's data dir, carrying
`next-run-at`, `last-run-at`, `last-thread-id`, `model` and `outputs`. See
[data.md](data.md).

## See also

- [permissions.md](permissions.md) — the four modes; a job may be saved as three of them
- [tools.md](tools.md) — the `workflow` tool and everything else a job can call
- [computer-use.md](computer-use.md) — what an unattended run can do to the computer
- [autoresearch.md](autoresearch.md) — the other automation loop, no clock involved
- [data.md](data.md) — where jobs, threads and outputs live
- [troubleshooting.md](troubleshooting.md) — when a job did not fire
