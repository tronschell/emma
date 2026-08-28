---
name: releasing
description: How Emma's changelog, CI, versioning, and builds work — conventional PR titles feed release-please, which writes CHANGELOG.md and cuts the tag; GitHub Actions runs the six checks on every PR and packages the macOS app on release. Use when writing a commit or PR title, adding or fixing a GitHub Actions workflow, cutting a release, bumping a version, asking where the changelog comes from, or asking how builds and distribution work.
---

# Releasing Emma

Nobody writes the changelog. Nobody bumps a version by hand. Both fall out of PR
titles.

## The one rule for contributors

**The PR title is the changelog entry.** Squash-merge, conventional commit form:

```
fix(notch): stop the island stealing focus from Quick Ask
feat(jobs): after <job-id> triggers
```

`type(scope): summary` — scope optional, `!` after it for a breaking change.
[`ci.yml`](../../../.github/workflows/ci.yml) fails the PR if the title does not
parse.

| Type | In the changelog | Bumps |
| --- | --- | --- |
| `feat` | Features | minor |
| `fix` | Bug Fixes | patch |
| `perf` | Performance | patch |
| `refactor` `docs` `test` `build` `ci` `chore` `revert` | hidden | none |
| any type with `!`, or a `BREAKING CHANGE:` body | Breaking | major |

Commits inside the PR do not matter — squash uses the title.

## What you must not do

- **Do not edit `CHANGELOG.md`.** It is generated. A hand-written entry is
  overwritten or duplicated at the next release.
- **Do not bump `version` in `package.json` or `Cargo.toml` in a PR.**
  release-please owns the root `package.json` version;
  [`release.yml`](../../../.github/workflows/release.yml) stamps
  `desktop/package.json` at package time so the built `Emma.app` carries the
  released version. A hand bump collides with the release PR.
- **Do not tag manually.** Merging the release PR creates the tag.
- **No comments in the workflow YAML.** `AGENTS.md` covers config too. If a step
  needs explaining, name the step.

## The flow

1. PR merges to `main` with a conventional title.
2. `release.yml` runs release-please, which opens or updates a standing
   **`chore(main): release X.Y.Z`** PR containing the `CHANGELOG.md` diff and
   the version bump. It sits there accumulating entries until someone merges it.
3. Merging that PR tags `vX.Y.Z` and publishes the GitHub Release.
4. The same workflow then packages `Emma.app` on a macOS runner and attaches
   `Emma-vX.Y.Z-darwin-arm64.zip` to that release.

One repo setting has to be on before step 2 works: **Settings → Actions →
General → Allow GitHub Actions to create and approve pull requests.** Without it
release-please fails with `GitHub Actions is not permitted to create pull
requests` and no release PR ever appears.

Releasing is therefore one action: **merge the release PR.** Nothing else cuts a
release, and nothing releases on a schedule.

## CI

[`ci.yml`](../../../.github/workflows/ci.yml) runs on every PR and every push to
`main`, on one `macos-15` runner, and is the six checks from
[`AGENTS.md`](../../../AGENTS.md), the title check, and `npm run build:native` —
the clang builds of `desktop/native/` and their two `--self-test` binaries, which
`npm run check` does not cover and which take about two seconds. Nothing is
CI-only; every step reproduces locally with the same command. If CI fails on a
step you cannot reproduce, suspect a stale local build before suspecting the
runner.

Pinned in the workflow and duplicated from the repo's own pins — change both
together: **Node 24**, **Zig 0.16.0** (also
[`harness/build.zig.zon`](../../../harness/build.zig.zon)), macOS runner image.
Rust follows [`rust-toolchain.toml`](../../../rust-toolchain.toml) on its own.

Third-party actions are pinned to a full commit SHA, never a tag — a mutable tag
is code execution the repo did not review, and `release.yml` runs one of them in
the job that unlocks the signing keychain. First-party `actions/*` stay on tags.
The convention elsewhere writes the version in a trailing comment; comments are
banned here, so the version goes in the step's `name` instead. Re-pin with
`gh api repos/OWNER/REPO/git/ref/tags/TAG`, and update the `name` to match. If
that returns `"type": "tag"` the tag is annotated and the SHA is the tag object,
not the commit — dereference it with `gh api repos/OWNER/REPO/git/tags/SHA` and
pin `.object.sha`. `release-please-action` is annotated; `setup-zig` is not.

Both workflows declare `permissions:` explicitly rather than inheriting the
repository default. `ci.yml` needs only `contents: read`. In `release.yml` the
scope is per job: `changelog` needs `contents: write` and `pull-requests: write`
for release-please, `package` only `contents: write` for `gh release upload`.

## Builds and money

Public repos get unlimited free Actions minutes on standard runners, macOS
included, so both workflows cost nothing. Larger runners are not free; do not
reach for them.

What is **not** free:

- **Signing and notarization.** These need a paid Apple Developer Program
  account. `release.yml` wires both up, but they only run once
  `MACOS_CERT_P12`, `MACOS_CERT_PASSWORD`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`
  and `APPLE_API_ISSUER` are in repo secrets; without them the release job fails
  at the import step. `npm run package:mac` alone still produces an unsigned
  bundle, which Gatekeeper blocks on any Mac but the one that built it. See
  [`docs/development.md`](../../../docs/development.md).
- **Fork PRs cannot read secrets.** Any signing step must live in the release
  job on the main repo, never in the PR job — a workflow that needs a secret to
  pass turns every outside contribution red.

Packaging is **not** exercised on PRs — it is minutes-expensive and the release
job is the first thing that runs it. A PR that changes `package:mac`,
`electron-packager` flags, `native/`, or `vendor:ripgrep` must be packaged
locally before merge:

```sh
npm run package:mac
```

## The other repos

The phone app ([tronschell/emma-mobile](https://github.com/tronschell/emma-mobile),
see [`docs/mobile.md`](../../../docs/mobile.md)) and the website are separate
public repos and follow the same contract: conventional PR titles,
release-please, free runners. Their differences are downstream of the platform,
not of the process — iOS distribution needs the same paid Apple account as
signing here, Android and the site do not, and the relay Worker deploys from its
own repo to the operator's own Cloudflare account. Emma's version numbers and
theirs are independent; do not try to lock them together.
