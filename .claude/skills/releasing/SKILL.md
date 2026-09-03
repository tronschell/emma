---
name: releasing
description: Capture Emma changelog entries when preparing feature PRs and prepare or publish releases. Feature PRs land on dev, the owner merges dev into main, and main publishes the signed macOS app from the root package.json version. Use for PR release summaries, release workflows, versioning, packaging, and distribution changes.
---

# Releasing Emma

Read [`docs/releases.md`](../../../docs/releases.md) for the branch flow,
credentials, verification, and recovery before changing or running release
automation.

## Invariants

- Feature branches start from and squash-merge into `dev`, the default branch.
  `ci.yml` runs the full checks on every PR, on macOS and Windows. Windows is
  test-only; it packages nothing.
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

## Capture changes in feature PRs

Write the release summary while preparing or updating the PR, using its complete
diff against `dev`. Describe the final shipped behavior and relevant fixes,
compatibility changes, and migration steps. The agent doing the work writes the
summary without asking the owner to compose changelog entries.

Use a descriptive conventional title: `feat`, `fix`, `perf`, or `docs` selects
the release section; other titles remain under Other changes. Mark incompatible
changes with `!` or a `BREAKING CHANGE:` footer.

Add a `## Release notes` section to the PR body with plain Markdown bullets for
each meaningful change. Keep implementation discussion and validation under
separate level-two headings. Update the notes when the scope changes; describe
only changes present in the final diff. For direct commits, put the same section
in the commit body when the title alone is insufficient.

GitHub already uses `PR_TITLE` and `PR_BODY` for Emma squash commits. Preserve
the release section when supplying a custom squash message. The release job
reads this committed snapshot, so edits to a merged PR do not rewrite history.
Older commits without this section fall back to their titles. No extra labels,
changelog file, version bump, or release action is needed to record a change.

`npm run release:notes` previews the published-release-to-remote-`dev` range.
Use `npm run release:notes -- v0.3.1 v0.4.1` to inspect a specific GitHub range.
Both commands only print Markdown; they create no release, tag, or file.

## Workflow edits

Run the six checks in [`AGENTS.md`](../../../AGENTS.md). Package locally when
changing the build, resources, target, signing, or notarization path, and launch
and exercise the resulting app. Report unverified platform behavior.

Keep Node 24, Zig 0.16.0, and the macOS runner aligned with the repository pins.
Third-party actions use full commit SHAs; first-party `actions/*` use version
references. Put action versions in step names, not YAML comments.

Preparing release infrastructure does not authorize publishing a release or
merging unrelated work.
