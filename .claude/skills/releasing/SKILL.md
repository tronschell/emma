---
name: releasing
description: Prepare and publish Emma releases through feature branches, dev, and main; conventional PR titles feed generated versions and changelogs, and main publishes the signed macOS app. Use for release workflows, versioning, packaging, and distribution changes.
---

# Releasing Emma

Read [`docs/releases.md`](../../../docs/releases.md) for the branch flow,
credentials, verification, and recovery procedures before changing or running
release automation.

## Invariants

- Feature branches start from and squash-merge into `dev`, the default branch.
  Conventional PR titles and bodies become the squash commits.
- release-please owns the root version, `.release-please-manifest.json`, and
  `CHANGELOG.md`. Do not hand-edit release metadata or tags.
- The generated release PR targets `dev`. Merging it creates a tag and a draft
  release, never a public download. Keep `draft` and `force-tag-creation` enabled
  in `release-please-config.json` so later changelogs have a release boundary.
- Promote the exact prepared tree from `dev` to `main` with a merge commit,
  never squash. `desktop/scripts/release.mjs` checks the branch, version,
  manifest, tag ancestry, and tree. A later change needs another prepared version.
- A push to `main` runs the shared CI workflow before packaging. Signing,
  notarization, stapling, Gatekeeper validation, and asset upload must all
  succeed before the draft becomes public. Published releases are not replaced.
- Release preparation and publication are separate jobs. Only preparation,
  draft validation, and publication receive write permissions. GitHub requires
  push access to read draft releases; keep `contents: write` on `plan` even though
  it only reads release state. PR checks receive no Apple secrets.
- Sign after locale trimming. Keep native executables, skills, and dependency
  notices in the package. `npm run package:mac` verifies the unsigned bundle;
  signing and a real update installation still need separate verification.
- Keep release names exactly `vX.Y.Z` and the stable zip suffix
  `darwin-arm64.zip`, as expected by the existing updater.

## Workflow edits

Run the six checks in [`AGENTS.md`](../../../AGENTS.md). Package locally when
changing the build, resources, target, signing, or notarization path, and launch
and exercise the resulting app. Report unverified platform behavior.

Keep Node 24, Zig 0.16.0, and the macOS runner aligned with the repository pins.
Third-party actions use full commit SHAs; first-party `actions/*` use version
references. Put action versions in step names, not YAML comments. Do not add
Windows packaging before the native platform paths have been ported and tested.

Preparing release infrastructure does not authorize publishing a release or
merging unrelated work. Preserve existing dirty changes and leave a failed
release as a draft until its cause is fixed.
