# Troubleshooting

Every error string below is quoted from the source file it is thrown in. If a
message you hit is not here, grep for it — Emma's errors are literals.

## Launching and building

| Problem | Cause | Fix |
| --- | --- | --- |
| `npm run dev` exits 0 with no window | `app.requestSingleInstanceLock()` failed, so this process calls `app.quit()` silently ([main.ts:2028](../desktop/main/main.ts#L2028)). A packaged app and a dev run share Electron's `userData` directory, so both take the same lock. | Quit the running Emma, or `electron . --user-data-dir=/tmp/emma-dev-profile` |
| A second launch just focuses the first window | Same lock — `app.on("second-instance")` re-opens the existing window. Intended. | — |
| The dev run edits your real threads and vault | Both roots are shared: the Rust host defaults to `%APPDATA%/Emma` on Windows or `~/Library/Application Support/Emma` on macOS, while Electron stores its own files in `userData`. | `EMMA_DATA_DIR=/tmp/emma-data electron . --user-data-dir=/tmp/emma-dev-profile` |
| Blank window, or every privileged IPC call throws `IPC sender is not allowed` | `trustedSender` accepts only the dev-server origin or `file://<appRoot>/dist-renderer/index.html` ([ipc.ts:240](../desktop/main/ipc.ts#L240)). Electron started without `EMMA_DEV_SERVER_URL`, or `dist-renderer/` was never built. | Use `npm run dev` (it sets the var), or `npm --prefix desktop run build:renderer` first |
| `zig: command not found` during `build:host` | `build:harness` runs `(cd ../harness && zig build)`. | Install Zig 0.16.0, matching CI and [harness/build.zig.zon](../harness/build.zig.zon) |
| `clang: command not found` during `build:native` | The platform-specific native helpers are compiled with Clang. | On macOS run `xcode-select --install`; on Windows install LLVM/Clang with the Windows SDK |
| `build:native` compiles, then aborts | A native helper self-test failed; the `&&` chain stops. | Read the assertion from `emma-option-tap`, `emma-computer` or `emma-pty` and investigate before packaging |
| `ripgrep checksum mismatch: expected …, got …. Nothing was written.` | `vendor:ripgrep` verifies the download against a per-arch SHA-256 ([vendor-ripgrep.mjs:45](../desktop/scripts/vendor-ripgrep.mjs#L45)). A proxy rewrote the tarball, or the pin is stale. | Retry off the proxy; if the pin really is stale, update version and hash together |
| `ripgrep download failed: <status>` | GitHub release fetch failed. Needs network on first build only. | Retry, or drop a `rg` binary at `desktop/vendor/rg` yourself |
| Rust build fails on toolchain | `rust-toolchain.toml` pins `1.97.1`; the workspace is edition 2024. | `rustup toolchain install 1.97.1` |
| `npm --prefix desktop run check` fails on lint only | `eslint . --max-warnings 0` — a warning is a failure. | `npx eslint . --fix`, then re-run |

## The agent will not run

| Problem | Cause | Fix |
| --- | --- | --- |
| `Emma could not find its agent at <path>. The install is incomplete — reinstall Emma, or run npm run build:harness from the repo.` | `binary("emma-cli")` resolves to `harness/zig-out/bin/emma-cli` or `emma-cli.exe` in dev and the packaged app's resources directory ([main.ts:1344](../desktop/main/main.ts#L1344)). | `npm --prefix desktop run build:harness` |
| `emma-cli exited with code <n>` | The harness child died ([harness.ts:332](../desktop/main/harness.ts#L332)). Its stderr is forwarded to the Electron console prefixed `emma-cli:`. | Read that stderr line; run `harness/zig-out/bin/emma-cli doctor` directly |
| `Harness call <method> timed out` | No ACP response inside the call deadline ([harness.ts:512](../desktop/main/harness.ts#L512)). | Stop the turn; check whether a model call is hanging |
| `Harness is bound to <a>, not <b>` | One `emma-cli` process is pinned to one working directory ([harness.ts:352](../desktop/main/harness.ts#L352)); the thread's folder changed under it. | Start a new thread for the other folder |
| `No folder is connected to this thread. Ask the user to connect one from the ＋ menu.` | A tool needed a granted folder and the thread has none ([main.ts:895](../desktop/main/main.ts#L895)). | Attach one from ＋ |
| `This thread works in "<name>", and nothing outside it is reachable from here.` | A thread holds exactly one folder ([main.ts:898](../desktop/main/main.ts#L898)). | Open the other folder in its own thread |
| `"<name>" is no longer at <path> — reconnect it from the ＋ menu.` | The grant in `folders.json` is re-checked against the real path on every read ([folders.ts](../desktop/main/folders.ts)), and `Harness.start` checks the working directory before spawning ([harness.ts](../desktop/main/harness.ts)) — Node reports a missing cwd as `ENOENT` on the executable, which used to read as a broken install. The folder moved, was renamed, or was deleted. | Re-attach it |
| `Emma's tools are only available while a turn is running.` | A tool call arrived with no live turn ([main.ts:1500](../desktop/main/main.ts#L1500)). | Send a message first |
| `That skill is switched off in Settings → Tools.` | The slug is in `disabledSkills` ([main.ts:2747](../desktop/main/main.ts#L2747)). | Re-enable it in Settings → Tools |

## Models and providers

| Problem | Cause | Fix |
| --- | --- | --- |
| `emma-cli has no provider credential. Set EMMA_PROVIDER_API_KEY.` | The harness's only credential source is that one variable ([credentials.zig:88](../harness/src/core/auth/credentials.zig#L88)); whitespace counts as absent. Electron passes it at spawn from the stored `OPENROUTER_API_KEY`. | Save a key in Settings → Models — it applies to the *next* harness spawn |
| `This computer's secure credential store is unavailable, so Emma will not store a key in plain text.` | `safeStorage.isEncryptionAvailable()` returned false ([credentials.ts:69](../desktop/main/credentials.ts#L69)). | Unlock or enable the operating system's secure credential store, then relaunch |
| Console: `Emma: stored provider keys could not be read; re-enter them in Settings` | `credentials.json` will not decrypt — usually a different login keychain ([credentials.ts:63](../desktop/main/credentials.ts#L63)). | Re-enter the key |
| `That model is no longer in OpenRouter's catalog. Reload the models page and pick again.` | The saved id is absent from the cached catalog ([main.ts:1563](../desktop/main/main.ts#L1563)). | Reload Settings → Models and pick again |
| `OpenRouter listed no models Emma can use — check your connection and try again` | The catalog fetch returned nothing usable ([catalog.ts:124](../desktop/main/catalog.ts#L124)). | Check the network; the compiled seed catalog covers first launch |
| `That endpoint is plain http off this computer.` | A provider base URL is `http:` on your network rather than loopback ([settings.ts](../desktop/shared/settings.ts)). | Tick the network box to accept unencrypted prompts and keys, or serve it over https |
| A new provider cannot be selected | Provider registration or settings persistence failed. Saving must succeed before the profile can be used. | Read the error in Settings → Models, check the endpoint/profile, and retry saving; do not assume a displayed choice was persisted |
| A model reports no eligible endpoint with Private routing on | The chosen model has no endpoint satisfying the requested no-training/zero-retention policy. | Pick a qualifying model or a local provider. Turn off Private routing only if its weaker privacy policy is acceptable |

## Platform permissions

| Problem | Cause | Fix |
| --- | --- | --- |
| ⌥⌥ does nothing on macOS | `NSEvent addGlobalMonitorForEventsMatchingMask` reports other apps' keys only to a trusted process. `emma-option-tap` prints `Emma: Accessibility access is required to control the computer.` to stderr ([quick_ask.m:613](../desktop/native/quick_ask.m#L613)). | Grant Accessibility, then **relaunch Emma** — the running helper does not pick up a new grant |
| Left Alt double-tap does nothing on Windows | Quick Ask listens for the physical left Alt key; the Windows helper may be missing or stopped. | Rebuild the Windows native helpers and start a new Emma run; Accessibility and Automation grants are not required |
| `Screen Recording permission is required. Enable Emma in System Settings → Privacy & Security → Screen Recording.` | `getMediaAccessStatus("screen")` is `denied` or `restricted` for the separate screen-context or annotation capture ([computer.ts](../desktop/main/computer.ts)); app-scoped computer use does not capture the screen. | Grant it, then relaunch |
| `Emma could not capture this display. Check Screen Recording permission and try again.` | `desktopCapturer` returned no source for that screen-context or annotation capture, or an empty thumbnail ([computer.ts](../desktop/main/computer.ts)). | Grant Screen Recording; if it is granted, the display was disconnected mid-capture |
| `macOS has not allowed Emma to read your browser — grant it in System Settings → Privacy & Security → Automation → Emma.` | The Apple Events send to Safari or Chrome was refused ([clip.ts:39](../desktop/main/clip.ts#L39)). macOS reports Automation grants to nobody, so this error is the only signal. | Grant Automation → Emma → that browser |
| `macOS stopped Emma's speech helper. The built-in recognizer needs the packaged Emma.app — npm run package:mac.` | TCC reads the *responsible* process's `Info.plist` for `NSSpeechRecognitionUsageDescription`. Only `Emma.app` carries it (`--extend-info`); the dev Electron binary does not ([voice.ts:63](../desktop/main/voice.ts#L63)). | Package it, or use a local speech server instead |
| Windows built-in speech is unavailable | The SAPI helper could not start or no supported Windows speech recognition language is installed. | Check Windows speech settings, rebuild `emma-transcribe.exe`, or use a local speech server instead |
| `No speech-to-text server answered at <origin>. Start one in Settings → Voice.` | Nothing is listening on the configured loopback endpoint ([voice.ts:190](../desktop/main/voice.ts#L190)). | Start the server, or switch the engine |
| `The speech-to-text server answered <status>. Check the model name in Settings → Voice.` | The server replied non-2xx ([voice.ts:192](../desktop/main/voice.ts#L192)). | Fix the model name |
| No notification banners; the macOS Dock icon bounces instead | An unsigned macOS build is never prompted for notification permission, so `Notification` emits `failed` and Emma falls back to `dock.bounce("critical")` ([main.ts:429](../desktop/main/main.ts#L429)). | Expected in dev. Only the packaged, signed app is ever prompted |

## The vault (knowledge base)

Emma writes one Markdown note per save into `<vault>/knowledge-base`. There is
no second copy — see [data.md](data.md).

| Problem | Cause | Fix |
| --- | --- | --- |
| `Emma has nowhere to keep this yet. Choose an Obsidian vault or a folder on the Knowledge base page, then keep it again.` | No vault in `vault.json` ([main.ts:955](../desktop/main/main.ts#L955)). | Pick one on the Knowledge base page |
| Nothing appears in the vault, and the setup row stays unchecked | `vaultWritable` writes `.emma-write-check` into the notes folder and deletes it ([vault.ts:106](../desktop/main/vault.ts#L106)). A failure here is almost always the Files & Folders grant. | Grant Files & Folders, or pick a folder outside the protected ones |
| `That screenshot is too large to keep.` | Decoded attachment exceeded `MAX_ATTACHMENT_BYTES` = 8 MB ([shared/vault.ts](../desktop/shared/vault.ts)). | — |
| `That screenshot is not an image Emma can keep.` | The data URL was not `png`, `jpeg`, `jpg`, `webp` or `gif`. | — |
| `Your vault already keeps too many notes by that name.` | `freeNotePath` tried `slug.md`, `slug-2.md` … up to `MAX_VAULT_NOTES` = 2000. | Rename or archive the existing notes |
| `That note has no frontmatter to fill in.` / `That is not a note Emma saved.` | Auto-tagging rewrites frontmatter in place; the file has none, or the path is not an absolute `.md` ([vault.ts:304](../desktop/main/vault.ts#L304)). | — |
| Notes save but never get tags | `tagNote` returns `null` unless both a model and an endpoint are set ([vault-tags.ts:59](../desktop/main/vault-tags.ts#L59)). | Configure the tagger in Settings → Models |

## Computer use and the browser

Every ceiling below applies in **every** permission mode, `full` included.

| Problem | Cause | Fix |
| --- | --- | --- |
| `This computer run reached its step limit` | `MAX_RUN_STEPS` = 20 ([computer.ts](../desktop/main/computer.ts)). | Ask again with a narrower goal |
| `The user did not allow this app. Do not try it again this turn.` | Exact-app approval is required even in Full access. | Do not retry or work around the denial |
| `Computer use must be performed by the parent turn with a current tool call.` | Child agents cannot use the parent's app grant ([harness.ts](../desktop/main/harness.ts)). | Ask the parent turn to perform app actions |
| `Computer action timed out and may already have happened. Do not retry it automatically.` | `emma-computer` did not answer within 10 seconds ([computer.ts](../desktop/main/computer.ts)). | Inspect the app before starting a new turn; do not repeat the action automatically |
| `Get a fresh app state before acting; that snapshot is stale or belongs to another app` | Mutations need an element from that app's latest single-use snapshot. | Call `get_app_state` again; screenshots and coordinates are unsupported |
| A control cannot be pressed or edited in the background | The app does not expose the required accessibility operation; `type_text` supports only plain text fields and combo boxes. | Stop and explain the limitation; there is no pointer, activation or clipboard fallback |
| `text is invalid` | Text is empty, exceeds 4096 characters, or contains a null byte. | Supply bounded plain text |
| A run feels throttled | `MIN_ACTION_INTERVAL_MS` = 40 between actions, and `MAX_RUN_MS` caps a run at 10 minutes. | — |
| `Emma could not open a debugging port for its browser, so the agent cannot drive it.` | The `browser` tool needs a CDP port on Emma's own `BrowserView` ([browser.ts:245](../desktop/main/browser.ts#L245)). | Relaunch Emma |

## Capability limits

| Problem | Cause |
| --- | --- |
| `Tool code must start with a #! line naming its interpreter` | `write_tool` scripts are `0700` and must be executable ([capabilities.ts:181](../desktop/main/capabilities.ts#L181)) |
| `Emma already holds the maximum number of tools` / `… learned skills` | Per-kind ceilings in [capabilities.ts](../desktop/main/capabilities.ts) |
| `Memory files are limited to 262144 bytes.` | `MAX_MEMORY_FILE_BYTES` = 256 KiB; `MAX_MEMORY_FILES` = 256 ([memory.ts](../desktop/main/memory.ts)) |
| `The memory path is outside the memory directory.` | Both a literal `/memories` prefix check and a resolved-prefix check run before any I/O |
| `Every skill needs instructions, under 64KB.` | A `write_plugin` skill body over 64 KiB ([marketplace.ts:687](../desktop/main/marketplace.ts#L687)); `write_skill` uses the same ceiling ([capabilities.ts:9](../desktop/main/capabilities.ts#L9)) |

## Logs and reset

| Want | Do |
| --- | --- |
| Main-process logs | The terminal running `npm run dev`. `emma-cli` stderr is prefixed `emma-cli:`; host errors are prefixed `Emma:` |
| Renderer logs | macOS `⌥⌘I`; Windows `Ctrl+Shift+I`; or drive the running app: `node desktop/scripts/drive.mjs '<expression>'` (attaches over CDP on `EMMA_CDP_PORT`, default `9222`) |
| Harness session records | `<userData>/harness/.fx/sessions/<id>/` — `events.jsonl`, `usage-v2.json` |
| Wipe everything | Settings → Reset all data. Emma removes its Electron `userData` root and configured `EMMA_DATA_DIR`, then relaunches ([main.ts:2545](../desktop/main/main.ts#L2545)). Your vault is outside both roots and survives |
| Wipe just the harness | Remove `<userData>/harness` (`%APPDATA%/Emma/harness` on a packaged Windows build; use `rm -rf ~/Library/Application\\ Support/emma-desktop/harness` for a macOS dev profile) |
| Wipe just the stored keys | Remove `<userData>/credentials.json` (`%APPDATA%/Emma/credentials.json` on a packaged Windows build) |
| Wipe renderer settings | `node desktop/scripts/drive.mjs 'localStorage.removeItem("emma.settings.v1")'` |

## See also

- [data.md](data.md) — every path and environment variable named above
- [getting-started.md](getting-started.md) — install and first run
- [development.md](development.md) — checks, tests, packaging
- [permissions.md](permissions.md) — the four modes and the gate table
- [computer-use.md](computer-use.md) — approved app-scoped accessibility controls
- [models.md](models.md) — providers and routing
- [harness.md](harness.md) — `emma-cli`, Emma's fork of [vercel-labs/fx](https://github.com/vercel-labs/fx)
