# Controlling this Mac

Emma takes the real pointer and keyboard: capture the screen, click, scroll,
type, look again. Tool of last resort, for GUI apps with no other route.

macOS only, foreground only, awake and unlocked. One run at a time.

## How it is gated

`computer` is an ordinary tool, so the composer's permission mode decides it —
the same table every other tool answers to
([permissions.ts](../desktop/shared/permissions.ts)). There is no separate
approval flow, and no "Control this Mac" button.

| Mode | `computer` |
| --- | --- |
| Ask | `ask` — a dialog per call |
| Accept edits | `ask` — a dialog per call |
| Auto | reads the `ask` row; the call goes to your verifier model first |
| Full access | `auto` — runs through |

There is no `plan` mode. Switching **Control this Mac** off in Settings → Tools
makes the tool `hidden` in every mode: never advertised, and refused if the model
names it anyway.

The dialog is `PermissionPrompt` ([agents.tsx](../desktop/src/agents.tsx)) —
summary (`left click`, `type`, `scroll`), raw arguments, **Don't** / **Allow
once**. Escape closes it as **Don't**; unanswered for `MAX_ASK_MS` (10 minutes) it
is a refusal, which reaches the model as *"The user did not allow computer to run.
Do not try it again this turn."* In `auto`, anything the verifier will not clear
falls through to that same dialog.

Enforcement is `runEmmaTool` ([main.ts](../desktop/main/main.ts)), not the
advertised catalog. The harness registers `computer` with
`requires_approval = false` on purpose: Emma gates it at execution, and a harness
prompt would be a second dialog for the same decision.

The tool's own description tells the model when it may reach for this:

> The user must have asked for it, or you must ask them first and get a yes in
> the conversation; a granted permission dialog is not that ask.

## The rails, in every mode

None of these consult the permission mode. `full` does not switch any of them off.

| Rail | Value | Constant |
| --- | --- | --- |
| Model steps per run | 20 | `MAX_RUN_STEPS` |
| Actions per run | 400 | `MAX_RUN_ACTIONS` |
| Minimum gap between actions | 40 ms | `MIN_ACTION_INTERVAL_MS` |
| Wall clock per run | 10 minutes | `MAX_RUN_MS` |
| Characters in one `type` | 4096 | `MAX_TYPED_CHARACTERS` |
| Seconds for `wait` / `hold_key` | 300 | `MAX_WAIT_SECONDS` |
| Presses for `key` `repeat` | 32 | `MAX_KEY_REPEAT` |
| Helper reply timeout | 5 s, plus any `hold_key` duration | `HELPER_TIMEOUT_MS` |
| Helper line | 8 KB | `MAX_HELPER_LINE_BYTES` |

All from [computer.ts](../desktop/main/computer.ts). `step()` returns false once
the run is past 20 steps *or* over 10 minutes old, and the call fails with a
message the model reads, so the turn ends on it rather than stopping silently.
The action ceiling throws. The rate limit is a sleep, not an error.

**The banner.** An always-on-top window for the life of the run: frameless,
transparent, `focusable: false`, 76 px tall and at most 520 px wide, centred at
the top of the display under the pointer, pinned at the `screen-saver` level and
visible on all workspaces including fullscreen ones — a fullscreen app cannot hide
it. It shows the current action, the step count against `MAX_RUN_STEPS`, and the
action count, and carries a **Stop** button. It is one of only two senders
`emma:stop-agent` accepts.

**Escape.** While a run is live, `Escape` is registered as a *global* shortcut, so
it works wherever focus happens to be — which matters, because the agent is
clicking in other apps. It aborts the run and closes the banner. It is
unregistered the moment the banner closes.

**The action log.** Three places. The main-process log writes
`Emma computer run started for <threadId>`, one line per action
(`Emma computer action 14/400: left_click`), then
`Emma computer run stopped by the user after 14 actions`. The banner shows it
live. And every call is a span in the thread's durable trace, readable in the
inspector or with `read_trace`. No separate log file; no screenshot on disk.

The run also ends when the turn ends, and on app quit.

## Actions

The `computer_toolset_20260801` vocabulary, so a model that already knows
Anthropic's computer-use tool needs no retraining. `move` and `click` are kept as
aliases because saved skills and traces still spell them that way. Validation is
`validateAction` in [computer.ts](../desktop/main/computer.ts); anything not on
this list is *"Computer action is invalid"*.

| Action | Arguments | Notes |
| --- | --- | --- |
| `screenshot` | — | The display under the pointer. Clears any armed zoom. |
| `zoom` | `region` | Arms the next screenshot to `[x0, y0, x1, y1]`. At least 8 px per side. No capture of its own. |
| `cursor_position` | — | Where the pointer is, in the last screenshot's pixels. |
| `wait` | `duration` | Seconds, 0–300. |
| `mouse_move` / `move` | `coordinate` | |
| `left_click` / `click` | `coordinate`, `text` | `text` is modifiers to hold, at most 64 characters. |
| `right_click` | `coordinate`, `text` | |
| `middle_click` | `coordinate`, `text` | |
| `double_click` | `coordinate`, `text` | |
| `triple_click` | `coordinate`, `text` | |
| `left_mouse_down` | `coordinate` | |
| `left_mouse_up` | `coordinate` | |
| `left_click_drag` | `start_coordinate`, `coordinate` | |
| `scroll` | `coordinate`, `scroll_direction`, `scroll_amount` | `up`/`down`/`left`/`right`; 1–50 wheel lines, default 3. |
| `type` | `text` | Up to 4096 characters. |
| `key` | `text`, `repeat` | A combo: `cmd+s`, `ctrl+shift+tab`, `Return`. `repeat` up to 32. |
| `hold_key` | `text`, `duration` | Holds the combo for `duration` seconds. |

Modifiers the native helper understands: `command`/`cmd`/`super`, `shift`,
`option`/`alt`, `control`.

Everything but `screenshot`, `zoom`, `cursor_position` and `wait` goes out to
`emma-option-tap` run with `--input` — one JSON line in, one JSON line out — which
posts real CGEvents at the HID tap ([quick_ask.m](../desktop/native/quick_ask.m)).
Same binary as the double-Option Quick Ask gesture.

### Coordinates

`[x, y]` in the pixels of the screenshot the model last saw, top-left origin.
Pointer actions are refused until a screenshot has been taken — *"Take a
screenshot before pointing at the screen"* — because screenshot pixels are the
only thing there is to map from. `helperPayload` undoes the zoom crop, then the
capture scale, landing on a real screen point. Out-of-frame coordinates and an
unplugged display are both refused.

Capture: the display under the pointer, native scale, clamped to 2560×1600, JPEG
quality 82, then squeezed under `MAX_SCREEN_CONTEXT_CHARS` by trying widths
1440/1200/960/720 against qualities 68/54/42/32 — quality is coarsened before
resolution so coordinates stay usable as long as possible.

Each capture takes the display under the pointer. Move the pointer to another
screen mid-run and the next screenshot is of that one. There is no display picker.

## Screenshots stay in this process

`ComputerUseRuntime.screenshot()` captures, crops, compresses and remembers the
frame — that is what makes coordinate mapping work — but the result handed back
over the harness bridge is a single text string. `_emma/callTool` has no image
channel. The `computer` tool answers in words.

The `vision` tool is the deliberate exception: it posts one image to a vision
model and returns what that model said. Emma's `vision` is advertised to the model
under the name `look_at_image`, because the harness keeps `vision` for its own
forced-lookup path ([overrides.zig](../harness/src/builtins/emma/overrides.zig)).
See [privacy.md](privacy.md).

## macOS permissions

Two grants, both yours to give ([setup.ts](../desktop/shared/setup.ts)).

**Screen Recording** — System Settings → Privacy & Security → Screen Recording.
Without it the first capture fails and the run cannot start, because a run's first
act is a screenshot: *"Screen Recording permission is required."* Granted but
empty gives *"Emma could not capture this display."*

**Accessibility** — System Settings → Privacy & Security → Accessibility. This is
what lets Emma post real events. The helper checks `AXIsProcessTrusted()` before
reading a single action and otherwise answers every one with
`{"ok": false, "error": "Accessibility access is not granted"}`. It needs a
relaunch after you grant it.

## Learning from a run

`write_skill` is advertised alongside `computer` so a run that hits a dead end or
finds a better route can record it. Two arguments: `name` (lowercase hyphenated
slug) and `instructions` (markdown, a one-line summary then the steps that
worked). It lands in `<userData>/skills/<slug>/SKILL.md` via `writeLearnedSkill`
([capabilities.ts](../desktop/main/capabilities.ts)) and is mirrored into the
harness's skills directory. The next turn that matches by keyword starts with the
lesson in it. `write_skill` is `auto` in every mode — it writes a markdown file
into Emma's own data folder.

## Failure modes

- **Nothing is undoable.** Stop stops the next action; it does not undo the last.
- **Anything can move under it.** A dialog between the screenshot and the click
  means the click lands elsewhere. The 120 ms settle after each action helps and
  does not solve it. Small text is a real failure — `zoom` exists for that.
- **Helper failures end the run.** If the helper stops or does not answer within
  5 seconds, every pending action rejects and the helper is killed.
- **Foreground only.** The pointer is the real one; whatever you do while a run is
  going fights it.
- **Not a Mac.** `start` throws *"Computer use is macOS only in this build"*, and
  the model is told *"computer controls this Mac, and this is not a Mac."*
- **Unattended runs reach it too.** A scheduled job saved on `full` can drive the
  screen with nobody watching. The banner opens, Escape works and the ceilings
  apply — but nobody is there to see the banner. See [jobs.md](jobs.md).

## See also

- [permissions.md](permissions.md) — the four modes, the gate matrix, the verifier
- [tools.md](tools.md) — every tool a turn can call
- [privacy.md](privacy.md) — what leaves this Mac
- [notch.md](notch.md) — the other user of the same native helper
- [troubleshooting.md](troubleshooting.md) — grants, helpers and stuck runs
