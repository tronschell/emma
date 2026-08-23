# Fork provenance

`emma-cli` is Emma's fork of [`vercel-labs/fx`](https://github.com/vercel-labs/fx),
a coding agent harness written in Zig.

| | |
| --- | --- |
| Upstream | https://github.com/vercel-labs/fx |
| Forked at | [`580a0c5da9386317251968c09c1cee69e763487a`](https://github.com/vercel-labs/fx/tree/580a0c5da9386317251968c09c1cee69e763487a) |
| Upstream version | 0.0.4 |
| Upstream license | Apache License 2.0 |

Copyright Vercel, Inc. and fx contributors. Licensed under the Apache License,
Version 2.0. The full license text is in [`LICENSE`](LICENSE) and upstream's
third-party notices are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
Both are retained because Apache-2.0 §4 requires it; that obligation survives
renaming and rebranding, so it is not something the fork may drop.

## What this fork changes

Emma keeps fx's agent loop, permission model, hooks, skills, subagents, tools,
and MCP client. It replaces the parts that tie fx to Vercel's hosted services:

- **Binary and package name.** `fx` becomes `emma-cli`. The `build.zig.zon`
  fingerprint is regenerated, because upstream's own comment on that field says
  a fork that keeps it is attempting to take over the original project's
  identity.
- **Model transport.** Upstream talks to Vercel AI Gateway over the AI SDK
  language-model v3 protocol (`prompt`/`toolChoice` at `/v3/ai/language-model`).
  Emma talks to any OpenAI-compatible Chat Completions endpoint, which is the
  provider seam the rest of Emma already uses.
- **Authentication.** Upstream's Vercel device OAuth, ChatGPT Codex OAuth, team
  selection, and credit balance are removed. Emma supplies a base URL, a model,
  and the *name* of an environment variable holding the credential; there is no
  vendor login surface anywhere in Emma.
- **Branding and hosted endpoints.** `fx.sh` docs links, feedback and upgrade
  URLs, and telemetry paths are removed rather than repointed.

### De-Vercel pass (removals)

Commands and their plumbing: `login`, `logout`, `teams`, `credits`, `setup`, the
ChatGPT/Codex OAuth flow (`src/core/auth/chatgpt_oauth.zig`), and `/feedback`.
The credential model collapsed to a single source read from
`EMMA_PROVIDER_API_KEY` (`src/core/auth/credentials.zig`), and
`model_provider.ProviderId` to a single `gateway` variant.

Modules deleted: `src/builtins/devbox.zig` and
`src/core/execution/devbox_executor.zig` (Vercel Sandbox remote execution),
`src/core/hosts/native_secret_store.zig`, `src/core/feedback/runtime.zig`. The
gateway-API-key and OAuth-session halves of `src/core/hosts/native_keychain.zig`
went with them; the MCP OAuth half stays, because `src/core/mcp/` uses it.
`BackendKind.vercel` is gone from `src/core/shared/types.zig`, and the sandbox
`vercel` backend from `src/core/permissions/sandbox.zig`.

Release and hosting infrastructure: the Vercel Blob CDN workflows
(`cdn-backfill.yml`, `release.yml`, `dev-release.yml`, `prepare-release.yml`,
`publish-libfx.yml`). `upgrade_helpers.resolveCdnBase()` now returns `null`
unless the loopback E2E override is set, because emma-cli ships inside the
desktop app and has nothing to self-update from.

Renames: `AI_GATEWAY_API_KEY` → `EMMA_PROVIDER_API_KEY`,
`FX_E2E_UPGRADE_BASE_URL` → `EMMA_UPGRADE_BASE_URL`, `fx` → `emma-cli` in help,
usage, and error text, `fx.shared_model_context.v1` →
`emma.shared_model_context.v1`, and the `ai_gateway_*` web-search backend ids to
`perplexity_search`/`parallel_search` (local selector labels; the wire tool name
was already unprefixed).

Deliberately kept: the `LICENSE`, `THIRD_PARTY_NOTICES.md`, and every Apache-2.0
header and copyright line; `sandbox.retired_sandbox_config_message` and its
`vercel` parse arm, so an existing config naming that sandbox gets a real
diagnostic instead of a silent fallback; `"VERCEL_OIDC_TOKEN="` in the
`secret_prefixes` redaction allowlist in `src/core/shared/text_utils.zig`, since
dropping an entry only weakens redaction; the `~/.fx` config paths and `FX_*`
environment variables, which are fx branding rather than Vercel and are
user-settable; and inert fixture strings naming `vercel-labs/agent-skills`,
`github.com/vercel-labs/fx` git remotes, and `vercel/v0` PR URLs.

## Merging upstream

Upstream is under active development, so this fork is a real maintenance cost —
that was a deliberate, accepted trade. Keep changes minimal and localized so a
future `git diff` against a newer upstream tag stays readable. Anything Emma
adds that is not a de-Vercel change belongs in Emma's own code where possible,
not scattered through vendored files.
