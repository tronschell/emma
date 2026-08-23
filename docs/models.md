# Models and providers

How Emma picks a model, where the key comes from, and what happens on the wire. Everything here is what the code on the `fx-migration` branch does today.

## The short version

Emma talks to any OpenAI-compatible Chat Completions endpoint. Out of the box that endpoint is OpenRouter. You paste an OpenRouter key into **Settings → Models**, Emma encrypts it with the macOS keychain, and hands it to the agent process through its spawn environment. You pick a model from the catalog Emma fetches from OpenRouter's public listing. The picker in the composer switches models per thread.

Nothing else is required. No account inside Emma, no config file.

## What actually runs a turn

One process runs the agent loop: `emma-cli`, the Zig harness in [harness/](../harness). Electron owns the UI, the tools, the permission answers and the durable Markdown store; the harness owns the loop and the HTTP call to the provider.

The renderer sends `sendMessage` over IPC. [main.ts](../desktop/main/main.ts) intercepts it before it reaches the Rust host and turns it into `driveTurn`, which runs the turn on the harness over ACP:

```ts
const result = request.method === "sendMessage"
  ? await driveTurn({ threadId, content, mode: threadMode(threadId), title: "This thread", model: threadModel(threadId), params: { ...await skillParams(content), ...extra } })
  : await host!.request(request);
```

When the turn finishes, Electron writes it back with a `recordTurn` call to the Rust host. The host is the store — threads, knowledge, scheduled jobs, autoresearch jobs, traces. It is not in the model path.

If the `emma-cli` binary is missing, Emma refuses to start a turn. [main.ts](../desktop/main/main.ts) calls that a broken install, not a fallback condition.

### The transport

[harness/src/gateway/emma_openai.zig](../harness/src/gateway/emma_openai.zig) builds the request body:

| Constant | Value |
| --- | --- |
| `default_chat_url` | `https://openrouter.ai/api/v1/chat/completions` |
| `chat_url_env` | `EMMA_PROVIDER_CHAT_URL` |
| `zero_retention_env` | `EMMA_OPENROUTER_ZDR` |

[harness/src/builtins/gateway.zig](../harness/src/builtins/gateway.zig) holds the defaults around it:

| Constant | Value |
| --- | --- |
| `default_model` | `nvidia/nemotron-3-super-120b-a12b:free` |
| `default_model_catalog_base_url` | `https://openrouter.ai/api/v1` |
| `models_path` | `/models` |
| `retry_count` | `3` |

Requests are not streamed at the HTTP layer — the body ends `,"stream":false}`. Tokens still arrive in the UI incrementally, over ACP.

## Model keys

Emma's picker deals in keys, not raw model IDs. Three shapes, all defined in [settings.ts](../desktop/shared/settings.ts):

| Key | Means |
| --- | --- |
| `openrouter:<id>` | A model from the OpenRouter catalog |
| `local:<profileId>` | A local endpoint profile you added |
| `fallback` | The deterministic local profile |
| `free-router` | Emma's free router chain (`FREE_ROUTER_KEY`) |

`defaultSettings.selectedModel` is `"fallback"` and `favoriteModels` starts as `["fallback"]`.

`harnessModel()` in [main.ts](../desktop/main/main.ts) turns a key into what goes on the wire:

```ts
function harnessModel(key: string | undefined) {
  if (key === FREE_ROUTER_KEY) return freeRouterChain(modelCatalog?.ids());
  return key?.startsWith("openrouter:") ? key.slice("openrouter:".length) : undefined;
}
```

`undefined` means Emma sends no `model` config option at all, and the harness stays on its own `default_model`. That is what `fallback` and `local:` keys do today: **selecting a local profile as your main thread model does not route the turn at your local server.** The code says so outright — the harness's gateway is Emma's provider endpoint, not a loopback server. Local profiles do work for the second models (verifier, tagger, advisor, vision). To point the main loop at a local server, use the environment variables below.

### The free router

`free-router` is not a model. `freeRouterChain()` expands it into one comma-separated list, best first, which the transport turns into OpenRouter's `models` fallback array. `FREE_ROUTER_MODELS` in [settings.ts](../desktop/shared/settings.ts) is checked on 2026-08-22 and holds ten IDs:

```
nvidia/nemotron-3-ultra-550b-a55b:free
thinkingmachines/inkling:free
z-ai/glm-5.2:free
poolside/laguna-s-2.1:free
nvidia/nemotron-3-super-120b-a12b:free
thinkingmachines/inkling-small:free
dots-studio/dots-3-note-preview:free
poolside/laguna-xs-2.1:free
cohere/north-mini-code:free
nvidia/nemotron-3.5-lightning:free
```

The chain is filtered against the catalog Emma actually has, so a retired ID is dropped rather than sent. An empty catalog means the list goes unfiltered — a first launch that has never fetched still routes.

What was deliberately left out: models under a 256K window, vision-only and perception sub-agent models, LiquidAI's 2.6B, and stealth/cloaked routes whose vendor is unnamed and whose prompts are logged for training.

The UI calls this **Emma Free Router**. One known gap: `recordTurn` stores the chain, not the link that answered. OpenRouter names the serving model in its response; the harness does not pass it back.

## The OpenRouter catalog

[catalog.ts](../desktop/main/catalog.ts) fetches and caches the model list. Electron does this, not the sidecar.

```
https://openrouter.ai/api/v1/models?supported_parameters=tools&sort=most-popular
```

**Why no key is needed to browse.** That listing endpoint is public. `fetchOpenRouterCatalog` sends no credential. You can open the models page, read every model, compare prices and pick one before you have an account. The key is only needed to run a turn.

**Why only tool-capable models.** Emma advertises tools on every turn. A model without tool support fails the moment it is used, so `supported_parameters=tools` filters it out at the source and `supportsParameter(row.supported_parameters, "tools")` checks again on the way in.

**Validation.** Every row is remote input, so every field is checked. `MAX_CATALOG_MODELS` is `2048`. An ID must match `/^[A-Za-z0-9\-_.:]+\/[A-Za-z0-9\-_.:]+$/` and be at most 128 chars; a name must be 1–256 chars with no control characters; a context length must be an integer from 1 to 100,000,000; input modalities are filtered to `image`, `file`, `audio`. A bad row is dropped, not allowed into the picker.

**Free vs paid.** `free` is `isZeroPrice(pricing.prompt) && isZeroPrice(pricing.completion)` — both sides must parse to exactly `0`. Prices are stored as micro-dollars per million tokens: `Math.round(usdPerToken * 1e12)`, on `promptMicroUsdPerMtok` and `completionMicroUsdPerMtok`. The picker renders this as a `Free` or `Paid` badge, and `isFreeModel` in the renderer is a plain `idOrKey.endsWith(":free")`.

**Thinking modes.** `reasoningEfforts` is filtered against the closed vocabulary `["none", "minimal", "low", "medium", "high", "xhigh", "max"]`, weakest first. A model that advertises `reasoning_effort` but publishes no list gets OpenRouter's own three stops, `["low", "medium", "high"]`, so the knob works with the vendor default behind it. `reasoningMandatory` comes straight from the vendor.

### The cache and the diff

`CatalogCache` writes `<userData>/openrouter-catalog.json` with mode `0o600`. On construction it loads the bundled seed, then replaces it with the on-disk cache if there is one — a cache older than the seed still wins, because it is what this user last saw.

`refresh()` snapshots the current IDs, runs the fetch, and returns `added` and `removed` alongside the models, so reloading the page can say what actually changed. If the fetch throws, it returns the cached models with `stale: true` and the error message. The models page paints offline.

A cache that cannot be written is a slower next launch, not a failed reload — the write is wrapped in a `try` that swallows.

`contextLength(id)` exists because the harness only recognises a few model-ID prefixes and treats every other window as unknown, which silently caps its history and disables token-pressure compaction. Electron looks the real number up and sends it as the `context_window` config option.

### The bundled seed

[catalog-seed.ts](../desktop/main/catalog-seed.ts) holds 332 model rows compiled into the app, for a first launch with neither a cache nor a network. Regenerate it with:

```sh
npm run seed:catalog
```

[seed-catalog.mjs](../desktop/scripts/seed-catalog.mjs) hits the same public endpoint and writes `../main/catalog-seed.ts`. It notes in its own comments that the listing is public, so this needs no credential.

## Credentials

The rule: **a setting names an environment variable. It never holds the key.**

[credentials.ts](../desktop/main/credentials.ts) is the whole mechanism.

1. You paste a key in **Settings → Models → provider keys**. It goes over IPC to main and no further.
2. `CredentialStore.set(env, secret)` validates it: the variable name must match `isEnvName` (`/^[A-Za-z_][A-Za-z0-9_]{0,63}$/`), the secret must be 1 to `MAX_SECRET_CHARS` (512) printable ASCII characters (`printableSecret`, `/^[!-~]+$/`).
3. `save()` encrypts each secret with Electron's `safeStorage.encryptString`, which uses the macOS keychain, and base64-encodes the result. If `safeStorage.isEncryptionAvailable()` is false it throws: *"This Mac's keychain is unavailable, so Emma will not store a key in plain text."*
4. The blob lands at `<userData>/credentials.json`, written to a `.tmp` file with mode `0o600` inside a directory created `0o700`, then renamed into place. On macOS `<userData>` is `~/Library/Application Support/Emma`.
5. `applyToEnv(process.env)` decrypts and mirrors the secrets onto Electron's own environment.
6. `startHost()` spawns the Rust host and its Zig sidecar with that environment, and they inherit it.
7. `Harness` spawns `emma-cli` with `{ ...process.env, HOME: this.deps.home, AI_GATEWAY_API_KEY: apiKey, EMMA_PROVIDER_API_KEY: apiKey }`, where `apiKey` is `process.env.OPENROUTER_API_KEY`.

The renderer never gets a value back. `list()` returns `{ env, masked }`, and `maskSecret` shows the first 6 characters, ten bullets, and the last 4 — or eight bullets alone for anything under 12 characters.

Because both children read the key from their spawn environment, a key you just pasted only takes effect on a fresh process. `emma:save-credential` restarts the host and closes idle harnesses for exactly that reason.

The one provider Emma ships a slot for, from `providerCredentials`:

| Field | Value |
| --- | --- |
| `providerId` | `openrouter` |
| `env` | `OPENROUTER_API_KEY` |
| `label` | `OpenRouter` |
| `detail` | `Free + tool-capable catalog` |
| `hint` | `sk-or-v1-…` |

Web search keys use the same store: `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`.

## Environment variables

Emma has two provider seams, read by two different processes. This trips people up, so here they are separately.

### Read by `emma-cli` — the process that runs your turn

| Variable | Effect |
| --- | --- |
| `EMMA_PROVIDER_API_KEY` | The bearer token. Without it: *"emma-cli has no provider credential. Set EMMA_PROVIDER_API_KEY."* ([credentials.zig](../harness/src/core/auth/credentials.zig)) |
| `AI_GATEWAY_API_KEY` | Set to the same value by [harness.ts](../desktop/main/harness.ts) |
| `EMMA_PROVIDER_CHAT_URL` | Chat Completions URL. Empty or unset means `https://openrouter.ai/api/v1/chat/completions` |
| `EMMA_OPENROUTER_ZDR` | Any value turns on zero-retention routing |
| `FX_MODEL` | Overrides the startup model ([app_lifecycle.zig](../harness/src/core/app/app_lifecycle.zig)) |
| `FX_GATEWAY_BASE_URL` | Overrides the model catalog base URL |

### Read by the Rust host — the store, and its Zig sidecar

[runtime.rs](../crates/host/src/runtime.rs):

| Variable | Effect |
| --- | --- |
| `EMMA_PROVIDER_BASE_URL` | Provider base URL |
| `EMMA_PROVIDER_MODEL` | Model ID |
| `EMMA_PROVIDER_CREDENTIAL_ENV` | The **name** of the variable holding the key |
| `EMMA_OPENROUTER_ZDR` | Zero-retention routing |
| `EMMA_DATA_DIR` | Overrides `~/Library/Application Support/Emma` |
| `EMMA_KNOWLEDGE_DIR` | Overrides `~/Documents/Emma Knowledge`; empty turns the mirror off |

The first three are all-or-nothing. All unset is fine — that is the no-provider case. Any partial combination is an error: *"set all of EMMA_PROVIDER_BASE_URL, EMMA_PROVIDER_MODEL, and EMMA_PROVIDER_CREDENTIAL_ENV"*.

Note the indirection on `EMMA_PROVIDER_CREDENTIAL_ENV`. It holds a variable name, not a secret:

```sh
export EMMA_PROVIDER_CREDENTIAL_ENV=OPENROUTER_API_KEY
export OPENROUTER_API_KEY=sk-or-v1-...
```

The sidecar reads the name, then reads that variable. A key never lives in a setting, a config file, or a log line.

`provider_config_from_values` also derives two flags: `protect_data` is true when the base URL is an OpenRouter host, and `zero_retention` is true when `EMMA_OPENROUTER_ZDR` is set at all.

## Settings → Models

[App.tsx](../desktop/src/App.tsx) renders, in order:

- **ModelCatalog** — the full OpenRouter list, with a "Free only" filter (`FREE_ONLY_KEY`, persisted under `emma.freeModelsOnly.v1`), a `Free`/`Paid` badge per row, and a reload that shows what was added and removed. `CATALOG_PAGE` is 15 rows at a time.
- **LocalModelSettings** — local endpoint profiles. A profile is `{ id, name, modelId, baseUrl, credentialEnv }`. The default suggestion is `http://127.0.0.1:1234/v1`.
- **VerifierPanel**, **TaggerPanel**, **AdvisorPanel**, **VisionPanel** — the four second models.
- **ProviderKeys** — the credential slots above.
- **Private routing** — the zero-retention checkbox. Details in [privacy.md](privacy.md).
- **Automatic fallback**, **Local deterministic profile**, **Speech to text** — status panels.

### Local endpoint profiles

`localModelEndpoint()` in [settings.ts](../desktop/shared/settings.ts) is strict about what counts as local:

- `http:` only — not `https:`
- hostname must be `localhost`, `127.0.0.1`, `[::1]` or `::1`
- no username, no password, no query string, no fragment

A profile's ID must match `/^[A-Za-z0-9_-]{1,64}$/`, its name must be non-empty and at most 64 characters, its model ID non-empty and at most 128, and its `credentialEnv` (if given) a valid variable name. `canRemoveLocalModel` refuses to delete the profile you currently have selected.

`verifierFromKey` turns a `local:<id>` key into a route by appending `/chat/completions` to the profile's base URL.

### Favorites

`MAX_FAVORITE_MODELS` is 6. Favorites are what the composer's picker shows first. `forgetLocalModel` drops a deleted profile from favorites at the same time it drops the profile.

## The picker in the composer

Each thread carries its own model. `threadModel(threadId)` supplies it per turn, and the picker changes it for that thread only. `MODEL_MENU_LIMIT` caps the composer menu at 30 entries.

Because a thread can be half-answered by one model and half by another, the model is recorded per turn in `recordTurn` rather than read off the picker at render time.

## The second models

Four subsystems run a separate small model on a separate route. They all share the `VerifierSettings` shape — `{ model, endpoint, credentialEnv, system }` — and all go through one `chatCompletion` helper in [verifier.ts](../desktop/main/verifier.ts).

That helper posts `{ model, messages, temperature: 0, max_tokens, stream: false }` with an `authorization: Bearer <key>` header, and falls back to `message.reasoning` when `content` comes back empty. The key comes from `process.env[settings.credentialEnv]`, which the credential store already mirrored in. An empty `credentialEnv` means a local server that needs no key.

| Subsystem | File | Default model | Timeout | Max tokens |
| --- | --- | --- | --- | --- |
| Verifier | [verifier.ts](../desktop/main/verifier.ts) | `liquid/lfm-2.5-2.6b:free` | 20 s | 700 |
| Tagger | [tagger.ts](../desktop/main/tagger.ts) | `liquid/lfm-2.5-2.6b:free` | 20 s | 32 |
| Vision | [vision.ts](../desktop/main/vision.ts) | `nvidia/nemotron-nano-12b-v2-vl:free` | 60 s | 1024 |
| Advisor | [advisor.ts](../desktop/main/advisor.ts) | `""` (off) | 120 s | 1024 |

All three configured defaults point at `OPENROUTER_CHAT_ENDPOINT` (`https://openrouter.ai/api/v1/chat/completions`) with `credentialEnv: "OPENROUTER_API_KEY"`. All are remote by default; all can be pointed at a local profile.

**Verifier.** The second model in `auto` mode. It reads what you asked for and the call the agent wants to make, and answers whether that call is safe. `MAX_ATTEMPTS` is 3, detail is capped at `MAX_DETAIL_CHARS` (2000). Its standing rules are editable — what counts as destructive is your call — up to `MAX_VERIFIER_SYSTEM_CHARS` (8192).

It is deliberately not the selected model. The point is a reviewer that is not the thing being reviewed, small and cheap enough to sit in front of every gated call. `toolGate()` in [permissions.ts](../desktop/shared/permissions.ts) maps `auto` onto the same column as `ask` — the question just goes to the verifier instead of to you. An empty `model` leaves `auto` with no verifier, so every call asks.

Cost: one extra completion per gated tool call, capped at 700 output tokens, on a free model by default.

**Advisor.** The `advisor` tool. The mirror image of the verifier: a stronger model the agent consults mid-turn, handed the transcript so far (capped at `MAX_ADVISOR_TRANSCRIPT_CHARS`, 60,000). Off unless you set a model.

**Vision.** The `vision` tool, for a selected model that cannot see. It sends an `image_url` data URL. Text-only models are most of the catalog and half the free half of it, and without this a screenshot on disk is a path the agent can only guess about. Image URLs from the model go through `publicUrl`, not `externalUrl` — see [privacy.md](privacy.md).

**Tagger.** Files a thread under one of your own tags. `MAX_TAGGER_TEXT_CHARS` is 4000 and `MAX_THREAD_TAGS` is 32. `pickTag` matches the longest tag in the reply; `none` means the model declined. Stateless — the route arrives with each request rather than being held in main.

## The autoresearch judge

[research.ts](../desktop/main/research.ts) runs the judge on its own thread in `mode: "plan"` with `model: job.proposerModel` — the same model the job is proposing with, not a separate one. Its output is sliced to 32 KB.

Cost is tracked in micro-dollars:

```ts
estimateMicroDollars(tokens, rates) = Math.round((in * rates.input + out * rates.output) / 1_000_000)
dollars(micro) = `${(micro / 1_000_000).toFixed(2)}`
```

`modelRates(catalogFile, modelId)` reads `promptMicroUsdPerMtok` and `completionMicroUsdPerMtok` from the cached catalog on disk. [research.rs](../crates/core/src/research.rs) holds the ceilings: `max_seconds`, `max_tokens`, `max_micro_dollars`, with matching `spent_*` counters and `MAX_RESEARCH_ITERATIONS` at 1000. See [autoresearch.md](autoresearch.md).

## Dictation models

Two models, both local, both covered fully in [voice.md](voice.md). Defaults from [voice.ts](../desktop/shared/voice.ts):

| Stage | Model | Endpoint |
| --- | --- | --- |
| Speech to text | `ggml-org/Qwen3-ASR-0.6B-GGUF` | `http://127.0.0.1:8080/v1/audio/transcriptions` |
| Transcript cleanup | `superwhisper/s1-mini-GGUF` | `http://127.0.0.1:8081/v1/chat/completions` |

Both run under `llama.cpp` (`brew install llama.cpp`). The alternative engine is macOS Speech.framework with `requiresOnDeviceRecognition = YES` ([transcribe.m](../desktop/native/transcribe.m)). [voice.ts](../desktop/main/voice.ts) refuses any endpoint that is not local, and settings validation refuses to save one.

## Token, rate and cost accounting

Two numbers exist for every turn: a live estimate and the provider's real count.

**The estimate.** [usage.ts](../desktop/shared/usage.ts) and [agent-loop.ts](../desktop/main/agent-loop.ts) both use `CHARS_PER_TOKEN = 4`. As text streams in, `noteDelta` adds `Math.ceil(text.length / CHARS_PER_TOKEN)`.

**The real count.** When the harness reports usage, `noteUsage` overwrites the output side and adds to the input side:

```ts
noteUsage(threadId, usage) {
  run.inputTokens += usage.inputTokens;
  if (usage.outputTokens > 0) run.outputTokens = usage.outputTokens;
}
```

This matters beyond cosmetics. Without the real input count, the autoresearch token budget only ever sees the output side and stops at roughly half the real spend.

`recordTurn` stores `inputTokens`, `outputTokens`, `durationMilliseconds` and `model` per turn. A turn that failed before any usage arrived records `"0"` on both sides — a ledger that knows it cannot account for a turn is better than a guess.

The context bar reads the rest of [usage.ts](../desktop/shared/usage.ts): `MAX_USES` is 32, `RATE_FLOOR` is 4096, and `rateByContext`, `systemChars`, `mergeUses`, `allocateCells`, `charLabel` and `shareLabel` render it.

## Worked example: point Emma at LM Studio

LM Studio serves an OpenAI-compatible API on `http://127.0.0.1:1234/v1`. Ollama does the same on `http://127.0.0.1:11434/v1`. Substitute freely.

### As a second model — works through the GUI

1. Start LM Studio, load a model, start its server.
2. **Settings → Models → Local endpoints**, add a profile:
   - Name: `LM Studio`
   - Model ID: whatever LM Studio calls it, e.g. `qwen3-8b`
   - Base URL: `http://127.0.0.1:1234/v1`
   - Credential env: leave empty
3. Pick that profile in **VerifierPanel**, **TaggerPanel**, **VisionPanel** or **AdvisorPanel**.

`verifierFromKey` builds `http://127.0.0.1:1234/v1/chat/completions` and posts to it with no `authorization` header. Verified traffic never leaves the Mac.

Watch the validator: `https` is rejected for a local profile, and so is any URL with a query string, fragment or embedded credentials.

### As the main thread model — needs environment variables

The picker cannot do this today. `harnessModel()` returns `undefined` for a `local:` key, so the harness stays on its own default. Launch Emma with the environment set instead:

```sh
export EMMA_PROVIDER_CHAT_URL=http://127.0.0.1:1234/v1/chat/completions
export EMMA_PROVIDER_API_KEY=not-used-but-required
export FX_MODEL=qwen3-8b
open -a Emma
```

- `EMMA_PROVIDER_CHAT_URL` moves the whole agent loop off OpenRouter.
- `EMMA_PROVIDER_API_KEY` must be non-empty or `emma-cli` refuses to run. LM Studio ignores the value.
- `FX_MODEL` names the model, because Electron sends no `model` option for a non-`openrouter:` key.
- Leave `EMMA_OPENROUTER_ZDR` unset. The zero-retention flags are OpenRouter-specific and `isOpenRouter()` will not match a loopback URL anyway.

Two things to expect. The catalog page still lists OpenRouter models, because `FX_GATEWAY_BASE_URL` and Electron's catalog fetch are separate. And your local server must support tool calls — Emma advertises tools on every turn.

## The deterministic local fallback

`fallback` is the shipped default `selectedModel`, and it names a real thing: a canned reply built entirely on this Mac, no provider, no network. [agent/src/main.zig](../agent/src/main.zig) still implements it, in `fallbackReply`:

```
I received your message about "{subject}".
 I found {n} relevant knowledge page(s): "Title", ...
 This local fallback keeps the conversation in this thread; connect a provider for a model-generated answer.
```

The turn is recorded with model `local-fallback`, and input tokens are counted as `(input_bytes + 3) / 4`. The sidecar also has `classify()`, a keyword-only categoriser that sorts text into research, technology, finance, health or general with no model involved.

**On this branch, no thread turn reaches it.** The host's `sendMessage` method is what leads to the sidecar's `thread_message` handler, and Electron intercepts `sendMessage` in the IPC bridge before it gets there. `grep` finds no caller. A thread on the `fallback` key gets the harness's `default_model` — `nvidia/nemotron-3-super-120b-a12b:free` — over the network.

The Settings copy that reads *"Without a selected provider, Emma uses its deterministic local fallback"* describes the sidecar path, which no longer serves thread turns.

## See also

- [architecture.md](architecture.md) — how Electron, the Rust host, the Zig sidecar and the harness fit together
- [harness.md](harness.md) — `emma-cli` in detail
- [privacy.md](privacy.md) — what leaves this Mac
- [permissions.md](permissions.md) — the modes the verifier plugs into
- [tools.md](tools.md) — the tools Emma advertises on every turn
- [voice.md](voice.md) — the two dictation models
- [autoresearch.md](autoresearch.md) — the judge and the budget
- [data.md](data.md) — what lives in `<userData>`
- [troubleshooting.md](troubleshooting.md) — when a model will not answer
