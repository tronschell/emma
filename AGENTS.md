# Emma repository guide

Emma is a macOS-first hybrid application: Rust/GPUI owns native lifecycle and
presentation; Zig owns the agent harness. Keep that boundary visible.

## Ownership

- `crates/desktop`: process startup, windows, global shortcuts, menus, macOS bridges.
- `crates/ui`: GPUI views, focus, actions, accessible components, presentation state.
- `crates/core`: UI-independent knowledge records, persistence, and protocol types.
- `agent`: Zig agent runtime and its wire protocol. It never renders UI.

Do not add a new crate, trait, service locator, or plugin framework until a
second real implementation needs the boundary. Blocking filesystem, process,
network, image, and model work stays off GPUI's application thread. Store every
returned GPUI task or detach it only for deliberate app-lifetime work.

## Checks

```sh
cargo fmt --all -- --check
cargo check --workspace --locked --all-targets
cargo test --workspace --locked
cargo clippy --workspace --locked --all-targets -- -D warnings
zig build test --build-file agent/build.zig
```

Visible or platform work is not complete until the real app has been launched
and the changed interaction exercised. Report unverified privacy permissions,
VoiceOver behavior, display geometry, and non-macOS paths explicitly.

