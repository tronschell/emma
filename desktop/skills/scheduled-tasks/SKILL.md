---
name: scheduled-tasks
description: How to build, edit, test, run and delete the user's scheduled tasks with the `workflow` tool — the trigger grammar (cron, manual, after another task, on an app event), the node graph (agent, script, set, if), variables and conditions. Use whenever the user asks for something to happen on a schedule, to happen every time they do something, to run a local script and pass its output onward, to happen after something else finishes, or asks to see, change, pause or delete what is already scheduled.
---

# Scheduled tasks

A scheduled task is work the user stops having to ask for. You build them with
the `workflow` tool; the user sees them under Scheduled tasks in the sidebar,
and every run opens its own thread there.

This skill ships with the app and is rewritten from `desktop/skills/` on every
launch. Do not edit it with `write_skill`; write what you learn as a separate
skill and it survives.

## The shape of a task

A task is **a trigger** plus **a graph of nodes**. Nothing else.

```
workflow {"action": "save", "title": "Monday reading", "trigger": "0 9 * * 1",
          "prompt": "Collect what's worth reading this week",
          "permissionMode": "acceptEdits"}
```

That is a whole task: one agent step running `prompt`. Reach for a graph only
when the work branches or has to pass something between steps.

## Triggers

| Trigger | Fires |
|---|---|
| `0 9 * * 1` | five cron fields, **UTC** — Mondays at 09:00 |
| `manual` | only when the user or you run it |
| `after job-…` | when that task finishes, starting with its variables |
| `on launch`, `on page-saved` | when Emma raises that app event |

A chain of `after` triggers is cut off after three hops, so two tasks that
trigger each other cannot run forever.

## Nodes

`nodes` is a JSON array. Every node has an `id` (lowercase, dashes), a `kind`
and `text`.

| kind | what it does |
|---|---|
| `agent` | runs `text` as a full turn, exactly like a message from the user |
| `script` | runs the fixed absolute file in `text`, sends optional templated `input` on stdin and returns its output |
| `set` | stores `text` in `saveAs` without running anything |
| `if` | reads `text` as a condition; goes to `next` when it holds, `otherwise` when it does not |

- `saveAs` keeps a step's result as a variable. `if` has nothing to save.
- `{{name}}` in ordinary `text` or script `input` becomes that variable;
  `{{last}}` is the last agent answer. An unset variable expands to nothing.
- A script path is absolute, fixed rather than templated, and inside a folder
  the user connected to Emma. `.py`, `.js`/`.mjs`/`.cjs`, `.sh` and `.zsh`
  have built-in runners; another script must be executable and carry a shebang.
- A step with no `next` falls through to the node written below it, so a plain
  list of steps needs no wiring. `"next": "end"` finishes the run.
- A branch **must** say where both sides go — a branch that says nothing ends
  the run rather than falling into whatever came next.

Conditions: `X is Y`, `X is not Y`, `X contains Y`, `X does not contain Y`,
`X is empty`, `X is not empty`, and numeric `>`, `<`, `>=`, `<=`. Anything else
is false, never a guess.

```json
[
  {"id": "collect", "kind": "agent", "text": "Find this week's papers on sleep", "saveAs": "digest"},
  {"id": "check", "kind": "if", "text": "{{digest}} is not empty", "next": "write", "otherwise": "quiet"},
  {"id": "write", "kind": "agent", "text": "Write up {{digest}} into notes/reading.md", "saveAs": "writeup", "next": "end"},
  {"id": "quiet", "kind": "set", "text": "nothing this week", "saveAs": "writeup"}
]
```

The variables a run ends with are its output: a task triggered `after` this one
starts with `digest` and `writeup` already set.

To hand deterministic script output to a model, save it and use that variable in
the next agent prompt:

```json
[
  {"id": "calculate", "kind": "script", "text": "/Users/me/reports/calculate.py", "input": "{{source}}", "saveAs": "numbers"},
  {"id": "analyze", "kind": "agent", "text": "Analyze these calculated results:\n{{numbers}}"}
]
```

## Working on tasks

| Ask | Call |
|---|---|
| what is scheduled | `workflow` with no arguments |
| one task in full | `{"action": "get", "jobId": "job-…"}` |
| create or edit | `{"action": "save", …}` — with `jobId` it edits in place and keeps everything you did not send |
| dry run | `{"action": "test", …}` — walks the graph, takes no turns |
| run it now | `{"action": "run", "jobId": "job-…"}` |
| remove it | `{"action": "delete", "jobId": "job-…"}` |

**Test before you save something the clock will run unattended.** `test` reports
the path a run takes, which branch each `if` takes and what the variables end
up as, without running a single turn. It accepts a graph you have not saved
yet, so a task can be checked before it exists. A test validates a script path
but does not execute the script; use **Run now** for a real end-to-end check.

## Tasks that keep an artifact up to date

A run has the `artifact` tool like any other turn, so a task can own a document
and rewrite it every time it fires. This is the shape to reach for when the user
wants something that *accumulates* rather than something that notifies.

```json
[
  {"id": "read", "kind": "agent", "text": "artifact {\"action\":\"get\",\"id\":\"flight-tracker\"}", "saveAs": "current"},
  {"id": "search", "kind": "agent", "text": "Search for fares LHR→JFK in March. Current board:\n{{current}}", "saveAs": "found"},
  {"id": "write", "kind": "agent", "text": "Update the flight-tracker artifact with {{found}}: change the prices that moved, leave the rest.", "next": "end"}
]
```

Give the task `acceptEdits` — it is writing. Prefer `update` over `rewrite` in
the final step so a run that finds nothing new changes nothing, and name the
artifact id in the prompt so the task keeps writing to the same one rather than
minting a new artifact every morning. See the `artifact` skill for the tool.

## Modes

`permissionMode` is what the run may do when it fires: `plan`, `ask`,
`acceptEdits` or `full`. Nobody is there to answer a question at 09:00 on a
Monday, so `ask` declines every gated call — choose it only for a task that
reads. A task that writes files wants `acceptEdits`.

## Habits worth having

- Name the task the way the user described it, not the way the cron reads.
- Prefer one agent step. Split into a graph when a real decision sits between
  two pieces of work, not to look thorough.
- Say what you built in one line — the trigger and what it does — and tell them
  it is in the sidebar under Scheduled tasks.
- If the user describes something they do over and over, offer the task. Do not
  build one they did not ask for.
