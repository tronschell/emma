# The notch

Quick Ask: one macOS island that opens under the camera housing, or a Windows
pill near the top of the display, on top of whatever you were doing. Main-process geometry is
[`desktop/main/overlay.ts`](../desktop/main/overlay.ts), the windows are in
[`desktop/main/main.ts`](../desktop/main/main.ts), and every surface is the same
renderer bundle picking a component off its query string
([`desktop/src/App.tsx`](../desktop/src/App.tsx)).

## Opening it

On macOS, double-tap the **left** Option key. macOS reports a bare modifier only
to a trusted app, so this is an event tap in `emma-option-tap`, built with clang
from [`desktop/native/quick_ask.m`](../desktop/native/quick_ask.m). On Windows,
double-tap the **left** Alt key; `emma-option-tap.exe` uses the Windows keyboard
hook. Both helpers write `toggle` on stdout and nothing else.

| | |
|---|---|
| Key | Left Option on macOS, or left Alt on Windows; the right key is not it |
| Window | Second press within **0.35 s** of the first release |
| Needs | Accessibility. Without it the helper says so on stderr and ⌥⌥ stays dead |
| Also opens it | Any accelerator or hold bound in **Settings → Keybinds** |

The helper does the holds too: bind an action to holding a modifier and Emma
sends the helper a `{"holds":[…]}` line over stdin; it answers `hold <action>`
when the key is held past its duration and cancels on any other key.

## Where it draws

On macOS, `emma-option-tap --screens` reports the real camera housing per display —
AppKit's `auxiliaryTopLeftArea`/`auxiliaryTopRightArea` bracket it and
`safeAreaInsets.top` is its height. Emma re-reads it whenever the helper prints,
and `parseNotchGeometry` refuses anything outside 40–600 wide or 8–120 tall.

A display with no housing gets a **virtual notch**: a centred gap of
`notchGap` pixels, **120–260, default 180**, set in **Settings → Notch**. That is
the calibration knob — an external monitor has no housing to measure, so the
number is what makes the island's shoulders sit where you want them.

The macOS island window spans the housing and hangs below it: 620px wide (or the
display minus 16), the menu-bar height, plus 97px of island and a 126px
transparent band for the orbs. On Windows, the pill uses the active display's
work area and the saved pill position; it has no camera-housing geometry.

## The idle sliver

With the island closed, main polls the cursor every 120ms and, once it comes
within 220px of the housing, builds a transparent hotspot window over it —
the housing plus 14px each side and 44px of drop for the sliver to draw in. It
is click-through (`setIgnoreMouseEvents(true, { forward: true })`) unless the
cursor is inside the housing itself — the pad and the drop never take a click,
so the menu bar and whatever sits under them keep working; inside, it lights up
and a click opens Quick Ask. Opening the island destroys it.

## The island

One surface, not a stack of panels: transcript, composer, mode picker, model
picker, and a footer reading the model's window and the last answer's tok/s.

- It grows with the conversation up to `MAX_TRANSCRIPT` (**260px**), measured
  from the transcript plus whatever menu or slash band is open. Past that the
  transcript scrolls instead of the window growing.
- After **6** turns it offers *"Getting long — continue in the full app →"*.
- `⌘1` / `⌘2` / `⌘3` on macOS, or `Ctrl+1` / `Ctrl+2` / `Ctrl+3` on Windows,
  run the three quick actions from **Settings → Quick actions** — each is a
  label and a prompt, run as one turn in a fresh thread.
- Escape leaves the island; so does clicking away.
- Reopening while a turn is still running starts a new quick session, unless
  **Settings → Notch → Quick Ask behaviour** is `continue`.

## Leaving, and the draft

| Leaving with | What happens |
|---|---|
| Nothing running | The window is **destroyed** — no idle renderer sitting behind the menu bar |
| A turn running | The window hides and is destroyed when the run lands (`closeOverlayWhenIdle`) |
| The island detached | It collapses to the chip instead of closing |

An unsent draft survives either way: the composer writes it to `localStorage`
under `emma.overlayDraft.v1` on every keystroke and reads it back when the island
is built again.

## The chip and the popout

Dragged off the housing, Quick Ask becomes a 44px chip parked where you left it
— always whole and inside the work area, because a chip half off the screen is
one you cannot get back. Clicking it expands the same island beside it, with a
28px header where the housing wrap would have been.

## The orb ring

Two ways to the same commands, both off `settings.cursorOrbs` (up to
`MAX_CURSOR_ORBS`, **8**; default ⌘1, ⌘2, ⌘3, ▣ Screen, ✎ Draw, ⧉ Save screen):

- **Under the island** — sweep the cursor down through the notch and the orbs
  drop out of it. Turned off by **Settings → Notch → notch commands**.
- **At the cursor** — a 260px ring, orbs at 88px radius, opened with the island
  when cursor orbs are on and no command was passed.

The ring is a focusless window of its own, so it cannot type. It sends a command
name and nothing else, and **main validates it against the fixed catalog**
(`isCursorCommand`, [`desktop/shared/settings.ts`](../desktop/shared/settings.ts))
before forwarding it to the island — a compromised ring renderer cannot ask for
anything that is not on the list.

| Command | Glyph | Does |
|---|---|---|
| `0` `1` `2` | ⌘1/`Ctrl+1`, ⌘2/`Ctrl+2`, ⌘3/`Ctrl+3` | Runs that quick action |
| `screen` | ▣ | Captures the screen and attaches it to the next turn |
| `draw` | ✎ | Opens the yellow pen over the screen — see [voice.md](voice.md) |
| `page` | ⧉ | Keeps what you are looking at as a note — screenshot, then the vision model, then the app in front — see [knowledge.md](knowledge.md) |
| `keep` | ◈ | Listed in the catalog, but the island has no handler for it — nothing happens |
| `workspace` | ▤ | Opens the main window |

## Settings

| Setting | Values |
|---|---|
| Notch gap | 120–260, default 180 (virtual notch only) |
| Quick Ask model | Any OpenRouter key, or the thread default |
| Quick Ask behaviour | `separate` (default) or `continue` |
| Cursor orbs | On/off, and which up to 8 |
| Notch commands | On/off — the orbs that drop under the island |
| Quick actions | Three labels and prompts |
| Shortcuts | Accelerator or modifier-hold per action |

The user can create one conversationally, for example: “Make ⌘⌥K ask Emma to
summarize what I am working on.” The `shortcut` tool fills the next unbound
Quick Action, registers the global accelerator immediately, and shows its label
and prompt on **Settings → Keybinds**. Reusing the same label or combination
updates that slot; all three occupied means one must be cleared first.

Everything above is validated by `validateOverlayPreferences` and
`validateKeybinds` before main acts on it.

## See also

- [voice.md](voice.md) — dictation and the yellow pen
- [knowledge.md](knowledge.md) — what keeping a page writes
- [permissions.md](permissions.md) — the mode picker in the island's footer
- [computer-use.md](computer-use.md) — the run banner, another of these surfaces
