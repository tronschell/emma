# Permissions

What a turn is allowed to do without stopping to ask, and where that is enforced.
One table in [permissions.ts](../desktop/shared/permissions.ts) answers the
question for every tool; the mode picker in the composer chooses which column of
it a run reads.

## The five modes

`PERMISSION_MODES` is `["plan", "ask", "acceptEdits", "auto", "full"]`. The
default is `ask` (`DEFAULT_PERMISSION_MODE`). Names, glyphs and hints are exactly
as they appear in [permissions.ts](../desktop/shared/permissions.ts) and exactly
what the picker renders:

| Glyph | Name | Mode id | Hint |
| --- | --- | --- | --- |
| ◇ | Plan | `plan` | Reads and subagents only. Nothing on this Mac changes. |
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

`hidden` is the strong one. The source says it plainly:

> `hidden` is never advertised, so the model cannot even ask for it.

The significance is that `hidden` is not a "no" the model can argue with or
retry — the tool is absent from the catalog, so there is no call to negotiate
over and no dialog for a user to click through by habit. That is what makes
`plan` mode a real promise rather than a strongly worded request: in `plan`,
`write_file`, `bash`, `computer`, `install_mcp` and the rest are not options that
get denied, they are options that do not exist.

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

| Tool | `plan` | `ask` | `acceptEdits` | `full` |
| --- | --- | --- | --- | --- |
| `read_file` | auto | auto | auto | auto |
| `list_files` | auto | auto | auto | auto |
| `ripgrep` | auto | auto | auto | auto |
| `write_file` | hidden | ask | auto | auto |
| `bash` | hidden | ask | ask | auto |
| `background` | hidden | auto | auto | auto |
| `cli` | hidden | ask | ask | auto |
| `cli_runs` | auto | auto | auto | auto |
| `computer` | hidden | ask | ask | auto |
| `write_skill` | hidden | auto | auto | auto |
| `write_tool` | hidden | auto | auto | auto |
| `run_tool` | hidden | ask | ask | auto |
| `memory` | hidden | auto | auto | auto |
| `advisor` | auto | auto | auto | auto |
| `vision` | auto | auto | auto | auto |
| `web_fetch` | auto | auto | auto | auto |
| `web_search` | auto | auto | auto | auto |
| `task` | auto | auto | auto | auto |
| `plan` | hidden | auto | auto | auto |
| `threads` | auto | auto | auto | auto |
| `read_trace` | auto | auto | auto | auto |
| `context` | auto | auto | auto | auto |
| `save_page` | hidden | auto | auto | auto |
| `mcp_tool` | hidden | ask | ask | auto |
| `agents` | auto | auto | auto | auto |
| `install_mcp` | hidden | ask | ask | auto |
| `workflow` | hidden | ask | ask | auto |
| `autoresearch` | hidden | ask | ask | auto |
| `artifact` | hidden | auto | auto | auto |
| `visualize` | auto | auto | auto | auto |

Reading the table sideways:

- **Free in every mode, including `plan`** — `read_file`, `list_files`,
  `ripgrep`, `cli_runs`, `advisor`, `vision`, `web_fetch`, `web_search`, `task`,
  `threads`, `read_trace`, `context`, `agents`, `visualize`. Reads are free
  everywhere: a folder grant is already the user saying yes to that folder.
- **Never asks, but hidden in `plan`** — `background`, `write_skill`,
  `write_tool`, `memory`, `save_page`, `plan`, `artifact`. These write, but only
  into Emma's own data folder or the user's knowledge base, never into a file the
  user owns. In `plan`, where the promise is that nothing at all happens, they
  are not offered.
- **Asks in `ask`, free in `acceptEdits`** — `write_file`, alone. That is the
  whole difference between the two modes.
- **Asks in `ask` and in `acceptEdits`** — `bash`, `cli`, `run_tool`, `computer`,
  `mcp_tool`, `install_mcp`, `workflow`, `autoresearch`. `acceptEdits` promises
  edits, not commands, and each of these runs a program: `run_tool` runs a script
  in the connected folder, `cli` hands the folder to another coding agent,
  `install_mcp` starts a process, `workflow` and `autoresearch` hand out agent
  turns that run later with nobody watching.
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

The comment above `GATES` states the rule:

> `task` is free too — a subagent inherits this same mode, so its own writes and
> commands hit this table again rather than escaping through the spawn.

That is why `task` is `auto` in every column, including `plan`: spawning is not
itself a change to the Mac, and the child cannot do anything the parent could
not. `spawnThread` in [agent-loop.ts](../desktop/main/agent-loop.ts) passes
`mode: turn.mode` down, and `threads spawn` is gated the same way for the same
reason.

Two extra limits on top:

- `ToolAvailability.canSpawn` is false inside a subagent
  ([tools.ts](../desktop/main/tools.ts)), so a subagent cannot spawn another.
- `runThreadsTool` refuses `spawn` and `message` outright in `plan` mode, even
  though the `threads` row is `auto` — the read-only halves (`list`, `read`,
  `rename`) stay available, and the halves that put an agent to work do not.

Live subagents are capped at `MAX_LIVE_SUBAGENTS = 8`
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

Mode ids are mapped in [harness.ts](../desktop/main/harness.ts):

```ts
const MODE_IDS: Record<PermissionMode, string> = {
  plan: "plan",
  ask: "ask",
  acceptEdits: "ask",
  auto: "ask",
  full: "ask",
};
```

Every mode that can change something maps to the harness's `ask`, so every
decision comes back to Emma. The two identity mappings that look natural were
both unsafe and were removed: `acceptEdits` → harness `auto` does not check the
granted folder at all, and `full` → harness `yolo` has no floor whatsoever, where
Emma's `full` still enforces the sandbox.

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
([tools.ts](../desktop/main/tools.ts)) offers four values, not five:

```ts
permissionMode: { type: "string", enum: ["plan", "ask", "acceptEdits", "full"], description: "What the unattended run may do. Nobody is there to answer a question, so \"ask\" declines every gated call." }
```

`autoresearch` carries the same field, with its own note: "Nobody is watching, so
\"ask\" declines every gated call — a job that edits files needs \"acceptEdits\"
at least."

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

## `EMMA_MODE` for the terminal command

The standalone `emma` command is a bash script, [agent/emma](../agent/emma). It
reads the same mode names except `auto`:

```bash
mode="${EMMA_MODE:-ask}"
[ -n "${EMMA_YOLO:-}" ] && mode=full
case $mode in
  plan | ask | acceptEdits | full) ;;
  *) echo "EMMA_MODE must be plan, ask, acceptEdits, or full" >&2; exit 1 ;;
esac
```

`auto` is absent because there is no verifier in that script and no window to
fall back to. What each mode does there:

- `plan` advertises no tools at all.
- `ask` prompts `run it? [y/N]` on `/dev/tty`.
- `acceptEdits` and `full` run the command.

It has one tool, `bash`, its output is cut at `head -c 16000`, and `max_steps` is
120. `EMMA_YOLO` set to anything forces `full`. `EMMA_MODE` appears in this script
and nowhere else — not in `agent/src/main.zig`, not in
[cli.ts](../desktop/main/cli.ts). See [cli.md](cli.md).

The harness has its own four modes in
[modes.zig](../harness/src/builtins/modes.zig), matched to Emma's picker, with
`default_mode_id = "ask"`:

| Id | Name | Description | Internal mode |
| --- | --- | --- | --- |
| `plan` | Plan | Read and reason, change nothing | `.ask`, `read_only` tool policy |
| `ask` | Ask | Request permission before making any changes | `.ask` |
| `acceptEdits` | Accept edits | Edit files without asking, but ask before running anything | `.auto` |
| `full` | Full | Run unattended, asking for nothing | `.yolo` |

Plan mode's denial message there is: "Plan mode is read-only. Say what you would
do, and the user can switch modes to let you do it." Because of `MODE_IDS` above,
Emma only ever selects `plan` or `ask` of these.

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

**The log.** Every call lands in the durable trace, readable in the inspector and
by `read_trace`, including every verifier review.

Settings → Privacy states the same contract in the product's own words: "Every
run is gated by the mode picker … *Plan* hides it, *Ask* and *Accept edits* stop
for your yes on every call, *Auto* sends the call to your verifier model, and
*Full access* lets it through. The step ceiling, the action rate limit, the
on-screen banner, and the Escape kill switch apply in every mode, and every
action is logged."

## Note on lazy tool discovery

Every harness mode opens advertising only `search_tools` and `select_tool`; the
rest of the catalog waits behind a search
([tool_native_dispatch.zig](../harness/src/core/tooling/tool_native_dispatch.zig)).
That file says outright that this is "a prompt-cost mechanism, not a security
boundary" — it saves tokens, it does not gate anything. The gate is `GATES`.

## See also

- [tools.md](tools.md) — what each gated tool actually does
- [computer-use.md](computer-use.md) — the pointer, the banner, and Escape
- [jobs.md](jobs.md) — scheduled tasks and their saved mode
- [autoresearch.md](autoresearch.md) — the long experiment loop and its budgets
- [models.md](models.md) — configuring the verifier and advisor routes
- [privacy.md](privacy.md) — what leaves this Mac
- [harness.md](harness.md) — `emma-cli`, ACP, and the permission channel
- [cli.md](cli.md) — `EMMA_MODE` and the terminal front ends
- [architecture.md](architecture.md) — process boundaries and the trust model
- [concepts.md](concepts.md) — thread, run, subagent, mode
- [getting-started.md](getting-started.md) — the macOS permissions Emma asks for
- [knowledge.md](knowledge.md) · [notch.md](notch.md) · [voice.md](voice.md)
- [development.md](development.md) · [data.md](data.md) · [plugins.md](plugins.md)
- [troubleshooting.md](troubleshooting.md) — when a prompt does not appear
