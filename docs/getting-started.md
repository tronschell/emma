# Getting started

Clone to first turn. Emma is macOS-first and `package:mac` builds Apple Silicon
only (`--platform=darwin --arch=arm64`).

## Prerequisites

| Tool | Version | Pinned in | Needed by |
| --- | --- | --- | --- |
| Xcode Command Line Tools | any current | — | `clang`, for the three native helpers |
| Rust | 1.97.1 | [rust-toolchain.toml](../rust-toolchain.toml) | `crates/core`, `crates/host` |
| Zig | 0.16.0+ | [harness/build.zig.zon](../harness/build.zig.zon) `minimum_zig_version` | `harness/` |
| Node | 24.x | [desktop/package.json](../desktop/package.json) (`@types/node` 24.10.1) | everything in `desktop/` |
| Electron | 43.4.0 | installed by npm | — |

```bash
xcode-select --install
brew install zig
```

`rustup` reads `rust-toolchain.toml` and installs 1.97.1 the first time you run
`cargo` here. The first build also downloads
[ripgrep](https://github.com/BurntSushi/ripgrep) 14.1.1 from GitHub and checks it
against a pinned SHA-256 ([vendor-ripgrep.mjs](../desktop/scripts/vendor-ripgrep.mjs)),
so it needs network once.

## Install and run

```bash
git clone <your-remote> emma
cd emma
npm --prefix desktop install
npm run dev
```

Every JavaScript dependency lives under `desktop/`; the root `package.json`
forwards to it. The first run builds Rust, Zig, the native helpers and the main
process — a few minutes. Later runs reuse the caches.

### `npm run dev` vs `npm --prefix desktop start`

`npm run dev` runs [dev.mjs](../desktop/scripts/dev.mjs), which stops at the
first failing step: `build:host` (cargo `emma-host`, then `zig build`) →
`build:native` (clang) → `build:main` (tsc) → Vite, then Electron 800 ms later.
Quitting Electron `SIGTERM`s Vite, so one Ctrl-C cleans up both.

| | `npm run dev` | `npm --prefix desktop start` |
| --- | --- | --- |
| Renderer | Vite dev server on `127.0.0.1:5173`, hot reload | `dist-renderer/index.html` over `file://` |
| `vendor:ripgrep` | no | yes |
| `build:renderer` | no | yes |
| `EMMA_DEV_SERVER_URL` | `http://127.0.0.1:5173` | unset |
| Closest to shipping | no | yes |

A tree that has only ever run `npm run dev` never vendors `desktop/vendor/rg`.
`rg` is on the harness's allowed-command list
([command_policy.zig](../harness/src/core/tooling/command_policy.zig)) and is
resolved from the inherited `PATH`, so without either the vendored copy or a
`PATH` ripgrep the agent's searches fall back to whatever else it can run. Run
`npm --prefix desktop run vendor:ripgrep` once to fetch the pinned binary.

`just dev`, `just check`, `just test`, `just package` are the same commands
([justfile](../justfile)).

## First launch

Emma takes a single-instance lock, so a second launch focuses the first window
instead of opening one. A packaged `Emma.app` and a dev run share that lock —
see [troubleshooting.md](troubleshooting.md).

A five-step walkthrough opens once (**Emma · Quick Ask · Permissions ·
Knowledge · Agents**), gated on `emma.setupSeen.v1` in `localStorage`. Skip any
step; Emma asks again when it needs to.

Step 4 picks your **vault** — an Obsidian vault or any plain folder. Emma writes
one Markdown note per save into `<vault>/knowledge-base`; there is no second
copy. See [data.md](data.md) for the layout.

## macOS permissions

One table drives both the walkthrough and the pane each button opens:
[shared/setup.ts](../desktop/shared/setup.ts). Microphone is the only grant Emma
can raise itself (`askForMediaAccess`); every other row opens System Settings and
re-checks when Emma comes back to the front.

| Grant | Why, exactly | Status Emma can read |
| --- | --- | --- |
| Accessibility | `NSEvent addGlobalMonitorForEventsMatchingMask` only reports other apps' key presses to a trusted process — that is the left-Option double-tap. The same grant lets [quick_ask.m](../desktop/native/quick_ask.m) post `CGEvent` mouse and key events for computer use. **Relaunch Emma after granting.** | `isTrustedAccessibilityClient` |
| Screen Recording | Every capture: the ▣ orb, the ✎ annotation sheet, and the `computer` tool's `screenshot`. [computer.ts:99](../desktop/main/computer.ts#L99) checks it and refuses by name before capturing. **Relaunch after granting.** | `getMediaAccessStatus("screen")` |
| Microphone | Dictation into the composer. | `getMediaAccessStatus("microphone")` |
| Speech Recognition | Only the `macOS · built in` dictation engine, through the `emma-transcribe` helper. A local Whisper server needs neither. | none — row reads `[--]` |
| Files & Folders | Writing notes into the vault folder you chose. Checked by writing `.emma-write-check` and deleting it ([vault.ts:106](../desktop/main/vault.ts#L106)), because TCC has no query API. | write probe |
| Automation | Reading the front browser tab, which is how "save this page" works without a screenshot ([clip.ts](../desktop/main/clip.ts)). | none — macOS reports Apple Events grants to nobody |
| Notifications | One banner when a run lands or stops on a permission ask. Unsigned builds are never prompted, so Emma bounces the Dock icon instead. | `Notification.isSupported()` |

## Point it at a model

Settings → Models → paste an OpenRouter key (stored as `OPENROUTER_API_KEY`,
encrypted with Electron `safeStorage`), then pick a model — or pick **free
router**, which sends ten free tool-capable OpenRouter ids as one
comma-separated list and lets OpenRouter fall through them
([settings.ts](../desktop/shared/settings.ts) `FREE_ROUTER_MODELS`).

A key only reaches `emma-cli` through its spawn environment, so it takes effect
on the next harness spawn; saving one closes every idle harness.

## Your first turn

- **Attach a folder.** The ＋ menu. A thread holds **one** folder and it becomes
  the working directory `emma-cli` is spawned in. With no folder, the thread runs
  in `userData/workspaces/<threadId>`.
- **Pick a permission mode** in the composer. Four modes, default `ask` —
  [permissions.md](permissions.md).
- **Try Quick Ask.** Double-tap the **left** Option key (key code 58, under
  0.35 s apart, [quick_ask.m:28](../desktop/native/quick_ask.m#L28)). The island
  unfolds over whatever app is in front. The right Option key does nothing.

Then type.

## Checks

From [AGENTS.md](../AGENTS.md), the source of truth:

```bash
npm --prefix desktop run check
cargo fmt --all -- --check
cargo check --workspace --locked --all-targets
cargo test --workspace --locked
cargo clippy --workspace --locked --all-targets -- -D warnings
(cd harness && zig build test)
```

`npm --prefix desktop run check` is `test` + `typecheck` + `lint` +
`build:renderer`. Per-layer builds and packaging live in
[development.md](development.md).

Visible or platform work is not done until the real app has been launched and
the changed interaction exercised.

## Credits

`harness/` is Emma's fork of [vercel-labs/fx](https://github.com/vercel-labs/fx)
(Apache-2.0, © Vercel, Inc. and fx contributors), forked at `580a0c5` /
upstream v0.0.4 — see [harness/FORK.md](../harness/FORK.md) and
[harness/THIRD_PARTY_NOTICES.md](../harness/THIRD_PARTY_NOTICES.md). Emma also
vendors [ripgrep](https://github.com/BurntSushi/ripgrep) and builds on
[Electron](https://github.com/electron/electron),
[React](https://github.com/facebook/react),
[Vite](https://github.com/vitejs/vite),
[Tailwind](https://github.com/tailwindlabs/tailwindcss),
[xterm.js](https://github.com/xtermjs/xterm.js),
[mermaid](https://github.com/mermaid-js/mermaid) and
[Recharts](https://github.com/recharts/recharts). The interface font is
Departure Mono (SIL OFL). Vendor brand marks:
[icon-sources.md](icon-sources.md) and
[desktop/assets/BRANDS-NOTICES.md](../desktop/assets/BRANDS-NOTICES.md).

## See also

- [architecture.md](architecture.md) — how Electron, Rust and Zig fit together
- [development.md](development.md) — workflow, tests, packaging
- [troubleshooting.md](troubleshooting.md) — when a step above fails
- [data.md](data.md) — every file Emma writes, every env var
- [concepts.md](concepts.md) — threads, runs, the vocabulary
- [permissions.md](permissions.md) — the four modes and the gate table
- [computer-use.md](computer-use.md) — pointer and keyboard control
- [models.md](models.md) — providers, the catalog, routers
- [harness.md](harness.md) — `emma-cli`, the fx fork
- [notch.md](notch.md) — Quick Ask and the island
- [voice.md](voice.md) — dictation
