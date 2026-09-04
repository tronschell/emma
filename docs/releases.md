# Releasing Emma

Emma currently targets **macOS 12 or later on Apple silicon** and **Windows 10
version 1809 or later on x64**. GitHub Actions builds it on standard `macos-15`
and `windows-2025` (x64) runners.

## Branches

```text
feature branch → dev → main → signed macOS download
```

`dev` is the default branch. Anyone opens feature PRs against it, and every PR
runs the full `ci` workflow on macOS. `main` holds released code.
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
3. The push to `main` runs the `release` workflow. It reads the version from
   the root `package.json`, skips if that release already exists, and otherwise
   packages, signs, notarizes, staples, checks Gatekeeper, and publishes
   `vX.Y.Z` with GitHub's generated release notes.

There is no changelog file, release PR, manifest, or tag to manage. The
GitHub Releases page is the changelog, built from merged PR titles. Merging
`main` again with an unchanged version publishes nothing.

## Downloads and updates

Published macOS assets appear in [GitHub Releases](https://github.com/tronschell/emma/releases):

- `Emma-vX.Y.Z-darwin-arm64.dmg`
- `Emma-vX.Y.Z-darwin-arm64.dmg.sha256`
- `Emma-vX.Y.Z-darwin-arm64.zip`
- `Emma-vX.Y.Z-darwin-arm64.zip.sha256`

The disk image is the human download: open it and drag Emma onto the
Applications alias beside it. Quit Emma before replacing an installed copy,
choose **Replace** if Finder asks, eject the image, and open Emma from
Applications. This replaces only the app bundle; `app.getPath('userData')`, the
separate `EMMA_DATA_DIR` store, and the user's notes vault stay in place. The
package includes its Rust host, Zig harness, ripgrep, native helpers, bundled
skills, and dependency notices. End users do not need Node, Rust, Zig, or Xcode
installed.

The single-instance lock belongs to the running process, regardless of which
version or bundle was opened next. A packaged Mac copy that cannot acquire it
shows its own version and bundle path and explains how to quit, replace, and
reopen Emma. A newer primary also refuses to focus its older window for a newer
launch. Older releases cannot participate in that handoff, so quitting before
installation remains required.

The release title is exactly `vX.Y.Z` and the stable `darwin-arm64.zip` asset
is the one the `update.electronjs.org` feed selects. Keep both the DMG and ZIP.
Drafts and prereleases are not stable updates.

On macOS, a packaged app checks the feed at launch and every six hours. Squirrel
downloads a newer eligible version in the background. Only after the download
finishes does Emma show **Update ready · X.Y.Z** with **Install and relaunch**.
The unpackaged `EMMA_UPDATE_FAKE` mode only exercises the notice.

There is no Windows CI. The desktop suite is written against POSIX fixtures and
`build-native.mjs` calls `rc.exe`, so the lane never passed; it was removed
rather than left red. Windows packaging, signing, and publication are not wired
into any workflow either.

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
npm run dmg:mac
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
The DMG builder requires a structurally valid app signature, verifies the
mounted app and Applications link, and refuses to overwrite an existing image.
Use a fresh output path for each verification run.

## Recovery

Rerun a failed `release` workflow after correcting the cause. Nothing is
published until every step succeeds, so a rerun is safe. Never edit a published
release's assets. If the source must change, land the fix on `dev`, bump the
version, and promote again.
