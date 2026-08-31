# Release readiness — August 28, 2026

This records a local verification snapshot, not a published release. Checks ran
on the release-readiness changes developed on `codex/release-readiness`, based on
`d1e0984ee48eb9a21fdfb2c00163e71b46834fb7` from `dev`. Verification changed no
version, changelog, release tag, remote branch or GitHub setting.

## Verdict

The scoped release-hardening fixes pass the required local checks, packaging
checks and real-app widget smoke test, and are ready for review into `dev`. An
unqualified public-release recommendation is withheld: the background-agent
context issue below was explicitly deferred, and production signing and delivery
have not yet been exercised. Do not promote the old `dev` tree as though it
contained these fixes.

## Changes

- Widget credentials require native approval of the exact request template and
  component version. URLs cannot interpolate credentials; errors do not echo
  substituted secrets. Public HTTPS connections validate and pin DNS addresses,
  reject redirects and reserved headers, and cap response bytes while reading.
  Widgets still share the renderer; this does not make them isolated programs.
- Terminal subscriptions wait for a selected thread and discard stale tabs and
  asynchronous replies when selection changes.
- The OpenAI-compatible harness parser frees partial tool calls and completion
  fields correctly on malformed replies and allocation failures.
- Release-policy lint passes without relaxing its assertions. Draft inspection
  retains the GitHub permission it needs; the workflows themselves are unchanged.
- README, user/developer documentation and in-app privacy wording describe the
  current onboarding, tools, routing limits, data boundaries and updater behavior.

## Verification

| Check | Result |
| --- | --- |
| `npm --prefix desktop run check` | Passed: 637 tests, typecheck, lint and renderer build |
| `cargo fmt --all -- --check` | Passed |
| `cargo check --workspace --locked --all-targets` | Passed |
| `cargo test --workspace --locked` | Passed: 39 tests |
| `cargo clippy --workspace --locked --all-targets -- -D warnings` | Passed |
| `zig build test` in `harness` | Passed on the final parser-fixed, context-unchanged tree |
| Parser-focused checks | Passed: 20 tests, including malformed replies and allocation-failure injection |
| Fresh ReleaseSafe harness against a loopback provider | Passed: malformed reply exits normally with `InvalidProviderResponse` and no tool dispatch; valid text/reasoning succeeds |
| Fresh macOS package | Passed: arm64/macOS deployment checks, bundled binaries/notices, native helper and ripgrep self-tests |
| Visible packaged-app widget smoke | Passed: normal HTTPS, three unsafe-request rejections, native credential warning and cancellation; no startup terminal-list error |
| Settings wording | Typecheck and copy regression passed; final visual inspection was blocked by the UI tool selecting the radial menu instead of the main window |
| Documentation and isolated website checks | Passed: 457 existing local links, this document's links, website tool catalog and image dimensions |

The desktop build still reports its existing large-bundle warning. Native socket
tests need execution outside the filesystem/network sandbox; sandbox-denied
loopback calls are not application failures. Local logs and fixtures are under
`/private/tmp/emma-release-ready.Q83BUf` and
`/private/tmp/emma-gateway-readiness.YlFhKa` on the verification Mac.

The widget smoke used a separate bundle identifier, profile, vault and Rust data
directory. Only a dummy credential name/value was provided. The native dialog
showed the URL, method, template and variable name without the value; cancellation
blocked the request. Actual approval and session reuse were covered by automated
tests, not a native approval click. The UI tool's mouse actions failed, so the
verified interactions used keyboard navigation. Its subsequent window-selection
failure prevented a reliable Settings screenshot; that is not reported as a
successful visual check. The test copy was restarted once to investigate it.

## Real native mock update

Passed using isolated, locally signed copies: `0.1.0` downloaded `0.2.0`, the
user-approved **Install and relaunch** action invoked the real native updater,
and the new app opened automatically in **2.695 seconds**. No manual launch was
issued during the restart. The old and new processes were different, the
installed bundle version/signature matched the update, and the test conversation
had the same SHA-256 before and after:

```text
c3385944ab094d752c9a37fd998bad64a363f2cc56874dc2efaa9b84182fe172
```

The updater code was unchanged from `d1e0984`. The mock used a loopback feed,
ad-hoc signatures pinned to the replacement hash, and a test-only library
validation entitlement. It used neither the installed Emma nor real user data.
Evidence is in `/private/tmp/emma-update-rehearsal.ImHJ9T/result.json` and its
event log. This proves local download, replacement, restart and data retention;
it does not prove GitHub delivery, Developer ID signing, notarization,
Gatekeeper acceptance or macOS 12 compatibility.

## Explicitly deferred risk

At the maintainer's request, the background-agent context-lifetime issue is
**not fixed**. In ACP, a child borrows `state.context_snapshot` bytes that the
next parent context refresh can free
([prompt.zig](../harness/src/acp/prompt.zig)). The TUI child similarly borrows a
queued parent snapshot whose lifetime can end first
([app_agent_runtime.zig](../harness/src/core/app/app_agent_runtime.zig)). A
surviving child can read freed memory, potentially corrupting its context or
crashing. Two independent source reviews confirmed the lifetime mismatch; a
timing-dependent runtime crash was not reproduced. The CLI ask path joins its
children before freeing its immutable snapshot and does not share this defect.
No child-context patch remains in the candidate.

## Publication and website gates

After this snapshot, [release PR #7](https://github.com/tronschell/emma/pull/7)
merged and prepared `v0.2.0` at `48ed848`. Its draft contains only GitHub's
source archives because the prepared tree never reached the `main` packaging
job, and it predates the hardening changes above. Keep that draft unpublished.

1. Merge these reviewed fixes into `dev`, let release-please open or update its
   generated release PR, and run the required checks on that final tree. Do not
   hand-bump its version or changelog.
2. Merge the generated release PR and let preparation create its exact tag and
   draft. Promote that exact `dev` tree to `main` using a merge commit. The
   [release contract](releases.md) describes the signing and publication gates.
3. Verify the first Developer ID signed, notarized, Gatekeeper-accepted build.
   All five Apple secret names exist, but their contents and validity were not
   inspected or proven. The assetless `v0.2.0` draft is not that proof.
4. Check the public feed after publication. The app is wired to
   `update.electronjs.org/tronschell/emma/darwin-arm64/<installed-version>`;
   release names and ZIP names match its contract. A later upgrade between two
   published signed versions is still needed to prove that entire path.
5. Apply/review and deploy the prepared website delta. The existing dirty website
   checkout was not modified. The isolated copy passed formatting, lint,
   typechecking, production build and a 1280px live-browser check; all 26 tools
   and 11 screenshot dimensions match. Deployment and the live site's contents
   remain unverified. The baseline-relative patch is
   `/private/tmp/emma-website-baseline.SXidCj/website-readiness.patch`.
6. Review the `main` strict up-to-date branch rule before the next promotion.
   After a merge promotion, `main` has a merge commit absent from linear `dev`;
   requiring the next `dev` head to include it can block repeated promotions.
   This is a policy/graph inference, not an exercised second release. No branch
   protection was changed.

Global shortcuts, fresh privacy grants, VoiceOver, multiple-display geometry,
macOS 12 hardware, Intel and non-macOS paths are not verified by these checks.
Windows and Intel packages are not currently shipped. A local test pass is not
a claim that every feature or platform interaction is bug-free.
