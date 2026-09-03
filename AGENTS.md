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
- `crates/host`: NDJSON bridge onto the stores. It talks to no model and answers
  requests only — the app process drives every provider call.
- `crates/core`: thread, scheduled, and research records, validation, and atomic
  Markdown persistence.
- `harness`: `emma-cli`, the fork of vercel-labs/fx driven over ACP from
  `desktop/main/harness.ts`. Apache-2.0; keep `harness/FORK.md` honest.

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
(cd harness && zig build test)
```

Visible or platform work is not complete until the real app has been launched
and the changed interaction exercised. Report unverified shortcuts, privacy
permissions, VoiceOver behavior, display geometry, signing, and non-macOS paths.

## Releasing

Feature branches start from and squash-merge into `dev`, the default branch.
Every PR runs the full `ci` workflow. Only the owner can merge `dev` into
`main`; that merge commit is the release. The `release` workflow reads the
root `package.json` version, skips if that version is already published, and
otherwise builds, signs, notarizes, and publishes the app with generated notes.
Bump the version on `dev` before promoting. There is no changelog file, release
PR, or hand-made tag.

The workflows in `.github/workflows/` run the checks above and nothing else that
cannot be run locally. They are config, so the no-comments rule applies to them.

Full contract: [`.claude/skills/releasing/SKILL.md`](.claude/skills/releasing/SKILL.md).
