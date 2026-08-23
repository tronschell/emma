# Autoresearch

An autoresearch job is a long-running experiment loop against a project folder on
this Mac. It is loosely [karpathy/autoresearch](https://github.com/karpathy/autoresearch)
generalised: the agent proposes one change, Emma measures the metric, the change
is kept if the metric improved and reverted if it did not, and the loop repeats
until a budget runs out or the user pauses it.

The one rule that separates it from a scheduled task: **the metric never
changes**. Everything else about a job — the command, the model, the budgets, the
title — can be edited while it runs. Changing what you are optimising for makes
every earlier iteration meaningless, so it is refused; make a new job instead.

## Anatomy

```
job = project folder + metric + eval command + brief + proposer model + budgets
iteration = one agent turn → run the eval command → read the metric → keep or revert
```

The project folder must be a git repository. Keeping and reverting is
`git commit` and `git reset --hard`, which is the smallest reliable undo for
"the agent changed some files and the result got worse".

### The metric

Two kinds, chosen when the job is created. The creation flow — the form and
Emma's own `autoresearch` tool — must ask which one and show these examples.

| Kind | How the number is read | Example |
|---|---|---|
| `grep` | Emma runs the eval command and greps `^<metricName>:` out of its output | eval `uv run train.py 2>&1`, metric `val_bpb`, the run prints `val_bpb: 0.997900` |
| `judge` | Emma runs the eval command, then a model scores its output against a rubric and returns one number | eval `npm test -- --reporter=json`, rubric "score 0-100: how many suites pass and how readable is the failure output" |

`direction` is `lower` or `higher` and says which way is better. Both are part of
the immutable metric.

### Budgets

Three, each optional (`0` means no limit), each checked before every iteration:

- `maxSeconds` — iteration time summed across every run of the job, not per
  iteration. Time the job spends paused does not count against it: the budget is
  for work done, not for how long the job has existed.
- `maxTokens` — input + output tokens summed over every iteration
- `maxMicroDollars` — estimated spend, `tokens × the model's OpenRouter price`
  from the cached catalog (`promptMicroUsdPerMtok`, `completionMicroUsdPerMtok`,
  micro-dollars per million tokens). A model whose price OpenRouter never
  published prices at zero, so the job still runs — it just cannot be stopped by
  the spend budget.

Hitting any of them **pauses** the job with a note saying which one. Raising the
budget and pressing play resumes it — nothing is lost, because everything is on
disk.

## Layers

| Layer | Owns |
|---|---|
| `crates/core/src/research.rs` | the durable job + its iterations, Markdown round-trip, the immutable-metric rule |
| `crates/core/src/live.rs`, `crates/host/src/main.rs` | CRUD commands, `snapshot.researchJobs` |
| `desktop/main/research.ts` | the loop: drive a turn, run the command, read the metric, keep/revert, record |
| `desktop/main/tools.ts`, `desktop/skills/autoresearch` | the `autoresearch` tool and the skill that teaches Emma to set one up |
| `desktop/src/App.tsx` | the Autoresearch section: graph, logs, costs, attempts, play/pause |

Core stores the job and never runs one, exactly as it does for scheduled jobs:
the shell, the filesystem and git live in the app process.

## Durable shape

`ResearchJob`, one Markdown file per job under the research root, format
`emma-research-format: 1`, written with the same `field`/`quote` helpers
`ScheduledJob` uses.

```rust
pub struct ResearchJob {
    pub id: ResearchJobId,          // "research-<unix>-<pid>-<nanos>-<seq>"
    pub title: String,              // <= 128
    pub project_dir: String,        // absolute, no "..", <= 1024
    pub metric_name: String,        // <= 64, the grep key or the judge's label
    pub metric_kind: String,        // "grep" | "judge"
    pub metric_prompt: String,      // the judge rubric; "" for grep. <= 4096
    pub direction: String,          // "lower" | "higher"
    pub eval_command: String,       // <= 4096, run with project_dir as cwd
    pub proposer_model: String,     // OpenRouter model id, <= 256
    pub permission_mode: String,    // one of core::PERMISSION_MODES
    pub max_seconds: u64,           // 0 = unlimited
    pub max_tokens: u64,
    pub max_micro_dollars: u64,     // $1 = 1_000_000
    pub spent_seconds: u64,
    pub spent_tokens: u64,
    pub spent_micro_dollars: u64,
    pub status: String,             // "running" | "paused" | "finished" | "failed"
    pub status_note: String,        // why it paused or failed, <= 512
    pub thread_id: Option<String>,  // the job's thread; the app creates it
    pub created_at: Timestamp,
    pub iterations: Vec<ResearchIteration>,  // <= MAX_RESEARCH_ITERATIONS (1000)
}

pub struct ResearchIteration {
    pub index: u32,
    pub at: Timestamp,
    pub value: Option<f64>,   // None = the run crashed
    pub best: Option<f64>,    // best-so-far *after* this iteration; the graph line
    pub outcome: String,      // "keep" | "discard" | "crash"
    pub note: String,         // the annotation shown on the graph, <= 280
    pub commit: String,       // short hash, <= 64
    pub duration_ms: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub micro_dollars: u64,
}
```

`value`/`best` reject NaN and infinity on the way in. Core computes `index`,
`best` and the three `spent_` totals when an iteration is recorded — the app
sends what happened, never the running totals.

## Host methods

All reached through the existing `emma:request` path, so each one is added to
`methods`/`fields` in `desktop/main/ipc.ts` and routed in `crates/host/src/main.rs`.

| Method | Params | Returns |
|---|---|---|
| `saveResearchJob` | `title`, `projectDir`, `metricName`, `metricKind`, `direction`, `evalCommand`, `proposerModel`, `permissionMode`, `maxSeconds`, `maxTokens`, `maxMicroDollars`; optional `jobId` (absent creates), `metricPrompt`, `prompt` | the job |
| `deleteResearchJob` | `jobId` | `{}` |
| `setResearchJobStatus` | `jobId`, `status`; optional `note` | the job |
| `setResearchJobThread` | `jobId`, `threadId` | the job |
| `recordResearchIteration` | `jobId`, `outcome`, `durationMilliseconds`, `inputTokens`, `outputTokens`, `microDollars`; optional `value`, `note`, `commit` | the job |
| `snapshot` | — | gains `researchJobs: ResearchJob[]` |

Numbers travel as strings, as every other host param does. Saving over an
existing job with a different `metricName`, `metricKind`, `direction` or
`projectDir` fails with *"an autoresearch metric cannot be changed — create a new
job for a different metric"*. `validateRequest` rejects blank values, so an
optional param is **omitted**, never sent empty.

## The loop

`desktop/main/research.ts`, one runner per job, driven by `driveTurn` so an
iteration is an ordinary Emma turn with the job's folder attached and the job's
permission mode.

```
while (job.status === "running") {
  if (a budget is exhausted)        → setResearchJobStatus paused, note which, stop
  before = git rev-parse HEAD
  resolveMentions(iteration prompt) → "/skill" attached; "@artifact", "@page"
                                      and "@file" read in
  driveTurn(one iteration prompt)   → the agent edits the project
  git add -A && git commit          → or note "no change" and carry on
  output = run evalCommand in projectDir
  value  = grep ^metricName: output   | judge(output)
  keep   = value beats best in `direction`
  if (!keep) git reset --hard before
  recordResearchIteration(...)
}
```

The iteration prompt carries: the iteration number, the metric and its direction,
the best value so far, the last few iterations with their outcomes and notes, the
job's **brief** — the user's own free text, editable while the job runs — and the
instruction to make **one** change and stop without running the eval command
itself — Emma runs it, so the number cannot be reported by the thing being
measured.

A crash (non-zero exit, or no metric in the output) is an iteration with
`outcome: "crash"` and no value; the working tree is reverted and the loop
continues, exactly as karpathy's does.

**Recovery.** Nothing about a run lives only in memory. On launch, main lists the
snapshot's jobs and restarts a runner for every job still marked `running`; a job
that was killed mid-iteration simply loses that iteration's uncommitted work,
which `git reset --hard` would have discarded anyway.

## Compaction

Unrelated to autoresearch, required by it: **every** turn, on every surface,
compacts its conversation when it passes **70%** of the selected model's context
window. Emma has no compaction today — the sidecar drops the oldest messages once
it passes `max_imported_messages`, which silently loses the start of long runs,
and an autoresearch job is nothing but a long run.

The conversation accumulates in the Zig sidecar (`agent/src/main.zig`), so that
is where the rule lives: when the thread's estimated tokens exceed 70% of the
provider's context length, the oldest half is replaced with one system message
summarising it. If the summary call fails, fall back to today's drop-oldest so a
turn never dies of compaction.

The host knows each model's context length and sends it with the provider
config; `0` means unknown, which keeps the old behaviour.

One surface is **not** covered: the forked coding harness under `harness/`, off
unless `EMMA_HARNESS=1`, compacts on a turn count with a summary it builds
locally and knows nothing about context windows. Bringing it under the same rule
needs the model's window plumbed into its session runtime and a token estimate
over its history union; `compactHistory` carries a `ponytail:` comment naming
both.
