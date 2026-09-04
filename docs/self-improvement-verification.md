# Model-scoped self improvement verification

Verified locally on macOS on September 4, 2026, against the existing working
tree. The implementation and retained-data limits are described in
[self-optimization.md](self-optimization.md#model-aware-run-review).

## Checks

| Check | Result |
| --- | --- |
| `npm --prefix desktop run check` | Passed: 1,017 tests, renderer typecheck, ESLint, renderer build; existing bundle-size and dynamic-import warnings remain |
| `cargo fmt --all -- --check` | Passed |
| `cargo check --workspace --locked --all-targets` | Passed |
| `cargo test --workspace --locked` | Passed |
| `cargo clippy --workspace --locked --all-targets -- -D warnings` | Passed |
| `zig build test` in `harness` | Passed |
| `zig build` in `harness` | Passed |
| `zig fmt --check` on the changed Zig files | Passed |
| `git diff --check` | Passed |

The new regression tests cover scope validation and persistence through the
trial lifecycle, model/family filtering, comparison eligibility, model switches,
subagent attribution, same-timestamp runs, older-trace offsets and children
finishing after their parent.

A deterministic local HTTP provider exercised the freshly built
`harness/zig-out/bin/emma-cli` through the desktop Harness client. A GLM parent
received a GLM-only prompt and tool-description marker. Its GPT child requested
its own context and received neither marker, while retaining the standard tool
and verification guidance. All three provider requests completed; no real model
service was used for this check.

The real Electron app was launched with an isolated profile and synthetic run
data. Family filtering showed five GLM failures; GPT filtering showed three
successful runs and no repeating failure. An expanded repair was changed from
family scope to `z-ai/glm-5.3-flash`, given a concrete tool description, queued
and started. The exact scope and text were present after restarting the app.
The screenshot in the website shows synthetic examples, not measured provider
quality. The development server logged Fast Refresh/createRoot warnings during
concurrent edits; the final restart restored the saved trial. Both owned
validation processes were stopped afterward.

## Sibling repositories

The website feature/docs, roadmap, agent reference and screenshot were updated.
Its build, changed-file formatting/lint and browser verification passed. Its
full checks still report pre-existing lint errors in `EmmaWindow.tsx` and
formatting issues in seven untouched files.

The phone's shared trace/protocol types and metadata regression check were
updated. Typecheck, targeted lint, thread/events/guard and whitespace checks
passed. Its full protocol mirror check still reports pre-existing `goal.ts`
drift. Desktop improvement trials remain on the Mac; phone UI was unchanged.

## Verification limits

Historical traces can lack model and context fields, and stored evidence remains
bounded. No live provider benchmark established that GLM performs worse than
another model. Analysis quality with a real provider, VoiceOver, global
shortcuts, new privacy permission requests, alternate display geometry,
non-macOS execution, signing and release artifacts were not exercised. Remote CI
was not run, and these changes were not committed or published.
