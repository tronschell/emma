# Getting started

How to get Emma building and running on a fresh Mac: what to install, what each
command does, what the first launch asks for, and how to package a build.

## What you need

Emma runs on macOS. `npm run package:mac` builds for Apple Silicon only — it
passes `--platform=darwin --arch=arm64` ([desktop/package.json](../desktop/package.json)).
The ripgrep it vendors has both `arm64` and `x64` builds.

| Tool | Version | Where it is pinned | What needs it |
| --- | --- | --- | --- |
| Xcode Command Line Tools | any current | — | `clang`, for the two Objective-C helpers |
| Rust | 1.97.1 | [rust-toolchain.toml](../rust-toolchain.toml) | `crates/core`, `crates/host` |
| Zig | 0.16.0 or newer | [harness/build.zig.zon](../harness/build.zig.zon) | `harness/` |
| Node | 24.x | [desktop/package.json](../desktop/package.json) (`@types/node` 24.10.1) | everything in `desktop/` |
| Electron | 43.4.0 | [desktop/package.json](../desktop/package.json) | installed by npm, not by you |
| `just` | optional | [justfile](../justfile) | shorthand for the npm and cargo commands |

- **Xcode Command Line Tools.** `xcode-select --install`. The `build:native`
  script compiles [quick_ask.m](../desktop/native/quick_ask.m) and
  [transcribe.m](../desktop/native/transcribe.m) with `clang -mmacosx-version-min=12.0`
  against AppKit, ApplicationServices, Foundation, and Speech. No Xcode app
  needed — just the command line tools.
- **Rust.** [rust-toolchain.toml](../rust-toolchain.toml) pins channel `1.97.1`
  with the `minimal` profile plus `clippy` and `rustfmt`. `rustup` reads that
  file and installs the right toolchain the first time you run `cargo` in the
  repo. The workspace is Rust edition 2024 with `rust-version = "1.97"`
  ([Cargo.toml](../Cargo.toml)).
- **Zig.** [harness/build.zig.zon](../harness/build.zig.zon) declares
  `minimum_zig_version = "0.16.0"`. `brew install zig`, or a tarball from
  ziglang.org.
- **Node.** There is no `engines` field. The typings are pinned at
  `@types/node` 24.10.1 and the repo is developed on Node 24.
- **Network access on the first build.** [vendor-ripgrep.mjs](../desktop/scripts/vendor-ripgrep.mjs)
  downloads ripgrep 14.1.1 from GitHub and checks it against a pinned SHA-256.
  It is a no-op once `desktop/vendor/rg` exists and its stamp matches.

## Clone, install, run

Every JavaScript dependency lives under `desktop/`. The root
[package.json](../package.json) has no dependencies at all — its three scripts
just forward to `desktop`.

```bash
git clone <your-remote> emma
cd emma
npm --prefix desktop install
npm run dev
```

The first `npm run dev` builds the Rust host, the Zig harness, the native
helpers, and the TypeScript main process before Electron opens. Expect a few
minutes. Later runs reuse the caches.

### `npm run dev` vs `npm --prefix desktop start`

Both open an Electron window. The difference is where the renderer comes from
and what gets built on the way there.

`npm run dev` → `npm --prefix desktop run dev` → [dev.mjs](../desktop/scripts/dev.mjs),
which runs four steps and stops at the first one that fails:

1. `npm run build:host` — `cargo build --locked -p emma-host`, then
   `npm run build:harness` (`cd ../harness && zig build`).
2. `npm run build:native` — `clang` both `.m` files into `desktop/dist-native/`,
   then runs `emma-option-tap --self-test`.
3. `npm run build:main` — `tsc -p tsconfig.main.json` into `desktop/dist-main/`.
4. `npm exec vite -- --host 127.0.0.1`, then 800 ms later
   `npm exec electron .` with `EMMA_DEV_SERVER_URL=http://127.0.0.1:5173`.

Quitting Electron sends `SIGTERM` to Vite, so one Ctrl-C cleans up both.

`npm --prefix desktop start` runs
`build:host && build:native && vendor:ripgrep && build && electron .`, where
`build` is `build:main && build:renderer`. The renderer is compiled to
`desktop/dist-renderer/` and loaded over `file://`.

| | `npm run dev` | `npm --prefix desktop start` |
| --- | --- | --- |
| Renderer | Vite dev server, hot reload | static `dist-renderer/index.html` over `file://` |
| Runs `vendor:ripgrep` | no | yes |
| Runs `build:renderer` | no | yes |
| `EMMA_DEV_SERVER_URL` | set to `http://127.0.0.1:5173` | unset |
| Closest to shipping | no | yes |

That ripgrep row matters. [main.ts](../desktop/main/main.ts#L284) looks for the
bundled `desktop/vendor/rg` and, when it is not there, falls through to whatever
`rg` is on your `PATH` — and [search.ts](../desktop/main/search.ts) falls through
again to `grep`. A tree that has only ever run `npm run dev` never vendors it.
Run `npm --prefix desktop run vendor:ripgrep` once if you want the pinned binary.

The `just` recipes are the same commands: `just dev`, `just check`, `just test`,
`just package` ([justfile](../justfile)).

## What happens on first launch

Before the app is ready, [main.ts](../desktop/main/main.ts#L2440) registers the
`emma-artifact` URL scheme and takes the single-instance lock. A second launch
does not open a second Emma — it quits and focuses the window already open
([main.ts:2442](../desktop/main/main.ts#L2442)).

On `app.whenReady()`, in order:

- The session permission handlers go up. The only thing a page can ask the OS
  for is the microphone, and only from one of Emma's own windows
  ([main.ts:2450](../desktop/main/main.ts#L2450)). Camera, geolocation,
  notifications — all refused outright.
- `CredentialStore`, `FolderStore`, `AttachmentStore`, and `CatalogCache` open
  under `app.getPath("userData")`.
- `startHost()` decrypts the saved credentials into this process's environment
  and spawns `emma-host` with `EMMA_KNOWLEDGE_DIR` set to the saved knowledge
  folder ([main.ts:838](../desktop/main/main.ts#L838)). The host reads no
  provider settings and spawns nothing of its own.
- Bundled skills in [desktop/skills](../desktop/skills) are seeded into
  `userData` and into the harness profile at `userData/harness`.
- Interrupted autoresearch jobs resume ([research.ts](../desktop/main/research.ts)).
- The workspace window opens: 1380×860, minimum 1040×680, hidden-inset title bar,
  sidebar vibrancy on macOS.
- `readNotchGeometry()` and `startQuickAskHotkey()` each spawn
  `emma-option-tap` — one with `--screens` to read the camera housing bounds,
  one as a long-lived global key listener.

### Where things land on disk

Two roots, and they are not the same one.

| What | Where | Set by |
| --- | --- | --- |
| Threads, knowledge, scheduled jobs, research | `~/Library/Application Support/Emma` | `EMMA_DATA_DIR`, else the default in [runtime.rs:26](../crates/host/src/runtime.rs#L26) |
| Readable Markdown mirror | `~/Documents/Emma Knowledge` | the walkthrough, or `EMMA_KNOWLEDGE_DIR` ([setup.ts:10](../desktop/main/setup.ts#L10)) |
| Credentials, folder grants, artifacts, plans, harness profile, renderer storage | `~/Library/Application Support/emma-desktop` | Electron's `userData` |

The Electron folder is named after `desktop/package.json`'s `name` field, so it
is `emma-desktop` for both the dev run and the packaged app. The Rust host's
root is decided separately in Rust and is `Emma` either way.

### The walkthrough

The renderer shows a five-step modal the first time it runs, gated on the
`emma.setupSeen.v1` key in `localStorage`
([App.tsx:341](../desktop/src/App.tsx#L341)). The steps are **Emma**,
**Permissions**, **Quick Ask**, **Knowledge**, and **Agents**. You can skip any
of them; Emma asks again when it needs to.

Step 2 lists every grant Emma can ever want — all seven rows of
`SETUP_PERMISSIONS` ([shared/setup.ts](../desktop/shared/setup.ts)) — with the
live state of each one beside it: `[ok]` granted, `[  ]` not granted, `[--]`
macOS will not say. The long reason for each sits behind its `(i)`; the visible
line is one sentence. Nothing here can grant anything except the microphone,
which `askForMediaAccess` really does prompt for; every other row opens the pane
it is granted in and re-checks when Emma comes back to the front.

Step 3 teaches Quick Ask: a drawing of the island wrapping the camera housing,
the five things you need to know to drive it, and a **Show me** button that
opens the real island from the workspace (`emma:demo-quick-ask`). That button
works before Accessibility is granted, which the double-tap gesture does not.

Step 4 offers to pick a knowledge folder or use the Documents default. Creating
that folder is what makes macOS raise the Files & Folders prompt
([setup.ts:29](../desktop/main/setup.ts#L29)). Emma checks the grant by writing
a probe file and deleting it, because TCC has no API to ask
([setup.ts:48](../desktop/main/setup.ts#L48)).

Step 5 scans for skills and MCP servers you already set up for Codex, Claude,
Antigravity, Pi, OpenCode, Cursor, Windsurf, and Devin. It records paths only.

## macOS permissions

Emma can raise the prompt for exactly one of these, the microphone; the rest
only you can grant, in System Settings. The walkthrough opens the exact pane for
each one and re-checks the moment Emma comes back to the front. The panes live
in one table, [shared/setup.ts](../desktop/shared/setup.ts), so the reason you
read and the pane that opens can never drift apart — and that table is what the
walkthrough renders, so a grant Emma needs cannot be missing from it.

### Accessibility

**System Settings → Privacy & Security → Accessibility.**

Two things need it, and both live in
[quick_ask.m](../desktop/native/quick_ask.m):

- The Quick Ask gesture. `NSEvent addGlobalMonitorForEventsMatchingMask` only
  reports key presses in other apps to a trusted process. Without the grant the
  double-tap does nothing at all.
- Computer use. The same helper posts `CGEvent` mouse and keyboard events when
  the agent drives the pointer.

The helper calls `AXIsProcessTrustedWithOptions` with the prompt option at
startup, so you get the system dialog on the first run and a line on stderr when
it is refused. **Emma has to be relaunched after you grant this** — the running
helper does not pick up a new grant.

### Screen Recording

**System Settings → Privacy & Security → Screen Recording.**

Needed for every screen capture: the ▣ orb in the notch, the ✎ annotation sheet,
and the `computer` tool's `screenshot` action.
[computer.ts:100](../desktop/main/computer.ts#L100) reads
`systemPreferences.getMediaAccessStatus("screen")` and refuses with a named
error before it tries. Nothing is captured until you ask for it, and each frame
is compressed locally and travels only with the turn you send it with.

### Files & Folders

**System Settings → Privacy & Security → Files and Folders.**

Only for the Markdown mirror. Emma keeps its own copy of knowledge regardless;
this grant is what lets the readable copy land in `~/Documents/Emma Knowledge`
where Finder, Spotlight, Obsidian, and your backups can see it.

### Microphone and Speech Recognition

**System Settings → Privacy & Security → Microphone** and **→ Speech
Recognition.**

Both are walkthrough rows, and Settings → Voice is the second door onto the same
panes. Microphone is the one grant Emma can raise itself: the walkthrough calls
`systemPreferences.askForMediaAccess("microphone")` and only falls through to
the pane when macOS answers no. Speech Recognition is only ever asked for by the
`macOS · built in` engine, which runs through the `emma-transcribe` helper
([voice.ts](../desktop/main/voice.ts)), so its walkthrough row reads `[--]` —
there is no API to query it from the app process.

The built-in recognizer needs the packaged app. TCC reads the *responsible*
process's `Info.plist` for `NSSpeechRecognitionUsageDescription`, which for the
spawned helper is whatever launched Emma. `Emma.app` carries it via
`--extend-info` ([Info.extra.plist](../desktop/native/Info.extra.plist)); the
development Electron binary does not, so the helper is killed on sight under
`npm run dev` ([voice.ts:63](../desktop/main/voice.ts#L63)).

### Automation

**System Settings → Privacy & Security → Automation → Emma.**

Asked for the first time Emma reads the front browser tab, which is how "save
this page" works without a screenshot. The walkthrough has a row for it, but no
status to put beside it — macOS reports Apple Events grants to nobody, so the
row reads `[--]` and the only other sign is the error from
[clip.ts:39](../desktop/main/clip.ts#L39).

### Notifications

**System Settings → Notifications → Emma.**

One banner when a run lands or stops on a permission ask
([main.ts:497](../desktop/main/main.ts#L497)). The walkthrough row opens the
Notifications pane rather than Privacy & Security — it is the one grant whose
URL is not a `com.apple.preference.security` anchor, which is why the pane
column in [shared/setup.ts](../desktop/shared/setup.ts) holds a whole
`x-apple.systempreferences:` path and not just an anchor name. An unsigned build
is never prompted at all, so Emma falls back to bouncing its Dock icon.

## Your first turn

**Add a model.** Settings → Models. Emma ships one remote route, OpenRouter, and
stores the key under `OPENROUTER_API_KEY`
([settings.ts:724](../desktop/shared/settings.ts#L724)). The key is encrypted
with `safeStorage` — this Mac's keychain — and never returned to the renderer,
only its mask ([credentials.ts](../desktop/main/credentials.ts)). It reaches
`emma-cli` through its spawn environment, so **a key you just pasted only takes
effect on a harness spawned after it** — saving one closes every idle harness so
the next turn picks it up, while a harness mid-turn keeps the old environment.

There is also a free router, which is not a single model but a chain of free
tool-capable OpenRouter models sent as one comma-separated list. OpenRouter
falls through the list on its own side when one is rate-limited or down
([settings.ts:958](../desktop/shared/settings.ts#L958)).

**Open the workspace.** It is the window that opened at launch. Closing it does
not quit Emma on macOS; the Dock icon and `app.on("activate")` bring it back.

**Try Quick Ask.** Double-tap the **left** Option key — key code 58, with under
0.35 s between the release and the second press
([quick_ask.m:28](../desktop/native/quick_ask.m#L28)). The island unfolds from
the camera housing over whatever app you are in, without bringing Emma forward.
Escape closes it when idle and parks it as a chip when a turn is running. The
right Option key does nothing; that is deliberate.

**Pick a permission mode.** The composer's picker, four modes, default `ask`
([permissions.ts](../desktop/shared/permissions.ts)):

| Mode | What it means |
| --- | --- |
| Plan `◇` | Reads and subagents only. Nothing on this Mac changes. |
| Ask `◈` | Every write, command, and click asks first. |
| Accept edits `◆` | File writes and grep go through; other commands and the pointer still ask. |
| Auto `⬗` | A separate verifier model reads each gated call; anything it will not clear still asks you. |
| Full access `⬥` | Nothing asks. Escape still stops a run. |

**Attach a folder.** The ＋ menu opens a directory picker. A thread holds
**one** folder, and attaching a second replaces the first — that folder is the
working directory `emma-cli` is spawned in, and the harness reads its workspace
root from that cwd once at startup
([main.ts:183](../desktop/main/main.ts#L183)). A thread with no folder runs in a
scratch directory under `userData/workspaces/<threadId>`, which is better than
an agent loose in your home directory.

Then type. Emma streams the answer into the thread and records it as Markdown
under the host's data root.

## Build and check commands

The full list from [AGENTS.md](../AGENTS.md), which is the source of truth:

```bash
npm --prefix desktop run check
cargo fmt --all -- --check
cargo check --workspace --locked --all-targets
cargo test --workspace --locked
cargo clippy --workspace --locked --all-targets -- -D warnings
(cd harness && zig build test)
```

What each one covers:

| Command | Covers |
| --- | --- |
| `npm --prefix desktop run check` | `test` + `typecheck` + `lint` + `build:renderer` |
| `cargo fmt --all -- --check` | Rust formatting, both crates |
| `cargo check --workspace --locked --all-targets` | Rust compiles, including tests and benches |
| `cargo test --workspace --locked` | `emma-core` and `emma-host` tests |
| `cargo clippy … -- -D warnings` | Rust lints, warnings are failures |
| `(cd harness && zig build test)` | the `emma-cli` fork's tests, and the only Zig suite there is |

`npm --prefix desktop run check` breaks down into
([desktop/package.json](../desktop/package.json)):

- `test` → `tsc -p tsconfig.main.json`, then `node --test dist-main/test/*.test.js`.
  Thirty-odd suites over `desktop/main` and `desktop/shared`, in
  [desktop/test](../desktop/test).
- `typecheck` → `tsc --noEmit` against both `tsconfig.main.json` (main + test)
  and `tsconfig.renderer.json` (the React tree).
- `lint` → `eslint . --max-warnings 0`.
- `build:renderer` → `vite build`, so a renderer that type-checks but will not
  bundle still fails.

Individual build targets, when you only changed one layer:

```bash
npm --prefix desktop run build:host      # cargo host, then the zig harness
npm --prefix desktop run build:harness   # just emma-cli
npm --prefix desktop run build:native    # the two ObjC helpers, plus a self-test
npm --prefix desktop run build:main      # tsc for the main process
npm --prefix desktop run build:renderer  # vite build
npm --prefix desktop run vendor:ripgrep  # download and verify ripgrep 14.1.1
```

`just check` runs the desktop check plus `cargo check`; `just test` runs
`cargo test`. Neither covers the whole `AGENTS.md` list.

One rule from `AGENTS.md` worth repeating: visible or platform work is not done
until the real app has been launched and the changed interaction exercised.

## Packaging

```bash
npm run package:mac
```

That runs, in order
([desktop/package.json](../desktop/package.json)):

1. `cargo build --locked --release -p emma-host`
2. `(cd ../harness && zig build -Doptimize=ReleaseSafe)`
3. `npm run build:native`
4. `npm run vendor:ripgrep`
5. `npm run build`
6. `electron-packager . Emma --platform=darwin --arch=arm64 --out=release --overwrite --asar …`

The result is `desktop/release/Emma-darwin-arm64/Emma.app`.
`Contents/Resources` holds `app.asar` plus the six things copied by
`--extra-resource`: `emma-host`, `emma-cli`, `rg`, `emma-option-tap`,
`emma-transcribe`, and the `skills` directory.
`--extend-info=native/Info.extra.plist` merges
`NSSpeechRecognitionUsageDescription` into the bundle's `Info.plist`.

### Known release blockers

You can check every one of these on a build you just made.

- **The bundle identifier is provisional.** `--app-bundle-id=dev.local.emma`.
  TCC keys its grants on the identity, so this is the id every Accessibility and
  Screen Recording grant is attached to. Shipping under a real id means every
  tester re-grants.
- **There is no signing identity.** No `--osx-sign` and no `--osx-notarize`, so
  the bundle is ad-hoc signed. `codesign -dv` on the output reports
  `Signature=adhoc`, `TeamIdentifier=not set`, and `Identifier=Electron`. A copy
  handed to anyone else is quarantined by Gatekeeper.
- **Notifications are dropped.** An unsigned build is never prompted for
  notification permission, so banners silently fail. Emma catches this and falls
  back to a critical Dock bounce ([main.ts:517](../desktop/main/main.ts#L517)),
  which needs no authorization.
- **The icon is Electron's.** No `--icon` is passed, so the bundle ships
  `electron.icns`.

## See also

- [architecture.md](architecture.md) — how the Electron, Rust, and Zig layers fit together
- [development.md](development.md) — day-to-day workflow, conventions, and tests
- [troubleshooting.md](troubleshooting.md) — when one of the above does not work
- [concepts.md](concepts.md) — threads, runs, knowledge, and the vocabulary
- [permissions.md](permissions.md) — the four modes and the tool gate table
- [models.md](models.md) — providers, the catalog, and the free router
- [harness.md](harness.md) — `emma-cli`, the fx fork
- [cli.md](cli.md) — the `cli` tools and Settings → Connections
- [privacy.md](privacy.md) — what leaves this Mac, and when
- [notch.md](notch.md) — Quick Ask, the island, and the cursor ring
- [voice.md](voice.md) — dictation and the local cleanup model
- [computer-use.md](computer-use.md) — pointer and keyboard control
- [knowledge.md](knowledge.md) — the knowledge base and its Markdown mirror
- [data.md](data.md) — every file Emma writes and where
- [tools.md](tools.md) — the tool catalog
- [jobs.md](jobs.md) — scheduled work
- [autoresearch.md](autoresearch.md) — the long-running research loop
- [plugins.md](plugins.md) — UI plugins
- [design-system.md](design-system.md) — the visual language
- [icon-sources.md](icon-sources.md) — where the brand marks come from
