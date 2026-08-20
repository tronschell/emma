# Emma agent sidecar

`emma-agent` is Emma's small Zig 0.16 sidecar. It reads one JSON object per
line from stdin and writes one response per line to stdout. Request IDs are
echoed unchanged. Errors use `{ "ok": false, "error": { "code", "message" } }`.
Lines are limited to 128 KiB and analysis text to 64 KiB.

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

`thread_message` reserves `events`, `tool_calls`, and `permission_requests` in
its result so shell, file, web, skill, and MCP activity can use the ordinary
agent turn without becoming knowledge-base content. This slice does not
execute those tools.

Knowledge analysis is an explicit action layered onto an existing thread.
`save_to_knowledge` and its `analyze` alias return a destination-tagged
artifact; normal assistant replies do not:

```json
{"id":"knowledge-1","type":"save_to_knowledge","thread_id":"thread-1","text":"A software bug delayed the release.","sources":["https://example.test/report"],"provider":{"base_url":"https://api.example.test/v1","model":"example-model","credential_env":"EMMA_OPENAI_API_KEY"}}
```

The provider object is the entire provider seam: an OpenAI-compatible base URL,
model, and the *name* of the credential environment variable. This slice
validates that configuration but deliberately uses `local-fallback`; it never
reads or prints credential values.

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

The MCP catalog/search/select ownership and next-model-step advertisement flow
are adapted from Vercel Labs' `fx`, specifically
`src/core/mcp/model_catalog.zig`, `src/core/tooling/tool_mcp_runtime.zig`, and
`src/core/agent/runtime/gateway_step.zig` at exact commit
[`b1774fbf6c7602b503026f96f6e960e946c692ef`](https://github.com/vercel-labs/fx/tree/b1774fbf6c7602b503026f96f6e960e946c692ef).
Copyright Vercel, Inc. and fx contributors. Licensed under the
[Apache License 2.0](https://github.com/vercel-labs/fx/blob/b1774fbf6c7602b503026f96f6e960e946c692ef/LICENSE).
No complete fx subsystem or source file is copied here.
