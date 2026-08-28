# Plugins and extensions

Four seams, no in-process JavaScript SDK:

| Seam | What it is |
| --- | --- |
| [Imports](#imports) | Skills and MCP servers already set up for another agent, referenced where they sit |
| [Emma's own capabilities](#emmas-own-capabilities) | A skill, a tool, or an MCP server Emma writes for herself, live in the same turn |
| [Plugins](#plugins) | The ChatGPT and Codex plugin format — manifest, skills, MCP config, hooks — from a marketplace |
| [UI plugins](#ui-plugins) | One bounded CSS file that restyles the app |

A fifth seam is Emma writing interface rather than capability: the `component`
tool, whose widgets land in the context bar. See [components.md](components.md).

## Imports

Settings → **Imports & plugins** scans this Mac for skills and MCP configs
already set up for another agent and records their **paths** in
`<userData>/imports.json`. Nothing is copied, and no secret is read.

Sources are defined in
[`desktop/main/imports.ts`](../desktop/main/imports.ts):

| Agent | Skills | MCP config |
| --- | --- | --- |
| Codex (OpenAI) | `~/.codex/skills` | `~/.codex/config.toml` |
| Claude (Anthropic) | `~/.claude/skills` | `~/.claude.json` |
| Antigravity (Google) | `~/.gemini/antigravity/skills` | `~/.gemini/antigravity/mcp_config.json` |
| Pi | `~/.pi/agent/skills` | `~/.pi/agent/settings.json` |
| OpenCode | `~/.config/opencode/skills`, `~/.opencode/skills` | `~/.config/opencode/opencode.json`, `.jsonc` |
| Cursor | `~/.cursor/skills` | `~/.cursor/mcp.json` |
| Windsurf | `~/.windsurf/skills` | `~/.codeium/windsurf/mcp_config.json` |
| Devin (Cognition) | `~/.devin/skills` | `~/.devin/mcp.json` |

A skill directory counts only if it holds `SKILL.md`. Config parsing handles the
JSON `mcpServers` / `mcp_servers` / `servers` / `mcp` shapes and the Codex-style
`[mcp_servers.<name>]` TOML stdio subset (`command`, `args`, `env`). Only stdio
is parsed and only stdio is passed on — there is no remote MCP transport.

An imported skill is an inactive reference until a thread attaches it; its
`SKILL.md` is loaded only on attachment. An imported MCP server is launched by
the harness when it builds a session, but its tools stay behind
`mcp_search_tools` until the model asks for one.

Configs and environment values stay in the main process. The renderer receives
bounded metadata, redacted arguments, and environment **key names** only.

Ceilings ([`desktop/main/capabilities.ts`](../desktop/main/capabilities.ts)):
16 skill roots, 128 skills per root, 64 KiB per `SKILL.md`, 16 MCP files, 32
servers, 128 KiB manifest, 256 KiB config.

## Emma's own capabilities

Emma owns four places under `<userData>`, and writes only there:

| Path | Written by | What it holds |
| --- | --- | --- |
| `skills/<slug>/SKILL.md` | `write_skill` | A durable lesson |
| `mcp.json` | `install_mcp` | The one MCP config Emma owns |
| `tools/<slug>/run` + `about.txt` | `write_tool` | An executable script of her own |
| `components/<id>/module.js` + `meta.json` | `component` | A widget in the context bar |

Both capability files are synthesized into the manifest as an implicit `emma`
source, so they need no import step. Enumeration re-reads them on every call and
writing either calls `toolsChanged()`, which drops the harness's sessions — a
skill or server installed mid-turn is usable on the next turn with nothing to
relaunch. An MCP server connects when that session is built.

Writing an existing slug replaces it. That is how a wrong lesson, tool, or
command gets fixed.

### The extension tools

| Tool | Does | Gate in ask / acceptEdits |
| --- | --- | --- |
| `write_skill` | Writes `skills/<slug>/SKILL.md` | auto |
| `write_tool` | Writes `tools/<slug>/run` (executable) and `about.txt` | auto |
| `write_plugin` | Packages skills as a plugin and installs it | auto |
| `install_mcp` | Adds a server to `mcp.json` | **ask** |
| `run_tool` | Lists the written tools and runs one | **ask** |
| `component` | Writes `components/<id>/module.js` and its `meta.json` | auto |

Gates are in [`desktop/shared/permissions.ts`](../desktop/shared/permissions.ts);
in `full` all six are auto, and in `auto` the `ask` rows are used and those calls
go to the verifier model.

`component` is auto for the same reason `write_skill` is: it writes a file into
Emma's own folder. The code it writes reaches the network only through
`emma:component-fetch`, which is public https, and only with the variables the
component declared — so there is no arbitrary-code gate to place on it.

The two halves of a tool are gated apart on purpose: writing a file into Emma's
own folder never asks, while running one is arbitrary code on the user's Mac and
sits exactly where `cli` does. `run_tool` runs the script with the connected
folder as its working directory, hands the call's `input` as its single
argument, and returns what it printed. A `#!` line is required, and the script
runs under a login shell so it finds the same interpreters the user's terminal
does.

`install_mcp` asks in every mode except full access, and the question carries
the command, its arguments, and the environment key names — never the values.
That ask is the whole review: nothing else stands between the model naming a
program and the harness launching it.

### Bundled skills

Emma ships her own skills in [`desktop/skills/`](../desktop/skills): `artifact`,
`autoresearch`, `building-emma`, `installing-capabilities`, `meta-harness`,
`scheduled-tasks`, `threads`. Each launch rewrites them into `<userData>/skills/`
and the harness profile's `.fx/skills/`, so they are present before any import
and always match the running build. A bundled slug is app-owned: a `write_skill`
over one is replaced on the next launch.

`mirrorSkillsToHarness` copies every visible skill — bundled, imported, written,
and plugin — into the harness's own `.fx/skills` root, because the harness
discovers skills from its `$HOME`. Copied, not symlinked; the harness drops
symlinked skill directories. A skill switched off in Settings is simply not
written. A missing `name`/`description` frontmatter header is generated from the
first non-heading line, since the harness's catalog is description-driven.

## Plugins

Emma reads [OpenAI's plugin format](https://developers.openai.com/plugins/build/plugins)
as published. A plugin is a folder:

```
my-plugin/
  .codex-plugin/plugin.json
  skills/<name>/SKILL.md
  .mcp.json
  hooks/hooks.json
```

`plugin.json` carries `name`, `version`, `description`, an `interface` block,
and optional `skills`, `mcpServers`, `apps`, and `hooks` paths. `skills` and
`mcpServers` default to the two paths above; `apps` has no default. Every
manifest path is resolved inside the plugin and `realpath`-checked, so a
manifest cannot point at `../../Library`.

`.mcp.json` is read whether it wraps its servers (`mcpServers`, `mcp_servers`,
`servers`, `mcp`) or is a bare map of name to `{command, args, env}`.

### `interface`

Emma reads `displayName`, `shortDescription`, `longDescription`,
`developerName`, `category`, `capabilities`, `websiteURL`, `privacyPolicyURL`,
`termsOfServiceURL`, `defaultPrompt`, `brandColor`, `composerIcon`, `logo`, and
`screenshots`. `logoDark` is parsed past — Emma has one dark palette.

The three URLs must be `https:`. `brandColor` must be `#rgb` or `#rrggbb`.
`defaultPrompt` caps at 3 entries of 128 characters, `capabilities` at 8,
`screenshots` at 6. A field that fails its check is absent, not an error.

Images are read in [`main/marketplace.ts`](../desktop/main/marketplace.ts) and
never by the renderer: size-capped (512 KiB icon or logo, 2 MiB screenshot),
sniffed for a PNG, JPEG, GIF, or WebP magic number rather than trusted for their
extension, then handed over as a `data:` URL. A file named `.png` holding a shell
script is simply not there.

`brandColor` tints exactly one thing: the hairline around the plugin's icon tile.
It never stands in for `--accent`.

### `.app.json`

A map of ChatGPT-hosted connections, not of servers:

```json
{ "apps": { "support": { "id": "plugin_asdk_app_6a4c0062", "category": "Productivity" } } }
```

An `id` names a connection inside a ChatGPT account served by ChatGPT's own
remote MCP endpoint — no command, no URL, no credential, and Emma has no remote
MCP transport. So Emma records each `{name, id, category}` and states it where
the plugin is shown: *"Carries a ChatGPT-hosted connection Emma cannot run"*.
Nothing reaches `mcpFiles`, and a plugin whose only content is an `.app.json`
still installs.

### Hooks

Shell commands run at moments in a turn, from `hooks/hooks.json` or from a
manifest `hooks` entry (one path, an array of paths, one inline object, or an
array of those). Only `"type": "command"` handlers are kept; the three levels
are event → matcher group → handlers.

Four events run:

| Event | When |
| --- | --- |
| `SessionStart` | A thread's first turn opens a harness session. `matcher` sees `startup` |
| `UserPromptSubmit` | Immediately before `session/prompt` |
| `Stop` | When that prompt resolves, with `stop_reason` and `last_assistant_message` |
| `SessionEnd` | Sessions are dropped: a capability change, a settings change, quit. `matcher` sees `other` |

Every payload also carries `session_id`, `cwd`, `hook_event_name`, `model`,
`permission_mode`, and `transcript_path: null` — Emma keeps no transcript file.
`stop_reason` is Emma's addition; the format defines none.

`PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreCompact`, `PostCompact`,
`SubagentStart`, and `SubagentStop` are parsed and shown in the review dialog as
**Emma has no such moment**, and never run. The tool loop is the harness, which
dispatches Zig function pointers in-process with no per-call child to wrap;
compaction and subagents are the harness's too. Hook *output* is captured for
the error line only — no `additionalContext`, no decision read back.

#### Trust

Installing a plugin does not trust its hooks. Each is off until
reviewed: the installed row's **`n` hooks · review** lists every hook's event,
matcher, timeout, and exact command text. Trust is pinned to a hash of that
definition, recorded in `<userData>/plugin-hooks.json`; change the text on disk
and the hook is untrusted again. Uninstalling the plugin, or removing its
marketplace, forgets its hashes.

**What a hook gets.** `/bin/sh -c <command>`, the connected folder as working
directory, the payload as JSON on stdin, and a hand-built environment: `PATH`,
`HOME`, `PLUGIN_ROOT`, `PLUGIN_DATA`, and `CLAUDE_PLUGIN_ROOT` /
`CLAUDE_PLUGIN_DATA` aliases. Emma's own environment, provider keys included, is
not inherited. The two paths are passed as variables rather than substituted
into the command text, so a plugin folder named `store; rm -rf ~` cannot become
a second command. `PLUGIN_DATA` is
`<userData>/plugin-data/<marketplace>/<plugin>/`, created `0700` on first use.

**Ceilings.** 32 hooks per plugin; 10s each unless the hook asks for more, 60s
at most, 3s at `SessionEnd`; 8 KiB of captured output; 4 KiB of command text.
Hooks on one event start together. A failure is one line in the turn, never a
stack trace. Each hook gets its own process group and the timeout kills the
group, not just the shell — `sh -c` forks for anything compound.

Parsing is in [`shared/plugins.ts`](../desktop/shared/plugins.ts), trust and
spawning in [`main/marketplace.ts`](../desktop/main/marketplace.ts), and the
call sites in [`main/harness.ts`](../desktop/main/harness.ts).

### Marketplaces

A JSON catalog at `.agents/plugins/marketplace.json`,
`.claude-plugin/marketplace.json`, or `marketplace.json`, in that order.
**Add marketplace** takes three fields:

| Field | Accepts |
| --- | --- |
| Source | `owner/repo`, `owner/repo@ref`, an `https://` / `ssh://` / `git@…` URL, or an absolute path on this Mac |
| Git ref | A branch or tag to pin. Overrides `@ref`. Git sources only |
| Sparse paths | One per line, checked out with `git sparse-checkout`. Git sources only |

The first time the Plugins page opens, Emma adds `openai/plugins` — OpenAI's own
catalog, filed as **Codex official**. It is an ordinary Git marketplace from
then on. The seeding is marked by `<userData>/marketplaces/.default-added`,
written only once the clone lands, so removing it is final and a failed clone is
retried next time.

Git marketplaces clone into `<userData>/marketplaces/<name>/` shallow, blobless,
with `core.symlinks=false`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=`, and
`ssh -oBatchMode=yes` — a repo wanting credentials fails fast rather than
hanging on a prompt Emma cannot answer. The clone lands in staging and is only
renamed into place once its marketplace file parses and its name is free. Local
marketplaces are read where they sit; removing one never deletes the folder.

A marketplace is filed under the `name` in its own catalog, not what was typed.
Refs starting with `-` or carrying whitespace or Git revision syntax are
rejected, so a source string can never become a `git` flag.
`policy.installation: NOT_AVAILABLE` blocks Install; `policy.authentication:
ON_INSTALL` shows "Signs in on install".

### npm sources

```json
{ "source": "npm", "package": "@example/codex-plugin", "version": "^1.2.0", "registry": "https://registry.npmjs.org" }
```

`package` is required and may be scoped. `version` takes a version, tag, or
range — never a path or URL selector. `registry` must be `https:` with no
embedded credentials, query, or fragment. A leading `-` is refused in every
field and the spec is passed after a `--` terminator.

Install runs `npm pack <spec> --ignore-scripts --pack-destination <dir>`. `pack`
downloads and never executes, and `--ignore-scripts` holds even if the tarball
declares `preinstall`. The tarball is gunzipped in-process and piped to the
system `tar`, so Emma counts decompressed bytes as they go and aborts past
256 MB. `tar` reads from stdin, refuses `..` members, and strips leading `/`.
The `package/` directory is the plugin root, `realpath`-checked like every other
path. Emma runs `npm` but never installs it; a Mac without it gets a sentence,
not an `ENOENT`. Registry auth is whatever `npm` itself is configured with —
Emma reads no token and writes no `.npmrc`. The checkout lands in
`<userData>/marketplaces/.remote/<marketplace>/<plugin>/`.

### The Plugins page

Under **Scheduled** in the sidebar. Search filters on name, description,
category, and keywords; chips filter by marketplace and category, both derived
from the catalogs on disk. A card shows icon, category, name, one line, and
keywords; the name opens a detail dialog that fetches the long description,
screenshots, capabilities, starter prompts, links, and hosted connections
through `emma:plugin-detail` on open.

Installed plugins are recorded in `<userData>/installed-plugins.json`, **not**
in `imports.json`, which is rewritten wholesale from the Settings selection and
would delete them. `loadManifest` appends each as a `plugin:<marketplace>/<name>`
source, so its skills reach the harness mirror and its MCP servers reach
`session/new` by exactly the path an imported source takes. Installing calls
`toolsChanged()`, so a plugin is live on the next turn. A plugin skill whose
name collides with one of Emma's own is skipped rather than overwriting it.

Ceilings: 32 marketplaces, 128 installed plugins, 64 skills per plugin, 16
hosted app ids, 512 KiB per JSON file, 512 KiB per icon, 2 MiB per screenshot,
4 MiB of card icons per catalog read, 256 MB unpacked per npm package, 120s
clone timeout, 120s for `npm pack`, 30s for other Git calls.

### Plugins Emma writes

`write_plugin` takes a name, a description, an optional category, and a list of
skills, and writes a real plugin folder under
`<userData>/marketplaces/emma/plugins/<name>/`: `.codex-plugin/plugin.json` plus
one `skills/<name>/SKILL.md` each. Frontmatter is generated unless the
instructions already begin with `---`. It registers `emma` as a local
marketplace named "Written by Emma", adds the plugin to its catalog, and
installs it — so the folder is portable to any other agent that reads the
format.

## UI plugins

`~/Library/Application Support/Emma/plugins/<id>/plugin.json`:

```json
{ "id": "my-emma-ui", "name": "My Emma UI", "version": "1.0.0", "uiStylesheet": "theme.css" }
```

The directory name must equal `id`, which is lowercase-hyphen and at most 64
characters; `version` must be `x.y.z`; `uiStylesheet` must be a bare `.css`
filename inside the plugin, `realpath`-checked. At most 32 plugins load, each
manifest at most 32 KiB and each stylesheet at most 128 KiB. `@import` and
`url(...)` are rejected, so a visual plugin cannot fetch a remote resource. A
plugin that fails any check is skipped with a console warning; the rest load.

CSS can restyle and rearrange the whole semantic UI. Executable functionality
belongs in a skill or an MCP tool, where the permission boundary is visible.
See [design-system.md](design-system.md) for the tokens worth overriding.

Loader: [`desktop/main/plugins.ts`](../desktop/main/plugins.ts).
