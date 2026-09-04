# Releasing Emma

Emma currently targets **macOS 12 or later on Apple silicon** and **Windows 10
version 1809 or later on x64**. GitHub Actions builds it on standard `macos-15`
and `windows-2025` (x64) runners.

## Branches

```text
feature branch → dev → main → signed macOS download
```

`dev` is the default branch. Anyone opens feature PRs against it, and every PR
runs the full `ci` workflow on macOS and Windows. `main` holds released code.
Only the repository owner can update `main`; a GitHub ruleset blocks everyone
else from merging into it.

```sh
git fetch origin
git switch -c feat/my-change origin/dev
gh pr create --base dev
```

## Release a version

1. On `dev`, bump the root `package.json` version in a normal PR, or run
   `npm version patch --no-git-tag-version` and commit it.
2. Open a `dev` → `main` PR and merge it with **Create a merge commit**.
3. The promotion PR carries the required checks. After it is merged, the push
   to `main` runs `ci` against the exact promoted commit and packages an unsigned
   candidate. The successful candidate workflow then triggers `release`, which
   verifies that candidate, signs, notarizes, staples, checks Gatekeeper, and
   publishes `vX.Y.Z` with the automatically collected changelog. A manual
   release dispatch retains a direct package fallback.

There is no changelog file, release PR, manifest, or tag to manage. The
GitHub Releases page is the changelog. Merging `main` again with an unchanged
version publishes nothing.

## Automatic changelog

The existing release job runs [`release-notes.mjs`](../desktop/scripts/release-notes.mjs)
before building. It compares the most recently published stable release with the
exact commit being released. Drafts, prereleases, and unpublished tags do not
move that starting point. GitHub supplies the commit range with pagination, so
changes merged through `dev` and direct commits are included even in large
releases. Promotion merge commits do not become changelog entries.

Conventional titles group entries into Breaking changes, Features, Fixes,
Performance, Documentation, and Other changes. Each entry links to its PR or
commit and credits its author. Its committed `## Release notes` section supplies
the detailed bullets; older commits without that section use their titles.
Breaking-change footers retain their migration instructions. A full comparison
link connects the previous release to the exact source commit.

The [contribution skill](../.claude/skills/contributing/SKILL.md) routes agents to
the [release skill](../.claude/skills/releasing/SKILL.md) to write these summaries
as part of normal PR preparation. Emma's squash-merge settings already preserve
the PR title and body. There is no release-time collection or editing step for
the owner. A GitHub API failure stops the job before publication.

To preview the remote `dev` changelog with an authenticated GitHub CLI:

```sh
npm run release:notes
```

Optional arguments select a previous release and target GitHub ref, for example
`npm run release:notes -- v0.3.1 v0.4.1`. This prints Markdown without publishing
or changing anything. References resolve on GitHub, independent of local tags.

## Downloads and updates

Published macOS assets appear in [GitHub Releases](https://github.com/tronschell/emma/releases):

- `Emma-vX.Y.Z-darwin-arm64.dmg`
- `Emma-vX.Y.Z-darwin-arm64.dmg.sha256`
- `Emma-vX.Y.Z-darwin-arm64.zip`
- `Emma-vX.Y.Z-darwin-arm64.zip.sha256`

The disk image is the human download: open it and drag Emma onto the
Applications alias on the right. The centered Finder window uses Emma's rose
dither background, a drag instruction, and the root package version at the
bottom. `scripts/dmg-mac.mjs` draws the background at standard and Retina
resolution with macOS AppKit, then saves the icon positions and window geometry
with `ds_store` and `mac_alias`. The build needs Python 3.10 or later and installs
these two checksum-pinned build dependencies in a temporary virtual environment.
Packaging CI builds the image and verifies its layout, Retina artwork, and
background reference after remounting. The release job rebuilds it from the
stapled app, then signs, notarizes and staples the image itself.

Installing into Applications is not cosmetic. Squirrel replaces the bundle it
is running from, so a copy left in Downloads updates itself and leaves the one
in Applications behind. Worse, a browser marks that copy with the quarantine
attribute, and macOS runs a quarantined app the user never moved from a
read-only translocated path, where Squirrel cannot write at all and updates can
never apply.

The package includes its Rust host, Zig harness, ripgrep, native helpers,
bundled skills, and dependency notices. End users do not need Node, Rust, Zig,
or Xcode installed.

The release title is exactly `vX.Y.Z` and the stable `darwin-arm64.zip` asset
is the one the `update.electronjs.org` feed selects. Keep both, and keep
publishing the zip whatever else ships beside it. Drafts and prereleases are
not stable updates.

On macOS, a packaged app checks the feed at launch, on a five-minute tick, when
the machine wakes, and when a window takes focus, with any check inside thirty
minutes of the last one skipped. Wake and focus matter because a sleeping Mac
suspends the timer, so a window left open for days would otherwise never check
again. **Check for Updates…** in the Emma menu forces one past that gap and
reports the result either way. Squirrel downloads a newer eligible version in
the background, and Emma shows **Update ready · X.Y.Z** with **Install and
relaunch** once the download finishes.

The downloaded version is recorded in `update-ready.json` under the user data
directory, so quitting no longer forgets it and the notice returns on the next
launch. Squirrel can only install an update this process downloaded, so
installing from a restored notice re-downloads first and then relaunches. The
record is deleted once the running version is no longer older than it. The
unpackaged `EMMA_UPDATE_FAKE` mode only exercises the notice.

Windows CI runs tests only. Windows packaging, signing, and publication are not
wired into any workflow yet.

## Signing credentials

Keep these in repository Actions secrets, never in source or artifacts:

| Secret | Value |
| --- | --- |
| `MACOS_CERT_P12` | Base64-encoded Developer ID Application certificate and private key exported as `.p12` |
| `MACOS_CERT_PASSWORD` | Password used when exporting that `.p12` |
| `APPLE_API_KEY_P8` | Base64-encoded App Store Connect team API private key |
| `APPLE_API_KEY_ID` | The API key ID |
| `APPLE_API_ISSUER` | The API key's issuer ID |

The release job fails before compiling if a required secret is missing. It
signs after locale trimming and removes its temporary certificate, private key,
and keychain on exit. PR checks never receive signing secrets.

## Local verification

Run the six checks in [`AGENTS.md`](../AGENTS.md), then:

```sh
npm run package:mac
```

On a native Windows x64 host:

```powershell
npm --prefix desktop run package:win
```

macOS packaging needs full Xcode for `actool`, not only the Command Line Tools.
`DEVELOPER_DIR` can select another Xcode installation. Both package scripts
stamp the root version into the copied app without changing
`desktop/package.json`, include only compiled runtime files in `app.asar`, and
generate dependency notices, then verify the bundle's version, executables,
architecture, and native helpers.

Use another output directory to avoid replacing a running development bundle:

```sh
npm --prefix desktop run package:mac -- /tmp/emma-release-check
```

Launch the resulting app with an isolated profile and data directory and
exercise the workspace before release. A local unsigned package does not prove
signing, notarization, Gatekeeper acceptance, or update installation.

## Recovery

Rerun a failed `release` workflow after correcting the cause. Nothing is
published until every step succeeds, so a rerun is safe. Never edit a published
release's assets. If the source must change, land the fix on `dev`, bump the
version, and promote again.
