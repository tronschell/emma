# The command line

Three unrelated things in Emma answer to "CLI":

- the **`cli` and `cli_runs` tools**, which drive *someone else's* coding CLI in a connected folder — most of this page;
- **Settings → Connections**, which adds a line of system context per third-party tool you already have, and no tool at all;
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
entries is three strings, so that is all it holds. Session ids are UUIDs because
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

[src/cli.tsx](../desktop/src/cli.tsx), two views onto the same runs.

**`CliDock`** — the strip pinned above the thread: the run that is working, or
the most recent one. Logo, run id, first line of the opening prompt, live state
(`turn 3 · 47s`, `idle · exit 0`, `failed to start`), an `unattended` badge, the
folder, `+N` for the others, Open tab and Stop, and the last 6 lines of terminal.
It is pinned rather than inlined because a run outlives the turn that started it.

**`CliPanel`** — that run's own tab: stats, the whole terminal, and a composer
that gives it the next turn. The composer talks to main directly: typing into a
named CLI's box and pressing send *is* the permission, the same reason Stop needs
no dialog.

Both scrollers pin to the bottom unless you have scrolled more than 24 px up
(`useTailScroll`, which `run-block.tsx` reuses under a shell fence).

## Settings → Connections

[main/connections.ts](../desktop/main/connections.ts). **A connection is a line
of system context and nothing else** — no wrapper, no schema, no process Emma
owns, no new tool. The binary was already reachable through the shell; what the
agent was missing is that it exists here and what it is for.

| id | Label | Probes for | Homebrew formula | Project |
| --- | --- | --- | --- | --- |
| `obsidian` | Obsidian | `obsidian`, `obsidian-cli` | `yakitrak/yakitrak/obsidian-cli` | [Yakitrak/obsidian-cli](https://github.com/Yakitrak/obsidian-cli) |
| `github` | GitHub | `gh` | `gh` | [cli/cli](https://github.com/cli/cli) |
| `gitlab` | GitLab | `glab` | `glab` | [gitlab-org/cli](https://gitlab.com/gitlab-org/cli) |
| `jira` | Jira | `jira` | `ankitpokhrel/jira-cli/jira-cli` | [ankitpokhrel/jira-cli](https://github.com/ankitpokhrel/jira-cli) |
| `todoist` | Todoist | `todoist` | `sachaos/todoist/todoist` | [sachaos/todoist](https://github.com/sachaos/todoist) |

Obsidian is the only entry with two candidate binaries; whichever is found first
is what the agent is told to run.

Everything a switched-on, installed connection adds to a turn:

```
Third-party command-line tools the user has connected on this Mac. Use them
through the terminal tool, which needs a connected folder as its working
directory:

- GitHub — `gh`. Issues, pull requests, releases, CI. Run `gh --help` first if
  you are unsure of its subcommands.
```

That is the whole feature.

Detection is one `bash -lc` for the whole catalog — the same login shell the
`terminal` tool runs under, so a binary on the agent's PATH is the one detected.
The block is rebuilt when the selection changes, not per turn.

Ids, binaries and formulae are interpolated into shell scripts, so the catalog is
held to bare names and `assertCatalog` fails the tests if an entry strays:
`^[a-z][a-z0-9-]{0,31}$` for ids and binaries, plus up to two `/` segments for a
tapped formula. Homebrew is the only thing Emma installs or upgrades, and only on
your click; `outdatedConnections` runs `brew outdated` separately from detection,
because it walks every installed formula and the list has to draw first.

## See also

- [harness.md](harness.md) — `emma-cli`, the agent behind every turn
- [tools.md](tools.md) — every tool Emma advertises
- [permissions.md](permissions.md) — the four modes and the tool gate
- [terminal.md](terminal.md) — the shell panel and the `terminal` tool
- [troubleshooting.md](troubleshooting.md) — when a CLI run will not start
