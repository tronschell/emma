# Design system

One visual language for every surface: the workspace window and the notch
surfaces (`.overlay`, `.island*`, `.orb`, `.radial`, `.notch-*`,
`.screen-annotation`, `.run-banner`) are drawn from the same tokens.

Tokens live in [`desktop/src/styles/tokens.css`](../desktop/src/styles/tokens.css).
Region stylesheets are plain CSS, imported in order from
[`desktop/src/index.css`](../desktop/src/index.css). No component library, no
theming abstraction. Do not hard-code a hex value that a token already names.

## Tokens

### Surfaces and ink

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#0e0e10` | The window. Most of the app sits here |
| `--surface` | `#131316` | Sidebar, panel |
| `--surface-2` | `#17171a` | Card, composer |
| `--surface-3` | `#1c1c20` | Hover |
| `--surface-4` | `#232327` | Active |
| `--chrome` | `var(--surface)` | Titlebar as-is; the sidebar mixes it to 35% over `vibrancy: "sidebar"` |
| `--text` | `#e8e6df` | Primary |
| `--text-2` | `#e8e6dfad` | Secondary, labels. 6.56:1 on `--surface-4` |
| `--text-3` | `#e8e6df8c` | Timestamps, captions. 4.80:1 on `--surface-4` — the floor |
| `--border` | `#e8e6df26` | The quiet grid |
| `--border-strong` | `#e8e6df47` | A region outline, or a band separator |
| `--solid` / `--solid-hover` / `--fg-invert` | `#e8e6df` / `#f4f2ec` / `#0e0e10` | Light-on-dark primary button pair |

Never put `--border` and `--border-strong` on the same edge.

### Palette

Seven hues, and only these seven. A hue must mean something — a
category, a series, a section, a state. If you cannot say what it signifies,
use `--text-2`.

| Token | Hex | Meaning |
| --- | --- | --- |
| `--orange` | `#ff6a3d` | The default accent |
| `--blue` | `#6faee6` | Links and references |
| `--rose` | `#ed7a9b` | Danger, destructive confirmation |
| `--teal` | `#3fd8c0` | Categorical |
| `--lime` | `#c3d64b` | Categorical |
| `--violet` | `#ae78f0` | Categorical |
| `--yellow` | `#e8c34a` | A state that is neither good nor bad yet |

`--accent` aliases `--orange` and `--danger` aliases `--rose`; Settings →
Appearance repoints `--accent` at another palette hue and everything derived
follows. `--accent-soft` is the accent at 14%. `--danger-surface` is `#2a1620`.
`--accent-2` is `oklch(from var(--accent) l c calc(h + 150))` — the accent's
own lightness and chroma at a rotated hue, so it stays a second colour against
whatever accent is set, a custom hex included. It marks a moment rather than a
state: the reveal a component wipes in behind ([components.md](components.md))
is the only thing that uses it.

The accent is for **action and state only**: primary action, active state,
focus ring, checked control, and literal quantities meant to be read as data.
When something is one of a set — chart series, source kinds, status classes —
give the set distinct hues in palette order instead of tinting all of them
with the accent.

Two deliberate exceptions: the vendor brand tints in `settings.css`, and the
screen-annotation pen, which is ink on the user's own wallpaper.

### Geometry, space, type

| Group | Tokens |
| --- | --- |
| Radii | `--r-sm` `--r-md` `--r-lg` `--r-xl` are all **`0`**. `--r-full` is `999px` and exists only for genuinely circular things |
| Space | `--s-1` 4 · `--s-2` 6 · `--s-3` 8 · `--s-4` 12 · `--s-5` 16 · `--s-6` 20 · `--s-7` 24 · `--s-8` 32. Nothing between steps |
| Type | `--fs-2xs` 10 · `--fs-xs` 11 · `--fs-sm` 12 · `--fs-md` 13 · `--fs-lg` 14 · `--fs-xl` 15 · `--fs-2xl` 17 · `--fs-3xl` 20 |
| Tracking | `--ls-caps` `.08em`, on uppercase labels only |
| Shadows | `--shadow-sm` `--shadow-md` `--shadow-lg`. Only surfaces that genuinely float cast one |
| Motion | `--t` — 120ms ease. Hover and focus only |
| Column | `--content-gutter` `clamp(12px, 3vw, 28px)` · `--content-column` `720px` (settings-wide overrides to 980px) |

Corners are square. The `--r-*` aliases stay so region files keep compiling;
new rules should simply omit `border-radius`.

### Fonts

| Token | Face | Use |
| --- | --- | --- |
| `--font-mono` | Departure Mono | The interface face: labels, values, nav, buttons, counts, table headers, IDs, timestamps — anything on the grid |
| `--font` | Inter | Prose read in sentences: message bodies, page copy, help text |
| `--font-code` | `ui-monospace` | Text that must survive being copied out |

## Structure: rules, not boxes

The app is drawn with sharp 1px lines on a grid.

- **A region is an outline, not a card.** `1px solid var(--border-strong)`, no
  fill, no shadow, square corners. Inside it, bands are separated by full-bleed
  `1px solid var(--border)`.
- **Rules are full-bleed.** A band's rule runs to the region's outline, not
  inset by the band's padding:
  `margin-inline: calc(var(--s-4) * -1); padding-inline: var(--s-4);`
  An inset rule looks like a mistake; a full-bleed rule looks like a terminal.
- **Fill means state, never grouping.** Background colour is hover, selection,
  active. To say "these belong together", use a rule or a shared edge.
- **Never stack outlines.** An outlined region may not contain another. If two
  things each need an outline, they are siblings.
- **Align to columns like a terminal.** `LABEL    value` is a two-column grid
  with the value on a fixed tab stop, not `space-between`.
- **Links are underlined.** In a chrome this flat, colour alone is not a signal.
- **Casing.** JSX string literals are sentence case; visual small caps come
  from `text-transform: uppercase` in the stylesheet.

## No walls of text

Emma's UI does not explain itself in paragraphs. A view shows the thing; it
does not narrate it. Where prose is genuinely unavoidable it goes behind the
`(i)` `InfoDot` (`desktop/src/icons.tsx`) — a `<details>` whose summary is a
single `i` — beside the heading it belongs to, not inline in the view.

## Layout

The shell is a two-column grid: `--sidebar-width` then content.

| Surface | Contract |
| --- | --- |
| Sidebar | One pane, 260px by default, user-resizable 200–340, 46px collapsed. `--row` 28px, `--pad` `--s-4`. Right edge is `--border-strong`; ground is `--chrome` at 35% over sidebar vibrancy |
| Content | Single centred column at `--content-column`, gutters `--content-gutter` |
| Messages | User turns right-aligned on `--surface-2`; assistant turns plain text flush left at `--fs-md`, no avatar, no card. Metadata is `--text-3` |
| Composer | Floats above the transcript bottom on `--surface-2` with `--shadow-lg` and a hairline that brightens on focus-within |
| Context bar | Floating card inset from the window edge, not a flush column |
| Settings | Full-content takeover with its own sub-nav grouped `Personal` / `Coding` / `Integrations` / `Emma` |

## The mark

`desktop/assets/emma.webp` (eyes open) and `emma-blink.webp` (shut), both
1800×1253 and trimmed to the ink — set a width and let the height follow.
`EmmaMark` in `desktop/src/icons.tsx` stacks both frames and crosses their
opacities on the same keyframe; fading the shut frame in is not enough, because
the open eyes show through its transparent pixels.

She appears in the setup flow, the quick-ask island and the settings header at
28px — the sidebar shows no wordmark, its first row is the search field. The
`blinks` class opens the cycle: `emma-open` / `emma-shut`, 7s, which is a human blink rate.
`prefers-reduced-motion` stops it through the global rule in `index.css` and
leaves her eyes open.

The app icon source is the Icon Composer document at
`desktop/assets/emma.icon`. `desktop/scripts/make-icons.mjs` rebuilds its bow
from the same pixel grid as `Mark`, flattens `emma.icns` for the supported
macOS 12 baseline and extracts `emma-dock.png` for unpackaged development runs.
Packaged releases intentionally ship the flattened ICNS instead of compiling
the macOS 26-only source document on the release runner. Rebuild all three after
editing the grid:

```
node desktop/scripts/make-icons.mjs
```

`Mark` in `desktop/src/icons.tsx` is the other one: a bow on a 16x16 pixel grid,
`#` for ribbon and `o` for the knot, which is the same colour at half opacity. It
is the empty-state glyph and the quick-ask pill, not the logo — Emma is the logo.
It draws in `currentColor`, so a context tints it rather than swapping the art:
`--lime` for a good state, `--orange` for a bad one, `--yellow` for one still in
the air. `mark-wiggle` tilts it 4 degrees off the knot and is opt-in per context;
a mark at rest holds still.

## Accessibility floor

- `:focus-visible` is `2px solid var(--accent)` at `2px` offset, on every
  interactive element.
- Body text never below `--fs-sm` (12px); metadata never below `--fs-2xs`
  (10px). These two steps do not move.
- Interactive targets keep a real hit area. Do not shrink a target below 24px
  to win space.
- Keep `.sr-only` labels and `aria-*` wiring intact; restyling must not delete
  one.

## Density

Emma is a dense tool people keep open all day. Reach for the next step **down**
before the next step up, and prefer removing a wrapper to padding it. If a
screen feels cramped, the fix is fewer elements — cut a label, drop a wrapper,
merge two rows — not more padding.

## Departure Mono glyph coverage

Measured against the face's own `M` (10.2px at 16px). Do not "fix" a glyph on
this list without re-measuring.

| | Glyphs |
| --- | --- |
| Real glyph | `⌥ ⌘ ↑ ← → ↓ · — – … × │ ─ ▪` |
| Falls back to the system font | `⌄ ⌃ ⇧ ＋ ◇ ◆ ▣ ⌁ ⌕ ▸ ▾ ▴ ✓ ● ○ ◦ ◈ ⊞ ⎋ ⏎ ⇥ ⌫` |

Shortcut copy uses `Option` and `Command` on macOS and `Alt` and `Ctrl` on
Windows; the Windows Quick Ask gesture is the physical left `Alt` key.

A fallback glyph has a different advance (9.6px vs 10.2px), so it breaks a
monospace column. In an aligned column prefer the first list or plain ASCII;
standalone and decorative, either is fine. `⌕` renders as a soft blob at chrome
sizes — use `/` for search.

Font licensing is in [credits.md](credits.md); vendor marks are in
[icon-sources.md](icon-sources.md).
