# Emma plugins

Emma has two deliberately small plugin seams instead of an in-process JavaScript
SDK:

- skills and MCP configuration can be registered from other agents in Settings;
  Emma records their existing paths in `imports.json` and does not copy secrets;
- a local UI plugin can replace layout, density, colors, and component styling
  with one bounded CSS file.

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
