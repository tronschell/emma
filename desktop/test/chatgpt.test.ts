import test from "node:test";
import assert from "node:assert/strict";
import { chatChunks, chunkState, readChatgptAuth, responsesRequest, upstreamFailure } from "../main/chatgpt";
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
  assert.deepEqual(request.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(request.tools, [{ type: "function", name: "read_file", description: "read", parameters: { type: "object" }, strict: false }]);
  assert.deepEqual(request.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "read it" }, { type: "input_image", image_url: "data:image/png;base64,AA" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "on it" }] },
    { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}" },
    { type: "function_call_output", call_id: "call_1", output: "hello" },
  ]);
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
