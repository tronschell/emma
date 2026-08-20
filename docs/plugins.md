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

The planned knowledge-artifact seam follows the same boundary: plugins register
versioned block types and render validated declarative payloads in a sandbox.
Each block must provide a portable Markdown/data fallback. Filesystem, network,
model, and connector access remain explicit capabilities rather than ambient
renderer privileges. This renderer SDK is a product contract, not part of the
current vertical slice.
