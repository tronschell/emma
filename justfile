set positional-arguments

check:
    cargo check --workspace --locked --all-targets

check-runtime-shaders:
    cargo check -p emma-desktop --locked --features gpui_platform/runtime_shaders

test:
    cargo test --workspace --locked

test-runtime-shaders:
    cargo test --workspace --locked --features gpui_platform/runtime_shaders

dev:
    cargo run --locked -p emma-desktop

dev-runtime-shaders:
    cargo run --locked -p emma-desktop --features gpui_platform/runtime_shaders

run:
    cargo run --locked --release -p emma-desktop
