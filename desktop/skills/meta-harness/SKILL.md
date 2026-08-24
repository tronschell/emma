---
name: meta-harness
description: How to run the user's other coding CLIs — Claude Code, Codex, Pi, OpenCode, Cursor — from inside Emma with the `cli` and `cli_runs` tools; which one to pick, how to brief it, how to take turns with it, and when to do the work yourself instead. Use whenever the user names one of those CLIs, asks for a second agent's take on the same code, asks what coding agents they have installed, or asks to hand a job to something other than Emma.
---

# Running the other CLIs

Emma is a meta harness. The user has already installed and configured coding
agents — Claude Code, Codex, Pi, OpenCode, Cursor — and Emma runs the one they
want in the thread's own folder rather than reimplementing it.

This skill ships with the app and is rewritten from `desktop/skills/` on every
launch. Do not edit it with `write_skill`; write what you learn as a separate
skill and it survives.

## The two tools

| Ask | Call |
|---|---|
| what is installed, what is running | `cli_runs {}` |
| start one on a job | `cli {"cli": "codex", "prompt": "…"}` |
| read a run's terminal | `cli_runs {"id": "cli1"}` |
| give it the next turn | `cli {"action": "send", "id": "cli1", "prompt": "…"}` |
| kill the turn it is on | `cli_runs {"id": "cli1", "stop": true}` |

`cli_runs` never asks the user for permission; `cli` always does, unless the
thread is on Full access. Check what is installed before you run something —
a CLI that is not on the PATH is the failure you will actually hit.

## Picking one

**Do the work yourself** unless there is a reason not to. Emma has the folder,
the thread, and the user's attention; handing a job sideways costs a whole extra
model and buys nothing by default.

Reach for a CLI when:

- **The user named one.** "Ask Codex", "have Claude Code do it" — that is the
  whole decision, do not talk them out of it.
- **They want a second opinion** on code Emma already looked at. Two agents
  disagreeing about a bug is worth more than one agent asserting twice.
- **That CLI is set up for this project and Emma is not.** Its own
  `AGENTS.md`, `CLAUDE.md`, MCP servers, hooks and skills all load when it runs
  — that is the point of running it rather than copying its config.
- **The job is long and self-contained.** A migration across forty files is a
  fine thing to hand over and check on.

Do *not* run one to answer a question you can answer, and never run two on the
same folder at once — they will fight over the same files.

## Briefing it

The CLI sees the folder and nothing else. It cannot see this conversation, the
thread, what the user just said, or what you already worked out.

So `prompt` is the whole brief: what to change, which files, what "done" looks
like, and any constraint the user gave that is not written down in the repo. A
one-line prompt gets a one-line-quality answer.

```
cli {"cli": "claude", "prompt": "In src/parser.ts, the tokenizer drops escaped
     quotes inside single-quoted strings — see the failing case in
     test/parser.test.ts:112. Fix the tokenizer, keep the existing API, and run
     `npm test` before you finish."}
```

## Taking turns

A run is a conversation, not a command. `cli` returns when the turn finishes and
hands you its output; the run then sits **idle**, holding its session, until you
send it more. `send` continues that same session with everything it already
knows, so a follow-up is a sentence, not a re-brief.

```
cli {"action": "send", "id": "cli1", "prompt": "Two tests still fail. Fix those
     rather than changing what they assert."}
```

The user can type into the run's tab too, and often will — the terminal is
pinned at the top of the thread while it works, so they are watching. Do not
narrate what they can already see; say what you are handing over and why.

Sessions: Claude Code and Pi resume by an id Emma owns. **Codex, OpenCode and
Cursor only offer "continue the newest session in this folder"** — so keep one
run of those going at a time per folder, or a follow-up lands in the wrong
conversation.

## Approvals

`unattended` passes that CLI's own skip-approvals flag —
`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`,
`--auto`. Without it a CLI that wants to write a file will stop and wait for a
human who is not there, and the turn ends having done nothing.

With it, another agent edits and runs commands in the user's folder with nothing
in the way.

Both of those are real, so: **leave it off unless the user asked for a hands-off
run**, and when you turn it on, say so in the same sentence you say what you
handed over. The permission dialog shows the exact argv, so the flag is never a
surprise — but it should not be news either.

## Reading a run

The output is a terminal, not a transcript: progress lines, tool calls, and the
CLI's own formatting. Read it for what changed and whether it finished, then say
that in your own words. Do not paste it back at the user — it is already on
their screen, in the tab.

If a run failed to start, the reason is in the first line: usually the binary is
not installed, or its flags moved in a new version.
