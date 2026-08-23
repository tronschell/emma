# Emma repository guide

This file is the source of truth for every agent working in this repository.

## Comments

No comments. Period. Full stop. Not in TypeScript, Rust, Zig, CSS, shell,
JSON5, or config. No file headers, no section banners, no `TODO`, no `ponytail:`
markers, no commented-out code, no explanatory notes above a function, no
restating what the next line does. Doc comments (`///`, `/** */`, JSDoc) are
comments too.

Delete comments you find in code you are already editing. If something needs
explaining, rename it, split it, or write it down in `docs/` — not in the source.

The only exceptions are lines a tool refuses to run without: shebangs,
`#!/usr/bin/env`, license headers required by a vendored file's original
license, and directives like `// @ts-expect-error`, `#![allow(...)]`, or
`eslint-disable`. A directive carries no prose.

## Layout

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
- `harness`: `emma-cli`, the fork of vercel-labs/fx driven over ACP from
  `desktop/main/harness.ts`. Apache-2.0; keep `harness/FORK.md` honest.
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
(cd harness && zig build test)
```

Visible or platform work is not complete until the real app has been launched
and the changed interaction exercised. Report unverified shortcuts, privacy
permissions, VoiceOver behavior, display geometry, signing, and non-macOS paths.
