# Controlling this Mac

Emma can take the real pointer and keyboard: capture the screen, click, scroll,
type, and look again. It is the tool of last resort — for GUI apps with no other
route — and every run has hard ceilings, an always-on-top banner, and a
system-wide kill switch.

macOS only. Foreground only. The Mac has to be awake and unlocked.

## Starting a run

There is no "Control this Mac" menu item, and no button that starts a run. The
composer's ＋ menu holds Attach files, files and knowledge categories, skills and
MCP servers, Imported skills & MCP, Agent runtime, and a hint about the screen
pen. Nothing there starts a run.

A run starts when the model calls the `computer` tool, which happens because you
asked for it.

1. Put the thread on a mode that allows the tool: **Ask**, **Accept edits**,
   **Auto** or **Full access**. On **Plan** the tool is hidden and nothing
   happens.
2. Say what you want done, naming the app: *"Open System Settings and turn on
   Night Shift"*, *"In Reminders, tick everything under Groceries"*.
3. On `ask` or `acceptEdits`, a dialog appears for the first action and every one
   after it. Press **Allow once**.

The tool's own description tells the model when it may reach for this:

> Take over this Mac's real pointer and keyboard. Only for work that has no other
> route: driving a GUI app, or looking at the screen. Never for files or code —
> use read_file, write_file and bash. The user must have asked for it, or you
> must ask them first and get a yes in the conversation; a granted permission
> dialog is not that ask.

The first cleared call is what starts the run. `ensureComputerRun`
([main.ts](../desktop/main/main.ts)) opens the run, opens the banner, and takes
the first screenshot. Everything after that is one action per call.

**Control this Mac** is a label, not a button. It is how Settings → Tools names
the `computer` switch: *"Control this Mac — Takes the real pointer and keyboard,
and looks at the screen."* Switch it off there and the tool is hidden in every
mode.

## The loop

Per call, in [main.ts](../desktop/main/main.ts):

1. Start the run if it is not already going — banner up, first screenshot taken.
2. Push the action name to the banner.
3. Count a step. Past the step ceiling or the time ceiling the call fails with
   *"This computer run reached its step limit."* The model reads that and the
   turn ends on it — no silent stop.
4. Validate the action, count it, wait out the rate limit, log it, do it.
5. Sleep 120 ms so the target app can react before the model looks again.

The run ends when the turn ends (`abort("finished")`), when you stop it, or when
Emma quits (`abort("app quit")`). One run at a time — a second `start` throws
*"A computer run is already active"*.

## Actions

The `computer_toolset_20260801` vocabulary, so a model that already knows the
Anthropic tool needs no retraining. `move` and `click` are kept as aliases
because saved skills and traces still spell them that way.

| Action | Arguments | Notes |
| --- | --- | --- |
| `screenshot` | — | Captures the display under the pointer. Clears any armed zoom. |
| `zoom` | `region` | Arms the next screenshot to show only `[x0, y0, x1, y1]`. At least 8 px per side. No capture of its own. |
| `cursor_position` | — | Where the pointer is, in the last screenshot's pixels. |
| `wait` | `duration` | Seconds, 0–300. |
| `mouse_move` / `move` | `coordinate` | |
| `left_click` / `click` | `coordinate`, `text` | `text` is modifiers to hold: `shift`, `cmd+alt`. |
| `right_click` | `coordinate`, `text` | |
| `middle_click` | `coordinate`, `text` | |
| `double_click` | `coordinate`, `text` | |
| `triple_click` | `coordinate`, `text` | |
| `left_mouse_down` | `coordinate` | |
| `left_mouse_up` | `coordinate` | |
| `left_click_drag` | `start_coordinate`, `coordinate` | |
| `scroll` | `coordinate`, `scroll_direction`, `scroll_amount` | Direction is `up`/`down`/`left`/`right`. Amount is 1–50 wheel lines, default 3. |
| `type` | `text` | Up to 4096 characters. |
| `key` | `text`, `repeat` | A combo: `cmd+s`, `ctrl+shift+tab`, `Return`. `repeat` up to 32. |
| `hold_key` | `text`, `duration` | Holds the combo for `duration` seconds. |

Modifiers understood by the native helper: `command`/`cmd`/`super`, `shift`,
`option`/`alt`, `control`.

Everything but `screenshot`, `zoom`, `cursor_position` and `wait` goes out to the
native helper — one JSON line in, one JSON line out — which posts real CGEvents
at the HID tap ([quick_ask.m](../desktop/native/quick_ask.m)). The same binary
that watches for the double-Option Quick Ask gesture, run with `--input`.

### Coordinates

Coordinates are `[x, y]` in the pixels of the screenshot the model last saw,
top-left origin. **Pointer actions are refused until a screenshot has been
taken** — *"Take a screenshot before pointing at the screen"* — because
screenshot pixels are the only thing there is to map from.

The mapping in `helperPayload` ([computer.ts](../desktop/main/computer.ts)) undoes
the zoom crop first, then the capture scale, landing on a real screen point on
the display that was captured. Out-of-frame coordinates are refused
(*"coordinate is outside the captured screen"*), as is a display that has since
been unplugged.

Capture details: the display under the pointer, at native scale, clamped to
2560×1600, JPEG quality 82. The frame is then squeezed under a 96 KB context
ceiling by trying widths 1440 / 1200 / 960 / 720 against qualities 68 / 54 / 42 /
32 — quality is coarsened before resolution so coordinates stay usable as long as
possible. If none fit: *"Screen frame could not be compressed safely"*.

## Safety rails

### The permission gate

There is no separate approval flow. `computer` is an ordinary tool, so the
thread's permission mode decides it — the same table every other tool answers to
([permissions.ts](../desktop/shared/permissions.ts)):

| Mode | `computer` |
| --- | --- |
| Plan | `hidden` — never advertised, refused if asked for anyway |
| Ask | `ask` — a dialog per call |
| Accept edits | `ask` — a dialog per call |
| Auto | reads the `ask` column; the call goes to your verifier model first |
| Full access | `auto` — runs through |

The dialog is `PermissionPrompt` ([agents.tsx](../desktop/src/agents.tsx)): the
thread and its mode, the action as a summary (`left click`, `type`, `scroll`),
the raw arguments underneath, and two buttons — **Don't** and **Allow once**.
Escape closes it as **Don't**. Unanswered for 10 minutes
(`MAX_ASK_MS`), it is treated as a refusal. A refusal comes back to the model as
*"The user did not allow computer to run. Do not try it again this turn."*

In `auto`, the verifier model is asked first and a call it clears never reaches
you. Anything else — it says no, it is not configured, its endpoint is down —
falls through to the same dialog carrying what it did say.

The enforcement point is `runEmmaTool` ([main.ts:1842](../desktop/main/main.ts)),
not the advertised catalog: *"a filtered list is not an enforced one: the harness
caches its catalog and the model can guess."* The harness registers `computer`
with `requires_approval = false` on purpose — Emma gates it itself, and a harness
prompt would be a second dialog for the same decision.

### The banner

Above every app, for the life of the run
(`openRunBanner`, [main.ts:2340](../desktop/main/main.ts)):

> **Emma is using this Mac · left click**
> Step 3/20 · 14 actions · *the task, first 200 characters*   **[Stop · esc]**

It is a frameless, transparent, non-focusable panel, 76 px tall and up to 520 px
wide, centred at the top of the display under the pointer. It is pinned at the
`screen-saver` level and set visible on all workspaces including full-screen
ones, so a full-screen app cannot hide it. The current action, the step count and
the action count update on every call.

Pressing **Stop** stops every live agent, aborts the run, and closes the banner.

### Escape

While a run is live, Escape is registered as a **global** shortcut — it works
wherever focus happens to be, which matters because the agent is clicking in
other apps. It aborts the run (`abort("stopped by the user")`) and closes the
banner. It is unregistered the moment the banner closes, so Escape means nothing
special the rest of the time.

### The ceilings

Every one of these applies to every run, whatever the mode cleared
([computer.ts](../desktop/main/computer.ts)):

| Ceiling | Value | Constant |
| --- | --- | --- |
| Model steps per run | **20** | `MAX_RUN_STEPS` |
| Actions per run | **400** | `MAX_RUN_ACTIONS` |
| Minimum gap between actions | **40 ms** | `MIN_ACTION_INTERVAL_MS` |
| Wall clock per run | **10 minutes** | `MAX_RUN_MS` |
| Characters in one `type` | **4096** | `MAX_TYPED_CHARACTERS` |
| Seconds for `wait` / `hold_key` | **300** | `MAX_WAIT_SECONDS` |
| Presses for `key` `repeat` | **32** | `MAX_KEY_REPEAT` |
| Wheel lines per `scroll` | **1–50** | validated twice: `computer.ts` and the helper |
| Zoom region | **≥ 8 px per side** | `validateAction` |
| Helper reply timeout | **5 s** (plus any `hold_key` duration) | `HELPER_TIMEOUT_MS` |
| Helper line | **8 KB** | `MAX_HELPER_LINE_BYTES` |
| Capture size | **2560 × 1600**, JPEG q82 | `captureDisplay` |
| Screen frame in context | **96 KB** | `MAX_SCREEN_CONTEXT_CHARS` |
| Modifier string on a click | **64 characters** | `validateAction` |

The step ceiling and the time ceiling are checked together: `step()` returns
false once the run is over 10 minutes old *or* past 20 steps, and the call fails
with a message the model can read. The action ceiling throws *"This computer run
reached its action limit"*. The rate limit is a sleep, not an error.

## The action log

Three places:

- **The main-process log.** `ComputerUseRuntime` is constructed with the default
  sink, which is `console.log`. Every run writes
  `Emma computer run started for <threadId>`, then one line per action —
  `Emma computer action 14/400: left_click` — then
  `Emma computer run stopped by the user after 14 actions` (or `finished`, or
  `app quit`). Run Emma from a terminal to watch it live; in the packaged app
  these go to the standard macOS process log.
- **The banner**, live: current action, step count, action count.
- **The thread's durable trace.** Every `computer` call is a span with the tool
  name, its arguments, its status and its duration, stored on the thread
  (`recordTrace`) and rendered again after a restart. Read it in the thread
  inspector, or have Emma read it with `read_trace`. Arguments are kept to 1024
  characters per span, rendered at 240 per line, and the whole trace is clamped
  at 16 KB ([trace.ts](../desktop/shared/trace.ts)).

Nothing is written to a separate log file, and screenshots are not saved to disk.

## macOS permissions

Two grants. Only you can give them; macOS has no API that does
([setup.ts](../desktop/shared/setup.ts)).

### Screen Recording

**System Settings → Privacy & Security → Screen Recording.**

Without it, the first capture fails and the run cannot start, because a run's
first act is a screenshot:

> Screen Recording permission is required. Enable Emma in System Settings →
> Privacy & Security → Screen Recording.

If the grant is there but the capture comes back empty:

> Emma could not capture this display. Check Screen Recording permission and try
> again.

### Accessibility

**System Settings → Privacy & Security → Accessibility.**

This is what lets Emma post real keyboard and mouse events. The helper checks
`AXIsProcessTrusted()` before reading a single action and, without it, answers
every action with `{"ok": false, "error": "Accessibility access is not granted"}`
and prints:

> Emma: Accessibility access is required to control the computer. Grant it in
> System Settings, then relaunch Emma.

The first-launch walkthrough lists both, shows whether this Mac has them, and
deep-links the exact pane. Accessibility needs a relaunch after you grant it.

## Learning from a run

A run that hits a dead end or finds a better route writes itself a skill. The
`write_skill` tool is advertised alongside `computer` for exactly this
([computer.ts](../desktop/main/computer.ts)):

> Record a durable lesson as a skill so future runs avoid a mistake or reuse a
> better route. Rewrite an existing name to correct an earlier lesson.

There is no separate trigger and no automatic detection — the model decides to
call it, prompted by that description. Two arguments: `name`, a lowercase
hyphenated slug (`safari-download-pdf`), up to 128 characters, and
`instructions`, markdown starting with a one-line summary then the concrete steps
that worked, up to 32 KB.

The call lands in `writeLearnedSkill`
([capabilities.ts](../desktop/main/capabilities.ts)), which writes
`<userData>/skills/<slug>/SKILL.md` through the ordinary imported-skill path —
atomically, with the directory at mode 0700 and the file at 0600. That folder is
an implicit import source, so learned skills survive re-running the import
dialog, and they are mirrored into the harness's own skills directory. The next
turn that matches the skill by keyword starts with the lesson already in it. The
skill is the memory; there is no separate memory store for runs.

`write_skill` is gated `auto` in `ask`, `acceptEdits` and `full`, and `hidden` in
`plan` — writing a markdown file into Emma's own data folder does not stop to
ask. Its executable sibling `write_tool` sits in the same place, while `run_tool`
gates exactly where `bash` does.

## Limits and failure modes

**No pixels reach the model on this branch.** `ComputerUseRuntime.screenshot()`
captures, crops, compresses and remembers the frame — that is what makes
coordinate mapping work — but the tool result that goes back over the harness
bridge is a single `output` string, capped at 16 KB
([harness.ts](../desktop/main/harness.ts),
[bridge.zig](../harness/src/tools/emma/bridge.zig)). A `screenshot` action
answers *"Captured this display at 1440x900 pixels. The image is attached to this
message."* — but `_emma/callTool` has no image channel to attach it to. Known
gap.

**One display.** Each capture takes the display under the pointer. Move the
pointer to another screen mid-run and the next screenshot is of that one; the
coordinate frame follows it. There is no display picker.

**Foreground only.** The pointer and keyboard are the real ones. Whatever you do
while a run is going fights it. There is no hidden or background session.

**Awake and unlocked.** A locked or asleep Mac cannot be captured or clicked.
A scheduled job that reaches for `computer` at 03:00 on a sleeping machine gets
nothing.

**Nothing is undoable.** The harness marks the tool irreversible with the comment
*"A real click on a real screen. Whatever it hit already happened."* Stop stops
the next action; it does not undo the last one.

**Anything can move under it.** A dialog appearing between the screenshot and the
click means the click lands somewhere else. The 120 ms settle after each action
helps and does not solve it. Small text is a real failure mode — `zoom` exists
for that.

**macOS only.** `start` throws *"Computer use is macOS only in this build"*, and
the model is told *"computer controls this Mac, and this is not a Mac."*

**Helper failures are fatal to the run.** If the helper stops or does not answer
within 5 seconds, every pending action rejects and the helper is killed. The run
ends.

**Unattended runs reach the same tools.** A scheduled job saved on `full` can
drive the screen with nobody watching. The banner still opens, Escape still
works, the ceilings still apply — but nobody is there to see the banner. See
[jobs.md](jobs.md).

### There is no YOLO toggle

Older docs described a "YOLO toggle in Settings → Privacy" that skipped the
approval dialog. **That toggle does not exist in this code**, and the permission
mode is what decides the dialog. What is actually there:

- No `yolo`, `skipApproval` or equivalent setting anywhere in `desktop/`
  (matches are limited to `node_modules`).
- Settings → **Data & privacy** contains exactly one control — **Reset Emma** —
  plus explanatory text. No toggles ([App.tsx](../desktop/src/App.tsx)).
- The word `yolo` appears in `desktop/main/harness.ts` only as the name of one of
  the *harness's own* permission modes, which Emma deliberately never selects:
  every Emma mode maps onto the harness's `ask`.
- The stale JSDoc on `requireZeroRetention`
  ([settings.ts:247](../desktop/shared/settings.ts)) reads *"Skips the
  computer-use approval dialog…"*, but that field is the zero-retention routing
  switch, wired to `setZeroRetention` and shown on the **Models** page as
  "Private routing". The comment is residue from a removed field.

If a toggle like that ever ships, what it would skip is the dialog and nothing
else. That is already what the Privacy page promises about every mode: *the step
ceiling, the action rate limit, the on-screen banner, and the Escape kill switch
apply in every mode, and every action is logged.* All four check out against the
code above. The dialog is the only rail a mode changes.

## See also

- [permissions.md](permissions.md) — the modes, the gate table, the verifier
- [tools.md](tools.md) — every tool a thread can reach, and the Settings switches
- [privacy.md](privacy.md) — what leaves this Mac, and what does not
- [jobs.md](jobs.md) — unattended runs and the mode they fire under
- [knowledge.md](knowledge.md) — skills, and where a learned one is stored
- [troubleshooting.md](troubleshooting.md) — grants, helpers and stuck runs
- [architecture.md](architecture.md) — the split between the loop and the screen
- [notch.md](notch.md) — the other user of the same native helper
