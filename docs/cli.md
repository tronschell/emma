# The command line

Two different things share the word "CLI" in Emma, and they are not related. `emma` is the terminal front end for Emma's own agent. The `cli` and `cli_runs` tools let an Emma turn drive *someone else's* coding CLI — Claude Code, Codex, Pi, OpenCode, Cursor — inside a connected folder.

This page covers both, in that order. A third thing, `emma-cli`, is the forked coding harness and is documented in [harness.md](harness.md).

---

# Part 1: the `emma` command

[`agent/emma`](../agent/emma) is a 122-line bash script. It keeps one `emma-agent` sidecar process and one thread alive, talks NDJSON over a fifo pair, and never shows you JSON. Provider settings come from the same environment the desktop app reads.

## Install it

Run it once with `--install`:

```bash
/Applications/Emma.app/Contents/Resources/emma --install   # packaged app
agent/emma --install                                        # from a checkout
```

`--install` symlinks the script as `emma` into the **first** of these that exists and is writable:

1. `~/.local/bin`
2. `/usr/local/bin`
3. `$HOMEBREW_PREFIX/bin`, defaulting to `/opt/homebrew/bin`

It prints `linked <target>/emma -> <script>`, and adds `add <target> to your PATH` if that directory is not already on `$PATH`. If none of the three is writable it fails with an exit code of 1 and tells you to run `sudo ln -sf …` yourself.

The link points back at the script wherever it is, so from a checkout it keeps working against your rebuilt sidecar. The script resolves its own location through one `readlink` hop, which is enough for its own symlink and not for a chain of them.

`package:mac` ships it with `--extra-resource=../agent/emma`, so a packaged app has `Emma.app/Contents/Resources/emma` next to `Emma.app/Contents/Resources/emma-agent`.

## Use it

```bash
emma "write a fizzbuzz in python"    # one shot
emma                                  # REPL
emma "explain this" > notes.md        # the reply is stdout
```

Arguments are joined with spaces into one prompt (`say "$*"`), so quoting is optional but sensible.

### Flags and subcommands

There is exactly one: `--install`. That is the whole surface.

Everything else is an environment variable, and anything that is not `--install` is treated as prompt text — `emma --help` asks the model about the string "--help".

| Variable | Default | Does |
| --- | --- | --- |
| `EMMA_PROVIDER_BASE_URL` | unset | An OpenAI-compatible base URL. Without it, every reply is the sidecar's local fallback and no tools are advertised. |
| `EMMA_PROVIDER_MODEL` | — | Required once a base URL is set. The script fails immediately if it is missing. |
| `EMMA_PROVIDER_CREDENTIAL_ENV` | `EMMA_API_KEY` | The **name** of the variable holding the credential, not the credential. The sidecar reads that variable only when making the request. |
| `EMMA_MODE` | `ask` | `plan`, `ask`, `acceptEdits` or `full`. Anything else exits 1 with a usage line. |
| `EMMA_YOLO` | unset | Any non-empty value forces `full`. |
| `EMMA_AGENT_BIN` | unset | Path to a different `emma-agent`. |

The sidecar is found at `$EMMA_AGENT_BIN`, then `<script dir>/emma-agent` (the packaged layout), then `<script dir>/zig-out/bin/emma-agent` (the checkout layout).

It needs `jq`. Every request and every reply goes through it.

### Permission modes

`EMMA_MODE` takes four of Emma's five names. **`auto` is not one of them** — the script's `case` accepts `plan | ask | acceptEdits | full` only, and Auto mode's verifier is a second model that lives in the desktop app.

| Mode | What happens |
| --- | --- |
| `plan` | No tools are advertised at all. The `tools` payload is only built when the mode is not `plan`. |
| `ask` (default) | Each command is printed to stderr as `$ <command>`, then gated on `read -r -p 'run it? [y/N] ' ok </dev/tty`. Only `y`, `Y` or `yes` runs it. Anything else — including a closed tty — comes back to the model as `The user declined to run that command.` |
| `acceptEdits` | Runs it. Prints the command, does not ask. |
| `full` | Same as `acceptEdits` here. There are no edit tools to treat differently. |

The gate reads from `/dev/tty` rather than stdin, deliberately: stdin is the loop's own plumbing, and reading it would consume the script's input.

### One tool, and it is `bash`

With a provider configured, `emma` advertises exactly one tool. The literal from the script:

```json
{"name":"bash","description":"Run a shell command on this machine. Returns combined stdout and stderr, truncated to 16KB. Prefer one self-contained command per call.","input_schema":{"type":"object","properties":{"command":{"type":"string","description":"Command line to run under bash."}},"required":["command"]}}
```

No file tools, no edit tools, no search. In a terminal, `bash` already *is* `read_file`, `list_files` and `write_file`.

Execution is `eval "$command" </dev/null 2>&1 | head -c 16000`. Combined stdout and stderr, 16,000 bytes, stdin closed so a command that waits for input cannot wedge the loop. Empty output becomes `(no output)`; a non-zero exit appends `[exit <code>]`. The output is printed to stderr for the user and returned to the model as the tool result.

Two guards on what the model asks for: a call naming anything other than `bash` answers `Emma has no tool named <x>. The only tool here is bash.`, and a call with no `command` answers `That call had no command argument. Send {"command":"..."}.` Neither ends the turn.

The loop stops after `max_steps=120` tool steps and prints `stopped after 120 tool steps` to stderr. That is the script's own ceiling, not the sidecar's — the sidecar's is high enough to build something real, and an unattended run needs a shorter one.

### What the REPL supports

Not much, and it is worth being precise about it, because `agent/README.md` is silent here.

| | |
| --- | --- |
| Prompt | `> `, from bare `read -r -p`. |
| History | **None.** `read` is called without `-e`, so there is no readline: no up-arrow, no editing beyond backspace. Arrow keys insert escape sequences into your prompt. |
| Multi-line | **None.** One line is one turn. |
| Blank line | Skipped. The loop re-prompts. |
| Exit | Ctrl-D (EOF). There is no `exit` or `/quit` command. |
| Interrupt | **None.** Ctrl-C ends the whole session, not the current turn. The `EXIT` trap removes the fifo directory on the way out. |
| History between turns | Yes — one sidecar process, one thread (`thread-1`), created once at startup with `thread_create` and title `cli`. Every turn shares it. |

Sidecar threads live only for the process's lifetime. Close `emma` and the conversation is gone. `emma-host` is what keeps Emma's durable Markdown threads.

### Standing instructions do not reach it

The Settings system prompt, the connections block and the kept Agent-page improvements are assembled by `settingsBlock()` in [system-prompt.ts](../desktop/main/system-prompt.ts) and written to `<userData>/harness/.fx/AGENTS.md`, which the harness loads as global rules. That is an Electron code path.

`emma` sends a bare `thread_message` — no `skill_context`, no system message — and `writeRequest` in [`openai_compatible.zig`](../agent/src/openai_compatible.zig) only emits a `system` message for a knowledge prompt or a skill prompt, neither of which the script sends. So a terminal turn carries the thread's own history and nothing else.

If you want standing instructions in the terminal, put them in the prompt.

### Under it: the sidecar protocol

`emma-agent` reads one JSON object per line and writes one per line. The script uses four of its twelve request types: `thread_create`, `thread_message`, `thread_tool_result`, and it ignores the rest (`health`, `thread_list`, `thread_get`, `save_to_knowledge`/`analyze`, `revise_document`, `openrouter_models`, `mcp_catalog`, `mcp_search_tools`, `mcp_select_tool`).

The sidecar decides *what* to call and never executes a tool itself. Whoever drives it decides whether it happens: Electron gates through the permission channel, `emma` gates through the tty. Both submit results back over `thread_tool_result`. Full protocol in [`agent/README.md`](../agent/README.md).

---

# Part 2: the `cli` and `cli_runs` tools

The other direction. Emma does not reimplement Claude Code or Codex — it runs the one you already have, in the thread's own folder, shows the terminal live, and feeds it the next prompt.

## The catalog

Five entries in [`shared/cli.ts`](../desktop/shared/cli.ts). What actually differs between them is three strings, so that is all the table holds.

| id | Label | Binary | Starts with | Resumes with | Unattended flag | Owns its session |
| --- | --- | --- | --- | --- | --- | --- |
| `claude` | Claude Code | `claude` | `--print --session-id <uuid> <prompt>` | `--print --resume <uuid> <prompt>` | `--dangerously-skip-permissions` | yes |
| `codex` | Codex | `codex` | `exec --color never <prompt>` | `exec resume --last --color never <prompt>` | `--dangerously-bypass-approvals-and-sandbox` | no |
| `pi` | Pi | `pi` | `--print --session-id <uuid> <prompt>` | `--print --session-id <uuid> <prompt>` | none | yes |
| `opencode` | OpenCode | `opencode` | `run <prompt>` | `run --continue <prompt>` | `--auto` | no |
| `cursor` | Cursor CLI | `cursor-agent` | `--print <prompt>` | `--print --resume <prompt>` | `--force` | no |

Session ids are UUIDs because `claude --session-id` and `codex exec resume` require one.

"Owns its session" is the one that bites. `false` means the CLI only offers "continue the newest session in this directory", so two Emma runs of it in one folder would resume each other's. Both the tool result and the run's tab say so:

> Codex resumes by "most recent session in this folder" rather than by id, so keep one codex run going at a time here.

The `cursor` row is the only one not verified against a real install — its flags come from Cursor's docs. If a run fails at argv, look there first.

## How a run works

[`main/cli.ts`](../desktop/main/cli.ts) owns the processes. A **run is a conversation**, not a command: the child exits at the end of a turn and the run goes `idle`, holding its transcript and session id until the next prompt resumes it. That is the difference from `background`, which runs a shell line and forgets it.

- **Binary resolution** goes through `/bin/bash -lc command -v <bin>`, cached. Electron inherits launchd's PATH, not yours — `claude` lives in `~/.local/bin` and `opencode` in `~/.opencode/bin`, and neither is on the PATH Electron starts with. The login `$PATH` is read once and handed to every child.
- **Spawn** is `detached: true` with `stdio: ["ignore", "pipe", "pipe"]`, in the run's own process group, so Stop takes any language server or sandbox helper the CLI forked with it. Stop sends SIGTERM, then SIGKILL after 2 seconds.
- **Pipes, not a pty.** Every CLI here has a non-interactive mode, which is exactly what a pipe is for. A pty means node-pty (a native module to rebuild per Electron version) plus a terminal emulator in the renderer. Add both when driving a CLI's interactive TUI is the thing being asked for.
- **Output** is stdout and stderr merged into one buffer, capped at 256 KiB with the oldest bytes dropped. `terminalText` strips CSI, OSC and two-byte ANSI escapes and applies carriage returns so a spinner rewriting its own line reads correctly. It is not a terminal emulator; a CLI that addresses the cursor to redraw a box needs a real one.
- **Repaints** are coalesced to one every 120 ms.
- **Limits.** 12 runs kept, and only finished ones are dropped — a running one is still someone's agent. A turn that has said nothing for 30 minutes is stopped as wedged.
- **A failed spawn** is recorded as `failed` with the message in the transcript, not thrown.

Nothing that reaches the renderer carries a process handle or the transcript: `snapshot()` rebuilds the record field by field.

## The tools

**`cli`** — needs a connected folder.

| Argument | |
| --- | --- |
| `action` | `run` or `send`. Defaults to `run`. |
| `cli` | `claude`, `codex`, `pi`, `opencode`, `cursor`. Required for `run`. |
| `id` | The run to continue. Required for `send`. |
| `prompt` | The whole instruction. The CLI does not see Emma's conversation, only the folder. |
| `unattended` | Passes that CLI's skip-approvals flag. Off by default. |
| `folder` | The thread's connected folder. A thread works in exactly one, so normally omitted. |

Prompts are capped at `MAX_CLI_PROMPT_CHARS` — 32 KiB. A CLI turn is a whole agent run, so it gets room `bash` never needed.

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

## In the window

[`src/cli.tsx`](../desktop/src/cli.tsx) has two views onto the same runs.

**`CliDock`** is the strip pinned above the thread: the run that is working, or the most recent one if none is. Logo, run id, first line of the opening prompt, live state (`turn 3 · 47s`, or `idle · exit 0`, or `failed to start`), an `unattended` badge, the folder, `+N` for the others, and buttons for Open tab and Stop. Under that, the last 6 lines of terminal. It is pinned rather than inlined in the transcript because a run outlives the turn that started it — the agent has moved on and the CLI is still going.

**`CliPanel`** is that run's own tab: stats (run, folder, turns, approvals), the whole terminal, and a composer that gives it the next turn. The composer talks to main directly rather than through an Emma turn — typing into a named CLI's box and pressing send *is* the permission, the same reason Stop needs no dialog, and routing it through Emma would put a second model between you and the CLI you picked.

Both scrollers pin to the bottom unless you have scrolled up more than 24 pixels to read (`useTailScroll`, which [`run-block.tsx`](../desktop/src/run-block.tsx) reuses for the play button under a shell fence).

---

# Part 3: Settings → Connections

Third-party command-line tools Emma can lean on. [`main/connections.ts`](../desktop/main/connections.ts).

**A connection is a line of system context and nothing else.** No wrapper, no schema, no process Emma owns, no new tool. The binary was already reachable through `bash`; all the agent was missing is that it exists on this Mac and what it is for.

| id | Label | Probes for | Homebrew formula |
| --- | --- | --- | --- |
| `obsidian` | Obsidian | `obsidian`, `obsidian-cli` | `yakitrak/yakitrak/obsidian-cli` |
| `github` | GitHub | `gh` | `gh` |
| `gitlab` | GitLab | `glab` | `glab` |
| `jira` | Jira | `jira` | `ankitpokhrel/jira-cli/jira-cli` |
| `todoist` | Todoist | `todoist` | `sachaos/todoist/todoist` |

Obsidian is the only entry with two candidate binaries; the first one found is what the agent is told to run.

What a switched-on, installed connection adds to the turn:

```
Third-party command-line tools the user has connected on this Mac. Use them
through the bash tool, which needs a connected folder as its working directory:

- GitHub — `gh`. Issues, pull requests, releases, CI. Run `gh --help` first if
  you are unsure of its subcommands.
```

That is the entire feature.

Detection is one `bash -lc` for the whole catalog — the same login shell the `bash` tool runs commands under, so a binary on the agent's PATH is the one detected. The block is rebuilt on a change of selection, not per turn. Ids, binaries and formulae are interpolated into shell scripts, so the catalog is held to bare names and `assertCatalog` fails the tests if an entry ever strays (`^[a-z][a-z0-9-]{0,31}$` for ids and binaries, plus up to two `/` segments for a tapped formula).

Homebrew is the only thing Emma installs or upgrades, and only on your click. `outdatedConnections` runs `brew outdated` separately from detection, because it walks every installed formula and the list has to draw first.

## See also

- [harness.md](harness.md) — `emma-cli`, the third program with a similar name
- [tools.md](tools.md) — every tool Emma advertises, `cli` and `cli_runs` among them
- [permissions.md](permissions.md) — the four modes `EMMA_MODE` names, in the app
- [getting-started.md](getting-started.md) — installing Emma itself
- [concepts.md](concepts.md) — threads, runs and agents
- [jobs.md](jobs.md) — scheduled and unattended work
- [development.md](development.md) — building the sidecar
- [architecture.md](architecture.md) — where the sidecar sits
- [troubleshooting.md](troubleshooting.md) — when `emma` or a CLI run will not start
