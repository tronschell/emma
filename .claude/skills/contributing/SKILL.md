---
name: contributing
description: How to contribute to the Emma repository — the house standards, which layer to rebuild for a given change, how to run a dev instance (and a second one that will not fight the first), how to run against the packaged build, the six checks, and how to verify a change in the real app. Use for any change to Emma's own desktop, crates, or harness code, or when asked how to build, run, check, or package this repo.
---

# Contributing to Emma

## Read first

[`AGENTS.md`](../../../AGENTS.md) is the contract, not a style guide. The rule
that catches everyone: **no comments, anywhere** — TypeScript, Rust, Zig, CSS,
shell, config, and doc comments (`///`, `/** */`, JSDoc) count. Delete the ones
you find in files you are already editing. Only tool-mandated lines survive:
shebangs, license headers on vendored files, and directives like
`// @ts-expect-error` or `#![allow(...)]`.

The rest of the standards:

- **Layer boundaries stay visible.** `desktop/main` owns windows, shortcuts, IPC
  and every privileged runtime; `desktop/src` is a sandboxed renderer with no
  Node and no Electron imports; `desktop/shared` is what both agree on and may
  not import Electron; `crates/host` is the NDJSON bridge; `crates/core` owns
  durable Markdown records; `harness/` owns the agent loop. Filesystem, process,
  network, image and model work never moves into the renderer.
- **Validate at the trust boundary.** Every IPC parameter, NDJSON line, imported
  manifest and model-supplied argument is parsed and bounded where it arrives.
  `desktop/main/ipc.ts` and `desktop/main/tools.ts` are the house style. The
  guard goes in the shared function, not in each caller.
- **No new dependency, crate, trait, service locator or plugin framework** until
  a second real implementation needs the boundary. One implementation is not a
  boundary.
- **Shortest diff that works, fewest files.**
- **One runnable check for non-trivial logic.** `node:test` files in
  `desktop/test/*.test.ts`; copy a neighbour's shape.
- `harness/` is a fork of [vercel-labs/fx](https://github.com/vercel-labs/fx),
  Apache-2.0. Read [`harness/FORK.md`](../../../harness/FORK.md) before touching
  it and keep it honest; `LICENSE` and `THIRD_PARTY_NOTICES.md` stay.

Start feature branches from `dev` and open PRs against `dev`. Squash-merge
features with a conventional PR title. Only a prepared release on `dev` is
promoted to `main`, using a merge commit. See [releasing](../releasing/SKILL.md).
Preserve unrelated work already in the checkout.

## Running it

Three ways, and they are not interchangeable.

| | Command | What you get |
| --- | --- | --- |
| **Dev** | `npm run dev` | Builds host + native + main, starts Vite, launches Electron against it. Only `desktop/src/**` hot-reloads |
| **Prod-ish** | `npm --prefix desktop start` | Same builds, no Vite — Electron runs the built bundle. Closest thing to the shipped app without packaging |
| **Packaged** | `npm run package:mac` | Release Rust + ReleaseSafe Zig + `electron-packager` → `desktop/release/Emma-darwin-arm64/Emma.app`. Apple silicon only, unsigned |

First clone:

```sh
npm install --prefix desktop
npm run dev
```

`scripts/dev.mjs` is strictly sequential and has **no watcher**. A change to
`main/`, `shared/`, `crates/`, `harness/` or `native/` means quit and rerun
`npm run dev`. A main-process edit that was not rebuilt *and relaunched* shows up
as red `No handler registered for 'emma:…'` in the window — that is a stale main
process, not your bug.

### A second instance, without killing the first

A running Emma holds Electron's single-instance lock, so a plain `electron .`
exits silently with code 0 and looks like a build failure. Give the second one
its own profile, and its own data root so it does not edit real threads:

```sh
cd desktop && EMMA_DATA_DIR=/tmp/emma-dev-data ./node_modules/.bin/electron . \
  --user-data-dir=/tmp/emma-dev-profile --remote-debugging-port=9223
```

The unsigned dev binary never gets macOS notification permission — only the
packaged app is prompted.

### Rebuild only the layer you touched

| Changed | Build with | Then |
| --- | --- | --- |
| `desktop/src` | `npm --prefix desktop run build:renderer` | reload the window |
| `desktop/main`, `desktop/shared` | `npm --prefix desktop run build:main` | **relaunch Electron** |
| `crates/` | `npm --prefix desktop run build:host` | relaunch |
| `harness/` | `npm --prefix desktop run build:harness` | relaunch |
| `desktop/native/*.m`, `*.c` | `npm --prefix desktop run build:native` | relaunch |

## Checks

All six. Nothing else is a check — `just check` runs two of them and is not the
list.

```sh
npm --prefix desktop run check
cargo fmt --all -- --check
cargo check --workspace --locked --all-targets
cargo test --workspace --locked
cargo clippy --workspace --locked --all-targets -- -D warnings
(cd harness && zig build test)
```

`npm run check` is test → typecheck → lint → renderer build. Never run two at
once: concurrent Vite builds clash over `dist-renderer`.

## Verifying

Launching is not verifying. Visible or platform work is not done until the real
app has been launched and the changed interaction exercised.

```sh
EMMA_CDP_PORT=9223 node desktop/scripts/drive.mjs \
  'return await window.emma.request("snapshot", {})'
node desktop/scripts/shot.mjs 9223 /tmp/emma-shots 1440 900
```

`drive.mjs` evaluates against the real `window.emma` bridge — the same path a
click takes. Its argument is an async function *body*, so it needs `return`.
`shot.mjs` reloads first, so it picks up a renderer rebuild but not a main one.
A screenshot that disagrees with the source is a stale bundle: rebuild, confirm
over CDP, then believe the picture.

Report what you did not verify. Privacy permissions, VoiceOver, display
geometry, signing and non-macOS paths are called out, not implied.

## Deeper

- [`releasing`](../releasing/SKILL.md) — conventional PR titles, the
  generated changelog, CI, and how a build reaches a release
- [`docs/development.md`](../../../docs/development.md) — every npm script, the
  full repo map, toolchain pins, packaging and the open release blockers
- [`docs/architecture.md`](../../../docs/architecture.md) — process boundaries
  and the trust model
- [`docs/data.md`](../../../docs/data.md) — every file and environment variable
- [`docs/troubleshooting.md`](../../../docs/troubleshooting.md) — when it breaks
- [`docs/design-system.md`](../../../docs/design-system.md) — the renderer's
  visual contract
