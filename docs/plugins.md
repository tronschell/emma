# Emma plugins

Emma has a few deliberately small plugin seams instead of an in-process
JavaScript SDK:

- ChatGPT and Codex plugins — a manifest, a folder of skills, an optional MCP
  server — can be installed from a marketplace on the Plugins page, and Emma can
  write one herself;
- skills and MCP configuration can be registered from other agents in Settings;
  Emma records their existing paths in `imports.json` and does not copy secrets;
- Emma can install a skill or an MCP server for herself, into the two files she
  owns rather than into anyone else's config, and can write a tool of her own —
  one executable script, kept beside them;
- a local UI plugin can replace layout, density, colors, and component styling
  with one bounded CSS file.

## ChatGPT and Codex plugins

Emma reads [OpenAI's plugin format](https://developers.openai.com/plugins/build/plugins)
as published. A plugin is a folder holding `.codex-plugin/plugin.json` and
whichever of these it ships:

```
my-plugin/
  .codex-plugin/plugin.json
  skills/<name>/SKILL.md
  .mcp.json
  hooks/hooks.json
```

`plugin.json` carries `name`, `version`, `description`, an `interface` block, and
optional `skills`, `mcpServers` and `apps` paths. Every manifest path is resolved
inside the plugin and `realpath`-checked, so a manifest cannot point at
`../../Library`. `skills` and `mcpServers` default to the two paths above; `apps`
has no default, because the format states one only for `hooks`, so Emma reads an
`.app.json` when the manifest names it and not otherwise.

`.mcp.json` is read whether it wraps its servers (`mcpServers`, `mcp_servers`,
`servers`, `mcp`) or is a bare map of name to `{command, args, env}` — the shape
the format's examples use.

`hooks/hooks.json` is the default for `hooks`, and is read only after review —
see [Hooks](#hooks).

### `.app.json`

The format calls `apps` a compatibility field, and the file is a map of hosted
connections, not of servers:

```json
{ "apps": { "support": { "id": "plugin_asdk_app_6a4c0062", "category": "Productivity" } } }
```

An `id` is a connection registered inside a ChatGPT account and served by
ChatGPT's own remote MCP endpoint. It carries no command, no URL, and no
credential — there is nothing on this Mac to launch — and Emma has no remote MCP
transport. So Emma parses the file, records each `{name, id, category}` on the
installed plugin, and states it where the plugin is shown: *"Carries a
ChatGPT-hosted connection Emma cannot run"*, with the id. Nothing reaches
`mcpFiles`, and a plugin whose only content is an `.app.json` still installs, so
its skills and the fact of the connection stay visible rather than vanishing.

### `interface`

Emma reads the whole block: `displayName`, `shortDescription`, `longDescription`,
`developerName`, `category`, `capabilities`, `websiteURL`, `privacyPolicyURL`,
`termsOfServiceURL`, `defaultPrompt`, `brandColor`, `composerIcon`, `logo`, and
`screenshots`. `logoDark` is parsed past — Emma has one dark palette.

The three URLs must be `https:`; `javascript:`, `file:` and `data:` are dropped
rather than rendered. `brandColor` must be `#rgb` or `#rrggbb`. `defaultPrompt`
is capped at 3 entries of 128 characters, matching the format's own limit,
`capabilities` at 8, `screenshots` at 6. A field that fails its check is absent,
not an error — a bad privacy URL does not stop an install.

Asset paths follow the `skills` path rules. Images are read in
[main/marketplace.ts](../desktop/main/marketplace.ts) and never by the renderer:
each is size-capped first (512 KiB for an icon or logo, 2 MiB for a screenshot),
then sniffed for a PNG, JPEG, GIF or WebP magic number rather than trusted for
its extension, then handed over as a `data:` URL. A file named `.png` that holds
an SVG or a shell script is simply not there. Card icons share a 4 MiB budget
across the whole catalog and stop after 128 plugins.

`brandColor` tints exactly one thing: the hairline around the plugin's icon tile.
It never repaints the card and never stands in for `--accent`, which stays the
one primary action per view.

The three URLs are ordinary `<a target="_blank">` links, which is how every
external link in the app works: `setWindowOpenHandler` in
[main/main.ts](../desktop/main/main.ts) revalidates the scheme and hands it to
`shell.openExternal`, so it opens in the browser and never in an Electron window.

### Hooks

A plugin can carry shell commands to run at moments in a turn. They live in
`hooks/hooks.json`, which Emma reads when the manifest names nothing:

```json
{ "hooks": { "SessionStart": [{ "matcher": "startup", "hooks": [
  { "type": "command", "command": "date >> \"$PLUGIN_DATA/started.log\"", "statusMessage": "Noting the session", "timeout": 5 }
] }] } }
```

A manifest `hooks` entry replaces that default and takes four shapes: one path,
an array of paths, one inline hooks object, or an array of those. Paths follow
the `skills` rules. Only `"type": "command"` handlers are kept; the three levels
are event → matcher group → handlers.

| Event | Where Emma runs it |
| --- | --- |
| `SessionStart` | A thread's first turn opens a harness session. `matcher` sees `startup` |
| `UserPromptSubmit` | Immediately before `session/prompt` |
| `Stop` | When that prompt resolves, with `stop_reason` and `last_assistant_message` |
| `SessionEnd` | Sessions are dropped: a capability change, a settings change, quit. `matcher` sees `other` |

Every payload also carries `session_id`, `cwd`, `hook_event_name`, `model`,
`permission_mode`, and `transcript_path: null` — Emma keeps no transcript file.
`stop_reason` is Emma's addition; the format does not define one.

`PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreCompact`, `PostCompact`,
`SubagentStart` and `SubagentStop` are parsed and shown in the review dialog as
**Emma has no such moment**, and never run. Emma's tool loop is the harness,
which dispatches Zig function pointers in-process with no per-call child to wrap;
compaction and subagents are the harness's too. Hook *output* is captured for the
error line only: no `additionalContext`, no decision read back out.

Nothing runs in **Plan**. Plan's promise is that nothing on the Mac changes, and
a hook firing there would break it.

#### Trust

Installing a plugin does not trust its hooks. Each one is off until it is
reviewed: on the Plugins page, the installed row's **`n` hooks · review** opens a
dialog listing every hook's event, matcher, timeout and exact command text, with
one button to trust them and one to turn them off again.

Trust is pinned to a hash of the definition — event, matcher, command, status
message, timeout — recorded in `<userData>/plugin-hooks.json`. Change any of
those on disk and the hash no longer matches, so the hook is untrusted and does
not run until the new text is reviewed. The card carries `n hooks not trusted`
without opening anything. Uninstalling the plugin, or removing its marketplace,
forgets its hashes.

#### What a hook gets

`/bin/sh -c <command>`, the connected folder as working directory, the payload as
JSON on stdin, and a hand-built environment: `PATH`, `HOME`, `PLUGIN_ROOT`,
`PLUGIN_DATA`, and `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` aliases. Emma's own
environment, provider keys included, is not inherited. The two paths are passed
as variables rather than substituted into the command text, so `$PLUGIN_ROOT`
expands to one value — a plugin folder named `store; rm -rf ~` cannot become a
second command.

`PLUGIN_DATA` is `<userData>/plugin-data/<marketplace>/<plugin>/`, created `0700`
on first use. It is never the plugin root and never the workspace.

Ceilings: 32 hooks per plugin, 10s each unless the hook asks for more and 60s at
most (3s at `SessionEnd`, which is on the way out), 8 KiB of captured output,
4 KiB of command text. Hooks matching one event start together. A failure is one
line in the turn — `Hook Watch · SessionStart hook exited 3 — cannot reach the
notes folder` — never a stack trace or a stderr dump. The timeout resolves the
turn itself, so a command that backgrounds a child and holds the pipe open cannot
hang it. Each hook gets its own process group, and the timeout kills the group
rather than the shell: `sh -c` forks for anything compound, so signalling the
shell alone would leave the real work — a `python3` behind an `&&`, a
backgrounded subshell — orphaned and still running.

Parsing is in [shared/plugins.ts](../desktop/shared/plugins.ts), trust and
spawning in [main/marketplace.ts](../desktop/main/marketplace.ts), and the four
call sites in [main/harness.ts](../desktop/main/harness.ts).

### Marketplaces

A marketplace is a JSON catalog listing plugins, found at
`.agents/plugins/marketplace.json`, `.claude-plugin/marketplace.json`, or
`marketplace.json` in that order. Plugins → **Add marketplace** takes the three
fields ChatGPT's does:

| Field | Accepts |
| --- | --- |
| Source | `owner/repo`, `owner/repo@ref`, an `https://`/`ssh://`/`git@…` URL, or an absolute path to a folder on this Mac |
| Git ref | A branch or tag to pin. Overrides the `@ref` in the source. Git sources only |
| Sparse paths | One path per line, checked out with `git sparse-checkout`. Git sources only |

Git marketplaces are cloned into `<userData>/marketplaces/<name>/` shallow,
blobless, with `core.symlinks=false`, and with `GIT_TERMINAL_PROMPT=0`,
`GIT_ASKPASS=` and `ssh -oBatchMode=yes` set — a repo that wants credentials
fails fast rather than hanging on a prompt Emma cannot answer. The clone lands in
a staging directory first and is only renamed into place once its marketplace
file parses and its name is not already taken. Local marketplaces are read where
they sit; removing one never deletes the user's folder.

The name Emma files a marketplace under is the `name` in its own catalog, not
anything typed into the dialog. Refs are rejected if they start with `-` or carry
whitespace or Git revision syntax, so a source string can never become a `git`
flag.

A listed plugin's `source` may be a relative path inside the marketplace, a
`url`/`git-subdir` object naming another repo, or an `npm` object.
`policy.installation` of `NOT_AVAILABLE` blocks Install; `policy.authentication`
of `ON_INSTALL` is surfaced on the card as "Signs in on install".

### npm sources

```json
{ "source": "npm", "package": "@example/codex-plugin", "version": "^1.2.0", "registry": "https://registry.npmjs.org" }
```

`package` is required and may carry a scope. `version` is optional and takes a
version, a distribution tag, or a range — never a path or URL selector, so
anything holding `/` or `:` is refused. `registry` is optional and must be an
`https:` URL with no embedded credentials, query, or fragment. Nothing that could
be read as an argv flag survives: a leading `-` is refused in every field and the
spec is passed after a `--` terminator.

Install runs `npm pack <spec> --ignore-scripts --pack-destination <dir>`, plus
`--registry` when the entry names one. `pack` downloads and never executes, and
`--ignore-scripts` holds even if the tarball declares `preinstall`. The tarball
is gunzipped in-process and piped to the system `tar`, which lets Emma count the
decompressed bytes as they go and abort past 256 MB — a small tarball that
expands to a full disk stops at the ceiling instead. `tar` reads the stream on
stdin, so it never sees a path Emma has not already measured, and it refuses
`..` members and strips leading `/` by default. Since an npm tarball nests
everything under `package/`, that directory is the plugin root —
`realpath`-checked to be inside the checkout like every other path. Emma runs `npm` but never installs
it: a Mac without it gets a sentence saying so, not an `ENOENT`. Registry
authentication is whatever `npm` itself is configured with; Emma reads no token
and writes no `.npmrc`. The checkout lands in
`<userData>/marketplaces/.remote/<marketplace>/<plugin>/` beside the Git ones and
is replaced wholesale on reinstall.

### The Plugins page

Under Scheduled in the sidebar. A search box filters on name, description,
category and keywords; chips filter by marketplace and by category, both derived
from the catalogs on disk rather than a fixed list. Each marketplace gets a
section with Update and Remove, and each plugin a card with Install or Remove.
The Installed list at the bottom is the record that actually drives capabilities.

A card shows the icon, the category, the name, one line of description, and the
keywords — `longDescription` is deliberately not on it. The name is a button; it
opens a detail dialog on the app's `.modal-backdrop` + `.agent-dialog` surface
with the long description, screenshots, capabilities, starter prompts, the three
links, and any hosted connection. The dialog fetches that material on open
through `emma:plugin-detail`, so screenshots are read from disk only when someone
asks to see them.

Installed plugins are recorded in `<userData>/installed-plugins.json` — not in
`imports.json`, which is rewritten wholesale from the Settings import selection
and would delete them. `loadManifest` appends each installed plugin to the
capability manifest as a `plugin:<marketplace>/<name>` source, so its skills
reach the harness skill mirror and its MCP servers reach `session/new` through
exactly the path an imported source takes. Installing calls `toolsChanged()`,
which drops harness sessions, so a plugin is live on the next turn with nothing
to relaunch. A plugin skill whose name collides with one of Emma's own is skipped
in the flat mirror rather than overwriting it.

Ceilings: 32 marketplaces, 128 installed plugins, 64 skills per plugin, 16 hosted
app ids per plugin, 512 KiB per JSON file, 512 KiB per icon, 2 MiB per
screenshot, 4 MiB of card icons per catalog read, 256 MB unpacked per npm
package, 120s clone timeout, 120s for `npm pack`, 30s for other Git calls.

### Plugins Emma writes

`write_plugin` takes a name, a description, an optional category, and a list of
skills, and writes a real plugin folder under
`<userData>/marketplaces/emma/plugins/<name>/`: `.codex-plugin/plugin.json` plus
one `skills/<name>/SKILL.md` each. Frontmatter is generated unless the
instructions already begin with `---`. It registers `emma` as a local marketplace
named "Written by Emma", adds the plugin to its catalog, and installs it — so
what Emma writes appears on the same page as everything installed, and the folder
is portable to any other agent that reads the format.

The parsing half lives in [shared/plugins.ts](../desktop/shared/plugins.ts) with
no Electron imports, so it is unit-tested directly; disk and Git work is in
[main/marketplace.ts](../desktop/main/marketplace.ts) and never reaches the
renderer, which only ever receives a validated `PluginCatalog` over IPC.

## Installing without a relaunch

Emma owns exactly two capability files under her user data: `skills/<slug>/SKILL.md`
and `mcp.json`. `write_skill` writes the first and `install_mcp` writes the
second, and both are synthesized into the manifest as an implicit `emma` source
so they need no import step. Enumeration re-reads them on every call, and writing
either file calls `toolsChanged()`, which drops the harness's sessions — so a
capability installed mid-turn is live on the next turn with nothing to relaunch.
An MCP server is connected when that next session is built, and its tools are
found from then on with the harness's own `mcp_search_tools`.

`install_mcp` asks in every mode except full access, and the question carries the
command, its arguments, and the environment key names. That ask is the review,
and it is the whole review: nothing else stands between the model naming a
program and the harness launching it. Environment *values* are never rendered,
exactly as with an imported config. Writing a name that already exists replaces
that entry, which is how a wrong command gets fixed.

## Tools Emma writes

A skill is a lesson and an MCP server is someone else's program; a tool is the
third case and the one neither covers — a script of Emma's own, written once and
called by name afterwards. `write_tool` writes `tools/<slug>/run`, executable,
beside its one-line `about.txt`; `run_tool` lists them and runs one with the
connected folder as its working directory, handing it the call's `input` as its
single argument and returning what it printed. The `#!` line is required and the
script runs under a login shell, so it finds the same interpreters the user's
terminal does. Writing the same name replaces it, which is how a tool that
turned out wrong gets fixed.

The two halves are gated apart, because they are different acts: writing a file
into Emma's own folder sits with `write_skill` and never asks, while running one
is arbitrary code on the user's Mac and sits exactly where `bash` does.

## UI plugins

Place UI plugins under `~/Library/Application Support/Emma/plugins/<id>`:

```json
{
  "id": "my-emma-ui",
  "name": "My Emma UI",
  "version": "1.0.0",
  "uiStylesheet": "theme.css"
}
```

The directory name must equal `id`. Emma loads at most 32 stylesheets, each at
most 128 KiB. `@import` and `url(...)` are rejected so a visual plugin cannot
silently fetch remote resources. CSS can comprehensively restyle and rearrange
the existing semantic UI; executable functionality belongs in a selected skill
or lazily searched MCP tool, where permission and context boundaries are visible.

Emma also ships her own skills in `desktop/skills/`. Each launch rewrites them
into `<userData>/skills/` and the harness profile's `.fx/skills/`, so they are
present before any import and always match the running build; a bundled slug is
app-owned and a `write_skill` over it is replaced on the next launch.

Imported skills are inactive references until selected. An imported MCP server is
launched by the harness when it builds a session, but its tools stay behind
`mcp_search_tools` until the model asks for one. Either way a config's
credentials and its whole tool schema never enter model context.

The current imported-capability slice searches skill directory metadata and loads
one selected `SKILL.md` only after explicit attachment; referenced skill files and
assets are not loaded in this slice. It supports the common
JSON `mcpServers`/`mcp` shapes and the Codex-style `[mcp_servers.<name>]` TOML
stdio subset (`command`, `args`, and `env`). Config files and environment values
stay in Electron's main process; the renderer receives only bounded metadata,
redacted arguments and environment key names — enough to list a server by name in
the `/` menu, and no more. Emma speaks no MCP herself: the parsed servers are
handed to the harness on `session/new`, and it is the harness that runs
`initialize`, holds the tool list behind `mcp_search_tools` and
`mcp_select_tool`, and calls a selected tool by its own name. Remote transports
stay outside this slice — only a stdio command is parsed, and only a stdio
command is passed on.

The knowledge-artifact data seam follows the same boundary: plugins register
versioned block types and render validated declarative payloads in a sandbox.
Each block must provide a portable Markdown/data fallback. Filesystem, network,
model, and connector access remain explicit capabilities rather than ambient
renderer privileges. This renderer SDK is a product contract, not part of the
current vertical slice.
