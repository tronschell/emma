# The context bar

The column down the right of a thread. **You arrange all of it.** Every component
can be added, dropped, reordered and laid out two ways, on up to four named pages
the bar's own tabs switch between.

The catalog and the validator are in
[context-bar.ts](../desktop/shared/context-bar.ts); the widgets and the arranger
are in [context-bar.tsx](../desktop/src/context-bar.tsx); the two layouts per
widget are in [styles/context-bar.css](../desktop/src/styles/context-bar.css).

## Where it is

It is the `<aside className="inspector">` in
[App.tsx](../desktop/src/App.tsx), to the right of the transcript and the
composer. Its header holds the page name (or the page tabs), the `+N −M` changes
button when this thread's agents have rewritten files, and **Save & analyze**.
Below that, `ContextWidgets` renders the current page's components in order.

Two controls act on the column itself rather than on what is in it:

| Control | What it does |
|---|---|
| `.inspector-toggle` (`›` / `‹`) | Collapses the whole column. Stored as `inspectorCollapsed`. |
| `ResizeHandle` on the left edge | Drags the column wider or narrower. `role="separator"`, and ArrowLeft/ArrowRight move it 8px at a time. |

Both live in `PaneLayout` ([layout.ts](../desktop/src/layout.ts)), saved under
`emma.layout.v2` in localStorage, separate from the arrangement. The handle is
mounted with `min={210} max={360}`, but every write goes through
`validatePaneLayout`, which clamps `inspectorWidth` to **260–360** and shrinks it
further if the window is too narrow to hold both panes. The default is **288**,
which is the width the Settings preview is drawn at.

## What it can show

Seven components. This is the whole catalog, `CONTEXT_WIDGETS` in
[context-bar.ts](../desktop/shared/context-bar.ts), verbatim:

| `type` | Label | Glyph | Blurb | Orientable |
|---|---|---|---|---|
| `stats` | Thread stats | `▦` | Messages, replies, attachments, tool calls, speed, and output tokens. | yes |
| `context` | Context window | `▤` | What the last turn carried, by kind, against the model's stated window. | yes |
| `timeline` | Timeline | `⌇` | Every turn as a waterfall — model requests, tool calls, subagents. | no |
| `plan` | Plan | `◰` | The plan this thread is working through, drawn as a graph of subagents. Press a node to light its wave. | no |
| `subagents` | Subagents | `⌸` | One row per subagent, into the transcript it is writing. | yes |
| `subthreads` | Sub threads | `⑃` | Threads this one started, working or idle. They outlive their runs, so the rows stay. | yes |
| `git` | Git | `⑂` | Branch, working tree, and the diff behind it. Empty outside a repo. | no |

The label, glyph and blurb are constants. You cannot rename a component or give
it your own icon — the only text you name is the page.

### Thread stats

Six figures, all read off the ledger:

| Figure | Where the number comes from |
|---|---|
| `N messages` | `thread.messages.length` |
| `N Emma replies` | messages with `role === "assistant"` |
| `N attachments` | ledger rows of kind `attachment` or `skill` |
| `N tool calls` | the calls counted off landed turns' traces, plus the live agents' |
| `N avg tok/s` | output tokens ÷ total `durationMilliseconds` × 1000, or `—` when nothing was timed |
| `N output tokens` | every reply's `generation.outputTokens`, summed, through `charLabel` |

The `avg tok/s` tile carries a small chart button (`Tokens a second by context
size`). It opens the **speed curve**: the same replies pooled per doubling of
input from `RATE_FLOOR` (4096), one bar per bucket, labelled `4K`, `8K`, `16K`…
The average hides the trend — generation slows as the request grows — so the
curve hangs off the number it qualifies. With no timed replies it says
`No timed replies yet.`

Horizontal is the 2-up tile grid. Vertical is one metric a line, label left,
number right, which is what still reads when the column is narrow.

### Context window

The prompt ledger, drawn as one 48-cell bar over its legend.

The title reads **Context window** when the model states one and **Context used**
when it does not. The readout under it reads like `62k / 1049k tokens (5.9%)`, or
`62k tokens sent · no stated window` on the fallback and local routes, where
there is nothing to be a percentage of.

Rows, in the order they are assembled:

| Row | Kind | Meaning |
|---|---|---|
| Prompt, tools & retrieval | `knowledge` | The residual — everything assembled below Emma that the provider's input count reports and nothing else accounts for: the harness's system prompt, whatever tool schemas it advertised, retrieved knowledge, injected skills, resent steps |
| `N durable messages` | `history` | The transcript, which rides every turn |
| `This turn · N tool calls` | `history` | The turn in flight, only while one is running |
| An attached file or folder listing | `attachment` | Recorded when the turn was built |
| An attached skill | `skill` | Same |
| Free space | — | Only when the model states a window |

Kind names in the tooltips come from `KIND_NAMES`: Transcript, System prompt,
Tool schemas, Knowledge, Attachment, Skill. Hues are in
[panels.css](../desktop/src/styles/panels.css) — history blue, knowledge violet,
attachment teal, skill rose, system lime, tools orange, free space grey.
The `system` and `tools` kinds are held open for a harness that one day reports
what it advertised; nothing emits them today.

Emma used to state its own system prompt and tool catalog as two exact rows,
measured off `toolDefinitions()` — the catalog its own agent loop assembled. That
loop is gone: the harness decides what a turn advertises, and most of its tools
wait behind `search_tools` rather than riding every request. The rows were sizing
a request nobody sends, and because they came from a projection rather than a
turn, a brand new thread read `8.2k tokens sent` having sent nothing. Both fold
into the residual now, which is derived from what a turn actually carried, so an
empty thread reads zero.

Under the legend, one more line appears **only if a Harness experiment has fired
on this thread**: `Experiments · −12.4k net · 18.4k saved, 0.9k added`. Pruning
takes tokens out of what is resent; the repeated prompt puts tokens back in.
Neither is something the turn carried, so it sits below the rows, not in them.

The expand button opens a modal with the same grid over a table — Segment, Kind,
Chars, Tokens, Share, Turns — plus Carried, Window, Free space, Largest,
Experiments, Messages, Attachments, Tool calls and Output.

Horizontal wraps the legend into swatches and drops the share column, so eight
segments cost three lines instead of eight. The bar above it is unchanged.

### Timeline

The thread's turns as one waterfall under a synthesised `Overall` root, newest
turn first. Not orientable. It renders nothing until something has run, so it is
safe to leave on a page. Bars can measure **Time** or **Context**, and the
Context toggle only appears once a span has actually reported a size. Full
detail — the span shape, the storage format, the axis, the expanded dialog — is
in [concepts.md](concepts.md#the-span-waterfall).

### Plan

The plan filed under this thread, drawn as a graph: a row per wave, edges from
what each step waits on, one colour per state (`running`, `ready`, `waiting`,
`done`, `failed`). Pressing a node lights its whole wave and opens that step's
tasks, six to a page. The expand button prints the plan file itself. Not
orientable. With no plan it says
`Nothing planned yet — Emma writes one per plan write.`

Several plans under one thread put a row of tabs above the graph, one per plan,
sorted by id rather than the folder's newest-first — a row that reshuffles every
time a step ticks is not one you can go through. Each tab carries a dot in the
graph's own colours for where that plan as a whole got to, so the one Emma is
running right now pulses accent whichever you are reading. The widget opens on
that one, and stays on whichever you press.

### Subagents

One row per subagent: a coloured square (pulsing while running or
waiting, still under `prefers-reduced-motion: reduce`), the subagent's title, and
its model — falling back to its status when it has no model. Pressing a row
switches the thread pane to that subagent's transcript tab. Empty state:
`Nothing delegated yet — a subagent gets a row here the moment it starts.`

Horizontal drops the model column and wraps the squares, so a thread that fanned
out to eight of them is one strip rather than eight rows.

### Sub threads

The header reads `Sub threads · 1 of 2 working`. One row per non-archived thread
whose `parentThreadId` is this one and whose `kind` is not `subagent`, drawn with
a `↳` in its agent's colour when it has one. The trailing figure is the agent's
status while it is alive, and otherwise how long ago the thread last moved
(`<1m`, `42m`, `3h`, `5d`). A live row carries a `■` that calls
`window.emma.stopAgent`. Pressing the row leaves this thread for that one, which
is the difference from the rail above: a subagent is a step of this turn, a sub
thread is a place that outlives every run in it. Empty state:
`Nothing branched off yet — Emma opens one per threads spawn.`

### Git

Branch, `N files uncommitted` or `Working tree clean`, the `+N −M` count, and one
collapsible section per file with its diff. The whole widget renders nothing when
the thread has no folder attached, since `useGit` returns `null` without one. In
the bar the per-file diff is capped at `MAX_DIFF_LINES`; the `⤢` button opens the
same panel in the Git tab, where the cap comes off and each file gets an
open-in-editor control. Not orientable.

## How it is customizable

![Settings → Context bar: the page tabs, the component palette with what is on the page and what is left, and the live preview at 288px](../desktop/screenshots/settings-context-bar.png)

This is the point of the bar. Everything below is done in **Settings → Context
bar** (`SettingsPage` id `contextbar`, listed as "Arrange the thread inspector"
under Personal).

### The axes

| Axis | How | Limits |
|---|---|---|
| **Add a component** | Drag its palette card into the column, or press its `+` to append | Each component at most once per page |
| **Remove one** | Press the `×` on its header row in the preview | A page may be empty |
| **Reorder** | Drag the grip on its header row | — |
| **Flip its layout** | Press `⇄` / `⇅` on its header row | Only on `orientable` components: stats, context, subagents, subthreads |
| **Add a page** | **New page** | `MAX_CONTEXT_PAGES` = 4 |
| **Rename a page** | The Name field | `MAX_PAGE_NAME` = 20 characters, and it cannot be blank |
| **Delete a page** | **Delete page** | Disabled at one page — you always keep at least one |

Reordering is real drag-and-drop, on `@dnd-kit`
(`@dnd-kit/core` 6.3.1, `@dnd-kit/sortable` 10.0.0, `@dnd-kit/utilities` 3.2.2).
Placed widgets are a `SortableContext` with `verticalListSortingStrategy` and
`closestCenter` collision; palette cards are plain `useDraggable`, with `add:` in
front of their id so a card and a placed widget can share a type without
colliding. Pointer drags need 4px of movement before they start, so pressing a
grip is not accidentally a drag. A `KeyboardSensor` with
`sortableKeyboardCoordinates` is registered too, and every grip is a real
`<button>` with an aria-label (`Reorder Timeline`, `Drag Git into the bar`).

While you drag, the pointer carries a `DragOverlay` ghost — just the glyph and
the name, not a clone of a 288px panel being hauled across a 980px page. The drop
target lights its own edge instead of a dashed rectangle appearing from nowhere.

**What is not customizable:** per-widget width or height (the column resizes as a
whole), the labels and glyphs, and duplicates of one component on one page. A
page holds each component at most once, which is what lets the type itself be the
key dnd-kit sorts by — no instance ids to generate, none to keep unique.

### The preview is the real thing

The arranger mounts the **actual widgets** over a made-up thread, inside a real
`.inspector` at the real 288px. Nothing restyles a widget for the preview; if it
looks different in Settings than it does in a thread, that is a bug. The sample
thread is sized so every widget has something to say — a part-full window, a
transcript that dominates it, one skill, replies slow enough that the speed curve
has a slope, two subagents, two
sub threads (one working, one quiet), a four-step plan mid-run, and a one-file
diff.

The two widgets that fetch for themselves — the timeline's stored trace and the
plan's folder — take a `sample` prop, and that is the only hook. Inside the
preview each widget body carries `inert`, so a press lands on the card rather
than opening a dialog over a thread that does not exist.

Layout: palette left, the bar pinned sticky on the right at 288px, preview height
`min(60vh, 560px)`. Under 900px wide the bar drops below the palette and stays
288px, because 288px is the whole point of previewing it.

### The defaults

`defaultContextPages`, two pages:

| Page | Name | Components, in order |
|---|---|---|
| `p1` | Context | stats (horizontal), context, timeline, plan, subagents, subthreads |
| `p2` | Run | timeline, plan, subagents, subthreads, git |

Page 1 is the bar exactly as it was before it was configurable. Page 2 is a run
being watched. A page created with **New page** starts as `Page N` holding
`stats` horizontal.

### Switching pages in the bar

With one page, the header shows its name. With more than one, it becomes a real
tablist (`role="tablist"`, `aria-label="Context bar pages"`), one tab per page,
each titled `Context — 6 components`. Four is the ceiling because a fifth tab in
a 288px column either truncates every name to three characters or wraps the row.

Which page you are on is **not** a setting. It lives in `localStorage` under
`emma.contextPage.v1`, read once by `readContextPage` and written by
`writeContextPage`. It is where you are looking, not how you set the app up, and
storing it in settings would broadcast a settings change on every tab click. If
the stored id names a page that no longer exists, the bar falls back to the first
one.

### The deepest axis: replace it entirely

The whole `<aside>` is wrapped in `<Region name="context">`
([regions.tsx](../desktop/src/regions.tsx)). An artifact whose `surface` is
`context` replaces the built-in inspector with its own component, handed
`thread`, `messages`, `ledger`, `busy`, `sending`, `agents`, `subagents`,
`subthreads`, `git`, `collapsed` and `setCollapsed`. A module that throws while
rendering gives the region straight back to the built-in and says why. See
[concepts.md](concepts.md) and [plugins.md](plugins.md).

## Where the configuration is stored and validated

**The key is `contextPages`**, a field of `UserSettings` in
[settings.ts](../desktop/shared/settings.ts):

```ts
/** Arrangements of the thread inspector's components; the bar switches between them. */
contextPages: ContextPage[];
```

with `defaultSettings.contextPages = structuredClone(defaultContextPages)`. The
shape is `{ id: string; name: string; widgets: { type; orientation }[] }[]`.

The whole `UserSettings` object is one localStorage entry, `emma.settings.v1`.
Reads go through `readSettings`, which validates and falls back to
`defaultSettings` on any throw. Writes go through `persistSettings`, which
validates, stores, and dispatches `emma-settings-changed`.

`validateSettings` calls **`validateContextPages`**, which is the entire contract:

| Input | Result |
|---|---|
| `undefined` or `null` | A clone of `defaultContextPages` — a store written before the bar was configurable is not a corrupt store |
| Not an array, empty, or more than 4 pages | `Keep 1 to 4 context bar pages` |
| A page that is not an object | `A context bar page is invalid` |
| `id` not matching `/^p[1-9]$/` | `A context bar page is invalid` |
| `name` missing, blank after trim, or over 20 chars | `Name every context bar page, in 20 characters or fewer` |
| `widgets` not an array, or longer than the catalog (7) | `A context bar page is invalid` |
| A `type` not in `CONTEXT_WIDGETS` | `A context bar component is invalid` |
| The same type twice on one page | `A component can only appear once on a page` |
| Two pages with the same id | `Context bar pages must have distinct ids` |

Two things are coerced rather than rejected: names are trimmed on the way out,
and `orientation` is forced to `"vertical"` unless the value is literally
`"horizontal"` **and** that component's definition is `orientable`. So a stored
`{ type: "git", orientation: "horizontal" }` loads as vertical instead of
throwing.

`nextPageId` only ever mints `p1`–`p4`, picking the lowest id no page is using so
a new page never collides with a removed one's. The regex is wider than that, so
a hand-edited `p7` validates.

The editor is forgiving on purpose. `saveContextPages` in
[App.tsx](../desktop/src/App.tsx) is:

```ts
const saveContextPages = (contextPages: ContextPage[]) => {
  try { setSettings(persistSettings({ ...settings, contextPages })); }
  catch { setSettings((current) => ({ ...current, contextPages })); }
};
```

Clearing the Name field makes the validator throw, so that keystroke stays in
React state and is not written. Type a name again and it persists.

### The trust boundary

Elsewhere in Emma, main validates rather than trusting the renderer — the radial
ring is the clearest case, where main checks every message against its own
command catalog. **That pattern does not apply here, because `contextPages` never
crosses to main.**

`syncMainPreferences` sends main exactly `notchGap`, `cursorOrbsEnabled`,
`notchConcurrency`, `systemPrompt` and `connections`, and main re-validates that
payload with `validateOverlayPreferences`. `contextPages` is not in it, and no
other IPC carries it.

Main has no involvement in the bar at all. It used to answer `emma:context-parts`
with the size of its own prompt and tool catalog; that channel is deleted, and
every figure the bar shows now comes from the thread, the live agent list, or
localStorage. So the arrangement is renderer-owned end to end. `validateContextPages` is not a
privilege boundary — it is the renderer guarding itself against its own
localStorage, which a user or a stale build can put anything into. The worst a
bad value can do is break the renderer's own layout, and both entry points
(`readSettings` falling back, `saveContextPages` catching) stop a corrupt or
half-typed value from doing even that.

## The data behind each number

Every figure in the bar is produced somewhere else:

| Data | Produced by |
|---|---|
| Messages, replies, output tokens, tok/s, speed curve | `message.generation` on the durable thread — main's `recordTurn` writes `inputTokens`, `outputTokens`, `durationMilliseconds`, `model`. See [models.md](models.md#token-rate-and-cost-accounting) |
| Attachment and skill ledger rows | `recordUses` in [context.ts](../desktop/src/context.ts) → `emma.threadContextUses.v1`, merged by `mergeUses`, capped at `MAX_USES` (32) |
| The transcript row | `historyUse` — the characters of every stored message |
| The turn in flight | `agent.inputTokens` and `agent.toolCalls` summed over live agents from main's agent list |
| The residual — system prompt, tool schemas, retrieval | `systemUse` → `systemChars(lastInputTokens(thread), measuredChars)`, floored at 0 |
| The window capacity | `useSelectedModel` → the OpenRouter catalog's `contextLength`. Zero on the fallback and local routes, which is why free space disappears |
| Experiment savings | `recordExperiment` → `emma.threadExperiments.v1` |
| Subagent rows | The live agent list main broadcasts (`LiveAgent` in [agents.ts](../desktop/shared/agents.ts)) |
| Sub thread rows | `snapshot.threads`, the host's library — not the agent list, which is why an idle sub thread still has a row |
| Timeline spans | `window.emma.listSpans()` and `onSpans` for the live turn, `threadTraces(threadId)` for the rest |
| Git | `window.emma.gitStatus(folderId)` |

Characters are counted on this Mac and divided by `CHARS_PER_TOKEN` (4) to read
as tokens, so every ledger figure is an estimate. The panel measures in
characters and the window is stated in tokens, so every figure is divided back
before it is shown. Skip that and you get `62k / 4000k` — 62k characters of a
4M-character budget, the same fraction, but reading as a window four times the
model's.

## The ledger, and how the widgets share it

`useContextLedger` builds the ledger **once**, in the thread pane, and hands the
same object to every widget on the page. Thread stats, Context window and the
timeline's context axis are three readings of one number, so they cannot
disagree.

It is built whether or not the widget that draws it is on the page you are
looking at — take Context window off a page and the timeline's context axis is
still right.

Two details worth knowing. A turn is one durable message however many steps it
took, so a ledger read off `thread.messages` alone would sit still through
exactly the part that fills the window — a hundred tool results, resent every
step — and then jump when the turn lands. The running total is shown as its own
`This turn` row until the message it becomes replaces it. And that running total
is deliberately left out of the residual subtraction: the residual is what the
*last landed* turn's input count could not account for, and a turn in flight has
not reported one yet.

The prompt ledger and the inspector as concepts are in
[concepts.md](concepts.md#the-context-ledger) and
[concepts.md](concepts.md#inspector); usage accounting is in
[models.md](models.md#token-rate-and-cost-accounting). This page does not repeat
them.

## Interaction and accessibility

- **Page tabs** are `role="tab"` inside `role="tablist"` with `aria-selected`,
  and each is titled with its component count.
- **Truncation.** Subagent and sub thread titles ellipsise on one line. Legend
  labels clamp to two lines with `overflow-wrap: anywhere`, breaking at the `·`
  these labels already carry, so `Experiments/ · file list` wraps instead of
  ellipsising mid-word. Widget header names in the arranger ellipsise.
- **Overflow.** `.inspector-body` scrolls vertically. Nothing in the bar scrolls
  horizontally; a narrow column changes shape instead — which is what the
  vertical orientation is for.
- **Every control is a real button** with an aria-label: expand affordances,
  the rate toggle (`aria-expanded`, `aria-controls="rate-curve"`), the flip
  (`aria-pressed`), the remove, the grips, and the per-row stop.
- **Dialogs** are native `<dialog>` opened with `showModal`. Escape closes them
  through `onCancel`, and clicking the backdrop closes them too.
- **Reduced motion.** The pulsing subagent square and sub thread branch stop
  animating under `prefers-reduced-motion: reduce`.
- **The resize handle** is keyboard-operable: focus it and use ArrowLeft or
  ArrowRight for 8px steps, with `aria-valuemin`, `aria-valuemax` and
  `aria-valuenow` reported.

## Adding a component

End to end, in order:

1. **[desktop/shared/context-bar.ts](../desktop/shared/context-bar.ts)** — add an
   entry to `CONTEXT_WIDGETS`: `type`, `label`, `glyph`, `blurb`, `orientable`.
   The type union, the validator's length ceiling, the palette and the "N left"
   count all derive from this array, so nothing else needs its length bumped. Add
   it to `defaultContextPages` only if it should be on by default for everyone.
2. **The component itself** — a new file in `desktop/src`, or an existing one.
   Take `orientation: WidgetOrientation` as a prop if it is orientable and put it
   on the root as `data-orientation`. If it fetches its own data, take a `sample`
   override prop the way `Timeline` and `PlanRail` do, or the Settings preview
   will have nothing to draw.
3. **[desktop/src/context-bar.tsx](../desktop/src/context-bar.tsx)** — add a
   branch to `Widget`; add any new field to `WidgetContext`; add a `SAMPLE_*`
   constant and wire it into `usePreviewContext`.
4. **[desktop/src/App.tsx](../desktop/src/App.tsx)** — supply the new
   `WidgetContext` field at the `<ContextWidgets ... />` mount.
5. **[desktop/src/styles/context-bar.css](../desktop/src/styles/context-bar.css)**
   — the `[data-orientation="horizontal"]` rules if it is orientable, and, if the
   component draws its own label row, add that selector to the
   `.bar-widget-body … { display: none }` list so the arranger's card header does
   not print the name twice.

Nothing in `desktop/main` and nothing in
[settings.ts](../desktop/shared/settings.ts): the settings key already exists and
the validator is generic over the catalog. Existing saved arrangements keep
validating — the new component simply is not on any page until someone adds it.

## See also

- [concepts.md](concepts.md) — thread, run, subagent, sub-thread, the context
  ledger, the span waterfall, the inspector
- [models.md](models.md) — usage accounting, `CHARS_PER_TOKEN`, context windows
- [design-system.md](design-system.md) — the tokens, density and square-corner
  rules the bar is drawn with
- [architecture.md](architecture.md) — process boundaries and the trust model
- [plugins.md](plugins.md) — artifacts that mount into a region
- [development.md](development.md) — repo map and house rules
