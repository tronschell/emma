# Scheduled jobs

Work that repeats, run by the clock instead of by you. A job is one trigger plus
a graph of steps; every run opens its own thread you can read afterwards.

The interface calls them **tasks**. The code calls them **jobs** — the `workflow`
tool, `ScheduledJob` in the store. Same thing.

## What a job is

Two parts:

- **A trigger.** When it runs: a cron expression, another job finishing, an app
  event, or nothing at all (`manual`).
- **A graph.** What it does: a JSON array of nodes that pass variables between
  them. Leave it empty and the job is one agent step on its prompt.

The rest of a job is bookkeeping — title, permission mode, enabled, `nextRunAt`,
`lastRunAt`, `lastThreadId`, and `outputs` (the variables the last run finished
with).

The grammar lives in one file, [workflow.ts](../desktop/shared/workflow.ts), and
three callers share it: the main process runs it for real, the `workflow` tool
dry-runs it, and the workspace parses it to draw the graph and refuse a bad edit
before it is saved. `crates/core` stores the JSON and never looks inside it.

## Nodes

Three kinds ([workflow.ts:17](../desktop/shared/workflow.ts)).

| Kind | What it does | Uses |
| --- | --- | --- |
| `agent` | Runs `text` as a full agent turn on the run's thread. The answer becomes `{{last}}`. | `text`, `saveAs`, `next` |
| `set` | Stores `text` in a variable. Nothing runs. | `text`, `saveAs` (required), `next` |
| `if` | Reads `text` as a condition. True goes to `next`, false to `otherwise`. | `text`, `next`, `otherwise` |

Fields:

| Field | Meaning |
| --- | --- |
| `id` | Lowercase letters, digits and dashes, 1–32 characters, first character not a dash. Unique in the graph. |
| `kind` | `agent`, `set` or `if`. |
| `text` | The prompt, the value, or the condition. A template. Up to 8192 characters. |
| `saveAs` | Variable to store the result in. Lowercase letter first, then letters, digits and underscores, up to 32 characters. Not allowed on `if`. |
| `next` | Where to go next. A node id, or `end`. |
| `otherwise` | The false branch. `if` only. |

### Variables

`{{name}}` anywhere in a node's `text` becomes that variable, or an empty string
if it was never set. `{{last}}` is the previous `agent` step's answer, set
automatically. Each stored value is cut at 8192 characters.

### Conditions

`if` reads one of these forms. Anything it cannot parse evaluates to **false** —
a branch never guesses.

| Form | Example |
| --- | --- |
| `is` / `is not` | `{{status}} is done` — case-insensitive |
| `contains` / `does not contain` | `{{digest}} contains error` — case-insensitive |
| `is empty` / `is not empty` | `{{digest}} is not empty` |
| `>` `<` `>=` `<=` | `{{count}} >= 3` — both sides must be finite numbers, or it is false |

### Flow

- A node with no `next` falls through to the next node in the array. A list of
  steps needs no wiring.
- `"next": "end"` finishes the run.
- An `if` with nothing to take on the side it lands on ends the run. It does not
  fall through.
- The walk starts at the **first node in the array**, not at any node called
  `start`.

## Triggers

One string. Four shapes, checked in the renderer by `triggerProblem`
([workflow.ts:196](../desktop/shared/workflow.ts)) and again in Rust by
`validate_schedule` ([scheduled.rs](../crates/core/src/scheduled.rs)). Core is
the one that decides whether the cron fields mean anything.

| Trigger | Fires |
| --- | --- |
| `0 9 * * 1` | Five cron fields, **UTC**. |
| `manual` | Only when you press Run now, or Emma calls `workflow` with `action: "run"`. |
| `after <job-id>` | When that job finishes, with that job's saved variables as its starting point. |
| `on <event>` | When Emma raises that app event. |

The whole string is capped at 128 characters.

### Cron

Five fields, in this order, in UTC — not your local time. The Trigger picker's
time field is labelled **At (UTC)** and prints your local equivalent underneath
it, but UTC is what gets stored.

| Position | Field | Range |
| --- | --- | --- |
| 1 | minute | 0–59 |
| 2 | hour | 0–23 |
| 3 | day of month | 1–31 |
| 4 | month | 1–12 |
| 5 | day of week | 0–7, where 0 and 7 are both Sunday |

Each field takes `*`, a number, a comma list (`1,3,5`), a range (`1-5`), or a
step (`*/15`, `1-5/2`). A step of `0` is rejected.

| Expression | Means |
| --- | --- |
| `0 9 * * *` | 09:00 UTC every day |
| `0 9 * * 1` | 09:00 UTC on Mondays |
| `*/15 * * * *` | Every 15 minutes |
| `30 6 1 * *` | 06:30 UTC on the 1st of every month |
| `0 0 1 1 *` | 00:00 UTC on 1 January |

Emma looks up to a year ahead for the next occurrence — 527,040 minutes. A
schedule with no occurrence in that window is refused with *"schedule has no
occurrence in the next year"*.

The Trigger picker in [schedule.tsx](../desktop/src/schedule.tsx) writes these
for you (Every N minutes / Hourly / Daily / Weekly on… / Monthly / Yearly /
Manually / Cron) and reads a stored expression back into its controls. Anything
it cannot model round-trips verbatim as a raw cron string.

### App events

`on <event>` matches the trigger string exactly, so `on launch` fires only for
the event named `launch`. Emma raises exactly two, both in
[main.ts](../desktop/main/main.ts):

| Event | Raised when | Starting variables |
| --- | --- | --- |
| `launch` | The app finishes starting up. | none |
| `page-saved` | A page is clipped into the knowledge base. | `title`, `url`, `category` |

The grammar accepts any 1–64 character name of lowercase letters, digits and
dashes, so `on anything` saves cleanly and simply never fires. Firing is best
effort: an event that cannot reach the store is logged and dropped.

## What gets rejected

### The graph

`parseWorkflow` returns every problem it found, written for whoever is fixing
them — the model reads them back as a tool result, you read them under the
editor. The complete set:

| Message | Cause |
| --- | --- |
| `The graph is not valid JSON.` | `JSON.parse` failed |
| `The graph must be a JSON array of nodes.` | Not an array |
| `The graph has no nodes.` | Empty array |
| `A task cannot have more than 24 nodes.` | Over `MAX_WORKFLOW_NODES` |
| `Node N is not an object.` | A string, a number, an array, `null` |
| `Node N needs an id of lowercase letters, digits and dashes.` | Bad or missing `id` |
| `Node N repeats the id "x".` | Duplicate `id` |
| `Node "x" needs a kind of agent, set or if.` | Bad or missing `kind` |
| `Node "x" needs text: a prompt, a value, or a condition.` | Empty `text` |
| `Node "x" is longer than 8192 characters.` | `text` over `MAX_VARIABLE_CHARS` |
| `Node "x" saves into "y", which is not a variable name.` | `saveAs` fails the variable pattern |
| `Node "x" is a branch, so it has nothing to save.` | `saveAs` on an `if` |
| `Node "x" has a condition Emma cannot read: …` | `if` whose `text` is not a condition |
| `Node "x" sets a value but says no variable to save it in.` | `set` without `saveAs` |
| `Node "x" is not a branch, so it has no otherwise.` | `otherwise` on `agent` or `set` |
| `Node "x" points its next at "y", which is not a node.` | Dangling `next` or `otherwise` |

**There is no cycle detection.** A graph may point backwards, and the editor
saves it. What stops it is the run: `runWorkflow` walks at most 32 node visits
(`MAX_WORKFLOW_STEPS`) and then returns whatever it has. Loops are a budget, not
an error — unlike plans, where [plan.ts](../desktop/shared/plan.ts) does refuse a
cycle outright.

### The trigger

The renderer refuses anything that is not `manual`, `after <16–96 char id>`,
`on <1–64 char event>`, or exactly five whitespace-separated fields:

> A trigger is five cron fields in UTC ("0 9 \* \* 1"), "manual", "after
> \<task-id\>", or "on \<event\>".

Core then re-checks the same shapes and validates the fields themselves,
answering with *"trigger must be a five-field cron expression, \"manual\",
\"after \<job-id\>\", or \"on \<event\>\""* or *"schedule contains an invalid
cron field"*.

### The permission mode

Core accepts three: `ask`, `acceptEdits`, `full`
([scheduled.rs](../crates/core/src/scheduled.rs)). A job saved before the picker
dropped Plan loads as `ask`. The mode picker in the task editor is the
composer's, which also offers `auto` — saving a job on `auto` is refused by the
store. See [permissions.md](permissions.md).

### Ceilings

| Limit | Value | Where |
| --- | --- | --- |
| Nodes in one graph | 24 | `MAX_WORKFLOW_NODES` |
| Node visits in one run | 32 | `MAX_WORKFLOW_STEPS` |
| Characters kept per variable | 8192 | `MAX_VARIABLE_CHARS` |
| Variables written back to the store | 16 KB | `MAX_VARIABLES_BYTES` / `MAX_WORKFLOW_OUTPUT_BYTES` |
| Whole graph on disk | 32 KB | `MAX_WORKFLOW_NODE_BYTES` |
| Trigger string | 128 characters | `validate_schedule` |
| Trigger fan-out depth | 3 | `MAX_TRIGGER_DEPTH` |
| Source domains on a job | 32 | `MAX_SCHEDULED_SOURCE_DOMAINS` |
| Starting variables read back | 64 entries | `parseVariables` |

Over the 16 KB output ceiling, `packVariables` keeps every variable **name** and
halves the longest value until it fits — which variables exist is what the next
job branches on.

## How a run actually happens

The clock lives in Rust. `crates/core`'s runtime thread wakes every 30 seconds
([live.rs](../crates/core/src/live.rs)) and calls `run_due_jobs`. For each job,
`claim_run` checks it is enabled and past due, stamps `lastRunAt`, and **books
the next occurrence before returning true** — so one tick cannot fire the same
occurrence twice.

Then `hand_out_run` creates a new thread, tags it with the job's id, saves it,
and pushes the run out to Electron as a `dueJob` event. Core never drives the
model: a job is a full agent turn under the mode it was saved with, and the
tools that mode gates live in the app process.

In Electron, `runScheduledWorkflow` ([main.ts](../desktop/main/main.ts)) parses
the graph and walks it. Each `agent` node resolves its `/skill` and `@thing`
tokens the way the composer would, then runs an ordinary turn on the run's
thread. When the walk ends, `finishScheduledJob` stores the variables and fires
anything triggered `after` this job.

Three things follow from that.

**Jobs run only while Emma is open.** The tick is a thread inside the running
app. Nothing is installed in `launchd`, nothing wakes the Mac. Miss a week of
09:00 Mondays and you get **one** run when Emma next starts, not four: a past-due
`nextRunAt` fires once and is immediately rebooked from now.

**Runs are ordinary threads.** Each one is a real thread in the sidebar under
Scheduled tasks, with the job's title, its full transcript, and its durable
trace. Nothing about it is special except the `scheduledJobId` tag.

**The saved permission mode is the gate, and it is the only gate.** Nobody can
answer a dialog at 09:00, so the mode decides everything up front. The `workflow`
tool says so itself: *"Nobody is there to answer a question, so \"ask\" declines
every gated call."* So:

- On `ask` and `acceptEdits`, a gated tool (`bash`, `run_tool`, `cli`,
  `computer`, `install_mcp`, `workflow`, `autoresearch`, plus
  `write_file` on `ask`) still raises the dialog in the main window. If you are
  at the Mac you can answer it. Unanswered, it times out after 10 minutes
  (`MAX_ASK_MS`) and counts as a refusal — and the job sits on that step for as
  long as it takes.
- On `full`, nothing asks.
- Tools gated `auto` run without asking in every mode. That includes
  `save_page`, `write_skill`, `write_tool`, `memory` and `artifact`. **An
  unattended run on `ask` can still file a knowledge page and write a skill.**
  Both land in the run's thread and its trace, but nothing stops them. The full
  table is in [permissions.ts](../desktop/shared/permissions.ts); see
  [permissions.md](permissions.md) and [tools.md](tools.md).

If the graph does not parse, nothing runs. The thread is created anyway and gets
one message saying why, so you do not open an empty thread and wonder:

> This task did not run: its graph will not run as written.

## Chaining jobs

`after <job-id>` is how one job depends on another. When a job finishes,
`finish_scheduled_job` saves its outputs and fires every enabled job whose
trigger is exactly `after <that id>`, handing them those outputs as their
starting variables.

The loop breaker is depth, not cycle detection. A cron or event run starts at
depth 0, each `after` hop adds one, and past `MAX_TRIGGER_DEPTH = 3` nothing
fires. A job that triggers `after` itself runs a bounded number of times and
stops.

Starting variables differ by how a run began:

| How it started | Starting variables |
| --- | --- |
| Cron | none |
| Run now | none |
| `after <job-id>` | the upstream job's saved outputs |
| `on <event>` | the event's variables |
| Test, in the editor | this job's own last saved outputs |

## Lifecycle, history and control

A job's whole life, from the Scheduled section:

1. **Created** — Save in the editor, or Emma calls `workflow` with
   `action: "save"`. Core mints the id and computes `nextRunAt` for a cron
   trigger. `manual`, `after` and `on` jobs have no `nextRunAt`; the rail shows
   "Waits for its trigger".
2. **Waiting** — the header shows `Next run <date> · <time>`. That one is in
   **local** time, unlike the trigger, which is UTC.
3. **Claimed** — the tick fires it, `lastRunAt` is stamped and `nextRunAt`
   rebooked.
4. **Run** — a thread is created and the graph walked.
5. **Finished** — variables written back to `outputs`, downstream `after` jobs
   fired.

Where the history lives:

- **Runs list** in the task editor: every thread tagged with this job, most
  recent first, up to 8 shown, each with its date and message count. Click one to
  open it.
- **Last-run variables**: up to 12 rows under the Runs list, name and value —
  exactly what a downstream job will read.
- **Sidebar**: a "Scheduled tasks" group holding every run thread from every job.
- On disk, each job is one Markdown file with front matter
  (`emma-scheduled-job-format: 3`) in the `scheduled/` folder of Emma's store,
  carrying `next-run-at`, `last-run-at`, `last-thread-id` and `outputs`. See
  [data.md](data.md).

The controls:

| Button | Does |
| --- | --- |
| **Save** / **Create task** | Writes the job. Disabled until title, prompt, trigger and graph are all valid. |
| **Test** | Walks the graph with the turns stood in for — real path, real branches, real variables, no model call, no thread. |
| **Run now** | Fires it immediately, at depth 0, with no starting variables. Works on a paused job too. |
| **Pause** / **Resume** | Flips `enabled`. A paused job is skipped by the tick and by `after`/`on` triggers. |
| **Delete** | Two presses — the second button reads "Delete for good". |

An edit keeps everything the job earned by existing — created-at, enabled,
`lastRunAt`, `lastThreadId`, `outputs`. The booking survives only while the
trigger it was made for does: change the schedule string and `nextRunAt` is
recomputed; leave it alone and editing the prompt does not skip tomorrow.

Test before you save. The `workflow` tool says it outright: *"Always test before
saving something the clock will run unattended."*

## Keeping an artifact current

A job can own an artifact and rewrite it on every run. The mechanism is the
`artifact` tool, which addresses artifacts by id: *"any later thread or scheduled
task can read and rewrite one by its id"*
([tools.ts](../desktop/main/tools.ts)).

That is deliberate: the tool is gated free in every mode because a scheduled task
has to be able to keep its artifact current at 09:00 with nobody watching, and a
free gate on an action that takes the user's kept work off disk is the one
combination worth refusing.

So a flight tracker looks like this. Ask Emma once to make the artifact and note
its id. Then a job whose agent step says:

```
Check the current price for SFO→LHR in October on the usual sites.
Then rewrite artifact art-… so it shows today's number, and keep the
history table below it — append one row, do not replace the table.
```

`artifact` is `auto` in `ask`, `acceptEdits` and `full`, so the run rewrites it
without stopping. `create`, `update` and `rewrite` are available; deleting is
not — that stays yours, from the Artifacts page.

## The Agent page

![The Agent page: turns read, how many ended badly, repeating patterns, lessons kept, and a list of where runs get stuck by tool](../desktop/screenshots/agent-dashboard.png)

The Agent section proposes changes to how Emma works and applies none of them by
itself. It reads the last 40 threads over a 30-day window
([AgentView.tsx](../desktop/src/AgentView.tsx),
[improvement.ts](../desktop/shared/improvement.ts)), finds a friction pattern,
and drafts a proposal — a line for Emma's standing instructions, or a rule for
the Auto verifier. The panel is labelled *"Proposal · nothing is applied until
you start it"*. Approve it and the change runs as an A/B trial: a coin flip per
turn decides which half gets it, both halves are compared on their traces, and
you Keep it or Revert it. You can also hand the friction straight to a new thread.

An older version of this page went further and offered to create a job — a
bounded weekly discovery run limited to a handful of domains, behind an **Approve
weekly job** button. **That is gone.** Nothing in `desktop/` proposes or creates
a scheduled job from the Agent page today. What is left of it is the
`sourceDomains` field on a job — up to 32 domains, still validated in core and
still written to disk — which the current editor always saves empty.

So every job is created by you, or by Emma calling `workflow` in a conversation.
`workflow` is gated `ask` in every mode but `full`, because saving a job hands
out an agent turn that runs later with nobody watching. Knowledge saving is in
[knowledge.md](knowledge.md).

## Autoresearch

Autoresearch is the other automation section and a different loop: a git project,
a permanent metric, an eval command, and three budgets, iterating until a budget
runs out and keeping only the changes that moved the number. No clock, and
nothing in common with the grammar above except the permission mode and the `ask`
gate on its tool. See [autoresearch.md](autoresearch.md).

## End to end: a Monday reading sweep

Say you want a digest of the week's papers every Monday morning, written up only
if there is anything to write up.

1. Open **Scheduled** in the sidebar, then **+ New task**.
2. **Title**: `Weekly reading sweep`.
3. **Trigger**: pick *Weekly on…*, tick Mon, set 09:00. The field stores
   `0 9 * * 1`. Remember it is UTC — check the local-time hint under the picker.
4. **What it does**: `Find this week's machine learning papers worth reading.`
   This is the summary shown for the graph, and the whole job if you write no
   graph.
5. **Runs as**: `acceptEdits` if the job needs to write files, `ask` if it should
   only read and report.
6. Expand **Write the graph** and paste:

```json
[
  {"id": "collect", "kind": "agent", "text": "Find this week's machine learning papers worth reading. List each with one line on why.", "saveAs": "digest"},
  {"id": "check", "kind": "if", "text": "{{digest}} is not empty", "next": "write", "otherwise": "end"},
  {"id": "write", "kind": "agent", "text": "Write up {{digest}} as a short brief and rewrite artifact art-reading-brief with it.", "saveAs": "brief"}
]
```

7. Press **Test**. You get the path without a single model call:

```
collect · agent · (a turn would run: Find this week's machine learning papers worth reading. …)
check · if · (a turn would run: …) is not empty → true
write · agent · (a turn would run: Write up (a turn would run: …) as a short brief …)

Variables afterwards: digest, last, brief
```

8. Press **Create task**. The header switches to `Next run <date> · 09:00`.
9. Press **Run now** to see a real one immediately. A thread appears under
   Scheduled tasks; open it and read what it actually did.
10. Want a follow-up? Make a second job with the trigger `after <the first job's
    id>`. It starts with `digest`, `last` and `brief` already set.

Emma can do all of this from a sentence — "every Monday at 9, find me the week's
papers and write them up" — by calling `workflow`. It will ask before saving.

## See also

- [concepts.md](concepts.md) — threads, runs and what a durable thread is
- [permissions.md](permissions.md) — the four modes and what each one gates
- [tools.md](tools.md) — the `workflow` tool and everything else a job can call
- [knowledge.md](knowledge.md) — the knowledge base a job can file into
- [computer-use.md](computer-use.md) — what an unattended run can do to the Mac
- [autoresearch.md](autoresearch.md) — the other loop
- [data.md](data.md) — where jobs, threads and outputs live on disk
- [architecture.md](architecture.md) — the Rust tick, the host bridge, the split
- [troubleshooting.md](troubleshooting.md) — when a job did not fire
