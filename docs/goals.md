# Goals

One objective a thread keeps working at on its own. Set a goal and Emma drives
turn after turn without being asked again, stopping only when the objective is
met with evidence, the same blocker has stood three turns running, or the
allowance runs out. The thread grows a **Goal** tab; every goal tool call leaves
a pressable card in the transcript.

| | |
| --- | --- |
| The durable record | [crates/core/src/thread.rs](../crates/core/src/thread.rs) |
| The host commands | [crates/core/src/live.rs](../crates/core/src/live.rs), [crates/host/src/main.rs](../crates/host/src/main.rs) |
| The shared contract | [shared/goal.ts](../desktop/shared/goal.ts) |
| The tool and the loop | [main/tools.ts](../desktop/main/tools.ts), [main/main.ts](../desktop/main/main.ts) |
| What the model is told | [main/system-prompt.ts](../desktop/main/system-prompt.ts) |
| The card and the view | [src/goal.tsx](../desktop/src/goal.tsx), [styles/goal.css](../desktop/src/styles/goal.css) |

## The record

A goal lives on the thread, in the same Markdown file, so it survives a quit and
travels with the thread rather than sitting in a side table. Front matter carries
`goal-objective`, `goal-status`, `goal-evidence`, `goal-blocked-reason`,
`goal-blocked-streak`, `goal-blocked-at-turn`, `goal-token-budget`,
`goal-tokens-used`, `goal-time-used-seconds`, `goal-turns`, `goal-created-at` and
`goal-updated-at`, written only when the thread has a goal.
`emma-thread-format` is **13**. The format number gates nothing on read: a file
without the goal keys loads with no goal, and one carrying them loads the goal
whatever number it claims.

Ceilings: objective 2,000 characters, evidence 4,000, blocker reason 1,000,
default allowance 200,000 tokens and 40 turns.

## Status

| | |
| --- | --- |
| `active` — *Pursuing* | Emma re-drives the thread each time a turn ends. Resume restarts one left stranded by a quit. |
| `paused` — *Paused* | The record stands; nothing drives. Resume puts Emma back to work. |
| `complete` — *Achieved* | Evidence is on the record. Settled. |
| `blocked` — *Blocked* | The same blocker stopped three consecutive goal turns. Settled. |
| `budgetLimited` — *Budget reached* | The token allowance or the 40-turn ceiling was reached. Continue grants more. |
| `usageLimited` — *Usage limited* | The provider refused for rate limit, quota or billing. Resume when it clears. |

The invariants live in Rust, not in prompt text, so no caller can skip them:

- **Evidence gates completion.** `complete` with an empty `evidence` is rejected
  — "what was run, what it printed, what changed".
- **Blocked takes three turns.** A blocker is recorded at most once per turn.
  A different blocker restarts the count; the status only turns `blocked` at
  three, and stays `active` until then. Resuming a goal clears the count, so a
  goal picked back up starts a fresh audit.
- **The allowance is accounted for you.** `record_turn` folds every turn's
  tokens and duration into the goal — including the turn that settles it, and a
  turn stopped part-way, which is billed spend either way. Only a paused goal
  stops counting. The status flips to `budgetLimited` when the tokens are spent
  or the 40th turn lands. A grant resets the turn count along with the tokens, so
  Continue always hands back a working allowance.
- **A second `set` cannot buy an allowance.** Setting a goal over one that is
  still running carries the spend across: same tokens used, same turn count, same
  creation time, new objective and budget. Otherwise a model out of budget could
  re-`set` its way past the ceiling instead of asking. A settled goal is replaced
  outright — that thread's next goal starts clean.
- **Settled means settled.** A `complete` goal cannot be reopened by an update,
  and the reason on any stop — including the provider's own refusal text on
  `usageLimited` — is kept on the record rather than dropped.

What is *not* held in Rust: subagent spend. `record_turn` folds a turn into the
goal on the thread it was recorded against, and a subagent runs on its own
thread, which has no goal. Work fanned out under a goal is therefore invisible to
its budget, and the turn ceiling is what bounds it.

## The continuation loop

`driveTurn` in [main.ts](../desktop/main/main.ts) is the single chokepoint every
turn funnels through, and the loop hangs off it: when a turn ends on a thread
whose goal is still `active`, `continueGoal` starts another with
`"Continue working toward this thread's goal."` and keeps going while
`goalDrivesAgain` holds — not a subagent, not halted, `active`, under 40 turns,
tokens left. Stop halts it; so does anything that leaves the goal settled. A
thread the user archived is never driven at on its own: archiving is the user
saying they are done with it, so the goal stays on record but Emma stops
continuing it.

The allowance is also enforced **inside** a turn. The harness runs its agent
steps unbounded, so one turn could otherwise spend without limit while the ledger
still read zero. Emma accumulates what each mid-turn usage report adds — the
step's prompt plus the output it grew by — and stops the turn where it stands once
that running total passes what the goal has left.

Stopping is not enough on its own. The ledger is coarser than the guard: a turn is
recorded with the harness's own figures, whose input side is the *last* step's
prompt rather than the sum of every step's, so a long many-step turn is written
down for less than it cost — and a goal stopped for overspending would settle back
as `active` with budget apparently left, halted by a stop the card never mentions,
reading *Pursuing* forever. So the guard writes the status itself: it stops the
thread and records `budgetLimited` with a reason saying the allowance ran out
part-way through a turn. The 40-turn ceiling is the backstop that a token budget
alone does not give.

Pause, Resume, Continue and Clear reach the record over two bridge methods —
`updateGoal` and `clearGoal`; `setGoal` is how a goal is first put on a thread.
Resume and Continue do not merely rewrite the record: they clear the halt from the
last stopped run and drive a turn, so a goal put back to `active` is one Emma is
actually working on again. That is also the way back for a goal left `active` by a
quit, which no longer has a turn driving it.

## The tool

The model reaches its goal through one tool with five actions — `set`, `get`,
`update`, `extend`, `clear`. A subagent's call acts on its parent's goal: a
subagent lives inside a turn and cannot hold a goal of its own, which is why the
goal block tells the model to write the objective into every brief it hands out.
Emma's own sub-threads are given it automatically (`towardGoal`); a harness-native
subagent gets it only from the brief.

While a goal is active — and only then — every turn carries a `GOAL:` block: the
objective, the status, the turn and token ledger, the evidence and blocker on
record, and the rules above in the model's own terms. A paused or settled goal
steers nothing, and its objective is not pushed into the briefs of subagents that
turn spawns.

## In the interface

A goal tool call marks a line of its output with `[goal:<threadId>]`, and the
transcript draws a card from it: status pill, objective, spend bar, tokens spent
and left, elapsed time, turns. Press it and the thread's **Goal** tab opens: the
ledger, the controls, the blocker with its count, the evidence when there is
some, the plan with its revisions, and every subagent working under the goal.

The card reads live state, so a card left by an earlier turn shows what the goal
says now rather than what it said then.

## Known edges

- Two assistant messages that land in the same second share one transcript block
  cache key, so their tool cards can duplicate. Real turns take longer than a
  second; a fixture that answers instantly makes it certain.
- A goal only drives the thread it is set on. Sub-threads inherit the objective
  as text, never the record, and their spend never reaches the parent's ledger.
- A turn's recorded input tokens are the last agent step's prompt, not the sum
  over every step, so a long turn is under-billed against the allowance. The
  mid-turn guard accumulates properly; the record does not.
- A goal that stays `complete` while the user keeps talking on the thread keeps
  counting those turns against it. The cost it reports is the thread's, not
  strictly the objective's.
- A provider rate limit reaches `usageLimited` only after the harness has
  finished its own retries, which can take minutes.
