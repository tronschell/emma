# Development

[`AGENTS.md`](../AGENTS.md) is the rules file. The one-line version: **no
comments, anywhere** — not in TypeScript, Rust, Zig, CSS, shell or config, and
doc comments count. Delete the ones you find in files you are already editing.
Read `AGENTS.md` before your first change; this page is the mechanics.

## Repository map

| Path | What lives there |
| --- | --- |
| [`AGENTS.md`](../AGENTS.md) | The rules |
| [`Cargo.toml`](../Cargo.toml) | Rust workspace: `crates/core` + `crates/host`, edition 2024, Apache-2.0, `publish = false` |
| [`rust-toolchain.toml`](../rust-toolchain.toml) | Rust 1.97.1, minimal, `clippy` + `rustfmt` |
| [`package.json`](../package.json) · [`justfile`](../justfile) | Shims onto `desktop`'s scripts. `just` has `check`, `test`, `dev`, `run`, `package` |
| [`crates/core/src/`](../crates/core/src) | `thread.rs`, `live.rs`, `scheduled.rs`, `research.rs`, `record.rs` (timestamps, validation, quoting), `lib.rs` (re-exports + integration tests) |
| [`crates/host/src/`](../crates/host/src) | `main.rs` — the `emma-host` NDJSON server; `runtime.rs` — resolves the data root and starts the live runtime |
| [`desktop/main/`](../desktop/main) | Electron main. 40 files: lifecycle, windows, IPC, and every runtime touching disk, a process, the network, the screen or a model |
| [`desktop/src/`](../desktop/src) | Sandboxed React 19 renderer, 41 modules. No Node, no Electron imports |
| [`desktop/src/styles/`](../desktop/src/styles) | 15 stylesheets; `tokens.css` holds the design tokens |
| [`desktop/shared/`](../desktop/shared) | 23 modules both processes agree on — `permissions.ts`, `settings.ts`, `vault.ts`, `artifacts.ts`, `plan.ts`, `workflow.ts`, `context-bar.ts`, `trace.ts`, `usage.ts`. Nothing here may import Electron |
| [`desktop/test/`](../desktop/test) | 43 `node --test` files plus `fake-acp-agent.mjs` |
| [`desktop/native/`](../desktop/native) | `quick_ask.m` → `emma-option-tap`, `transcribe.m` → `emma-transcribe`, `pty.c` → `emma-pty`, and `Info.extra.plist` |
| [`desktop/scripts/`](../desktop/scripts) | `dev.mjs`, `vendor-ripgrep.mjs`, `seed-catalog.mjs`, and the CDP drivers `drive.mjs`, `shot.mjs`, `dismiss.mjs` |
| [`desktop/skills/`](../desktop/skills) | Seven bundled skills: `artifact`, `autoresearch`, `building-emma`, `installing-capabilities`, `meta-harness`, `scheduled-tasks`, `threads` |
| `desktop/vendor/` | Gitignored. `npm run vendor:ripgrep` puts `rg` here |
| [`harness/`](../harness) | `emma-cli`. `src/acp/` (the ACP server), `src/builtins/` (registry; `builtins/emma/` holds Emma's tool *schemas*), `src/core/` (the engine), `src/gateway/` (model transport), `src/tools/`, `src/ui/` |
| [`website/`](../website) | Separate public site. Shares nothing with the app |

`harness/` is Emma's fork of [vercel-labs/fx](https://github.com/vercel-labs/fx),
Apache-2.0, © Vercel, Inc. and fx contributors. Read
[`FORK.md`](../harness/FORK.md) before touching it, and keep it honest —
that is a rule, and Apache-2.0 §4 keeps `LICENSE` and
[`THIRD_PARTY_NOTICES.md`](../harness/THIRD_PARTY_NOTICES.md) in place.

## Toolchains

| | Version | Pinned in |
| --- | --- | --- |
| macOS | Apple silicon | — |
| Node | 24+ | no `engines` field |
| Rust | 1.97.1 | [`rust-toolchain.toml`](../rust-toolchain.toml) |
| Zig | 0.16.0 minimum | [`harness/build.zig.zon`](../harness/build.zig.zon) |
| Electron | 43.4.0 | [`desktop/package.json`](../desktop/package.json) |
| TypeScript · React · Vite · Tailwind · ESLint | 6.0.3 · 19.2.8 · 8.2.2 · 4.3.3 · 10.0.1 | same |
| Xcode CLT | whatever ships `clang` | builds the three native helpers |

```sh
npm install --prefix desktop
npm run dev
```

## Checks

All six, straight from [`AGENTS.md`](../AGENTS.md). Nothing else is a check.

```sh
npm --prefix desktop run check
cargo fmt --all -- --check
cargo check --workspace --locked --all-targets
cargo test --workspace --locked
cargo clippy --workspace --locked --all-targets -- -D warnings
(cd harness && zig build test)
```

`just check` runs only the first and the third — it is not the list.

Visible or platform work is not done until the real app has been launched and the
changed interaction exercised.

## npm scripts

All in [`desktop/package.json`](../desktop/package.json).

| Script | What it actually runs |
| --- | --- |
| `check` | `test` → `typecheck` → `lint` → `build:renderer` |
| `test` | `build:main`, then `node --test dist-main/test/*.test.js`. Run it from `desktop/` — `harness.test.ts` resolves `fake-acp-agent.mjs` off `process.cwd()`, and `panes.test.ts` reads the real CSS |
| `typecheck` | `tsc --noEmit` over `tsconfig.main.json` and `tsconfig.renderer.json` |
| `lint` | `eslint . --max-warnings 0`. Browser globals for `src/`, Node globals for `main/`, `test/`, `scripts/` |
| `build:main` | `tsc -p tsconfig.main.json` → `dist-main/`. `rootDir: "."`, `module: Node16`, so it emits CommonJS and pulls `shared/` and the `.ts` half of `src/` in transitively |
| `build:renderer` | `vite build` → `dist-renderer/` |
| `build` | `build:main` then `build:renderer` |
| `build:host` | `cargo build --locked -p emma-host`, then `build:harness` |
| `build:harness` | `(cd ../harness && zig build)` → `harness/zig-out/bin/emma-cli`. **Nothing else builds the harness** |
| `build:native` | `clang` three times, all `-mmacosx-version-min=12.0`: `quick_ask.m` → `emma-option-tap` (then `--self-test`), `transcribe.m` → `emma-transcribe`, `pty.c` → `emma-pty` (then `--self-test`) |
| `vendor:ripgrep` | Downloads [ripgrep](https://github.com/BurntSushi/ripgrep) 14.1.1 for this arch into `desktop/vendor/rg`, checked against a pinned SHA-256, stamped in `vendor/rg.version`. A no-op once stamped; warns and skips off darwin |
| `seed:catalog` | Refetches OpenRouter's tool-capable model list into `main/catalog-seed.ts`. Needs no key |
| `dev` | `node scripts/dev.mjs` |
| `start` | `build:host` + `build:native` + `vendor:ripgrep` + `build`, then `electron .`. No Vite server; the built bundle |
| `package:mac` | See [Packaging](#packaging) |

## The dev loop

[`scripts/dev.mjs`](../desktop/scripts/dev.mjs) is strictly sequential; each step
must exit zero:

1. `build:host` — `cargo build -p emma-host`, then `zig build` for `emma-cli`.
2. `build:native` — the three clang helpers.
3. `build:main` — `tsc -p tsconfig.main.json`.
4. `npm exec vite -- --host 127.0.0.1`, left running.
5. After 800 ms, `npm exec electron .` with `EMMA_DEV_SERVER_URL=http://127.0.0.1:5173`.

Quitting Electron `SIGTERM`s Vite and exits with Electron's code.

Only `desktop/src/**` hot-reloads. `main/`, `shared/`, `crates/`, `harness/` and
`native/` are each compiled once, in steps 1–3 — changing any of them means quit
and rerun `npm run dev`. There is no watcher.

`vendor:ripgrep` is not in the dev path; on a fresh clone the search tool falls
through to `rg` on `PATH`, then to `grep`. Two dev instances fight over the user
data directory — give the second one `--user-data-dir`.

`drive.mjs`, `shot.mjs` and `dismiss.mjs` drive a running instance over CDP
(`EMMA_CDP_PORT`, default 9222 for `drive.mjs`, 9223 for the other two);
`drive.mjs` evaluates an expression against the real `window.emma` bridge, so it
exercises the same IPC path a click does.

```sh
node desktop/scripts/drive.mjs 'await window.emma.request("snapshot", {})'
```

Main-process `console.*` goes to the terminal that ran `npm run dev`; there is no
log file. `emma-cli`'s stderr is prefixed `emma-cli: `. `emma-host` needs no
configuration to run by hand — start it in a terminal and type JSON at it.

## Packaging

```sh
npm run package:mac
```

In order: `cargo build --locked --release -p emma-host`, `zig build
-Doptimize=ReleaseSafe`, `build:native`, `vendor:ripgrep`, `build`, then
`electron-packager . Emma --platform=darwin --arch=arm64 --out=release
--overwrite --asar`. Apple silicon only.

Source, tests and configs are excluded by three `--ignore` patterns;
`dist-main/main` and `dist-main/shared` ship, `dist-main/src` and
`dist-main/test` do not. Seven extra resources land in
`Emma.app/Contents/Resources/`: `emma-host`, `emma-cli`, `rg`,
`emma-option-tap`, `emma-transcribe`, `emma-pty`, and `skills/`. At runtime
`binary()` in `main.ts` resolves them from `process.resourcesPath` when packaged
and from the build outputs when not. `--extend-info=native/Info.extra.plist`
merges `NSSpeechRecognitionUsageDescription` in — TCC reads the *responsible*
process's plist, which for the spawned `emma-transcribe` is Emma.app.

### Release blockers

Still open, all verified against the build as it stands:

- **Bundle id is `dev.local.emma`**, set by `--app-bundle-id`. A development
  identifier; nobody owns that reverse-DNS prefix.
- **No signing identity.** The packager call has no `--osx-sign` and no
  notarization step, so Gatekeeper blocks the build on any Mac but the one that
  made it. Unsigned dev builds also never get macOS notification permission.
- **No minimum macOS version of Emma's own.** `Info.extra.plist` declares only
  the speech usage string; the bundle carries Electron's default floor. The
  three native helpers are built `-mmacosx-version-min=12.0`.
- **No update owner.** There is no channel and no updater. `emma-cli` ships
  inside the app and its inherited self-update path resolves to `null` unless
  `EMMA_UPGRADE_BASE_URL` names a loopback host, which only the fork's own
  end-to-end test does.

## Licensing

| Component | Terms |
| --- | --- |
| [`harness/`](../harness) | Apache-2.0. [`LICENSE`](../harness/LICENSE), [`FORK.md`](../harness/FORK.md), [`THIRD_PARTY_NOTICES.md`](../harness/THIRD_PARTY_NOTICES.md) — §4 requires keeping all three, and that survives the rename |
| `crates/` | `license = "Apache-2.0"` in [`Cargo.toml`](../Cargo.toml), `publish = false` |
| Departure Mono | SIL OFL 1.1, © 2022–2024 Helena Zhang. [`DepartureMono-LICENSE.txt`](../desktop/assets/DepartureMono-LICENSE.txt) |
| Brand assets | [`BRANDS-NOTICES.md`](../desktop/assets/BRANDS-NOTICES.md), [icon-sources.md](icon-sources.md). Trademarks stay with their owners |
| ripgrep | MIT/Unlicense, [BurntSushi](https://github.com/BurntSushi/ripgrep). Downloaded at build time, not vendored in git |

**There is no root `LICENSE` file.** `desktop/`, `website/` and `docs/` have no
stated terms. That is an open item.

## See also

- [architecture.md](architecture.md) — process boundaries and the trust model
- [concepts.md](concepts.md) — the vocabulary
- [harness.md](harness.md) — `emma-cli` and the ACP session
- [data.md](data.md) — every file and environment variable
- [design-system.md](design-system.md) — the renderer's visual contract
- [troubleshooting.md](troubleshooting.md) — when it breaks
