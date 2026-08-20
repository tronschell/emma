set positional-arguments

check:
    cargo check --workspace --locked --all-targets

test:
    cargo test --workspace --locked

dev:
    cargo run --locked -p emma-desktop

run:
    cargo run --locked --release -p emma-desktop
