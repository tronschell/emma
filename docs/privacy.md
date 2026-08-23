# Privacy

What leaves this Mac, what doesn't, and where each thing goes. Every claim here traces to a file in this repo. Where the code and the UI copy disagree, the code wins, and the disagreement gets named at the bottom of the page.

## Where data goes

| Subsystem | What data | Where it goes |
| --- | --- | --- |
| Thread turn | Your prompt, thread history, tool results, system prompt, tool schemas | The configured chat endpoint. `https://openrouter.ai/api/v1/chat/completions` unless `EMMA_PROVIDER_CHAT_URL` says otherwise |
| Verifier (`auto` mode) | Your request and the pending tool call | The verifier endpoint. OpenRouter by default |
| Advisor tool | The transcript so far, up to 60,000 chars | The advisor endpoint. Off unless you set a model |
| Vision tool | One image as a data URL, plus your question | The vision endpoint. OpenRouter by default |
| Tagger | The top of a thread, up to 4,000 chars, plus your tag list | The tagger endpoint. OpenRouter by default |
| Autoresearch judge | The job's output, sliced to 32 KB | The job's own proposer model |
| Knowledge-page authoring | The captured page text, or a thread's last answer, plus your category names. A revision also sends the page's current blocks | The selected model's endpoint. OpenRouter by default; nothing at all on the local fallback |
| Model catalog | Nothing but the HTTP request. No credential, no query text | `openrouter.ai` |
| `web_search` | Your query string, plus a result count on Brave, Tavily and Exa | Your configured search provider. `4get.canine.tools` by default |
| `web_fetch`, `save_page` | The URL you or the model named | That site |
| Dictation | Recorded audio | `127.0.0.1:8080`, or macOS on-device Speech.framework. Never off this Mac |
| Transcript cleanup | The raw transcript | `127.0.0.1:8081`. Never off this Mac |
| Computer use | Screenshots, pointer and keyboard actions | Stays in Electron. The model gets text only |
| Annotated screen context | A compressed JPEG | Stays in Electron's main process |
| Knowledge mirror | Markdown pages | `~/Documents/Emma Knowledge` on this disk |
| Threads, traces, jobs, plans | Markdown and JSON | `~/Library/Application Support/Emma` |
| Provider keys | Your API keys | Keychain-encrypted on disk, plus the spawn environment of Emma's own child processes |

## The thread turn

This sends the most, so it gets the most detail.

[main.ts](../desktop/main/main.ts) catches the renderer's `sendMessage` and runs the turn on `emma-cli`, the Zig harness in [harness/](../harness). The harness makes the HTTP call. [emma_openai.zig](../harness/src/gateway/emma_openai.zig) builds the body and posts it to `EMMA_PROVIDER_CHAT_URL`, which defaults to `https://openrouter.ai/api/v1/chat/completions`. Requests carry `"stream":false` and get at most 3 retries.

The bearer token is `EMMA_PROVIDER_API_KEY`, set by [harness.ts](../desktop/main/harness.ts) from `process.env.OPENROUTER_API_KEY`:

```ts
const key = this.deps.apiKey ? { AI_GATEWAY_API_KEY: this.deps.apiKey, EMMA_PROVIDER_API_KEY: this.deps.apiKey } : {};
```

The harness runs with `cwd` set to the thread's connected folder. A thread with no folder gets a scratch directory under `<userData>/workspaces/<threadId>`, because the alternative is an agent loose in your home directory.

## Zero-retention routing

**Off by default.** The switch lives in **Settings → Models**, under the heading *Private routing*, bound to `settings.requireZeroRetention`. Its label:

> Require no-training, zero-retention endpoints (blocks every free model)

Turning it on sets `EMMA_OPENROUTER_ZDR` in Electron's environment and recycles the idle harnesses. Turning it off deletes the variable and recycles again ([main.ts](../desktop/main/main.ts), `emma:set-zero-retention`). `emma-cli` reads the flag from its spawn environment, which is why a change has to reach the processes that are already up.

### What goes on the wire

With the flag set and the chat URL pointing at OpenRouter, [emma_openai.zig](../harness/src/gateway/emma_openai.zig) appends exactly this to the request body:

```json
"provider":{"data_collection":"deny","zdr":true}
```

`isOpenRouter()` is a substring check for `://openrouter.ai/`. Point Emma at any other host and those keys are not sent, because they are OpenRouter's own routing vocabulary and mean nothing anywhere else.

That is the only place in Emma these flags are built. A Zig sidecar used to keep a second copy of this logic; the sidecar is gone and so is the copy.

### What the toggle does not cover

The flags ride the harness's request body, so they cover every turn and nothing else. Electron main's own provider calls — the verifier, tagger, vision, advisor, and knowledge-page authoring — post a plain OpenAI-compatible body from [verifier.ts](../desktop/main/verifier.ts) and [knowledge-author.ts](../desktop/main/knowledge-author.ts) with no `provider` object on it. Zero-retention routing does not apply to them. Point them at a local profile if that matters to you; [models.md](models.md) has the settings.

### What the flags do

`data_collection: "deny"` tells OpenRouter not to route your request to any upstream provider that might collect the prompt. `zdr: true` demands a zero-data-retention endpoint. If OpenRouter cannot satisfy that, the request **fails** instead of quietly falling through to a provider that might keep your prompt. The failure is the feature.

### Why it is off by default

From [settings.ts](../desktop/shared/settings.ts), on `requireZeroRetention: false`:

> OpenRouter has no free zero-retention endpoint, so requiring it would block the whole free catalog.

The Settings copy says the same thing: leave it off unless you route to a paid or local model.

### What it does not cover

Your OpenRouter account settings. Account-level logging and product-improvement toggles live on OpenRouter, not in Emma, and they still apply. **Settings → Data & privacy** links straight there:

<https://openrouter.ai/settings/privacy>

One more limit worth knowing: the free router chain leaves out stealth and cloaked routes, because their vendor is unnamed and their prompts are logged for training. That is a hardcoded list, not a runtime check.

## Free models

There is **no privacy warning when you pick a free model**. The catalog shows a `Free` or `Paid` badge per row and offers a "Free only" filter, and the *Private routing* section warns that turning it on blocks every free model. That is all of it. If you are looking for a per-model consent dialog, it is not in this code.

`free` in the catalog means both `pricing.prompt` and `pricing.completion` parse to exactly `0` ([catalog.ts](../desktop/main/catalog.ts)). The renderer's own check is a suffix test: `idOrKey.endsWith(":free")`.

## The model catalog

Browsing models sends nothing about you. [catalog.ts](../desktop/main/catalog.ts) fetches:

```
https://openrouter.ai/api/v1/models?supported_parameters=tools&sort=most-popular
```

No credential, no body. The listing is public, and `fetchOpenRouterCatalog` is a plain `fetch` with a timeout. The response is cached at `<userData>/openrouter-catalog.json`, mode `0o600`, and a failed fetch returns the cached list with `stale: true` instead of an error page.

[seed-catalog.mjs](../desktop/scripts/seed-catalog.mjs) does the same fetch at build time to regenerate [catalog-seed.ts](../desktop/main/catalog-seed.ts), the 332 rows compiled into the app so a first launch with no network still has a picker.

## Web search

[web-search.ts](../desktop/main/web-search.ts) sends your query string to one of five back ends. Which one is your choice in **Settings → Tools**.

| Provider | Endpoint | Credential | Header |
| --- | --- | --- | --- |
| 4get (default) | `https://4get.canine.tools` → `/api/v1/web?s=<query>` | none | none |
| SearXNG | `http://127.0.0.1:8888` → `/search?q=&format=json` | none | none |
| Brave | `https://api.search.brave.com` → `/res/v1/web/search` | `BRAVE_SEARCH_API_KEY` | `X-Subscription-Token` |
| Tavily | `https://api.tavily.com` → `/search` | `TAVILY_API_KEY` | `Authorization: Bearer` |
| Exa | `https://api.exa.ai` → `/search` | `EXA_API_KEY` | `x-api-key` |

Every request goes out as `net.fetch(url, { credentials: "omit", ... })` with a 20-second timeout, so no cookie or stored auth rides along with your query.

4get gets one retry, and only at a different host: `https://search.yonderly.org`. Every other provider is one host by definition, and its failures are your endpoint or your key, which retrying cannot fix.

Results are cached in memory for 10 minutes, at most 64 entries, keyed on provider, endpoint, limit and query. 4get's terms ask callers to cache rather than re-ask. Snippets get truncated to 300 characters, titles to 200, URLs to 2048.

Search endpoints deliberately **skip** `publicUrl`. The endpoint is your own setting, and a self-hosted SearXNG lives on `127.0.0.1` — exactly the address `web_fetch` has to refuse when the *model* names it.

## Web fetch and page clipping

`web_fetch` and `save_page` reach whatever URL they are handed, so both are guarded against being aimed at your own network.

Two validators in [ipc.ts](../desktop/main/ipc.ts):

- **`externalUrl`** — any `http:`/`https:` URL. Used for links *you* clicked, which open in your system browser.
- **`publicUrl`** — everything `externalUrl` accepts, minus anything private. Used for any URL the *model* supplied.

`publicUrl` blocks `localhost`, `.localhost`, `.local`, `.internal`, and the ranges `0.x`, `10.x`, `127.x`, `169.254.x`, `172.16–31.x`, `192.168.x`, `100.64–127.x`, `255.x`, plus `::1`, `::`, `fc/fd` and `fe8/fe9/fea/feb`. Your router, your Ollama and your dev server stay off limits however the model asks.

[clip.ts](../desktop/main/clip.ts) does the fetching, with `redirect: "manual"` and at most 5 hops. The guard runs again on **every hop**, so a public URL cannot bounce into your LAN. Requests are `credentials: "omit"` with a 20-second timeout, the content type must match `^\s*(text\/|application\/(xhtml|xml|json))`, and the body is capped at `MAX_FETCHED_PAGE_BYTES` (2 MiB) with text truncated to `MAX_FETCHED_TEXT_CHARS` (50 KiB).

Fetched page text comes back to the model with a line in front of it saying it is information, not instructions. Search results carry the same warning.

## Dictation

Every stage of dictation runs on this Mac, and main enforces that rather than trusting the setting.

Audio is recorded in the renderer, the one window granted a microphone. Two engines:

- **macOS Speech.framework** — [transcribe.m](../desktop/native/transcribe.m) sets `request.requiresOnDeviceRecognition = YES;`, which is Apple's switch for refusing server-side recognition.
- **A local `llama.cpp` server** — `ggml-org/Qwen3-ASR-0.6B-GGUF` at `http://127.0.0.1:8080/v1/audio/transcriptions`.

Optional cleanup runs `superwhisper/s1-mini-GGUF` at `http://127.0.0.1:8081/v1/chat/completions`.

### How the enforcement works

[voice.ts](../desktop/main/voice.ts) resolves every endpoint through `localEndpoint()` before it will use it:

```ts
const endpoint = localEndpoint(settings.transcriptionEndpoint);
if (!endpoint) throw new Error("The speech-to-text endpoint must be a local address.");
```

Cleanup does the same, and hands back the raw transcript rather than sending it anywhere else:

```ts
const endpoint = localEndpoint(settings.voiceCleanupEndpoint);
if (!... || !endpoint) return raw;
```

`localEndpoint()` in [settings.ts](../desktop/shared/settings.ts) accepts `http:` or `https:` on `localhost`, `127.0.0.1` or `[::1]`, and nothing else.

This gets checked twice. `validateSettings` refuses to *save* a non-local transcription or cleanup endpoint — *"The transcript cleanup endpoint must be local"* — and [voice.ts](../desktop/main/voice.ts) checks again at use time. So a settings file edited by hand still cannot redirect your voice.

Audio never touches durable storage. The utterance goes into a temp WAV under `mkdtemp(tmpdir(), "emma-voice-")` at mode `0o600` and is removed in a `finally` block. `MAX_UTTERANCE_BYTES` is 12 MiB. Timeouts: probe 1.5 s, transcribe 120 s, cleanup 20 s, authorize 60 s.

Full setup in [voice.md](voice.md).

## Vision and screenshots

Three image paths, three different destinations.

**The `vision` tool.** This one *does* send an image to a model. That is the whole job. [vision.ts](../desktop/main/vision.ts) posts an `image_url` data URL to the configured vision endpoint, `https://openrouter.ai/api/v1/chat/completions` by default, with a 60-second timeout and 1024 max tokens. A URL argument goes through `publicUrl`, not `externalUrl`, because the URL came from the model. A path argument has to be inside a connected folder.

**Computer-use screenshots.** Captured with `desktopCapturer`, compressed to JPEG at quality 82, and used inside Electron to map coordinates. On this branch the `computer` tool returns **text only** to the model. The frame is never attached to a turn. The tool's own reply string still says *"The image is attached to this message"*, which is stale.

**Annotated screen context.** The yellow pen captures and compresses a screen image locally into `ScreenContextStore`. `sendMessage` claims it and puts it on `request.params.screenContext`, but `runOnHarness` reads only `skillContext` off `turn.params`:

```ts
skillContext: typeof turn.params?.skillContext === "string" ? turn.params.skillContext : undefined,
```

So on this branch the annotated frame never leaves the main process. Compressed frames are capped at `MAX_SCREEN_CONTEXT_CHARS` and checked as valid JPEG data URLs before they are stored at all.

## Computer use

**There is no YOLO toggle.** No such setting exists anywhere in this code. What decides whether the pointer moves is the composer's permission mode, from [permissions.ts](../desktop/shared/permissions.ts):

```ts
computer: { ask: "ask", acceptEdits: "ask", full: "auto" }
```

`auto` maps onto the `ask` column, with the question going to your verifier model instead of to you. So: *Ask* and *Accept edits* stop for your yes on every call, *Auto* asks the verifier, and *Full access* lets it through.

[computer.ts](../desktop/main/computer.ts) says the same thing from the other side: "`computer` is `ask` in every mode but `full`, so by the time a call reaches here the user has already said yes."

Every other guard applies in every mode, with no way to turn it off:

| Ceiling | Value |
| --- | --- |
| `MAX_RUN_STEPS` | 20 |
| `MAX_RUN_ACTIONS` | 400 |
| `MIN_ACTION_INTERVAL_MS` | 40 |
| `MAX_RUN_MS` | 600,000 (10 minutes) |
| `HELPER_TIMEOUT_MS` | 5,000 |
| `MAX_KEY_REPEAT` | 32 |

Every action is logged as it happens:

```
Emma computer action 37/400: left_click
```

The on-screen run banner appears whenever a run is live, and Escape is registered as a global shortcut for exactly as long as one is:

```ts
globalShortcut.register("Escape", () => { computerRuntime?.abort("stopped by the user"); closeRunBanner(); });
```

The runtime also aborts when the turn ends, when you stop it, and on app quit. More in [computer-use.md](computer-use.md).

## Credentials

A key you paste is encrypted with the macOS keychain through Electron's `safeStorage`, base64-encoded, and written to `<userData>/credentials.json`. The write goes to a `.tmp` file at mode `0o600` inside a directory created `0o700`, then renamed into place ([credentials.ts](../desktop/main/credentials.ts)).

If the keychain is unavailable, `save()` throws instead of settling for something weaker:

> This Mac's keychain is unavailable, so Emma will not store a key in plain text.

`applyToEnv(process.env)` decrypts the secrets onto Electron's environment. `emma-cli` inherits that environment when it is spawned. The Rust host inherits it too, but reads no key out of it: nothing in Rust makes a network request. **The renderer never receives a key.** `list()` returns `{ env, masked }`, and `maskSecret` gives the first 6 characters, ten bullets, and the last 4.

The second models follow the same rule. They read `process.env[settings.credentialEnv]`, so a settings object carries the *name* of a variable and never a secret. Same for `web_search`: main reads the key and passes in just that one value, so it never travels through settings or the renderer. Knowledge-page authoring reads its key the same way, per call, so a key pasted mid-session is live at once. Full table in [models.md](models.md).

## Renderer hardening

Every Emma window is built by `secureWindow()` in [main.ts](../desktop/main/main.ts):

```ts
webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
```

**Navigation.** `will-navigate` is prevented for any URL that differs from the current one. `setWindowOpenHandler` returns `{ action: "deny" }` for everything. If the URL passes `externalUrl` it goes to `shell.openExternal` first, so an ordinary link opens in your browser instead of inside Emma.

**Electron permissions.** Both `setPermissionCheckHandler` and `setPermissionRequestHandler` run through one function:

```ts
function microphoneOnly(contents, permission, kinds) {
  return permission === "media" && kinds.length > 0 && kinds.every((kind) => kind === "audio") && ownWindow(contents);
}
```

Audio media, from one of Emma's own windows, is the only thing ever granted. Camera, geolocation, notifications, clipboard read, MIDI, USB, HID and everything else get denied.

**Content Security Policy**, from [index.html](../desktop/index.html):

```
default-src 'self';
script-src 'self' emma-artifact:;
style-src 'self' 'unsafe-inline';
font-src 'self' data:;
img-src 'self' data:;
connect-src 'self' emma-artifact: ws://127.0.0.1:* ws://localhost:*;
frame-src 'self' emma-artifact:;
object-src 'none';
base-uri 'none';
form-action 'none'
```

Look at `connect-src`: no remote origin in it. The renderer cannot open a socket to the internet. Every network call goes through main, which is exactly why every guard above can be enforced in one place. The only sockets the renderer can open are loopback WebSockets, for the dev server.

**Single instance.** `app.requestSingleInstanceLock()` runs before the app is ready. A second launch quits and raises the first window instead. One process, one lock on the data directory.

The architecture behind all of this is in [architecture.md](architecture.md).

## What never leaves this Mac

Checked in the code, not aspirational:

- **Recorded audio.** Both engines are forced local at two separate boundaries. See above.
- **Raw transcripts.** Cleanup is local-only or skipped.
- **Your API keys.** Encrypted at rest, mirrored only into the environment of Emma's own child processes, masked before the renderer sees them.
- **Computer-use screenshots.** Text-only tool results on this branch.
- **Annotated screen context.** Captured, then dropped before the turn.
- **Threads, knowledge, plans, traces, memories, artifacts, skills, tools.** Markdown and JSON under `~/Library/Application Support/Emma`, with the Markdown mirror at `~/Documents/Emma Knowledge`. `EMMA_DATA_DIR` and `EMMA_KNOWLEDGE_DIR` move them, and an empty `EMMA_KNOWLEDGE_DIR` turns the mirror off entirely.
- **Anything at all, until you send a turn.** The renderer's CSP has no remote `connect-src`, and the catalog fetch carries no credential and no query.

Nothing about your usage is reported anywhere. No telemetry endpoint, no analytics key, no crash reporter in this codebase.

**Start fresh** in **Settings → Data & privacy** deletes every thread, knowledge page, artifact, plan, connected folder, saved key and setting on this Mac, then restarts Emma empty. The Markdown mirror in your Documents folder stays where it is. It cannot be undone.

## Where the UI overstates the code

Listed here because a privacy doc that hides its own inaccuracies is worthless.

| Claim | Where | What the code does |
| --- | --- | --- |
| "Selected-model turns request no provider data collection and zero retention" | Settings → Data & privacy | Only when `requireZeroRetention` is on, which is off by default. Reads as unconditional. It is not. |
| "Emma answers with its deterministic local reply rather than quietly routing your turn to a different model" | Settings → Models, *Automatic fallback* | True of a knowledge page, which really is authored locally. Not true of a thread turn: a `fallback` key lands on the harness's `default_model` over the network. |
| "The image is attached to this message" | `computer` tool result | It is not. The `computer` tool returns text only. |

## See also

- [models.md](models.md) — providers, keys, the catalog, model selection
- [permissions.md](permissions.md) — the four modes and the gate table
- [computer-use.md](computer-use.md) — the pointer, the ceilings, the kill switch
- [voice.md](voice.md) — local dictation setup
- [architecture.md](architecture.md) — process boundaries and the IPC surface
- [tools.md](tools.md) — every tool and what it can reach
- [data.md](data.md) — what is on disk and where
- [knowledge.md](knowledge.md) — the Markdown mirror
- [development.md](development.md) — running Emma from source
