# Agents

Emma's page about Emma. It reads the span traces her own finished turns left
behind, names the friction that keeps repeating, drafts one change about it, and
then — this is the part that matters — tries to prove the change helped before
keeping it. The proof is a **replay bench**: your own saved cases, replayed
under both arms back to back, at a case count declared before the run starts.

| | |
| --- | --- |
| Friction, trials, and the record | [shared/improvement.ts](../desktop/shared/improvement.ts) |
| The bench arithmetic | [shared/bench.ts](../desktop/shared/bench.ts) |
| The store and the driver | [src/bench.ts](../desktop/src/bench.ts), [src/bench-run.ts](../desktop/src/bench-run.ts) |
| The arm pin and the bench mark | [main/system-prompt.ts](../desktop/main/system-prompt.ts) |
| What a replay may reach | [main/agent-loop.ts](../desktop/main/agent-loop.ts) |
| The page | [src/AgentView.tsx](../desktop/src/AgentView.tsx), [src/BenchPanel.tsx](../desktop/src/BenchPanel.tsx) |
| Where a turn's numbers come from | [shared/trace.ts](../desktop/shared/trace.ts) |

## The levers

A proposed change is written into one of six levers, and nothing else. The
addition is at most 1024 characters, and each lever reads it its own way — an
addition that will not parse is dropped rather than stored:

| Lever | What it edits | The addition is |
| --- | --- | --- |
| `instructions` | The standing instructions every turn carries | The line itself |
| `verifier` | The rules the auto verifier reviews a call against | The line itself |
| `prompt` | The system prompt, under an optional scope | The prompt body; `scope` is a preset scope — `family:glm`, `model:<id>`, or empty for every model |
| `tools` | What a tool's description says this turn | JSON: `{"<tool>": "<description>"}` |
| `advertise` | Which tools are offered without a search | A comma-separated tool list |
| `knobs` | One harness experiment field | `<field>=<integer>`, held to the ceilings in `validateHarnessExperiments` |

A `tools` or `advertise` trial reaches the turn it rides and no further: the
harness sends the overrides per turn and does not pass them to subagents, so a
child turn runs with the shipped descriptions on either arm.

Four other levers were considered and cut, each for a mechanical reason rather
than a stylistic one:

- **Skill files.** The harness loads its skill catalog once per process at ACP
  startup, so a `SKILL.md` written mid-run is inert. Making it honest costs a
  harness respawn per case-arm, and the treatment is still conditional on the
  model choosing to call the `skill` tool. Put the text in `instructions`
  instead: same experiment, no restarts.
- **Memory files.** `<userData>/memories` is one global tree with no arm
  segment, and the agent rewrites it mid-run, so arm A reads what arm B wrote.
  Nothing injects it into a prompt either.
- **Subagent briefs.** There is no injection point; a parent's skill context
  never reaches a child.
- **The advisor.** A copy of the verifier lever, but `advise` gets no thread id
  and fires rarely.

## What a turn is worth

One stored trace is one finished turn. Eight numbers come off it, and **all eight
are costs — lower is better**, so no surface anywhere inverts a sign.

| Metric | Counted from the trace |
| --- | --- |
| `failures` | Tool calls that came back failed |
| `blocks` | Calls the auto verifier would not clear |
| `steps` | Tool calls made |
| `requests` | Requests to the model, from the trace header |
| `tokens` | The turn's `in` + `out`, from the trace header |
| `cost` | Micro USD the provider charged, from the trace header |
| `ms` | Wall clock the run took, from the trace header |
| `failed` | `1` when the run itself ended failed, `0` otherwise |

The header numbers are zero on a turn recorded before they existed. The cost
proxies are each also what *giving up early* looks like: a turn that quits after
two calls scores beautifully. `failed` is the last number for exactly that reason — it is the one that goes up when
Emma buys a low step count by not finishing. Read it alongside whichever of the
three a trial is being judged on.

### Where the tokens go

Beside the friction list the Agents page ranks the same window by tokens, six
rows deep, from `spendOf` in improvement.ts. Each row proposes the lever that
could move its number:

| Row | The number | Proposes |
| --- | --- | --- |
| A tool | Tokens its calls put in the window, with the call and turn counts | Nothing — a tool's cost is not by itself a change to make |
| A model family | Tokens an average turn on it costs, beside mean `requests` and `cost` | A `prompt` trial scoped `family:<id>`, judged on `tokens` |
| Discovery | Tokens spent in `search_tools` and `select_tool`, with mean steps a turn and the tools picked most | An `advertise` trial offering those tools up front, judged on `requests` |

A tool whose failures are mostly argument-shape errors proposes a `tools` trial
instead of a lesson, drafted as `{"<tool>": ""}` — the description is yours to
write, and the trial will not start until it is.

## The replay bench

A **case** is a prompt harvested from one of your own past threads, kept with the
folder it ran in. Save one from the picker on this page, or from the thread
itself: right-click it in the sidebar and choose **Save as bench case**. Either
way the case is the thread's first user message, replayed in that thread's
folder, and either way it is refused with a reason when the thread has no first
message, no folder, when that thread is already a case, or when the bench is
already full. The two doors carry the same four refusals, because either one on
its own is enough to turn one thread into six cases and a run into six pairs
that are one draw.

A **run** replays every case under one arm — the baseline — or under both — a
trial. Arms are interleaved *per case*, not all-A-then-all-B, so the two halves
of a pair sit next to each other in time and whatever drifted between them
(model routing, time of day, a background build) cancels.

Each case-arm gets a throwaway thread, archived before it is ever sent anything,
bound to the case's folder, run under a pinned arm, scored off its own trace,
and stopped when the driver leaves it. The pin is consumed by the turn it was set
for and expires two minutes after it is written, so a stale pin can never colour
later work.

### The boundary

A replayed case can reach past its own thread. It can start threads with
`threads spawn`; it can ask `workflow` to run one of your scheduled jobs, or
`autoresearch` to resume one, or `plan run` to fan work out, or `cli send` to
push a prompt into a conversation you have open — and each of those is a turn
starting somewhere. **None of them can start one in a thread of yours.**

The rule is enforced once, where turns begin, rather than tool by tool. Two
registers do it. The first is *ownership*: the case thread is claimed when the
driver pins its arm, and every thread created with it as a parent is claimed at
the moment the host creates it, at any depth — so a grandchild born three hops
down is owned before its first turn exists, without a snapshot walk and without a
race. The second is *replay*: every tool call made by a bench turn runs inside a
marked scope, and that mark follows the call wherever it goes, through the tool
router and into whatever it calls next. `driveTurn` — the one door every turn in
the app comes through — refuses to start a turn when it is inside a marked scope
and the target thread is not owned, and says what to do instead: spawn a thread
of your own and send the work there. Adding a tool that starts a turn cannot open
a hole, because the check is not in the tools.

Two things are not turns and so are checked where they happen: `agents stop`
refuses to cancel a thread the sender did not start, and `threads message` into a
thread with a turn already running cannot reach it either, because there is no
path from a tool call into a turn already in flight.

**Stopping is durable, not a message.** Stopping a case thread halts it and
everything owned under it, and a halted thread refuses to start a turn from then
on. That matters because the old stop was a cancel aimed at a live harness
session: a thread spawned a second ago has no session yet, so the cancel found
nothing, and the turn it was meant to prevent started afterwards. Now the halt is
recorded first and the turn is refused when it tries to begin, whether that is
now or after the session finally opens. A thread created under a parent that is
already halted is stopped and archived on arrival.

So cleanup is no longer a walk that has to keep up. When a case-arm ends the
driver stops its one case thread, and the halt walks the owned tree from there —
stopping, archiving, and refusing every later turn. Every case-thread id is
recorded before its turn is sent, so the same stop runs the next time this page
opens, over the case threads of any run still marked running, which is what
sweeps up after a crash or a mid-run reload. Nothing of yours is ever owned, so
the bench never stops, archives, or hides a thread you own, and the friction
reading on this page still reads every thread of yours, whether or not a bench
run ever mentioned it.

### What a run refuses, and what it costs

A run refuses to start in Ask mode, where the answers to the permission modals
would be the measurement, and refuses when any case points at a folder that is no
longer connected, which would run the case in an empty scratch directory. The
panel disables the buttons and names the reason; the driver re-checks against a
fresh grant list and refuses again, so neither a stale button nor a folder removed
between the click and the first turn gets through.

Both buttons carry their price. **Run the bench** names one turn per saved case;
**Test the trial** names two, because a trial is two arms over the same cases, and
also names which look it is about to be — `Test the trial · attempt 2 · 12 turns`
— so a re-run is a decision rather than a second click. The number on the button
is the number of real turns your provider is about to bill, and it moves as you
add and remove cases. While a run is going, the **Agent** row
in the sidebar carries a count of running runs, so leaving the page does not lose
track of one.

Ceilings: 12 cases, 24 runs, 4,096 characters of prompt per case, 24
results kept per run — exactly what a full twelve-case paired run produces, and
exactly what such a run has to hold before it counts as finished.

## The arithmetic

Let case *i* cost `a_i` without the change and `b_i` with it.

```
d_i = b_i − a_i
n   = complete pairs
d̄   = mean(d)
s_d = sample sd of d
SE  = s_d / √n
t   = d̄ / SE
```

A pair needs both arms, and the driver visits each case-arm exactly once, so a
case contributes one pair or none. There is no repeat control and no way to take
a second draw on a case — see Limits for what that does and does not buy.

**The t verdict** is two-sided at 95%, against `t` at `df = n − 1` rather than a
flat `z = 2` — at six pairs the true critical value is 2.571, and 2 would
over-claim badly:

```
tClear = n ≥ 6 && ( SE > 0 ? |t| > tCritical(n − 1) : d̄ ≠ 0 )
```

`tCritical` is a 30-entry table, returning 2.042 above 30 degrees of freedom;
`t_df` falls as `df` rises, so the flat tail is conservative. The `SE = 0` branch
is not a hedge: every case improving by exactly the same amount is the strongest
signal there is, and a rule that demands positive spread reads it as noise.

**The sign test** is the distribution-free backstop, because these are small,
right-skewed, zero-inflated integer counts and a t-test on six of them is a
stretch:

```
wins   = #{ d_i < 0 }    losses = #{ d_i > 0 }    ties dropped
m = wins + losses        k = min(wins, losses)
p = 2 · Σ_{j≤k} C(m, j) / 2^m,  capped at 1
signClear = m > 0 && p ≤ 0.05
```

**Both must clear.** The t-test speaks to magnitude, the sign test to
consistency. Requiring both is what stops one giant outlier case from dragging
the mean into a verdict — the exact failure a paired t over six integers invites.

```
verdict = run not done   → pending
          n < 6          → unproven
          m < 6          → unproven
          not both clear → unproven
          d̄ < 0          → improved
          otherwise      → regressed
```

Percent delta is `((b̄ − ā) / |ā|) · 100`, the same arithmetic the live trial's Δ
uses, so a percentage means the same thing wherever it is printed. That is a
convention, not a claim that the two readings carry equal weight — see below. The
`±` beside it is `tCritical(n − 1) · SE`, not the bare standard error — an
interval narrower than
the test it sits above would read as excluding zero on a run the t-test calls
unproven. When every case moved by exactly the same amount there is no spread to
build an interval out of, and the card prints `±—` and reads T as `—` with
`no spread · sign test only` beside it, rather than a confidently zero-width
`±0.00` under a verdict no t was computed for.

A zero baseline has no percentage, and `ā = 0` is the *ordinary* case for
`failures` and `blocks`, where a spotless arm A is what you hope for. The record
prints the absolute gap instead — `+1.00 per case from a zero baseline` — because
it used to print "no comparable cases", which is what an empty run says, and so
an unambiguous six-pair regression was written down as having had no cases at
all. A p below 0.001 records as `p<0.001` rather than rounding to `p=0.000`.

Whichever of those lines fired is carried out as `short`, a two-or-three word
naming of the actual blocker, `""` once there is a verdict. The panel prints it
rather than leaving you to infer the reason from the rows.

### Why six, and six of *what*

With `m` non-tied pairs all falling the same way, the exact two-sided sign-test
p is `2/2^m`: four cases give 0.125, five give 0.0625, six give 0.03125. **Below
six one-way cases the sign test cannot reach 0.05 even when every single case
agrees.** The floor is arithmetic, not caution. It is also the same six as the
live trial's per-arm turn minimum, which keeps one number in your head.

The six that binds is `m`, not `n`. **Ties count toward `n` and are dropped from
`m`**, so a run can be six pairs deep and still be five one-way pairs short of
anything the sign test can call. The `failed` metric makes this ordinary: six
cases, arm A ending badly on five and arm B on none, one case succeeding on both
gives `d = [−1,−1,−1,−1,−1,0]` — `t = −5.00` against a critical 2.571, a huge
result — and `m = 5`, `p = 0.0625`, unproven. That is the honest answer, and the
fix is a seventh case rather than a lower bar; `2/2^5` does not reach 0.05 and no
amount of wanting it to changes that. `short` says `5 untied of 6` so the one tie
is not something you have to spot in the Sign row.

### Fixed N, and why a stopped run has no verdict

The case count and the case list are stamped when a run starts and never change.
While a run is live its card shows a progress bar, which case of how many is
running, which arm that case is on, and the metric the run was stamped with —
and no number that came off the run: no arm means, no Δ, no t, no p, no per-case
bars, no verdict, no list of earlier attempts, and no button but **Stop**. There
is no reading to peek at and nothing that would act on one, so the incentive is
removed rather than warned about.

"Done" is not "the driver's loop exited". A run is done only when it holds every
case-arm it declared at the start — `plannedCases × arms`, two arms for a trial
and one for a baseline — and **anything short of that is `stopped`**. A stopped
run stays `pending` forever: it shows how many case-arms of the declared total it
reached, the metric it was to be read under, and no numbers. Stopping a run
because it looks good therefore yields nothing at all.

That is the whole of it, and it is deliberately blunt. One case-arm can fail on
its own — the turn errored, its trace never flushed, the pin did not take — and
one is enough to stop the run; there is no salvage rule that reads the survivors
and no fraction of the run you are allowed to lose. Missing data here is
missing-not-at-random *and correlated with the arm*: the cases that drop are the
long, heavy, interesting ones whose turns error or overrun, and the ones that
survive are the short easy ones where the change has the least room to matter. A
twelve-case run that loses six is not a six-case run — it is a six-case run drawn
from the wrong end of the distribution, and its estimate is biased rather than
merely noisy. Six unanimous survivors of twelve would otherwise read `improved,
p = 0.031`, which is the peek-and-legitimise loop wearing a p-value. A crash on
case seven of twelve is therefore a stopped run, and so is one lost trace on an
otherwise perfect twelve.

More power means starting a *new* run with more cases, and a finished run is
immutable. The panel draws one run at a time: the live one, or — while a trial is
open — that trial's own most recent finished run, or else the newest run there
is. **The card is titled with the change that run measured**, looked up from the
run's own `improvementId`, not with the change you happen to have open — because
the third of those three is a fallback, and a fallback wearing the open trial's
name is a verdict filed under the wrong change. A card whose numbers belong to
something else at least says so in its heading. Its eyebrow carries the run's
attempt number as well, so which look you are reading does not depend on there
being a second row to compare against.

Starting a baseline no longer hides the verdict you were reading, but there is
still no list of past runs to page back through; what you get instead is the
**Attempt** list under the card, one row per finished run of that change. The two
arm bars share a fixed track of the row, so the shorter is to scale against the
longer and the number printed beside them cannot squeeze either.

### Only a bench run can keep a change

The panel above the bench reads the same trial over your own turns as they
happen. It is unbounded optional stopping by construction: the arms are unpaired,
their size is whatever your own turns since the trial started happened to give
them out of a 30-day window, and the whole thing is recomputed on every mount and
after every turn, so it flips between `NO SIGNAL` and `WORTH BENCHING` as the
arms fill. So it has no **Keep it**. It has **Revert it**, it calls its own
reading a `Hint`, and it says under its N that the N is not fixed.

The asymmetry is the point, and it is not a hedge. You never need evidence to
*stop* doing something: a change you have lost confidence in can go at any
moment, at any N, on a hunch, and the cost of being wrong is that you are back
where you started. You need evidence to *keep* one, because a kept change rides
every later turn and every later measurement is taken through it. The only button
in the app that writes `Kept` is the one under a finished bench run.

A record is written once, by the decision that measured it, and nothing
rewrites it afterwards. **Keep it** and **Revert it** under a finished run write
that run's reading; **Revert it** on the live trial writes the unpaired one,
which begins `Reverted at 3/2 turns` and can never say `Kept`. **Stop using
this** writes nothing at all — it flips the row to `reverted` and stamps the day,
and the measured line stays as it was measured. So a stopped row does read `Kept
at 6 paired cases · …` under a `reverted` badge: that line is the quotation of
what the bench found, and the badge and the date beside it are what say the
change is no longer in use. Growing a stored record was the one writer that could
push it into the 1,024-character clamp and cut its p-value off, and it is gone.

Nothing that feeds a run may move while one is running. **Stop using this** and
**Try it again** are both locked while the bench is live, because pulling a kept
lesson out of the standing prompt between arm A and arm B of case 7 would put a
treatment you injected inside a pair, and the run would still finish, still read
`done`, and still reach a verdict with nothing on the record to say so.

The Decided list also says where a record came from. A line that does not name
paired cases is marked **no bench run behind it** in the summary, so a change
reverted off the live hint is never mistaken for one a run decided.

### The metric is stamped on the run

A run declares its metric when it starts, next to its case list and its case
count, and is read under that one forever. A trial run takes it from the change
on trial; a baseline takes it from the select, whose label says exactly that —
*Metric the next baseline run is stamped with*. Every read goes back through
`runMetric`, so a finished run cannot be re-read under a metric it did not
declare. Without the stamp the *same* run, no re-run and no new data, could be
read under all four metrics until one of them said IMPROVED, with the `proven`
headline ticking up as it went. Four correlated metrics picked after the fact at
α = 0.05 is about an 18% chance of finding one, on a display that presents itself
as proof. The scoreboard obeys the same stamp: a baseline run is plotted only on
the curve of the metric it declared. A stored row whose metric is missing, or is
not one of the four, reads as `failed`, so a run recorded before the stamp
existed still opens.

### Attempts are counted

Running the same trial again is allowed, and should be: a second run is more
data, and an unproven run at six pairs is often a real effect short of power.
What was wrong is that it was **silent**. The panel draws one run, so discarded
ones left no trace on screen, and the record read `Kept at 6 paired cases · … ·
improved · p=0.031` with nothing to say it was the third try. Optional stopping
across k clicks turns a per-run α of 0.05 into 1 − (1 − α)^k, which is 0.14 by
the third.

So every done run of a change is an **attempt**, the number is **stamped on the
run when the run starts**, and it is read back off the run — never recounted:

```
Kept at 6 paired cases · tool calls per turn · −18% · improved · attempt 3 · p=0.031
```

That number comes from the change, not from the runs. Every change carries the
look it is — 1 when you propose one, one more than the row you clicked when you
retry — assigned at the moment the row is created and never recounted. The run
copies it when the run starts. Counting attempts out of the store, at either end,
was the whole defect: the count was taken after the store had already made room,
so a third look could be written down as `attempt 1` exactly when the history
being disclosed got long enough to matter. Nothing reads a collection to produce
that number now — not the runs, not the other changes.

Every clause left in that line is like that: fixed when the run finished, and
frozen into the string when you decided. `6 paired cases` is the number of pairs
that run actually completed, the metric is the one it declared, the verdict and
the p come off its own numbers. **The record cites nothing that can be deleted
later.** It used to carry a cross-attempt comparison too — how many cases each
earlier attempt ran, whether the case set had moved, whether earlier attempts had
been dropped — and every one of those clauses was computed at the moment you
clicked, out of the runs still in the window. They said less the longer the
history got, and that is the wrong way round for a disclosure. They are gone.

They named something real, though, and it is now only a limit. **Remove** is
enabled on a case between runs, and the per-case bars under a finished run name
exactly which cases the change lost on — so dropping the six it lost on and
re-running is an obvious move, and it turns the population into a thing chosen
after the data was seen. Nothing can stop that without freezing the case list
forever. What each attempt actually ran is on the runs themselves, in the
**Attempt** list under the card, for as long as those runs are in the window.

The p-value is still the single-look one. Everything beside it is what tells you
how to read it.

### A change and its retries are one line

Every decided record carries **Try it again**, and the friction row that drafted
it carries the same choice. A row with decided records behind it lists them above
its buttons — each with its state, its date and its record line, and a button
that opens the next look at that one — and its own button then reads **Propose a
new change** rather than **Propose a change**. Whichever you click stamps the
draft: the retry buttons carry the chosen record's *lineage*, the propose button
carries none. Starting that trial **appends** a new record; the old one keeps its
state, its date and its result line, whether it was kept or reverted.

So which line a trial joins is **declared, not inferred**. The page may offer —
it groups the decided records under the friction row whose draft shares their
title, one entry per lineage, newest of each — but the click is what decides, and
the history is on screen before the click. Identity used to be *decided* by the
change's words, matched byte for byte against the records already on the page,
and that failed in the one case it existed for: the draft's skeleton quotes the
friction's live turn count and its newest error message, both of which move the
moment the tool fails again — which is precisely when you retry a change that did
not help. The same friction row therefore emitted different words on every visit,
and a second look at it was written down as a first. The byte match is gone.
Nothing about which line a change joins is inferred from its words: a draft
carries a lineage because you pressed **Another look at this one**, or it carries
none.

The proposal says which of the two you picked — `Proposal · another look at a
change you already decided`, or `Proposal · a new change` — and stops there. It
prints **no attempt number**, because at that point there is none. The number is
stamped on the bench run when the run starts; a count made here would be a
second, earlier guess at it, computed off rows the run's own stamp does not
depend on, and free to say `attempt 2` over a record that reads `attempt 1`.

While a retrial of a **kept** change is running, that change's kept lesson is
pulled out of the standing block for the duration: arm A of the retrial is
genuinely the arm without it, and arm B carries the new wording. Otherwise both
arms would have shipped the old lesson and the run would have measured the
difference between a change and itself. The page says so while it lasts — the
Decided row reads `retesting · off while retested` instead of `kept`, and the
`lessons kept` headline stops counting it — because a page that goes on claiming
a lesson is applied while both arms run without it is telling you the opposite of
what is being measured.

Only one trial runs at a time. Starting a second is refused rather than queued,
because two additions in the prompt at once would give one coin flip two
treatments.

The store holds 40 changes, and the only rows it will ever drop are **reverted
records whose whole line is reverted**: a lineage with a kept record or a running
trial anywhere in it is never touched, and neither is a reverted record a later
attempt still hangs off. When nothing is disposable the 41st is refused rather
than made room for — **Start the trial** goes flat and the panel says `40 changes
on file · stop using one first`. The old rule kept the last 40 rows and dropped
the oldest on every write, which meant proposing a change could silently delete a
kept lesson, take its text out of the standing prompt on the same tick, and leave
the rest of the page still counting it. A verdict you can still read is never
traded for one you have not run yet.

The 24-run store spends in order rather than by age. A run still going is never
spent. Everything else is ranked by what it cost you: a stopped run and a
finished baseline go first, because neither is behind a decision, and only when
there is nothing cheaper left does the oldest finished paired run go. Runs are
not records — no number the app shows or stores is read back out of one once its
verdict has been written down — so the ring can close over the oldest evidence
without any line on the page changing. It closes over the cheapest first anyway,
so the run you would click through to is the last thing spent.

The `proven` headline is counted the same way round, and off the same words. A
change counts as proven when it is **still kept** *and* the record you can read
on its row says `improved`. Not when any attempt ever did: **Keep it** writes the
reading of the run it sat under, so a change measured four times, clearing on the
third and regressing on the fourth, carries the fourth reading and is not proven;
nor is one you stopped using. Two improved runs of one change are still one
change proven, not two.

The headline reads the record rather than going back to the runs on purpose. The
record is written once and is kept until you delete the change. Counting `proven`
off the runs meant a number on screen that quietly decremented as old runs aged
out of the window — a change stayed kept, its line still said
`improved`, and the count above it dropped anyway, citing evidence the store no
longer held. The record is the evidence. It is written once, from a finished run,
and never recomputed.

### A stored run is not believed about being finished

`validateBench` clamps every other field it reads out of `localStorage` — prompt
length, case count, the rolling results window — and used to take `state` at face
value. Editing one row's `"stopped"` to `"done"` in devtools republished a verdict
on a run truncated on purpose after its numbers had been seen, with Δ, T, Sign and
Verdict all rendering and **Keep it** enabled. A stored `done` holding fewer than
`plannedCases × arms` results is now demoted to `stopped` on the way in.

The check sits in the validator rather than in each reader, so the panel, the
Attempt list and the record line all see one already-demoted row, and a demoted
run cannot be the one **Keep it** writes from. It raises the bar rather than closing the class, and says so: `plannedCases`
is read out of the same untrusted blob, so editing it down in the same pass makes
the row self-consistent again, and nothing signs the store. What it buys is that
the one-field edit — the edit a truncated run actually invites — no longer
republishes a verdict.

## The baseline scoreboard

A baseline run replays the cases under arm A alone, and the scoreboard plots one
point per baseline run over time. Four rules keep it honest:

- **Same mode and model.** Switching from a smaller model to a larger one
  mid-history would otherwise credit the model change to Emma's own lessons.
- **Same metric.** A run is plotted only on the curve of the metric it stamped;
  it is never recomputed under a metric it did not declare. The page builds a
  curve for each of the four and draws whichever has the most points, ties going
  to the one whose newest point is latest — so which curve you see is decided by
  the history, not by what the last run happened to have selected.
- **One baseline number, one run.** The `Baseline` row on a run's card is that
  run's own arm-A mean over its own cases, and it names how many. The curve below
  is a different reading of a different population — only the cases every run on
  the line shares — and it says so on its own header. The row used to be read out
  of the curve's family, which meant a finished run whose cases had moved on was
  excluded from the family and printed `Baseline —` after billing six turns.
- **A shared case set.** Only cases present in *every* run on the line are
  scored, so adding a hard case cannot make the line jump. Intersecting across
  *all* eligible runs would let one non-overlapping run — harvest six new cases,
  delete the old ones, run a baseline — empty the intersection and wipe a
  five-run curve off the display. Instead the line is drawn over the **largest
  family of runs that share at least one case**, most recent winning ties: pick
  the case the most runs ran, keep those runs, intersect their case sets. A run
  that shares nothing with the history sits out; it does not delete it.

All four metrics are costs, so a shrinking bar is the line going the right way.

## Limits

Read these before quoting a verdict at anyone.

- **The pairing controls for task difficulty, not for the model.** Each
  case-arm is a *single* draw from a sampling distribution. The design removes
  the variance between cases, which is the large term; it does nothing about the
  same case answered differently twice in a row, and nothing about a model that
  is stochastic by construction. The sign test is what keeps one lucky draw from
  carrying a run, and it is the reason both tests must clear. There is no repeat
  control: the driver visits each `(case, arm)` exactly once, so a run cannot
  take a second draw on a case. Both save doors now refuse a thread that is
  already a case, which closes the obvious way of faking one — but **the bench
  counts case ids, not prompts**, so two cases carrying the same prompt from two
  different threads are still two independent pairs to the arithmetic: `n` and
  `m` both go up, the sign-test p roughly halves, and the run over-claims in the
  direction you least want. More power comes from more *different* cases.
- **The scoreboard is a repeated absolute measurement, not a controlled
  contrast.** Its points are separated by time, by whatever else changed in the
  meantime, and by nothing that was randomised. Nothing about it is paired: it is
  arm A on two different days. It is weaker evidence than the paired test by
  construction, and it is a series to look at rather than a result to cite.
- **Twelve cases is a small experiment.** A verdict at six pairs detects a change
  that is consistent, not one that is subtle.
- **The attempt number counts looks at the line, not runs of one wording.** A
  retry is a new record with the old lineage, and its first run reads `attempt
  2`, because that is what it is: the second look at that change. The words being
  measured may have changed between the two, and the number does not say so. What
  was tested each time is the `addition` on each record, still sitting in Decided.
  Read the number for how many looks there have been, and the records for what
  each look actually said.
- **The record does not compare its population with the last attempt's.** It
  names its own — `6 paired cases` — and stops, because every cross-attempt
  clause had to be counted out of runs. The comparison lives on the panel
  instead, and across the dated records in the Decided list.
- **The stored record line is cut at 1,024 characters, on a word boundary.** No
  line the bench writes comes close, so the cut is a clamp on a store you can
  edit rather than something the app can walk into — but a line cut there loses
  its tail, and the p-value is at the tail.
- **A measured turn can be interrupted by hand, and the interruption is scored.**
  The case thread is archived before it is sent anything, but Archive →
  **Restore** puts it back in the sidebar mid-run, and pressing ■ on the turn
  stops it the ordinary way. A cancelled turn is not a failed turn: the trace is
  still written, the arm is still on its header, and the run's own span closes
  `ok` — so that case-arm is recorded with `failed = 0` and with whatever step
  and failure counts it had reached, which is to say it lands in the run looking
  like a clean, cheap case. Nothing guards it. The guard would cost a split
  between the driver and the thread view for a foot-gun that needs a deliberate
  detour through the Archive view and is on screen at every step — but it is a
  real way to hand-shape a number, so it is written down here rather than left as
  something you were supposed to know. If you do it, stop the run.
- **Approvals can still stop a case.** The bench refuses Ask mode outright, but
  Accept edits still asks before a command or the pointer, and Auto asks for
  anything its verifier will not clear. A case that trips one waits for you, and
  an unanswered question is denied after ten minutes — so whether you happened to
  be at the keyboard becomes part of the measurement. Run the bench in a mode
  whose gates your cases do not trip.
- **A halt refuses the next turn; it does not kill the one already running.**
  Ownership is claimed when a thread is created and the halt is recorded before
  anything is cancelled, so nothing spawned by a replay escapes by being too new
  — but a turn that has already passed the door runs to the end. Cancelling it
  is still a message to a live harness session, and a turn whose session is
  mid-handshake does not receive it. Expect up to one more full turn per thread
  after you press **Stop**, in that thread's own folder, with its output
  discarded.
- **One case thread can be briefly visible after a hard crash** — the one created
  but not yet archived. Each is archived before it is prompted, and the sweep when
  this page next opens stops and archives whatever a crash or a mid-run reload left
  running. There is no delete on the host; archived threads are hard-deleted 30
  days later by the snapshot sweep.
- **A sample whose trace header does not name the arm it was driven under is
  dropped**, rather than counted under the arm it was meant to have — and one
  dropped case-arm is enough to leave the whole run `stopped` with no verdict.
- **`proven` still counts a kept change while its own retrial is running.** The
  lesson is pulled out of the prompt for the duration, and the Decided row and
  the `lessons kept` headline both say so — but `proven` counts records that are
  still `kept` and whose own line says `improved`, and a retrial changes neither
  until it is decided. That number is about the record, not
  about what rode the last turn.
- **A branch off an older record repeats that branch's number.** The look is one
  more than the row you clicked, so retrying the newest record of a line always
  counts up. Reaching past it in the Decided list to retry an older row starts a
  second branch at the same number — two records can then both read `attempt 2`.
  Which run each names is still on its own dated row.
- **A lever applies 12 kept lessons per lever, and says which ones it dropped.**
  The standing block is capped at 12 lines; a 13th kept change on the same lever
  is stored and listed, and its row reads `past the 12-lesson ceiling`. The
  `lessons kept` count is the number actually riding, not the number stored.
- **The retry offer under a friction row is matched by the drafted title.** The
  records a friction row shows you are the decided ones whose title matches the
  title that row would draft — one entry per line, newest of each. That is a
  suggestion, not the identity: the identity is whichever button you press. A
  record made under a different title will not be offered there, and starting a
  new line by not finding an old one is a click away from being wrong. **Try it
  again** on the record itself, in Decided, always reaches the right line.
- **Traces are capped.** A thread keeps 64 of them at 16 KB each, and an
  oversized trace loses its middle. A case whose turn is enormous is scored off
  what survived the clamp.
