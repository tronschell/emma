# Emma documentation

Everything written down about Emma lives here. The [root README](../README.md)
is the tour; this is the reference.

## Start here

| | |
|---|---|
| [Getting started](getting-started.md) | Prerequisites, install, run, first launch, the macOS permissions Emma asks for and why |
| [Concepts](concepts.md) | The vocabulary — thread, run, subagent, sub-thread, artifact, context, inspector |
| [Troubleshooting](troubleshooting.md) | Problem → cause → fix, for the failures the code can actually produce |

## Using Emma

| | |
|---|---|
| [Permissions](permissions.md) | The five modes, the full gate matrix, the verifier, and what survives every mode |
| [Tools](tools.md) | Every tool a turn can call: input, output, gate, and the file behind it |
| [Models](models.md) | The local fallback, OpenAI-compatible endpoints, credentials, the OpenRouter catalog |
| [Privacy](privacy.md) | What leaves this Mac and what doesn't, subsystem by subsystem |
| [Knowledge](knowledge.md) | Knowledge bases, save & analyze, auto-categorisation, the Markdown mirror |
| [Notch surfaces](notch.md) | The Option double-tap, Quick Ask, the island, quick actions, the radial ring |
| [Voice](voice.md) | Dictation's two engines, the local-only rule, and drawing |
| [Computer use](computer-use.md) | Emma driving the Mac, and every safety rail as implemented |
| [Jobs](jobs.md) | Scheduled workflows: triggers, node graphs, validation, execution |
| [Autoresearch](autoresearch.md) | The experiment loop, the immutable metric, budgets |
| [CLI](cli.md) | The `emma` terminal command, and driving the user's other CLIs |

## Building on Emma

| | |
|---|---|
| [Plugins](plugins.md) | Skills, MCP servers, tools Emma writes for herself, CSS UI plugins |
| [Harness](harness.md) | `emma-cli`, the fx fork, ACP, and what it reaches today |
| [Design system](design-system.md) | Tokens, density, and one visual language for every surface |

## Contributing

| | |
|---|---|
| [Architecture](architecture.md) | Process boundaries, the trust model, the product contract |
| [Development](development.md) | Repo map, house rules, toolchains, builds, tests, packaging |
| [Data](data.md) | Every file Emma reads or writes, every environment variable |
| [Icon sources](icon-sources.md) | Where each vendor mark came from and under what terms |

[`AGENTS.md`](../AGENTS.md) at the repo root is the source of truth for anyone —
human or agent — changing this repository. Read it before your first change. The
short version: **no comments, anywhere**. If something needs explaining, it goes
in this folder.

## Reading paths

**"I just want to run it."**
[Getting started](getting-started.md) → [Models](models.md) → [Troubleshooting](troubleshooting.md)

**"I want to know what it can do to my machine."**
[Permissions](permissions.md) → [Tools](tools.md) → [Computer use](computer-use.md) → [Privacy](privacy.md)

**"I'm going to change the code."**
[Architecture](architecture.md) → [Development](development.md) → [Concepts](concepts.md) → [Data](data.md)

**"I want to extend it without forking it."**
[Plugins](plugins.md) → [Tools](tools.md) → [Harness](harness.md)
