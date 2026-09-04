# Harness handoff verification — September 4, 2026

The desktop now shows each harness's latest output as a readable result, with a
separate terminal log and shared attachment/model composer. Hand off output
starts another installed harness or continues an existing run in the thread.
The `cli` tool accepts `fromRuns` for sequences, combined inputs, and review loops.

## Verified

- Real Electron app, disposable profile and workspace: Claude Code fixture →
  Codex fixture through the handoff dialog, followed by Codex → the existing
  Claude Code session from the floating window. The receiving runs showed the
  expected output and source id/turn. Destination selection and text entry also
  worked by keyboard. These were local fixture executables, not vendor model
  calls.
- The backend integration check covers a three-harness chain, multiple inputs,
  latest-turn stdout without command echoes or stderr, cross-thread rejection,
  self-input rejection, failed/oversized sources, prompt limits, same-folder
  concurrency, and refusing an obsolete newest-session resume.
- 54 focused CLI, model-catalog, and bridge checks passed. Desktop TypeScript,
  lint, and renderer production build passed. Rust formatting, check, tests,
  Clippy, and Zig harness tests passed.
- Before the UI refinement, the desktop suite had 1,014 passing checks and one failure in
  the concurrently edited provider-onboarding privacy-copy check (the expected
  wording “separate opt-ins” was absent). This change does not edit that test
  or its settings copy.
- Mobile protocol mirror, typecheck, and regression checks passed. The real
  iOS 26.5 app on an iPhone 17 Pro simulator displayed source lineage and
  separate Latest result / Run log sections using local demo fixtures.
- Website docs, agent references, roadmap, and a real-app screenshot were
  updated. Its production build and targeted checks passed; the full website
  check still encounters unrelated formatting and existing EmmaWindow lint
  errors.

## Limits

Runs, captured output, and source metadata last for the app session. The UI
hands off one run at a time; chat can combine up to eight. Large deliverables
must be saved to files and passed by path. New UI runs use default CLI approvals;
existing destinations retain theirs. Other terminal sessions are outside Emma's
session tracking.

Live vendor authentication, vendor CLI flags, unattended permission behavior,
Windows, signing, VoiceOver announcements, and multiple-display geometry were
not exercised. No shortcut or privacy permission was changed. Mobile source-link tapping and VoiceOver were not exercised because a demo
permission sheet covered the lower screen. The handoff destination picker
remains desktop-only, while the phone can request chains in chat.

[Real app screenshot](../desktop/screenshots/harness-handoff.png)

## UI refinement

The follow-up UI pass adds branded run headers, readable result typography,
segmented output controls, source navigation, destination opening, and a card
picker for handoffs. All harness controls, cards, badges, and dialog corners are
square. It changes no bridge fields or backend handoff behavior.

The real isolated Electron app completed a handoff using the new cards. Open
Codex navigated to the receiving run; the Claude Code source chip navigated back.
The floating window showed its task title and restyled controls. Native radio
selection with Tab/Right and Escape dismissal with restored trigger focus were
exercised. The 1,018 desktop tests, TypeScript, lint, and renderer build passed.

This follow-up did not retest live vendor calls, signing, VoiceOver, Windows,
multiple displays, or mobile. It changed no shortcut or privacy permission.

[Workspace preview](../desktop/screenshots/harness-workspace-ui.png) ·
[Handoff preview](../desktop/screenshots/harness-handoff-ui.png)


## Native model and thinking options

September 4, 2026: the model/effort follow-up passed 1,021 desktop tests,
renderer type checking, lint, and the renderer build. Cargo formatting, workspace
check, tests, Clippy, and Zig harness tests passed. Desktop/Zig socket tests
needed their normal localhost permissions outside the restricted sandbox.

The real isolated Electron app ran a local Claude fixture with model `sonnet`
and effort `high`, then handed its output to a Codex fixture configured through
the real dialog as `gpt-5.6-luna` with `max`. The receiving run showed both choices.
Its captured command included `--model gpt-5.6-luna --config
model_reasoning_effort="max"`. Applying `high` in the run's settings and sending a
follow-up produced `exec --color never resume --last` with the same model and
`model_reasoning_effort="high"`.

Applying `gpt-5.5` with `max` produced a visible catalog validation error and kept
the original Luna/max selection. Correcting the pair closed the settings and
restored focus. Native model input and thinking selection were exercised; all
new controls have square corners. The error layout was checked at 1232×768.

Claude and OpenCode help and the installed Pi argument parser confirmed native
flags. Codex's parser accepted the corrected resume flag placement in a help-only
invocation. Antigravity's `agy` adapter follows its official headless reference.
No live vendor model turn, provider billing, Antigravity/Gemini/Cursor installation,
VoiceOver, signing, Windows, privacy permission, global shortcut, or multiple
display path was exercised. These settings are requested values; Emma does not
measure the vendor's actual reasoning budget or override its model restrictions.

[Configured handoff](../desktop/screenshots/harness-model-handoff.png) ·
[Configured workspace](../desktop/screenshots/harness-model-workspace.png)

The mobile protocol mirror, requested-option display, active-turn guards, and
square rows passed protocol drift, TypeScript, targeted ESLint, thread-artifact,
send, rows, and keyboard checks. Mobile model-only edits preserve effort. The
phone links to chat for capability-aware thinking selection because its existing
model-list endpoint does not publish per-model thinking metadata. This pass's
mobile UI and VoiceOver remain visually unverified after simulator control
failures; the owned validation setup was stopped.

The website docs, agent references, roadmap, and real fixture screenshots were
updated. Website build/typecheck and targeted formatting/lint checks passed;
full formatting remains blocked by seven untouched files.
