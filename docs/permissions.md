# Permissions

What a turn is allowed to do without stopping to ask, and where that is enforced.
One table in [permissions.ts](../desktop/shared/permissions.ts) decides it for
every tool. The mode picker in the composer picks which column of that table a
run reads.

## The four modes

`PERMISSION_MODES` is `["ask", "acceptEdits", "auto", "full"]`. The
default is `ask` (`DEFAULT_PERMISSION_MODE`). Names, glyphs and hints are exactly
as they appear in [permissions.ts](../desktop/shared/permissions.ts) and exactly
what the picker renders:

| Glyph | Name | Mode id | Hint |
| --- | --- | --- | --- |
| ◈ | Ask | `ask` | Every write, command, and click asks first. |
| ◆ | Accept edits | `acceptEdits` | File writes and grep go through; other commands and the pointer still ask. |
| ⬗ | Auto | `auto` | A separate verifier model reads each gated call; anything it will not clear still asks you. |
| ⬥ | Full access | `full` | Nothing asks. Escape still stops a run. |

The picker lives in [agents.tsx](../desktop/src/agents.tsx) (`ModeMenu`,
`ModePicker`, `ModeTrigger`). The default for new threads is set in
Settings → "Default permission mode" ([App.tsx](../desktop/src/App.tsx)).

Changing the mode mid-run applies to the run in flight: the renderer sends
`emma:set-thread-context`, and main calls `agents.setMode(threadId, mode)`. A
turn already going follows the picker, not the mode it opened on.

## The three gate values

`toolGate(mode, tool, disabled)` returns one of three things:

| Gate | What happens |
| --- | --- |
| `hidden` | The tool is not advertised, and a call to it is refused if the model asks anyway. |
| `ask` | The call stops and a human (or, in `auto`, the verifier) has to say yes. |
| `auto` | The call goes through. |

`hidden` is the strong one:

> `hidden` is never advertised, so the model cannot even ask for it.

`hidden` is not a "no" the model can argue with or retry. The tool is missing
from the catalog, so there is no call to negotiate over and no dialog to click
through by habit. Today only a Settings → Tools switch and an unknown name reach
it; no mode hides a tool the user has left switched on.

Settings → Tools switches are checked in the same function, first:

```ts
export function toolGate(mode: PermissionMode, tool: string, disabled: readonly string[] = []): ToolGate {
  if (disabled.includes(tool)) return "hidden";
  const row = GATES[tool as AgentToolName];
  return row ? row[mode === "auto" ? "ask" : mode] : "hidden";
}
```

So a tool switched off in Settings is `hidden`, in every mode, both to the
catalog and to the refusal path. An unknown name is also `hidden` — there is
nothing to allow.

## The gate matrix

Every tool in `AGENT_TOOLS`, transcribed cell for cell from `GATES` in
[permissions.ts](../desktop/shared/permissions.ts). Rows are in `AGENT_TOOLS`
order.

| Tool | `ask` | `acceptEdits` | `full` |
| --- | --- | --- | --- |
| `read_file` | auto | auto | auto |
| `list_files` | auto | auto | auto |
| `ripgrep` | auto | auto | auto |
| `write_file` | ask | auto | auto |
| `bash` | ask | ask | auto |
| `background` | auto | auto | auto |
| `cli` | ask | ask | auto |
| `cli_runs` | auto | auto | auto |
| `computer` | ask | ask | auto |
| `write_skill` | auto | auto | auto |
| `write_tool` | auto | auto | auto |
| `write_plugin` | auto | auto | auto |
| `run_tool` | ask | ask | auto |
| `memory` | auto | auto | auto |
| `advisor` | auto | auto | auto |
| `vision` | auto | auto | auto |
| `web_fetch` | auto | auto | auto |
| `web_search` | auto | auto | auto |
| `plan` | auto | auto | auto |
| `threads` | auto | auto | auto |
| `read_trace` | auto | auto | auto |
| `context` | auto | auto | auto |
| `save_page` | auto | auto | auto |
| `agents` | auto | auto | auto |
| `install_mcp` | ask | ask | auto |
| `workflow` | ask | ask | auto |
| `autoresearch` | ask | ask | auto |
| `artifact` | auto | auto | auto |
| `visualize` | auto | auto | auto |

Reading the table sideways:

- **Free in every mode** — `read_file`, `list_files`, `ripgrep`, `cli_runs`,
  `advisor`, `vision`, `web_fetch`, `web_search`, `threads`, `read_trace`,
  `context`, `agents`, `visualize`. Reads are free everywhere: a folder grant is
  already the user saying yes to that folder.
- **Never asks, though it writes** — `background`, `write_skill`, `write_tool`,
  `write_plugin`, `memory`, `save_page`, `plan`, `artifact`. These write, but only
  into Emma's own data folder or the user's knowledge base, never into a file the
  user owns.
- **Asks in `ask`, free in `acceptEdits`** — `write_file`, alone. That is the
  whole difference between the two modes.
- **Asks in `ask` and in `acceptEdits`** — `bash`, `cli`, `run_tool`, `computer`,
  `install_mcp`, `workflow`, `autoresearch`. `acceptEdits` promises
  edits, not commands, and each of these runs a program: `run_tool` runs a script
  in the connected folder, `cli` hands the folder to another coding agent,
  `install_mcp` puts one on the list the harness launches, `workflow` and
  `autoresearch` hand out agent turns that run later with nobody watching.
- **Free in `full`** — everything. Nothing asks.

`ripgrep` is `auto` everywhere because it runs one bundled binary with no shell.
There is a related helper, `isBareGrep`, which recognises a lone `grep` with no
shell operators (`SHELL_OPERATORS` is ``/[;&|<>$`(){}\r\n]/``). It is exported
and tested, but has no production caller on this branch — do not rely on a
bare-`grep` carve-out existing today.

## Why `auto` has no column

`GATES` is typed `Record<AgentToolName, Record<GatedMode, ToolGate>>`, where
`GatedMode = Exclude<PermissionMode, "auto">`. `auto` reads `ask`'s column:

```ts
return row ? row[mode === "auto" ? "ask" : mode] : "hidden";
```

The comment above the type says why:

> `auto` has no column of its own: it reads `ask`'s, and the question goes to the
> verifier model instead of to the user. One column, so the two can never drift —
> whatever asks a person in `ask` is exactly what a verifier is asked to clear.

So `auto` is not a looser mode than `ask`. It gates exactly the same calls; it
changes only *who gets asked first*.

## The verifier

[verifier.ts](../desktop/main/verifier.ts) is the second model `auto` mode routes
gated calls to. It is deliberately small — the file's own words: "a 2.6B on a free
route by default". It is configured in Settings → Models; its rules live in
`defaultVerifierSystem` and `PROHIBITED` in
[settings.ts](../desktop/shared/settings.ts) and are editable there.

What it is shown, from `verifierPrompt()`:

- `Thread: <thread title>`
- `The user asked: <goal>`
- `The agent is currently: <activity>`
- `Proposed action: <tool>`
- `Summary: <summary>` — the same phrase a human would have seen
- `Exactly what it will run:\n<detail>`, or `It carries no further arguments.`
- `Is it safe to run this now? Answer with the JSON line.`

Ceilings: `VERIFIER_TIMEOUT = 20_000` ms, `VERIFIER_MAX_TOKENS = 700`,
`MAX_ATTEMPTS = 3`, `MAX_DETAIL_CHARS = 2_000`. The request is a normal
OpenAI-shaped chat completion at `temperature: 0`, `stream: false`, with
`authorization: Bearer <key>`; if `content` comes back empty it falls back to
`message.reasoning`, which is what a reasoning model on a free route tends to
fill instead.

`parseVerdict()` strips `<think>` blocks, then accepts a JSON object keyed on any
of `allow`, `allowed`, `safe`, `approve`, `approved`, `verdict`, `decision` or
`answer` — and failing that, a bare leading word. `review()` never throws; a
malformed reply is quoted back and retried, up to `MAX_ATTEMPTS`.

**A refusal is not a veto.** In `AgentRuntime.question`
([agent-loop.ts](../desktop/main/agent-loop.ts)):

```ts
if (run?.mode === "auto") {
  const review = await this.reviewed(run, ask);
  if (review.verdict?.allow) return true;
  const said = review.verdict ? `blocked this: ${review.verdict.reason || "no reason given"}` : `could not answer: ${review.error ?? "no verdict"}`;
  ask = { ...ask, detail: `${ask.detail}\n\n[auto agent] ${said}` };
}
```

A clear "allow" runs the call. Anything else — a block, a timeout, a broken
route, an unparseable reply — falls through to the same dialog `ask` mode would
have shown, with the verifier's reason appended to the detail under an
`[auto agent]` line. So a broken verifier degrades `auto` to `ask`, never to
`full`.

Every review is recorded as a `kind: "verifier"` span and step carrying the whole
prompt and reply, so it is readable afterwards in the inspector and by
`read_trace`. The span names are `auto agent · reviewing`, then one of
`auto agent approved`, `auto agent blocked` or `auto agent could not answer`.

## Subagents inherit the mode

A child inherits the parent's mode, so its writes and commands hit this table
again rather than escaping through the spawn.

Delegation is the harness's tool, not Emma's, so it is gated there instead:
`permission_mode` on a `subagent` `create` "inherits the caller when omitted and
cannot exceed it". Spawning is not itself a change to the Mac, and the child
cannot do anything the parent could not. `spawnThread` in
[agent-loop.ts](../desktop/main/agent-loop.ts) passes `mode: turn.mode` down, and
`threads spawn` is gated the same way for the same reason.

How many children run at once is the harness's to decide. What Emma still caps is
the plan: one wave hands out at most `MAX_LIVE_SUBAGENTS = 8` briefs
([agents.ts](../desktop/shared/agents.ts)).

## Where the gate is enforced

`toolGate` has two production call sites.

**1. The advertised catalog** — [tools.ts](../desktop/main/tools.ts):

```ts
export function toolDefinitions(mode: PermissionMode, available: ToolAvailability, disabled: readonly string[] = []): ToolDefinition[] {
  return DEFINITIONS
    .filter((tool) => toolGate(mode, tool.name, disabled) !== "hidden")
    .filter((tool) => tool.needs === "always" || available[tool.needs])
    .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}
```

**2. The refusal** — `runEmmaTool` in [main.ts](../desktop/main/main.ts), which
is what actually runs one of Emma's own tools when the harness asks for it:

```ts
const gate = toolGate(turn.mode, name, toolSettings.disabledTools);
if (gate === "hidden") {
  throw new Error(`${wireName} is not available in ${turn.mode} mode, or is switched off in Settings → Tools.`);
}
```

then, for the `ask` cells:

```ts
if (gate === "ask") {
  const allowed = await agents!.question({
    threadId,
    tool: name,
    summary: describeToolCall(parsed),
    detail: JSON.stringify(args, null, 2).slice(0, 4096),
  });
  if (!allowed) throw new Error(`The user did not allow ${wireName} to run. Do not try it again this turn; say what you needed it for instead.`);
}
```

Two sites rather than one because a filtered list is not an enforced one — the
harness caches its catalog and the model can guess a name it was never offered.

### The other half: the harness's own tools

After the fx migration the agent loop lives in the harness (`emma-cli acp`, see
[harness.md](harness.md)). Emma's own tools are registered there as native tools
and called back into Electron over `_emma/callTool`; that is the `runEmmaTool`
path above. The harness's *own* tools — its file tools, its terminal — run in the
harness process and are gated over the ACP permission channel instead.

Emma's native tools are registered with `requires_approval = false`
([emma_tools.zig](../harness/src/builtins/emma_tools.zig)), because Emma gates
them itself at execution. A test asserts it for every one of them, with the
reason: "Emma applies its own gate when it runs the call, so a harness prompt
would be a second one for the same decision."

The mode id sent to the harness is a constant in
[harness.ts](../desktop/main/harness.ts):

```ts
export const HARNESS_MODE_ID = "ask";
```

Every Emma mode maps to the harness's `ask`, so every decision comes back to
Emma. Two of them look like they should map straight through, and both were
unsafe: `acceptEdits` → harness `auto` does not check the granted folder at all,
and `full` → harness `yolo` has no floor whatsoever, where Emma's `full` still
enforces the sandbox.

The decision then lands in `onPermission` in [main.ts](../desktop/main/main.ts),
in this order:

1. `context.outsideWorkspace` → deny, with a
   `blocked: <tool> is outside the connected folder` step broadcast to the
   thread. This one is **not** a prompt the user can override. The workspace
   check is Electron's because the harness does not know a grant exists;
   `callEscapesWorkspace` / `escapesRoot` in
   [harness.ts](../desktop/main/harness.ts) realpath the root and resolve the
   target's deepest existing ancestor, and an unresolvable path counts as an
   escape. `PATH_FIELDS` is `["path", "paths", "old_path", "new_path", "source", "destination", "cwd"]`.
2. `mode === "full"` → allow.
3. `mode === "acceptEdits" && kind === "edit"` → allow. Only file mutations pass
   silently; anything else still asks.
4. Otherwise → `agents.question(...)`, which is the same funnel `runEmmaTool`
   uses, so `auto` mode's verifier sits in front of the harness's tools too.

A denial picks the harness's own reject option so the turn continues with a "no"
rather than being cancelled, which would lose everything before it. From
[harness.ts](../desktop/main/harness.ts): "A refused or unanswered question is a
denial, never a silent allow."

### The IPC boundary

The renderer cannot bypass any of this, because it has no tool-execution IPC at
all. Its entire permission vocabulary in
[preload.ts](../desktop/main/preload.ts) is two verbs:

```ts
answerPermission: (value: { id: string; allowed: boolean }) => ipcRenderer.send("emma:answer-permission", value),
onPermissionAsk: (handler) => /* listens on "emma:permission-ask" */,
```

It can listen for a question, and it can send back an `allowed` boolean for an id
main handed it. It cannot invent an id, cannot name a tool, and cannot ask for
one to be run.

The receiving handler in [main.ts](../desktop/main/main.ts) checks the sender
before it looks at the payload:

```ts
ipcMain.on("emma:answer-permission", (event, value: unknown) => {
  if (event.senderFrame !== event.sender.mainFrame || event.sender !== mainWindow?.webContents) return;
  if (!value || typeof value !== "object") return;
  const answer = value as Record<string, unknown>;
  if (typeof answer.id !== "string" || typeof answer.allowed !== "boolean") return;
  agents!.answer(answer.id, answer.allowed);
});
```

Only the main window's main frame, only a well-formed `{ id, allowed }`. Ids are
`randomUUID()` and are deleted on first settle, so an answer cannot be replayed.
`emma:stop-agent` is accepted from `mainWindow` or the run banner and nowhere
else.

The general host channel is allow-listed the same way:
[ipc.ts](../desktop/main/ipc.ts) holds a table of 33 methods with their required
and optional string fields, and `validateRequest` rejects an unknown method,
a non-string param, an extra key, an over-length value, a blank value, or a
request over `MAX_HOST_REQUEST_BYTES` (128 KiB). `trustedSender` pins the sender
to `file://<appRoot>/dist-renderer/index.html` or the dev server origin.

Two renderer actions are deliberately allowed without a mode check, because the
click *is* the consent:

- `emma:run-command` — the play button beside a command in the transcript.
  "Pressing play is the permission." Bounded to 4096 characters by
  `runCommandRequest`.
- `emma:send-cli-run` — sending a prompt into a CLI run the user named. "Naming
  the run and pressing send is the consent."

## Unattended runs carry their saved mode

A scheduled task stores its own `permissionMode` and runs under it later with
nobody watching. The `workflow` tool's schema
([tools.ts](../desktop/main/tools.ts)) offers three values, not four — `auto`
needs a verifier the unattended path does not run:

```ts
permissionMode: { type: "string", enum: ["ask", "acceptEdits", "full"], description: "What the unattended run may do. Nobody is there to answer a question, so \"ask\" declines every gated call." }
```

`autoresearch` carries the same field, with its own note: "Nobody is watching, so
`ask` declines every gated call — a job that edits files needs `acceptEdits` at
least."

The field is normalised through `asPermissionMode` on save
([ipc.ts](../desktop/main/ipc.ts) lists `permissionMode` among
`saveScheduledJob`'s fields) and again on execution — `runScheduledWorkflow` in
[main.ts](../desktop/main/main.ts) does `const mode = asPermissionMode(job.permissionMode)`
and passes it into `driveTurn`. `asPermissionMode` falls back to
`DEFAULT_PERMISSION_MODE`, which is `ask`.

A question raised with nobody there does not hang forever and does not pass:
`MAX_ASK_MS` is `10 * 60 * 1000`, and the timeout settles the promise as `false`.
If there is no main window at all, main answers `false` immediately. See
[jobs.md](jobs.md) and [autoresearch.md](autoresearch.md).

## The harness's own modes

The harness has four modes in
[modes.zig](../harness/src/builtins/modes.zig), matched to Emma's picker, with
`default_mode_id = "ask"`:

| Id | Name | Description | Internal mode |
| --- | --- | --- | --- |
| `plan` | Plan | Read and reason, change nothing | `.ask`, `read_only` tool policy |
| `ask` | Ask | Request permission before making any changes | `.ask` |
| `acceptEdits` | Accept edits | Edit files without asking, but ask before running anything | `.auto` |
| `full` | Full | Run unattended, asking for nothing | `.yolo` |

Emma selects only `ask` of these. The harness keeps its own `plan` mode for its
TUI; Emma's picker dropped it, because a mode that hides `terminal` and
`write_file` has no way back out to executing the plan it just wrote. Planning in
Emma is the `plan` tool instead — write the steps, run a wave of subagents,
record what each returned — which needs a mode that can act.

## What a permission prompt carries

The payload is `PermissionAsk` in [agents.ts](../desktop/shared/agents.ts):

```ts
type PermissionAsk = { id: string; threadId: string; tool: string; summary: string; detail: string };
```

`summary` is the short human phrase from `describeToolCall`
([tools.ts](../desktop/main/tools.ts)) — `running npm test`, `writing src/app.ts`,
`installing the github MCP server`, `left click`. `detail` is the argument worth
reading before approving.

Where the detail comes from depends on which side raised the question:

- **Emma's own tools** (`runEmmaTool`): `JSON.stringify(args, null, 2).slice(0, 4096)` —
  the raw call as the model sent it, pretty-printed. So an `install_mcp` prompt
  shows the `name`, the `command`, the `args` array and the `env` object as
  written.
- **The harness's tools** (`handlePermission` in
  [harness.ts](../desktop/main/harness.ts)): the ACP request's `rawInput`, either
  the string itself or `JSON.stringify(call.rawInput ?? {}, null, 2).slice(0, 4096)`.
  A `file_mutation` title is replaced with `describePath(rawInput)` so the prompt
  names the file rather than the category.

Both are capped at 4096 characters.

`install_mcp`'s own schema warns the model about the environment object:
"Environment variables the server needs. Values are stored on this Mac and appear
in this transcript, so ask the user before putting a secret here." On this branch
the prompt renders the whole `env` object, values included — an earlier
`detailOf()` helper that printed only the sorted key names was removed with the
old agent loop. Treat the prompt as showing everything the call carries.

The dialog itself is `PermissionPrompt` in
[agents.tsx](../desktop/src/agents.tsx): a real `<dialog>` modal, one question at
a time, oldest first. The header is `<agent title or "Emma"> · <mode name>`, then
`<h2>{ask.summary}</h2>`, then `<pre className="permission-detail">{ask.detail}</pre>`,
then two buttons — **Don't** and **Allow once** (which takes focus). `onCancel`,
which is Escape, answers `false`. Only the main window can answer, so main calls
`needsYou("Emma needs your approval", request.summary)` first to raise it — a run
started from the overlay still gets its question in front of you. If the main
window does not exist, main answers `false` on the spot.

There is no "allow always" in Emma's dialog. When the harness offers
`allow_always`, `pick("allow_once", "allow_always")` prefers `allow_once`, in
that order, deliberately — kinds are preferred by name rather than by list
position so an upstream reordering cannot turn a single yes into a session-wide
grant.

## What survives every mode

These do not consult the table, and `full` does not switch them off.

**Escape.** While a computer-use run is going, main registers a system-wide
shortcut ([main.ts](../desktop/main/main.ts)):

```ts
if (!globalShortcut.isRegistered("Escape")) globalShortcut.register("Escape", () => {
  computerRuntime?.abort("stopped by the user");
  closeRunBanner();
});
```

It is registered globally, so it works while Emma is behind whatever app it is
driving. `full`'s own hint says so: "Nothing asks. Escape still stops a run."

**The run banner.** An always-on-top window that appears for the length of a
computer-use run: frameless, transparent, 520 px wide at most and 76 px tall,
`focusable: false`, `alwaysOnTop` at the `"screen-saver"` level, and visible on
every workspace including fullscreen ones. It carries the step count against
`MAX_RUN_STEPS`, and it is one of only two senders `emma:stop-agent` accepts.

**The ceilings.** Computer use, from [computer.ts](../desktop/main/computer.ts):

| Ceiling | Value |
| --- | --- |
| `MAX_RUN_STEPS` | 20 |
| `MAX_RUN_ACTIONS` | 400 |
| `MAX_RUN_MS` | `10 * 60_000` |
| `MAX_TYPED_CHARACTERS` | 4096 |
| `MAX_WAIT_SECONDS` | 300 |
| `MAX_KEY_REPEAT` | 32 |
| `MAX_HELPER_LINE_BYTES` | `8 * 1024` |

Tool arguments and output, from [tools.ts](../desktop/main/tools.ts):

| Ceiling | Value |
| --- | --- |
| `MAX_COMMAND_CHARS` | 4096 |
| `MAX_TASK_PROMPT_CHARS` | 8192 |
| `MAX_CLI_PROMPT_CHARS` | `32 * 1024` |
| `MAX_WORKFLOW_NODE_CHARS` | `32 * 1024` |
| `MAX_TOOL_OUTPUT_BYTES` | `16 * 1024` |
| `MAX_ADVERTISED_TOOLS` | 32 |
| `MAX_TRACES_READ` | 8 |
| `MAX_MESSAGES_READ` | 60 |

Shell commands are killed at `MAX_COMMAND_MS` (120 000 ms) with their output cut
at `MAX_COMMAND_OUTPUT` (16 KiB) ([main.ts](../desktop/main/main.ts)).

**The workspace grant.** `context.outsideWorkspace` denies before any mode check,
including `full`.

**Argument validation.** `parseToolArgs` runs on every call regardless of mode,
and its refusals are written for the model to act on rather than for a log.

**Screen Recording.** `captureDisplay` refuses outright when macOS has not
granted it, in any mode: "Screen Recording permission is required. Enable Emma in
System Settings → Privacy & Security → Screen Recording."

**Plugin hooks.** A plugin's lifecycle hooks are not tool calls and never reach
`GATES`: they are shell commands the user reviewed once, running at fixed moments
in a turn. Their gate is trust, pinned to a hash of the exact command text and
revoked the moment it changes ([plugins.md](plugins.md#trust)).

**The log.** Every call lands in the durable trace, readable in the inspector and
by `read_trace`, including every verifier review.

Settings → Privacy states the same contract in the product's own words: "Every
run is gated by the mode picker … *Ask* and *Accept edits* stop
for your yes on every call, *Auto* sends the call to your verifier model, and
*Full access* lets it through. The step ceiling, the action rate limit, the
on-screen banner, and the Escape kill switch apply in every mode, and every
action is logged."

## Lazy tool discovery is not a gate

Every harness mode opens advertising only `search_tools` and `select_tool`; the
rest of the catalog waits behind a search
([tool_native_dispatch.zig](../harness/src/core/tooling/tool_native_dispatch.zig)).
That file says outright that this is "a prompt-cost mechanism, not a security
boundary". It saves tokens. It gates nothing. The gate is `GATES`.

## See also

- [tools.md](tools.md) — what each gated tool actually does
- [computer-use.md](computer-use.md) — the pointer, the banner, and Escape
- [jobs.md](jobs.md) — scheduled tasks and their saved mode
- [autoresearch.md](autoresearch.md) — the long experiment loop and its budgets
- [models.md](models.md) — configuring the verifier and advisor routes
- [privacy.md](privacy.md) — what leaves this Mac
- [harness.md](harness.md) — `emma-cli`, ACP, and the permission channel
- [cli.md](cli.md) — driving the user's other coding CLIs
- [architecture.md](architecture.md) — process boundaries and the trust model
- [concepts.md](concepts.md) — thread, run, subagent, mode
- [getting-started.md](getting-started.md) — the macOS permissions Emma asks for
- [knowledge.md](knowledge.md) · [notch.md](notch.md) · [voice.md](voice.md)
- [development.md](development.md) · [data.md](data.md) · [plugins.md](plugins.md)
- [troubleshooting.md](troubleshooting.md) — when a prompt does not appear
