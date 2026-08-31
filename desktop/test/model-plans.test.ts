import test from "node:test";
import assert from "node:assert/strict";
import { CLI_PLANS, MODEL_PLANS, defaultSettings, isEnvName, modelPlanRoute, planBalanceLine, planFor, planForGeneration, planForModel, planForProfile, planModelId, planProfileFor, planProfileId, planSpend, providerEndpoint, validateSettings, withPlanProfile } from "../shared/settings";
import { readDeepSeekBalance } from "../main/catalog";
import { CLI_IDS } from "../shared/cli";

test("a plan is found by the OpenRouter namespace of the model it can take over", () => {
  assert.equal(planForModel("openrouter:z-ai/glm-5.2")?.id, "zai");
  assert.equal(planForModel("z-ai/glm-5.2")?.id, "zai");
  assert.equal(planForModel("openrouter:moonshotai/kimi-k2")?.id, "kimi");
  assert.equal(planForModel("openrouter:MiniMax/MiniMax-M2")?.id, "minimax");
  assert.equal(planForModel("openrouter:google/gemini-3-pro")?.id, "gemini");
  assert.equal(planForModel("openrouter:nvidia/nemotron-3-super-120b-a12b:free"), undefined);
  assert.equal(planForModel("fallback"), undefined);
  assert.equal(planForModel("router:free"), undefined);
});

test("a plan model id drops the OpenRouter namespace and the free suffix", () => {
  const plan = planFor("zai")!;
  assert.equal(planModelId(plan, "openrouter:z-ai/glm-5.2"), "glm-5.2");
  assert.equal(planModelId(plan, "openrouter:z-ai/glm-5.2:free"), "glm-5.2");
  assert.equal(planModelId(plan, "glm-5.3"), "glm-5.3");
});

test("routing models through one plan keeps a profile for each saved surface", () => {
  const plan = planFor("kimi")!;
  const once = withPlanProfile(defaultSettings, plan, "k3-256k");
  assert.equal(once.providers.length, 1);
  assert.equal(once.providers[0].id, planProfileId("kimi"));
  assert.equal(once.providers[0].baseUrl, plan.baseUrl);
  assert.equal(once.providers[0].credentialEnv, "KIMI_CODE_API_KEY");
  const twice = withPlanProfile(once, plan, "kimi-for-coding");
  assert.equal(twice.providers.length, 2);
  assert.equal(twice.providers[0].modelId, "k3-256k");
  assert.equal(twice.providers[1].id, planProfileId("kimi", 2));
  assert.equal(twice.providers[1].modelId, "kimi-for-coding");
  assert.equal(withPlanProfile(twice, plan, "k3-256k").providers.length, 2);
  const other = withPlanProfile(twice, planFor("minimax")!, "MiniMax-M3");
  assert.equal(other.providers.length, 3);
});

test("a model plan route keeps the model and provider in one provider key", () => {
  const plan = planFor("zai")!;
  const first = modelPlanRoute(defaultSettings, plan, "openrouter:z-ai/glm-5.2");
  const second = modelPlanRoute(first.settings, plan, "openrouter:z-ai/glm-4.6");
  assert.equal(first.key, "provider:plan-zai");
  assert.equal(second.key, "provider:plan-zai-2");
  assert.equal(planProfileFor(second.settings.providers, plan, "glm-5.2")?.id, "plan-zai");
  assert.equal(planProfileFor(second.settings.providers, plan, "glm-4.6")?.id, "plan-zai-2");
  assert.equal(planForProfile(second.settings.providers[1])?.id, "zai");
});

test("every plan profile survives the same validation a hand-typed provider does", () => {
  for (const plan of MODEL_PLANS) {
    const settings = validateSettings(withPlanProfile(defaultSettings, plan, "test-model"));
    const profile = settings.providers.find((item) => item.id === planProfileId(plan.id));
    assert.ok(profile, `${plan.id} did not validate`);
    assert.equal(profile.baseUrl, plan.baseUrl.replace(/\/$/, ""));
  }
});

test("every plan endpoint is https and every key slot is an environment variable name", () => {
  for (const plan of MODEL_PLANS) {
    assert.ok(providerEndpoint(plan.baseUrl), `${plan.id} has an endpoint Emma would refuse`);
    assert.equal(new URL(plan.baseUrl).protocol, "https:", `${plan.id} is not https`);
    assert.ok(isEnvName(plan.credentialEnv), `${plan.id} has an invalid key variable`);
    assert.ok(plan.keysUrl.startsWith("https://"), `${plan.id} has no console link`);
    assert.ok(plan.note.length > 0, `${plan.id} says nothing about what it bills`);
  }
  assert.equal(new Set(MODEL_PLANS.map((plan) => plan.id)).size, MODEL_PLANS.length);
  assert.equal(new Set(MODEL_PLANS.map((plan) => plan.credentialEnv)).size, MODEL_PLANS.length);
});

test("a plan whose subscription no endpoint can bill is marked metered, not subscription", () => {
  assert.equal(planFor("openai")?.billing, "metered");
  assert.equal(planFor("anthropic")?.billing, "metered");
  assert.equal(planFor("deepseek")?.billing, "metered");
  assert.equal(planFor("gemini")?.billing, "metered");
  assert.equal(planFor("zai")?.billing, "subscription");
});

test("a CLI plan names a harness Emma can actually spawn and detect", () => {
  for (const plan of CLI_PLANS) {
    assert.ok(CLI_IDS.includes(plan.id), `${plan.id} is not a CLI Emma runs`);
    assert.ok(plan.note.includes("unmodified"), `${plan.id} does not say it runs the vendor's own binary`);
  }
  assert.deepEqual(CLI_PLANS.map((plan) => plan.id), ["claude", "codex", "gemini"]);
});

test("a turn is billed to a plan only when its model is the bare slug that plan currently holds", () => {
  const settings = withPlanProfile(defaultSettings, planFor("zai")!, "glm-5.2");
  assert.equal(planForGeneration("glm-5.2", settings.providers), "zai");
  assert.equal(planForGeneration("z-ai/glm-5.2", settings.providers), undefined);
  assert.equal(planForGeneration("glm-5.3", settings.providers), undefined);
  assert.equal(planForGeneration("", settings.providers), undefined);
});

test("plan spend counts only the turns inside the window", () => {
  const settings = withPlanProfile(defaultSettings, planFor("kimi")!, "k3");
  const generations = [
    { at: 1_000, model: "k3", inputTokens: 100, outputTokens: 10 },
    { at: 5_000, model: "k3", inputTokens: 200, outputTokens: 20 },
    { at: 5_000, model: "moonshotai/kimi-k2", inputTokens: 999, outputTokens: 99 },
  ];
  const inside = planSpend(generations, settings.providers, 2_000).get("kimi")!;
  assert.deepEqual(inside, { turns: 1, inputTokens: 200, outputTokens: 20 });
  const all = planSpend(generations, settings.providers, 0).get("kimi")!;
  assert.deepEqual(all, { turns: 2, inputTokens: 300, outputTokens: 30 });
  assert.equal(planSpend(generations, settings.providers, 9_000).size, 0);
});

test("a DeepSeek balance reads its money out of strings and keeps the currency", () => {
  const balance = readDeepSeekBalance({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00" }] });
  assert.equal(balance.remaining, 110);
  assert.equal(balance.currency, "CNY");
  assert.equal(planBalanceLine(balance), "\u00a5110.00 left");
  assert.equal(planBalanceLine(readDeepSeekBalance({ balance_infos: [{ currency: "USD", total_balance: "0.00" }] })), "Out of balance");
  assert.equal(planBalanceLine({ keyed: false, freeTier: false, remaining: null, usage: 0, error: "" }), "");
});
