# Emma agent sidecar

`emma-agent` is Emma's small Zig 0.16 sidecar. It reads one JSON object per
line from stdin and writes one response per line to stdout. Request IDs are
echoed unchanged. Errors use `{ "ok": false, "error": { "code", "message" } }`.
Lines are limited to 256 KiB and analysis text to 64 KiB.

A provider-backed turn streams: the sidecar writes `{"id":…,"delta":…}` lines
carrying assistant text as it arrives, then the request's own response line. A
client reads lines until one carries `ok`. Delta lines are best effort and the
local fallback emits none.

Build and test:

```sh
zig build test
zig build -Doptimize=ReleaseSafe
```

## Terminal client

`agent/emma` is a bash front end for this protocol, so a terminal never sees
JSON. It ships in the packaged app at `Emma.app/Contents/Resources/emma`,
beside the sidecar it drives, and links itself onto PATH as `emma`:

```sh
/Applications/Emma.app/Contents/Resources/emma --install
```

`--install` symlinks the script as `emma` into the first writable of
`~/.local/bin`, `/usr/local/bin`, and `$HOMEBREW_PREFIX/bin`. From a checkout,
`agent/emma --install` does the same against the built sidecar. Then, from any
directory:

```sh
emma "write a fizzbuzz in python"   # one shot
emma                                 # REPL, one thread for the session
```

It keeps one `emma-agent` process and one thread alive, so turns share history.
It runs the sidecar beside itself, falling back to `agent/zig-out/bin/emma-agent`
in a checkout; `EMMA_AGENT_BIN` names another one. Provider settings come from
`EMMA_PROVIDER_BASE_URL`, `EMMA_PROVIDER_MODEL`, and
`EMMA_PROVIDER_CREDENTIAL_ENV` (default `EMMA_API_KEY`); without a base URL
every reply is the local fallback. It requires `jq`. The reply is text on
stdout, so `emma "..." > file` works.

When a provider is configured, `emma` advertises exactly one tool — `bash`,
one command per call, combined output truncated to 16KB — and executes the
calls itself. `EMMA_MODE` picks the same four permission modes the desktop
composer offers, with the same meanings: `plan` advertises no tools at all,
`ask` (the default) prints each command and gates it behind a `y/N` prompt on
the tty, and `acceptEdits` and `full` run it. `EMMA_YOLO=1` is an alias for
`full`. A declined or ungated call comes back to the model as a refusal. The
loop stops after 120 tool steps, which is its own ceiling and not the
sidecar's. Without a provider no tools are advertised at all, because the
sidecar rejects tools on a fallback turn. File and edit tools stay out of the
CLI: `bash` already covers them. See the `tool_calls` protocol below.

`emma-cli` is a different program: the forked coding harness in `harness/`,
which Emma drives over ACP and does not ship in the app bundle.

## Use Emma without the UI

`emma-agent` is also a standalone headless agent. Keep one process alive for
the lifetime of a coding thread and speak NDJSON over stdin/stdout; no login or
Electron process is involved. This creates a thread and asks for a coding plan
with the deterministic local fallback:

```sh
printf '%s\n' \
  '{"id":"1","type":"thread_create","title":"Fix the parser"}' \
  '{"id":"2","type":"thread_message","thread_id":"thread-1","content":"Inspect the parser design and propose the smallest safe fix."}' \
  | ./zig-out/bin/emma-agent
```

For a real model-generated coding response, add an OpenAI-compatible provider
to the message and place the credential in the named environment variable:

```sh
EMMA_OPENAI_API_KEY='your-key' ./zig-out/bin/emma-agent
```

Then send the same `thread_create` request followed by:

```json
{"id":"2","type":"thread_message","thread_id":"thread-1","content":"Review this coding task and return a patch plan.","provider":{"base_url":"https://api.openai.com/v1","model":"your-model","credential_env":"EMMA_OPENAI_API_KEY"}}
```

The sidecar keeps threads only for its process lifetime. Use `emma-host` when
you also want Emma's durable Markdown thread and knowledge stores.

Every ordinary interaction belongs to an in-process thread. The no-credential
path still creates and persists both a `user` message and a general
`assistant` reply:

```json
{"id":"health-1","type":"health"}
{"id":"create-1","type":"thread_create","title":"Release planning"}
{"id":"message-1","type":"thread_message","thread_id":"thread-1","content":"Help me plan the release."}
{"id":"list-1","type":"thread_list"}
{"id":"get-1","type":"thread_get","thread_id":"thread-1"}
```

After restarting the sidecar, the durable host can rehydrate a thread by
passing optional `messages` to `thread_create`. Entries accept only `system`,
`user`, or `assistant` roles, are limited to 256 messages and 96 KiB of total
content, and default to an empty history when omitted. The same limits form the
rolling in-process context window; the oldest whole messages are discarded as
new turns arrive:

```json
{"id":"create-2","type":"thread_create","title":"Release planning","messages":[{"role":"system","content":"Be concise."},{"role":"user","content":"What remains?"},{"role":"assistant","content":"Signing and distribution."}]}
```

Supplying a provider makes `thread_message` send the thread's actual prior
messages plus the new user message to an OpenAI-compatible Chat Completions
endpoint:

```json
{"id":"message-2","type":"thread_message","thread_id":"thread-1","content":"Help me plan the release.","provider":{"base_url":"https://api.openai.com/v1","model":"example-model","credential_env":"EMMA_OPENAI_API_KEY"}}
```

An explicitly selected skill can be attached to one provider-backed turn with
the optional `skill_context` field. It is capped at 64 KiB, enters that request
as a system instruction, and is not added to durable thread history. The local
fallback rejects skill or screen context because it cannot interpret either:

```json
{"id":"message-3","type":"thread_message","thread_id":"thread-1","content":"Review this change.","skill_context":"Apply the selected review procedure.","provider":{"base_url":"https://api.openai.com/v1","model":"example-model","credential_env":"EMMA_OPENAI_API_KEY"}}
```

The provider seam is only an OpenAI-compatible base URL, model, and the *name*
of a credential environment variable. The sidecar reads that variable only
when making the request and sends it as bearer authorization; neither the
credential nor provider error bodies enter JSON responses or logs. Remote
URLs require HTTPS. Plain HTTP is accepted only for `localhost`, `127.0.0.1`,
and `::1`, so OpenAI, OpenRouter, and local compatible servers use the
same URL/profile path without vendor login code. A request is capped at 1 MiB
and a whole response at 1 MiB, a streamed one at 16 MiB, redirects are not
followed, and requests time out after 60 seconds.

`openrouter_models` lazily fetches OpenRouter's live tool-capable catalog, free
and paid, each entry marked `free` with its context length, input modalities,
reasoning efforts, and per-million-token prices. OpenRouter profiles must set
`protect_data: true` and no other host may; the flag adds
`provider.require_parameters: true` to Chat Completions requests. Optional
`zero_retention: true` narrows both the catalog and the routing to endpoints
that neither retain nor train on the turn, by adding
`provider.data_collection: "deny"` plus `provider.zdr: true`. It stays opt-in
because most free endpoints offer neither and would fail the turn:

```json
{"id":"models-1","type":"openrouter_models","provider":{"base_url":"https://openrouter.ai/api/v1","model":"openrouter/free","credential_env":"OPENROUTER_API_KEY","protect_data":true}}
```

A provider may also carry `reasoning_effort` (one of `none`, `minimal`, `low`,
`medium`, `high`, `xhigh`, `max`, or `off` to ask for no reasoning) and
`context_length`, the selected model's window as the catalog reported it. A
window turns compaction on: past 70% of it the oldest half of the thread is
replaced by one `system` summary, or dropped outright if summarising fails or
does not save bytes. `0` or an absent value leaves compaction off.

`thread_message` turns stream over SSE; document authoring asks for one whole
JSON object and does not. Standard `prompt_tokens`/`completion_tokens` usage is
believed when a provider sends it and estimated at four bytes per token when it
does not. Ordinary provider turns receive
retrieved knowledge as read-only context and cannot write pages; explicit
`save_to_knowledge` remains the durable write path. Native Anthropic and Gemini
wire formats are not supported; those services need an OpenAI-compatible
gateway for this slice.

`thread_message` reserves `events` and `permission_requests` in its result so
shell, file, web, skill, and MCP activity can use the ordinary agent turn
without becoming knowledge-base content. A bounded `knowledge` array supplies
only relevant pages from the thread's selected source bases.

`tool_calls` is now live, but only for requests that advertised tools. A
`thread_message` or `thread_tool_result` request may carry a bounded `tools`
array (name, description, JSON Schema); when the provider answers with tool
calls, the sidecar returns them instead of an assistant message and the caller
replies with a `thread_tool_result` request carrying each `tool_call_id`'s
output. A step that asks for tools writes nothing durable — only a real answer
is appended to the thread. When no tools were advertised, a reply containing
`tool_calls` or `finish_reason: "tool_calls"` is still rejected outright, and
the sidecar never executes a tool itself.

Knowledge analysis is an explicit action layered onto an existing thread.
`save_to_knowledge` and its `analyze` alias return a destination-tagged
artifact; normal assistant replies do not:

```json
{"id":"knowledge-1","type":"save_to_knowledge","thread_id":"thread-1","text":"A software bug delayed the release.","sources":["https://example.test/report"]}
```

With a provider on the request, the model authors the page itself — title,
category, summary, and up to 64 content blocks and 12 interesting points, each
kept only if it validates. Without one the reply is the deterministic local
classifier and its fixed scaffold. `revise_document` edits a page already
written: it takes the current `document` array and an `instruction` and returns
the revised `blocks`, and it requires a provider because there is no local
rewriter.

Lazy MCP discovery is stateful within one process. A caller installs metadata
and schemas, but catalog and search responses keep schemas out of model
context. Selection must name a result from the immediately preceding search;
only that exact schema is returned for the next model step.

```json
{"id":"catalog-1","type":"mcp_catalog","servers":[{"name":"files","tools":[{"name":"read_file","description":"Read workspace text","input_schema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}]}]}
{"id":"search-1","type":"mcp_search_tools","query":"workspace","limit":5}
{"id":"select-1","type":"mcp_select_tool","name":"read_file"}
```

The Zig sidecar does not launch MCP servers, execute `tools/call`, or run any
other tool. Execution belongs to whoever drives it: Emma's Electron main process
owns the separately permissioned stdio transport and gates each computer action
behind a per-run grant, and `emma` gates each `bash` call behind a tty prompt.
Both drive the same loop and submit results back over `thread_tool_result`. The sidecar decides *what* to call; the caller decides
whether it is allowed to happen.

## fx attribution

The provider transport/orchestration boundary and MCP catalog/search/select
ownership and next-model-step advertisement flow are adapted from Vercel Labs'
`fx`, specifically
`src/core/mcp/model_catalog.zig`, `src/core/tooling/tool_mcp_runtime.zig`, and
`src/core/agent/runtime/gateway_step.zig` at exact commit
[`b1774fbf6c7602b503026f96f6e960e946c692ef`](https://github.com/vercel-labs/fx/tree/b1774fbf6c7602b503026f96f6e960e946c692ef).
Copyright Vercel, Inc. and fx contributors. Licensed under the
[Apache License 2.0](https://github.com/vercel-labs/fx/blob/b1774fbf6c7602b503026f96f6e960e946c692ef/LICENSE).
No complete fx subsystem or source file is copied here.
