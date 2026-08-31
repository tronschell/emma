---
name: artifact
description: How to decide whether a piece of work deserves an artifact, and how to make and edit one with the `artifact` tool — a document, code file, web page, SVG, diagram or React component the user keeps, edits and reuses outside the conversation, or a live module that replaces one whole region of Emma's own interface — her sidebar, conversation pane, notch or context bar. Something *new* in the interface is the `component` tool instead, which builds a widget into the context bar, not an artifact. Use whenever the user asks you to write, save, edit or keep something of that shape, whenever they ask you to build or change part of Emma's interface, when they point at the Artifacts page, and before you paste anything long enough that they would want it as a file.
---

# Artifacts

An artifact is the thing a conversation leaves behind. It lives on the Artifacts
page in the sidebar, it has an id, and any later thread or scheduled task can
read it and rewrite it.

Unlike the other bundled skills, **this one is yours to edit**. Emma reseeds the
rest from the app on every launch; this one is left alone once you have changed
it, so tighten the criteria below to taste and the change survives.

## When one is worth making

All four, or none:

1. **Significant and self-contained** — typically more than 15 lines.
2. **Something the user will want to edit, iterate on, or reuse** outside this
   conversation.
3. **It stands on its own** — it makes sense without the conversation around it.
4. **Worth referring back to** later.

## When not to

- brief snippets and one-liners
- explanatory or illustrative content — a worked example inside an answer
- commentary on an artifact that already exists
- conversational answers
- one-off questions

**Err strongly on the side of not creating one.** At most one per reply unless
the user asks for more. A wrongly-made artifact is worse than a missing one: it
puts a file on their page that nobody wanted and nobody will delete.

## The seven kinds

| kind | for | saved as |
|---|---|---|
| `markdown` | documents, notes, plans, write-ups | `.md` |
| `code` | a script or module in any language — set `language` | `.txt` |
| `html` | a self-contained page, styles and script inline | `.html` |
| `app` | a page that keeps its own data — see below | `.html` |
| `svg` | a drawing, icon or figure | `.svg` |
| `mermaid` | a flowchart, sequence or state diagram | `.mmd` |
| `react` | one component, default-exported | `.jsx` |

`react` is **shown as source, never run** — Emma renders no model-written
component. If it is meant to be looked at rather than read, it is an `html`.

`html` when the page shows what you already wrote into it. `app` when the *user*
puts things in and expects them to be there tomorrow.

## The tool

```
artifact {"action": "list"}
artifact {"action": "get", "id": "flight-tracker"}
artifact {"action": "create", "title": "Flight tracker", "kind": "html", "content": "<!doctype html>…"}
artifact {"action": "update", "id": "flight-tracker", "old_str": "<h1>Flights</h1>", "new_str": "<h1>Flights today</h1>"}
artifact {"action": "rewrite", "id": "flight-tracker", "content": "<!doctype html>…"}
```

There is no delete. An artifact is the user's to remove, from the Artifacts page,
where they are asked first. If they want one gone, say so and let them do it.

`create` chooses the id from the title and hands it back — that is what you
address it by from then on. Every answer that changed an artifact *starts* with
a `[artifact:…]` token, which is how Emma draws it in the transcript. Leave the
token where it is and do not repeat it in your own prose.

## update or rewrite

**`update` is the default.** It replaces one exact run of text, so the rest of
the artifact cannot drift while you are fixing four lines of it.

- `old_str` must appear **exactly once** and match **verbatim** — every space,
  every line break. If it appears twice, or not at all, the call fails and says
  so rather than editing the wrong place. Widen `old_str` with a line either
  side until it is unique.
- `get` first if you are not certain what is in there. Editing from memory is
  how a mismatch happens.
- **`rewrite`** when most of the artifact changes, when it is being restructured,
  or when three or four updates would be needed to say one thing.

## In a scheduled task

A task can read an artifact, do work, and write the result back into the same
one — so the user has one page that is always current rather than a new thread
to open every morning.

```
get the artifact → search, read, compute → update or rewrite it
```

A flight-tracker task, for instance: every morning it searches the web for the
fares it watches and rewrites the tracker artifact with what it found. The user
opens the same page and sees today's numbers. Say which artifact the task writes
to when you build it, and make the artifact first so the task has an id to name.

## The frame a page runs in

An `html` artifact is served under its own scheme and framed with
`sandbox="allow-scripts"` and this policy:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:
```

Which means, concretely:

- **No CDN, ever.** No Tailwind script tag, no React from unpkg, no
  `<link>` stylesheet. They fail silently and the page renders unstyled.
  Everything is inline: one `<style>`, one `<script>`.
- **No webfonts.** `font-src data:` — Geist, Inter and the rest are not there.
  Use the system UI font stack.
- **No images off the network.** `img-src data:` only. Draw with inline SVG
  instead of reaching for an image.
- **No fetch, no storage.** Opaque origin: `localStorage` throws. For an `html`
  artifact state lives in memory for the life of the frame, and data is baked
  into the file. An `app` is the kind that gets around this — with SQLite, not
  with storage.
- **No form submission.** The sandbox has no `allow-forms`, so a `<form>` never
  submits and its `submit` event never fires — the button does nothing at all,
  with nothing in the console. Use a plain `<button type="button">` and a
  `click` listener, and Enter-to-submit is a `keydown` on the input.

An `svg` artifact is framed with no script at all — `<script>` inside one is dead.

## An app and its database

An `app` is framed exactly as an `html` page is, and gets two more things.

**`emma.sql(statement, ...params)`** — one statement, returns a promise of rows.
It is already defined; do not write it, do not feature-detect it.

```js
await emma.sql("create table if not exists task (id integer primary key, body text, done integer default 0)");
await emma.sql("insert into task (body) values (?)", body);
const open = await emma.sql("select id, body from task where done = 0 order by id desc limit 50");
```

- Real SQLite in the artifact's own folder, and **only** that artifact's. It
  survives the frame, the thread, and the week. Deleting the artifact deletes it.
- **One statement per call.** A second one after a `;` is ignored, silently. Run
  the schema as several calls, from a `setup()` you await before the first read.
- **Always parameters, never a template string.** `?` is bound; `${}` is a bug.
- Rows are plain objects keyed by column, so name your columns. Writes return
  `[]` — use `insert … returning id` when you want the id back.
- Booleans go in as 0 and 1. `null` is `null`. Everything else is refused.
- A `select` over 2000 rows is refused: `limit`, or count in SQL.
- 16 MB of data. Past that a write fails with "database or disk is full".

**Files beside it** — `file` on `get`, `rewrite` and `update` addresses one:

```
artifact {"action": "create", "title": "Habits", "kind": "app", "content": "<!doctype html>…"}
artifact {"action": "rewrite", "id": "habits", "file": "app.js", "content": "…"}
artifact {"action": "update", "id": "habits", "file": "app.js", "old_str": "…", "new_str": "…"}
```

`<script src="app.js">` and `<link rel="stylesheet" href="style.css">` resolve to
them — the artifact's own host is in its policy, which is the one exception to
"everything inline". Flat names only, one of `js css json html svg txt md csv`,
at most 16 of them, 512 KB each. Split when the page is genuinely two things; a
200-line app is one file.

An app still starts on screen in the first 150px. Query on load, render what
came back, and leave the empty state saying what to type — not how it works.

The frame's backdrop is a warm off-white, so **artifacts are light**. Do not
build a dark mode or a theme toggle for one.

The card in the transcript clips to **150px**, the Artifacts page to 190px.
Whatever the artifact is *for* goes in that first 150px — a title bar and a
hero margin means every card looks identical.

## Writing Emma's own interface

**First, the fork in the road.** If the user wants something *new* in the
interface — a panel, a counter, a tracker, a small tool — that is the `component`
tool, not this. It builds into the context bar, hot-reloads while they watch, and
carries its own ⋯ to delete it. It is not an artifact and it never lands on the
Artifacts page.

What follows is the other thing: *replacing a whole built-in region*. Reach for it
only when the user says the sidebar, the conversation pane, the notch or the
context bar itself should be yours.

A `code` artifact with `surface` set **becomes that region of the app** — not a panel inside it, the region itself. The built-in
one stops rendering and yours runs in its place, in the app's own React tree, with
the app's own stylesheet and the same props the built-in was handed.

| `surface` | what you are replacing | it is handed |
| --- | --- | --- |
| `navbar` | the whole left sidebar | `view, setView, busy, threads, projects, agents, counts, threadId, openThread(id), newThread(), collapsed, setCollapsed(bool)` |
| `chat` | the conversation pane: transcript and composer | `thread, messages, busy, sending, send(text), stop(), streaming, mode, setMode` |
| `context` | the thread inspector on the right | `thread, messages, ledger, busy, sending, agents, subagents, subthreads, git, collapsed, setCollapsed(bool)` |
| `notch` | the island window | `turns, busy, error, stream, status, ask(text), open()` |

The module is plain JS — no build step, so **no JSX and no imports**. It default-
exports a factory that is handed everything it needs and returns the component:

```js
export default ({ h, useState, emma }) => ({ threads, threadId, openThread, newThread }) =>
  h("aside", { className: "sidebar" },
    h("button", { className: "new-thread", onClick: newThread }, "New thread"),
    h("nav", { className: "thread-list" }, threads.map((thread) =>
      h("button", {
        key: thread.id,
        className: thread.id === threadId ? "thread-row active" : "thread-row",
        onClick: () => openThread(thread.id),
      }, thread.title))));
```

```
artifact {"action": "create", "title": "My sidebar", "kind": "code", "language": "js", "surface": "navbar", "content": "export default …"}
artifact {"action": "update", "id": "my-sidebar", "old_str": "…", "new_str": "…"}
artifact {"action": "rewrite", "id": "my-sidebar", "surface": "none", "content": "…"}
```

**Every write reloads that region and nothing else.** No restart, no build: `update`
it four times while the user watches and they see four versions, with the rest of
the app untouched. That is the loop to work in — put something small in, then edit
it in front of them rather than writing a perfect one blind.

- The factory gets `{ h, Fragment, useState, useEffect, useMemo, useRef, useCallback, emma }`.
  `h` is React's `createElement`, the hooks are React's, and `emma` is the same
  bridge the app uses — `emma.request("snapshot", {})`, `emma.machineSample()`, and the rest.
- **You are inside the app, so use its CSS.** `className: "sidebar"` *is* the
  sidebar's styling. Read the app's classes off what you are replacing and reuse
  them; hand-rolled inline styles are what makes a region look bolted on. This is
  the opposite of a normal artifact: no light palette, no frame, no house style —
  the app's dark chrome is already yours.
- One module per region, and `surface` is **sticky**: an edit that does not mention
  it leaves the region where it is. `"none"` hands the region back to the built-in.
  Say `"none"` when the user is done rather than leaving your sidebar there forever.
- Only `code` mounts — nothing else runs.
- **Replacing means replacing.** Everything the built-in region did is gone unless
  you rebuild it. Before you take over the navbar, look at what is in it; a sidebar
  with no way to reach Artifacts or settings is a worse app than the one you
  started with. Keep the props you were handed wired to something.
- If it throws, or will not import, the built-in comes straight back with a line
  saying why. Nothing bricks — but a region that fails on load is invisible work,
  so check the app after a write rather than assuming it took.

## House style

Unless the user asks for something else, build to this. It is
[shadcn/ui](https://ui.shadcn.com)'s system, which is monochrome, hairline-bordered
and quiet — it reads as an instrument rather than a landing page, and it is
almost impossible to make ugly.

```css
:root {
  --canvas: #f5f5f5;   /* page background, secondary buttons */
  --paper:  #ffffff;   /* cards, popovers, filled surfaces */
  --alt:    #fafafa;   /* sidebars, subtle card variant */
  --ink:    #0a0a0a;   /* text, headings, icon strokes */
  --ink-2:  #171717;   /* filled button and badge backgrounds */
  --muted:  #737373;   /* helper text, placeholders, captions */
  --line:   #e5e5e5;   /* every border */
  --ember:  #e7000b;   /* destructive only */

  --font: ui-sans-serif, -apple-system, system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
}
```

The rules that make it hold together:

- **Achromatic by default.** Colour is absence, not expression. One hue,
  `--ember`, and it means *destructive* — never decoration, never branding.
  A chart is the one exception; it may carry its own restrained scale.
- **Radius is hierarchy.** 18px on everything interactive — buttons, inputs,
  badges — so they are true pills; 24px on containers. 6px only on things
  nested inside something already rounded. Nothing square, nothing in between.
- **Three surfaces, no dividers.** canvas → alt → paper. Layer by tone, and
  let the 1px `--line` do the edges. Cards get the hairline *and* a whisper of
  shadow, never shadow alone:
  `0 0 0 1px rgb(23 23 23 / .05), 0 1px 3px rgb(0 0 0 / .1), 0 1px 2px -1px rgb(0 0 0 / .1)`
- **Type is compact and tight.** 14px/1.43 body, 12px uppercase captions at
  `+0.05em`, headings 24–48px at weight 600 with tracking going *negative* as
  they grow (−0.025em at 24–30px, −0.05em at 48px). Never below 14px for body,
  never lighter than `--muted`.
- **4px base unit.** 4/8/12/16/20/24/48 and nothing off the grid. 20px card
  padding, 8px between elements, 48–80px between sections, 1280px max width.
- **No gradients, no coloured shadows, no glass.** Every surface is one solid
  tone.

A primary button is `--ink` on `--paper`, 14px/500, 18px radius, ~36px tall, no
shadow. The secondary is the same button filled `--canvas`. An input rests on
`--canvas` with no border and takes a 1px `--line` ring on focus.

## Two that came out well

**A tracker** — an `html` page. One `<h1>`, then the numbers, immediately: a
row of stat blocks, label in 12px uppercase `--muted` above a 36px/600 figure,
no card chrome around them, because the type scale alone is the hierarchy. The
rows below it are a plain table on `--paper` with `--line` between rows and the
header in the same 12px caption. The data is a `const` array at the top of the
inline script, so a scheduled task can rewrite that one array and leave the
whole page alone. Sorting and filtering are 15 lines of vanilla JS on the array;
no framework earns its keep at this size.

**A one-page brief** — a `markdown` artifact, because Emma renders markdown in
her own prose styles and an `html` version would only be a worse one. No CSS to
write at all: the design is the outline. A one-line summary at the top that
answers the question on its own, then sections that each hold one idea, then a
table where there is anything to compare. Links go inline. If it opens with
"Introduction", it is a document nobody reads.

The pattern under both: **decide what the artifact is for, put that in the first
screen, and let everything else be structure.** The failure mode is not ugliness,
it is a beautiful shell with the substance three scrolls down.

## Habits worth having

- Say in one line what you made and that it is on the Artifacts page. Do not
  paste the whole thing back into the reply — it is already in front of them.
- Keep the title in the user's words.
- Editing beats making another. Two artifacts with nearly the same content is
  the failure this tool invites.
