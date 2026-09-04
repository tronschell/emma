# Privacy

What leaves this computer and what does not, subsystem by subsystem. Every row traces
to a file in this repo.

## Where data goes

| Subsystem | What data | Where it goes |
| --- | --- | --- |
| Thread turn | Your prompt, thread history, tool results, system prompt, tool schemas, attached images | The selected provider's chat endpoint; OpenRouter by default |
| Verifier (`auto` mode) | Thread title, what you asked, the pending call and its arguments | The verifier route in Settings → Models. OpenRouter by default |
| Advisor tool | The transcript so far, up to 60 000 characters | The advisor route. Off unless you set a model |
| Vision tool | One image as a data URL, plus the question | The vision route. OpenRouter by default |
| `secret` tool | The output of the command it was given, up to 32 000 characters | The secrets route in Settings → Models. Off until you pick one |
| Note tagger | A saved note's text, up to 6 000 characters | The tagger route. OpenRouter by default |
| Commit-message suggestion | File names and up to 12 000 characters of the diff | The tagger route, when you request a suggested commit message |
| Model catalog | Nothing but the HTTP request — no credential, no query | `openrouter.ai` |
| App updates | Repository name, platform, architecture and installed version in the feed URL; ordinary request metadata | `update.electronjs.org` for the public macOS feed, then GitHub release assets; at packaged-app launch and every six hours. Windows publication is pending release-workflow authorization |
| `web_search` | Your query string, plus a result count on Brave, Tavily and Exa | Your configured provider. `4get.canine.tools` by default |
| `web_fetch`, page clipping | The URL you or the model named | That site |
| Dictation | Recorded audio | `127.0.0.1:8080`, or the on-device macOS Speech.framework / Windows SAPI recognizer. Never off this computer |
| Transcript cleanup | The raw transcript | `127.0.0.1:8081`. Never off this computer |
| Computer use | Running-app metadata; approved app's accessibility text and action results | The turn's model as tool results; actions execute in the approved app |
| Annotated screen context | A compressed JPEG | Stays in Electron's main process |
| Notes you keep | Markdown and attachments | Written into the vault folder **you** chose; the note tagger may also send text to its configured model |
| Threads and jobs | Markdown | The Rust data root, moved by `EMMA_DATA_DIR` |
| Traces, task lists, plans, memories, artifacts and settings | Markdown and JSON | Electron's `userData` directory; see [data.md](data.md) for the separate roots |
| Component `fetch` | The widget's request, with approved `{{NAME}}` placeholders filled in from saved variables | The fixed public HTTPS destination shown in the credential-request approval; keyless widgets can fetch without credential approval |
| Provider keys | Your API keys | OS-secure-storage-encrypted on disk, child-process environments, and the configured service as authentication |
| Browser, MCP servers and coding CLIs | Pages, prompts, tool arguments and credentials used by those integrations | Their configured services; they are not covered by Private routing |

Emma does not configure an analytics service or a crash-report uploader. It does
record local usage and execution traces. Model providers, update servers and
other services still receive the requests listed above and their network metadata.

## The thread turn

This sends the most. [main.ts](../desktop/main/main.ts) catches the renderer's
`sendMessage` and runs the turn on `emma-cli`, the Zig harness in
[harness/](../harness) — Emma's fork of
[vercel-labs/fx](https://github.com/vercel-labs/fx). The harness makes the HTTP
call: [emma_openai.zig](../harness/src/gateway/emma_openai.zig) builds the body and
posts it to `EMMA_PROVIDER_CHAT_URL`. The bearer token is
`EMMA_PROVIDER_API_KEY`, set by [harness.ts](../desktop/main/harness.ts) from the
selected provider's credential, or the stored OpenRouter key for that route. A
`codex:` model points that URL at a loopback relay in Emma's main process, which
forwards the same turn to `https://chatgpt.com/backend-api/codex/responses`
under your `codex login` token — see [models.md](models.md).

The harness runs with `cwd` set to the thread's connected folder. A thread with no
folder gets a scratch directory under `<userData>/workspaces/<threadId>`, because
the alternative is an agent loose in your home directory.

## OpenRouter, honestly

**Emma cannot read or change your provider account's logging settings.**
OpenRouter documents separate opt-ins for private input/output logging and use
of prompts to improve its product. Review its
[data-collection policy](https://openrouter.ai/docs/guides/privacy/data-collection)
and your [account settings](https://openrouter.ai/settings/privacy). A model being
free or paid is not a privacy guarantee.

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
`provider` object on it. Nor does it touch your account settings, web tools,
widgets, browsers or external CLIs. A selected model without a qualifying
endpoint fails. Endpoint eligibility changes; see
[OpenRouter's ZDR contract](https://openrouter.ai/docs/guides/features/zdr).

There is no privacy warning when you pick a free model. The catalog shows a
`Free`/`Paid` badge and a "Free only" filter; that is all. The free router chain
leaves out stealth and cloaked routes, whose vendor is unnamed and whose prompts
are logged for training — a hardcoded list, not a runtime privacy check.

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

Two URL validators in [ipc.ts](../desktop/main/ipc.ts): `externalUrl` accepts
HTTP(S) links, while `publicUrl` rejects local hostnames and non-public literal
addresses. The URL guard alone does not resolve DNS and is not a network sandbox
for shell commands, browsers, MCP servers or user-configured endpoints.

[clip.ts](../desktop/main/clip.ts) fetches over `net.request` with
`redirect: "manual"` and at most 5 hops, re-running `publicUrl` on the first URL
and again on **every hop** before the redirect is followed — a page that
redirects to `127.0.0.1` is refused, not fetched. Clipped page images go through
the same guard. `credentials: "omit"`,
20-second timeout, content type must match
`^\s*(text\/|application\/(xhtml|xml|json))`, body capped at
`MAX_FETCHED_PAGE_BYTES`. Fetched page text and search results reach the model
behind a line saying they are information, not instructions.

## Dictation

Every stage runs on this computer, and main enforces that rather than trusting the
setting.

- **Built-in speech** — macOS uses Speech.framework with
  `request.requiresOnDeviceRecognition = YES;`; Windows uses its local SAPI
  recognizer through [transcribe_win.cpp](../desktop/native/transcribe_win.cpp).
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
  `publicUrl`; a `path` argument is a file in a connected folder, or an
  attachment the user picked in the native dialog. Absolute paths are folded
  back against the granted root and refused when they land outside it, so the
  tool reaches nothing the rest of the app would not. Advertised to the model
  as `look_at_image`.
- **The yellow pen's annotated capture** — compressed into `ScreenContextStore`
  and put on `request.params.screenContext`, but `runOnHarness` reads only
  `skillContext` and `attachedImages` off `turn.params`. The frame is dropped
  before the turn goes out.

Images **you** attach to a message do go to the model — `attachedImages` becomes
image blocks on the turn ([harness.ts](../desktop/main/harness.ts)).

## Credentials

A key you paste is encrypted through Electron's `safeStorage` (the operating
system's secure credential store),
base64-encoded, and written to `<userData>/credentials.json` — a `.tmp` file at
mode `0o600` in a directory created `0o700`, renamed into place
([credentials.ts](../desktop/main/credentials.ts)). If secure storage is
unavailable, `save()` throws rather than settle for something weaker.

`applyToEnv(process.env)` decrypts onto Electron's environment, which `emma-cli`
inherits. The Rust host inherits it too but reads no key: nothing in Rust makes a
network request. The credential-list API returns masks, not full keys:
`{ env, masked }`. `maskSecret` shows the first six and last four characters of a
long key. Keys are sent to their configured services as authentication; they do
not remain exclusively on this computer.

Second models store the *name* of an environment variable, never a secret; main
reads `process.env[settings.credentialEnv]` per call. Same for `web_search`.

A component stores names too. Main substitutes `{{NAME}}` in approved request
headers or bodies, never URLs. A native dialog authorizes the exact request
template for the current app session. Widgets share the app's renderer and
bridge; they are not isolated from each other. Approval authorizes sending the
named credentials to that destination, and a server may echo sensitive data in
its response. Review the destination and template before allowing it. See
[components.md](components.md).

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
default-src 'self'; script-src 'self' emma-artifact: emma-component:;
style-src 'self' 'unsafe-inline'; font-src 'self' data:;
img-src 'self' data: emma-component:;
connect-src 'self' emma-artifact: emma-component: ws://127.0.0.1:* ws://localhost:*;
frame-src 'self' emma-artifact: emma-visual:;
object-src 'none'; base-uri 'none'; form-action 'none'
```

`connect-src` has no remote origin: the renderer cannot open a socket to the
internet. Every network call goes through main, which is why every guard above can
be enforced in one place.

**Single instance.** `app.requestSingleInstanceLock()` runs before the app is
ready; a second launch quits and raises the first window.

## Local storage is not an offline guarantee

- **Recorded audio.** Transcription and cleanup are forced local at two
  boundaries. The resulting words reach the selected model when you send them.
- **The annotated capture.** The yellow pen's frame stays in the main process.
  Computer use captures no images, but sends approved app text to the model.
  Images attached to messages or passed to `vision` do leave this computer.
- **Your notes.** `keep` writes plain Markdown into the vault folder you chose and
  makes no mirror. The note tagger, an explicit tool call, your sync provider or
  backups can still send their contents elsewhere.
- **Threads, plans, traces, memories, artifacts, skills, tools.** Markdown and JSON
  under the [data roots](data.md). Relevant history and tool results are included
  in model requests.

Choosing a local thread model changes that route, not all network activity.
Secondary models, the catalog, update checks, widgets and enabled integrations
have separate routes. Review those before treating a setup as offline.

**Reset Emma**, in **Settings → Data & privacy**, deletes every thread, artifact,
plan, connected folder, saved key and setting on this computer, then restarts Emma
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
