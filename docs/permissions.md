# Permissions

What a turn may do without stopping to ask. The mode picker chooses ordinary tool
gates in [permissions.ts](../desktop/shared/permissions.ts). Computer use also
requires explicit per-app approval in every mode, including Auto and Full access.

## The four modes

`PERMISSION_MODES` is `["ask", "acceptEdits", "auto", "full"]`, default `ask`
(`DEFAULT_PERMISSION_MODE`). There is no `plan` mode — planning is the `plan`
tool now.

| Glyph | Name | Mode id | Hint |
| --- | --- | --- | --- |
| ◈ | Ask | `ask` | Writes and commands ask; computer access asks once per app per turn. |
| ◆ | Accept edits | `acceptEdits` | File edits go through; commands and app access still ask. |
| ⬗ | Auto | `auto` | A verifier clears ordinary gated calls; app access still asks you. |
| ⬥ | Full access | `full` | Ordinary tools run automatically; app access still asks you. |

Set the default for new threads in Settings → "Default permission mode". Changing
the picker mid-run applies to the run in flight (`agents.setMode`).

## The gate matrix

`toolGate(mode, tool, disabled)` returns `hidden`, `ask` or `auto`. For ordinary
tools, Auto reads the Ask column and sends gated calls to the verifier. The table
below shows effective behavior: `computer` has an `ask` gate in every mode, but
its implementation asks for the resolved app rather than each individual call.

| Tool | `ask` | `acceptEdits` | `auto` | `full` |
| --- | --- | --- | --- | --- |
| `browser` | ask | ask | verifier | auto |
| `cli` | ask | ask | verifier | auto |
| `cli_runs` | auto | auto | auto | auto |
| `computer` | app approval | app approval | app approval | app approval |
| `write_skill` | auto | auto | auto | auto |
| `write_tool` | auto | auto | auto | auto |
| `write_plugin` | auto | auto | auto | auto |
| `run_tool` | ask | ask | verifier | auto |
| `memory` | auto | auto | auto | auto |
| `advisor` | auto | auto | auto | auto |
| `vision` | auto | auto | auto | auto |
| `web_search` | auto | auto | auto | auto |
| `plan` | auto | auto | auto | auto |
| `goal` | auto | auto | auto | auto |
| `threads` | auto | auto | auto | auto |
| `read_trace` | auto | auto | auto | auto |
| `context` | auto | auto | auto | auto |
| `keep` | auto | auto | auto | auto |
| `agents` | auto | auto | auto | auto |
| `secret` | ask | ask | verifier | auto |
| `install_mcp` | ask | ask | verifier | auto |
| `workflow` | ask | ask | verifier | auto |
| `autoresearch` | ask | ask | verifier | auto |
| `artifact` | auto | auto | auto | auto |
| `component` | auto | auto | auto | auto |
| `visualize` | auto | auto | auto | auto |

Seven tools use the ordinary gate: `browser`, `cli`, `run_tool`, `secret`,
`install_mcp`, `workflow`, `autoresearch`. `computer` requires a human app grant;
its `list_apps` action returns only running-app metadata without that grant.

Creating a component uses its ordinary tool gate, but sending a widget request
with credentials requires a separate native approval of the exact request
template in every mode. This is not approval of all future widget requests.
See [components.md](components.md).

`hidden` is not in the table: no mode hides a tool. It comes from a Settings →
Tools switch or an unknown name, checked first, and applies in every mode. A
hidden tool is never advertised and is refused if the model guesses the name.

`acceptEdits` is identical to `ask` for all 26 of Emma's own tools. The whole
difference between those two modes is on the harness's side: `onPermission` in
[main.ts](../desktop/main/main.ts) allows a harness `kind === "edit"` call
silently under `acceptEdits`, and asks for everything else.

## How `auto` works

App approval is excluded from the verifier path: `question(..., { humanOnly:
true })` always asks the user. Auto cannot approve app access or override a denial.

[verifier.ts](../desktop/main/verifier.ts) is the second model. It is deliberately
small — a 2.6B on a free route by default — configured in Settings → Models, with
its rules in `defaultVerifierSystem` and `PROHIBITED`
([settings.ts](../desktop/shared/settings.ts)).

It is shown the thread title, what the user asked, what the agent is doing, the
tool, the same summary a human would have seen, and the exact arguments
(`verifierPrompt`). Ceilings: `VERIFIER_TIMEOUT` 20 s, `VERIFIER_MAX_TOKENS` 700,
`MAX_ATTEMPTS` 3, `MAX_DETAIL_CHARS` 2 000. A normal OpenAI-shaped completion at
`temperature: 0`, `stream: false`; an empty `content` falls back to
`message.reasoning`, which is where a reasoning model on a free route leaves it.

`parseVerdict` strips `<think>` blocks, then takes a JSON object keyed on any of
`allow`, `allowed`, `safe`, `approve`, `approved`, `verdict`, `decision`,
`answer` — failing that, a bare leading word. `review()` never throws.

**A refusal is not a veto.** In `AgentRuntime.question`
([agent-loop.ts](../desktop/main/agent-loop.ts)) only `verdict.allow` runs the
call. A block, a timeout, a dead route or an unparseable reply all fall through to
the same dialog `ask` would have shown, with the verifier's reason appended under
an `[auto agent]` line. A broken verifier degrades `auto` to `ask`, never to
`full`.

Every review is recorded as a `kind: "verifier"` span carrying the whole prompt
and reply, readable in the inspector and by `read_trace`.

## Subagents inherit the mode

`spawnThread` passes `mode: turn.mode` down, so a child's calls hit this table
again. Delegation itself is the harness's `subagent` tool, where `permission_mode`
"inherits the caller when omitted and cannot exceed it". One plan wave hands out
at most `MAX_LIVE_SUBAGENTS = 8` briefs ([agents.ts](../desktop/shared/agents.ts)).

A computer grant covers only the active parent turn that asked for it.
Harness-delegated agents cannot call `computer`; the parent must perform app
actions. A separate thread turn cannot borrow the grant. This scope is stated in
the app approval dialog; each other app requires a separate grant.

## Where it is enforced

`toolGate` has two call sites, because a filtered list is not an enforced one —
the harness caches its catalog and the model can guess a name it was never
offered.

1. `toolDefinitions` ([tools.ts](../desktop/main/tools.ts)) drops `hidden` tools
   from the advertised catalog.
2. `runEmmaTool` ([main.ts](../desktop/main/main.ts)) checks the gate again when
   the call actually arrives, and raises the dialog on `ask` for ordinary tools.
   `computer` instead resolves the running app and requests explicit approval
   before reading its state or creating its app-bound helper.

Emma's tools are registered in the harness with `requires_approval = false`
([emma_tools.zig](../harness/src/builtins/emma_tools.zig)) precisely because Emma
gates them itself; a test asserts it for every one.

Every Emma mode maps to the harness's `ask` (`HARNESS_MODE_ID = "ask"` in
[harness.ts](../desktop/main/harness.ts)), so every harness tool decision comes
back to Emma. `onPermission` then resolves, in order:

1. `context.outsideWorkspace` → deny, and broadcast a `blocked: <tool> is outside
   the connected folder` step. Not overridable, `full` included.
2. `mode === "full"` → allow.
3. `mode === "acceptEdits" && kind === "edit"` → allow.
4. Otherwise → `agents.question(...)`, the same funnel `runEmmaTool` uses, so the
   verifier sits in front of the harness's tools too.

A denial picks the harness's reject option so the turn continues with a "no"
rather than being cancelled. `pick("allow_once", "allow_always")` prefers
`allow_once` by name, not list position, so an upstream reordering cannot turn one
yes into a session-wide grant. Emma's own dialog has no "allow always".

## The prompt

`PermissionAsk` is `{ id, threadId, tool, summary, detail }`
([agents.ts](../desktop/shared/agents.ts)). For ordinary tools, `summary` is the
short phrase from `describeToolCall`; `detail` is the pretty-printed arguments, capped at 4096
characters on both the Emma and harness paths. `install_mcp` renders its whole
`env` object, values included — its schema warns the model about that.

The dialog is `PermissionPrompt` ([agents.tsx](../desktop/src/agents.tsx)): a real
`<dialog>`, one question at a time, **Don't** and **Allow once**. Computer prompts
show the resolved app identity and **Allow for this turn**, with **Don't** focused
by default. Escape answers `false`. If neither the main window nor a paired
permission channel can receive the question, it is denied immediately.
`MAX_ASK_MS` is 10 minutes; timeout, cancellation and ended or replaced turns
settle `false`. A late answer cannot revive a request. An app denial is remembered
for the rest of the turn, so the model cannot repeatedly ask for the same app.

The renderer cannot bypass any of this: its whole permission vocabulary in
[preload.ts](../desktop/main/preload.ts) is `onPermissionAsk`,
`answerPermission({ id, allowed })` and `onPermissionResolved`. The last event
removes prompts resolved elsewhere or by cancellation. It cannot name a tool or
ask for one to run.
`emma:answer-permission` checks the sender is the main window's main frame before
looking at the payload, ids are `randomUUID()` and are deleted on first settle.

## Unattended runs carry their saved mode

A scheduled task stores its own `permissionMode`. `workflow` and `autoresearch`
offer three values, not four — `auto` needs a verifier the unattended path does
not run:

```
enum: ["ask", "acceptEdits", "full"]
```

Normalised through `asPermissionMode` on save and again at execution, which falls
back to `ask`. Nobody answers a question there, so `ask` declines every gated
call. See [jobs.md](jobs.md) and [autoresearch.md](autoresearch.md).

Saving Full access does not preapprove computer use. Unattended work cannot read
or control an app unless a user explicitly answers that turn's app prompt.

## What survives every mode

Nothing here consults the table, and `full` does not switch any of it off.

- **Escape.** While a computer run is live, main registers `Escape` as a
  *system-wide* shortcut that aborts the run and closes the banner — so it works
  while Emma is behind whatever app it is driving.
- **The run banner.** Always-on-top at the `screen-saver` level, visible on every
  workspace including fullscreen, `focusable: false`, carrying the step count and
  a Stop button. The main window and banner can send `emma:stop-computer-run`.
- **App grants.** Exact running-app approval, revoked on Stop, Escape, lock,
  suspend, turn end and quit. No persistent grant and no global-input fallback.
- **The ceilings.** `MAX_RUN_STEPS` 20,
  `MIN_ACTION_INTERVAL_MS` 40, `MAX_RUN_MS` 10 min, and the rest in
  [computer-use.md](computer-use.md). Tool argument and output caps in
  [tools.md](tools.md).
- **The workspace grant.** `context.outsideWorkspace` denies before any mode
  check.
- **Argument validation.** `parseToolArgs` runs on every call.
- **Accessibility.** Computer use cannot read or act on controls without the
  macOS Accessibility grant or the Windows UI Automation path. Screen Recording
  is separate and required for annotation capture, not for app-scoped computer
  use.
- **The action log.** Every call, and every verifier review, lands in the durable
  trace.

Plugin lifecycle hooks are not tool calls and never reach `GATES`: they are shell
commands the user reviewed once, pinned to a hash of the exact command text and
revoked the moment it changes ([plugins.md](plugins.md#trust)).

Two renderer actions deliberately skip the mode check because the click *is* the
consent: `emma:run-command` (the play button beside a command in the transcript,
bounded to 4096 characters) and `emma:send-cli-run` (sending a prompt into a CLI
run the user named).

## Lazy tool discovery is not a gate

Every harness mode opens advertising only `search_tools` and `select_tool`, with
the rest of the catalog behind a search
([tool_native_dispatch.zig](../harness/src/core/tooling/tool_native_dispatch.zig)).
That file says it outright: "a prompt-cost mechanism, not a security boundary". It
saves tokens and gates nothing.

## See also

- [tools.md](tools.md) — what each tool does, and the harness's own builtins
- [computer-use.md](computer-use.md) — app grants, background controls and Escape
- [privacy.md](privacy.md) — what leaves this computer
- [harness.md](harness.md) — `emma-cli`, ACP, and the permission channel
- [jobs.md](jobs.md) · [autoresearch.md](autoresearch.md) — unattended runs
- [models.md](models.md) — configuring the verifier and advisor routes
