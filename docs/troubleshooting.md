# Troubleshooting

Real failures Emma produces, what causes each one, and the command that fixes
it. Every error string here is quoted from the source file it is thrown in.

## Launching

### `npm run dev` finishes with no window and no error

**Cause.** Emma takes a single-instance lock at startup. If another Emma already
holds it, this one calls `app.quit()` immediately — no window, no message, exit
code 0 ([main.ts:2442](../desktop/main/main.ts#L2442)):

```ts
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else app.on("second-instance", () => { void app.whenReady().then(openMain); });
```

The lock is per user data directory, and here is the trap: the packaged
`Emma.app` and a dev run use the **same** one. Electron names it after
`desktop/package.json`'s `name` field, which lives inside `app.asar` too, so
both resolve to `~/Library/Application Support/emma-desktop`. Check a running
Emma's helper process and you will see `--user-data-dir` pointing there. If you
keep a packaged build running, every `npm run dev` dies silently.

**Fix.** Quit the running Emma, or give the dev run a profile of its own:

```bash
pkill -f 'Emma.app/Contents/MacOS/Emma'   # or just quit it from the Dock
npm run dev
```

To run both at once, launch Electron directly with a separate profile:

```bash
npm --prefix desktop run build:host
npm --prefix desktop run build:native
npm --prefix desktop run build:main
npm --prefix desktop run build:renderer
cd desktop && ./node_modules/.bin/electron . --user-data-dir=/tmp/emma-dev-profile
```

A fresh `--user-data-dir` starts at the four-step onboarding modal with no folder
grants and no saved keys.

### The dev run is writing to your real threads and knowledge

**Cause.** `--user-data-dir` only moves Electron's half. Threads, knowledge,
scheduled jobs, and research live under the Rust host's own root, which defaults
to `~/Library/Application Support/Emma` and is decided in Rust, not Electron
([runtime.rs:26](../crates/host/src/runtime.rs#L26)). Clicking around in a
throwaway profile still creates real threads.

**Fix.** Set both.

```bash
cd desktop
EMMA_DATA_DIR=/tmp/emma-dev-data \
  ./node_modules/.bin/electron . --user-data-dir=/tmp/emma-dev-profile
```

### Blank window, or IPC calls rejected in dev

**Cause.** [dev.mjs:16](../desktop/scripts/dev.mjs#L16) hard-codes
`EMMA_DEV_SERVER_URL=http://127.0.0.1:5173`. If port 5173 is already taken, Vite
picks the next free port, Electron loads the wrong origin, and
`trustedSender` refuses every IPC call because the origin does not match
([ipc.ts:269](../desktop/main/ipc.ts#L269)).

**Fix.** Free the port and restart.

```bash
lsof -ti :5173 | xargs -r kill
npm run dev
```

The other two ways a dev window comes up blank are both staleness, not broken
code. A `ReferenceError` for a symbol the served file plainly exports is
Chromium's module cache — reload ignoring cache. A `TypeError` reading a field
off a snapshot means `target/debug/emma-host` is older than a change in
`crates/core`:

```bash
cargo build --bin emma-host   # then restart Electron so main respawns the host
```

### Emma opens but the second launch just focuses the first

Working as intended. The `second-instance` handler calls `openMain()`
([main.ts:2444](../desktop/main/main.ts#L2444)). Closing the workspace window
does not quit Emma on macOS — `window-all-closed` only quits off darwin
([main.ts:3387](../desktop/main/main.ts#L3387)).

## Building

### `zig: command not found`, or the harness step fails

**Cause.** `build:host` chains two builds and stops at the first failure:
`cargo build --locked -p emma-host`, then `build:harness`. The second one needs
a Zig compiler on `PATH`. [harness/build.zig.zon](../harness/build.zig.zon)
requires 0.16.0 or newer.

**Fix.**

```bash
brew install zig
zig version    # must be >= 0.16.0
npm --prefix desktop run build:host
```

### `clang: command not found` during `build:native`

**Cause.** [quick_ask.m](../desktop/native/quick_ask.m) and
[transcribe.m](../desktop/native/transcribe.m) are compiled directly by the
`build:native` script. That needs the Xcode Command Line Tools, not the full
Xcode app.

**Fix.**

```bash
xcode-select --install
npm --prefix desktop run build:native
```

### `build:native` compiles but then aborts

**Cause.** The script runs `dist-native/emma-option-tap --self-test`
immediately after linking it ([package.json](../desktop/package.json)). The
self-test exercises the double-tap state machine and the hold-binding parser
with synthetic `NSEvent`s and asserts on each
([quick_ask.m:557](../desktop/native/quick_ask.m#L557)). A failed assert kills
the build, which is the point — a broken gesture parser should never reach a
running app.

**Fix.** Read the assert. It names the case that broke.

### `vendor:ripgrep` fails

Three different failures, three causes
([vendor-ripgrep.mjs](../desktop/scripts/vendor-ripgrep.mjs)):

| Message | Cause | Fix |
| --- | --- | --- |
| `ripgrep download failed: <status>` | GitHub unreachable or rate-limiting | retry, or skip — see below |
| `ripgrep checksum mismatch: expected … got …` | the download did not match the pinned SHA-256; nothing was written | do not work around this; investigate the network path |
| `No pinned ripgrep for <platform>/<arch>` | not a darwin arm64/x64 Mac | not fatal, it exits 0 |

Skipping it is safe. [main.ts:284](../desktop/main/main.ts#L284) falls through to
`rg` on your `PATH`, and [search.ts](../desktop/main/search.ts) falls through
again to `grep`. Search gets slower and slightly different — `grep` has no
`--glob`, and its `--include` matches the file name where `rg` matches the whole
path.

```bash
brew install ripgrep   # the PATH fallback
```

### Rust build fails with a toolchain error

**Cause.** The workspace is edition 2024 with `rust-version = "1.97"`
([Cargo.toml](../Cargo.toml)), pinned to channel `1.97.1` by
[rust-toolchain.toml](../rust-toolchain.toml). Without `rustup`, nothing reads
that file.

**Fix.**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cd /path/to/emma && cargo check --workspace --locked --all-targets
```

`--locked` means [Cargo.lock](../Cargo.lock) must already satisfy the manifests.
If a dependency was added without updating the lock file, drop `--locked` once
and commit the result.

### `npm --prefix desktop run check` fails on lint but the code looks fine

`lint` is `eslint . --max-warnings 0` — a single warning is a failure. `check`
also runs `build:renderer`, so a renderer that type-checks but will not bundle
fails here too. Run the four sub-steps separately to see which:

```bash
npm --prefix desktop run test
npm --prefix desktop run typecheck
npm --prefix desktop run lint
npm --prefix desktop run build:renderer
```

## The agent will not run

### `Emma could not find its agent at <path>. The install is incomplete — reinstall Emma, or run npm run build:harness from the repo.`

**Cause.** `emma-cli` is missing. It is the only agent loop, and there is no
fallback to a second one on purpose: a bad build used to look like a working
Emma that quietly behaved differently
([main.ts:1590](../desktop/main/main.ts#L1590)). In a dev tree the binary is
expected at `harness/zig-out/bin/emma-cli`
([main.ts:262](../desktop/main/main.ts#L262)); in the packaged app it is in
`Contents/Resources`.

**Fix.**

```bash
npm --prefix desktop run build:harness
ls -l harness/zig-out/bin/emma-cli
```

### `emma-cli exited with code <n>`

**Cause.** The harness process died. Its stderr is forwarded to Emma's console
prefixed with `emma-cli:` ([harness.ts:281](../desktop/main/harness.ts#L281)),
and that prefix is where the actual reason is.

**Fix.** Run Emma from a terminal so you can see it, or reproduce the harness on
its own in the same workspace:

```bash
npm run dev 2>&1 | grep 'emma-cli:'
```

### `Harness call <method> timed out`

**Cause.** No answer from `emma-cli` within the idle window —
`MAX_IDLE_MS`, 30 minutes ([harness.ts:36](../desktop/main/harness.ts#L36)). The
timer resets on activity, so this means genuinely nothing came back, not that
the turn was long.

**Fix.** The failed turn does not lose the work: whatever the harness had
already streamed is recorded with the failure appended, so the transcript reads
as far as it got ([main.ts:2014](../desktop/main/main.ts#L2014)). Send the turn
again. If it recurs, the harness process is wedged — quit and relaunch Emma to
drop every client.

### `Harness is bound to <a>, not <b>`

**Cause.** One harness process per workspace directory, and the harness takes
its workspace root from that process's cwd once at startup. A turn asking for a
different directory cannot be honoured by that client
([harness.ts:303](../desktop/main/harness.ts#L303)).

**Fix.** A thread holds one folder. Attach the folder you meant, or open the
other one in a thread of its own.

### `No folder is connected to this thread. Ask the user to connect one from the ＋ menu.`

**Cause.** A filesystem tool was called on a thread with no folder grant
([main.ts:1006](../desktop/main/main.ts#L1006)).

**Fix.** ＋ menu → pick a directory. Note that a thread with no folder is not
broken — it runs in a scratch directory under `userData/workspaces/<threadId>`
([main.ts:1937](../desktop/main/main.ts#L1937)). Only the file tools need a real
grant.

### `This thread works in "<name>", and nothing outside it is reachable from here.`

**Cause.** The model named a folder that is not this thread's
([main.ts:1009](../desktop/main/main.ts#L1009)). Attaching a folder replaces
rather than appends, on purpose: a second folder would be reachable through
Emma's own tools and invisible to every tool the CLI runs itself.

**Fix.** Drop the folder argument, or open that folder in its own thread.

### `"<name>" is no longer at <path> — reconnect it from the ＋ menu.`

**Cause.** The granted directory was moved, renamed, or deleted
([folders.ts:156](../desktop/main/folders.ts#L156)).

**Fix.** Forget the grant and add it again from the ＋ menu.

## Models and providers

### The turn comes back refused, with the provider's text as the answer

**Cause.** When a provider or auth call fails, the harness reports it as ordinary
assistant text with a `refused` stop reason. Left alone, the provider's complaint
would be saved as Emma's answer. So Emma watches for exactly that case —
`failedTurn` is `reason === "refused"`
([harness.ts:47](../desktop/main/harness.ts#L47)) — and re-throws the spoken text
as an error instead. You get an error banner and your typed prompt back
([main.ts:1981](../desktop/main/main.ts#L1981)).

**Fix.** Read the banner. It is the provider's own message.

### `emma-cli has no provider credential. Set EMMA_PROVIDER_API_KEY.`

**Cause.** Emma owns the credential and hands it to the harness rather than
letting it find its own. `main.ts` reads `process.env.OPENROUTER_API_KEY`
([main.ts:1596](../desktop/main/main.ts#L1596)) and `harness.ts` passes it down
as both `AI_GATEWAY_API_KEY` and `EMMA_PROVIDER_API_KEY`
([harness.ts:267](../desktop/main/harness.ts#L267)). No key in the store means
no key in that environment.

**Fix.** Settings → Models → paste an OpenRouter key. Saving it restarts the
host and closes every **idle** harness so the next turn is spawned with the new
key; a harness that is mid-turn keeps its old environment until that turn ends
([main.ts:3319](../desktop/main/main.ts#L3319)).

```bash
# verify the key reached the process, from a terminal-launched dev run
ps eww $(pgrep -f 'emma-cli acp') | tr ' ' '\n' | grep EMMA_PROVIDER_API_KEY
```

### `This Mac's keychain is unavailable, so Emma will not store a key in plain text.`

**Cause.** `safeStorage.isEncryptionAvailable()` returned false
([credentials.ts:69](../desktop/main/credentials.ts#L69)). Emma refuses to
write a key it cannot encrypt.

**Fix.** Unlock the login keychain and try again. There is no plaintext fallback
and there should not be one.

### `Emma: stored provider keys could not be read; re-enter them in Settings`

**Cause.** `safeStorage.decryptString` failed on `credentials.json` — usually a
profile copied between Macs or between user accounts, since the ciphertext is
bound to this machine's keychain. The store clears itself rather than run with
half a set of keys ([credentials.ts:63](../desktop/main/credentials.ts#L63)).

**Fix.** Re-paste the keys in Settings → Models.

### `That model is no longer in OpenRouter's catalog. Reload the models page and pick again.`

**Cause.** A model was pinned by id that the cached catalog no longer lists. The
picker is answered in Electron main against `CatalogCache`, not by the host, so
this check runs where the catalog actually lives
([main.ts:1948](../desktop/main/main.ts#L1948), [catalog.ts](../desktop/main/catalog.ts)).

**Fix.** Settings → Models → reload the catalog, then pick again. The catalog is
cached on disk at `userData/openrouter-catalog.json` and answers from the cache
when the fetch fails.

### `OpenRouter listed no models Emma can use — check your connection and try again`

**Cause.** The catalog came back but nothing in it passed Emma's filter — free,
tool-capable, usable ([catalog.ts:124](../desktop/main/catalog.ts#L124)). Usually
a captive portal or a proxy returning an HTML error page as JSON.

**Fix.** Check the connection, then reload the catalog in Settings.

### `A local model server has to be on this Mac.`

**Cause.** A local model profile was saved with a non-loopback address. It is
checked in Electron main rather than trusted, because that endpoint is one main
POSTs your own saved pages to ([main.ts:1976](../desktop/main/main.ts#L1976)).
A sibling error, `The local model key must be the name of an environment variable.`,
comes from the next line: naming a credential is optional, but the name has to
be one.

**Fix.** Point it at `http://localhost:<port>/v1` or `http://127.0.0.1:<port>/v1`.

## macOS permissions

### Double-tapping left Option does nothing

**Cause.** Accessibility is not granted. `emma-option-tap` watches for the
gesture with `NSEvent addGlobalMonitorForEventsMatchingMask`, and macOS only
reports key presses in other apps to a trusted process. Without the grant, the
helper starts, prints to stderr, and never sees a thing
([quick_ask.m:659](../desktop/native/quick_ask.m#L659)):

```
Emma: Accessibility access is required for double-left-Option Quick Ask. Grant it in System Settings, then relaunch Emma.
```

**Fix.** **System Settings → Privacy & Security → Accessibility**, switch Emma
on, then **relaunch Emma**. The running helper does not pick up a new grant —
this is why the walkthrough's Accessibility card says so out loud
([shared/setup.ts:13](../desktop/shared/setup.ts#L13)).

```bash
open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
```

Two things that are *not* this bug:

- **Right** Option does nothing by design. The helper watches key code 58, the
  left one ([quick_ask.m:12](../desktop/native/quick_ask.m#L12)).
- The two taps must be under 0.35 s apart, and any other key or modifier in
  between cancels ([quick_ask.m:28](../desktop/native/quick_ask.m#L28)).

Also check the console for `Emma: Quick Ask hotkey listener failed` — that is
the helper crashing rather than being denied
([main.ts:327](../desktop/main/main.ts#L327)).

### `Screen Recording permission is required. Enable Emma in System Settings → Privacy & Security → Screen Recording.`

**Cause.** [computer.ts:100](../desktop/main/computer.ts#L100) checks
`systemPreferences.getMediaAccessStatus("screen")` before every capture and
refuses on `denied` or `restricted`. This blocks the `computer` tool's
`screenshot` action, the ▣ orb, and the ✎ annotation sheet.

**Fix.**

```bash
open 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
```

macOS requires a relaunch for Screen Recording to take effect.

### `Emma could not capture this display. Check Screen Recording permission and try again.`

**Cause.** The grant looks present but `desktopCapturer` returned nothing, or an
empty thumbnail ([computer.ts:106](../desktop/main/computer.ts#L106)). Usually a
stale grant on a rebuilt bundle — TCC keys on the code signing identity, and an
ad-hoc signed build's identity changes when you repackage.

**Fix.** Remove Emma from the Screen Recording list, add it back, relaunch.

### The knowledge folder stays empty

**Cause.** Files & Folders is not granted for Documents. TCC has no API to ask
about a folder grant and `access()` cannot see it either — a denied Documents
folder fails at `open`. So Emma writes a probe file and deletes it, which is the
only honest check ([setup.ts:48](../desktop/main/setup.ts#L48)). A refusal does
not lose your choice: the path is saved regardless
([setup.ts:33](../desktop/main/setup.ts#L33)).

**Fix.**

```bash
open 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'
```

Then re-pick the folder in the walkthrough or in Settings. Emma keeps its own
copy of knowledge either way — this only affects the readable Markdown mirror.

### `macOS has not allowed Emma to read your browser — grant it in System Settings → Privacy & Security → Automation → Emma.`

**Cause.** Reading the front browser tab goes through `osascript` and System
Events, which needs Automation. It is the one failure nothing else in Emma
reports — there is no setup-status row for it
([clip.ts:39](../desktop/main/clip.ts#L39)).

**Fix.**

```bash
tccutil reset AppleEvents dev.local.emma   # then trigger the clip again to re-prompt
```

Two neighbouring errors from the same file are *not* permission problems:
`<app> is not a browser Emma can read, and no browser window is open behind it`
([clip.ts:74](../desktop/main/clip.ts#L74)) and `<app> has no web page in front`
([clip.ts:76](../desktop/main/clip.ts#L76)).

### `macOS stopped Emma's speech helper. The built-in recognizer needs the packaged Emma.app — npm run package:mac.`

**Cause.** TCC does not refuse a process that touches Speech.framework without a
usage string — it aborts it. The string it reads is the *responsible* process's
`NSSpeechRecognitionUsageDescription`, which for the spawned `emma-transcribe`
helper is whatever launched Emma. `Emma.app` carries it via `--extend-info`
([Info.extra.plist](../desktop/native/Info.extra.plist)); the development
Electron binary does not ([voice.ts:63](../desktop/main/voice.ts#L63)).

**Fix.** Package the app, or use a local speech server instead of the `macOS ·
built in` engine.

```bash
npm run package:mac && open desktop/release/Emma-darwin-arm64/Emma.app
```

### `No speech-to-text server answered at <origin>. Start one in Settings → Voice.`

**Cause.** The local engine is selected and nothing is listening
([voice.ts:190](../desktop/main/voice.ts#L190)). A sibling error,
`The speech-to-text server answered <status>. Check the model name in Settings → Voice.`,
means something *is* listening but rejected the request
([voice.ts:192](../desktop/main/voice.ts#L192)).

**Fix.** Start the server, or switch the engine in Settings → Voice. The
endpoint must be loopback — `localhost`, `127.0.0.1`, or `[::1]` — or you get
`The speech-to-text endpoint must be a local address.`
([voice.ts:180](../desktop/main/voice.ts#L180)).

### Permission dialogs never show up as notifications

**Cause.** Notifications are a permission of their own, and one Emma cannot ask
for twice: denied, or an unsigned dev build macOS never prompted for. The banner
is dropped with no sign of it.

**Fix.** Nothing to do — Emma already handles it. On a dropped notification it
falls back to a critical Dock bounce, which needs no authorization and keeps
bouncing until you activate the app
([main.ts:517](../desktop/main/main.ts#L517)).

## Logs

Emma writes no log files. Everything goes to the main process's stdout and
stderr:

- `console.error` from `desktop/main`
- the Rust host's stderr, forwarded line by line
  ([main.ts:75](../desktop/main/main.ts#L75))
- `emma-cli`'s stderr, prefixed `emma-cli:`
  ([harness.ts:281](../desktop/main/harness.ts#L281))

So: run from a terminal and you see everything.

```bash
npm run dev 2>&1 | tee /tmp/emma.log
```

For a packaged build, launch the executable directly rather than through Finder:

```bash
./desktop/release/Emma-darwin-arm64/Emma.app/Contents/MacOS/Emma 2>&1 | tee /tmp/emma.log
```

To inspect a *running* Emma instead, the dev scripts drive it over CDP. That
needs Electron started with `--remote-debugging-port`, and
[drive.mjs](../desktop/scripts/drive.mjs) reads the port from `EMMA_CDP_PORT`
(default `9222`):

```bash
cd desktop && ./node_modules/.bin/electron . --remote-debugging-port=9222 &
node desktop/scripts/drive.mjs 'window.emma.setupStatus()'
```

`drive.mjs` evaluates through the renderer's own `window.emma` bridge, so it
exercises the same IPC path a click does rather than a back door around it.

## Environment variables

Every one of these is read by the code linked beside it. Nothing else in Emma is
configured by environment.

| Variable | Read by | Effect |
| --- | --- | --- |
| `EMMA_DATA_DIR` | [runtime.rs:9](../crates/host/src/runtime.rs#L9), [main.ts:3082](../desktop/main/main.ts#L3082) | Root for `threads/`, `knowledge/`, `scheduled/`, `research/`. Default `~/Library/Application Support/Emma`. Also what "reset data" deletes. |
| `EMMA_KNOWLEDGE_DIR` | [runtime.rs:33](../crates/host/src/runtime.rs#L33), [setup.ts:25](../desktop/main/setup.ts#L25) | Where the readable Markdown mirror goes. Default `~/Documents/Emma Knowledge`. **An empty value turns the mirror off.** Overridden by the walkthrough's saved choice once one is made. |
| `EMMA_PROVIDER_API_KEY` | [credentials.zig:9](../harness/src/core/auth/credentials.zig#L9) | The harness's credential. Emma sets it from `OPENROUTER_API_KEY` ([harness.ts:267](../desktop/main/harness.ts#L267)). |
| `EMMA_PROVIDER_CHAT_URL` | [emma_openai.zig:41](../harness/src/gateway/emma_openai.zig#L41) | Overrides the harness's Chat Completions URL. Default `https://openrouter.ai/api/v1/chat/completions`. Empty means the default. |
| `EMMA_OPENROUTER_ZDR` | [emma_openai.zig:54](../harness/src/gateway/emma_openai.zig#L54) | Any non-empty value asks OpenRouter for zero-retention routing. Read only by the harness. Set by the Settings toggle, which closes the idle harnesses so the next turn is spawned with it ([main.ts:3306](../desktop/main/main.ts#L3306)). Most free models offer no zero-retention endpoint, so forcing it can make them unroutable. |
| `OPENROUTER_API_KEY` | [main.ts:1596](../desktop/main/main.ts#L1596), [settings.ts:724](../desktop/shared/settings.ts#L724) | The one shipped remote route's key slot. |
| `EMMA_DEV_SERVER_URL` | [main.ts:432](../desktop/main/main.ts#L432), [ipc.ts:269](../desktop/main/ipc.ts#L269) | Load the renderer from Vite instead of `file://`, and trust that origin for IPC. Set by [dev.mjs](../desktop/scripts/dev.mjs). |
| `EMMA_CDP_PORT` | [drive.mjs:9](../desktop/scripts/drive.mjs#L9) | Which debugging port `drive.mjs` talks to. Default `9222`. |
| `EMMA_UPGRADE_BASE_URL` | [upgrade_helpers.zig:29](../harness/src/core/upgrade/upgrade_helpers.zig#L29) | The harness's self-upgrade endpoint. Not used by the desktop app. |

One note on something you may see in older docs: **`EMMA_HARNESS` no longer
exists.** It is not read anywhere in the current source. The harness is the only
agent loop now — `main.ts` throws rather than falling back
([main.ts:1590](../desktop/main/main.ts#L1590)). Any reference to
`EMMA_HARNESS=1` or `=0` is stale, including in a `desktop/dist-main` build
artifact left over from an earlier compile.

## Starting over

**Wipe everything.** Settings has a reset that closes the host, deletes both
roots, and relaunches ([main.ts:3082](../desktop/main/main.ts#L3082)). The
Markdown mirror in Documents is your folder, so it stays — and nothing reads it
back in. The equivalent by hand, with Emma quit:

```bash
rm -rf ~/Library/Application\ Support/Emma \
       ~/Library/Application\ Support/emma-desktop
```

**Replay the walkthrough only.** It is gated on one `localStorage` key
([App.tsx:341](../desktop/src/App.tsx#L341)). Clear it from the running app:

```bash
node desktop/scripts/drive.mjs 'localStorage.removeItem("emma.setupSeen.v1")'
```

**Rebuild every binary.** When the symptom is a mismatch between the
TypeScript, Rust, and Zig halves:

```bash
npm --prefix desktop run build:host
npm --prefix desktop run build:native
npm --prefix desktop run build:main
```

**Reset a single macOS grant.** TCC keys on the bundle id, which is
`dev.local.emma` ([desktop/package.json](../desktop/package.json)):

```bash
tccutil reset Accessibility dev.local.emma
tccutil reset ScreenCapture dev.local.emma
tccutil reset AppleEvents dev.local.emma
tccutil reset Microphone dev.local.emma
tccutil reset SpeechRecognition dev.local.emma
```

## See also

- [getting-started.md](getting-started.md) — prerequisites, first run, and every build command
- [development.md](development.md) — workflow and conventions
- [architecture.md](architecture.md) — which layer owns what
- [permissions.md](permissions.md) — the four modes and the tool gate
- [models.md](models.md) — providers, catalog, and the free router
- [harness.md](harness.md) — `emma-cli` and the ACP wiring
- [cli.md](cli.md) — the `cli` tools and Settings → Connections
- [data.md](data.md) — every file Emma writes and where
- [privacy.md](privacy.md) — what leaves this Mac, and when
- [voice.md](voice.md) — dictation setup and its failure modes
- [computer-use.md](computer-use.md) — pointer control and its limits
- [notch.md](notch.md) — Quick Ask and the island
- [knowledge.md](knowledge.md) — the knowledge base and its mirror
- [concepts.md](concepts.md) — the vocabulary
- [tools.md](tools.md) — the tool catalog
- [jobs.md](jobs.md) — scheduled work
- [autoresearch.md](autoresearch.md) — the long-running research loop
- [plugins.md](plugins.md) — UI plugins
- [design-system.md](design-system.md) — the visual language
- [icon-sources.md](icon-sources.md) — where the brand marks come from
