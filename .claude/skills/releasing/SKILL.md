---
name: releasing
description: Prepare and publish Emma releases; feature PRs land on dev, the owner merges dev into main, and main publishes the signed macOS app from the root package.json version. Use for release workflows, versioning, packaging, and distribution changes.
---

# Releasing Emma

Read [`docs/releases.md`](../../../docs/releases.md) for the branch flow,
credentials, verification, and recovery before changing or running release
automation.

## Invariants

- Feature branches start from and squash-merge into `dev`, the default branch.
  `ci.yml` runs the full checks on every PR, on macOS only. There is no Windows
  lane; it never passed and was removed.
- The root `package.json` version is the release version. Bump it on `dev`.
  Nothing else carries version metadata, and there is no changelog file.
- Only the owner can update `main`, enforced by a GitHub ruleset, not by code.
  Promote `dev` to `main` with a merge commit.
- `release.yml` runs on push to `main`. It skips when the `vX.Y.Z` release
  already exists. Otherwise signing, notarization, stapling, Gatekeeper
  validation, and asset upload must all succeed before `gh release create`
  publishes with generated notes. Published releases are never replaced.
- PR checks receive no Apple secrets. Only the release job has `contents: write`.
- Keep release names exactly `vX.Y.Z` and the stable zip suffix
  `darwin-arm64.zip`, as expected by the existing updater.

## Workflow edits

Run the six checks in [`AGENTS.md`](../../../AGENTS.md). Package locally when
changing the build, resources, target, signing, or notarization path, and launch
and exercise the resulting app. Report unverified platform behavior.

Keep Node 24, Zig 0.16.0, and the macOS runner aligned with the repository pins.
Third-party actions use full commit SHAs; first-party `actions/*` use version
references. Put action versions in step names, not YAML comments.

Preparing release infrastructure does not authorize publishing a release or
merging unrelated work.
