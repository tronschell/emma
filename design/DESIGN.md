---
version: alpha
name: Emma
description: A dense, dark, terminal-grade desktop chrome drawn with 1px rules on a square grid. Departure Mono for the interface, Inter for prose, one accent hue for action and state.
colors:
  bg: "#0e0e10"
  surface: "#131316"
  surface-2: "#17171a"
  surface-3: "#1c1c20"
  surface-4: "#232327"
  chrome: "{colors.surface}"
  text: "#e8e6df"
  text-2: "#e8e6dfad"
  text-3: "#e8e6df8c"
  border: "#e8e6df26"
  border-strong: "#e8e6df47"
  rose: "#ed7a9b"
  orange: "#ff6a3d"
  lime: "#c3d64b"
  yellow: "#e8c34a"
  teal: "#3fd8c0"
  blue: "#6faee6"
  violet: "#ae78f0"
  accent: "{colors.orange}"
  accent-soft: "color-mix(in srgb, #ff6a3d 14%, transparent)"
  danger: "{colors.rose}"
  danger-surface: "#2a1620"
  solid: "#e8e6df"
  solid-hover: "#f4f2ec"
  fg-invert: "#0e0e10"
  primary: "{colors.accent}"
  secondary: "{colors.text-2}"
  tertiary: "{colors.blue}"
  neutral: "{colors.bg}"
  on-surface: "{colors.text}"
  error: "{colors.danger}"
typography:
  display:
    fontFamily: Departure Mono
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.2
  title:
    fontFamily: Departure Mono
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.3
  subtitle:
    fontFamily: Departure Mono
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.3
  ui-md:
    fontFamily: Departure Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1
  ui-sm:
    fontFamily: Departure Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1
  label-md:
    fontFamily: Departure Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: 0.08em
  label-sm:
    fontFamily: Departure Mono
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: 0.08em
  label-xs:
    fontFamily: Departure Mono
    fontSize: 10px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: 0.08em
  body-md:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.6
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.55
  code:
    fontFamily: ui-monospace
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  none: 0px
  sm: 0px
  md: 0px
  lg: 0px
  xl: 0px
  full: 999px
spacing:
  base: 12px
  s-1: 4px
  s-2: 6px
  s-3: 8px
  s-4: 12px
  s-5: 16px
  s-6: 20px
  s-7: 24px
  s-8: 32px
  row: 28px
  titlebar: 46px
  sidebar: 260px
  sidebar-collapsed: 46px
  content-column: 720px
  content-column-wide: 980px
components:
  region:
    backgroundColor: transparent
    borderColor: "{colors.border-strong}"
    rounded: "{rounded.none}"
    padding: "{spacing.s-4}"
  band:
    backgroundColor: transparent
    borderColor: "{colors.border}"
    padding: "{spacing.s-4}"
  button:
    backgroundColor: transparent
    textColor: "{colors.text-2}"
    borderColor: "{colors.border}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.none}"
    padding: 0px 8px
    height: 28px
  button-hover:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.text}"
    borderColor: "{colors.border-strong}"
  button-disabled:
    textColor: "{colors.text-3}"
    borderColor: "{colors.border}"
  button-primary:
    backgroundColor: "{colors.solid}"
    textColor: "{colors.fg-invert}"
    borderColor: "{colors.solid}"
    typography: "{typography.label-sm}"
    padding: 0px 12px
    height: 28px
  button-primary-hover:
    backgroundColor: "{colors.solid-hover}"
    borderColor: "{colors.solid-hover}"
  button-accent:
    backgroundColor: transparent
    textColor: "{colors.accent}"
    borderColor: "color-mix(in srgb, #ff6a3d 55%, transparent)"
    typography: "{typography.label-sm}"
    padding: 0px 8px
    height: 28px
  button-accent-hover:
    backgroundColor: "{colors.accent-soft}"
    borderColor: "{colors.accent}"
  button-danger:
    backgroundColor: transparent
    textColor: "{colors.danger}"
    borderColor: "color-mix(in srgb, #ed7a9b 55%, transparent)"
    typography: "{typography.label-sm}"
    padding: 0px 8px
    height: 28px
  button-danger-hover:
    backgroundColor: "{colors.danger-surface}"
    borderColor: "{colors.danger}"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    typography: "{typography.ui-sm}"
    rounded: "{rounded.none}"
    padding: 6px 8px
    height: 28px
  input-focus:
    borderColor: "{colors.accent}"
  checkbox:
    backgroundColor: transparent
    borderColor: "{colors.border-strong}"
    rounded: "{rounded.none}"
    size: 16px
  checkbox-checked:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.fg-invert}"
    borderColor: "{colors.accent}"
  tag:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.text-3}"
    borderColor: transparent
    typography: "{typography.label-xs}"
    padding: 0px 4px
    height: 20px
  tag-hover:
    backgroundColor: "{colors.surface-4}"
    textColor: "{colors.text}"
  row:
    backgroundColor: transparent
    textColor: "{colors.text-2}"
    typography: "{typography.ui-sm}"
    padding: 0px 12px
    height: 28px
  row-hover:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.text}"
  row-active:
    backgroundColor: "{colors.surface-4}"
    textColor: "{colors.text}"
  section-label:
    textColor: "{colors.text-3}"
    typography: "{typography.label-xs}"
    borderColor: "{colors.border}"
    padding: 8px 12px 6px
  sidebar:
    backgroundColor: "color-mix(in srgb, #131316 35%, transparent)"
    borderColor: "{colors.border-strong}"
    width: 260px
  composer:
    backgroundColor: "{colors.bg}"
    borderColor: "{colors.border-strong}"
    rounded: "{rounded.none}"
    width: 720px
  composer-focus:
    borderColor: "{colors.text-3}"
  menu:
    backgroundColor: "{colors.surface-2}"
    borderColor: "{colors.border}"
    rounded: "{rounded.none}"
    padding: "{spacing.s-1}"
  titlebar:
    backgroundColor: "{colors.chrome}"
    height: 46px
  link:
    textColor: "{colors.blue}"
    typography: "{typography.body-md}"
  tag-experimental:
    backgroundColor: transparent
    textColor: "{colors.violet}"
    borderColor: "color-mix(in srgb, #ae78f0 45%, transparent)"
    typography: "{typography.label-xs}"
    padding: 0px 4px
    height: 18px
  status-pip:
    backgroundColor: "{colors.accent}"
    rounded: "{rounded.none}"
    size: 6px
  series-1:
    backgroundColor: "{colors.orange}"
    size: 6px
  series-2:
    backgroundColor: "{colors.blue}"
    size: 6px
  series-3:
    backgroundColor: "{colors.teal}"
    size: 6px
  series-4:
    backgroundColor: "{colors.violet}"
    size: 6px
  series-5:
    backgroundColor: "{colors.lime}"
    size: 6px
  series-6:
    backgroundColor: "{colors.yellow}"
    size: 6px
  series-7:
    backgroundColor: "{colors.rose}"
    size: 6px
  scrollbar-thumb:
    backgroundColor: "{colors.border-strong}"
    rounded: "{rounded.none}"
    width: 10px
  focus-ring:
    borderColor: "{colors.accent}"
    size: 2px
---

# Emma DESIGN.md

The normative values live in the front matter above and in
[`desktop/src/styles/tokens.css`](../desktop/src/styles/tokens.css), which is
their implementation. If the two disagree, the CSS is the bug or this file is —
fix one, never fork them. The prose below says why each value exists and how to
apply it. Longer implementation notes stay in
[`docs/design-system.md`](../docs/design-system.md).

## Overview

Emma is a macOS agent workspace someone keeps open all day, beside an editor and
a terminal. It should read as **instrument, not appliance**: a dense dark chrome
drawn with sharp 1px rules on a square grid, where every pixel of colour means
something and nothing decorates.

The reference points are a well-set terminal, an oscilloscope readout, and a
technical broadsheet — not a marketing page and not a chat app. The emotional
target is *quiet competence*: the UI never raises its voice, never explains
itself in paragraphs, and never animates to be liked.

Four commitments hold the whole system together, and every rule further down is
downstream of one of them:

1. **Lines, not boxes.** Structure comes from rules and shared edges. Fill is
   reserved for state.
2. **Square corners.** There are no rounded rectangles in this product.
3. **One accent.** Colour is action, state, or data. Never emphasis.
4. **Density is a feature.** Reach for the next step *down* before the next step
   up. If a screen feels cramped, remove an element — do not add padding.

The same tokens draw every surface: the workspace window and the notch surfaces
(`.overlay`, `.island*`, `.orb`, `.radial`, `.notch-*`, `.screen-annotation`,
`.run-banner`). One visual language, no per-surface theme.

## Colors

The ground is a warm-neutral near-black and the ink is a single warm off-white.
Warmth on both ends is deliberate: a cool grey chrome reads as a system dialog,
and Emma is meant to read as paper under a lamp.

### Ground

- **Paper (`#0e0e10`)** — the window itself. Most of the app sits here.
- **Surface (`#131316`)** — sidebar and panel ground, and the value `--chrome`
  aliases.
- **Surface 2 (`#17171a`)** — cards, the composer, menu ground.
- **Surface 3 (`#1c1c20`)** — hover.
- **Surface 4 (`#232327`)** — active and selected.

The four steps exist for *elevation only*. They are not a grouping device: two
things do not belong together because they share a fill, they belong together
because a rule or an edge says so.

### Ink

One off-white at three opacities, so each step composites correctly over any
ground instead of drifting cool on the dark ones.

- **Text (`#e8e6df`)** — primary.
- **Text 2 (`#e8e6dfad`)** — secondary, labels. 6.56:1 on `surface-4`.
- **Text 3 (`#e8e6df8c`)** — timestamps, captions, disabled. 4.80:1 on
  `surface-4` — the floor. Do not thin it further.

Contrast is verified against `surface-4`, the lightest ground in the product, so
a passing pair passes everywhere.

### Rules

- **Border (`#e8e6df26`)** — the quiet grid: band separators, table rules,
  input edges.
- **Border strong (`#e8e6df47`)** — a region outline, a window-edge boundary, a
  band separator inside an outlined region.

Never put both on the same edge. Doubling them reads as a rendering artefact.

### The categorical palette

Seven hues, and only these seven. A hue must *signify* — a category, a chart
series, a section, a status class. If you cannot say what it signifies, use
`text-2`.

| Token | Hex | Meaning |
| --- | --- | --- |
| `orange` | `#ff6a3d` | The default accent |
| `blue` | `#6faee6` | Links and references |
| `rose` | `#ed7a9b` | Danger, destructive confirmation |
| `teal` | `#3fd8c0` | Categorical |
| `lime` | `#c3d64b` | Categorical, "good" state |
| `violet` | `#ae78f0` | Categorical, experimental |
| `yellow` | `#e8c34a` | A state that is neither good nor bad yet |

Every one clears AA as text on every surface. Adding an eighth is a design
decision, not a convenience.

### The accent

`accent` aliases `orange`; `danger` aliases `rose`. Settings → Appearance
repoints `accent` at another palette hue and everything derived from it follows,
so **never hard-code `#ff6a3d`** — use the token.

The accent is for **action and state only**: the primary action, the active
state, the focus ring, a checked control, and any literal quantity meant to be
read as data. When something is one of a *set* — chart series, source kinds,
status classes — give the set distinct hues in palette order instead of tinting
all of them accent.

`accent-soft` is the accent at 14% and is the only accent fill that touches a
large area.

The spec's conventional names are provided as aliases — `primary` → `accent`,
`secondary` → `text-2`, `tertiary` → `blue`, `neutral` → `bg`, `on-surface` →
`text`, `error` → `danger` — so a tool that expects them resolves. Emma's own
code uses the concrete names.

Two deliberate exceptions to the palette: vendor brand tints in `settings.css`
(a brand mark must be its own colour), and the screen-annotation pen, which is
ink on the user's own wallpaper.

## Typography

Two faces, split by *what the text is*, not by hierarchy level.

- **Departure Mono** is the interface face — labels, values, navigation,
  buttons, counts, table headers, IDs, timestamps. Anything that sits on the
  grid. It is a pixel face, so it holds a column and reads as instrumentation.
- **Inter** is for prose read in sentences: message bodies, page copy, help
  text. Nothing structural.
- **`ui-monospace`** is for text that must survive being copied out — code
  blocks, paths, diffs, terminal output.

Hierarchy comes from **rules, case, and colour — not from size.** The scale tops
out at 20px, only 7px above body text, because a heading here is a label, not a
billboard. Weight is 400 almost everywhere; 500 appears only inside rendered
markdown headings.

Uppercase small-caps labels carry `0.08em` tracking (`--ls-caps`) so the caps do
not collide. Never track sentence-case text.

Casing: JSX string literals are written in sentence case; visual small caps come
from `text-transform: uppercase` in the stylesheet. That way the accessible name
is readable and the visual treatment stays a style decision.

Floors that do not move: body text never below 12px, metadata never below 10px.

Departure Mono's glyph coverage is partial. In an aligned column use only glyphs
the face actually carries (`⌥ ⌘ ↑ ← → ↓ · — – … × │ ─ ▪`) or plain ASCII — a
fallback glyph has a 9.6px advance against the face's 10.2px and silently breaks
the column. The full measured table is in
[`docs/design-system.md`](../docs/design-system.md).

## Layout

The shell is a two-column grid: `sidebar` then content.

| Surface | Contract |
| --- | --- |
| Titlebar | 46px, `chrome` as-is, macOS traffic lights reserved to 117px |
| Sidebar | One pane, 260px default, user-resizable 200–340, 46px collapsed. Row 28px, pad 12px. Right edge `border-strong`; ground is `chrome` at 35% over `vibrancy: "sidebar"` |
| Content | Single centred column at 720px (settings-wide overrides to 980px), gutters `clamp(12px, 3vw, 28px)` |
| Messages | User turns right-aligned on `surface-2`; assistant turns are plain text flush left at 13px — no avatar, no card, no bubble. Metadata is `text-3` |
| Composer | Floats above the transcript bottom on `surface-2` with `shadow-lg` and a hairline that brightens on focus-within |
| Context bar | Floating card inset from the window edge, not a flush column |
| Settings | Full-content takeover with its own sub-nav grouped Personal / Coding / Integrations / Emma |

Spacing is an eight-step scale (4, 6, 8, 12, 16, 20, 24, 32). Nothing between
steps. 12px is the default padding for a band or a row; 32px is the largest gap
that should appear anywhere in the chrome.

Four structural rules make the grid work:

- **A region is an outline, not a card.** `1px solid border-strong`, no fill, no
  shadow, square corners. Bands inside it are separated by full-bleed `1px solid
  border`.
- **Rules are full-bleed.** A band's rule runs to the region's outline, not
  inset by the band's padding
  (`margin-inline: calc(var(--s-4) * -1); padding-inline: var(--s-4);`). An
  inset rule looks like a mistake; a full-bleed rule looks like a terminal.
- **Never stack outlines.** An outlined region may not contain another. If two
  things each need an outline, they are siblings.
- **Align to columns like a terminal.** `LABEL⇥value` is a two-column grid with
  the value on a fixed tab stop — not `space-between`.

Prose columns cap at 72ch even inside the 720px column.

## Elevation & Depth

Depth is carried by **rules and ground steps**, not by shadows. On-page regions
sit flat on the paper and are separated by lines; they cast nothing.

| Level | Treatment | Where |
| --- | --- | --- |
| 0 | `bg`, no border | The window |
| 1 | `surface` / `surface-2` ground or a `border` rule | Panels, bands, rows |
| 2 | `border-strong` outline | An addressable region |
| 3 | `surface-2` + `shadow-md` | Menus, popovers |
| 4 | `surface-2` + `shadow-lg` | The composer, floating overlays, the notch surfaces |

Only a surface that genuinely floats above the page casts a shadow. Shadows are
pure black at high alpha (`0 1px 2px #0006`, `0 8px 24px #0007`,
`0 24px 60px #000b`), never coloured and never used to imply a card.

Translucency is deliberately confined to one pane: the sidebar mixes `chrome`
down to 35% over macOS `vibrancy: "sidebar"`. Whole-window translucency was
tried and abandoned — it ends in a hard blurred edge at the window boundary. One
pane of glass against opaque content does not.

## Shapes

**Corners are square.** `rounded.sm` through `rounded.xl` are all `0`. A rounded
corner breaks the grid and reads as a different product. The `--r-*` aliases
survive only so existing region files keep compiling; new rules should simply
omit `border-radius`.

`rounded.full` (`999px`) exists for things that are genuinely circular — an
avatar, a range thumb. It is not an escape hatch for a pill button.

Shapes that would normally be round are drawn as cells instead: the status pip
is a 6px filled square (a 6px circle renders as a lumpy blob on a 2x pixel
grid), and the checkbox tick is the rotated bottom-right corner of a box — no
glyph, no image.

## Components

Component tokens are in the front matter. This section is the intent behind
them. Note that `borderColor` is used throughout: it is not in the spec's
property list, but in a system drawn with lines it is as load-bearing as
`backgroundColor`.

### Buttons

A button is **a label inside an outline, never a filled pill**: mono, small
caps, tracked, transparent ground, `1px solid border`. The fill arrives on hover
(`surface-3`) and the border firms to `border-strong`. Height is 26–28px;
padding is `0 8px` or `0 12px`.

- `button` — the default everywhere.
- `button-primary` — light-on-dark (`solid` ground, `fg-invert` text). At most
  one per view, and only for the action the view exists to perform.
- `button-accent` — accent text on an accent-at-55% outline, filling to
  `accent-soft` on hover. For a call to action inside a region that already owns
  a primary.
- `button-danger` — same construction on `danger`, filling to `danger-surface`.
  Destructive actions only, and never the default focus of a dialog.

Disabled is `opacity: .45` plus `cursor: default`, applied globally — do not
re-style a disabled button per region.

### Inputs

Text fields draw their own `1px solid border` box on `bg` ground. On focus the
**border** becomes the accent and the outline ring is suppressed — a ring around
a field is a box around a box, and every autofocused field would open wearing
one. The caret plus the coloured edge is the signal.

Every other focusable thing gets `2px solid accent` at `2px` offset. That rule is
global and matches `:focus-visible` on everything, including `<summary>` and
`tabindex="-1"` popovers; a region that needs a different offset overrides it
with one class.

### Controls

Checkbox, range, and file inputs are defined once globally so no region can ship
a stock Aqua widget. The checkbox is a 16px square with a `border-strong` edge,
filling to `accent` when checked. Range uses `accent-color`.

Scrollbars are chrome like everything else: a 10px track that paints nothing and
a square `border-strong` thumb inset 3px, brightening to `text-3` on hover. No
floating grey pill.

### Rows, tags, and labels

- **Row** — 28px tall, 12px inline padding, `text-2` mono at 12px. Hover is
  `surface-3`, active is `surface-4`. This is the sidebar item, the menu item,
  and the list item; they are the same object.
- **Section label** — 10px mono small caps in `text-3` with a `border` rule
  under it. This is how a group is named, and it replaces a card header.
- **Tag** — 20px `surface-3` chip, 10px mono small caps, transparent border. A
  tag with no value drops its fill and shows a dashed `border` outline instead;
  an auto-assigned tag keeps the dashed edge.

### Data and status

- **Series** — `series-1` through `series-7` are the palette in order, and they
  are the only way to colour a set. A chart, a legend, a source-kind key, and a
  status class all draw from the same sequence, so the same hue means the same
  ordinal position everywhere. Never restart the sequence at a different hue to
  "match" a view.
- **Status pip** — a 6px filled square, accent by default, tinted per state. It
  is the shape of an empty `<i />` and nothing else; an `<i>` with text in it is
  a count or a delta, and painting a square over the glyph turns it into tofu.
- **Link** — `blue`, underlined. The underline is not optional.
- **Experimental tag** — `violet` text on a violet-at-45% outline, 10px small
  caps. This is the one badge that is allowed to be its own hue.

### Menus and overlays

Menus are `surface-2` with a `border` outline, 4px padding, `shadow-md`, and
30px rows. They are positioned `fixed` under a full-viewport scrim so they
escape scroll containers.

The notch surfaces (island, orb, radial, run banner) use level 4 and the same
tokens as the window. They are not a separate theme.

## Do's and Don'ts

**Do**

- Do use a token. If you are typing a hex value, you are almost certainly
  wrong — `tokens.css` already names it.
- Do separate things with a rule or a shared edge.
- Do reserve the accent for action, state, and data.
- Do give a set of things distinct palette hues in palette order.
- Do reach for the next step *down* on the spacing and type scales.
- Do keep `text-transform: uppercase` in CSS and sentence case in the string.
- Do underline links — in a chrome this flat, colour alone is not a signal.
- Do keep interactive targets at 24px or larger, even when space is tight.
- Do keep `.sr-only` labels and `aria-*` wiring intact through any restyle.

**Don't**

- Don't add a `border-radius`. There are no rounded rectangles.
- Don't use fill to group. Fill is hover, selection, and active — nothing else.
- Don't put `border` and `border-strong` on the same edge.
- Don't nest one outlined region inside another.
- Don't add a shadow to something that does not float.
- Don't inset a band's rule by its own padding.
- Don't tint a whole set of things with the accent to make them look related.
- Don't write a paragraph in the UI. A view shows the thing; it does not narrate
  it. Where prose is unavoidable it goes behind the `(i)` `InfoDot` beside the
  heading it belongs to.
- Don't drop body text below 12px or metadata below 10px.
- Don't use a Departure Mono fallback glyph inside an aligned column.
- Don't animate anything but hover and focus.

## Motion

One duration token: `120ms ease`. It applies to hover and focus transitions and
nothing else. There are no entrance animations, no easing curves per component,
no spring physics, no skeleton shimmer.

The two exceptions are both identity, not feedback: Emma's 7s blink cycle (a
human blink rate) and the opt-in `mark-wiggle`, a 4-degree tilt on the bow. A
mark at rest holds still.

`prefers-reduced-motion: reduce` kills every transition and animation globally
through one rule in `index.css`, and leaves Emma's eyes open. Never re-enable
motion past it.

## Iconography & The Mark

Emma herself is the logo: `desktop/assets/emma.webp` (eyes open) and
`emma-blink.webp` (shut), both 1800×1253 and trimmed to the ink — set a width
and let the height follow. `EmmaMark` stacks both frames and crosses their
opacities on the same keyframe. She appears at 28px in the setup flow, the
quick-ask island, and the settings header. The sidebar shows no wordmark; its
first row is the search field.

`Mark` is the other one: a bow on a 16×16 pixel grid, drawn in `currentColor` so
a context tints it rather than swapping the art — `lime` for a good state,
`orange` for a bad one, `yellow` for one still in the air. It is the empty-state
glyph and the quick-ask pill, not the logo.

Vendor brand marks arrive as `<img>` with their fill baked into the asset (white
where the brand mark is black, the real brand colour where it is not), fitted to
their own viewBox and padded 2px absolute. Never apply a blanket CSS filter to
them — it flattens the ones that are meant to be coloured.

The app icon is Emma on a macOS squircle. A bundle icon cannot follow system
appearance, so `dockIcon()` repaints the Dock tile on `nativeTheme` "updated"
while Finder keeps the dark tile.

## Accessibility Floor

These are not guidelines; they are the floor.

- Every interactive element has a visible `:focus-visible` treatment — `2px
  solid accent` at `2px` offset, or the accent border on a text field.
- `text-3` (4.80:1 on the lightest ground) is the lightest ink that may carry
  information. Anything below it is decoration and must be redundant.
- Body text ≥ 12px, metadata ≥ 10px.
- Interactive targets keep a real hit area; do not shrink one below 24px to win
  space.
- `prefers-reduced-motion` is honoured globally.
- Colour is never the only carrier of meaning — a status hue is paired with a
  glyph, a label, or a position.
- A skip link is the first focusable element, and it sits below the 46px
  titlebar so it does not cover the traffic lights.

## Implementation

Tokens are plain CSS custom properties on `:root` in
[`desktop/src/styles/tokens.css`](../desktop/src/styles/tokens.css). Region
stylesheets are plain CSS, imported in order from
[`desktop/src/index.css`](../desktop/src/index.css). There is no component
library and no theming abstraction — the cascade is the abstraction.

To consume this file outside the app, the token block maps directly:

```css
:root {
  --bg: #0e0e10;
  --text: #e8e6df;
  --border: #e8e6df26;
  --border-strong: #e8e6df47;
  --accent: #ff6a3d;
  --font-mono: "Departure Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --font: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --s-4: 12px;
  --fs-md: 13px;
  --ls-caps: .08em;
  --t: 120ms ease;
}
```

```js
export default {
  theme: {
    borderRadius: { none: "0", full: "999px" },
    extend: {
      colors: {
        bg: "#0e0e10",
        surface: { DEFAULT: "#131316", 2: "#17171a", 3: "#1c1c20", 4: "#232327" },
        ink: { DEFAULT: "#e8e6df", 2: "#e8e6dfad", 3: "#e8e6df8c" },
        rule: { DEFAULT: "#e8e6df26", strong: "#e8e6df47" },
        accent: "#ff6a3d",
      },
      fontFamily: { mono: ["Departure Mono", "ui-monospace"], sans: ["Inter"] },
      fontSize: { "2xs": "10px", xs: "11px", sm: "12px", md: "13px", lg: "14px" },
      spacing: { 1: "4px", 2: "6px", 3: "8px", 4: "12px", 5: "16px", 6: "20px", 7: "24px", 8: "32px" },
    },
  },
}
```

Validate changes with the reference linter:

```
npx @google/design.md lint design/DESIGN.md
```

It reports zero errors and 23 warnings, all of them `borderColor` on a
component. That property is not in the spec's sub-token list, which covers fill,
ink, type, radius, and size but not the edge. Emma is drawn with edges, so the
warnings are the correct output — do not silence them by deleting the property.
