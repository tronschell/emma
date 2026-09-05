import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { chatChunks, chunkState, readChatgptAuth, relayHeaders, responsesRequest, retainsPromptCache, sessionIdFor, upstreamFailure } from "../main/chatgpt";
import { codexCachedSlugs } from "../main/cli-models";
import { CODEX_MODEL_ID, availableCodexModelKey, codexModelKey, codexSlug, planFor, planForGeneration, planProfile } from "../shared/settings";

test("a ChatGPT route key carries the bare vendor slug", () => {
  const plan = planFor("openai")!;
  assert.equal(codexModelKey(plan, "openrouter:openai/gpt-5.4"), "codex:gpt-5.4");
  assert.equal(availableCodexModelKey(plan, "openrouter:openai/gpt-5.4"), "codex:gpt-5.4");
  assert.equal(availableCodexModelKey(plan, "openrouter:openai/gpt-5.4", []), "");
  assert.equal(availableCodexModelKey(plan, "openrouter:openai/gpt-5.4", ["gpt-5.4"]), "codex:gpt-5.4");
  assert.equal(codexSlug("codex:gpt-5.4"), "gpt-5.4");
  assert.equal(codexSlug("openrouter:openai/gpt-5.4"), "");
  assert.equal(codexSlug("provider:plan-openai"), "");
  assert.equal(codexSlug(undefined), "");
});

test("only a plausible slug is accepted as a subscription model", () => {
  assert.ok(CODEX_MODEL_ID.test("gpt-5.3-codex-spark"));
  assert.ok(!CODEX_MODEL_ID.test(""));
  assert.ok(!CODEX_MODEL_ID.test("../etc/passwd"));
  assert.ok(!CODEX_MODEL_ID.test("-m evil"));
  assert.ok(!CODEX_MODEL_ID.test("a".repeat(65)));
});

test("hidden models stay out of the cached slug list", () => {
  assert.deepEqual(codexCachedSlugs({ models: [{ slug: "gpt-5.6-sol" }, { slug: "gpt-reserve", visibility: "hide" }] }), ["gpt-5.6-sol"]);
  assert.deepEqual(codexCachedSlugs(undefined), []);
});

test("a plan generation is attributed to its provider profile", () => {
  const plan = planFor("openai")!;
  assert.equal(planForGeneration("gpt-5.4", [planProfile(plan, "gpt-5.4")]), "openai");
  assert.equal(planForGeneration("openai/gpt-5.4", [planProfile(plan, "gpt-5.4")]), undefined);
});

test("only a ChatGPT plan sign-in is accepted", () => {
  assert.throws(() => readChatgptAuth({ OPENAI_API_KEY: "sk-live" }), /API key/);
  assert.throws(() => readChatgptAuth(null), /API key/);
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-2" } })).toString("base64url");
  assert.deepEqual(readChatgptAuth({ tokens: { access_token: "a.b.c", account_id: "acct-1" } }), { accessToken: "a.b.c", accountId: "acct-1" });
  assert.equal(readChatgptAuth({ tokens: { access_token: `head.${claims}.sig` } }).accountId, "acct-2");
});

test("a chat completion becomes a stored-free responses call", () => {
  const request = responsesRequest({
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    max_tokens: 4096,
    messages: [
      { role: "system", content: "Be terse." },
      { role: "user", content: [{ type: "text", text: "read it" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] },
      { role: "assistant", content: "on it", tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "hello" },
    ],
    tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }],
  });
  assert.equal(request.store, false);
  assert.equal(request.stream, true);
  assert.equal(request.instructions, "Be terse.");
  assert.equal(request.max_output_tokens, 4096);
  assert.equal("prompt_cache_retention" in request, false);
  assert.deepEqual(request.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(request.tools, [{ type: "function", name: "read_file", description: "read", parameters: { type: "object" }, strict: false }]);
  assert.deepEqual(request.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "read it" }, { type: "input_image", image_url: "data:image/png;base64,AA" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "on it" }] },
    { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}" },
    { type: "function_call_output", call_id: "call_1", output: "hello" },
  ]);
});

test("a runtime overlay after the conversation stays out of the instructions head", () => {
  const request = responsesRequest({
    model: "gpt-5.6-sol",
    prompt_cache_key: "emma-openrouter-session-v1:abc",
    messages: [
      { role: "system", content: "Be terse." },
      { role: "developer", content: "Prefer tables." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "system", content: "Runtime context: cwd=/tmp" },
    ],
  });
  assert.equal(request.instructions, "Be terse.\n\nPrefer tables.");
  assert.equal(request.prompt_cache_key, "emma-openrouter-session-v1:abc");
  assert.deepEqual(request.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    { type: "message", role: "developer", content: [{ type: "input_text", text: "Runtime context: cwd=/tmp" }] },
  ]);
  assert.equal(sessionIdFor({ prompt_cache_key: "k" }), sessionIdFor({ prompt_cache_key: "k" }));
  assert.notEqual(sessionIdFor({ prompt_cache_key: "k" }), sessionIdFor({ prompt_cache_key: "j" }));
  assert.notEqual(sessionIdFor({}), sessionIdFor({}));
  assert.match(sessionIdFor({ prompt_cache_key: "k" }), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal("prompt_cache_key" in responsesRequest({ model: "m", messages: [] }), false);
});

test("responses events become chat completion chunks", () => {
  const state = chunkState("gpt-5.6-sol");
  const delta = (event: Record<string, unknown>) => chatChunks(event, state).map((chunk) => (chunk.choices as unknown[])[0]);
  assert.deepEqual(delta({ type: "response.output_text.delta", delta: "hi" }), [{ index: 0, delta: { content: "hi" }, finish_reason: null }]);
  assert.deepEqual(delta({ type: "response.reasoning_summary_text.delta", delta: "hmm" }), [{ index: 0, delta: { reasoning: "hmm" }, finish_reason: null }]);
  assert.deepEqual(delta({ type: "response.output_item.added", item_id: "item_1", item: { type: "function_call", name: "read_file", call_id: "call_1" } }), [{
    index: 0,
    delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }] },
    finish_reason: null,
  }]);
  assert.deepEqual(delta({ type: "response.function_call_arguments.delta", item_id: "item_1", delta: "{}" }), [{
    index: 0,
    delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
    finish_reason: null,
  }]);
  assert.deepEqual(delta({ type: "response.function_call_arguments.delta", item_id: "unknown", delta: "{}" }), []);
  assert.deepEqual(delta({ type: "response.in_progress" }), []);
  const [completed] = chatChunks({ type: "response.completed", response: { usage: { input_tokens: 143, output_tokens: 18, total_tokens: 161, input_tokens_details: { cached_tokens: 7 } } } }, state);
  assert.equal((completed.choices as { finish_reason: string }[])[0].finish_reason, "tool_calls");
  assert.deepEqual(completed.usage, { prompt_tokens: 143, completion_tokens: 18, total_tokens: 161, prompt_tokens_details: { cached_tokens: 7, cache_creation_tokens: 0 } });
});

test("a refused or truncated run is not read as an answer", () => {
  assert.equal(upstreamFailure({ type: "response.failed", response: { error: { message: "quota" } } }), "quota");
  assert.equal(upstreamFailure({ type: "error", message: "bad token" }), "bad token");
  assert.equal(upstreamFailure({ type: "response.output_text.delta", delta: "hi" }), "");
});

test("a run that ran out of output ends as a length finish, and every other failure keeps its reason", () => {
  const state = chunkState("gpt-5.6-sol");
  const [truncated] = chatChunks({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 12, output_tokens: 4 } } }, state);
  assert.equal((truncated.choices as { finish_reason: string }[])[0].finish_reason, "length");
  assert.equal(upstreamFailure({ type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } }), "content_filter");
  assert.deepEqual(chatChunks({ type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } }, state), []);
});

test("the proxy forwards upstream liveness even when no event translates into a chunk", () => {
  const home = mkdtempSync(path.join(tmpdir(), "emma-chatgpt-relay-"));
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "a.b.c", account_id: "acct-1" } }));
  const script = path.join(home, "relay.mjs");
  writeFileSync(script, [
    `const { chatgptRoute } = await import(${JSON.stringify(pathToFileURL(path.join(__dirname, "../main/chatgpt.js")).href)});`,
    'const upstream = \'data: {"type":"response.in_progress"}\\n\\ndata: {"type":"response.completed","response":{}}\\n\\ndata: [DONE]\\n\\n\';',
    "const real = globalThis.fetch;",
    "globalThis.fetch = async () => new Response(upstream, { status: 200 });",
    "const route = await chatgptRoute();",
    'const answer = await real(route.chatUrl, { method: "POST", headers: { authorization: `Bearer ${route.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] }) });',
    "process.stdout.write(await answer.text());",
  ].join("\n"));
  const proxied = spawnSync(process.execPath, [script], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8" });
  assert.equal(proxied.status, 0, proxied.stderr);
  assert.match(proxied.stdout, /^:$/m);
  assert.match(proxied.stdout, /"finish_reason":"stop"/);
});

test("a buffered request is answered with one chat completion", () => {
  const home = mkdtempSync(path.join(tmpdir(), "emma-chatgpt-buffered-"));
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "a.b.c", account_id: "acct-1" } }));
  const script = path.join(home, "buffered.mjs");
  writeFileSync(script, [
    `const { chatgptRoute } = await import(${JSON.stringify(pathToFileURL(path.join(__dirname, "../main/chatgpt.js")).href)});`,
    'const upstream = \'data: {"type":"response.output_text.delta","delta":"he"}\\n\\ndata: {"type":"response.output_text.delta","delta":"llo"}\\n\\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2}}}\\n\\ndata: [DONE]\\n\\n\';',
    "const real = globalThis.fetch;",
    "globalThis.fetch = async () => new Response(upstream, { status: 200 });",
    "const route = await chatgptRoute();",
    'const answer = await real(route.chatUrl, { method: "POST", headers: { authorization: `Bearer ${route.apiKey}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ model: "gpt-5.6-sol", max_tokens: 4000, stream: false, messages: [{ role: "user", content: "hi" }] }) });',
    'process.stdout.write(JSON.stringify({ type: answer.headers.get("content-type"), body: await answer.json() }));',
  ].join("\n"));
  const proxied = spawnSync(process.execPath, [script], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8" });
  assert.equal(proxied.status, 0, proxied.stderr);
  const answered = JSON.parse(proxied.stdout) as { type: string; body: Record<string, unknown> };
  assert.equal(answered.type, "application/json");
  assert.equal(answered.body.object, "chat.completion");
  assert.deepEqual(answered.body.choices, [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }]);
  assert.equal((answered.body.usage as { completion_tokens: number }).completion_tokens, 2);
});

test("reasoning items are replayed ahead of the calls they preceded", () => {
  const reasoning = [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAA" }];
  const called = responsesRequest({
    model: "gpt-5.4",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "on it", reasoning_details: reasoning, tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "hello" },
    ],
  });
  assert.deepEqual(called.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "on it" }] },
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAA" },
    { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "hello" },
  ]);
  const answered = responsesRequest({ model: "gpt-5.4", messages: [{ role: "assistant", content: "done", reasoning_details: reasoning }] });
  assert.deepEqual(answered.input, [
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAA" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ]);
  assert.deepEqual(responsesRequest({ model: "gpt-5.4", messages: [{ role: "assistant", content: "done", reasoning_details: "junk" }] }).input, [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ]);
  assert.deepEqual(called.include, ["reasoning.encrypted_content"]);
});

test("a later step extends the input of the step before it byte for byte", () => {
  const messages = [
    { role: "system", content: "Be terse." },
    { role: "user", content: "hi" },
    { role: "assistant", content: "", reasoning_details: [{ type: "reasoning", id: "rs_1", encrypted_content: "one" }], tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "hello" },
  ];
  const first = JSON.stringify(responsesRequest({ model: "gpt-5.4", messages }).input);
  const next = JSON.stringify(responsesRequest({
    model: "gpt-5.4",
    messages: [...messages,
      { role: "assistant", content: "", reasoning_details: [{ type: "reasoning", id: "rs_2", encrypted_content: "two" }], tool_calls: [{ id: "call_2", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_2", content: "again" },
    ],
  }).input);
  assert.ok(first.length > 2);
  assert.ok(next.startsWith(`${first.slice(0, -1)},`), `${first}\n${next}`);
});

test("only the gpt-5 models below 5.6 are asked to retain a cached prefix", () => {
  for (const model of ["gpt-5", "gpt-5-codex", "gpt-5.1", "gpt-5.2-codex", "gpt-5.4", "gpt-5.5"]) assert.equal(retainsPromptCache(model), true, model);
  for (const model of ["gpt-5.6", "gpt-5.6-luna", "gpt-5.7-codex", "gpt-6", "gpt-4o", "gpt-51", ""]) assert.equal(retainsPromptCache(model), false, model);
  assert.equal(responsesRequest({ model: "gpt-5.4", messages: [] }).prompt_cache_retention, "24h");
  assert.equal("prompt_cache_retention" in responsesRequest({ model: "gpt-5.4", messages: [] }, true), false);
  assert.equal("prompt_cache_retention" in responsesRequest({ model: "gpt-5.6-luna", messages: [] }), false);
});

test("a cache key names the session, the thread, and the legacy header alike", () => {
  const auth = { accessToken: "a.b.c", accountId: "acct-1" };
  const keyed = relayHeaders(auth, { prompt_cache_key: "emma:abc" });
  assert.equal(keyed.session_id, sessionIdFor({ prompt_cache_key: "emma:abc" }));
  assert.equal(keyed["session-id"], keyed.session_id);
  assert.equal(keyed["thread-id"], keyed.session_id);
  assert.equal(keyed["chatgpt-account-id"], "acct-1");
  const bare = relayHeaders(auth, {});
  assert.equal("session-id" in bare, false);
  assert.equal("thread-id" in bare, false);
  assert.match(bare.session_id, /^[0-9a-f-]{36}$/);
});

test("reasoning output items reach the harness before the calls they explain", () => {
  const state = chunkState("gpt-5.4");
  const item = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: "gAAAA" };
  assert.deepEqual(chatChunks({ type: "response.output_item.done", item }, state), []);
  assert.deepEqual(chatChunks({ type: "response.output_item.done", item: { type: "message" } }, state), []);
  const emitted = chatChunks({ type: "response.output_item.added", item_id: "item_1", item: { type: "function_call", name: "read_file", call_id: "call_1" } }, state);
  assert.deepEqual(emitted.map((chunk) => (chunk.choices as { delta: unknown }[])[0].delta), [
    { reasoning_details: [item] },
    { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }] },
  ]);
  assert.equal(chatChunks({ type: "response.completed", response: {} }, state).length, 1);
  chatChunks({ type: "response.output_item.done", item }, state);
  const finished = chatChunks({ type: "response.completed", response: {} }, state);
  assert.deepEqual((finished[0].choices as { delta: unknown }[])[0].delta, { reasoning_details: [item] });
  assert.equal((finished[1].choices as { finish_reason: string }[])[0].finish_reason, "tool_calls");
});
