# Emma plugins

Emma has two deliberately small plugin seams instead of an in-process JavaScript
SDK:

- skills and MCP configuration can be registered from other agents in Settings;
  Emma records their existing paths in `imports.json` and does not copy secrets;
- Emma can install a skill or an MCP server for herself, into the two files she
  owns rather than into anyone else's config, and can write a tool of her own —
  one executable script, kept beside them;
- a local UI plugin can replace layout, density, colors, and component styling
  with one bounded CSS file.

## Installing without a relaunch

Emma owns exactly two capability files under her user data: `skills/<slug>/SKILL.md`
and `mcp.json`. `write_skill` writes the first and `install_mcp` writes the
second, and both are synthesized into the manifest as an implicit `emma` source
so they need no import step. Enumeration re-reads them on every call and the
tool list is recomputed on every loop iteration, so a capability installed
mid-turn is usable in that turn — installing an MCP server connects it in the
same call, which is what makes `mcp_tool` appear on the next iteration.

`install_mcp` asks in every mode except full access, and the question carries the
command, its arguments, and the environment key names. That ask is the review:
it stands for the same one-use token the capability panel mints, so an agent
install and a hand install cross the same boundary. Environment *values* are
never rendered, exactly as with an imported config. The single-live-session
ceiling still holds — installing replaces whatever server was connected.

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

Imported skills and MCP files are inactive references until selected. This keeps
first launch safe and prevents config credentials or every tool schema from
entering model context.

The current imported-capability slice searches skill directory metadata and loads
one selected `SKILL.md` only after explicit attachment; referenced skill files and
assets are not loaded in this slice. It supports the common
JSON `mcpServers`/`mcp` shapes and the Codex-style `[mcp_servers.<name>]` TOML
stdio subset (`command`, `args`, and `env`). Config files and environment values
stay in Electron's main process; the renderer receives only bounded metadata,
redacted arguments, environment key names, and a one-use permission-review
token. A review starts exactly one selected stdio server, performs bounded
`initialize` and `tools/list`, then search exposes compact tool metadata and
selection exposes only one schema. `tools/call` is a separate user-invoked
action. Provider-driven autonomous tool loops, remote MCP transports, pagination
beyond the first bounded tool list, and JSON-Schema argument validation are
deliberately outside this slice.

The knowledge-artifact data seam follows the same boundary: plugins register
versioned block types and render validated declarative payloads in a sandbox.
Each block must provide a portable Markdown/data fallback. Filesystem, network,
model, and connector access remain explicit capabilities rather than ambient
renderer privileges. This renderer SDK is a product contract, not part of the
current vertical slice.
