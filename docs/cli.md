# The command line

Three things in Emma answer to some form of "CLI" and they are not related. The `cli` and `cli_runs` tools let an Emma turn drive *someone else's* coding CLI — Claude Code, Codex, Pi, OpenCode, Cursor — inside a connected folder. Settings → Connections looks like a second one and is not: it adds a line of system context per third-party tool you already have, and no new tool at all. `emma-cli` is the agent Emma itself runs, and it happens to be usable from a terminal on its own.

This page covers the first two, in that order. `emma-cli` gets a pointer below and a page of its own.

## `emma-cli` from a terminal

`emma-cli` is the same binary that runs every Emma turn, and it works on its own. A packaged app has it at `Emma.app/Contents/Resources/emma-cli`; a checkout builds it to `harness/zig-out/bin/emma-cli` with `npm --prefix desktop run build:harness`.

```bash
emma-cli ask "write a fizzbuzz in python"   # one shot
emma-cli                                    # a REPL in the current directory
emma-cli sessions                           # what it has saved
emma-cli session resume last
```

The current directory becomes its workspace, and it gates a tool call on the tty rather than through Emma's permission channel. Its own surface is documented in [`harness/README.md`](../harness/README.md); how Emma drives it is [harness.md](harness.md).

## The `cli` and `cli_runs` tools

The other direction. Emma does not reimplement Claude Code or Codex — it runs the one you already have, in the thread's own folder, shows the terminal live, and feeds it the next prompt.

### The catalog

Five entries in [`shared/cli.ts`](../desktop/shared/cli.ts). What actually differs between them is three strings, so that is all the table holds.

| id | Label | Binary | Starts with | Resumes with | Unattended flag | Owns its session |
| --- | --- | --- | --- | --- | --- | --- |
| `claude` | Claude Code | `claude` | `--print --session-id <uuid> <prompt>` | `--print --resume <uuid> <prompt>` | `--dangerously-skip-permissions` | yes |
| `codex` | Codex | `codex` | `exec --color never <prompt>` | `exec resume --last --color never <prompt>` | `--dangerously-bypass-approvals-and-sandbox` | no |
| `pi` | Pi | `pi` | `--print --session-id <uuid> <prompt>` | `--print --session-id <uuid> <prompt>` | none | yes |
| `opencode` | OpenCode | `opencode` | `run <prompt>` | `run --continue <prompt>` | `--auto` | no |
| `cursor` | Cursor CLI | `cursor-agent` | `--print <prompt>` | `--print --resume <prompt>` | `--force` | no |

Session ids are UUIDs because `claude --session-id` and `codex exec resume` want one.

"Owns its session" is the column that bites. `false` means the CLI only offers "continue the newest session in this directory", so two Emma runs of it in one folder would resume each other's. Both the tool result and the run's tab say so:

> Codex resumes by "most recent session in this folder" rather than by id, so keep one codex run going at a time here.

The `cursor` row is the only one not verified against a real install; its flags come from Cursor's docs. If a run fails at argv, look there first.

### How a run works

[`main/cli.ts`](../desktop/main/cli.ts) owns the processes. A **run is a conversation**, not a command: the child exits at the end of a turn and the run goes `idle`, holding its transcript and session id until the next prompt resumes it. That is the difference from `background`, which runs a shell line and forgets it.

- **Finding the binary** goes through `/bin/bash -lc command -v <bin>`, cached. Electron inherits launchd's PATH, not yours — `claude` lives in `~/.local/bin` and `opencode` in `~/.opencode/bin`, and neither is on the PATH Electron starts with. The login `$PATH` is read once and handed to every child.
- **Spawning** is `detached: true` with `stdio: ["ignore", "pipe", "pipe"]`, in the run's own process group, so Stop takes any language server or sandbox helper the CLI forked with it. Stop sends SIGTERM, then SIGKILL after 2 seconds.
- **Pipes, not a pty.** Every CLI here has a non-interactive mode, which is exactly what a pipe is for. A pty means node-pty — a native module to rebuild per Electron version — plus a terminal emulator in the renderer. Add both when driving a CLI's interactive TUI is the thing being asked for.
- **Output** is stdout and stderr merged into one buffer, capped at 256 KiB with the oldest bytes dropped. `terminalText` strips CSI, OSC and two-byte ANSI escapes and applies carriage returns, so a spinner rewriting its own line reads correctly. It is not a terminal emulator; a CLI that moves the cursor around to redraw a box needs a real one.
- **Repaints** are coalesced to one every 120 ms.
- **Limits.** 12 runs kept, and only finished ones are dropped — a running one is still someone's agent. A turn that has said nothing for 30 minutes is stopped as wedged.
- **A failed spawn** is recorded as `failed` with the message in the transcript, not thrown.

Nothing that reaches the renderer carries a process handle or the transcript: `snapshot()` rebuilds the record field by field.

### The tools

**`cli`** — needs a connected folder.

| Argument | |
| --- | --- |
| `action` | `run` or `send`. Defaults to `run`. |
| `cli` | `claude`, `codex`, `pi`, `opencode`, `cursor`. Required for `run`. |
| `id` | The run to continue. Required for `send`. |
| `prompt` | The whole instruction. The CLI does not see Emma's conversation, only the folder. |
| `unattended` | Passes that CLI's skip-approvals flag. Off by default. |
| `folder` | The thread's connected folder. A thread works in exactly one, so normally omitted. |

Prompts are capped at `MAX_CLI_PROMPT_CHARS`, 32 KiB. A CLI turn is a whole agent run, so it gets room `bash` never needed.

`cli` **blocks until the turn finishes** and returns the result plus that turn's output, so reading it back with `cli_runs` would be a wasted call:

```
codex run cli1 finished turn 1 (exit 0). Send it more with cli {"action":"send","id":"cli1","prompt":"…"}.

<terminal output>
```

`unattended` on a CLI with no approval gate to bypass — `pi` — is a no-op rather than a refusal, and the run records what actually applied rather than what was asked for.

**`cli_runs`** — always available.

- No arguments: the installed CLIs with their resolved paths, then one line per run — id, cli, status, exit code, turn count, folder, title.
- `{"id": "cli1"}`: that run's terminal tail.
- `{"id": "cli1", "stop": true}`: kills the turn it is working on.

A run stays readable between turns. That is how a turn checks whether one has finished before sending it more.

### In the window

[`src/cli.tsx`](../desktop/src/cli.tsx) has two views onto the same runs.

**`CliDock`** is the strip pinned above the thread: the run that is working, or the most recent one if none is. Logo, run id, first line of the opening prompt, live state (`turn 3 · 47s`, or `idle · exit 0`, or `failed to start`), an `unattended` badge, the folder, `+N` for the others, and buttons for Open tab and Stop. Under that, the last 6 lines of terminal. It is pinned rather than inlined in the transcript because a run outlives the turn that started it — the agent has moved on and the CLI is still going.

**`CliPanel`** is that run's own tab: stats (run, folder, turns, approvals), the whole terminal, and a composer that gives it the next turn. The composer talks to main directly rather than through an Emma turn. Typing into a named CLI's box and pressing send *is* the permission, the same reason Stop needs no dialog, and routing it through Emma would put a second model between you and the CLI you picked.

Both scrollers pin to the bottom unless you have scrolled up more than 24 pixels to read (`useTailScroll`, which [`run-block.tsx`](../desktop/src/run-block.tsx) reuses for the play button under a shell fence).

## Settings → Connections

Third-party command-line tools Emma can lean on. [`main/connections.ts`](../desktop/main/connections.ts).

**A connection is a line of system context and nothing else.** No wrapper, no schema, no process Emma owns, no new tool. The binary was already reachable through `bash`; all the agent was missing is that it exists on this Mac and what it is for.

| id | Label | Probes for | Homebrew formula |
| --- | --- | --- | --- |
| `obsidian` | Obsidian | `obsidian`, `obsidian-cli` | `yakitrak/yakitrak/obsidian-cli` |
| `github` | GitHub | `gh` | `gh` |
| `gitlab` | GitLab | `glab` | `glab` |
| `jira` | Jira | `jira` | `ankitpokhrel/jira-cli/jira-cli` |
| `todoist` | Todoist | `todoist` | `sachaos/todoist/todoist` |

Obsidian is the only entry with two candidate binaries; whichever is found first is what the agent is told to run.

Here is everything a switched-on, installed connection adds to the turn:

```
Third-party command-line tools the user has connected on this Mac. Use them
through the bash tool, which needs a connected folder as its working directory:

- GitHub — `gh`. Issues, pull requests, releases, CI. Run `gh --help` first if
  you are unsure of its subcommands.
```

That is the entire feature.

Detection is one `bash -lc` for the whole catalog — the same login shell the `bash` tool runs commands under, so a binary on the agent's PATH is the one detected. The block is rebuilt when the selection changes, not per turn.

Ids, binaries and formulae get interpolated into shell scripts, so the catalog is held to bare names and `assertCatalog` fails the tests if an entry ever strays: `^[a-z][a-z0-9-]{0,31}$` for ids and binaries, plus up to two `/` segments for a tapped formula.

Homebrew is the only thing Emma installs or upgrades, and only on your click. `outdatedConnections` runs `brew outdated` separately from detection, because it walks every installed formula and the list has to draw first.

## See also

- [harness.md](harness.md) — `emma-cli`, the agent behind every turn
- [tools.md](tools.md) — every tool Emma advertises, `cli` and `cli_runs` among them
- [permissions.md](permissions.md) — the four modes and the tool gate
- [getting-started.md](getting-started.md) — installing Emma itself
- [concepts.md](concepts.md) — threads, runs and agents
- [jobs.md](jobs.md) — scheduled and unattended work
- [development.md](development.md) — building each layer
- [architecture.md](architecture.md) — where each process sits
- [troubleshooting.md](troubleshooting.md) — when a CLI run will not start
