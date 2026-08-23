---
name: installing-capabilities
description: How to give yourself a capability you do not have yet — install an MCP server, write or install a skill, import another agent's setup — and use it in the same turn without a relaunch. Use whenever a job needs a tool you are not advertising, whenever the user asks to install, add, set up or connect a skill or an MCP server, and whenever you are about to tell someone to edit a config file by hand.
---

# Installing capabilities

You can give yourself a capability mid-turn. Nothing here needs a rebuild, a
restart, or the user editing a file. If you catch yourself writing "you'll need
to add this to your config", stop — that is this skill.

This skill ships with the app and is rewritten from `desktop/skills/` on every
launch. Do not edit it with `write_skill`; write what you learn as a separate
skill and it survives.

## Which one you need

| The job needs… | Use | Live |
|---|---|---|
| A procedure or lesson remembered next time | `write_skill` | immediately |
| A command sequence you keep repeating, or a tool the user asked you to build | `write_tool` | immediately |
| A tool that talks to a service — GitHub, Linear, a database, a browser | `install_mcp` | immediately |
| A skill that already exists somewhere on this Mac or on the web | `bash` to fetch, then `write_skill` | immediately |
| Everything from the user's other agents at once | tell them: Settings → Imports & plugins | after they pick |

## Installing an MCP server

`install_mcp` writes the server into Emma's own config and connects it in the
same call. Take the command straight from the server's README — it is the same
`command`/`args`/`env` every other agent's config uses:

```json
{ "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
```

Then call `mcp_tool` with a tool name and its arguments. The tool appears the
moment the server connects, so the sequence inside one turn is: `install_mcp` →
`mcp_tool` → answer.

What to hold to:

- **Find the real command before you call.** Do not guess a package name. If you
  are unsure, `bash` the README (`npm view <pkg>`, `curl` the repo's README) or
  ask. A wrong command fails at connect and you have to install again.
- **Only one server runs at a time.** Installing connects the new one and drops
  whichever was live. Say so if you displaced something the user was using.
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
so the user can review, reconnect or call the same server by hand later.

## Installing a skill

`write_skill` writes `<userData>/skills/<slug>/SKILL.md` and it is searchable on
the next turn. That is the whole install — there is no registry step.

To install one that already exists, fetch it and hand over its text:

1. `connect_folder` if nothing is connected, then `bash` — `git clone`, `curl`,
   or just read it out of a folder the user already gave you.
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
- **It will ask before it runs.** `run_tool` is arbitrary code on the user's Mac,
  so it sits where `bash` does — writing one never asks, running it does.

Reach for this when the user says "write a tool that…", and when you catch
yourself pasting the same six-line shell incantation a second time. Do not reach
for it when one `bash` call would do, or when a real MCP server for that service
already exists — a script that reimplements someone's API client is a liability.

## Verifying, before you say it worked

Do not report an install from the tool's own success message alone.

- MCP: make one real `mcp_tool` call and show the result.
- Skill: it is on disk once `write_skill` returns; naming it back to the user is
  enough.

If the connect failed, the message says why — a missing binary, a package that
does not exist, a server that wants an environment variable. Read it, fix the
one thing, install again. Do not fall back to instructing the user unless two
attempts have failed for a reason you cannot act on.
