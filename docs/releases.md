# Releasing Emma

Emma currently targets **macOS 12 or later on Apple silicon** and **Windows 10
version 1809 or later on x64**. GitHub Actions builds it on standard `macos-15`,
`windows-2025` (x64), and `windows-11-vs2026-arm` (ARM64) runners. x64 is the
supported distributable/public target; ARM64 is a CI compile/package rehearsal,
not a public auto-update target. A personal computer or self-hosted runner is not required.

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
   then package unsigned macOS and Windows x64 candidates plus an ARM64
   rehearsal without signing credentials. Merge it with
   **Create a merge commit**, not
   squash. Keep the `dev` branch.
5. The push to `main` automatically runs all checks, builds the tagged source,
   signs every macOS executable, notarizes and staples the app, checks
   Gatekeeper, and uploads the validated macOS assets. Windows CI has already
   built the unsigned x64 target package and ARM64 rehearsal on the promotion PR,
   but this release workflow does not sign or upload Windows artifacts. Public
   signed Windows x64 publication is pending release-workflow authorization.
   Only then is the draft published.

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

Published macOS assets appear in [GitHub Releases](https://github.com/tronschell/emma/releases):

- `Emma-vX.Y.Z-darwin-arm64.zip`
- `Emma-vX.Y.Z-darwin-arm64.zip.sha256`

Windows CI rehearsal artifacts include unsigned
`Emma-X.Y.Z-win32-x64-Setup.exe` and `Emma-X.Y.Z-win32-arm64-Setup.exe`, plus
matching `.nupkg`, `RELEASES`, and `SHA256SUMS` Squirrel assets. The x64 package
is the supported distributable/public target; ARM64 artifacts are compile/package
rehearsals and neither is a public release download yet.

Extract the macOS zip and move `Emma.app` into Applications. The Windows
rehearsal package installs `Emma.exe` with Squirrel. Either package includes its
Rust host, Zig harness, ripgrep, four native helpers, bundled skills, and
dependency notices. End users do not need Node, Rust, Zig, or Xcode installed.

The release title is exactly `vX.Y.Z`, matching the existing updater's version
parser. The stable `darwin-arm64.zip` asset is the one the
`update.electronjs.org` feed selects. Windows x64 signing, publication, and a
public Squirrel feed are pending release-workflow authorization; ARM64 has no
public feed. Drafts and
prereleases are not stable updates.

On macOS, a packaged app checks the feed at launch and every six hours. Squirrel
downloads a newer eligible version in the background. Only after the download
finishes does Emma show **Update ready · X.Y.Z** with **Install and relaunch**.
That button calls Electron's native updater to replace the app and restart it.
There is no custom download-progress screen. The unpackaged `EMMA_UPDATE_FAKE`
mode only exercises the notice; its install button does not install or restart.

A local rehearsal can exercise real replacement and restart using two signed
copies and `EMMA_UPDATE_URL` pointed at a loopback feed. An ad-hoc-signed mock is
not evidence of Developer ID signing, notarization, Gatekeeper acceptance or the
public GitHub-to-Electron feed. Verify that distribution path with an upgrade
between published signed versions. Never publish a mock version to test the UI.

## Signing credentials

Keep these in repository Actions secrets, never in source or artifacts:

| Secret | Value |
| --- | --- |
| `MACOS_CERT_P12` | Base64-encoded Developer ID Application certificate and private key exported as `.p12` |
| `MACOS_CERT_PASSWORD` | Password used when exporting that `.p12` |
| `APPLE_API_KEY_P8` | Base64-encoded App Store Connect team API private key |
| `APPLE_API_KEY_ID` | The API key ID |
| `APPLE_API_ISSUER` | The API key's issuer ID |

Their presence does not prove that any certificate, password, team, or API key
is valid. The first successful signed and notarized GitHub build is the
end-to-end check. The current release workflow does not consume Windows signing
secrets; public signed Windows publication requires an authorized workflow
change.

The release job fails before compiling if a required Apple secret is missing.
The macOS job requires a Developer ID Application identity, signs only after
locale trimming, and removes its temporary certificate, private key, and
keychain on exit. PR checks never receive signing secrets. Actions must be allowed to create pull requests
under Settings → Actions → General; that permission was enabled when inspected.

The plan job also needs `contents: write` to inspect the prepared draft through
GitHub's API; it does not publish it. GitHub exposes drafts only to callers with
repository push access. [GitHub release visibility](https://docs.github.com/en/rest/releases/releases#list-releases).

## Local verification

Run the six checks in [`AGENTS.md`](../AGENTS.md), then:

```sh
npm run package:mac
```

On a native Windows x64 or ARM64 host, the unsigned package structure can be exercised with:

```powershell
npm --prefix desktop run package:win
```

A local unsigned package does not prove certificate trust, SmartScreen behavior,
Squirrel installation, or update compatibility. Public signed Windows
publication remains pending release-workflow authorization.

macOS packaging needs full Xcode for `actool`, not only the Command Line Tools. It
uses the selected Xcode, or `/Applications/Xcode.app` when the selected tools
are only the CLT. `DEVELOPER_DIR` can select another Xcode installation.

The macOS package script sets the Rust and Zig deployment floor. Both package
scripts stamp the released root version into the copied app without changing
`desktop/package.json`, include only compiled runtime files in `app.asar`, and
generate dependency notices. The macOS path verifies the bundle's version,
executables, architecture, minimum OS, preload, renderer, and macOS-system-only
native links, then runs packaged native and search self-tests. The Windows path
verifies its version, executables, architecture, preload, renderer, and Squirrel
assets; `build:native` runs each Windows helper self-test. The pinned ripgrep
15.2.0 has statically linked PCRE2 and does not require Homebrew.

Use another output directory to avoid replacing a running development bundle:

```sh
npm --prefix desktop run package:mac -- /tmp/emma-release-check
```

Launch the resulting app with an isolated profile and data directory and
exercise the workspace before release. Keep privacy prompts, global shortcuts,
VoiceOver, display geometry, macOS 12 hardware, real signing/notarization, and
update installation on the manual verification checklist. A successful build
does not verify those behaviors. On Windows, a real x64 host still needs manual
validation of Setup installation, SmartScreen, native helpers, and upgrades
between signed versions; the current workflow produces no signed public
installer. ARM64 Windows is validated by CI compile/package checks only and is
not a public installer or auto-update target.

The release-policy regression test also runs inside `npm run check`:

```sh
node --test desktop/test/release.test.mjs
```

### Readiness evidence

Record the candidate commit, check results and manual limits in
[release-readiness.md](release-readiness.md). Passing results from an older tree
are not evidence for a new candidate. Keep local packaging and mock-update
results separate from successful GitHub signing, notarization and public-feed
updates; a green test suite alone does not establish release readiness.

## Recovery

Rerun a failed release workflow after correcting the cause. A signing,
notarization, or upload failure leaves the release as a draft. Reruns may replace
draft assets but never overwrite a published release. The notarized zip is also
retained as a workflow artifact for 14 days if publication fails after
packaging.

The workflow can be run manually on `dev` to retry preparation, or on `main` to
retry its current prepared release. It refuses publication from feature
branches. Do not manually publish an empty draft, move a tag, or push a fix
directly to `main` to recover a failed build. Prepare a new version on `dev`
when a source change is necessary.

The release workflow publishes only the supported macOS Apple-silicon assets.
Windows x64 is the supported distributable/public target and is rehearsed
unsigned in CI. Windows ARM64 is also packaged in CI for compile/package
validation only and is not a public installer or auto-update target. Signed x64
publication requires an authorized release workflow.
