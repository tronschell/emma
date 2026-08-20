# Emma

Emma is a macOS Electron agent workspace and exportable knowledge base. A global
shortcut opens a compact surface near the display notch and starts or continues
a normal agent thread with user-approved context. Saving an analyzed result as
portable Markdown is an explicit action, not the default for every turn.

This repository currently targets one production vertical slice:

```text
hotkey -> durable agent thread -> optional knowledge page
```

## Workspace

```text
desktop/        Electron main/preload and React 19 workspace
crates/core/    Durable Markdown knowledge and thread domain
crates/host/    NDJSON host bridge and Zig sidecar adapter
agent/          Zig agent sidecar, based on fx's embeddable architecture
website/        Separate React 19 + Tailwind 4 public site
docs/           Product and architecture contracts
```

The desktop uses Electron 43.4.0. Rust 1.97.1, Zig 0.16.0, and Node 24+ are
the development toolchains.

`dev.local.emma` is the provisional development identity. A publisher-owned
bundle ID, minimum supported macOS version, signing identity, distribution,
and update owner remain release blockers.

## Run the vertical slice

Install dependencies, then launch Electron (this also builds the Rust host and
Zig sidecar):

```sh
npm install --prefix desktop
npm run dev
```

Command-Shift-Space opens the compact agent surface. Threads are saved under
`~/Library/Application Support/Emma`; set `EMMA_DATA_DIR` for an isolated
store. Every thread selects one named knowledge base (the stable **Default**
base is used by older data). **Save & Analyze** creates an exportable Markdown
page inside that selected base; page edits are separate explicit actions.

Without a provider, Emma uses its deterministic local fallback. To use an
OpenAI-compatible local or hosted endpoint, set all three host settings; the
credential setting names an environment variable and never contains the key:

```sh
export EMMA_PROVIDER_BASE_URL=http://127.0.0.1:1234/v1
export EMMA_PROVIDER_MODEL=your-model
export EMMA_PROVIDER_CREDENTIAL_ENV=EMMA_API_KEY
export EMMA_API_KEY=your-key-or-local-placeholder
```

For OpenRouter, set its standard key and use the model picker in a thread's
right inspector. Emma loads the live free, tool-capable catalog and limits it
to models advertising a zero-data-retention endpoint:

```sh
export OPENROUTER_API_KEY=your-openrouter-key
```

Selecting a free model shows a privacy warning. Emma sends OpenRouter's
`provider.data_collection: "deny"` and `provider.zdr: true` controls on every
model turn, so a request fails instead of falling back to a provider that may
collect the prompt or retain it. OpenRouter account-level input/output logging
and product-improvement settings still apply; review them at
`https://openrouter.ai/settings/privacy`. Model selection currently lasts for
the running app session.

Threads keep one explicit destination base for saves and a durable, deduplicated
set of read-only source bases for bounded retrieval. Knowledge bases store
user category slugs alongside learned page categories. Page edits persist
through `emma-core` without changing capture provenance or run telemetry. The
activity heatmap is derived only from durable message/page timestamps.

Settings stores exactly three quick actions locally. `Command-1/2/3` in the
overlay runs them. Settings also chooses a below-notch surface or split side
rails and calibrates the center gap for the current Mac. The local transcription
endpoint/model seam is visible but microphone transport is disabled in this
build; no audio is recorded or sent.

Departure Mono is bundled under the SIL Open Font License and used sparingly
for compact labels and telemetry; body text stays on the native system stack.

First launch and Settings can register existing Codex, Claude, Antigravity, Pi,
OpenCode, Cursor, Windsurf, and Devin skill/MCP locations without copying their
config contents. User-installed CSS plugins can overhaul the semantic desktop UI;
the bounded manifest contract is documented in `docs/plugins.md`.

Electron does not expose notch bounds. Below mode centers the compact surface
under the active display's work area; rail mode anchors to the display top and
leaves a validated 120–260 point click-through center gap. Both use an original
24-step dither glow with a reduced-motion fallback. Dismissing an idle overlay
destroys its renderer to release memory while preserving an unsent draft
locally; an in-flight request settles before teardown. Build a macOS app with
`npm run package:mac`.
