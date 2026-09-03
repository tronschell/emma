# Self-optimization

How Emma tunes the way she uses her own harness: fewer model requests per
turn, fewer failed tool calls, less spend, same or better completion. Every
change is a proposal, every proposal is a paired trial against a control, and
only a finished bench run can keep one. This page is the program; the
machinery it rides on is in [agents.md](agents.md).

## What already exists

| Piece | Where | State |
| --- | --- | --- |
| One span tree per turn, stored on the thread | [trace.ts](../desktop/shared/trace.ts), `recordTrace` in [agent-loop.ts](../desktop/main/agent-loop.ts) | Header carries `thread`, `model`, `arm`; spans carry tool calls and model requests |
| Provider usage per turn | `TurnUsage` in [harness.ts](../desktop/main/harness.ts) → `GenerationTelemetry` in [thread.rs](../crates/core/src/thread.rs) | Input, output, cache read/write, `cost_micro_usd`, model, duration |
| A/B trial with two levers and four cost metrics | [improvement.ts](../desktop/shared/improvement.ts), [system-prompt.ts](../desktop/main/system-prompt.ts) | `instructions`, `verifier` × `failures`, `blocks`, `steps`, `failed` |
| Paired replay bench, t + sign test, fixed N | [bench.ts](../desktop/shared/bench.ts), [bench-run.ts](../desktop/src/bench-run.ts) | Cases from real threads, arms interleaved per case |
| Friction reader and proposal drafts | `frictionOf`, `draftProposal` in improvement.ts | Ranks failing tools, drafts one lesson |
| Family- and model-scoped prompt presets | [prompts.ts](../desktop/shared/prompts.ts) | `scope: family:glm` or `model:<id>`, seven variables |
| Harness knobs per turn | `HarnessExperiments` in [settings.ts](../desktop/shared/settings.ts) | compact %, reinject, prune tools, command timeout, semantic grep |
| Lazy tool discovery | `advertisement_order` in [tools.zig](../harness/src/builtins/tools.zig) | The harness's 24 file, shell and discovery tools are always advertised; of Emma's 27 only `task_list` is, and every other schema costs a `select_tool` model step to load |
| Model-specific prompt hook | `modelPromptOverlay` in [context.zig](../harness/src/builtins/context.zig) | Returns null for every model today; the desktop's family-scoped presets are the live branch |

What is missing is the join. The trial can only edit two prose blocks, the
bench only reads counts, the ledger is split across the trace header and the
generation record with five spellings of one model id, and nothing ranks
*spend*. On this machine today: 334 threads, 377 traces, 1 427 model requests,
and `Model:` written 15 different ways for six real models.

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

Per model span, the harness's per-generation usage update lands on the open
span (`in`, `out`, `cacheRead` per request) rather than only on the run total,
so a trace shows which request ballooned.

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
| 1 | Pre-select the eight most-called Emma tools from the ledger | `advertise` | `requests` | fewer discovery steps, slightly more prompt tokens, net cost down |
| 2 | Trim the Working section for Opus and GPT families | `prompt` | `tokens` | same `failed`, fewer tokens per turn |
| 3 | Add a worked tool-call example block for GLM-flash and Nemotron | `prompt` | `failures` | fewer malformed calls on free and flash models |
| 4 | Rewrite `computer` description around its top failure texts | `tools` | `failures` | `computer` is the top failing tool on this machine |
| 5 | Rewrite `terminal` description: one call, no retry on the same failure | `tools` | `failures` | second most failing |
| 6 | Compaction trigger 70 → 50 on ≤128k windows | `knobs` | `tokens` | fewer tokens, watch `failed` |
| 7 | Prune tool results after 8 steps | `knobs` | `tokens` | long turns cheaper |
| 8 | Stable prompt prefix: everything per-turn after the cached block | `prompt` | `cost` | higher `cacheRead` share |
| 9 | Default reasoning effort `low` for flash-class families | `knobs` | `ms` | faster, same `failed` |
| 10 | Skip the auto verifier on read-only tools | `verifier` | `requests` | fewer verifier requests in auto mode |

Order is by expected payoff over risk. Rows 1, 4 and 5 are the first bench
runs because the ledger already points at them.

## The loop

```
read the ledger              → rank by cost × frequency, per tool and family
draft one proposal           → the queue in improvements.ts, top row first
run the bench, arm A then B  → fixed N, interleaved per case
verdict                      → keep only on improved; otherwise revert, note, next
```

The proposer is the same friction reader with spend added: a tool that costs
the most tokens per call, a family whose `requests` per turn is highest, a
step that repeats. The verdict and the record are unchanged from agents.md.
Automating the loop is a scheduled job that opens the Agents page's next
proposal and runs the bench; that lands once the levers and the ledger have
produced three kept changes by hand.

## Order of work

1. Ledger fidelity: header fields, normalized model, per-request usage, the
   four new metrics, the dump script.
2. Harness options `tool_hints` and `preselect`, plumbed through `TurnExtras`.
3. Levers `prompt`, `tools`, `advertise`, `knobs` in the trial and the bench.
4. Bench experiments 1, 4, 5 against real cases; then the rest of the queue.
5. The proposer reads spend; the loop is scheduled.
