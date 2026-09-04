# Emma documentation

Everything written down about Emma lives here. The [root README](../README.md)
is the tour; this is the reference.

## Start here

| | |
|---|---|
| [Getting started](getting-started.md) | Prerequisites, install, run, first launch, and the platform permissions Emma asks for and why |
| [Concepts](concepts.md) | The vocabulary — thread, run, queue/steer/stop, subagent, sub-thread, artifact, context, inspector |
| [Troubleshooting](troubleshooting.md) | Problem → cause → fix, for the failures the code can actually produce |

## Using Emma

| | |
|---|---|
| [Context bar](context-bar.md) | The thread inspector — every component, pages, and rearranging the column |
| [Components](components.md) | The widgets Emma builds into the context bar: the module contract, variables, full screen |
| [Permissions](permissions.md) | The four modes, the full gate matrix, the verifier, and what survives every mode |
| [Tools](tools.md) | Every tool a turn can call: Emma's own, and the harness's builtins |
| [Models](models.md) | OpenAI-compatible endpoints, credentials, the OpenRouter catalog, private routing |
| [Privacy](privacy.md) | What leaves this computer and what doesn't, subsystem by subsystem |
| [Knowledge](knowledge.md) | The vault you pick, `keep`, tagging, and the note format on disk |
| [Notch surfaces](notch.md) | The macOS Option or Windows Alt double-tap, Quick Ask, the island, quick actions, the radial ring |
| [Terminal](terminal.md) | The shell panel under a thread: the pty helper, output as context, shortcut-click links |
| [Browser](browser.md) | The per-thread Chromium view: the docked pane, the PIP, and clipboard history |
| [Mobile](mobile.md) | Pairing a phone over your tailnet or LAN: the address, the PIN, building the app, and what the phone can drive |
| [Voice](voice.md) | Dictation's two engines, the local-only rule, and drawing |
| [Computer use](computer-use.md) | Emma driving approved apps on macOS or Windows, and every safety rail as implemented |
| [Goals](goals.md) | One objective a thread keeps working at: the ledger, the continuation loop, evidence, the blocked audit |
| [Agents](agents.md) | Self-improvement: friction, trials, the replay bench, and how a change is proved |
| [Jobs](jobs.md) | Scheduled workflows: triggers, node graphs, validation, execution |
| [CLI](cli.md) | Driving the user's other coding CLIs and using `emma-cli` directly |

## Building on Emma

| | |
|---|---|
| [Plugins](plugins.md) | Imported skills and MCP servers, marketplaces, tools Emma writes for herself, CSS UI plugins |
| [Harness](harness.md) | `emma-cli`, the fx fork, ACP, and what it reaches today |
| [Design system](design-system.md) | Tokens, density, and one visual language for every surface |

## Contributing

| | |
|---|---|
| [Architecture](architecture.md) | Process boundaries, the trust model, the product contract |
| [Development](development.md) | Repo map, house rules, toolchains, builds, tests, packaging |
| [Data](data.md) | Every file Emma reads or writes, every environment variable |
| [Releasing](releases.md) | PR titles, the generated changelog, CI, downloads, signing, and update verification |
| [Credits](credits.md) | Every dependency, what it is used for, and its license |
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

**"I want to make it mine."**
[Context bar](context-bar.md) → [Design system](design-system.md) → [Plugins](plugins.md)

**"I'm going to change the code."**
[Architecture](architecture.md) → [Development](development.md) → [Concepts](concepts.md) → [Data](data.md)

**"I want it on my phone."**
[Mobile](mobile.md) → [Permissions](permissions.md) → [Privacy](privacy.md)

**"I want to extend it without forking it."**
[Plugins](plugins.md) → [Tools](tools.md) → [Harness](harness.md)
