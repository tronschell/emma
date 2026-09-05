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
| [`crates/core/src/`](../crates/core/src) | `thread.rs`, `live.rs`, `scheduled.rs`, `record.rs` (timestamps, validation, quoting), `lib.rs` (re-exports + integration tests) |
| [`crates/host/src/`](../crates/host/src) | `main.rs` — the `emma-host` NDJSON server; `runtime.rs` — resolves the data root and starts the live runtime |
| [`desktop/main/`](../desktop/main) | Electron lifecycle, windows, IPC, and every runtime touching disk, a process, the network, the screen or a model |
| [`desktop/src/`](../desktop/src) | Sandboxed React 19 renderer. No Node, no Electron imports |
| [`desktop/src/styles/`](../desktop/src/styles) | Stylesheets; `tokens.css` holds the design tokens |
| [`desktop/shared/`](../desktop/shared) | Types and validation both processes agree on — permissions, settings, vault, artifacts, plans, workflows, context bar, traces and usage. Nothing here may import Electron |
| [`desktop/test/`](../desktop/test) | `node --test` suites and the fake ACP agent |
| [`desktop/native/`](../desktop/native) | macOS Objective-C/C helpers and Windows native equivalents: `quick_ask.m`/`quick_ask_win.cpp`, `computer.m`/`computer_win.cpp`, `transcribe.m`/`transcribe_win.cpp`, `pty.c`/`pty_win.c`, plus `Info.extra.plist` |
| [`desktop/scripts/`](../desktop/scripts) | Development, packaging and release checks, vendoring, catalog generation, and the CDP drivers `drive.mjs`, `shot.mjs`, `dismiss.mjs` |
| [`desktop/skills/`](../desktop/skills) | Six bundled skills: `artifact`, `building-emma`, `installing-capabilities`, `meta-harness`, `scheduled-tasks`, `threads` |
| `desktop/vendor/` | Gitignored. `npm run vendor:ripgrep` puts `rg` here; `npm run vendor:zvec-grep` puts `zvec-grep/` beside it |
| [`harness/`](../harness) | `emma-cli`. `src/acp/` (the ACP server), `src/builtins/` (registry; `builtins/emma/` holds Emma's tool *schemas*), `src/core/` (the engine), `src/gateway/` (model transport), `src/tools/`, `src/ui/` |

`harness/` is Emma's fork of [vercel-labs/fx](https://github.com/vercel-labs/fx),
Apache-2.0, © Vercel, Inc. and fx contributors. Read
[`FORK.md`](../harness/FORK.md) before touching it, and keep it honest —
that is a rule, and Apache-2.0 §4 keeps `LICENSE` and
[`THIRD_PARTY_NOTICES.md`](../harness/THIRD_PARTY_NOTICES.md) in place.

## Toolchains

| | Version | Pinned in |
| --- | --- | --- |
| macOS | 12 or later, Apple silicon | `desktop/native/Info.extra.plist` and `desktop/scripts/package-mac.mjs` |
| Windows | Windows 10 version 1809 or later, x64 supported distributable/public target | `desktop/scripts/package-windows.mjs` and the Windows CI runner |
| Node | 24+ | no `engines` field |
| Rust | 1.97.1 | [`rust-toolchain.toml`](../rust-toolchain.toml) |
| Zig | 0.16.0 | [`harness/build.zig.zon`](../harness/build.zig.zon) and CI |
| Electron | 43.4.0 | [`desktop/package.json`](../desktop/package.json) |
| TypeScript · React · Vite · Tailwind · ESLint | 6.0.3 · 19.2.8 · 8.2.2 · 4.3.3 · 10.0.1 | same |
| Xcode | `clang` for macOS native helpers, full Xcode for packaging | `actool` is required by Electron Packager |
| Windows SDK | LLVM `clang`/`clang++` and UI Automation import libraries | Windows native helpers and unsigned packaging rehearsal |

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
| `test` | `build:main`, then `node --test --test-timeout=60000 dist-main/test/*.test.js test/*.test.mjs`. Run it from `desktop/` — `harness.test.ts` resolves `fake-acp-agent.mjs` off `process.cwd()`, and `panes.test.ts` reads the real CSS |
| `typecheck` | `tsc -p tsconfig.renderer.json --noEmit`; main TypeScript is compiled as part of `test` |
| `lint` | `eslint . --max-warnings 0`. Browser globals for `src/`, Node globals for `main/`, `test/`, `scripts/` |
| `build:main` | `tsc -p tsconfig.main.json` → `dist-main/`. `rootDir: "."`, `module: Node16`, so it emits CommonJS and pulls `shared/` and the `.ts` half of `src/` in transitively |
| `build:renderer` | `vite build` → `dist-renderer/` |
| `build` | `build:main` then `build:renderer` |
| `build:host` | `cargo build --locked -p emma-host`, then `build:harness` |
| `build:harness` | `(cd ../harness && zig build)` → `harness/zig-out/bin/emma-cli` (`.exe` on Windows). **Nothing else builds the harness** |
| `build:native` | Builds the four platform-specific helpers and runs their self-tests where supported: macOS uses `clang` and the `.m`/`.c` sources; Windows uses the SDK toolchain and the `_win` sources |
| `vendor:ripgrep` | Downloads [ripgrep](https://github.com/BurntSushi/ripgrep) 15.2.0 and its license files into `desktop/vendor/`, checked against a pinned SHA-256, stamped in `vendor/rg.version`. A no-op once all files are present and stamped; warns when no pinned platform/architecture archive exists |
| `vendor:zvec-grep` | `npm install`s `@zvec/zvec-grep` 0.2.1 into `desktop/vendor/zvec-grep/`, prunes every foreign `onnxruntime-node` binary, and stamps `vendor/zvec-grep/zvec-grep.version`. Only zvec-grep mode uses it — see [harness.md](harness.md#zvec-grep-mode) |
| `seed:catalog` | Refetches OpenRouter's tool-capable model list into `main/catalog-seed.ts`. Needs no key |
| `dev` | `node scripts/dev.mjs` |
| `start` | `build:host` + `build:native` + `vendor:ripgrep` + `vendor:zvec-grep` + `build`, then `electron .`. No Vite server; the built bundle |
| `package:mac` | See [Packaging](#packaging) |
| `dmg:mac` | See [Packaging](#packaging) |
| `package:win` | See [Packaging](#packaging) |

## The dev loop

[`scripts/dev.mjs`](../desktop/scripts/dev.mjs) is strictly sequential; each step
must exit zero:

1. `build:host` — `cargo build -p emma-host`, then `zig build` for `emma-cli`.
2. `build:native` — the four platform-native helpers.
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
node desktop/scripts/drive.mjs 'return await window.emma.request("snapshot", {})'
```

Main-process `console.*` goes to the terminal that ran `npm run dev`; there is no
log file. `emma-cli`'s stderr is prefixed `emma-cli: `. `emma-host` needs no
configuration to run by hand — start it in a terminal and type JSON at it.

## Packaging

```sh
npm run package:mac
```

[`package-mac.mjs`](../desktop/scripts/package-mac.mjs) builds release Rust,
ReleaseSafe Zig targeting macOS 12, the four native helpers, ripgrep, and the
Electron code. It packages for Apple silicon with the installed Electron
Packager, then trims unused locales and verifies the result. Full Xcode is
required for `actool`; the selected Xcode is used, with `/Applications/Xcode.app`
as the fallback when only the CLT is selected.

Only `package.json`, `dist-main/main`, `dist-main/shared`, and `dist-renderer`
are allowed into `app.asar`. The copied package version is stamped from the
root `package.json` without changing the source manifest. Extra resources are
`emma-host`, `emma-cli`, `rg`, `emma-option-tap`, `emma-computer`,
`emma-transcribe`, `emma-pty`, `skills/`, and `notices/`. The notices include
the root MIT license, the fork's Apache-2.0 license and provenance, fonts,
brands, ripgrep, and generated renderer and Rust dependency license texts.

`native/Info.extra.plist` declares macOS 12 as the minimum and describes the
microphone and speech-recognition access. The package check verifies the
version, preload, renderer, executable architectures and deployment floors,
and runs the packaged native self-tests. The output is unsigned until the
release workflow signs it after trimming.

```sh
npm run dmg:mac
```

[`dmg-mac.mjs`](../desktop/scripts/dmg-mac.mjs) wraps a packaged app in the
disk image users download, beside an alias to `/Applications` so the install is
a drag. It takes the app and image paths as optional arguments, defaulting to
the packaged app and `Emma-vX.Y.Z-darwin-arm64.dmg` in `desktop/release/`. It
mounts what it built and verifies the version, bundle identifier, the alias,
and the bundled host, harness and ripgrep before reporting the path.

Run it after signing, notarizing and stapling, never before: the image captures
whatever state the app is in, and a stapled ticket inside it is what lets the
app launch offline. The release workflow then signs, notarizes and staples the
image itself. The zip stays the asset the updater feed reads, so it ships
whatever else is published beside it.

To avoid replacing a running bundle, pass a separate output directory:

```sh
npm --prefix desktop run package:mac -- /tmp/emma-release-check
```

On a native Windows x64 host, use the Squirrel packaging path:

```powershell
npm --prefix desktop run package:win
```

It builds the release Rust host, Zig harness, Windows native helpers, ripgrep,
and Electron code, then writes the current native-architecture app and Squirrel
assets under `desktop/release/squirrel`. Local packaging omits signing
credentials and produces the same installer the release publishes. The release
workflow attaches the Windows x64 installer and Squirrel feed to every GitHub
release; it is unsigned until the Windows signing secrets exist.

### Continuous integration

Pull requests run the full macOS desktop and Rust checks plus Zig tests in
parallel. Promotion PRs targeting `main` also run the unsigned macOS package
smoke; ordinary feature PRs targeting `dev` keep that packaging step out of the
critical path. The Windows lane runs only for pull requests and covers the
Windows-specific desktop tests, native helpers, Rust, and Zig.

Pushes to `main` rerun the exact promoted commit, package the unsigned release
candidate, and upload it for the release workflow. After successful CI, the
release workflow downloads and verifies that candidate before signing,
notarizing, stapling, Gatekeeper validation, and publication. The manual release
dispatch remains a direct packaging fallback.

Features start from and squash-merge into `dev`, preserving their PR release
summaries. Bump the root `package.json` version on `dev`, then promote the exact
candidate to `main` with a merge commit. The release job collects the changelog,
consumes the verified main candidate, and publishes both. See the
[release guide](releases.md) and the
[release skill](../.claude/skills/releasing/SKILL.md).

### Release verification still required

The five Apple secret names were configured when inspected on August 28, 2026;
the first signed and notarized GitHub build must still prove their validity.
Unsigned local bundles cannot prove Gatekeeper acceptance, Authenticode trust,
Squirrel installation, or update installation.
A local update rehearsal needs two signed bundles and a compatible feed; it does
not prove the public GitHub feed or Developer ID/notarization path. Verify an
upgrade between published signed versions before claiming that distribution path
works end to end. Also verify privacy prompts, shortcuts, VoiceOver, display geometry,
and the minimum supported macOS on real hardware. A Windows x64 host must still
verify Setup.exe installation, SmartScreen behavior, native helpers, and an
update between signed versions once a Windows release workflow is authorized.
Windows ARM64 has no CI lane and is not a supported target.

## Licensing

| Component | Terms |
| --- | --- |
| [`harness/`](../harness) | Apache-2.0. [`LICENSE`](../harness/LICENSE), [`FORK.md`](../harness/FORK.md), [`THIRD_PARTY_NOTICES.md`](../harness/THIRD_PARTY_NOTICES.md) — §4 requires keeping all three, and that survives the rename |
| `crates/` | `license = "Apache-2.0"` in [`Cargo.toml`](../Cargo.toml), `publish = false` |
| Departure Mono | SIL OFL 1.1, © 2022–2024 Helena Zhang. [`DepartureMono-LICENSE.txt`](../desktop/assets/DepartureMono-LICENSE.txt) |
| Brand assets | [`BRANDS-NOTICES.md`](../desktop/assets/BRANDS-NOTICES.md), [icon-sources.md](icon-sources.md). Trademarks stay with their owners |
| ripgrep | MIT/Unlicense, [BurntSushi](https://github.com/BurntSushi/ripgrep). Downloaded at build time, not vendored in git |

The root [`LICENSE`](../LICENSE) records the MIT terms already stated in the
README. Subtrees and bundled third-party assets retain the terms above.

## See also

- [architecture.md](architecture.md) — process boundaries and the trust model
- [concepts.md](concepts.md) — the vocabulary
- [harness.md](harness.md) — `emma-cli` and the ACP session
- [data.md](data.md) — every file and environment variable
- [design-system.md](design-system.md) — the renderer's visual contract
- [troubleshooting.md](troubleshooting.md) — when it breaks
