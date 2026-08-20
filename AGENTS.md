# Emma repository guide

Emma is a macOS-first Electron application. Electron owns windows and the
sandboxed presentation, Rust owns durable data and the host boundary, and Zig
owns the agent harness. Keep those boundaries visible.

## Ownership

- `desktop/main`: Electron lifecycle, windows, global shortcuts, trusted IPC,
  and the narrow preload bridge.
- `desktop/src`: sandboxed React views and presentation state; no Node access.
- `crates/host`: NDJSON bridge, provider adapter, and Zig process boundary.
- `crates/core`: thread and knowledge records, validation, and atomic Markdown
  persistence.
- `agent`: Zig agent runtime and its wire protocol. It never renders UI or
  writes the durable stores directly.
- `website`: separate React and Tailwind public site.

Do not add a crate, trait, service locator, or plugin framework until a second
real implementation needs the boundary. Keep filesystem, process, network,
image, and model work outside the renderer. Validate every IPC and NDJSON input
at its trust boundary.

## Checks

```sh
npm --prefix desktop run check
cargo fmt --all -- --check
cargo check --workspace --locked --all-targets
cargo test --workspace --locked
cargo clippy --workspace --locked --all-targets -- -D warnings
zig build test -Doptimize=ReleaseSafe --build-file agent/build.zig
```

Visible or platform work is not complete until the real app has been launched
and the changed interaction exercised. Report unverified shortcuts, privacy
permissions, VoiceOver behavior, display geometry, signing, and non-macOS paths.
