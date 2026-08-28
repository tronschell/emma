import test from "node:test";
import assert from "node:assert/strict";
import type { PermissionAsk, ThreadStep } from "../shared/agents";
import { defaultVerifier, defaultVerifierSystem, OPENROUTER_CHAT_ENDPOINT, routerKey, validateVerifier, verifierFromKey, verifierKey } from "../shared/settings";
import { toolGate } from "../shared/permissions";
import { decodeSpans, type TraceSpan } from "../shared/trace";
import { AgentRuntime } from "../main/agent-loop";
import { chatCompletion, parseVerdict, PROHIBITED, review, verifierPrompt, type VerifierRequest, type VerifierReview } from "../main/verifier";

const settings = { model: "small/model", endpoint: "https://example.test/v1/chat/completions", credentialEnv: "", system: defaultVerifierSystem };

test("a small model's yes and no are read however it spells them", () => {
  assert.deepEqual(parseVerdict('{"allow": true, "reason": "reads a file"}'), { allow: true, reason: "reads a file" });
  // Fenced, prefixed, and with the fields renamed: all still an answer.
  assert.equal(parseVerdict('```json\n{"allow": false, "reason": "deletes the repo"}\n```')?.allow, false);
  assert.equal(parseVerdict('Here is my answer: {"allowed": "yes", "why": "it only lists files"}')?.allow, true);
  assert.equal(parseVerdict('{"verdict": "deny", "reason": "rm -rf"}')?.allow, false);
  assert.equal(parseVerdict('{"safe": 0}')?.allow, false);
  // No JSON at all, but it did answer the question with its first word.
  assert.equal(parseVerdict("ALLOW — this only runs the test suite")?.allow, true);
  assert.equal(parseVerdict("Blocked: this force pushes over main")?.allow, false);
  // And what is not an answer stays unanswered, so the user gets the question back.
  assert.equal(parseVerdict(""), undefined);
  assert.equal(parseVerdict("I am a language model and cannot help with that."), undefined);
  assert.equal(parseVerdict('{"reason": "unsure"}'), undefined);
  // A word that merely starts with one is not a verdict, or every "No idea what
  // you mean" would reach the user as a refusal with an invented reason.
  assert.equal(parseVerdict("No idea what you mean"), undefined);
  assert.equal(parseVerdict("Safely running the suite is not something I can judge"), undefined);
  // A thinking model's reasoning is not its verdict, and half a thought is no verdict at all.
  assert.equal(parseVerdict('<think>Deleting sounds scary, but they asked for it.</think>\n{"allow": true, "reason": "they named the folder"}')?.allow, true);
  assert.equal(parseVerdict("<think>No, wait, the user did say to remove it"), undefined);
});

test("a model that answers with nothing is re-asked without its silence quoted back, and says so when it gives up", async () => {
  const sent: number[] = [];
  const gaveUp = await review(settings, request(), async (_settings, messages) => { sent.push(messages.length); return ""; });
  assert.equal(gaveUp.verdict, undefined);
  assert.match(gaveUp.error!, /empty reply/);
  // One extra user turn per retry, never an empty assistant one.
  assert.deepEqual(sent, [2, 3, 4]);
});

test("the verifier is re-asked when it answers in the wrong shape, and gives up rather than guessing", async () => {
  const sent: number[] = [];
  const replies = ["I think that's probably fine!", "sure thing", '{"allow": true, "reason": "runs the tests"}'];
  const answered = await review(settings, request(), async (_settings, messages) => {
    sent.push(messages.length);
    return replies[sent.length - 1];
  });
  assert.equal(answered.verdict?.allow, true);
  assert.equal(answered.attempts, 3);
  // Each retry carries the failed reply and the correction, so the model sees its own mistake.
  assert.deepEqual(sent, [2, 4, 6]);

  const gaveUp = await review(settings, request(), async () => "no idea what you mean");
  assert.equal(gaveUp.verdict, undefined);
  assert.match(gaveUp.error!, /format/);
  // Whatever it did say is still on the record: that is what the transcript shows.
  assert.equal(gaveUp.reply, "no idea what you mean");

  // A dead endpoint is not retried in the same second, and never throws at the caller.
  const broken = await review(settings, request(), () => Promise.reject(new Error("connect ECONNREFUSED")));
  assert.equal(broken.attempts, 1);
  assert.match(broken.error!, /ECONNREFUSED/);
});

test("the verifier is told the goal and the exact command, not just the tool name", () => {
  const prompt = verifierPrompt(request());
  assert.match(prompt, /The user asked: run the tests/);
  assert.match(prompt, /rm -rf \/tmp\/build && npm test/);
  assert.match(prompt, /Proposed action: terminal/);
});

test("the standing rules are the prohibited list, and the goal is what everything else is judged against", async () => {
  let system = "";
  await review(settings, request(), async (_settings, messages) => {
    system = String(messages[0].content);
    return '{"allow": false, "reason": "no"}';
  });
  assert.ok(PROHIBITED.length >= 8, "a short list is a list with holes in it");
  for (const rule of PROHIBITED) assert.ok(system.includes(rule), `the model is never told: ${rule}`);
  // The nuance that makes the list usable: destruction the user asked for is the job.
  assert.match(system, /Destruction the user asked for is fine/);
  assert.match(system, /Unrelated is blocked/);
  // And the reason is written for the agent that has to try something else.
  assert.match(system, /read by the agent that proposed the action/);

  // ...unless the user rewrote them, in which case theirs is what the model gets.
  let mine = "";
  await review({ ...settings, system: "Allow nothing on a Tuesday." }, request(), async (_settings, messages) => {
    mine = String(messages[0].content);
    return '{"allow": false, "reason": "no"}';
  });
  assert.equal(mine, "Allow nothing on a Tuesday.");
});

test("an endpoint the review would travel to in the clear is refused", () => {
  assert.deepEqual(validateVerifier(undefined), defaultVerifier);
  assert.equal(validateVerifier({ model: " x ", endpoint: "http://127.0.0.1:1234/v1/chat/completions", credentialEnv: "" }).model, "x");
  // The rules are the user's to rewrite, and emptying the box asks for the shipped ones back.
  assert.equal(validateVerifier({ ...settings, system: "  only allow reads  " }).system, "only allow reads");
  assert.equal(validateVerifier({ ...settings, system: "   " }).system, defaultVerifierSystem);
  assert.throws(() => validateVerifier({ ...settings, system: "x".repeat(9000) }), /characters/);
  assert.throws(() => validateVerifier({ model: "x", endpoint: "http://example.com/v1", credentialEnv: "" }), /https/);
  assert.throws(() => validateVerifier({ model: "x", endpoint: "not a url", credentialEnv: "" }), /URL/);
  assert.throws(() => validateVerifier({ model: "x", endpoint: settings.endpoint, credentialEnv: "not an env name" }), /environment variable/);
});

test("picking a catalogued model is picking a route, and only a stranger needs the fields", () => {
  const profiles = [{ id: "p1", name: "Qwen local", modelId: "qwen3:8b", baseUrl: "http://127.0.0.1:1234/v1/", credentialEnv: "LOCAL_KEY", contextWindow: 0, insecure: false }];
  const openrouter = verifierFromKey("openrouter:liquid/lfm-2.5-2.6b:free", profiles, "rules");
  assert.deepEqual(openrouter, { model: "liquid/lfm-2.5-2.6b:free", endpoint: OPENROUTER_CHAT_ENDPOINT, credentialEnv: "OPENROUTER_API_KEY", system: "rules" });
  assert.equal(verifierKey(openrouter, profiles), "openrouter:liquid/lfm-2.5-2.6b:free");
  const local = verifierFromKey("provider:p1", profiles, "rules");
  assert.equal(local.endpoint, "http://127.0.0.1:1234/v1/chat/completions");
  assert.equal(local.credentialEnv, "LOCAL_KEY");
  assert.equal(verifierKey(local, profiles), "provider:p1");
  assert.equal(verifierFromKey("", profiles, "rules").model, "");
  assert.equal(verifierKey(verifierFromKey("", profiles, "rules"), profiles), "");
  assert.equal(verifierKey({ model: "x", endpoint: "https://elsewhere.test/v1/chat/completions", credentialEnv: "", system: "" }, profiles), "custom");
  // A router is a list of models, best first: picking one gives the second model
  // the same fallbacks the main model gets, and reads back as the router again.
  const routers = [{ id: "free", name: "Free", models: ["a/one:free", "b/two:free"] }];
  const chained = verifierFromKey(routerKey("free"), profiles, "rules", routers);
  assert.equal(chained.model, "a/one:free,b/two:free");
  assert.equal(verifierKey(chained, profiles, routers), routerKey("free"));
  assert.equal(validateVerifier(chained).model, "a/one:free,b/two:free");
});

test("a chained second model asks OpenRouter to fall through for it", async () => {
  const sent: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const chain = { ...settings, model: " a/one:free , b/two:free " };
    assert.equal(await chatCompletion(chain, [{ role: "user", content: "hi" }], "", { maxTokens: 10, timeoutMs: 5_000, label: "verifier" }), "ok");
    assert.deepEqual(sent[0], { model: "a/one:free", models: ["a/one:free", "b/two:free"], messages: [{ role: "user", content: "hi" }], temperature: 0, max_tokens: 10, stream: false });
    // One model is one model: nothing extra travels for the common case.
    await chatCompletion(settings, [{ role: "user", content: "hi" }], "", { maxTokens: 10, timeoutMs: 5_000, label: "verifier" });
    assert.equal((sent[1] as { models?: unknown }).models, undefined);
  } finally { globalThis.fetch = original; }
});

test("auto gates exactly what ask gates, so the verifier is asked the same questions", () => {
  assert.equal(toolGate("auto", "run_tool"), "ask");
  assert.equal(toolGate("auto", "computer"), "ask");
  assert.equal(toolGate("auto", "keep"), "auto");
  // Auto is not a way to reach a tool the mode table hides from everyone.
  assert.equal(toolGate("auto", "rm_rf"), "hidden");
});

test("a call the verifier clears runs without asking, and the whole review is on the record", async () => {
  const seen: VerifierRequest[] = [];
  const { runtime, gate, asked, live, traced } = harness({
    verify: async (request) => {
      seen.push(request);
      return { model: "small/model", prompt: verifierPrompt(request), reply: '{"allow": true, "reason": "runs the tests"}', verdict: { allow: true, reason: "runs the tests" }, attempts: 1 };
    },
  });
  assert.equal(await gate(), true, "a cleared call is allowed");
  assert.equal(asked.length, 0, "and never reaches the user");
  // What the verifier was told: the goal, what the agent is doing, and the command itself.
  assert.equal(seen[0].goal, "run the tests");
  assert.equal(seen[0].detail, "npm test");
  const record = live.find((step) => step.kind === "verifier")!;
  assert.equal(record.title, "auto agent approved");
  assert.equal(record.status, "completed");
  assert.match(record.input!, /The user asked: run the tests/);
  assert.match(record.output!, /"allow": true/);
  // And the same exchange is in the waterfall the finished turn stored. It hangs
  // off the run rather than off the call: the harness asks without telling Emma
  // which of its calls the question is about.
  runtime.finish("t1");
  const span = traced.find((candidate) => candidate.kind === "verifier")!;
  assert.match(span.name, /auto agent approved/);
  assert.equal(span.parentId, "agent:t1");
  assert.equal(span.input, record.input);
});

test("a call the verifier will not clear goes back to the user, and the dialog says why", async () => {
  const { gate, asked, live } = harness({
    verify: async (request) => ({ model: "small/model", prompt: verifierPrompt(request), reply: '{"allow": false, "reason": "wipes a directory the user never mentioned"}', verdict: { allow: false, reason: "wipes a directory the user never mentioned" }, attempts: 1 }),
    answer: false,
  });
  assert.equal(await gate(), false, "and the user said no");
  assert.equal(asked.length, 1, "a blocked call is a question, not a refusal");
  assert.match(asked[0].detail, /npm test/);
  assert.match(asked[0].detail, /\[auto agent\] blocked this: wipes a directory the user never mentioned/);
  assert.equal(live.find((step) => step.kind === "verifier")?.title, "auto agent blocked");
});

test("a verifier that cannot answer asks the user rather than deciding for them", async () => {
  const { gate, asked, live } = harness({
    verify: async () => ({ model: "", prompt: "p", reply: "", attempts: 1, error: "No verifier model is configured in Settings → Models." }),
    answer: true,
  });
  // The user said yes, so the call still runs: a missing verifier costs a dialog, not the turn.
  assert.equal(await gate(), true);
  assert.equal(asked.length, 1);
  assert.match(asked[0].detail, /\[auto agent\] could not answer: No verifier model is configured/);
  assert.equal(live.find((step) => step.kind === "verifier")?.title, "auto agent could not answer");
});

function request(): VerifierRequest {
  return { goal: "run the tests", title: "This thread", activity: "running npm test", tool: "terminal", summary: "running npm test", detail: "rm -rf /tmp/build && npm test" };
}

/**
 * One gated command put through the channel the harness uses — `question` — with
 * the answers the test wants. The turn itself is the harness's; all Emma sees is
 * the one call it stopped to ask about.
 */
function harness({ verify, answer }: { verify: (request: VerifierRequest) => Promise<VerifierReview>; answer?: boolean }) {
  const asked: PermissionAsk[] = [];
  const live: ThreadStep[] = [];
  const traced: TraceSpan[] = [];
  const runtime: AgentRuntime = new AgentRuntime({
    request: async (method, params) => {
      if (method === "recordTrace") traced.push(...decodeSpans(params.trace));
      return {};
    },
    ask: (request) => { asked.push(request); runtime.answer(request.id, answer === true); },
    answered: () => undefined,
    advise: async () => ({ model: "", text: "no advisor" }),
    verify,
    spawnTurn: () => {},
    changed: () => {},
    step: (value) => live.push(value),
  });
  runtime.adopt({ threadId: "t1", content: "run the tests", mode: "auto", title: "This thread" });
  const gate = () => runtime.question({ threadId: "t1", tool: "terminal", summary: "running npm test", detail: "npm test" });
  return { runtime, gate, asked, live, traced };
}
