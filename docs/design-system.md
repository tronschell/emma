# Emma design system

One language for every surface Emma paints: the workspace window, and equally
the notch surfaces (`.overlay`, `.island*`, `.orb`, `.radial`, `.notch-*`,
`.screen-annotation`, `.run-banner`). The notch used to be its own product —
soft glass, 20px radii, a yellow accent, a rainbow aura — and is now drawn from
the same tokens and the same rules as everything else. This file is the
contract.

## Non-goals

- Do not invent hues. The six in "Palette" below are the whole set; adding a
  seventh is a design decision, not a convenience.
- Do not add a CSS framework, a component library, or a theming abstraction.
  Tokens in `src/styles/tokens.css`, plain CSS in region files. That is all.

## What is wrong today

1. **Type is microscopic.** 7px Departure Mono eyebrows on nearly every block,
   8-10px body copy. It reads as a demo, not an app. The reference layout uses
   13-15px UI text and reserves small caps for genuine metadata.
2. **Everything is an eyebrow.** `WORKSPACE`, `THREAD / A1B2C3D4`,
   `SETTINGS / LOCAL TO THIS MAC`, `ORDERED BLOCKS`. Keep at most one per view.
3. **Two navigation panes.** A 188px rail plus a 246px list eats 434px before
   content starts. Merge into one sidebar.
4. **Hard 1px `#292a26` borders everywhere.** Separation should come from
   surface elevation, not grid lines.
5. **Cramped rows next to sprawling pages.** Interactive rows ran 5-9px pad with
   no min-height while page chrome ran 24-32px gutters. Rows want 4-8px pad and
   a 28-32px min height; pages want to come *down* the spacing scale, not up.
   See "Density" — dense is the goal, cramped targets are not.

## Tokens

Defined in `src/styles/tokens.css`. Use them; do not hard-code new hex values.

Surfaces stack: `--bg` (window) → `--surface` (sidebar/panel) →
`--surface-2` (card/composer) → `--surface-3` (hover) → `--surface-4` (active).

Text: `--text` (primary) → `--text-2` (secondary/label) → `--text-3` (tertiary,
timestamps and captions only).

Borders are alpha whites (`--border`, `--border-strong`) so they work over any
surface. `--accent` is the green; it is for live status, focus rings, and the
one primary action per view. `--fg-invert`/`--solid` are the light-on-dark
primary button pair.

Radii: `--r-sm` 6, `--r-md` 10, `--r-lg` 14, `--r-xl` 20, `--r-full`.
Space scale: `--s-1` 4 through `--s-8` 40. Nothing between steps.
Type: `--fs-2xs` 10 … `--fs-3xl` 28, with `--font-mono` reserved for metadata.

## Layout

Reference is the Codex desktop layout, rendered in Emma's palette.

```
┌──────────── 40px titlebar (drag region, centered title) ────────────┐
│ sidebar 260px │            content column             │ context 300 │
│               │                                       │  (floating) │
│  brand ⌄  ⌕ ⚙ │   ┌─ scroll ──────────────────────┐   │ ┌─────────┐ │
│  New thread   │   │  centred 720px transcript     │   │ │ card    │ │
│  Threads      │   │  user msg  → right pill       │   │ │ sections│ │
│  Knowledge    │   │  emma msg  → flush left       │   │ └─────────┘ │
│  Agent        │   └───────────────────────────────┘   │             │
│  Scheduled    │   ┌─ composer, floating, r-xl ────┐   │             │
│  ─ PROJECTS ─ │   │  textarea                     │   │             │
│  ▸ base name  │   │  ＋  model ⌄        🎙  ( ↑ )  │   │             │
│     thread    │   └───────────────────────────────┘   │             │
│  ─────────────│                                       │             │
│  ● agent · ⌥⌥ │                                       │             │
└─────────────────────────────────────────────────────────────────────┘
```

Rules:

- **Sidebar** is one pane. Top: brand row with a disclosure chevron and icon
  buttons. Then primary nav rows (icon, label, count) at 32px min-height,
  `--r-md`, active state = `--surface-3` fill, no left bar. Then a `PROJECTS`
  section label, then knowledge bases as collapsible groups with their threads
  nested one indent level under them. Bottom: a persistent status row.
- **Content** is a single centred column, `max-width: 760px`, gutters
  `clamp(16px, 4vw, 40px)`. No header border; the view title sits inline.
- **Messages**: user turns are right-aligned pills on `--surface-2` with
  `--r-lg`; assistant turns are plain text flush left at `--fs-md`, no avatar
  box, no card. Role/time metadata is `--text-3` and only appears on hover for
  user turns.
- **Composer** floats above the transcript bottom with `--r-xl`, `--surface-2`,
  `--shadow-lg`, and a hairline `--border` that brightens on focus-within. The
  tool row sits inside it. Send is a 32px circle.
- **Context panel** is a floating rounded card inset from the window edge
  (`margin: var(--s-4)`), `--surface` on `--r-lg`, not a flush column with a
  left border. Sections are label + rows, no dividers between every row.
- **Settings** is a full-content takeover: its own left sub-nav (grouped by
  `Personal` / `Integrations` / `Coding`) and a right column of setting rows.
  Each row is title + one-line description on the left, control on the right,
  grouped into `--surface` cards with `--r-lg`.
- **Popovers and dialogs** use `--surface-2`, `--r-lg`, `--shadow-lg`, and 12px
  internal padding. Menu rows are 34px, icon + label + optional description.

## The mark

Emma's logo is the drawn window with the bow: `desktop/assets/emma.webp` with
her eyes open, `desktop/assets/emma-blink.webp` with them shut. Both are trimmed
to the ink — the drawing arrived on a 2048² canvas that was mostly empty margin,
and any margin left in the file becomes padding baked into every box she sits
in. They are 1800×1253, so a caller sets a width and lets the height follow.

`EmmaMark` in `desktop/src/icons.tsx` stacks the two frames in one box and cuts
between their opacities on the same keyframe. Both frames are transparent, so
fading the shut one in over the open one is not enough — the open eyes show
straight through the shut frame's empty pixels, and she reads as never blinking
at all. The open frame has to go to zero in the same step. Swapping `src`
instead of stacking would refetch and leave a gap on the first blink of a
session, before the second frame has decoded. She is static by default; the
`blinks` class is what opens the cycle.

She appears once, in the sidebar brand band at 28px beside the wordmark, and she
blinks there. One mark in one place: a second copy floating in a corner reads as
a stray element rather than as a logo.

The `◇` tile (`.mark`) is unrelated — it is the empty-state and waiting glyph,
not the logo.

## Motion

One transition token, `--t` (120ms ease). Hover and focus only. No entrance
animations, no transforms on scroll.

The one exception is Emma's blink: roughly 140ms shut once every 7 seconds,
which is a human blink rate rather than a strobe. It is an opacity crossfade on
a decorative image, so `prefers-reduced-motion` stops it through the global rule
in `index.css` and simply leaves her eyes open.

## Accessibility floor

Focus-visible ring stays `2px solid var(--accent)` with `2px` offset on every
interactive element. Body text never drops below 12px. Metadata never below
10px. Keep `.sr-only` labels and existing `aria-*` wiring intact — restyling
must not delete a single one.

## Wave 2 contract (markup ↔ stylesheet split)

Wave 2 runs one markup agent (sole owner of `desktop/src/App.tsx`,
`desktop/src/AgentView.tsx`, `desktop/src/layout.ts`) alongside three
stylesheet agents (one each for `conversation.css`, `panels.css`, and
`sidebar.css` + `settings.css`). Nobody edits a file they do not own.

The markup agent guarantees these class names exist so the stylesheet agents
can target them without seeing the diff:

- `.composer-row` — the flex row holding `.composer-tools` and the send
  button. Replaces the `.composer > div:not(.composer-attachment)` selector.
- `.sidebar-search` — wrapper around a single `<input type="search">` that
  filters the projects tree, placed between `.new-thread` and
  `.sidebar-projects`.
- `.provider-mark-text` — wraps the `<strong>` + `<small>` pair inside each
  `.provider-marks` entry.
- `.page-title-row` — wraps the page title textarea and `.page-category`
  controls in the knowledge page editor.

And guarantees these are gone: `.brand-chevron`, the hard-coded `60D` and `5`
nav badges, the `.artifact-heading` "ORDERED BLOCKS" eyebrow, the per-row
eyebrow `<span>`s in the settings rows, and the titlebar's duplicate
`HOST CONNECTED` pill (sidebar footer keeps the single liveness indicator).

Casing rule: JSX string literals are written in sentence case. Where the
design calls for visual small-caps, the stylesheet applies
`text-transform: uppercase` — never bake the caps into the string.

## Structure: rules, not boxes

The app is drawn with sharp 1px lines on a grid. Nothing is rounded — there is
no radius token for a rectangle because there are no rounded rectangles. A
corner radius breaks the grid and immediately reads as a different product.

**A region is an outline, not a card.** `1px solid var(--border-strong)`, no
fill, no shadow, square corners. Inside it, bands are separated by full-bleed
`1px solid var(--border)` rules. The canonical composition is:

```
┌──────────────────────────────────────┐
│ HEADER LABEL                     1/5 │  <- header band, rule below
├──────────────────────────────────────┤
│ body                                 │  <- content band
├──────────────────────────────────────┤
│ PRIMARY ACTION                       │  <- action band, rule above
├──────────────────────────────────────┤
│ id                       metadata    │  <- footer band
└──────────────────────────────────────┘
```

**Rules must be full-bleed.** A band's rule runs to the region's outline, not
inset by the band's padding. In practice: negative inline margins equal to the
padding, then re-pad inside. An inset rule looks like a mistake; a full-bleed
rule looks like a terminal.

```css
.band { margin-inline: calc(var(--s-4) * -1); padding-inline: var(--s-4); border-bottom: 1px solid var(--border); }
```

**Fill means state, never grouping.** A background colour is reserved for
hover, selection, and active. If you are filling something to say "these belong
together", use a rule or a shared left edge instead.

**Never stack outlines.** One outlined region may not contain another. Inside a
region you get rules and space, nothing else. If two things each need an
outline, they are siblings.

**Align to columns like a terminal.** `LABEL    value` is a two-column grid with
the value on a fixed tab stop, so every row's values line up vertically. It is
not `space-between` — that flings the value to the far edge and leaves a
different gap in every row.

**Mono is the interface face.** Labels, values, nav, buttons, counts, table
headers, IDs, timestamps — anything sitting on the grid — is `--font-mono`.
Small-caps labels get `text-transform: uppercase` plus `letter-spacing:
var(--ls-caps)`. `--font` (Inter) is only for prose the user reads in
sentences: message bodies, page copy, help text. `--font-code` is for text that
must survive being copied out.

**Links are underlined.** In a chrome this flat, colour alone is not enough of
a signal.

### Departure Mono glyph coverage

Measured, not guessed — advance width against the face's own `M` (10.2px at
16px). Do not "fix" a glyph on this list without re-measuring.

- **Has a real glyph:** `⌥ ⌘ ↑ ← → ↓ · — – … × │ ─ ▪`
- **Falls back to the system font:** `⌄ ⌃ ⇧ ＋ ◇ ◆ ▣ ⌁ ⌕ ▸ ▾ ▴ ✓ ● ○ ◦ ◈ ⊞ ⎋ ⏎ ⇥ ⌫`

Fallback is not a bug — the reference site mixes the same way, and the
geometric shapes are legible. But a fallback glyph has a different advance
(9.6px vs 10.2px), so it breaks a monospace column. Where a glyph sits in an
aligned column, prefer one from the first list or a plain ASCII character;
where it is decorative and standalone, either list is fine.

`⌕` is the one to avoid outright: it renders as a soft blob at chrome sizes.
Use `/` for search.

## Palette

The ground is warm-neutral near-black (`--bg` → `--surface-4`) and carries no
hue of its own. Ink is one warm off-white at three opacities so every step
composites correctly over any surface; all three clear WCAG AA 4.5:1 against
every surface including `--surface-4`.

Colour comes from six categorical hues, and only from them:

| token | hex | meaning |
| --- | --- | --- |
| `--orange` | `#ff6a3d` | the accent: primary action, active state, focus ring, checked control, and literal quantities meant to be read as data |
| `--blue` | `#6faee6` | links and references — anything that navigates |
| `--rose` | `#ed7a9b` | danger, destructive confirmation |
| `--teal` | `#3fd8c0` | categorical |
| `--lime` | `#c3d64b` | categorical |
| `--violet` | `#ae78f0` | categorical |

`--accent` and `--danger` are aliases of `--orange` and `--rose`; use the
semantic name when you mean the role and the hue name when you mean the
category.

**Use the whole palette, not one hue everywhere.** The previous pass aliased
`--accent` to a single colour and then reached for `--accent` for every
coloured thing on screen, so the app came out monochrome-purple. When something
is one of a set — chart series, knowledge categories, satellite planes, source
kinds, status classes — give the set distinct hues in palette order rather than
tinting all of them with the accent. The accent is for *action and state
only*.

**A hue must still mean something** — a category, a series, a section, a state.
It never decorates. If you cannot say what a hue signifies, use `--text-2`.
Adding a seventh is a design decision, not a convenience.

One deliberate exception: the vendor brand tints in `settings.css` (Codex,
Claude, Cursor and friends own those colours, not us). The screen-annotation pen
is the other off-palette colour, and it is ink the user draws on their own
wallpaper rather than chrome — a highlighter has to be yellow.

## Density

Emma is a dense tool that people keep open all day, not a marketing page. When
choosing a spacing or type step, reach for the next step **down** before the
next step up, and prefer removing a wrapper to padding it.

The spacing scale is deliberately tight (`--s-2` is 6px, `--s-8` is 32px).
Density comes out of the top of the type scale, where the sprawl was — the
bottom three steps are the accessibility floor and do not move:

- body text never below `--fs-sm` (12px)
- metadata never below `--fs-2xs` (10px)

The previous design failed in the other direction — 7px type everywhere — so
tightening must never resume that. If a screen feels cramped, the fix is fewer
elements, not more padding: cut an eyebrow, drop a wrapper, merge two rows.

Interactive targets keep a real hit area regardless of density. Controls sized
by explicit height (30–32px rows) stay that way; do not shrink a target below
24px to win space.
