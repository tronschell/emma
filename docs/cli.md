# The command line

Two unrelated things in Emma answer to "CLI":

- the **`cli` and `cli_runs` tools**, which drive *someone else's* coding CLI in a connected folder — most of this page;
- **`emma-cli`**, the agent Emma itself runs, which also works from a terminal.

## `emma-cli` from a terminal

The same binary that runs every Emma turn. A packaged macOS app has it at
`Emma.app/Contents/Resources/emma-cli`; a Windows package keeps `emma-cli.exe`
under its `resources/` directory. A checkout builds it to
`harness/zig-out/bin/emma-cli` on macOS or `harness/zig-out/bin/emma-cli.exe`
on Windows with `npm --prefix desktop run build:harness`.

```bash
emma-cli ask "write a fizzbuzz in python"   # one shot
emma-cli                                    # a REPL in the current directory
emma-cli sessions
emma-cli session resume last
```

The current directory is its workspace, and it gates a tool call on the tty
rather than through Emma's permission channel. Only the REPL needs a console:
`--help`, `--version`, `ask`, `sessions`, and `acp` run the same over pipes or
redirected output, which is how Emma drives `acp` over stdio. It is Emma's fork
of [vercel-labs/fx](https://github.com/vercel-labs/fx) (Apache-2.0; provenance
in [FORK.md](../harness/FORK.md)) — its own surface is
[harness/README.md](../harness/README.md), and how Emma drives it is
[harness.md](harness.md).

## `cli` and `cli_runs`

Emma does not reimplement Claude Code or Codex. It runs the one you already
have, in the thread's folder, shows the terminal live, and feeds it the next
prompt. These harnesses are other people's work:

| id | Label | Binary | Starts with | Resumes with | Unattended flag | Owns its session |
| --- | --- | --- | --- | --- | --- | --- |
| `claude` | [Claude Code](https://github.com/anthropics/claude-code) | `claude` | `--print --session-id <uuid> <prompt>` | `--print --resume <uuid> <prompt>` | `--dangerously-skip-permissions` | yes |
| `codex` | [Codex](https://github.com/openai/codex) | `codex` | `exec --color never <prompt>` | `exec --color never resume --last <prompt>` | `--dangerously-bypass-approvals-and-sandbox` | no |
| `pi` | [Pi](https://pi.dev) | `pi` | `--print --session-id <uuid> <prompt>` | `--print --session-id <uuid> <prompt>` | none | yes |
| `opencode` | [OpenCode](https://github.com/sst/opencode) | `opencode` | `run <prompt>` | `run --continue <prompt>` | `--auto` | no |
| `gemini` | [Gemini CLI](https://geminicli.com) | `gemini` | `--prompt <prompt>` | `--resume latest --prompt <prompt>` | `--approval-mode=yolo` | no |
| `antigravity` | [Antigravity CLI](https://antigravity.google/docs/cli/headless/) | `agy` | `--print <prompt>` | `--continue --print <prompt>` | `--dangerously-skip-permissions` | no |
| `cursor` | [Cursor CLI](https://docs.cursor.com/en/cli/overview) | `cursor-agent` | `--print <prompt>` | `--print --resume <prompt>` | `--force` | no |

The catalog is [shared/cli.ts](../desktop/shared/cli.ts). Each harness supplies
its native arguments and thinking options. Every row accepts an optional model
as `--model <id>`. Emma owns Claude and Pi session identifiers; other adapters
currently resume the newest conversation in the folder, even where the vendor
also supports explicit session ids. Emma prevents resuming an obsolete run.

Claude, Codex, Pi, and OpenCode flags were checked against installed CLIs.
Antigravity, Gemini, and Cursor are documented adapters, not locally installed
end-to-end integrations on the verification machine.

### How a run works

[main/cli.ts](../desktop/main/cli.ts) owns the processes. A **run is a
conversation**, not a command: the child exits at the end of a turn and the run
goes `idle`, holding its transcript and session id until the next prompt resumes
it.

| | |
| --- | --- |
| Finding the binary | macOS uses `/bin/bash -lc command -v <bin>` and caches the result; Windows searches the inherited `PATH` with its executable extensions. The resolved path is handed to every child |
| Spawning | `detached: true`, `stdio: ["ignore", "pipe", "pipe"]`, own process group, so Stop takes whatever the CLI forked. macOS uses SIGTERM then SIGKILL after 2 s; Windows uses `taskkill` for the process tree |
| Pipes, not a pty | Every CLI here has a non-interactive mode. A pty would mean node-pty plus a terminal emulator in the renderer |
| Output | stdout and stderr merged, capped at `MAX_OUTPUT` 256 KiB, oldest bytes dropped. `terminalText` strips CSI/OSC/two-byte ANSI escapes and applies carriage returns, so a spinner reads correctly. Not an emulator: a CLI that addresses the cursor to redraw a box needs a real one |
| Repaints | coalesced to one every 120 ms (`NOTIFY_EVERY_MS`) |
| Limits | `MAX_RUNS` 12, and only finished ones are dropped. A turn silent for `MAX_TURN_MS` (30 minutes) is stopped as wedged |
| A failed spawn | recorded as `failed` with the message in the transcript, not thrown |

Nothing reaching the renderer carries a process handle: `snapshot()` rebuilds the
record field by field.

### The tools

**`cli`** — needs a connected folder. Gated `ask` in every mode but `full`.

| Argument | |
| --- | --- |
| `action` | `run` or `send`. Defaults to `run` |
| `cli` | `claude`, `codex`, `pi`, `opencode`, `gemini`, `cursor`, `antigravity`. Required for `run` |
| `id` | The run to continue. Required for `send` |
| `prompt` | The whole instruction — the CLI sees the folder, never Emma's conversation. Capped at `MAX_CLI_PROMPT_CHARS`, 32 KiB |
| `model` | Exact model id or native alias; omitted preserves an existing run, empty resets to the harness default |
| `effort` | Native reasoning level or OpenCode variant; omitted preserves an existing run, empty resets to the harness default |
| `unattended` | Passes that CLI's skip-approvals flag. Off by default |
| `folder` | The thread's connected folder. A thread works in exactly one, so normally omitted |

`cli` **blocks until the turn finishes** and returns the outcome plus that turn's
output, so reading it back with `cli_runs` is a wasted call:

```
codex run cli1 finished turn 1 (exit 0). Send it more with cli {"action":"send","id":"cli1","prompt":"…"}.

<terminal output>
```

`unattended` on a CLI with no approval gate to bypass — `pi` — is a no-op rather
than a refusal, and the run records what actually applied.

**`cli_runs`** — always available, `auto` in every mode.

- No arguments: the installed CLIs with their resolved paths, then one line per run — id, cli, status, exit code, turns, folder, title.
- `{"id": "cli1"}`: that run's terminal tail.
- `{"id": "cli1", "stop": true}`: kills the turn it is working on.

A run stays readable between turns, which is how a turn checks whether one has
finished before sending it more.

### In the window

[src/cli.tsx](../desktop/src/cli.tsx), four views onto the same runs.

**A tab** — where a run lands by default. It takes a tab of its own in the
thread's strip, beside the sub threads, wearing its harness's logo, and opens
`CliPanel`: the run's id, folder, turn count, approvals, its terminal tail and a
composer for the next turn. `⤢` in the header floats it instead.

**A PIP** — [src/pip.tsx](../desktop/src/pip.tsx) floats one small window per
floated run over the conversation, never inside it, because a run outlives the
turn that started it. Its logo, label, folder, live state (`working · 47s`, `finished`,
`stopped · code 2`, `failed`), an `unattended` badge, a `⋯` menu, a fold button,
the output, and a composer
that gives it the next turn. The composer is Emma's own — same classes, same
shape — and takes attachments through `＋` or a drop onto the window, sending
their paths with the prompt.

Runs share one window until you pull them apart. A second run stacks behind the
first, offset by `STACK` and dimmed, up to `DEEPEST` cards deep; clicking a card
brings it to the front, and dragging one more than `TEAR` pixels tears it out
into a window of its own. From then on both are placed independently.

Drag a window by its header, resize it from the corner grip (arrow keys work
too) down to `MIN_WIDTH` × `MIN_HEIGHT`, which is the size that still fits the
header, a readable stretch of transcript and the whole composer row, or fold it
into the icon rail. The rail sits on the conversation's right
edge until you drag it somewhere else — press an icon to restore that run, drag
the rail to move it. Brand marks are `draggable={false}`, or the browser's own
image drag would eat the gesture on the first move.

On drop, `restfulSpot` scores a 4×4 grid of anchors and swoops to the best one:
how much text the window would cover (`document.elementsFromPoint` over a sample
grid), how much it would overlap the other windows, and how far it would travel
from where it was let go. Overlap disqualifies rather than merely costs: any
anchor that lands clear of the other windows beats every anchor that does not,
and the gradient only breaks ties among the crowded ones, for when two windows
are too big to sit side by side. `floorOf` keeps it above the composer at the bottom of
the conversation — its own composer does not count, or every window would push
its own floor up.

Every action lives behind the header's `⋯` menu, as a named row with its icon —
show raw output, back to its tab, run in terminal, stop run —
because an icon row of five unlabelled glyphs said nothing about what any of them
did. Only the fold button stays outside it, where it always was. The menu closes
on Escape, on picking a row, and when focus leaves it.

The output renders as markdown by default, through the same `Markdown` the
conversation uses, so a CLI that answers in tables and lists reads like one.
**Terminal log** switches to the captured terminal text, per run.

**The model picker** — each run opens its own model and thinking controls.
The model field offers native catalog suggestions and accepts exact custom ids;
thinking uses a native select, or a variant field for OpenCode. Apply saves the
pair for the next turn. Invalid options surface an error without closing the
controls. The current turn is never changed while it is running.

Emma does not keep a list of models. `discoverCliModels` in
[main/cli-models.ts](../desktop/main/cli-models.ts) asks each CLI what it has:

| id | Where the models come from |
| --- | --- |
| `claude` | scans the newest build under `~/.local/share/claude/versions` for `claude-*` ids, plus the `fable`/`opus`/`sonnet`/`haiku` aliases |
| `codex` | `models[].slug` out of `~/.codex/models_cache.json` |
| `pi` | `~/.pi/agent/models-store.json`, as `provider/id` |
| `opencode` | `opencode models` |
| `cursor` | `cursor-agent --list-models` |
| `antigravity` | `agy models`, parsing the model slug column |

So a model released tomorrow shows up as soon as that CLI knows about it, with
no change here. The answer is cached in `<userData>/cli-models.json` for
`CLI_MODELS_STALE_MS` — one hour — and Refresh reads it again now.
Scanning a binary is bounded by `MAX_LIST_BYTES` and `LIST_MS`, and the ids are
validated before they are offered, because a loose `claude-*` match pulls in
strings that are not models.

**The terminal** — the Terminal button starts that harness's own interactive CLI
in Emma's pty ([main/terminal.ts](../desktop/main/terminal.ts) takes a `cli` id
and runs the platform shell: `$SHELL -ilc <bin>` on macOS, or `%COMSPEC% /d /s /c
<bin>` on Windows, so the CLI gets a real TTY). Any terminal tab pops back out
into a PIP with `⇱`, and docks again from the PIP.

**`CliPanel`** — that run's own tab: stats, the whole terminal, and a composer
that gives it the next turn. The composer talks to main directly: typing into a
named CLI's box and pressing send *is* the permission, the same reason Stop needs
no dialog.

Both scrollers pin to the bottom unless you have scrolled more than 24 px up
(`useTailScroll`, which `run-block.tsx` reuses under a shell fence).

## See also

- [harness.md](harness.md) — `emma-cli`, the agent behind every turn
- [tools.md](tools.md) — every tool Emma advertises
- [permissions.md](permissions.md) — the four modes and the tool gate
- [terminal.md](terminal.md) — the shell panel and the `terminal` tool
- [troubleshooting.md](troubleshooting.md) — when a CLI run will not start

## Harness handoffs

Each run has a **Result** view for its latest stdout and a **Terminal log** view
for the complete captured terminal tail, including stderr. The tab includes the
same attachments and model controls as the floating window. A finished run's
**Hand off output** button opens a destination picker: start an installed
harness, or continue another run in this thread. Add the next instruction and
send. New runs retain default CLI approvals; existing runs retain their original
approval mode, shown in the destination picker.

For a sequence requested in chat, Emma uses the optional `fromRuns` array on
`cli`, with up to eight successful run ids from the same thread. This works for
both `action: "run"` and `action: "send"`, so results can be chained, combined,
or sent back for another review. Each source contributes its latest turn's
stdout, id, harness, turn number, and folder. The receiving run records those
sources in `inputs` and shows them above its composer. This metadata and the
captured outputs live for the current app session, like the runs themselves.

Handoffs reject sources that are running, failed, stopped, empty, unavailable,
or from another thread. The combined prompt must fit 32 Ki characters and 96 KiB
of UTF-8; output that exceeded the 256 Ki-character capture cap is also rejected.
For larger deliverables, have the source save a file and give the next harness
its path. Emma never silently truncates a handoff. Files stay in their original
folders and are not automatically copied to a different workspace.

The shared runner permits one active harness per folder. Resuming an older run
of a harness that only continues the newest folder session is refused when Emma
knows a newer run exists. Sessions started outside Emma remain outside this
tracking. A nonzero exit or signal now marks the run failed, with diagnostics in
the terminal log, and prevents chaining it as a successful result.

The harness workspace uses a branded task header, readable result typography,
and a segmented Result / Terminal log control. Source chips open the originating
run, and a completed handoff offers **Open [harness]** to jump to its destination.
Floating harness windows show the task title below the harness name.

The handoff dialog shows installed harnesses as branded radio cards and existing
runs with their task titles and approval modes. Tab and arrow keys select the
cards; Escape closes the dialog and returns focus to its trigger. The selected
harness is named on the final action. If an existing destination starts working
or disappears while the dialog is open, sending is disabled until another
available destination is chosen.

## Model and thinking selection

Chat launches and follow-up turns accept explicit `model` and `effort` fields.
`cli_runs {"cli":"codex","refresh":true}` reads model ids and thinking choices
without starting a model turn. Model-specific Codex effort metadata is read
from its local catalog, including newer levels the installed model advertises.
When that metadata exists, an unsupported combination is rejected rather than
downgraded. Other CLIs validate model access and model-specific levels themselves;
Emma validates the option syntax and harness-level support before spawning.

The square model controls in a run edit the next turn's model and thinking
level. You can select a discovered model or enter an exact id/custom alias.
Apply saves both together and reports errors. Active turns cannot be changed.
The handoff dialog offers the same controls before the first destination turn,
and existing destinations retain their own options. Omission preserves values;
an empty value removes Emma's override and lets native settings decide again.
These choices do not enable unattended permissions.

| Harness | Model | Thinking control |
| --- | --- | --- |
| Claude Code | `--model` | `--effort`: low, medium, high, xhigh, max; model-dependent |
| Codex | `--model` | `--config model_reasoning_effort="…"`; use its model catalog |
| Pi | `--model`, including provider/id | `--thinking`: off, minimal, low, medium, high, xhigh, max |
| OpenCode | `--model provider/id` | `--variant`: native or configured variant name |
| Antigravity CLI | `agy --model` | `--effort`: low, medium, high |
| Gemini CLI | `--model` | Managed by native model configuration; no separate per-run effort flag exposed in Emma |
| Cursor CLI | `--model` | Managed by native model selection; no separate per-run effort flag exposed in Emma |

For example, plan with an exact Claude model, then build with a discovered Codex
Luna id and `effort:"max"`, passing the successful plan through `fromRuns`.
Emma's agent resolves requested names against the catalog; it must not substitute
another model for an unavailable named version. Requested settings appear in
run metadata and actual arguments in the terminal log. Vendor-side normalization
and actual reasoning consumption are not independently measured by Emma.

References checked September 4, 2026:
[Claude Code flags](https://code.claude.com/docs/en/cli-reference),
[Claude effort precedence](https://code.claude.com/docs/en/model-config),
[Codex configuration](https://developers.openai.com/codex/config-reference/),
[Pi options](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md#model-options),
[OpenCode run flags](https://opencode.ai/docs/cli/#run),
[Antigravity headless mode](https://antigravity.google/docs/cli/headless/),
[Gemini configuration](https://geminicli.com/docs/reference/configuration/),
[Cursor parameters](https://docs.cursor.com/en/cli/reference/parameters).

Claude's environment effort setting takes precedence over its CLI flag, so Emma
sets it in that child process when an effort is explicitly requested. It does
not edit the user's settings. The Codex web reference lags the installed catalog
on max/ultra; Emma preserves those native identifiers instead of renaming them.
