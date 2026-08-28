# Releasing Emma

Emma currently ships for **macOS 12 or later on Apple silicon**. GitHub Actions
builds it on a standard `macos-15` Apple-silicon runner; a personal Mac or
self-hosted runner is not required. Standard hosted runners are free for public
repositories. [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Branches

```text
feature branch → dev → main → signed macOS download
```

`dev` is the default branch and integration branch. Start feature branches from
it and open feature PRs against it. `main` contains releases, not unfinished
feature work. Both branches require the GitHub Actions `check` status and a PR;
force pushes and deletion are disabled. `dev` requires linear history, and
rebase merging is disabled, so feature and generated release PRs are squash
merged. The squash commit uses the PR title and body.

Feature PRs into `dev` run only lightweight branch, title, and release-rule
checks on Ubuntu. They do not install app dependencies, compile, or package
Emma. Full tests and app builds run only for promotion to `main` and its release
push. Pushes to `dev` only prepare the generated version/changelog PR.

```sh
git fetch origin
git switch -c feat/my-change origin/dev
gh pr create --base dev --title 'fix(notch): preserve focus'
```

Every PR title is a conventional commit. `feat` creates a minor release, `fix`
and `perf` a patch, and `!` or `BREAKING CHANGE:` a major. Other conventional
types do not normally create a release. Never hand-edit `CHANGELOG.md`, bump
versions in feature PRs, or create or move release tags yourself.

## Release a version

1. Squash-merge the finished feature PRs into `dev`.
2. The `release` workflow opens or updates the generated release PR against
   `dev`. Review its version and changelog, approve its CI run if GitHub asks,
   and squash-merge it after checks pass.
3. Wait for the `prepare` job on `dev` to succeed. It creates the version tag
   and a **draft**, not a public release. Do not change `dev` between this
   preparation and promotion.
4. Open a `dev` → `main` PR with a conventional title such as
   `chore(release): promote dev`. Its full checks compile and test all layers,
   then package an unsigned candidate without Apple credentials. Merge it with
   **Create a merge commit**, not
   squash. Keep the `dev` branch.
5. The push to `main` automatically runs all checks, builds the tagged source,
   signs every executable, notarizes and staples the app, checks Gatekeeper,
   and uploads the zip and SHA-256 checksum. Only then is the draft published.

The promotion can be opened and merged with:

```sh
gh pr create --base main --head dev --title 'chore(release): promote dev'
gh pr merge --merge <promotion-pr-number>
```

There is no second release PR to merge on `main`, no manual version bump, and
no manual publish button. A direct feature PR into `main`, a reused version,
or source that differs from the prepared tag fails validation. An additional
fix after preparation needs a new generated release on `dev`, not a moved tag.

Tags are created during preparation because release-please needs them as the
boundary for its next changelog. They point to the prepared `dev` commit,
which the promotion merge preserves on `main`. The final `main` tree must
match that tag exactly. Keep `dev` as the default branch: preparing a tag from
a non-default branch with changed workflows can require a separate token with
workflow-write permissions. [GitHub release API](https://docs.github.com/en/rest/releases/releases#create-a-release).

The default `GITHUB_TOKEN` is sufficient; no release PAT is needed. GitHub may
hold a bot-created release PR's CI run for maintainer approval. Approve the
run rather than bypassing the branch check.
[GitHub token-triggered workflows](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs).

## Downloads and updates

Published assets appear in [GitHub Releases](https://github.com/tronschell/emma/releases):

- `Emma-vX.Y.Z-darwin-arm64.zip`
- `Emma-vX.Y.Z-darwin-arm64.zip.sha256`

Extract the zip and move `Emma.app` into Applications. The app includes its
Rust host, Zig harness, ripgrep, four native helpers, bundled skills, and
dependency notices. End users do not need Node, Rust, Zig, or Xcode installed.

The release title is exactly `vX.Y.Z`, matching the existing updater's version
parser. The stable `darwin-arm64.zip` asset is compatible with the existing
`update.electronjs.org` feed. Testing an actual update requires two signed
published versions; local unsigned packages are not an update-install test.

## Apple credentials

Keep these in repository Actions secrets, never in source or artifacts:

| Secret | Value |
| --- | --- |
| `MACOS_CERT_P12` | Base64-encoded Developer ID Application certificate and private key exported as `.p12` |
| `MACOS_CERT_PASSWORD` | Password used when exporting that `.p12` |
| `APPLE_API_KEY_P8` | Base64-encoded App Store Connect team API private key |
| `APPLE_API_KEY_ID` | The API key ID |
| `APPLE_API_ISSUER` | The API key's issuer ID |

All five secret names were present when inspected on August 28, 2026. Their
presence does not prove that the certificate, password, team, or API key is
valid. The first successful notarized GitHub build is the end-to-end check.

The release job fails before compiling if a secret is missing, requires a
Developer ID Application identity, signs only after locale trimming, and
removes its temporary certificate, private key, and keychain on exit. PR checks
never receive signing secrets. Actions must be allowed to create pull requests
under Settings → Actions → General; that permission was enabled when inspected.

## Local verification

Run the six checks in [`AGENTS.md`](../AGENTS.md), then:

```sh
npm run package:mac
```

Packaging needs full Xcode for `actool`, not only the Command Line Tools. It
uses the selected Xcode, or `/Applications/Xcode.app` when the selected tools
are only the CLT. `DEVELOPER_DIR` can select another Xcode installation.

The package script sets the Rust and Zig deployment floor, stamps the released
root version into the copied app without changing `desktop/package.json`,
includes only compiled runtime files in `app.asar`, generates dependency
notices, and verifies the bundle's version, executables, architecture, minimum
OS, preload, and renderer. Native helpers may link only to macOS system
libraries; the pinned ripgrep 15.2.0 has statically linked PCRE2 and does not
require Homebrew. Packaged native and search self-tests run before it succeeds.

Use another output directory to avoid replacing a running development bundle:

```sh
npm --prefix desktop run package:mac -- /tmp/emma-release-check
```

Launch the resulting app with an isolated profile and data directory and
exercise the workspace before release. Keep privacy prompts, global shortcuts,
VoiceOver, display geometry, macOS 12 hardware, real signing/notarization, and
update installation on the manual verification checklist. A successful build
does not verify those behaviors. Windows and Intel Mac packages are not shipped.

The release-policy regression test also runs inside `npm run check`:

```sh
node --test desktop/test/release.test.mjs
```

### Readiness check: August 28, 2026

All six repository checks passed locally, including 628 desktop tests and the
Rust and Zig suites. Workflow validation passed with actionlint. An isolated
unsigned package passed its bundle and native-binary checks, launched, and
created and renamed a thread through its normal preload/host bridge. The
thread survived a restart and appeared in the packaged workspace.

Mouse automation failed in the local control tool, so click-through testing is
not verified. Startup also logged the existing `emma:terminal-list` error
`Terminal thread is invalid`; thread persistence still worked. The update feed
was deliberately disabled during this smoke test. Apple credential validity,
signed installation and updating, privacy permissions, shortcuts, VoiceOver,
display geometry, and macOS 12 hardware remain unverified. The new workflow
has not yet run on GitHub, and no release was published by this readiness check.

## Recovery

Rerun a failed release workflow after correcting the cause. A signing,
notarization, or upload failure leaves the release as a draft. Reruns may replace
draft assets but never overwrite a published release. The notarized zip is also
retained as a workflow artifact for 14 days if publication fails after packaging.

The workflow can be run manually on `dev` to retry preparation, or on `main` to
retry its current prepared release. It refuses publication from feature
branches. Do not manually publish an empty draft, move a tag, or push a fix
directly to `main` to recover a failed build. Prepare a new version on `dev`
when a source change is necessary.

Windows support belongs in a later platform change: port the native helpers
and host integrations, then add and verify Windows packaging. This workflow
does not imply that the current application runs on Windows.
