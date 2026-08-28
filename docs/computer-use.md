# App-scoped computer use

Emma can read and operate a running macOS app in the background after you approve
that specific app. It uses accessibility controls, not the global pointer, screen
coordinates, or the clipboard. Apps with no usable accessibility interface are
unsupported; there is no screenshot or canvas fallback.

## Approval and scope

`computer` starts with `list_apps`, which returns running-app names, bundle IDs,
PIDs and paths without an app approval. It does not read window contents. Ask the
user to open an app that is not listed; the tool cannot launch or activate apps.
Emma's own process and its descendants are excluded.

Before `get_app_state` reads an app, Emma shows its name, bundle ID, resolved path
and PID. **Allow for this turn** approves that running instance for the active
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

There are seven actions. Except for `list_apps`, pass the exact `app` bundle ID
from the list; add `pid` when several instances share that ID.

| Action | Additional arguments | Behavior |
| --- | --- | --- |
| `list_apps` | None | List eligible running apps, without reading their UI. |
| `get_app_state` | None | After approval, return accessibility text, a snapshot token and element indices. |
| `click` | `snapshot`, `element_index` | Perform the control's accessibility press action; never a coordinate click. |
| `set_value` | `snapshot`, `element_index`, `value` | Explicitly replace a writable control's entire value. An empty value clears it. |
| `type_text` | `snapshot`, `element_index`, `text` | Insert at an exposed selection in a plain `AXTextField` or `AXComboBox`. |
| `key` | `snapshot`, `element_index`, `key` | Dispatch one named, nonmodifier key to the approved app's already-focused control. |
| `scroll` | `snapshot`, `element_index`, `direction`, optional `amount` | Update an exposed writable scrollbar; amount is 1–10, default 1. |

A snapshot authorizes at most one mutation. Once an action is sent to the helper,
the snapshot is consumed even if that action fails. Snapshots expire after 60
seconds. Get fresh app state after each action to inspect the result and obtain
new indices; tokens from another app, an old state or a previous turn are refused.
Element ownership, identity and protected status are checked again before mutation.
The app's menu bar is excluded, including its Apple menu and system commands;
use supported controls inside app windows instead.

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

## Data and limits

App metadata and approved accessibility text reach the turn's model as ordinary
tool results. State can contain window titles, labels and values, including
sensitive information visible in ordinary controls. Secure controls are omitted;
this does not make all other app text nonsensitive. State is bounded and can be
truncated. The `computer` tool takes no screenshots, reads no clipboard and has no
image channel. The separate yellow-pen annotation capture and image attachment
paths are unchanged; see [privacy.md](privacy.md).

macOS Accessibility permission is required to read or act on controls. Enable Emma
in System Settings → Privacy & Security → Accessibility, then relaunch. Screen
Recording is not needed for this tool; it remains separate for screen annotation.

Only one computer turn runs at a time. Limits are 20 tool calls and ten minutes per
run, with at least 40 ms between app actions and a ten-second helper reply timeout.
A timed-out mutation may already have happened; do not automatically retry it.
The always-on-top run banner identifies the app, shows progress and provides Stop.
Escape is registered globally while the banner is open; failure to register it
stops the turn. Calls also appear in the thread's execution trace.

Implementation: [computer.ts](../desktop/main/computer.ts) owns grants and helper
lifetime; [computer.m](../desktop/native/computer.m) enforces app identity and
accessibility actions; [main.ts](../desktop/main/main.ts) connects human approval,
turn lifecycle and the banner. [harness.ts](../desktop/main/harness.ts) accepts
computer calls only from the active parent turn's current tool-call IDs, never
from delegated agents. Settings → Tools → Computer use can disable the tool in
every mode. Non-macOS platforms are unsupported.

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

Automated checks cover validation, snapshot ownership, process replacement,
concurrent calls, turn admission, parent-only harness calls and permission
cancellation. Native helper self-tests and the desktop, Rust and Zig checks passed.
This is not release certification: OS permission grant/denial prompts, the physical
global Escape shortcut, lock/suspend behavior, VoiceOver, multiple displays,
release signing and non-macOS behavior were not manually verified.

## See also

- [permissions.md](permissions.md) — modes, explicit app grants and cancellation
- [tools.md](tools.md) — the tool catalogs and harness bridge
- [privacy.md](privacy.md) — what leaves this Mac
