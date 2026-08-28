# Privacy

What leaves this Mac and what does not, subsystem by subsystem. Every row traces
to a file in this repo.

## Where data goes

| Subsystem | What data | Where it goes |
| --- | --- | --- |
| Thread turn | Your prompt, thread history, tool results, system prompt, tool schemas, attached images | `EMMA_PROVIDER_CHAT_URL`, default `https://openrouter.ai/api/v1/chat/completions` |
| Verifier (`auto` mode) | Thread title, what you asked, the pending call and its arguments | The verifier route in Settings → Models. OpenRouter by default |
| Advisor tool | The transcript so far, up to 60 000 characters | The advisor route. Off unless you set a model |
| Vision tool | One image as a data URL, plus the question | The vision route. OpenRouter by default |
| `secret` tool | The output of the command it was given, up to 32 000 characters | The secrets route in Settings → Models. Off until you pick one |
| Note tagger | A saved note's text, up to 6 000 characters | The tagger route. OpenRouter by default |
| Autoresearch judge | The eval command's output | The job's own proposer model |
| Model catalog | Nothing but the HTTP request — no credential, no query | `openrouter.ai` |
| `web_search` | Your query string, plus a result count on Brave, Tavily and Exa | Your configured provider. `4get.canine.tools` by default |
| `web_fetch`, page clipping | The URL you or the model named | That site |
| Dictation | Recorded audio | `127.0.0.1:8080`, or on-device macOS Speech.framework. Never off this Mac |
| Transcript cleanup | The raw transcript | `127.0.0.1:8081`. Never off this Mac |
| Computer use | Running-app metadata; approved app's accessibility text and action results | The turn's model as tool results; actions execute in the approved app |
| Annotated screen context | A compressed JPEG | Stays in Electron's main process |
| Notes you keep | Markdown and attachments | The vault folder **you** chose. Nowhere else |
| Threads, traces, jobs, plans, memories, artifacts | Markdown and JSON | `~/Library/Application Support/Emma` (`EMMA_DATA_DIR` moves it) |
| Provider keys | Your API keys | Keychain-encrypted on disk, plus the environment of Emma's own child processes |

No telemetry, no analytics and no crash reporter exist anywhere in Emma. Grep for
them — the only hits are `GenerationTelemetry` in
[thread.rs](../crates/core/src/thread.rs), which is a local token count on a
message, and never leaves the disk.

## The thread turn

This sends the most. [main.ts](../desktop/main/main.ts) catches the renderer's
`sendMessage` and runs the turn on `emma-cli`, the Zig harness in
[harness/](../harness) — Emma's fork of
[vercel-labs/fx](https://github.com/vercel-labs/fx). The harness makes the HTTP
call: [emma_openai.zig](../harness/src/gateway/emma_openai.zig) builds the body and
posts it to `EMMA_PROVIDER_CHAT_URL`. The bearer token is
`EMMA_PROVIDER_API_KEY`, set by [harness.ts](../desktop/main/harness.ts) from the
stored OpenRouter key.

The harness runs with `cwd` set to the thread's connected folder. A thread with no
folder gets a scratch directory under `<userData>/workspaces/<threadId>`, because
the alternative is an agent loose in your home directory.

## OpenRouter, honestly

**Prompt logging is an account-level opt-in that Emma cannot read or change.**
Switch it on at OpenRouter and OpenRouter and the providers behind it may keep
your prompts and Emma's replies, and train on them. Opting in is also what unlocks
parts of the free catalog — and free routes are Emma's default path: the fallback
chain, the verifier and the vision model are all free models. Your account setting
sits above anything Emma sends. Check it yourself:
<https://openrouter.ai/settings/privacy>

**Emma's own switch is off by default.** *Private routing* in **Settings →
Models** (`settings.requireZeroRetention`) demands no-training, zero-retention
endpoints and fails the turn rather than route around them. Turning it on sets
`EMMA_OPENROUTER_ZDR` in Electron's environment and recycles the idle harnesses,
because `emma-cli` reads the flag from its spawn environment.

With it set and the chat URL pointing at OpenRouter, `emma_openai.zig` appends
exactly this to the request body:

```json
"provider":{"data_collection":"deny","zdr":true}
```

`isOpenRouter()` is a substring check for `://openrouter.ai/`; point Emma anywhere
else and the keys are not sent, because they are OpenRouter's own vocabulary.

**What it does not cover.** The flag rides the harness request body only. Electron
main's own provider calls — verifier, vision, advisor, secrets, note tagger — post a plain
OpenAI-compatible body from [verifier.ts](../desktop/main/verifier.ts) with no
`provider` object on it. Nor does it touch your account settings. And no free
endpoint qualifies, so every free model fails while it is on — which is why it
ships off.

There is no privacy warning when you pick a free model. The catalog shows a
`Free`/`Paid` badge and a "Free only" filter; that is all. The free router chain
leaves out stealth and cloaked routes, whose vendor is unnamed and whose prompts
are logged for training — a hardcoded list, not a runtime check.

## Web search and fetching

[web-search.ts](../desktop/main/web-search.ts) sends your query to one of five back
ends, your choice in Settings → Tools.

| Provider | Endpoint | Credential |
| --- | --- | --- |
| 4get (default) | `https://4get.canine.tools` | none |
| SearXNG | `http://127.0.0.1:8888` | none |
| Brave | `https://api.search.brave.com` | `BRAVE_SEARCH_API_KEY` |
| Tavily | `https://api.tavily.com` | `TAVILY_API_KEY` |
| Exa | `https://api.exa.ai` | `EXA_API_KEY` |

Every request is `credentials: "omit"` with a 20-second timeout, so no cookie or
stored auth rides along. Results are cached in memory for 10 minutes, at most 64
entries. Search endpoints deliberately skip `publicUrl`, because the endpoint is
your own setting and a self-hosted SearXNG lives on `127.0.0.1` — exactly the
address a model-supplied URL must be refused.

Two URL validators in [ipc.ts](../desktop/main/ipc.ts): `externalUrl` for links
*you* clicked, and `publicUrl` for any URL the *model* supplied. `publicUrl` blocks
`localhost`, `.localhost`, `.local`, `.internal`, and `0.x`, `10.x`, `127.x`,
`169.254.x`, `172.16–31.x`, `192.168.x`, `100.64–127.x`, `255.x`, plus `::1`,
`::`, `fc/fd` and `fe8/fe9/fea/feb`. Your router, your Ollama and your dev server
stay off limits however the model asks.

[clip.ts](../desktop/main/clip.ts) fetches with `redirect: "manual"` and at most 5
hops, re-running the guard on **every hop**, so a public URL cannot bounce into
your LAN. `credentials: "omit"`, 20-second timeout, content type must match
`^\s*(text\/|application\/(xhtml|xml|json))`, body capped at
`MAX_FETCHED_PAGE_BYTES`. Fetched page text and search results reach the model
behind a line saying they are information, not instructions.

## Dictation

Every stage runs on this Mac, and main enforces that rather than trusting the
setting.

- **macOS Speech.framework** — [transcribe.m](../desktop/native/transcribe.m) sets
  `request.requiresOnDeviceRecognition = YES;`, Apple's switch for refusing
  server-side recognition.
- **A local `llama.cpp` server** — `http://127.0.0.1:8080/v1/audio/transcriptions`.
  Optional cleanup at `http://127.0.0.1:8081/v1/chat/completions`.

Checked at **two boundaries**. `validateSettings` refuses to *save* a non-local
transcription or cleanup endpoint, and [voice.ts](../desktop/main/voice.ts) resolves
every endpoint through `localEndpoint()` again *before use* — so a settings file
edited by hand still cannot redirect your voice. `localEndpoint()` accepts `http:`
or `https:` on `localhost`, `127.0.0.1` or `[::1]`, and nothing else. Cleanup that
cannot run returns the raw transcript rather than sending it elsewhere.

Audio never touches durable storage: a temp WAV under
`mkdtemp(tmpdir(), "emma-voice-")` at mode `0o600`, removed in a `finally`.
`MAX_UTTERANCE_BYTES` is 12 MiB. See [voice.md](voice.md).

## App text and images

**Computer use sends app text, not screenshots.** `list_apps` returns running-app
names, bundle IDs, PIDs and paths without reading window contents. Reading state
requires your explicit approval of that running app, even in Auto or Full access.
Its accessible window titles, labels and values then reach the turn's model as
ordinary tool results. Secure controls are omitted, but ordinary controls can
still contain private information. Typing and clicking can also send data through
the target app; app approval is not approval for every consequential action.
See [computer-use.md](computer-use.md).

The `computer` tool does not capture screens or use the clipboard. Its grants
exist only for the active parent turn; delegated harness agents cannot use them.
Stop, Escape, screen lock, suspend, turn end and quit revoke access. The app's menu
bar and its system commands are excluded. Other image paths are unchanged:

- **The `vision` tool** — the deliberate exception. It posts one image to the
  configured vision endpoint and hands back words. A `url` argument goes through
  `publicUrl`; a `path` argument must be inside a connected folder. Advertised to
  the model as `look_at_image`.
- **The yellow pen's annotated capture** — compressed into `ScreenContextStore`
  and put on `request.params.screenContext`, but `runOnHarness` reads only
  `skillContext` and `attachedImages` off `turn.params`. The frame is dropped
  before the turn goes out.

Images **you** attach to a message do go to the model — `attachedImages` becomes
image blocks on the turn ([harness.ts](../desktop/main/harness.ts)).

## Credentials

A key you paste is encrypted through Electron's `safeStorage` (macOS keychain),
base64-encoded, and written to `<userData>/credentials.json` — a `.tmp` file at
mode `0o600` in a directory created `0o700`, renamed into place
([credentials.ts](../desktop/main/credentials.ts)). If the keychain is
unavailable, `save()` throws rather than settle for something weaker.

`applyToEnv(process.env)` decrypts onto Electron's environment, which `emma-cli`
inherits. The Rust host inherits it too but reads no key: nothing in Rust makes a
network request. **The renderer never receives a key** — `list()` returns
`{ env, masked }`, and `maskSecret` gives six characters, ten bullets, and four.

Second models store the *name* of an environment variable, never a secret; main
reads `process.env[settings.credentialEnv]` per call. Same for `web_search`.

## Renderer hardening

Every window is built by `secureWindow()`: `nodeIntegration: false`,
`contextIsolation: true`, `sandbox: true`, `webSecurity: true`.

**Navigation.** `will-navigate` is prevented for any URL that differs from the
current one. `setWindowOpenHandler` denies everything; a URL that passes
`externalUrl` goes to `shell.openExternal`, so an ordinary link opens in your
browser instead of inside Emma.

**Electron permissions.** Both handlers run through `pageMayAsk`: the request must
come from one of Emma's own windows, and only `clipboard-sanitized-write` and
audio-only `media` are ever granted. Camera, geolocation, notifications, clipboard
*read*, MIDI, USB and HID are denied.

**CSP**, from [index.html](../desktop/index.html):

```
default-src 'self'; script-src 'self' emma-artifact:; style-src 'self' 'unsafe-inline';
font-src 'self' data:; img-src 'self' data:;
connect-src 'self' emma-artifact: ws://127.0.0.1:* ws://localhost:*;
frame-src 'self' emma-artifact: emma-visual:;
object-src 'none'; base-uri 'none'; form-action 'none'
```

`connect-src` has no remote origin: the renderer cannot open a socket to the
internet. Every network call goes through main, which is why every guard above can
be enforced in one place.

**Single instance.** `app.requestSingleInstanceLock()` runs before the app is
ready; a second launch quits and raises the first window.

## What never leaves this Mac

- **Recorded audio and raw transcripts.** Forced local at two boundaries.
- **Your API keys.** Encrypted at rest, mirrored only into Emma's own child
  processes, masked before the renderer sees them.
- **The annotated capture.** The yellow pen's frame stays in the main process.
  Computer use captures no images, but sends approved app text to the model.
  Images attached to messages or passed to `vision` do leave this Mac.
- **Your notes.** `keep` writes plain Markdown into the vault folder you chose and
  nowhere else. There is no second copy and no mirror. Nothing saves silently: a
  note is written only when you ask for one.
- **Threads, plans, traces, memories, artifacts, skills, tools.** Markdown and JSON
  under `~/Library/Application Support/Emma`, moved by `EMMA_DATA_DIR`.
- **Anything at all, until you send a turn.** The CSP has no remote `connect-src`,
  and the catalog fetch carries no credential and no query.

**Reset Emma**, in **Settings → Data & privacy**, deletes every thread, artifact,
plan, connected folder, saved key and setting on this Mac, then restarts Emma
empty. The notes in your vault are left where they are — they are your files, in
your folder. It cannot be undone.

## See also

- [permissions.md](permissions.md) — the four modes and the gate matrix
- [computer-use.md](computer-use.md) — app grants, data limits and the kill switch
- [tools.md](tools.md) — every tool and what it can reach
- [models.md](models.md) — providers, keys, the catalog, the second models
- [voice.md](voice.md) — local dictation setup
- [data.md](data.md) — what is on disk and where
- [architecture.md](architecture.md) — process boundaries and the IPC surface
