# Emma

Emma is a lightweight macOS agent and exportable knowledge base. A global
shortcut opens a compact surface near the display notch and starts or continues
a normal agent thread with user-approved context. Saving an analyzed result as
portable Markdown is an explicit action, not the default for every turn.

This repository currently targets one production vertical slice:

```text
hotkey -> inspect context -> agent thread -> optional knowledge page
```

## Workspace

```text
agent/          Zig agent sidecar, based on fx's embeddable architecture
crates/core/    Knowledge and protocol domain
crates/ui/      GPUI views and controls
crates/desktop/ macOS lifecycle, windows, hotkey, and capture bridge
website/        React 19 + Tailwind 4 public site
docs/           Product and architecture contracts
```

GPUI is pinned to Zed commit
`7733b9922665f103abda7c6a3fde6b9dfdc8eba9`; the fx reference is pinned to
`b1774fbf6c7602b503026f96f6e960e946c692ef`. Rust 1.97.1 and Zig 0.16.0 are
the development toolchains.

`dev.local.emma` is the provisional development identity. A publisher-owned
bundle ID, minimum supported macOS version, signing identity, distribution,
and update owner remain release blockers.

## Run the vertical slice

Build the Zig sidecar, then launch the GPUI app:

```sh
zig build --build-file agent/build.zig
cargo run --locked -p emma-desktop
```

Command-Shift-Space opens the compact agent surface. Threads are saved under
`~/Library/Application Support/Emma`; set `EMMA_DATA_DIR` for an isolated
store. Knowledge pages are created only by **Save & Analyze** and remain plain
Markdown.

Without a provider, Emma uses its deterministic local fallback. To use an
OpenAI-compatible local or hosted endpoint, set all three host settings; the
credential setting names an environment variable and never contains the key:

```sh
export EMMA_PROVIDER_BASE_URL=http://127.0.0.1:1234/v1
export EMMA_PROVIDER_MODEL=your-model
export EMMA_PROVIDER_CREDENTIAL_ENV=EMMA_API_KEY
export EMMA_API_KEY=your-key-or-local-placeholder
```

This checkout has only Xcode Command Line Tools, so native shader compilation
cannot find `metal`. Install full Xcode for the standard command, or use
`--features gpui_platform/runtime_shaders` for local validation.
