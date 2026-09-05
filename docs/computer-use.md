# App-scoped computer use

Emma can read and operate a running macOS or Windows app in the background after
you approve that specific app. It uses macOS accessibility controls or Windows
UI Automation, not the global pointer, screen coordinates, or the clipboard.
Apps with no usable accessibility interface are unsupported; there is no
screenshot or canvas fallback.

## Approval and scope

`computer` starts with `list_apps`, which returns running-app names, bundle IDs,
PIDs and paths without an app approval. It does not read window contents. An app
that is not listed is opened with `launch_app` rather than by asking the user.
Emma's own executables are excluded, by name and by directory, never by process
ancestry: an app the harness shell or `launch_app` started is listed and can be
controlled like any other.

Before `get_app_state` reads an app, Emma shows its name, bundle ID, resolved path
and PID. Before `launch_app` starts one, Emma shows the resolved application it
would open; allowing that both starts the app and grants control of it, so
`get_app_state` on the app it returns does not ask a second time. **Allow for this turn** approves that running instance for the active
parent turn only. Delegated harness agents cannot use `computer`; the parent must
perform app actions. Another app needs its own approval. Separate thread turns
cannot borrow the grant.

This is an explicit human decision in **every permission mode**, including Auto
and Full access. The verifier cannot approve it. **Don't**, Escape in the dialog,
or a ten-minute unanswered prompt denies access, and that app cannot be requested
again in the same turn. There is no persistent or always-allow grant.

The grant lives only in memory. The helper checks the bundle identity, path, PID
and kernel process birth timestamp before acting; quitting or relaunching an app
requires a new turn and approval. Stop, the run banner's Escape shortcut, screen
lock, suspend, turn completion and Emma quitting revoke access and stop helpers.
After a stop, further calls cannot restart computer use in the same turn. A stop
does not undo actions already dispatched.

App approval permits access to that app; it is not approval for a purchase,
deletion, sending private data or another consequential action. The tool tells the
model to ask separately. On-screen text is untrusted data, never authorization.
This boundary applies to `computer`, not to separately permitted shell commands,
browser tools or plugins; it is not an OS sandbox for those tools or the target app.

## Actions

There are eight actions. Except for `list_apps` and `launch_app`, pass the exact
`app` bundle ID from the list; add `pid` when several instances share that ID.

| Action | Additional arguments | Behavior |
| --- | --- | --- |
| `list_apps` | None | List eligible running apps, without reading their UI. |
| `launch_app` | `name` | After approval, start an installed app by name and return its identity and PID. |
| `get_app_state` | None | After approval, return accessibility text, a snapshot token and element indices. |
| `click` | `snapshot`, `element_index` | Perform the control's accessibility press action; never a coordinate click. |
| `set_value` | `snapshot`, `element_index`, `value` | Explicitly replace a writable control's entire value. An empty value clears it. |
| `type_text` | `snapshot`, `element_index`, `text` | Insert at an exposed selection in a plain `AXTextField` or `AXComboBox`. |
| `key` | `snapshot`, `element_index`, `key` | Dispatch one named, nonmodifier key to the approved app's already-focused control. |
| `scroll` | `snapshot`, `element_index`, `direction`, optional `amount` | Update an exposed writable scrollbar; amount is 1–10, default 1. |

`launch_app` takes `name`, the app as a person would name it — `Notepad`,
`Calculator`, `Google Chrome` — or the `name` `list_apps` prints. It is never a
file path, and it resolves only against installed applications, so the model
cannot ask Emma to run an arbitrary executable. Resolution is done twice: once to
show the user what would be opened, and again to start it, and a launch whose
second resolution differs from the approved one fails. The action returns the
started app's identity and PID after waiting up to twelve seconds for a window,
and adds that instance to the turn's approved apps. Emma refuses to start itself.
Unlike every other action, launching brings the app forward; that is what
starting an app does.

On macOS a name is resolved as a bundle identifier through
`NSWorkspace.URLForApplicationWithBundleIdentifier`, then as a bundle name in
`/Applications`, `/Applications/Utilities`, `/System/Applications`,
`/System/Applications/Utilities` and `~/Applications`, exactly first and then by
unique prefix. The app is started with
`NSWorkspace.openApplicationAtURL:configuration:completionHandler:`, which is not
subject to any job or process group of Emma's. The Windows resolution order is
below.

A snapshot authorizes at most one mutation. Once an action is sent to the helper,
the snapshot is consumed even if that action fails. Snapshots expire after 60
seconds. Get fresh app state after each action to inspect the result and obtain
new indices; tokens from another app, an old state or a previous turn are refused.
Element ownership, identity and protected status are checked again before mutation.
App and system menus are excluded; use supported controls inside app windows
instead.

`type_text` is not a general typing replacement: rich-text editors and text areas
may be unsupported, and it needs a readable value and selection. Do not substitute
`set_value` unless replacing the whole value is intended. Both input strings are
limited to 4096 characters; insertion refuses a resulting value over 65,536.

`key` accepts Return/Enter, Tab, Space, Backspace, Delete, Escape, arrows, Home,
End, PageUp and PageDown, case-insensitively. No modifier combinations, global
shortcuts or app focusing. Success means the event was dispatched to the approved
PID, not that the app received or handled it; inspect state rather than retrying
blindly. Scroll works only where the app exposes a writable scrollbar in the
requested direction.

## Windows

The Windows helper speaks the same eight actions over the same NDJSON protocol
and enforces the same identity, snapshot and element checks. It uses UI
Automation (`IUIAutomation`) and is manifested per-monitor-DPI-aware. What
differs is the platform underneath.

`list_apps` returns every process that owns a visible, unowned, non-tool-window
top level window, up to 128. The name is the executable's file stem
(`Notepad`, `chrome`), not a friendly product name, and the ID is
`app-<hash of the normalized executable path>`; the approval dialog also shows
the full path and PID. Identity is rechecked against the path, PID and process
creation time. The taskbar, the desktop and menu window classes are excluded.

So are Emma's own binaries, and only those: the helper process itself, the
process named by `--blocked-pid`, any executable whose file stem is `emma`,
`emma-host`, `emma-cli`, `emma-pty`, `emma-computer`, `emma-option-tap` or
`emma-transcribe`, and anything inside the directory holding the helper or the
directory holding Emma's own executable. Process ancestry is not consulted at
all, which is what makes an app started from Emma's shell or by `launch_app`
visible and controllable. The shells the harness spawns are hidden for a
different reason: they have no visible top level window, so they never reach the
list. Until this change the helper walked parents instead, and a process whose
recorded parent had already exited counted as Emma's descendant, which on
Windows is nearly every process.

`launch_app` resolves a name against installed apps in a fixed order: an exact
Start Menu shortcut stem under `%ProgramData%` or `%APPDATA%`, resolved through
the shortcut to its target `.exe`; then the `App Paths` registry keys under
`HKCU` and `HKLM` for `<name>` and `<name>.exe`; then an exact display-name match
in the AppsFolder shell namespace whose parsing name is a package AUMID; then a
unique prefix match over the same two sources. An executable target is started
with `CreateProcessW` and `CREATE_BREAKAWAY_FROM_JOB`, retried without the flag
when the helper holds no breakaway right, so the app is never a member of a job
object that would kill it. A package AUMID is started through
`IApplicationActivationManager::ActivateApplication`, falling back to
`ShellExecuteExW` on `shell:AppsFolder\<AUMID>`. The helper then polls for a
process that owns a new top level window — the process it started, one running
the resolved executable, or the single new one — and reports that identity. The
started app outlives the helper.

A packaged app whose window is hosted by `ApplicationFrameHost.exe` is a known
gap, not a new one: Windows reparents its `CoreWindow` into the frame process, so
`list_apps` shows `ApplicationFrameHost` rather than the app. Calculator is the
common case. `launch_app` reports the process it actually started, so a launch of
Calculator succeeds and returns `CalculatorApp`, but that identity is not in
`list_apps` and `get_app_state` on it fails. Notepad, which owns its own window,
works end to end.

`get_app_state` walks each of the app's windows in front-to-back z-order through
the control view, so the window the user is looking at gets the element budget
first. Roles are UI Automation control-type names (`Button`, `Edit`,
`Document`, `ListItem`). Password fields, menu bars, menus, menu items and title
bars are omitted. The 400-element, 23,000-byte, depth-18 and five-second budgets
match macOS.

`click` performs the control's Invoke pattern, or its Toggle pattern, or selects
it through the SelectionItem pattern — the three that Windows treats as a
control's default action. A control exposing none of them is refused; no mouse
event is ever synthesized. `set_value` and `type_text` write through the Value
pattern, and `type_text` additionally needs an Edit or ComboBox control with a
single Text-pattern selection. Both verify the value they wrote, so an app that
normalizes what it stores reports that the change was accepted but could not be
verified: Notepad rewrites `\n` as `\r`, so any multi-line `set_value` there
lands correctly and still reports unverified. `key` posts `WM_KEYDOWN` and
`WM_KEYUP` to the focused control's own window; Emma never calls
`SetForegroundWindow`, `AllowSetForegroundWindow` or `AttachThreadInput`, and
never uses `SendInput`, so a key reaches a background app without taking the
foreground and cannot leak to another app. `scroll` sets the Scroll pattern's
percent, moving a tenth of the scrollable range per unit of `amount`, matching
the macOS scrollbar step.

No operating-system permission is required: UI Automation needs neither a grant
nor UIAccess, and Windows has no equivalent of Screen Recording or Accessibility
consent. Setup status therefore reports `accessibility` as not applicable and
`screen` as granted on Windows.

The limits are the platform's own. A window belonging to a process running
elevated is unreadable and unactionable from a non-elevated Emma, and Windows
reports no error the helper can distinguish from an empty app. The secure
desktop — the UAC prompt, Ctrl+Alt+Del and the lock screen — is a separate
desktop that Emma cannot see or reach at all. A packaged app that Windows has
suspended because it is not on screen exposes an empty accessibility tree; the
Settings app in the background is the common case. Cursor geometry is reported in
physical pixels, so on a display scaled above 100% the activity cursor is
currently placed using unconverted coordinates.

## Data and limits

App metadata and approved accessibility text reach the turn's model as ordinary
tool results. State can contain window titles, labels and values, including
sensitive information visible in ordinary controls. Secure controls are omitted;
this does not make all other app text nonsensitive. State is bounded and can be
truncated. The `computer` tool takes no screenshots, reads no clipboard and has no
image channel. The separate yellow-pen annotation capture and image attachment
paths are unchanged; see [privacy.md](privacy.md).

On macOS, Accessibility permission is required to read or act on controls. Enable
Emma in System Settings → Privacy & Security → Accessibility, then relaunch. On
Windows, the helper uses UI Automation and has no equivalent macOS TCC grant.
Screen Recording is not needed for this tool; it remains separate for screen
annotation.

Only one computer turn runs at a time. Limits are 20 tool calls and ten minutes per
run, with at least 40 ms between app actions and a ten-second helper reply timeout.
A timed-out mutation may already have happened; do not automatically retry it.
The always-on-top run banner identifies the app, shows progress and provides Stop.
Escape is registered globally while the banner is open; failure to register it
stops the turn. Calls also appear in the thread's execution trace.

## Activity cursor

A grey Emma cursor haloed in the secondary accent, with an action label, marks
the control being edited, typed into, pressed or scrolled. The cursor glides between controls in the same window over
280 ms and pulses on arrival. Read-state steps do not interrupt that movement.
The operating system's Reduce Motion preference disables the glide and pulse.

The transparent overlay is click-through, cannot take focus and never moves the
real pointer. It is ordered immediately above the approved target window, not
always on top of unrelated apps. Accessibility geometry and public window metadata
identify the window and control; no screenshot is taken. These coordinates stay
inside Emma and are not added to model tool results. Missing, ambiguous,
minimized or off-display geometry suppresses the cue without changing the action.

The cue expires after 1.4 seconds and disappears immediately on Stop or turn end.
A post-action check also clears it when the action changes or closes the target
window/control. It marks the last action, not continuous tracking: manual window
moves or asynchronous layout changes after that check can leave the old location
visible for the remainder of the short cue lifetime. The run banner remains the
continuous status and Stop control.

Implementation: [computer.ts](../desktop/main/computer.ts) owns grants and helper
lifetime; [computer.m](../desktop/native/computer.m) and
[computer_win.cpp](../desktop/native/computer_win.cpp) enforce app identity and
platform accessibility actions; [main.ts](../desktop/main/main.ts) connects human
approval, turn lifecycle and the banner. [harness.ts](../desktop/main/harness.ts)
accepts computer calls only from the active parent turn's current tool-call IDs,
never from delegated agents. Settings → Tools → Computer use can disable the
tool in every mode.

## Relationship to Codex

Inspection of Codex CLI 0.147.0 and the installed Computer Use plugin found no
supported embedding interface for its app-private runtime. Emma uses its own
native helper, without copying proprietary plugin code. OpenAI documents Computer
Use as a [desktop app plugin with app approvals](https://learn.chatgpt.com/docs/computer-use),
and separately describes [custom computer-use harnesses](https://developers.openai.com/api/docs/guides/tools-computer-use).
Emma follows the custom-tool approach, not a dependency on Codex's private runtime.

## Verification

The macOS development build was exercised on 2026-08-28 with isolated Emma data,
a localhost model fixture and two disposable native apps. The real approval dialog
appeared in Auto and Full access. Approval allowed background value replacement,
Unicode text insertion and a button press while Emma remained frontmost. Denial
blocked retries, a second app required separate consent, and Stop cancelled a
pending turn before its next action. Secure fields and menu bars were absent from
the returned state. The final build repeated the approved interaction successfully.

`launch_app` was exercised on 2026-09-05 on Windows 11 x64 by driving
`dist-native/emma-computer.exe` directly. `--resolve` returned the packaged
Notepad executable, the Calculator package AUMID and Chrome's Start Menu target,
and refused a name no installed app matches. `--launch Notepad` started Notepad
and returned its identity and PID; the process outlived the helper's exit,
appeared in a later `--list`, and a `--app` session against it returned app
state, wrote a value through `set_value` and had that value verified and then
restored. `--launch Calculator` activated the package and returned
`CalculatorApp`, which `--list` does not show for the `ApplicationFrameHost`
reason above. `type_text` refuses Notepad's `Document` control, as documented:
that path needs an Edit or ComboBox. Not verified on Windows: the model-driven
end-to-end turn and the real approval dialog, which need provider credentials the
test machine does not have. The macOS half of this change — `--resolve`,
`--launch`, `NSWorkspace` resolution and the path-based exclusion — compiles
under `-Werror` and passes the helper's self-test on the CI macOS runner, but
nobody has resolved, launched or listed a real app with it; that needs a Mac.

The Windows helper was exercised on 2026-09-04 on Windows 11 x64 with two 100%
displays, against Notepad and Chrome. Until that day `list_apps` had always
returned nothing, because the ancestry walk treated a process whose recorded
parent had already exited as a descendant of Emma and excluded it, which on
Windows is nearly every process; the shipped 0.5.1 helper still behaves that way.
That walk is now gone on both platforms. With the earlier fix, listing, state, click, set_value, type_text, key and scroll were
each driven directly over NDJSON: Unicode including accents and emoji round-tripped
through both write paths, a posted key reached a background Notepad without
taking the foreground, selecting a tab worked once click covered the Toggle and
SelectionItem patterns, and scroll moved the document by the requested tenths.
Cursor events carried physical-pixel geometry that matched `GetWindowRect`,
including negative coordinates on a secondary display, and `moveAbove` with the
reported window handle placed an Electron overlay immediately above the target
window and below every other window. Not verified on Windows: a display scaled
above 100%, mixed-DPI displays, an elevated target window, the secure desktop,
and the model-driven end-to-end turn, which needs provider credentials the test
machine did not have.

Automated checks cover validation, snapshot ownership, process replacement,
concurrent calls, turn admission, parent-only harness calls and permission
cancellation. Native helper self-tests and the desktop, Rust and Zig checks passed.
Cursor regressions cover native geometry, progress framing, invalidation, the
sandboxed preload, overlay lifetime and stable coordinates across display boundaries.
The actual cursor renderer was also exercised in an isolated Electron visual
fixture: captured intermediate frames showed the glide in both directions and
the arrival pulse. The background app workflow was repeated with the cursor build.
This is not release certification: OS permission grant/denial prompts, the physical
global Escape shortcut, lock/suspend behavior, VoiceOver, multiple displays, the
system Reduce Motion setting and release signing were not manually verified. Real
Windows behavior is recorded above.

## See also

- [permissions.md](permissions.md) — modes, explicit app grants and cancellation
- [tools.md](tools.md) — the tool catalogs and harness bridge
- [privacy.md](privacy.md) — what leaves this computer
