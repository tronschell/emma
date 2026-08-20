set positional-arguments

check:
    npm --prefix desktop run check
    cargo check --workspace --locked --all-targets

test:
    cargo test --workspace --locked

dev:
    npm --prefix desktop run dev

run:
    npm --prefix desktop run dev

package:
    npm --prefix desktop run package:mac
