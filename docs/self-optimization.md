# Self-optimization

How Emma tunes the way she uses her own harness: fewer model requests per
turn, fewer failed tool calls, less spend, same or better completion. Every
change is a proposal, every proposal is a paired trial against a control, and
only a finished bench run can keep one. This page is the program; the
machinery it rides on is in [agents.md](agents.md).

## Model-aware run review

Self improvement reads retained traces across current and archived threads,
including subagents. Model and family rows are filters with provider logos,
failure rates and sample counts. All charts, friction, spending and evidence
follow the selected date window and model scope. Unknown historical models
stay unknown; changing a thread's current model cannot rewrite its history.
Nested agents use their own model and configuration, and their final stored
trace replaces an earlier nested preview when both are available.

Every proposal can target every model, one family, or one exact model. The
scope survives editing, queueing, trials, retries and keeping a change. Runtime
resolution and comparisons use that scope; the bench rejects a mismatched
model. Global defaults apply first, then family changes, then exact model
changes. Scoped prompt additions are rebuilt for each turn rather than saved
inside conversational skill context. Native subagents request their own
resolved prompt, tool hints, preselection and experiment settings from Electron
before their model call, so changing models does not inherit another model's
repair.

Run evidence exposes recorded prompts, skill context, configuration, effective
changes, calls, outcomes and usage. “Ask Emma to analyze these runs” opens a
thread with the selected cohort and asks for evidence-based proposals across
models, tools, skills, prompts and repeated work, including successful runs as
comparisons. It requests a concrete scope, edit and measurement, and does not
authorize applying a proposed change. The page itself is local; analysis uses
the selected model provider.

`read_trace` retains the metadata in its text response and accepts an `offset`
for older pages of up to eight traces. Storage remains bounded to 64 turns per
thread and 1 MiB per trace, and the host bounds each trace reply to 8 MiB.
Tool previews and older records can be truncated or lack model/context fields;
these limits are shown in the evidence view. This is retained execution
evidence, not a promise of unlimited history or byte-for-byte provider requests.

## What already exists

| Piece | Where | State |
| --- | --- | --- |
| One span tree per turn, stored on the thread | [trace.ts](../desktop/shared/trace.ts), `recordTrace` in [agent-loop.ts](../desktop/main/agent-loop.ts) | Header carries `thread`, `model`, `arm`; spans carry tool calls and model requests |
| Provider usage per turn | `TurnUsage` in [harness.ts](../desktop/main/harness.ts) → `GenerationTelemetry` in [thread.rs](../crates/core/src/thread.rs) | Input, output, cache read/write, `cost_micro_usd`, model, duration |
| A/B trial with six levers and eight cost metrics | [improvement.ts](../desktop/shared/improvement.ts), [system-prompt.ts](../desktop/main/system-prompt.ts) | `instructions`, `verifier`, `prompt`, `tools`, `advertise`, `knobs` × `failures`, `blocks`, `steps`, `requests`, `tokens`, `cost`, `ms`, `failed` |
| Paired replay bench, t + sign test, fixed N | [bench.ts](../desktop/shared/bench.ts), [bench-run.ts](../desktop/src/bench-run.ts) | Cases from real threads, arms interleaved per case |
| Friction reader and proposal drafts | `frictionOf`, `spendOf`, `draftProposal` in improvement.ts | Ranks failing tools and where the tokens go, drafts one change |
| Family- and model-scoped prompt presets | [prompts.ts](../desktop/shared/prompts.ts) | `scope: family:glm` or `model:<id>`, seven variables |
| Harness knobs per turn | `HarnessExperiments` in [settings.ts](../desktop/shared/settings.ts) | compact %, reinject, prune tools, command timeout, semantic grep, embedding model |
| Lazy tool discovery | `advertisement_order` in [tools.zig](../harness/src/builtins/tools.zig) | The harness's 24 file, shell and discovery tools are always advertised; of Emma's 28 only `task_list` is, and every other schema costs a `select_tool` model step to load |
| Model-specific prompt hook | `modelPromptOverlay` in [context.zig](../harness/src/builtins/context.zig) | Returns null for every model today; the desktop's family-scoped presets are the live branch |

The baseline this page was written against: 334 threads, 377 traces, 1 427
model requests, and `Model:` written 15 different ways for six real models.

## The ledger

One row per finished turn, all of it derivable at `recordTrace` time and
written into the trace header so `readTurn` and the bench read it for free.

| Field | Source | Why |
| --- | --- | --- |
| `model` | normalized bare id (`z-ai/glm-5.3-flash`), never a key | one spelling per model |
| `family` | `familiesOf(model)[0]` | family-scoped rollups and trials |
| `mode` | turn's permission mode | verifier cost is mode-dependent |
| `requests` | count of `kind: "model"` spans | the real "turns to find something out" |
| `in`, `out`, `cacheRead`, `cost`, `ms` | `TurnUsage` + run duration | spend |
| `discovery` | `search_tools` + `select_tool` + `mcp_*` spans | the discovery tax |
| `compactions` | compaction notices in the turn | when context pressure hit |
| `stop` | ACP stop reason | end_turn vs max_turns vs cancelled |

Per model span, the harness's per-generation usage update sets the open span's
`tokens` (in + out) rather than only the run total, so a trace shows which
request ballooned. No new span field: `tokens` already carries it.

`scripts/ledger.mjs` dumps every trace on this machine as JSONL for offline
analysis; nothing new is stored.

New metrics, all costs, lower is better: `requests`, `tokens` (in + out),
`cost` (micro USD), `ms`. `failed` stays the guard against giving up early.

## The levers

| Lever | Edits | Mechanism |
| --- | --- | --- |
| `instructions` | standing instructions | exists |
| `verifier` | auto verifier rules | exists |
| `prompt` | a family- or model-scoped preset body | trial addition carries `scope`; injected only when `promptApplies` |
| `tools` | one tool's description or a parameter's description | harness config option `tool_hints`, JSON `{name: description}`, applied at advertisement; no rebuild per trial |
| `advertise` | which tools are pre-selected into the base schema | harness config option `preselect`, comma-separated names |
| `knobs` | one `HarnessExperiments` field | value diff, sent through `context_experiments` |

Every lever is a per-turn config or prompt injection, so arm A and arm B of a
pair run on the same harness process and nothing leaks between them. Levers
that need a respawn or a shared file were cut for the reasons in agents.md.

## The experiment queue

Control is arm A on the saved bench cases. Each row names the metric it is
stamped with; `failed` is read beside every one.

| # | Hypothesis | Lever | Metric | Expect |
| --- | --- | --- | --- | --- |
| 1 | Pre-select the most-called Emma tools: `artifact`, `computer`, `workflow`, `threads`, `memory`, `web_search` | `advertise` | `requests` | fewer discovery steps, slightly more prompt tokens, net cost down |
| 2 | `terminal` description leads with the one-object call shape and the per-action required fields | `tools` | `failures` | 15 of 57 terminal failures were shape errors |
| 3 | Trim the Working section for Opus and GPT families | `prompt` | `tokens` | same `failed`, fewer tokens per turn |
| 4 | Add a worked tool-call example block for GLM-flash and Nemotron | `prompt` | `failures` | fewer malformed calls on free and flash models |
| 5 | Compaction trigger 70 → 50 on ≤128k windows | `knobs` | `tokens` | fewer tokens, watch `failed` |
| 6 | Prune tool results after 8 steps | `knobs` | `tokens` | long turns cheaper |
| 7 | Stable prompt prefix: everything per-turn after the cached block | `prompt` | `cost` | higher `cacheRead` share |
| 8 | Default reasoning effort `low` for flash-class families | `knobs` | `ms` | faster, same `failed` |
| 9 | Skip the auto verifier on read-only tools | `verifier` | `requests` | fewer verifier requests in auto mode |

Two findings from the stored traces are bugs, not trials, and are fixed
directly rather than measured:

| Failure | Count | Fix |
| --- | --- | --- |
| `read_tool_result` rejects `start_byte` sent as a quoted number (`"0"`, `"8192"`) | 54 | fixed: a digits-only JSON string decodes as the integer, and `start_byte` 0 reads as 1 |
| `computer` answers *Computer run thread is invalid* | 13 | resolve the run thread the way the other Emma tools do |

Counts are failed spans over the 377 traces on this machine as of
2026-09-03. Permission denials (13 `terminal`, 5 `vision`) are the user's
answer, not friction, and are excluded from every ranking.

Order is by expected payoff over risk. Rows 1 and 2 are the first bench
runs because the ledger already points at them.

## Bench log

| Date | Run | Result |
| --- | --- | --- |
| 2026-09-03 | control, 7 investigation cases, `glm-5.3-flash` on the plan route | 142 requests, 396k tokens, 69 min; `discovery` 0 on every turn, `cost` 0 (the plan route reports none) |
| 2026-09-03 | row 1 `advertise`, 14 turns | stopped at 1 of 14, no verdict: no headroom while `discovery` is 0, and the same case on the same arm ran 18 vs 44 requests, so n=7 cannot separate a lever from noise |

| 2026-09-03 | 12 real tasks (7 SWE, 5 knowledge work, mechanical checks) in `~/emma-bench/tasks`, control vs the three-lever bundle (preselect six Emma tools, `terminal` hint, `family:glm` call-shape prompt), `glm-5.3-flash` on OpenRouter, mode `full`, 80 steps / 15 min per case, 26 min wall | arm B: requests -20%, steps -19%, ms -40%, cost -18%, tokens +6%, check pass 10/12 on both arms; every metric `unproven` at n=12 (requests p=0.23, steps clears t but not the sign test); reverted |

Row 1 needs cases that actually call `select_tool`. Every row needs the
per-run cap raised past 25 min and a step cap per case: one case looped on
`grep_files` for 48 min under the harness's 1000-step limit.

## The loop

```
read the ledger              → rank by cost × frequency, per tool and family
draft one proposal           → the queue in improvements.ts, top row first
run the bench, arm A then B  → fixed N, interleaved per case
verdict                      → keep only on improved; otherwise revert, note, next
```

`spendOf` in improvement.ts is the proposer's other half: it ranks the same
window by tokens — per tool, per family, and a discovery row — and each row
drafts the lever that could move it. The verdict and the record are unchanged
from agents.md.

Automating the loop is a scheduled job that opens the Agents page's next
proposal and runs the bench; that lands once the levers and the ledger have
produced three kept changes by hand.

## Order of work

1. Fix the two argument bugs; bench experiments 1 and 2 against real cases;
   then the rest of the queue.
2. The loop is scheduled.
