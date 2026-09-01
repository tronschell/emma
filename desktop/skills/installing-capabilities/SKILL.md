---
name: installing-capabilities
description: How to give yourself a capability you do not have yet — install an MCP server, write or install a skill, import another agent's setup — without a relaunch. Use whenever a job needs a tool you are not advertising, whenever the user asks to install, add, set up or connect a skill or an MCP server, and whenever you are about to tell someone to edit a config file by hand.
---

# Installing capabilities

You can give yourself a capability without waiting for anyone. Nothing here needs
a rebuild, a restart, or the user editing a file — the table below says which
land mid-turn and which land on the next one. If you catch yourself writing
"you'll need to add this to your config", stop — that is this skill.

This skill ships with the app and is rewritten from `desktop/skills/` on every
launch. Do not edit it with `write_skill`; write what you learn as a separate
skill and it survives.

## Which one you need

| The job needs… | Use | Live |
|---|---|---|
| A procedure or lesson remembered next time | `write_skill` | immediately |
| A command sequence you keep repeating, or a tool the user asked you to build | `write_tool` | immediately |
| A tool that talks to a service — GitHub, Linear, a database, a browser | `install_mcp` | next turn |
| A skill that already exists somewhere on this computer or on the web | `terminal` to fetch, then `write_skill` | immediately |
| Several skills that belong together, packaged to keep or share | `write_plugin` | next turn |
| A published plugin, or a catalog of them | tell them: Plugins → Add marketplace | when they install |
| Everything from the user's other agents at once | tell them: Settings → Imports & plugins | after they pick |

## Installing an MCP server

`install_mcp` writes the server into Emma's own config. Take the command straight
from the server's README — it is the same `command`/`args`/`env` every other
agent's config uses:

```json
{ "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
```

Every configured server is connected when a turn starts, so the one you just
installed is live from the next turn, not this one. Find its tools then with
`mcp_search_tools`, read the schema of the one you want with `mcp_select_tool`,
and call it.

What to hold to:

- **Find the real command before you call.** Do not guess a package name. If you
  are unsure, `terminal` the README (`npm view <pkg>`, `curl` the repo's README) or
  ask. A wrong command is not caught until the next turn tries to connect it, so
  it costs a whole turn to find out.
- **Live on the next turn, not this one.** Say that rather than reaching for its
  tools immediately and looking broken. Every configured server runs — installing
  one displaces nothing.
- **Secrets are the user's to hand over.** `env` values are written to
  `<userData>/mcp.json` and are in this transcript forever. If the server needs a
  token, say which variable it wants and what it is for, and let the user decide
  — never invent one, and never pull one out of a file you happened to read.
- **Fixing a bad install is another install.** The same `name` replaces the old
  entry; there is nothing to clean up first.
- **It will ask.** In Ask and Accept-edits modes the user sees the exact command,
  arguments and environment key names before anything runs. A refusal is an
  answer: tell them what the server was for rather than trying a second route.

Installed servers are listed alongside imported ones in the composer's `/` menu,
so the user can see what is configured.

## Installing a skill

`write_skill` writes `<userData>/skills/<slug>/SKILL.md` and it is searchable on
the next turn. That is the whole install — there is no registry step.

To install one that already exists, fetch it and hand over its text:

1. `terminal` — `git clone`, `curl`, or just read it out of a folder the user
   already gave you. If nothing is connected, ask them to pick one: the folder
   button in the sidebar.
2. `read_file` the `SKILL.md`.
3. `write_skill` with its name and the file's contents verbatim.

Only `SKILL.md` is loaded. A skill that leans on sibling scripts or assets will
not work as written — either inline what it needs into the Markdown, or say
plainly that this one does not port.

Write the frontmatter the same way this file does: `name`, then a `description`
that says when to use it. The description is what makes it findable later.

## Writing a tool of your own

A skill is a lesson and an MCP server is someone else's program. `write_tool` is
the third case: one script of yours, kept in Emma's own folder, callable by name
from any thread afterwards.

```json
{ "name": "tidy-invoices", "description": "Renames every PDF in the folder named in its input to <date>-<vendor>.pdf.", "code": "#!/usr/bin/env bash\nset -euo pipefail\ncd \"$1\"\n…" }
```

- **The `#!` line is required** — bash, python3, node, whatever the job wants.
  The script is run under a login shell, so it finds the same interpreters the
  user's terminal does.
- **One argument in, printed text out.** The script gets the `input` string as
  `$1` and its output is the tool result. Keep it small and print something a
  reader can act on, including when it fails.
- **It runs in the thread's connected folder** when there is one, so a tool that
  works on the project needs no path argument.
- **Same name replaces it.** That is how a tool that turned out wrong gets fixed.
- **It will ask before it runs.** `run_tool` is arbitrary code on the user's computer,
  so it sits where `terminal` does — writing one never asks, running it does.

Reach for this when the user says "write a tool that…", and when you catch
yourself pasting the same six-line shell incantation a second time. Do not reach
for it when one `terminal` call would do, or when a real MCP server for that service
already exists — a script that reimplements someone's API client is a liability.

## Packaging skills as a plugin

`write_plugin` is `write_skill` for a set: it writes a real ChatGPT/Codex plugin
— `.codex-plugin/plugin.json` plus one `skills/<name>/SKILL.md` per skill —
installs it, and lists it on the Plugins page under "Written by Emma".

```json
{ "name": "invoice-ops", "description": "Everything for turning receipts into a monthly invoice.", "category": "Productivity",
  "skills": [{ "name": "sort-receipts", "description": "Files a folder of receipts by vendor and month.", "instructions": "…" }] }
```

- **A plugin is a set, a skill is one lesson.** One procedure is `write_skill`.
  Reach here when three related ones only make sense together, or when the user
  wants something they can hand to a teammate — the folder it writes is a valid
  plugin for any agent that reads the format, not just Emma.
- **Write each skill's `instructions` exactly as you would a `SKILL.md` body.**
  Frontmatter is added for you unless your text already opens with `---`.
- **Live on the next turn, not this one.** Its skills are searchable then; say
  that rather than calling one immediately and looking broken.
- **Same name replaces it.** Re-running with new skills rewrites the folder, so
  a plugin that came out wrong is fixed by writing it again.

## Verifying, before you say it worked

Do not report an install from the tool's own success message alone.

- MCP: it is in the config once `install_mcp` returns. Name the server back and
  say its tools arrive next turn — do not claim it works until a later turn has
  found it with `mcp_search_tools`.
- Skill: it is on disk once `write_skill` returns; naming it back to the user is
  enough.
- Plugin: `write_plugin` reports the folder and the skills it carries; say both,
  and point at the Plugins page.

If a later turn cannot find the server's tools, the command was wrong — a missing
binary, a package that does not exist, a server that wants an environment
variable. Fix the one thing and install again under the same name. Do not fall
back to instructing the user unless two attempts have failed for a reason you
cannot act on.
