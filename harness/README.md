# emma-cli

`emma-cli` is a coding agent harness and CLI written in Zig. It is Emma's fork
of [`vercel-labs/fx`](https://github.com/vercel-labs/fx) — see
[FORK.md](FORK.md) for provenance and for what this fork changes.

It focuses on minimalism and performance across the board, from system prompt
design to its tools, feature set, and binary size. Its CLI output style and form
factor aim to be closer to a Unix shell than a heavy "IDE in the terminal" TUI.

It is also Emma's terminal front end: there is no separate `emma` command.

⚠ Status: Experimental. Use at your own risk.

## Credential

There is no sign-in surface, and no credential source but one environment
variable:

```bash
export EMMA_PROVIDER_API_KEY=...
```

Requests go to `https://openrouter.ai/api/v1/chat/completions`.
`EMMA_PROVIDER_CHAT_URL` points them at any other OpenAI-compatible Chat
Completions endpoint. `EMMA_OPENROUTER_ZDR`, set to any non-empty value, adds
OpenRouter's `data_collection: "deny"` and `zdr: true` routing flags to each
request; it is opt-in because most free endpoints offer neither and would 404.

## Run

```bash
cd your_project
emma-cli
```

The current directory becomes the primary workspace. Enter a prompt, or run
`/help` to browse interactive commands.

Use `emma-cli ask` for a single request:

```bash
emma-cli ask "explain the changes in this repository"
```

List saved sessions with `emma-cli sessions`. Resume the latest session for the
current workspace, or select an exact session ID, through the same command
group:

```bash
emma-cli session resume last
emma-cli session resume --id <id>
```

The status line hides the workspace path and Git branch by default. Enable the
`Status line workspace` option in `/settings`, run `/statusline workspace`, or
set it in `~/.fx/settings.json`:

```json
{
  "statusLine": {
    "workspace": true
  }
}
```

Run `/trace` to create a private Markdown diagnostic with logs, session context,
runtime state, permissions, and recent activity. On macOS the `.md` file is
copied to the clipboard; on other platforms it is saved and its path printed.
Review and redact the trace before sharing it.

## Permissions

`emma-cli` starts in `auto` permission mode. Routine understood development
actions run directly; unresolved sensitive actions receive one bounded automatic
review. A blocked action may return an exact approval request that the agent can
send to the real permission screen. Ordinary question text never grants
permission.

JSON and quiet requests stay noninteractive by default. Add
`--prompt-permissions` to allow the existing Y/N approval prompt when stdin is a
TTY. Prompt text is written to stderr, so JSON stdout stays parseable and quiet
stdout stays empty. Piped or redirected stdin remains noninteractive and fails
instead of waiting for approval.

Inside a saved session, `/permissions remember <allow|deny> <tool-name>
<arguments-json>` stores an exact confirmed rule without running the action.
`/permissions` lists stable rule IDs, and `/permissions revoke <rule-id>`
removes a stored rule.

## Inside Emma

This is the only agent loop Emma has. A packaged app carries the binary at
`Emma.app/Contents/Resources/emma-cli`; a development run reads
`harness/zig-out/bin/emma-cli`, built by `npm --prefix desktop run
build:harness`. A missing binary is a broken install, not a reason to take
another path. Emma spawns `emma-cli acp` once per workspace directory and
drives it over the Agent Client Protocol, answering every
`session/request_permission` itself. `HOME` points at a profile of Emma's own,
so the harness never reads the user's `~/.fx`: Emma seeds that profile's
`.fx/skills` at launch and writes its `.fx/AGENTS.md` from the user's Settings
text before each turn. The credential comes from Emma's environment as
`OPENROUTER_API_KEY` and is handed down as `EMMA_PROVIDER_API_KEY`.

## Embed

`emma-cli` builds as a native binary or WebAssembly. Applications embedding it
can provide network transport, session storage, configuration, permission
handling, and terminal I/O.

| Surface | Use |
| --- | --- |
| `emma-cli acp` | Connect the native agent to editors and other Agent Client Protocol clients. |
| `createFxAgent()` | Embed the agent core in a JavaScript host with `fx-core.wasm`. |
| `createFxTerminal()` | Embed the interactive terminal with `fx-term.wasm`. |

The WebAssembly SDK is experimental. See the [WebAssembly SDK](sdk/README.md).

## Extend

Add reusable instructions with skills, connect external tools through MCP, or
delegate independent work to subagents. Project instruction files may link
within their scope, and read-only workspace or compatibility skill directories
and their primary `SKILL.md` files may link within their owning workspace or
home; managed skills, secondary resources, and escaping links remain no-follow.
Skills installed via symlinks that resolve outside home or workspace (e.g. Nix
store paths) are loaded when their resolved target is inside a directory listed
in the `FX_SKILL_SYMLINK_AUTHORITIES` environment variable (colon-separated
absolute paths). `emma-cli status` and `emma-cli doctor` report an invalid
trusted MCP profile without starting its servers.

## Build from source

Building requires [Zig 0.16.0+](https://ziglang.org/download/):

```bash
zig build -Doptimize=ReleaseSafe
./zig-out/bin/emma-cli
```

Run the test suite with `zig build test`. See [CONTRIBUTING.md](CONTRIBUTING.md)
for development guidelines.

## License

[Apache-2.0](LICENSE). Copyright Vercel, Inc. and fx contributors.

Third-party licenses and attributions are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Credits

Interface sounds by [cuelume](https://github.com/Danilaa1/cuelume).
