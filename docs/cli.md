# The command line

Two unrelated things in Emma answer to "CLI":

- the **`cli` and `cli_runs` tools**, which drive *someone else's* coding CLI in a connected folder — most of this page;
- **`emma-cli`**, the agent Emma itself runs, which also works from a terminal.

## `emma-cli` from a terminal

The same binary that runs every Emma turn. A packaged app has it at
`Emma.app/Contents/Resources/emma-cli`; a checkout builds it to
`harness/zig-out/bin/emma-cli` with `npm --prefix desktop run build:harness`.

```bash
emma-cli ask "write a fizzbuzz in python"   # one shot
emma-cli                                    # a REPL in the current directory
emma-cli sessions
emma-cli session resume last
```

The current directory is its workspace, and it gates a tool call on the tty
rather than through Emma's permission channel. It is Emma's fork of
[vercel-labs/fx](https://github.com/vercel-labs/fx) (Apache-2.0; provenance in
[FORK.md](../harness/FORK.md)) — its own surface is
[harness/README.md](../harness/README.md), and how Emma drives it is
[harness.md](harness.md).

## `cli` and `cli_runs`

Emma does not reimplement Claude Code or Codex. It runs the one you already
have, in the thread's folder, shows the terminal live, and feeds it the next
prompt. All five are other people's work:

| id | Label | Binary | Starts with | Resumes with | Unattended flag | Owns its session |
| --- | --- | --- | --- | --- | --- | --- |
| `claude` | [Claude Code](https://github.com/anthropics/claude-code) | `claude` | `--print --session-id <uuid> <prompt>` | `--print --resume <uuid> <prompt>` | `--dangerously-skip-permissions` | yes |
| `codex` | [Codex](https://github.com/openai/codex) | `codex` | `exec --color never <prompt>` | `exec resume --last --color never <prompt>` | `--dangerously-bypass-approvals-and-sandbox` | no |
| `pi` | [Pi](https://pi.dev) | `pi` | `--print --session-id <uuid> <prompt>` | `--print --session-id <uuid> <prompt>` | none | yes |
| `opencode` | [OpenCode](https://github.com/sst/opencode) | `opencode` | `run <prompt>` | `run --continue <prompt>` | `--auto` | no |
| `cursor` | [Cursor CLI](https://docs.cursor.com/en/cli/overview) | `cursor-agent` | `--print <prompt>` | `--print --resume <prompt>` | `--force` | no |

The catalog is [shared/cli.ts](../desktop/shared/cli.ts); what differs between
entries is three strings, so that is all it holds. Every row takes an optional
model, appended as `--model <id>` when a run has one. Session ids are UUIDs because
`claude --session-id` and `codex exec resume` want one.

**Owns its session** is the column that bites. `no` means the CLI only offers
"continue the newest session in this directory", so two Emma runs of it in one
folder would resume each other's. The tool result says so:

> Codex resumes by "most recent session in this folder" rather than by id, so keep one codex run going at a time here.

The `cursor` row is the only one never verified against a real install; its flags
come from Cursor's docs. If a run fails at argv, look there first.

### How a run works

[main/cli.ts](../desktop/main/cli.ts) owns the processes. A **run is a
conversation**, not a command: the child exits at the end of a turn and the run
goes `idle`, holding its transcript and session id until the next prompt resumes
it.

| | |
| --- | --- |
| Finding the binary | `/bin/bash -lc command -v <bin>`, cached. Electron inherits launchd's PATH, not yours — `claude` lives in `~/.local/bin`, `opencode` in `~/.opencode/bin`. The login `$PATH` is read once and handed to every child |
| Spawning | `detached: true`, `stdio: ["ignore", "pipe", "pipe"]`, own process group, so Stop takes whatever the CLI forked. SIGTERM, then SIGKILL after 2 s |
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
| `cli` | `claude`, `codex`, `pi`, `opencode`, `cursor`. Required for `run` |
| `id` | The run to continue. Required for `send` |
| `prompt` | The whole instruction — the CLI sees the folder, never Emma's conversation. Capped at `MAX_CLI_PROMPT_CHARS`, 32 KiB |
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
**Show raw output** flips it to the untouched terminal text, per run.

**The model picker** — one per run, holding only that harness's own models. It
is Emma's own picker, not a native control: the `.model-button` trigger from the
main composer opens a `.source-popover.model-menu` of `.model-menu-row` buttons,
sized to the card so it scrolls rather than escapes it. Picking one stores
`model` on the run, and the next turn passes `--model <id>` to the child.

Emma does not keep a list of models. `discoverCliModels` in
[main/cli-models.ts](../desktop/main/cli-models.ts) asks each CLI what it has:

| id | Where the models come from |
| --- | --- |
| `claude` | scans the newest build under `~/.local/share/claude/versions` for `claude-*` ids, plus the `fable`/`opus`/`sonnet`/`haiku` aliases |
| `codex` | `models[].slug` out of `~/.codex/models_cache.json` |
| `pi` | `~/.pi/agent/models-store.json`, as `provider/id` |
| `opencode` | `opencode models` |
| `cursor` | `cursor-agent --list-models` |

So a model released tomorrow shows up as soon as that CLI knows about it, with
no change here. The answer is cached in `<userData>/cli-models.json` for
`CLI_MODELS_STALE_MS` — a week — and the menu's foot row reads it again now.
Scanning a binary is bounded by `MAX_LIST_BYTES` and `LIST_MS`, and the ids are
validated before they are offered, because a loose `claude-*` match pulls in
strings that are not models.

**The terminal** — the Terminal button starts that harness's own interactive CLI
in Emma's pty ([main/terminal.ts](../desktop/main/terminal.ts) takes a `cli` id
and runs `$SHELL -ilc <bin>` in place of a login shell, so the CLI resolves on the
login PATH and gets a real TTY). Any terminal tab pops back out into a PIP with
`⇱`, and docks again from the PIP.

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
