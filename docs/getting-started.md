# Getting started

Emma targets macOS 12 or later on Apple silicon and Windows 10 version 1809 or
later on x64. Published downloads contain the macOS disk image and zip and the
Windows x64 installer, which is unsigned until the Windows signing secrets
exist. No build toolchains are needed for a published build. The rest of this page covers building from
source; see [releases.md](releases.md) for how a prepared version reaches the
download page.

## Prerequisites

| Tool | Version | Pinned in | Needed by |
| --- | --- | --- | --- |
| Xcode Command Line Tools | any current | — | macOS native helpers; full Xcode is required for macOS packaging |
| LLVM `clang`/`clang++` and Windows SDK | current | — | Windows native helpers and x64 packaging |
| Rust | 1.97.1 | [rust-toolchain.toml](../rust-toolchain.toml) | `crates/core`, `crates/host` |
| Zig | 0.16.0 | [harness/build.zig.zon](../harness/build.zig.zon) and CI | `harness/` |
| Node | 24.x | [desktop/package.json](../desktop/package.json) (`@types/node` 24.10.1) | everything in `desktop/` |
| Electron | 43.4.0 | installed by npm | — |

On macOS, install the command-line tools and Zig:

```bash
xcode-select --install
brew install zig
```

On Windows, install Node 24, the Rust toolchain selected by
`rust-toolchain.toml`, Zig 0.16.0, LLVM `clang`/`clang++`, and the Windows SDK
with its import libraries.
The `windows-2025` (x64) CI runner runs `package:win` on promotion pull
requests. x64 is the supported distributable/public target and every release
publishes its installer and Squirrel update feed.

`rustup` reads `rust-toolchain.toml` and installs 1.97.1 the first time you run
`cargo` here. The first `start`, `package:mac`, `package:win`, or
`vendor:ripgrep` run downloads
[ripgrep](https://github.com/BurntSushi/ripgrep) 15.2.0 from GitHub and checks it
against a pinned SHA-256 ([vendor-ripgrep.mjs](../desktop/scripts/vendor-ripgrep.mjs)),
so it needs network once.

## Install and run

```bash
git clone https://github.com/tronschell/emma.git
cd emma
npm --prefix desktop install
npm run dev
```

Every JavaScript dependency lives under `desktop/`; the root `package.json`
forwards to it. The first run builds Rust, Zig, the platform-native helpers and
the main process — a few minutes. Later runs reuse the caches.

### `npm run dev` vs `npm --prefix desktop start`

`npm run dev` runs [dev.mjs](../desktop/scripts/dev.mjs), which stops at the
first failing step: `build:host` (cargo `emma-host`, then `zig build`) →
`build:native` (the platform native toolchain) → `build:main` (tsc) → Vite, then
Electron 800 ms later.
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
instead of opening one. A packaged app and a dev run share Electron's `userData`
lock — see [troubleshooting.md](troubleshooting.md).

A three-step walkthrough opens once (**Connect · Permissions · Quick Ask**),
gated on `emma.setupSeen.v1` in `localStorage`. Connect requires a verified
OpenRouter API key; a free key is enough. Subscription connections are optional
and do not replace OpenRouter.

Permissions shows each grant’s purpose, current status, and system settings
action. All permissions are optional. The last step demonstrates the Quick Ask
shortcut and opens the real Quick Ask interface; Finish setup opens the workspace.
The current step is saved so setup can resume after a relaunch.

Choose your **vault** later in Settings — an Obsidian vault or any plain folder.
Emma writes one Markdown note per save into `<vault>/knowledge-base`; there is
no second copy. See [data.md](data.md) for the layout.

## Platform permissions

One table drives both the walkthrough and the pane each button opens:
[shared/setup.ts](../desktop/shared/setup.ts). On macOS, microphone is the only
grant Emma can raise itself (`askForMediaAccess`); other rows open System Settings
and re-check when Emma comes back to the front. Windows rows open Windows Settings
where the operating system exposes a setting.

| Grant | Why, exactly | Status Emma can read |
| --- | --- | --- |
| Accessibility | `NSEvent addGlobalMonitorForEventsMatchingMask` only reports other apps' key presses to a trusted process — that is the left-Option double-tap. The same grant lets [computer.m](../desktop/native/computer.m) read and operate approved apps' accessibility controls; each app still needs separate approval. **Relaunch Emma after granting.** | `isTrustedAccessibilityClient` |
| Screen Recording | The separate ▣ screen-context orb and ✎ annotation sheet capture the display; the app-scoped `computer` tool does not take screenshots. [captureDisplay](../desktop/main/computer.ts) checks this grant before capturing. **Relaunch after granting.** | `getMediaAccessStatus("screen")` |
| Microphone | Dictation into the composer. | `getMediaAccessStatus("microphone")` |
| Speech Recognition | The built-in dictation engine: macOS Speech.framework or Windows SAPI, through the platform `emma-transcribe` helper. A local speech server needs neither. | macOS has no direct status query; Windows has no per-app grant and reports the built-in capability |
| Files & Folders | Writing notes into the vault folder you chose. Checked by writing `.emma-write-check` and deleting it ([vault.ts:106](../desktop/main/vault.ts#L106)), because TCC has no query API. | write probe |
| Automation | On macOS, reading the front browser tab uses Apple Events; on Windows, UI Automation reads supported browser windows. This is how "save this page" works without a screenshot ([clip.ts](../desktop/main/clip.ts)). | none — macOS reports Apple Events grants to nobody |
| Notifications | One banner when a run lands or stops on a permission ask. Unsigned macOS builds are never prompted, so Emma bounces the Dock icon instead. | `Notification.isSupported()` |

Windows does not use the macOS TCC permission prompts. Accessibility and
Automation are not required there; the setup dialog marks them **Not required**
and excludes them from its meter. Speech Recognition is a built-in SAPI capability,
not a per-app grant. A real Windows x64 host still needs checks for
SmartScreen, native helper access, display geometry, and Squirrel installation
and updates once signed publication is authorized.

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
- **Try Quick Ask.** On macOS, double-tap the **left** Option key (key code 58,
  under 0.35 s apart, [quick_ask.m:28](../desktop/native/quick_ask.m#L28)); on
  Windows, double-tap the **left** Alt key. The right Option or Alt key does
  nothing. Windows uses Ctrl where macOS uses Command in shortcut labels.

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

To build the current native Windows x64 package from a Windows shell:

```powershell
npm --prefix desktop run package:win
```

Local packaging omits signing credentials and produces an unsigned structure
check for the current host architecture; it does not establish Authenticode
trust. The release workflow publishes the Windows x64 installer and signs it
only when the Windows signing secrets exist. Windows ARM64 has no CI lane and
is not a supported target.

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
[mermaid](https://github.com/mermaid-js/mermaid). The interface font is
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
- [computer-use.md](computer-use.md) — approved app-scoped accessibility controls
- [models.md](models.md) — providers, the catalog, routers
- [harness.md](harness.md) — `emma-cli`, the fx fork
- [notch.md](notch.md) — Quick Ask and the island
- [voice.md](voice.md) — dictation
