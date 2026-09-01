# Autoresearch

A long-running experiment loop against a git project on this computer. The agent
proposes one change, Emma measures the metric, the change is kept if the number
improved and reverted if it did not, and the loop repeats until a budget runs out
or you pause it.

The idea is [karpathy/autoresearch](https://github.com/karpathy/autoresearch)
generalised — `results.tsv`, the keep/revert rule and the crash handling are its
conventions.

**The metric never changes.** `metricName`, `metricKind`, `direction` and
`projectDir` are fixed the moment a job is saved (the judge rubric is kept too);
everything else — title, eval command, brief, model, mode, budgets — can be
edited while it runs. Re-saving with a different metric is refused: *"an
autoresearch metric cannot be changed — create a new job for a different
metric"*.

```
job       = git project + metric + eval command + brief + proposer model + budgets
iteration = one agent turn → git commit → run the eval → read the metric → keep or revert
```

Keeping and reverting is `git commit` and `git reset --hard`, so the project must
be a git repository with at least one commit. If it is not, the job pauses with
the `git init` / first-commit instruction instead of starting.

## The metric

| Kind | How the number is read | Example |
| --- | --- | --- |
| `grep` | Emma runs the eval command and takes the **last** `^<metricName>:` line out of its output, up to the number and no further | eval `uv run train.py 2>&1`, metric `val_bpb`, the run prints `val_bpb: 0.997900` |
| `judge` | Emma runs the eval command, then a model scores the output (first 32 KB) against the job's rubric on a thread of its own; the first number in the answer wins | eval `npm test`, rubric "score 0-100: how many suites pass and how readable is the failure output" |

`direction` is `lower` or `higher`. A `grep` job takes no rubric and a `judge`
job requires one. The judge runs on `job.proposerModel` — the same model that
proposes — in `mode: "ask"`.

## Budgets

Three, all in [research.rs](../crates/core/src/research.rs), each checked before
every iteration, each `0` for no limit. The form defaults to 6 hours, 2,000,000
tokens and $5.

| Field | Counts | Note |
| --- | --- | --- |
| `maxSeconds` | Iteration time summed over every run of the job | Paused time does not count — the budget is for work done |
| `maxTokens` | Input + output tokens summed over every iteration | |
| `maxMicroDollars` | Estimated spend, `$1 = 1_000_000` | `tokens × the model's OpenRouter price` from the cached catalog (`promptMicroUsdPerMtok`, `completionMicroUsdPerMtok`). An unpublished price reads as 0, so the job runs but cannot be stopped by spend |

Each has a matching `spentSeconds` / `spentTokens` / `spentMicroDollars`, which
core adds up — the app reports what happened, never the running totals. Hitting a
budget **pauses** the job with a note naming which one; raise it, press start,
and it carries on from disk.

Other ceilings: `MAX_RESEARCH_ITERATIONS` 1000, `MAX_EVAL_MS` 15 minutes per eval
run, iteration note 280 characters, brief 8192, eval command and rubric 4096,
project folder 1024 (absolute, no `..`), metric name 64, title 128, model id 256,
status note 512. Statuses are `running`, `paused`, `finished`, `failed`. A new
job is created `paused`: saving does not start it, you press start.

Permission mode: core accepts `ask`, `acceptEdits`, `full` — the same three a
scheduled job may be saved with, and `plan` loads as `ask`. Nobody watches a
running experiment, so `ask` cannot get through an iteration: every edit and
command waits `MAX_ASK_MS` for an answer and then counts as a refusal, and the
prompt is only ever drawn on the thread view, never in Autoresearch. A job in
`ask` therefore refuses to start — `unattendedRefusal` pauses it with a note
saying so, the same way an unclean repository or a spent budget does. The form
offers `acceptEdits` to a new job: the weakest mode in which the agent's one
change can land, with commands and app access still asking. Nothing widens a
mode a job was saved with.

## The loop

[research.ts](../desktop/main/research.ts), one runner per job. An iteration is
an ordinary Emma turn with the project folder granted and attached, so the file
and shell tools point at it.

```
before starting: git add -A && git commit  (carry over anything left in the tree)
while (status === "running") {
  budget spent?                    → pause with a note saying which, stop
  before = git rev-parse HEAD
  resolve /skill and @file tokens in the iteration prompt
  drive one turn                   → the agent makes exactly ONE change
  git add -A && git commit
  run evalCommand in projectDir    → grep the metric, or ask the judge
  keep = value beats best in `direction`
  if (!keep) git reset --hard before
  append a row to results.tsv, then recordResearchIteration
}
```

The iteration prompt carries the iteration number, the metric and direction, the
best value so far, the last 6 iterations with outcomes and notes, and the user's
**brief** last. It forbids running the eval command itself — Emma runs it, so the
number cannot be reported by the thing being measured — and forbids committing.

A run that exits without producing a number is `outcome: "crash"`: no value, tree
reverted, loop continues. A turn that edited nothing is recorded as *"No
change"*, and no eval is run for it. `results.tsv`
(`commit  value  outcome  description`) is read before the revert and written
after it, so a reset cannot take the earlier rows with it.

The job re-reads itself from the store every iteration, which is how an edit made
while it runs takes effect. On launch, `resumeResearchJobs` restarts a runner for
every job still marked `running`; a job killed mid-iteration loses only that
iteration's uncommitted work, which a revert would have discarded anyway.

Pausing stops the turn in flight, not just the loop between iterations.

## Where it lives

| Layer | Owns |
| --- | --- |
| [research.rs](../crates/core/src/research.rs) | the durable job and its iterations, Markdown round-trip (`emma-research-format: 2`), the immutable-metric rule, the index/best/spent arithmetic |
| [live.rs](../crates/core/src/live.rs), [host/main.rs](../crates/host/src/main.rs) | `saveResearchJob`, `deleteResearchJob`, `setResearchJobStatus`, `setResearchJobThread`, `recordResearchIteration`, and `researchJobs` on the snapshot |
| [research.ts](../desktop/main/research.ts) | the loop: turn, git, eval, metric, keep/revert, record |
| [research.tsx](../desktop/src/research.tsx) | the Autoresearch section: graph, iterations, cost, play/pause, delete |
| [tools.ts](../desktop/main/tools.ts) | the `autoresearch` tool, gated `ask` in every mode but `full` |

Core stores a job and never runs one. One file per job under `research/` in
Emma's data dir; numbers travel to the host as strings, and an optional param is
omitted rather than sent empty.

## Compaction

A job is nothing but a long run, so what happens when its conversation outgrows
the window decides whether the run is any good. The history lives in the harness
(Emma's fork of [vercel-labs/fx](https://github.com/vercel-labs/fx)):
`compactHistory` in
[session.zig](../harness/src/core/session/session.zig) folds everything but the
most recent turns into one summary when the history passes `max_history_turns`,
or when its estimated tokens pass `compact_token_trigger_percent` — **70** — of
the context window. A window of `0` means the caller never said, and only the
turn-count rule applies; Emma is what stops it being zero, sending the real
number from the cached catalog as the `context_window` config option.

## See also

- [jobs.md](jobs.md) — scheduled tasks, the other automation section
- [models.md](models.md) — the proposer model, prices and the token accounting
- [permissions.md](permissions.md) — the mode an iteration runs under
- [harness.md](harness.md) — the loop that runs a turn
