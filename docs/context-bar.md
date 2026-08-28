# The context bar

The thread inspector: the column down the right of a thread, built from
components you arrange. Emma ships **ten**
([`desktop/shared/context-bar.ts`](../desktop/shared/context-bar.ts) —
`CONTEXT_WIDGETS`), drawn by
[`desktop/src/context-bar.tsx`](../desktop/src/context-bar.tsx).

## The components

| | Component | Shows | Lays out |
|---|---|---|---|
| ▦ | Thread stats | Whichever metrics you picked, as tiles or rows. Six by default: messages, replies, attachments, tool calls, avg tok/s with a rate-by-context curve, output tokens | both |
| ▤ | Context window | What the last turn carried, by kind, against the model's stated window; ⤢ opens the full ledger as a table | both |
| ⌇ | Timeline | Every turn as a waterfall — model requests, tool calls, subagents | down only |
| ◰ | Plan | This thread's plan as a graph of subagents; pressing a node lights its wave | down only |
| ⌸ | Subagents | One row per live subagent, into the transcript it is writing | both |
| ⑃ | Sub threads | Threads this one started, working or idle — they outlive their runs, so the rows stay | both |
| ⑂ | Git | Branch, working tree, and the diff behind it. Renders nothing outside a repo. Highlighting inside one file's diff attaches that excerpt to the next turn | down only |
| ◫ | Machine | CPU, memory, GPU and network on this Mac, as numbers | both |
| ∿ | Machine graph | The same four as sparklines over the last minute | both |
| ▥ | Machine meters | The same four as 16-cell segmented gauges | both |

"Both" means the component is `orientable`: **vertical** is one item per line,
**horizontal** flows across and wraps. The four that are not orientable are
forced vertical however the settings file was written.

## The machine components

Three readings of one sampler, so a number and the gauge beside it cannot
disagree: CPU across every core, memory that is actually held (active, wired and
compressed — not the free page count, which on macOS reads as 97% used on an idle
Mac), GPU device utilisation, and network throughput either way.

They differ only in how they draw it — tiles of numbers, a sparkline a minute
long, or a row of 16 cells. CPU, memory and GPU are shares of a real ceiling;
network has none, so its sparkline and its cells are scaled against the loudest
second in the window on screen. A Mac that reports no GPU utilisation draws `—`
rather than a zero.

`useMachine` in [`desktop/src/machine.tsx`](../desktop/src/machine.tsx) holds one
minute of samples and one timer for the whole renderer however many of the three
are on the page, and stops sampling when the last one unmounts. Nothing samples
while the bar is collapsed or a different page is showing.

## The metrics

Thread stats draws what `widget.metrics` names, in that order, and the shipped
six (`DEFAULT_METRICS`) when it names nothing. The catalog is `CONTEXT_METRICS`
in [`desktop/shared/context-bar.ts`](../desktop/shared/context-bar.ts):

| | |
|---|---|
| Counts | Messages, Emma replies, Attachments, Tool calls, Subagents, Sub threads |
| Speed | Avg tok/s (the ▮ curve rides this one), Generation time |
| Tokens | Output tokens |
| Context | Context carried, Context window, Context free, Context used, Largest segment |
| Pruning | Pruning saved, Pruning added, Pruned results, Reinjections |

Every one reads the same `Ledger` the rest of the bar does, plus the live
subagent and sub thread lists, so a metric and the component under it cannot
disagree. Pick them with **▦** in the component's header while arranging —
in the bar's own Edit mode or in Settings. The last checked metric cannot be
unchecked; an empty stats component would only be a blank band.

## Pages

Up to `MAX_CONTEXT_PAGES` (**4**) arrangements, each named in
`MAX_PAGE_NAME` (**20**) characters or fewer. With more than one, the bar's
header becomes a `role="tablist"` row of page tabs; the chosen page id is
remembered in `localStorage` under `emma.contextPage.v1`.

Ships with three: **Context** (stats horizontal, then context, timeline, plan,
subagents, sub threads), **Run** (timeline, plan, subagents, sub threads, git)
and **Machine** (meters, graph, numbers). A component appears at most once per page — its type is the key the
drag-and-drop sorts by, so there are no instance ids to mint.

## Arranging

| Where | What |
|---|---|
| The bar's footer | **＋** adds a component that is not on this page; **Edit** turns the page into a drag-and-drop list with per-component flip, metric picker (**▦**, stats only) and remove |
| **Settings → Context bar** | The page editor: palette on the left, a 288px preview of the real components over a made-up thread on the right. Add, delete and rename pages here |
| The column edge | Drag to resize |
| The `‹` toggle | Collapse to a 30px rail |

Width is clamped to **260–360px**, default **288**
([`desktop/src/layout.ts`](../desktop/src/layout.ts), `validatePaneLayout`), and
squeezed toward the minimum when the window is too narrow for the panes asked
for. Opening the browser pane collapses the inspector and restores it on close.

Drag-and-drop is [@dnd-kit](https://github.com/clauderic/dnd-kit) — pointer and
keyboard sensors, so a component can be reordered from the keyboard.

## Validated on the way in

`validateContextPages` runs on every read of the stored settings, so a
hand-edited settings file cannot produce a bar that will not paint. It refuses:

- fewer than 1 or more than 4 pages, or two pages with the same id
- an id that is not `p1`…`p9`, a blank name, or a name over 20 characters
- a component type it does not know, or more components than exist
- the same component twice on one page

It also rewrites rather than refuses where a value is merely wrong: a bad
orientation becomes `vertical`, and so does any orientation on a component that
is not orientable; a metric it does not know is dropped, a repeated one is kept
once, and a `metrics` list on anything but stats — or one that survives none of
that — is dropped so the defaults draw. A page list that throws takes the whole settings object down
to defaults rather than half-applying.

## Replacing the bar

`context` is one of the four artifact surfaces
([`desktop/shared/artifacts.ts`](../desktop/shared/artifacts.ts) —
`navbar`, `chat`, `notch`, `context`). A `code` artifact with `language: "js"`
exporting `(api) => Component` and claiming `context` is loaded as a real module
and takes the region's place, handed the same props the built-in gets: `thread`,
`messages`, `ledger`, `busy`, `sending`, `agents`, `subagents`, `subthreads`,
`git`, `collapsed`, `setCollapsed`.

The built-in is what shows when there is no module, and what comes back when one
throws — the error boundary swaps it in and prints *"Emma's context could not
run, so the built-in is back"* ([`desktop/src/regions.tsx`](../desktop/src/regions.tsx)).
See [plugins.md](plugins.md).

## Where the numbers come from

| Data | Produced by |
|---|---|
| Messages, replies, output tokens, tok/s, rate curve | `message.generation` on the thread |
| Attachment and skill rows | `recordUses` → `emma.threadContextUses.v1`, merged by `mergeUses`, capped at `MAX_USES` (32) |
| The transcript row | `historyUse` — the characters of every stored message |
| The turn in flight | `inputTokens` and `toolCalls` summed over the live agents main broadcasts |
| The residual row | `systemChars(lastInputTokens(thread), measuredChars)`, floored at 0 |
| Window capacity | The OpenRouter catalog's `contextLength`. Zero on the fallback and local routes, which is why free space disappears |
| Subagent rows | The live agent list (`LiveAgent`, [`desktop/shared/agents.ts`](../desktop/shared/agents.ts)) |
| Sub thread rows | `snapshot.threads` from the host — not the agent list, which is why an idle sub thread still has a row |
| Timeline spans | `listSpans()` and `onSpans` for the live turn, `threadTraces(threadId)` for the rest |
| Git | `gitStatus(folderId)` |
| CPU, memory, GPU, network | `machineSample()` — `os.cpus()` deltas in the main process, and one `/bin/sh` per second over `netstat -ib`, `ioreg -c IOAccelerator` and `vm_stat` ([`desktop/main/machine.ts`](../desktop/main/machine.ts)). macOS only |

Characters are counted on this Mac and divided by `CHARS_PER_TOKEN` (**4**) to
read as tokens, so every ledger figure is an estimate.

`useContextLedger` builds the ledger once, in the thread pane, and hands the same
object to every component on the page — stats, the window and the timeline's
context axis are three readings of one number and cannot disagree. It is built
whether or not the component drawing it is on the page you are looking at.

A turn is one durable message however many steps it took, so the running total
shows as its own **This turn** row until the message it becomes replaces it. That
running total is left out of the residual subtraction: the residual is what the
last *landed* turn's input count could not account for.

## Exporting a thread's numbers

The `(i)` in the thread bar opens **Thread agent**, and its **Stats** row writes
every number this page draws — and the ones it does not — to a folder of CSVs
you choose. One file per sheet:

| File | One row per |
|---|---|
| `summary.csv` | metric — identity, counts, tokens, speed, context, goal |
| `turns.csv` | message, with its model, tokens, duration, tok/s and context bucket |
| `spans.csv` | trace span, with its parent, depth, offset in the turn, arguments and result |
| `tools.csv` | tool — calls, failures, total and slowest time, result tokens |
| `models.csv` | model — turns, tokens either way, requests, tok/s |
| `rate-by-context.csv` | context doubling — the same ladder the ▦ curve draws |
| `context-ledger.csv` | ledger segment, plus free space and the stated window |
| `sub-threads.csv` | thread this one started |
| `agents.csv` | live subagent |
| `plan.csv` | plan step |

Gathered by `collectStats` ([`desktop/src/thread-stats.ts`](../desktop/src/thread-stats.ts)),
which reads the same sources the table above lists, so an exported figure and a
drawn one are one number. Everything the renderer counts in characters is
exported in both characters and tokens at `CHARS_PER_TOKEN`.

The folder is named and placed by a save dialog. The renderer hands the main
process a flat list of `<name>.csv` files, and
[`statsExportRequest`](../desktop/main/ipc.ts) refuses a name that is not a plain
lower-case CSV file — nothing the renderer sends can write outside the folder
you picked.

## See also

- [concepts.md](concepts.md) — thread, run, context ledger, inspector
- [models.md](models.md) — token accounting and the stated window
- [plugins.md](plugins.md) — artifacts that replace a region of the interface
- [design-system.md](design-system.md) — tokens, density, glyphs
