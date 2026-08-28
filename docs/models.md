# Models and providers

Emma talks to any OpenAI-compatible Chat Completions endpoint. Out of the box
that endpoint is [OpenRouter](https://openrouter.ai). Paste an OpenRouter key
into **Settings → Models**, pick a model from the catalog, and the composer's
picker switches models per thread. No account inside Emma, no config file.

Anything else that speaks the same shape — Z.AI, DeepSeek, a GPU host, LM Studio
on this Mac, llama.cpp on a box down the hall — is a **provider profile** you add
in the same place. A provider is `{ id, name, modelId, baseUrl, credentialEnv,
contextWindow, insecure }`, and the profile is the whole mechanism: there are no
per-vendor adapters, because there is nothing to adapt.

## What runs a turn

One process runs the agent loop: `emma-cli`, the Zig harness in
[harness/](../harness) — Emma's fork of
[vercel-labs/fx](https://github.com/vercel-labs/fx) (Apache-2.0). Electron owns
the UI, the tools and the permission answers; the Rust host is the store and is
not in the model path at all. `sendMessage` from the renderer becomes `driveTurn`
in [main.ts](../desktop/main/main.ts), which runs the turn over ACP; the finished
turn goes back to the host as `recordTurn`. A missing `emma-cli` binary is a
broken install, not a reason to fall back.

[emma_openai.zig](../harness/src/gateway/emma_openai.zig) and
[gateway.zig](../harness/src/builtins/gateway.zig) hold the wire defaults:

| Constant | Value |
| --- | --- |
| `default_chat_url` | `https://openrouter.ai/api/v1/chat/completions` |
| `chat_url_env` | `EMMA_PROVIDER_CHAT_URL` |
| `zero_retention_env` | `EMMA_OPENROUTER_ZDR` |
| `default_model` | `nvidia/nemotron-3-super-120b-a12b:free` |
| `default_model_catalog_base_url` | `https://openrouter.ai/api/v1` |
| `retry_count` | `3` |

The request body ends `,"stream":false}` — nothing is streamed at the HTTP layer;
tokens still arrive incrementally in the UI, over ACP.

## When a model goes quiet

A turn shows its life as it streams: deltas and tool calls. When neither has
arrived for a minute — three, if a tool call is still running — the transcript
draws a stall notice under whatever the turn had reached, counting the silence
up, with **Try another model** beside it. The button opens the composer's model
picker.

Picking a different model there swaps the turn rather than the next one:
[App.tsx](../desktop/src/App.tsx) pushes the new key to the thread's context,
stops the stalled run, and queues the same prompt behind it, so the turn carries
on with no `continue` typed. The re-sent turn opens with a `Model changed to …`
notice in the transcript, drawn like the context notices and kept with the turn's
blocks. The skill attachment is left off the retry: main claimed it on the first
send.

## Model keys

The picker deals in keys, not raw model ids ([settings.ts](../desktop/shared/settings.ts)):

| Key | Means | On the wire |
| --- | --- | --- |
| `openrouter:<id>` | A model from the OpenRouter catalog | that id |
| `router:<id>` | One of the router profiles | that router's whole chain, comma-separated |
| `provider:<profileId>` | A provider profile | that profile's `modelId`, to that profile's endpoint |
| `fallback` | The shipped default | nothing — see below |

`defaultSettings.selectedModel` is `"fallback"` and `favoriteModels` starts as
`["fallback"]`. `harnessModel()` sends a `model` config option for `openrouter:`,
`router:` and `provider:`; only `fallback` sends **nothing**, leaving the
harness on its own `default_model`.

A key saved as `local:<profileId>` is rewritten to `provider:<profileId>` by
`legacyModelKey` on the way through `validateSettings`, and a stored `localModels`
array becomes `providers` the same way, so a profile saved before this existed
keeps working and keeps its star. `free-router` is rewritten to `router:free` the
same way.

### How a provider profile routes the whole loop

`EMMA_PROVIDER_CHAT_URL` is read by `emma-cli` once, at spawn — so the route is a
property of the *process*, not of the turn. `harnessKey(cwd, nestedThreadId,
providerId)` therefore puts the provider id in the harness map key, and
`harnessClient` hands that harness `chatUrl` and the provider's own `apiKey` in
its spawn environment. One process per workspace per provider; a thread on
DeepSeek and a thread on OpenRouter run side by side, each against its own
endpoint. `MAX_HARNESSES` (4) still reaps the idle ones.

A profile with an empty `credentialEnv` is a server that wants no key, but
`emma-cli` refuses to start without `EMMA_PROVIDER_API_KEY`, so Emma sends the
literal `no-key` and the server ignores it.

`contextWindow` on the profile is sent as the harness's `context_window` config
option. Leave it 0 and Emma falls back to the OpenRouter catalog's number for
that id — which a local model is not in, so the harness silently caps its history
and turns off token-pressure compaction. Fill it in for anything off-catalog.

Main learns the table over `emma:set-providers`, which validates and then calls
`recycleHarnesses()`. Like the verifier and the free chain, it is renderer state
pushed into main: until the window has loaded once, `providers` is empty and a
`provider:` key resolves to nothing.

### Routers

A **router** is a named chain of models, best first. `routerChain()` expands
`router:<id>` into one comma-separated list, which the transport turns into
OpenRouter's `models` fallback array: the next link answers when the one above it
is rate-limited, down, or has retired.

`routers` on `UserSettings` holds 0 to `MAX_ROUTERS` (5) of them, each
`{ id, name, models }` with a name the user writes and 1 to `MAX_ROUTER_MODELS`
(24) unique model ids — a rank of the smartest models, or the same model at four
vendors, whatever the chain is for. `validateRouters` checks them on the way in
and again in the main process, which learns the table over the `setRouters`
request and holds none until the renderer sends one. A settings file written
before routers existed carries a `freeRouterModels` array, which becomes the
first router.

The shipped default is one router, `free`, named **Emma Free Router**, holding
`FREE_ROUTER_MODELS` — ten free ids:

```
nvidia/nemotron-3-ultra-550b-a55b:free      thinkingmachines/inkling-small:free
thinkingmachines/inkling:free               dots-studio/dots-3-note-preview:free
z-ai/glm-5.2:free                           poolside/laguna-xs-2.1:free
poolside/laguna-s-2.1:free                  cohere/north-mini-code:free
nvidia/nemotron-3-super-120b-a12b:free      nvidia/nemotron-3.5-lightning:free
```

Every chain is filtered against the catalog Emma actually has, so a retired id is
dropped rather than sent; an empty catalog means the list goes unfiltered, so a
first launch still routes. A router whose ids are all `:free` is badged **Free**.

**Settings → Models** lists the routers above the catalog: rename one in place,
the gear opens the chain (drag to reorder, ✕ to drop a link, the field below adds
any catalogued model), ✕ deletes the router, and **Add a router** makes the next
one, seeded with the free chain.

### Which link answered

The reply's own `model` field says which one did. `parseCompletion` keeps it as
`routed_model`, and the orchestrator pushes it up the ACP info channel as
`_meta.fx.routedModel` — `{ model, fellBack }`, where `fellBack` compares base
slugs, so `a/one:free` answering for `a/one` is the same model rather than a
fallback. Electron records that model on the turn instead of the router key, so
the transcript's footer names what actually ran, and the renderer draws a
`Fell back to …` notice in the turn, where the compaction notices go, each time
the answering model changes mid-turn.

## The OpenRouter catalog

[catalog.ts](../desktop/main/catalog.ts) fetches and caches the list in Electron,
never in the Rust host:

```
https://openrouter.ai/api/v1/models?supported_parameters=tools&sort=most-popular
```

**No key is needed to browse.** That listing endpoint is public and
`fetchOpenRouterCatalog` sends no credential, so you can read every model and
compare prices before you have an account. The key is only needed to run a turn.

**Only tool-capable models.** Emma advertises tools on every turn, so a model
without tool support fails the moment it is used: `supported_parameters=tools`
filters at the source and `supportsParameter` checks again on the way in.

**Every row is remote input**, so every field is validated. `MAX_CATALOG_MODELS`
is 2048. An id must match `/^[A-Za-z0-9\-_.:]+\/[A-Za-z0-9\-_.:]+$/` and be ≤ 128
chars; a name 1–256 chars with no control characters; a context length an integer
1–100,000,000; input modalities filtered to `image`, `file`, `audio`. A bad row is
dropped, not repaired.

**Free vs paid** is `isZeroPrice(pricing.prompt) && isZeroPrice(pricing.completion)`
— both sides must parse to exactly `0`. Prices are stored as micro-dollars per
million tokens (`Math.round(usdPerToken * 1e12)`) on `promptMicroUsdPerMtok` and
`completionMicroUsdPerMtok`. The renderer's own `isFreeModel` is a plain
`idOrKey.endsWith(":free")`.

**Thinking modes.** `reasoningEfforts` is filtered against a closed list, weakest
first: `none, minimal, low, medium, high, xhigh, max`. A model that advertises
`reasoning_effort` but publishes no list gets OpenRouter's own three stops
(`low, medium, high`). `reasoningMandatory` comes straight from the vendor.

### Cache, diff and seed

`CatalogCache` writes `<userData>/openrouter-catalog.json` with mode `0o600`. On
construction it loads the bundled seed, then replaces it with the on-disk cache
if there is one — a cache older than the seed still wins, because it is what this
user last saw. `refresh()` snapshots the current ids, runs the fetch, and returns
`added` and `removed` with the models, so a reload can say what changed; if the
fetch throws it returns the cached models with `stale: true` and the error. That
is why the models page paints offline. A cache that cannot be written is a slower
next launch, not a failed reload.

`listOpenRouterModels` passes `refresh()` a 24-hour `maxAgeMs`, so a cache fetched
today is served without touching the network, and one fetch is shared by every
caller in flight — the panes that list models all ask on mount. The **Reload
OpenRouter catalog** button sends `force`, which drops the age gate.

[catalog-seed.ts](../desktop/main/catalog-seed.ts) compiles **334** rows into the
app for a first launch with neither cache nor network. Regenerate with
`npm run seed:catalog`, which hits the same public endpoint and needs no
credential.

`contextLength(id)` and `reasoningEfforts(id)` exist because the harness knows
only a handful of model-id prefixes: Electron looks the real numbers up and sends
the window as the `context_window` config option, without which the harness
silently caps its history and disables token-pressure compaction. For the free
chain it is the **first** id's window that is sent (`model.split(",")[0]`).

## Credentials

**A credential setting names an environment variable. It never holds the key.**
[credentials.ts](../desktop/main/credentials.ts) is the whole mechanism.

1. You paste a key in **Settings → Models → provider keys**. It goes over IPC to main and no further.
2. `set(env, secret)` validates: the name against `isEnvName` (`/^[A-Za-z_][A-Za-z0-9_]{0,63}$/`), the secret 1–`MAX_SECRET_CHARS` (512) printable ASCII (`/^[!-~]+$/`).
3. `save()` encrypts each secret with Electron `safeStorage.encryptString` — the macOS keychain — and base64s it. If `isEncryptionAvailable()` is false it throws: *"This Mac's keychain is unavailable, so Emma will not store a key in plain text."*
4. The blob lands at `<userData>/credentials.json`, written to a `.tmp` with mode `0o600` in a directory created `0o700`, then renamed. `<userData>` is `~/Library/Application Support/Emma`.
5. `applyToEnv(process.env)` decrypts and mirrors the secrets onto Electron's own environment, clearing names it set on an earlier pass.
6. `Harness` spawns `emma-cli` with `{ ...process.env, HOME: <userData>/harness, AI_GATEWAY_API_KEY: key, EMMA_PROVIDER_API_KEY: key }`, where `key` is `process.env.OPENROUTER_API_KEY`.

The renderer never gets a value back: `list()` returns `{ env, masked }`, and
`maskSecret` shows the first 6 characters, ten bullets and the last 4 — or eight
bullets alone under 12 characters.

`emma-cli` reads the key from its spawn environment, so a new key takes effect on
a fresh process: `emma:save-credential` calls `recycleHarnesses()`, which closes
every idle harness and leaves a busy one alone. Electron main's own provider calls
read `process.env` per call and pick it up immediately.

The one shipped slot (`providerCredentials`):

| Field | Value |
| --- | --- |
| `providerId` | `openrouter` |
| `env` | `OPENROUTER_API_KEY` |
| `label` | `OpenRouter` |
| `detail` | `Free + tool-capable catalog` |
| `hint` | `sk-or-v1-…` |

Web search keys use the same store: `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`,
`EXA_API_KEY`.

## Environment variables

Read by `emma-cli`, the process that runs your turn:

| Variable | Effect |
| --- | --- |
| `EMMA_PROVIDER_API_KEY` | The bearer token. Without it: *"emma-cli has no provider credential. Set EMMA_PROVIDER_API_KEY."* ([credentials.zig](../harness/src/core/auth/credentials.zig)) |
| `AI_GATEWAY_API_KEY` | Set to the same value by [harness.ts](../desktop/main/harness.ts) |
| `EMMA_PROVIDER_CHAT_URL` | Chat Completions URL. Empty or unset means OpenRouter |
| `EMMA_OPENROUTER_ZDR` | Any non-empty value turns on zero-retention routing |
| `FX_MODEL` | Overrides the startup model ([app_lifecycle.zig](../harness/src/core/app/app_lifecycle.zig)) |
| `FX_GATEWAY_BASE_URL` | Overrides the gateway base URL (`https://openrouter.ai/api`); ignored unless it is loopback http |

Read by the Rust host: `EMMA_DATA_DIR` alone, which moves
`~/Library/Application Support/Emma`. [runtime.rs](../crates/host/src/runtime.rs)
resolves the data root, starts the store, and answers requests — it spawns no
child, holds no credential and makes no network request.

## Settings → Models

[App.tsx](../desktop/src/App.tsx) renders, in order: **ModelCatalog** (the full
list, a "Free only" filter persisted under `emma.freeModelsOnly.v1`, a `Free`/`Paid`
badge, a reload that names what was added and removed, `CATALOG_PAGE` 15 rows at
a time) · **ProviderSettings** · **VerifierPanel** · **AdvisorPanel** ·
**VisionPanel** · **SecretPanel** · **ProviderKeys** · **Private routing** · **Automatic fallback**
· **Local deterministic profile** · **Speech to text**.

**Provider profiles.** `PROVIDER_PRESETS` fills the form's chips — OpenRouter,
Z.AI, DeepSeek, LM Studio, Ollama, llama.cpp, Custom — with a base URL and a key
variable name; a chip is prefill and nothing more. **Test** hits
`GET <baseUrl>/models` and then posts one throwaway completion with a single tool
advertised, and reports two things: how many models the endpoint lists, and
whether the model you named actually came back with a `tool_calls` array. Emma
advertises tools on every turn, so a model that fails the second dot will fail on
its first real use; the listed ids also fill the Model ID field's datalist.

`providerEndpoint(value, insecure)` is what a base URL has to pass:

| URL | Allowed |
| --- | --- |
| `https://` anywhere | yes |
| `http://` on `localhost`, `127.0.0.1`, `[::1]`, `::1` | yes |
| `http://` on `10/8`, `172.16/12`, `192.168/16`, `100.64/10` or `*.local` | only with `insecure` |
| `http://` anywhere else | no |
| any URL carrying a username, password, query or fragment | no |

`insecure` is the checkbox that appears only when what you typed is plain http
off this Mac, and it says what it does: the prompts and the key cross your network
unencrypted. `providerReach()` sorts a saved URL into **On this Mac**, **Your
network** or **Over the internet** for the row's second line.

An id must match `/^[A-Za-z0-9_-]{1,64}$/`, a name ≤ 64 chars, a model id ≤ 128,
`credentialEnv` (optional) a valid variable name, `contextWindow` 0 to
100,000,000, and there are at most `MAX_PROVIDERS` (24) profiles.
`canRemoveProvider` refuses to delete the profile you have selected, and
`forgetProvider` drops a deleted profile from favorites too. `verifierFromKey`
turns `provider:<id>` into a route with `providerChatUrl()`.

**Favorites and the composer.** `MAX_FAVORITE_MODELS` is 6; favorites sort first
in the composer's picker, which is capped at `MODEL_MENU_LIMIT` 30 entries. Each
thread carries its own model — `threadModel(threadId)` supplies it per turn — and
the model is recorded per turn in `recordTurn` rather than read off the picker at
render time.

### Private routing

The switch writes `EMMA_OPENROUTER_ZDR=1` into Electron's environment and calls
`recycleHarnesses()`, so **it restarts the local agent**. With it on, and only for
an `openrouter.ai` chat URL, the harness appends
`"provider":{"data_collection":"deny","zdr":true}` to every request body.

It is **off by default**, and it belongs off unless you route to a paid or local
model: zero retention narrows routing to endpoints that offer it, and no free
OpenRouter endpoint does — every free model fails while it is on.

The flag rides the harness request body only: the verifier, vision and advisor
calls go out with no routing flags. And it sits *below* your OpenRouter account's
own prompt-logging setting, which Emma can neither read nor change — that opt-in
is what unlocks parts of the free catalog. Check it yourself at
[openrouter.ai/settings/privacy](https://openrouter.ai/settings/privacy). See
[privacy.md](privacy.md).

## The second models

Five subsystems run a separate small model on a separate route. All share the
`VerifierSettings` shape — `{ model, endpoint, credentialEnv, system }` — and all
go through one `chatCompletion` helper in
[verifier.ts](../desktop/main/verifier.ts), which posts
`{ model, messages, temperature: 0, max_tokens, stream: false }` with
`authorization: Bearer <key>` from `process.env[credentialEnv]`, and reads
`message.reasoning` when `content` comes back empty. An empty `credentialEnv`
means a local server that needs no key.

| Subsystem | File | Default model | Timeout | Max tokens |
| --- | --- | --- | --- | --- |
| Verifier | [verifier.ts](../desktop/main/verifier.ts) | `liquid/lfm-2.5-2.6b:free` | 20 s | 700 |
| Note tagger | [vault-tags.ts](../desktop/main/vault-tags.ts) | `liquid/lfm-2.5-2.6b:free` | 20 s | 256 |
| Vision | [vision.ts](../desktop/main/vision.ts) | `nvidia/nemotron-nano-12b-v2-vl:free` | 60 s | 1024 |
| Advisor | [advisor.ts](../desktop/main/advisor.ts) | `""` (off) | 120 s | 1024 |
| Secrets | [secret.ts](../desktop/main/secret.ts) | `""` (off) | 60 s | 1024 |

All five default to `OPENROUTER_CHAT_ENDPOINT` with
`credentialEnv: "OPENROUTER_API_KEY"`, so all five are remote out of the box and
all five can be pointed at a local profile instead. **The defaults that are set
are all free models** — the free router’s chain, the verifier and the note tagger,
and the vision model. The advisor and the secrets model ship with no model at
all.

**Verifier** — the second model in `auto` mode. `toolGate()` maps `auto` onto the
same column as `ask`; the question goes to the verifier instead of to you, and
anything it will not clear still asks. `MAX_ATTEMPTS` 3, detail clamped at
`MAX_DETAIL_CHARS` 2000, standing rules yours to edit up to
`MAX_VERIFIER_SYSTEM_CHARS`. An empty `model` leaves `auto` with no verifier, so
every call asks you. Cost: one extra completion per gated call.

**Advisor** — the `advisor` tool, the mirror image: a stronger model consulted
mid-turn with the transcript so far, clamped at `MAX_ADVISOR_TRANSCRIPT_CHARS`
(60,000). Off unless you set a model.

**Vision** — the `vision` tool, for a selected model that cannot see. It posts an
`image_url` data URL; it is the deliberate exception to screenshots staying in
Emma's process. See [privacy.md](privacy.md).

**Secrets** — the `secret` tool. The command runs in Electron, its output goes
to this model and nowhere else, and the thread's own model gets the answer only.
Clamped at `MAX_SECRET_OUTPUT` (32,000). Off until you pick a model, because the
whole point is that you choose which one your keys reach — a local profile keeps
them on this Mac. See [privacy.md](privacy.md).

**Note tagger** — titles and tags a note kept into your vault
(`MAX_TAG_TEXT_CHARS` 6000, at most `MAX_TAGS` tags). See
[knowledge.md](knowledge.md). It has no panel: `emma:set-tagger` exists on the
IPC surface but nothing in the renderer calls it, so its model is whatever
`defaultTagger` says.

## Token, rate and cost accounting

Two numbers exist per turn: a live estimate and the provider's real count.

**The estimate.** [usage.ts](../desktop/shared/usage.ts) and
[agent-loop.ts](../desktop/main/agent-loop.ts) both use `CHARS_PER_TOKEN = 4`; as
text streams in, `noteDelta` adds `Math.ceil(text.length / CHARS_PER_TOKEN)`.

**The real count.** `noteUsage` replaces both sides with what the harness
reported, each only when it is greater than zero:

```ts
if (usage.inputTokens > 0) run.inputTokens = usage.inputTokens;
if (usage.outputTokens > 0) run.outputTokens = usage.outputTokens;
```

Without the real input count the autoresearch token budget would only see the
output side and stop at roughly half the real spend.

`recordTurn` stores `inputTokens`, `outputTokens`, `durationMilliseconds` and
`model` per turn; a turn that failed before any usage arrived records `"0"` on
both sides. Cost in micro-dollars is
`estimateMicroDollars(tokens, rates) = Math.round((in * rates.input + out * rates.output) / 1_000_000)`,
where `modelRates` reads `promptMicroUsdPerMtok` and `completionMicroUsdPerMtok`
off the cached catalog ([research.ts](../desktop/main/research.ts)). The context
bar reads the rest of `usage.ts`: `MAX_USES` 32, `RATE_FLOOR` 4096. See
[context-bar.md](context-bar.md) and [autoresearch.md](autoresearch.md).

## Pointing Emma at a local server

LM Studio serves an OpenAI-compatible API on `http://127.0.0.1:1234/v1`; Ollama
does the same on `http://127.0.0.1:11434/v1`; llama.cpp's `llama-server` on
`http://127.0.0.1:8080/v1`. A machine on your own network is the same profile with
its address in place of the loopback one — bind the server to `0.0.0.0` rather
than localhost, and expect to tick the insecure box unless you put https in front
of it. Over Tailscale a `100.x` address counts as your network too.

**As a second model**, through the GUI: start the server, add a profile under
**Settings → Models → Providers**, leave Key env empty, and pick
that profile in the Verifier, Advisor or Vision panel. `verifierFromKey` builds
`http://127.0.0.1:1234/v1/chat/completions` and posts with no `authorization`
header. That traffic never leaves the Mac.

**As the main thread model**, add it as a provider and pick it — that is what the
provider profile is for. The environment variables below still work and still
override, which is what to reach for when you want the route decided before Emma
starts:

```sh
export EMMA_PROVIDER_CHAT_URL=http://127.0.0.1:1234/v1/chat/completions
export EMMA_PROVIDER_API_KEY=not-used-but-required
export FX_MODEL=qwen3-8b
open -a Emma
```

`EMMA_PROVIDER_API_KEY` must be non-empty or `emma-cli` refuses to run; LM Studio
ignores the value. Leave `EMMA_OPENROUTER_ZDR` unset — the flags are
OpenRouter-specific and `isOpenRouter()` will not match a loopback URL. The
catalog page still lists OpenRouter models, because Electron's catalog fetch is a
separate thing, and your local server has to support tool calls.

## When no provider is configured

`fallback` is the shipped default `selectedModel`, and `selectFallbackModel` does
one thing: it clears the selection. Nothing else follows from it. Emma sends no
`model` config option, and the harness answers on its own `default_model` —
`nvidia/nemotron-3-super-120b-a12b:free`, over the network, on the free
OpenRouter route. With no key at all the turn fails with the harness's missing
credential message.

**There is no local answer path on this branch.** The Settings copy that reads
*"Without a selected provider, Emma uses its deterministic local fallback"*, the
"Automatic fallback" panel, and the picker row *"Deterministic local fallback ·
On this Mac"* all describe a mechanism that no longer exists in `desktop/main`.

## Dictation models

Two, both local, both covered in [voice.md](voice.md). Defaults from
[voice.ts](../desktop/shared/voice.ts): speech to text
`ggml-org/Qwen3-ASR-0.6B-GGUF` on `http://127.0.0.1:8080/v1/audio/transcriptions`,
cleanup `superwhisper/s1-mini-GGUF` on `http://127.0.0.1:8081/v1/chat/completions`,
both under `llama.cpp`. The alternative engine is macOS Speech.framework with
`requiresOnDeviceRecognition = YES`. A non-local endpoint is refused when saved
and refused again before use.

## See also

- [harness.md](harness.md) — `emma-cli` in detail
- [privacy.md](privacy.md) — what leaves this Mac
- [permissions.md](permissions.md) — the four modes the verifier plugs into
- [tools.md](tools.md) — the tools Emma advertises every turn
- [voice.md](voice.md) — the two dictation models
- [autoresearch.md](autoresearch.md) — budgets and the judge
- [data.md](data.md) — what lives in `<userData>`
- [troubleshooting.md](troubleshooting.md) — when a model will not answer
