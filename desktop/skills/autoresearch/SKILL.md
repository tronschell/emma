---
name: autoresearch
description: How to set up, start, pause and edit the user's autoresearch jobs with the `autoresearch` tool — the two metric kinds (grep and judge), the eval command, the proposer model and the three budgets, and how to help someone define a metric when they do not have one. Use whenever the user wants something optimised over and over — a number driven up or down, a model or a benchmark tuned, an experiment loop that keeps trying — or asks to see, start, pause or change what is already running.
---

# Autoresearch

An autoresearch job is an experiment that runs itself. One iteration is: the
agent makes **one** change to a project, Emma commits it, runs the eval command,
reads the metric, and keeps the change only if the number improved — otherwise
`git reset --hard`. Then it does it again, until a budget runs out or the user
presses pause.

The user sees jobs under Autoresearch in the sidebar: the graph, the cost, and
the job's own thread, where every iteration is a turn.

This skill ships with the app and is rewritten from `desktop/skills/` on every
launch. Do not edit it with `write_skill`; write what you learn as a separate
skill and it survives.

## The one rule

**The metric cannot be changed.** `metricName`, `metricKind`, `direction` and
`projectDir` are fixed when the job is created. Changing what is being optimised
makes every earlier iteration meaningless, so a later save is refused — make a
new job instead. Everything else — the title, the eval command, the model, the
budgets — can be edited while it runs.

Say this out loud before you save. A user who picks the wrong metric kind finds
out an hour later.

## Ask which kind of metric

There are two, and the answer is the user's, not yours.

**`grep`** — the eval command already prints the number.

```
projectDir   ~/code/nanochat
evalCommand  uv run train.py 2>&1
metricName   val_bpb        the run prints "val_bpb: 0.997900"
direction    lower
```

Emma greps the last `^val_bpb:` line out of the output and takes the number.
Nothing else has to exist. This is the kind to prefer.

**`judge`** — there is no single number, so a model reads the output and scores it.

```
projectDir   ~/code/api
evalCommand  npm test -- --reporter=json
metricName   suite_health
metricPrompt score 0-100: how many suites pass, and how clearly the failures
             say what broke. Answer with the number alone.
direction    higher
```

The rubric has to end in one number, every time, for the same output. "How good
is this code" is not a rubric; "0-100, ten points per passing suite, minus twenty
if the output is unreadable" is.

## Help them define one

Most people do not have a metric, they have a complaint. Turn it into a number
with three questions:

1. **What command do you already run to see whether it worked?** That is the
   eval command. If they do not have one, there is no job yet — help them get a
   command they trust first.
2. **What in that output tells you it got better?** A number in it is a `grep`
   metric; "I read it and I can tell" is a `judge` metric.
3. **Which way is better?** `lower` for a loss, an error rate, a runtime;
   `higher` for accuracy, a score, a pass count.

A good metric is **one number, from a command they already trust, that moves
when the thing they care about moves**. If the number can go up while the
project gets worse, the loop will find that out for them, expensively. Say so
and fix the metric before starting.

If the eval prints nothing usable, the smallest fix is usually one `print` in
their own script: `print(f"val_bpb: {value:.6f}")`. Offer to add it.

## The rest of a job

- **projectDir** — a git repository with at least one commit. Keeping and
  reverting is git, so a job refuses to start without one, and says so.
- **proposerModel** — the OpenRouter model id the iterations run on. It is the
  one paying for the budgets, so name it explicitly rather than assuming.
- **permissionMode** — nobody is watching an iteration, so `ask` declines every
  gated call and the job gets nowhere. A job that edits files and runs commands
  wants `full`; `acceptEdits` if you want its shell commands to stall.
- **Budgets** — `maxSeconds` (wall clock over the whole job), `maxTokens`, and
  `maxMicroDollars` (`$1` = `1000000`). `0` means no limit. Hitting one pauses
  the job with a note saying which; raising it and pressing play carries on.
  Always propose all three for a first job. An unbounded loop on a paid model is
  a bill.

The agent is told to make one change and **not** to run the eval command itself —
Emma runs it, so the number can never be reported by the thing being measured.

## Working on jobs

| Ask | Call |
|---|---|
| what is running | `autoresearch` with no arguments |
| one job in full | `{"action": "get", "jobId": "research-…"}` |
| create | `{"action": "save", …}` — everything but `jobId` |
| edit | `{"action": "save", "jobId": "research-…", …}` — keeps what you do not send |
| start it | `{"action": "start", "jobId": "research-…"}` |
| pause it | `{"action": "pause", "jobId": "research-…"}` |
| remove it | `{"action": "delete", "jobId": "research-…"}` |

```
autoresearch {"action": "save", "title": "nanochat val_bpb",
              "projectDir": "/Users/me/code/nanochat",
              "metricName": "val_bpb", "metricKind": "grep", "direction": "lower",
              "evalCommand": "uv run train.py 2>&1",
              "proposerModel": "anthropic/claude-sonnet-4.5",
              "permissionMode": "full",
              "maxSeconds": 21600, "maxTokens": 2000000, "maxMicroDollars": 20000000}
```

Saving never starts anything. Show the user what you saved, then ask before
starting it.

## Habits worth having

- Ask which metric kind, and show both examples. Do not pick for them.
- Confirm the eval command works before the job does: run it once yourself and
  check the metric line is really there.
- Every iteration leaves a row in `results.tsv` in the project folder — commit,
  value, outcome, description. Point at it when they want the raw numbers.
- Report progress in the metric's own words: "eleven iterations, val_bpb from
  1.0045 to 0.9979, four kept".
- If they describe an experiment they keep running by hand, offer the job. Do
  not start one they did not ask for.
