# Models and providers

Emma talks to any OpenAI-compatible Chat Completions endpoint. Out of the box
that endpoint is [OpenRouter](https://openrouter.ai). Paste an OpenRouter key
into **Settings → Models**, pick a model from the catalog, and the composer's
picker switches models per thread. No account inside Emma, no config file.

Anything else that speaks the same shape — Z.AI, DeepSeek, a GPU host, LM Studio
on this computer, llama.cpp on a box down the hall — is a **provider profile** you add
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

The request body ends `,"stream":false}` — nothing is streamed at the HTTP layer.
Completed model replies and tool activity are forwarded to the UI over ACP;
there are no live provider token deltas while a completion is still pending.

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
| `codex:<slug>` | A ChatGPT subscription model exposed by Codex | `codex exec --model <slug>` |
| `fallback` | The shipped default | nothing — see below |

`defaultSettings.selectedModel` is `"fallback"` and `favoriteModels` starts as
`["fallback"]`. `harnessModel()` sends a `model` config option for `openrouter:`,
`router:` and `provider:`; `codex:` runs the Codex CLI instead of the harness.
Only `fallback` sends **nothing**, leaving the harness on its own `default_model`.

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
option. Leave it 0 and `ModelMetadataCatalog` looks up the exact provider and
model in the live metadata cache. Fill it in to override that source or for an
off-catalog endpoint; the manual value always wins.

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

**Thinking modes.** Known efforts are ordered weakest first — `none, minimal,
low, medium, high, xhigh, max, ultra` — and any safe unfamiliar effort published
later is appended and rendered from its name. A model that advertises
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
model catalogs** button sends `force`, which drops the age gate.

[catalog-seed.ts](../desktop/main/catalog-seed.ts) compiles a model snapshot into the
app for a first launch with neither cache nor network. Regenerate with
`npm run seed:catalog`, which hits the same public endpoint and needs no
credential.

`contextLength(id)` and `reasoningEfforts(id)` exist because the harness knows
only a handful of model-id prefixes: Electron looks the real numbers up and sends
the window as the `context_window` config option, without which the harness
silently caps its history and disables token-pressure compaction. For the free
chain it is the **first** id's window that is sent (`model.split(",")[0]`).

### Route-aware metadata

[model-metadata.ts](../desktop/main/model-metadata.ts) keeps model facts keyed by
route, because one model slug does not imply one limit. It refreshes
`https://models.dev/api.json` daily, validates and stores the last good catalog
at `<userData>/model-metadata.json`, and serves that cache when the network is
down. The full source catalog stays on disk while the renderer receives a small
normalized record containing context and input/output limits, modalities,
reasoning efforts, tool and structured-output support, dates and token prices.

OpenRouter rows keep OpenRouter's current context, effort and price data and are
enriched with the matching OpenRouter metadata record. Direct provider profiles
use the provider's own record. `codex:<slug>` reads Codex's local
`~/.codex/models_cache.json`, including `effective_context_window_percent`, so
an API route may report 1,050,000 while the same slug through a ChatGPT plan
reports 258,400. A profile's nonzero manual `contextWindow` overrides every
catalog. These route records drive both the picker and the context window sent to
the harness.

## Credentials

**A credential setting names an environment variable. It never holds the key.**
[credentials.ts](../desktop/main/credentials.ts) is the whole mechanism.

1. You paste a key in **Settings → Models → provider keys**. It goes over IPC to main and no further.
2. `set(env, secret)` validates: the name against `isEnvName` (`/^[A-Za-z_][A-Za-z0-9_]{0,63}$/`), the secret 1–`MAX_SECRET_CHARS` (512) printable ASCII (`/^[!-~]+$/`).
3. `save()` encrypts each secret with Electron `safeStorage.encryptString` — the operating system's secure credential store — and base64s it. If `isEncryptionAvailable()` is false it throws: *"This computer's secure credential store is unavailable, so Emma will not store a key in plain text."*
4. The blob lands at `<userData>/credentials.json`, written to a `.tmp` with mode `0o600` in a directory created `0o700`, then renamed. `userData` is Electron's profile directory; packaged Windows builds use `%APPDATA%/Emma`, while macOS builds use `~/Library/Application Support/Emma`. See [data.md](data.md).
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

## Plans and subscriptions

**Settings → Models → Subscriptions** points the whole agent loop at a maker's
own endpoint instead of OpenRouter. It is not a new mechanism. `withPlanProfile`
([settings.ts](../desktop/shared/settings.ts)) writes a `ProviderProfile` with id
`plan-<planId>` into `settings.providers`, adding a numbered suffix when another
model already uses that plan. The existing `provider:` key carries it from there:
`providerRoute` in [main.ts](../desktop/main/main.ts), `EMMA_PROVIDER_CHAT_URL`
at spawn, one harness per provider. The harness, the IPC surface and main
learned nothing new. Delete the profile and the plan is gone.

`MODEL_PLANS` is the whole table:

| Plan | Label | Base URL | Key | Billing |
| --- | --- | --- | --- | --- |
| `openai` | OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` | metered |
| `anthropic` | Anthropic | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | metered |
| `deepseek` | DeepSeek | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | metered |
| `qwen` | Qwen Coding Plan | `https://coding-intl.dashscope.aliyuncs.com/v1` | `BAILIAN_CODING_PLAN_API_KEY` | subscription |
| `zai` | GLM Coding Plan | `https://api.z.ai/api/coding/paas/v4` | `ZAI_API_KEY` | subscription |
| `kimi` | Kimi Code | `https://api.kimi.com/coding/v1` | `KIMI_CODE_API_KEY` | subscription |
| `minimax` | MiniMax Token Plan | `https://api.minimax.io/v1` | `MINIMAX_API_KEY` | subscription |
| `gemini` | Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` | metered |
| `mistral` | Mistral | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | metered |

Every base URL is https and every key slot is an environment variable name that
`credentials.ts` will take, so a plan key is stored exactly like the OpenRouter
one. Kimi Code sits under `KIMI_CODE_API_KEY` rather than `KIMI_API_KEY` because
Moonshot's own CLI already claims the latter for its open-platform key, which is
a different credential on a different host and would 401 here. `contextWindow` is 0 on all nine, and a plan model id is a vendor slug the
OpenRouter catalog does not carry, so nothing fills the window in — set it on the
profile under **Providers** for anything you run at length.

### Choosing the route

Pick the model, then choose who bills for it under the selected row. The provider
control appears only for the current model when its id sits under a plan's
`namespace`: **OpenRouter · API** or the plan's name and billing kind. The same
control appears in the workspace, Quick Ask, scheduled tasks, conditional prompts,
verifier, advisor, vision and secrets. Rows no plan covers keep their existing route.

The model id is derived, never typed. `planForModel` matches the namespace,
`planModelId` strips it along with any `:free` suffix, and
`openrouter:z-ai/glm-5.2:free` becomes `glm-5.2` at
`https://api.z.ai/api/coding/paas/v4`. Choosing the plan route reuses that model's
profile or adds `plan-<planId>-2`, `plan-<planId>-3` and so on. A scheduled task
on one GLM model therefore does not change when the workspace chooses another.
The Subscriptions row lists the models currently routed through each plan and
holds no model id field of its own.

**Vendor slugs and OpenRouter slugs do not always match.** OpenRouter names a
model what OpenRouter names it, and the stripped id is a guess at what the vendor
calls the same weights. When the guess is wrong, or when a plan serves a model the
OpenRouter catalog does not list at all, the **Providers** panel below takes an
endpoint and a model id by hand.

### What a plan has cost you

Every plan row carries its own spend, on the two windows the vendors actually
meter against: the last five hours and the last seven days. There is no new
store behind it. `recordTurn` already writes `inputTokens`, `outputTokens` and
`model` into the durable thread record, so `planSpend`
([settings.ts](../desktop/shared/settings.ts)) folds the snapshot the renderer
already holds and no Rust, Zig or IPC surface changed.

Attribution rests on one invariant: **an OpenRouter turn always records a
namespaced id (`z-ai/glm-5.2`) and a plan turn always records the bare vendor
slug (`glm-5.2`)**, because `planModelId` strips the namespace on the way to the
profile. `planForGeneration` therefore refuses any model containing a `/`, and
otherwise matches the bare slug against the plan profiles. A hand-typed provider
profile whose `modelId` collides with a plan profile's will be counted against
the plan.

**Tokens, not dollars.** The harness computes a real per-request cost and a
resolved `canonicalSlug` ([client.zig](../harness/src/gateway/client.zig)), but
the ACP bridge narrows usage to two integers
([types.zig](../harness/src/acp/types.zig)) and drops both. Widening that wire
shape is what a money column would cost.

**DeepSeek is the only plan that can report its own balance.** `/user/balance`
is documented, returns its money as strings, and is fetched by
`fetchDeepSeekBalance` into the same `KeyBalance` the OpenRouter row already
uses. Nothing else is available: Qwen and Mistral publish no endpoint at all;
OpenAI and Anthropic gate usage behind an Admin key that by design cannot also
run inference; Z.AI's and Kimi Code's quota endpoints exist but appear in no
vendor documentation — two independent third-party clients disagree over whether
Z.AI even wants a `Bearer` prefix — so Emma does not call them. The five-hour
windows on the GLM and Kimi plans are therefore counted locally or not at all.

### Gateways are not plans

A plan claims one vendor `namespace`, which is what lets a catalog row offer a
second route button. A gateway carries every vendor's models under its own ids,
so it claims no namespace and gets no button — it belongs beside OpenRouter, not
in `MODEL_PLANS`. OpenCode ships two, both OpenAI-compatible and both reached
with the same `sk-` key from [the OpenCode console](https://opencode.ai/auth),
so both are `PROVIDER_PRESETS` chips rather than plan rows:

| Chip | Base URL | Key | Billing |
| --- | --- | --- | --- |
| OpenCode Zen | `https://opencode.ai/zen/v1` | `OPENCODE_API_KEY` | prepaid credits, auto-reloading |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | `OPENCODE_API_KEY` | $10 a month, open-weight models only |

**Only part of each catalog answers on `/chat/completions`.** OpenCode binds each
model id to one protocol: GPT, Grok and Muse are on `/responses`, Claude, Qwen and
MiniMax are on `/messages`, and Gemini is on `/models/<id>`. Emma speaks
chat-completions, so the usable set is the rest — GLM, Kimi, DeepSeek, MiniMax on
Zen, LongCat and MiMo on Go, plus the free tier. Pick the model with **Test**
before trusting a row: a wrong protocol answers 500, not 404.

### OpenAI, Anthropic and Google are different in kind

None of the three sells an HTTP endpoint that a subscription can pay for.
`https://api.openai.com/v1` bills your OpenAI Platform account per token and
`https://api.anthropic.com/v1` bills your Anthropic Console account per token,
whatever ChatGPT Plus or Pro, or Claude Pro or Max, you also hold. Google is the
same: its own docs say Google AI plan benefits "apply only within the Google AI
Studio web interface" and that direct API use is "billed and managed separately",
so `https://generativelanguage.googleapis.com/v1beta/openai` bills the key's
project no matter which AI Pro or Ultra plan you hold. That is why all three rows
are `billing: "metered"` and why each note says the subscription does not pay for
the key. Paste a key there if you want the metered route; it is not the plan you
are already buying.

The subscription path for those three is their **own CLI**, which Emma already
spawns through the `cli` tool ([cli.ts](../desktop/main/cli.ts),
[cli.md](cli.md)). `CLI_PLANS` holds three rows, shown under the key rows:

| Row | Plan | Sign in with | Turns draw on |
| --- | --- | --- | --- |
| Claude Code | Claude Pro or Max | `claude` | [the same limits your Claude chats share](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan) |
| Codex | ChatGPT Plus, Pro or Business | `codex login` | [the plan's five-hour message window, shared with other ChatGPT use](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) |
| Gemini CLI | Google AI Pro or Ultra | `gemini` | [1,000 requests a day free, 1,500 on AI Pro, 2,000 on AI Ultra](https://ai.google.dev/gemini-api/docs/google-ai-plans) |

**Emma spawns the binary and never touches the login.** Anthropic's
[legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
permits an end user signing in to the **unmodified** Claude Code binary with
their own subscription, and explicitly forbids a third-party application routing
Pro or Max credentials through itself or storing or intermediating Claude session
tokens. Emma spawns the unmodified binary you signed in to yourself and never
sees, stores or forwards that login. Codex is the same shape. Google is stricter
still: the Gemini CLI terms forbid third-party software reaching Gemini Code
Assist through that OAuth login, and the sanction falls on the user's account —
so the binary spawns as itself or not at all. Google AI Plus is not supported.

**A CLI run is a delegated side channel, not the thread model — except Codex.**
For Claude Code and Gemini CLI the call goes out through the `cli` tool and comes
back as one tool result; [harness.ts](../desktop/main/harness.ts) only ever
speaks ACP to `emma-cli`, so neither plan changes which process runs the loop.
This is not "use Claude as your model" and should not be read as one. Codex is
the single exception, and the next section says what that costs.

### The ChatGPT route runs someone else's agent

A GPT row in the catalog offers three buttons, not two: OpenRouter, the metered
OpenAI key, and **ChatGPT**. The third picks the key `codex:<slug>`, and
[main.ts](../desktop/main/main.ts) sends that turn to
[codex.ts](../desktop/main/codex.ts) instead of the harness — `codex exec --json`
in the workspace, one process per turn, resumed by the `thread_id` Codex hands
back on `thread.started`.

Be clear about what changes. **Codex runs its own agent loop, its own tools and
its own sandbox.** Emma's system prompt, its tool permissions, its disabled-tool
list and its approval prompts do not reach it. Emma passes `sandbox_mode` as
`workspace-write` and `approval_policy` as `never`, so a ChatGPT-routed turn can
write anywhere in the workspace without asking. The steps you see in the timeline
are Codex's `item.started` and `item.completed` events mapped onto Emma's, and
there is no token-level streaming in `--json`: an answer lands whole, not
letter by letter.

What does not change is the trust story. Emma spawns the unmodified `codex`
binary you signed in to yourself with `codex login`, and never reads, stores or
forwards that login — `~/.codex/auth.json` is Codex's file and Emma does not open
it. This is the shape OpenAI documents and ships itself: its own
[Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc) drives
Codex from a competitor's product under the user's ChatGPT subscription, and the
[pricing page](https://learn.chatgpt.com/docs/pricing) lists `codex exec` and
scriptable workflows as available on Plus, Pro, Business and Enterprise. Turns
draw on the plan's five-hour window, shared with your other ChatGPT use.

Picking the route fails loudly rather than silently: `selectCodexModel` refuses a
slug that is not a plain model id, and refuses outright if `codex` is not on the
PATH. The same guard sits in `codexArgs`, because a thread's pinned model is a
second way into the runner and a pin is only length-checked. **Emma always sends
its own `model_reasoning_effort`**, defaulting to `medium` when the turn has
none: without that, a `model_reasoning_effort` in your own
`~/.codex/config.toml` decides Emma's turns, and a global `max` is rejected
outright by the smaller models.

The button only appears on rows Codex can actually run. `useCodexSlugs` reads the
route metadata returned with the live catalog and falls back to Codex's model
list, cached for one hour, so `openai/gpt-5.4-mini` offers the route and
`openai/gpt-3.5-turbo-16k` does not.

**Some models exist only here.** `codexEntries` in
[App.tsx](../desktop/src/App.tsx) reads the Codex model cache and adds a row for
every slug OpenRouter does not carry — `gpt-5.3-codex-spark` is
`supported_in_api: false`, so a subscription is the only way to reach it at all.
Those rows have one route and no provider buttons.

**Ceilings.** Codex-only rows appear in Settings → Models and in the workspace
and per-task pickers, with their effective local context window. Quota is not
read — `codex exec --json` reports per-turn tokens on
`turn.completed` and nothing about the five-hour window, so a ChatGPT turn shows
up in the local ledger like any other and the remaining-quota line stays empty.
Reading quota, and signing in from inside Emma, both need `codex app-server`,
which is the upgrade path when either becomes worth an experimental JSON-RPC
surface that has no compatibility policy.

**Emma detects installed, not signed in.** `installedClis` resolves each binary
with `command -v` in a login shell, and the row reads **Installed** with the
resolved path or **Not found**. Whether that binary has a session is between you
and the vendor.

### What bites, per plan

Each row's `note`, which the panel shows behind its (i):

| Plan | Gotcha |
| --- | --- |
| GLM Coding Plan | The endpoint picks the billing pool, not the key. This is the coding host; the same key on the general host silently bills pay-as-you-go. A mainland `bigmodel.cn` key will not work here. |
| Kimi Code | Wants a Kimi Code key from the Kimi Code console — a different credential, on a different host, from a Moonshot open-platform key. |
| MiniMax Token Plan | The Token Plan issues its own Subscription Key, separate from the pay-as-you-go key; MiniMax states the two are not interchangeable. |
| Qwen Coding Plan | A Coding Plan key starts `sk-sp-` and works only on the coding hosts; an ordinary `sk-` Model Studio key is metered. Keys are bound to the region that made them. |
| DeepSeek | Prepaid balance, no subscription at all. At a zero balance every request is a 402 until you top up. |
| Mistral | No coding plan. The subscription grants monthly API credits that this key spends, per token. |
| OpenAI, Anthropic | Metered credit only — above. |

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

Read by the Rust host: `EMMA_DATA_DIR` alone, which moves the platform data root
(`%APPDATA%/Emma` on Windows or `~/Library/Application Support/Emma` on macOS).
[runtime.rs](../crates/host/src/runtime.rs)
resolves the data root, starts the store, and answers requests — it spawns no
child, holds no credential and makes no network request.

## Settings → Models

[App.tsx](../desktop/src/App.tsx) renders, in order: **ModelCatalog** (the full
list, a "Free only" filter persisted under `emma.freeModelsOnly.v1`, a `Free`/`Paid`
badge, a reload that names what was added and removed, `CATALOG_PAGE` 15 rows at
a time, and the shared provider control under the selected row when a plan covers it) ·
**ModelPlans** (Subscriptions, above — keys only) · **ProviderSettings** · **VerifierPanel** · **AdvisorPanel** ·
**VisionPanel** · **SecretPanel** · **ProviderKeys** · **Private routing** · **Automatic fallback**
· **Local deterministic profile** · **Speech to text**.

**Provider profiles.** `PROVIDER_PRESETS` fills the form's chips — OpenRouter,
Z.AI, DeepSeek, OpenCode Zen, OpenCode Go, LM Studio, Ollama, llama.cpp, Custom —
with a base URL and a key variable name; a chip is prefill and nothing more. **Test** hits
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
off this computer, and it says what it does: the prompts and the key cross your network
unencrypted. `providerReach()` sorts a saved URL into **On this computer**, **Your
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

It is **off by default**. Zero retention narrows routing to endpoints that offer
it; a model with no qualifying endpoint fails. Availability can change, and a
free or paid badge does not establish the endpoint's data policy.

The flag rides the harness request body only: verifier, vision, advisor, secrets
and note-tagger calls go out with no routing flags. It does not change your
OpenRouter account's prompt-logging settings, which Emma cannot read or change.
Check them yourself at
[openrouter.ai/settings/privacy](https://openrouter.ai/settings/privacy). See
[privacy.md](privacy.md). This is not an app-wide offline or privacy switch.

## The second models

Five subsystems run a separate small model on a separate route. All share the
`VerifierSettings` shape — `{ model, endpoint, credentialEnv, system }` — and all
go through one `chatCompletion` helper in
[verifier.ts](../desktop/main/verifier.ts), which posts
`{ model, messages, temperature: 0, max_tokens, stream: false }` with
`authorization: Bearer <key>` from `process.env[credentialEnv]`, and reads
`message.reasoning` or `message.reasoning_content` when `content` comes back
empty. Every one of these budgets has to cover the reasoning a current model
spends before it answers, not just the answer. An empty `credentialEnv`
means a local server that needs no key.

| Subsystem | File | Default model | Timeout | Max tokens |
| --- | --- | --- | --- | --- |
| Verifier | [verifier.ts](../desktop/main/verifier.ts) | `liquid/lfm-2.5-2.6b:free` | 20 s | 700 |
| Note tagger | [vault-tags.ts](../desktop/main/vault-tags.ts) | `thinkingmachines/inkling-small:free` | 20 s | 1024 |
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
them on this computer. See [privacy.md](privacy.md).

**Note tagger** — titles and tags a note kept into your vault
(`MAX_TAG_TEXT_CHARS` 6000, at most `MAX_TAGS` tags). See
[knowledge.md](knowledge.md). Its rules are `defaultTaggerSystem` and it sends
them; a stored `system` replaces them. It has no panel: `emma:set-tagger` exists
on the IPC surface but nothing in the renderer calls it, so its model is
whatever `defaultTagger` says — a three-model chain, none of which reasons
unless asked to.

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
header. That traffic never leaves the computer.

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
On this computer"* all describe a mechanism that no longer exists in `desktop/main`.

## Dictation models

Two, both local, both covered in [voice.md](voice.md). Defaults from
[voice.ts](../desktop/shared/voice.ts): speech to text
`ggml-org/Qwen3-ASR-0.6B-GGUF` on `http://127.0.0.1:8080/v1/audio/transcriptions`,
cleanup `superwhisper/s1-mini-GGUF` on `http://127.0.0.1:8081/v1/chat/completions`,
both under `llama.cpp`. The alternative engine is the platform's built-in
recognizer: macOS Speech.framework with `requiresOnDeviceRecognition = YES`, or
Windows SAPI. A non-local endpoint is refused when saved and refused again
before use.

## See also

- [harness.md](harness.md) — `emma-cli` in detail
- [privacy.md](privacy.md) — what leaves this computer
- [permissions.md](permissions.md) — the four modes the verifier plugs into
- [tools.md](tools.md) — the tools Emma advertises every turn
- [voice.md](voice.md) — the two dictation models
- [autoresearch.md](autoresearch.md) — budgets and the judge
- [data.md](data.md) — what lives in `<userData>`
- [troubleshooting.md](troubleshooting.md) — when a model will not answer
