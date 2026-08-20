# Emma

Emma is a lightweight macOS agent surface and exportable knowledge base. A
global shortcut opens a compact surface near the display notch, captures only
user-approved context, asks a Zig agent to analyze it, and saves the result as
portable Markdown.

This repository currently targets one production vertical slice:

```text
hotkey -> inspect context -> analyze -> save Markdown -> render in GPUI
```

## Workspace

```text
agent/          Zig agent sidecar, based on fx's embeddable architecture
crates/core/    Knowledge and protocol domain
crates/ui/      GPUI views and controls
crates/desktop/ macOS lifecycle, windows, hotkey, and capture bridge
docs/           Product and architecture contracts
```

GPUI is pinned to Zed commit
`7733b9922665f103abda7c6a3fde6b9dfdc8eba9`; the fx reference is pinned to
`b1774fbf6c7602b503026f96f6e960e946c692ef`. Rust 1.97.1 and Zig 0.16.0 are
the development toolchains.

`dev.local.emma` is the provisional development identity. A publisher-owned
bundle ID, minimum supported macOS version, signing identity, distribution,
and update owner remain release blockers.

