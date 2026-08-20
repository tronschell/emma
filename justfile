set positional-arguments

check:
    cargo check --workspace --locked --all-targets

test:
    cargo test --workspace --locked

dev:
    cargo run -p emma-desktop

run:
    cargo run --release -p emma-desktop

