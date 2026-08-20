# Emma agent sidecar

`emma-agent` is Emma's small Zig 0.16 sidecar. It reads one JSON object per
line from stdin and writes one response per line to stdout. Request IDs are
echoed unchanged. Errors use `{ "ok": false, "error": { "code", "message" } }`.
Lines are limited to 256 KiB and analysis text to 64 KiB.

Build and test:

```sh
zig build test
zig build -Doptimize=ReleaseSafe
```

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

The provider seam is only an OpenAI-compatible base URL, model, and the *name*
of a credential environment variable. The sidecar reads that variable only
when making the request and sends it as bearer authorization; neither the
credential nor provider error bodies enter JSON responses or logs. Remote
URLs require HTTPS. Plain HTTP is accepted only for `localhost`,
or `127.0.0.1`, so OpenAI, OpenRouter, and local compatible servers use the
same URL/profile path without vendor login code. Requests and responses are
each capped at 1 MiB, redirects are not followed, and requests time out after
60 seconds.

`openrouter_models` lazily fetches OpenRouter's live free catalog, restricted
to tool-capable models with a ZDR endpoint. OpenRouter profiles set
`protect_data: true`; the sidecar accepts that flag only for OpenRouter HTTPS
hosts and adds `provider.data_collection: "deny"` plus `provider.zdr: true` to
Chat Completions requests:

```json
{"id":"models-1","type":"openrouter_models","provider":{"base_url":"https://openrouter.ai/api/v1","model":"openrouter/free","credential_env":"OPENROUTER_API_KEY","protect_data":true}}
```

This transport is non-streaming and accepts assistant text plus standard
`prompt_tokens`/`completion_tokens` usage. Provider turns advertise explicit
`create_knowledge_page` and `update_knowledge_page` tools, parse at most one
knowledge action, and return it to the host for selected-base validation and
atomic Markdown persistence. Native Anthropic and Gemini wire formats are not
supported; those services need an OpenAI-compatible gateway for this slice.

`thread_message` reserves `events`, `tool_calls`, and `permission_requests` in
its result so shell, file, web, skill, and MCP activity can use the ordinary
agent turn without becoming knowledge-base content. A bounded `knowledge`
array supplies only relevant pages from the thread's selected base.

Knowledge analysis is an explicit action layered onto an existing thread.
`save_to_knowledge` and its `analyze` alias return a destination-tagged
artifact; normal assistant replies do not:

```json
{"id":"knowledge-1","type":"save_to_knowledge","thread_id":"thread-1","text":"A software bug delayed the release.","sources":["https://example.test/report"]}
```

Knowledge analysis remains the deterministic local classifier in this slice;
provider-backed generation currently applies only to `thread_message`.

Lazy MCP discovery is stateful within one process. The host installs metadata
and schemas, but catalog and search responses keep schemas out of model
context. Selection must name a result from the immediately preceding search;
only that exact schema is returned for the next model step.

```json
{"id":"catalog-1","type":"mcp_catalog","servers":[{"name":"files","tools":[{"name":"read_file","description":"Read workspace text","input_schema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}]}]}
{"id":"search-1","type":"mcp_search_tools","query":"workspace","limit":5}
{"id":"select-1","type":"mcp_select_tool","name":"read_file"}
```

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
