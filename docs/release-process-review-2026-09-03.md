# Release process review — September 3, 2026

Use one protected development branch (`dev`), one trusted candidate build, and one owner-approved signing/publication job. Keep the current Electron, Rust, Zig, and GitHub toolchain. The actionable problems are repeated builds, branch promotion friction, and a secondary dependency installation that is not locked.

This is a proposal, not an implementation. The reviewed checkout was `d51d07a9f744c78e7a972cb51041a3b4e4a0fbc7`, tree `373111a9e0b96b1f1ec61c75a21d94e5504f5b75`, matching released `main` at `e023f351f41131b07bde759af6cdb0e3f28eea7f`. The dirty development checkout was not used as source evidence. [v0.4.1 is published](https://github.com/tronschell/emma/releases/tag/v0.4.1).

## What this release measured

| Successful run | Job duration | Zig tests | Packaging |
| --- | ---: | ---: | ---: |
| [Feature PR #35 CI](https://github.com/tronschell/emma/actions/runs/33764477916/job/100678710959) | 11m33s | 4m46s | 3m50s |
| [Promotion PR #36 CI](https://github.com/tronschell/emma/actions/runs/33765901079/job/100683565352) | 13m30s | 6m30s | 4m02s |
| [Release publication](https://github.com/tronschell/emma/actions/runs/33767469447/job/100688894334) | 7m14s | — | 3m46s |

These three serial jobs consumed **32m17s** of active job time, excluding queueing, owner actions, local verification, and failed attempts. Packaging ran three times and consumed **11m38s**. Publication after the final package used 21s for signing, 2m18s for notarization/stapling/Gatekeeper, and 29s for archiving/upload/publication. Apple processing time is variable.

The published ZIP is **204,537,325 bytes**. The local zvec-grep vendor tree contains **6,308 regular files / 261,661,406 logical bytes (249.5 MiB)**; allocated disk size is larger. These are different measurements, not a predicted ZIP reduction.

The successful recovery already added production packaging and strict ad-hoc signature verification to every PR, preserved relative resource symlinks with `cpSync(..., { verbatimSymlinks: true })`, removed unused `onnxruntime-web`, and initialized Electron before parallel tests. Preserve those fixes. [PR #35](https://github.com/tronschell/emma/pull/35)

## Ranked changes

### 1. Replace promotion branches with a trusted release candidate

Keep feature PRs and squash merges into protected `dev`. Retain `main` as historical released history while retiring it from future promotion; future immutable tags identify released source. This avoids changing the default branch and removes repeated ancestry repair, promotion PRs, and the administrator-merge surprise encountered in this release.

The target sequence is:

```text
PR → full secretless CI → protected dev
owner release dispatch → full trusted checks + package → owner approval
→ sign → notarize → staple → Gatekeeper → upload draft assets → publish
```

Start with an on-demand release workflow restricted to `refs/heads/dev`. Capture its exact commit once. Its preparation jobs receive no Apple secrets and run all six repository checks plus the production package. The final job consumes that verified package and does no compilation. Required PR checks remain mandatory; preparation deliberately rechecks the actual release commit, keeping the initial migration simple and auditable.

Move Apple secrets into a GitHub environment restricted to `dev`, with `tronschell` as the sole required reviewer. Permit that owner to approve a run they initiated; preventing self-review would deadlock a sole-reviewer workflow. Keep `contents: write` only on the publication job and require owner review of release-workflow changes. Configure and test the environment before retiring the current owner-only `main` control. This public repository supports GitHub's environment reviewers, branch restrictions, and secret gating. [Environment configuration](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

Pass the candidate between jobs in a tar archive that preserves executable bits and relative symlinks. Record the repository, exact source SHA, tree, root version, run/attempt, toolchain versions, lockfile digests, artifact ID, and archive SHA-256. Select that artifact from the same trusted workflow run, require all preparation jobs to succeed, and fail on checksum or metadata disagreement. GitHub documents permission loss for loose artifact uploads and only a warning on automatic digest mismatch. [Artifact transport](https://github.com/actions/upload-artifact#permission-loss), [digest validation](https://docs.github.com/en/actions/tutorials/store-and-share-data#validating-artifacts)

Never sign a PR artifact, use an artifact named “latest,” or treat a matching source tree as binary provenance. The harness embeds `git rev-parse HEAD`, so commits with identical trees produce different build metadata. A trusted rerun may reuse its exact candidate artifact; an expired or missing candidate requires a fresh verified build. [Embedded commit](https://github.com/tronschell/emma/blob/e023f351f41131b07bde759af6cdb0e3f28eea7f/harness/build.zig#L421), [GitHub's trust-boundary guidance](https://docs.github.com/en/actions/reference/security/secure-use#mitigating-the-risks-of-untrusted-code-checkout)

**Benefit estimate:** this replaces promotion CI with trusted preparation and removes the final 3m46s package rebuild. Allowing for artifact transfer, expect roughly **2–3 minutes saved before parallelizing tests**, plus fewer manual operations. Removing the promotion PR does not justify claiming all 13m30s as saved while retaining those checks.

### 2. Lock the vendor payload and verify every native dependency

The desktop installation uses `npm ci`, but `vendor-zvec-grep.mjs` generates another manifest and runs `npm install --no-package-lock`. Pinning `@zvec/zvec-grep@0.2.1` does not pin its transitive dependencies. Its reuse stamp also excludes the installer/pruning logic, so an existing local vendor directory can survive a script change. [Vendor installer](https://github.com/tronschell/emma/blob/e023f351f41131b07bde759af6cdb0e3f28eea7f/desktop/scripts/vendor-zvec-grep.mjs#L7)

Commit a small separate vendor manifest and lockfile, copy them into the staging directory, and use `npm ci --omit=dev --ignore-scripts`. Invalidate the vendor stamp using the lockfile, installer script, OS, and architecture. Retain the existing checksum-pinned ripgrep download and symlink-preserving resource copy. This uses npm's existing dependency mechanism; `npm ci` rejects manifest/lock disagreements. [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/)

The current native check skips directory resources, including all of zvec-grep. Local `otool -l` inspection found:

| Bundled backend | Declared minimum macOS |
| --- | --- |
| ONNX binding and `libonnxruntime.1.21.0.dylib` | 13.3 |
| llama Metal addon and its three dylibs | 14.0 |
| App bundle and top-level Emma helper target | 12.0 |

This is evidence of a feature compatibility gap, not proof that the entire app fails on macOS 12. Recursively inventory Mach-O files, validate architecture and dependency resolution, and exercise backend imports through the packaged Electron binary. Choose compatible pinned binaries or explicitly gate affected features by OS; changing the whole app's minimum version is a separate product decision. Preserve notices when pruning. [Current top-level verification](https://github.com/tronschell/emma/blob/e023f351f41131b07bde759af6cdb0e3f28eea7f/desktop/scripts/package-mac.mjs#L113)

**Benefit:** fewer moving inputs and earlier compatibility failures. No download-size or build-time reduction has been measured for locking.

### 3. Run Zig tests alongside desktop/Rust/package checks

The current single macOS job serializes everything. Put `zig build test` on a second macOS runner while the existing desktop/Rust/package sequence runs on the first. Keep one required final `check` that fails if either lane fails, is cancelled, or is unexpectedly skipped. Apply the same commands to trusted release preparation. Use existing scripts; no task scheduler or build framework is needed. [Current CI](https://github.com/tronschell/emma/blob/e023f351f41131b07bde759af6cdb0e3f28eea7f/.github/workflows/ci.yml)

Delete the standalone CI `build:native` invocation: packaging already builds the helpers and runs their self-tests. That duplication cost 6–8s in the measured runs. Leave fresh production builds under `package:mac`'s ownership instead of adding general “skip build” flags. Keep Debug tests and the packaged ReleaseSafe harness; one does not substitute for the other.

**Estimate:** observed lane timings suggest **6–8 minutes** per complete validation/package stage after splitting, plus approximately **3–4 minutes** for signing/publication and transfer. Together with proposal 1, a release could take roughly **10–14 minutes after dispatch**, excluding owner waiting. These are critical-path estimates, not measured results or billing savings; extra runner setup and cache misses may offset some gain. Measure the first three runs before further optimization.

### 4. Keep the packaging/signing tools; extract only what gets reused

The existing package script already compiles independent components concurrently and validates its output. Keep `@electron/packager`, `@electron/osx-sign`, `notarytool`, `stapler`, `codesign`, and `spctl`. Put the reused seal/verify commands in one local runnable script when separating the trusted candidate from publication; leave credential import and GitHub publication in the workflow. Install locked signing-tool dependencies before importing credentials, and do not launch application code inside the credential-bearing job.

Switching to Forge would retain Packager and the same signing libraries underneath. It would still need Emma's custom resources, pruning order, native checks, and release constraints. There is no measured simplification that warrants that migration today. [Electron's supported signing paths](https://www.electronjs.org/docs/latest/tutorial/code-signing#using-electron-forge)

### 5. Remove obsolete release state and strengthen the existing contract

- Remote inspection confirmed [PR #25 “Main”](https://github.com/tronschell/emma/pull/25) and [PR #26 “chore(dev): release 0.3.2”](https://github.com/tronschell/emma/pull/26) are still open. Close them after checking that no unique work is needed. The reverse PR lets a `main` update trigger another CI run. Four assetless drafts also remain: `v0.2.0`, `v0.2.1`, `v0.2.2`, and `v0.3.0`; retire only confirmed obsolete drafts, preserving all published releases and tags.
- Correct `docs/releases.md`'s opening Windows support claim. Label the August release-readiness document as historical: its release-please and Windows-lane instructions conflict with today's release skill. There are currently only two workflows, both macOS; release-please is already removed from source.
- GitHub's release API reports `immutable: false` for v0.4.1. Today's no-replacement policy is enforced by workflow behavior and operator discipline. Have the owner enable GitHub immutability for future releases, stage all assets in a draft, verify them, then publish once. Built-in immutability locks assets/tags and adds a release attestation. Preserve all existing published bytes. [Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- Make the existing-version preflight distinguish a published release, a resumable draft from the same candidate, a conflicting draft, and an API failure. Currently any successful `gh release view` skips, including drafts; a failed API request is treated as absence. Resume only matching unpublished state and fail early on uncertainty. [Current preflight](https://github.com/tronschell/emma/blob/e023f351f41131b07bde759af6cdb0e3f28eea7f/.github/workflows/release.yml#L28)
- Verify tags against `tronschell/emma`'s remote API and dereference annotated tags when necessary. The local `v0.4.1` names upstream FX commit `36c94f94353a03b4d4b33540c028d16c85e50ed5`; the published Emma tag correctly names `e023f351f41131b07bde759af6cdb0e3f28eea7f`. Fetch upstream with `--no-tags` or configure that remote's `tagOpt`; preserve existing upstream tags and avoid tag-pruning shortcuts. [Git tag-fetch behavior](https://git-scm.com/docs/git-fetch#Documentation/git-fetch.txt---no-tags)
- Upgrade `actions/cache@v4` to supported Node 24 `@v5`. `mlugg/setup-zig` **v2.2.1 remains the latest published release** and still declares Node 20; this release succeeded with GitHub forcing Node 24. Keep its pinned SHA until a compatible upstream replacement is actually verified. Do not invent a newer version or introduce a custom installer solely to remove a warning. [Cache runtime](https://github.com/actions/cache#whats-new), [setup-zig release](https://github.com/mlugg/setup-zig/releases/tag/v2.2.1), [declared runtime](https://github.com/mlugg/setup-zig/blob/d1434d08867e3ee9daa34448df10607b98908d29/action.yml)

### 6. The meaningful radical option is retiring optional search payloads

zvec-grep is documented as experimental, and the harness already has a lexical search path when it is disabled. Retiring that experiment could remove its measured 249.5 MiB of uncompressed dependency payload and thousands of files, together with related native compatibility and signing work. That would remove local/hosted embedding features and requires a product decision; usage and compressed-size savings were not measured. [Current behavior](https://github.com/tronschell/emma/blob/e023f351f41131b07bde759af6cdb0e3f28eea7f/docs/harness.md#zvec-grep-mode)

If those features matter, retain the locked payload. Downloading executable backends after installation introduces another signed distribution/update path and is not the simple option. A GPUI/Tauri rewrite, a self-hosted Mac fleet, a custom updater, or a build-system replacement has no demonstrated benefit for this release problem. Revisit a platform rewrite only for separately measured product needs.

## Migration and gates

1. Land vendor locking, recursive native checks, documentation cleanup, the duplicate native-build deletion, and the verified cache-action update through normal PRs. Re-run all six checks, package, and exercise the real app. Resolve the backend OS support decision explicitly.
2. Add the trusted preparation artifact and local seal/verify command. Rehearse the artifact handoff without Apple secrets, including permissions, symlinks, checksum failure, and the packaged backend imports. Compare its reported source SHA with its embedded harness commit.
3. Have the owner configure the publication environment and future immutability. Rehearse a non-publishing run from protected `dev`; verify that other refs cannot use signing credentials and failed preparation cannot reach publication. Keep today's release path until this is proven. Then update the repository contract and retire promotion PRs.
4. Split the Zig lane, retaining the required aggregate check. Use the first three successful runs to decide whether caches or more parallelism are worth additional configuration.

Retain full PR and candidate checks; production ReleaseSafe packaging; portable symlinks and dependency notices; native architecture/OS/dependency validation; real-app exercise of changed interactions; strict signature verification; notarization acceptance; stapler validation; Gatekeeper acceptance; and temporary credential cleanup. Keep the root version authoritative, release title exactly `vX.Y.Z`, and asset suffix `darwin-arm64.zip`. The updater uses the published release name and platform/architecture asset selection. [Emma updater](https://github.com/tronschell/emma/blob/e023f351f41131b07bde759af6cdb0e3f28eea7f/desktop/main/update.ts), [feed naming contract](https://github.com/electron/update.electronjs.org#asset-naming-convention)

After publication, download the public asset independently, verify its SHA-256, strict signature, notarization ticket, Gatekeeper status, source/tag provenance, and compatibility with the previous app's signing requirement. Check the live feed from an older version. Feed success and signature compatibility alone do not prove an actual installed upgrade/relaunch; report that separately. Keep unverified privacy prompts, shortcuts, VoiceOver, display geometry, older macOS, and non-macOS behavior explicit.

## Reusable lessons for the shared skill

- Work from the selected remote source in an isolated checkout; preserve unrelated dirty work. Record exact source SHA and the actual built artifact, because tree equality does not neutralize embedded commit metadata.
- Trace the failing packaging path and sibling callers before patching. Preserve symlinks at the copy boundary, test strict ad-hoc signing before introducing Apple credentials, and initialize lazy installers before parallel consumers.
- Lock every dependency installation, including auxiliary vendor directories. Inspect nested native payloads and their OS floors, not just first-party executables.
- Read the actual GitHub rules and owner permissions. Existing owner authority can be legitimate; never relax checks or protections merely to get a merge through.
- Treat PR output as untrusted for signing. Reuse only a traceable candidate built from protected source, with an exact artifact ID and verified digest.
- Use repository-qualified release/tag checks in multi-remote clones. Preserve existing upstream tags and immutable published assets; source fixes require a new version.
- Separate build success, signing/notarization, real-app smoke, public-download verification, feed readiness, and completed update installation in the evidence. Mark historical documents and unverified claims clearly.
