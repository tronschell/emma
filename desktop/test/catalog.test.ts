import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { modelRates, CatalogCache, fetchOpenRouterCatalog, probeProvider, readKeyBalance, type CatalogModel } from "../main/catalog";
import { balanceLine, outOfCredit, routerChain, thinkingStops, validateRouterModels, validateRouters, validateSettings, defaultSettings, FREE_ROUTER_ID, FREE_ROUTER_MODELS, MAX_ROUTERS, MAX_ROUTER_MODELS } from "../shared/settings";

const model = (id: string, free = true): CatalogModel =>
  ({ id, name: id, contextLength: 1024, inputModalities: [], free });

test("the catalog caches to disk, reports what changed, and survives a dead fetch", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "emma-catalog-"));
  try {
    const seeded = new CatalogCache(dir);
    const offline = await seeded.refresh(() => Promise.reject(new Error("no network")));
    assert.ok(offline.stale);
    assert.equal(offline.error, "no network");
    assert.ok(offline.models.length > 0, "the bundled seed stands in before any fetch lands");
    assert.ok(offline.models.some((entry) => !entry.free), "the seed carries paid models too");

    const thinker = offline.models.find((entry) => entry.reasoningEfforts?.length);
    assert.ok(thinker, "the seed publishes reasoning efforts");
    assert.ok(thinkingStops(thinker).length > 1, "so a reasoning model has slider stops before any fetch lands");
    assert.equal(thinkingStops(thinker)[0], thinker.reasoningMandatory ? "" : "off", "starting at the model's quietest rung");
    const quiet = offline.models.find((entry) => !entry.reasoningEfforts?.length);
    assert.ok(quiet, "the seed carries models that do not think either");
    assert.deepEqual(thinkingStops(quiet), []);
    assert.ok(offline.models.some((entry) => entry.promptMicroUsdPerMtok), "and the prices the models page quotes");

    const first = await seeded.refresh(() => Promise.resolve({ models: [model("a/one"), model("b/two", false)] }));
    assert.equal(first.stale, false);
    assert.deepEqual(first.models.map((entry) => entry.id), ["a/one", "b/two"]);
    assert.equal(first.models[1].free, false);

    const again = await seeded.refresh(() => Promise.resolve({ models: [model("a/one"), model("b/two", false)] }));
    assert.deepEqual(again.added, []);
    assert.deepEqual(again.removed, []);

    const changed = await seeded.refresh(() => Promise.resolve({ models: [model("a/one"), model("c/three")] }));
    assert.deepEqual(changed.added, ["c/three"]);
    assert.deepEqual(changed.removed, ["b/two"]);

    const reopened = new CatalogCache(dir);
    const cached = await reopened.refresh(() => Promise.reject(new Error("still offline")));
    assert.ok(cached.stale);
    assert.deepEqual(cached.models.map((entry) => entry.id), ["a/one", "c/three"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fetched catalog is reused for a day, and one fetch serves every caller", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "emma-catalog-"));
  try {
    const cache = new CatalogCache(dir);
    let fetches = 0;
    const fetch = () => { fetches += 1; return Promise.resolve({ models: [model("a/one")] }); };

    const mounted = await Promise.all(Array.from({ length: 8 }, () => cache.refresh(fetch, 86_400_000)));
    assert.equal(fetches, 1);
    assert.ok(mounted.every((result) => !result.stale && result.models.length === 1));

    await new CatalogCache(dir).refresh(fetch, 86_400_000);
    assert.equal(fetches, 1);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await cache.refresh(fetch, 1);
    assert.equal(fetches, 2);
    await cache.refresh(fetch);
    assert.equal(fetches, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the free router sends the whole chain, in order, minus what the catalog has dropped", () => {
  assert.equal(routerChain().split(",").length, FREE_ROUTER_MODELS.length);
  assert.equal(routerChain(), FREE_ROUTER_MODELS.join(","));
  const listed = [FREE_ROUTER_MODELS[2], FREE_ROUTER_MODELS[0], "someone/else"];
  assert.equal(routerChain(listed), `${FREE_ROUTER_MODELS[0]},${FREE_ROUTER_MODELS[2]}`);
  assert.equal(routerChain(["someone/else"]), FREE_ROUTER_MODELS.join(","));
});

test("a user's own router chain is what gets sent, and a broken one is refused", () => {
  const mine = ["z-ai/glm-5.2:free", "vendor/other:free"];
  assert.equal(routerChain([], mine), mine.join(","));
  assert.equal(routerChain(["vendor/other:free"], mine), "vendor/other:free");
  assert.equal(routerChain([], []), FREE_ROUTER_MODELS.join(","));
  assert.deepEqual(validateRouterModels(mine), mine);
  assert.deepEqual(validateRouterModels(undefined), FREE_ROUTER_MODELS);
  assert.throws(() => validateRouterModels([]));
  assert.throws(() => validateRouterModels(["z-ai/glm-5.2:free", "z-ai/glm-5.2:free"]));
  assert.throws(() => validateRouterModels(["no-slash"]));
  assert.throws(() => validateRouterModels(new Array(MAX_ROUTER_MODELS + 1).fill(0).map((_, at) => `vendor/m${at}:free`)));
});

test("routers are named, capped, and grown out of the chain a settings file saved before them", () => {
  const mine = [{ id: "deepseek", name: "DeepSeek anywhere", models: ["deepseek/deepseek-v4", "vendor/deepseek-v4"] }];
  assert.deepEqual(validateRouters(mine), mine);
  assert.deepEqual(validateRouters(undefined), defaultSettings.routers);
  assert.deepEqual(validateRouters([]), []);
  assert.throws(() => validateRouters([{ id: "a", name: "", models: ["vendor/m"] }]));
  assert.throws(() => validateRouters([{ id: "a", name: "One", models: [] }]));
  assert.throws(() => validateRouters([{ id: "Caps", name: "One", models: ["vendor/m"] }]));
  assert.throws(() => validateRouters([{ id: "a", name: "One", models: ["vendor/m"] }, { id: "a", name: "Two", models: ["vendor/m"] }]));
  assert.throws(() => validateRouters(new Array(MAX_ROUTERS + 1).fill(0).map((_, at) => ({ id: `r${at}`, name: `Router ${at}`, models: ["vendor/m"] }))));
  const legacy = validateSettings({ ...defaultSettings, routers: undefined, freeRouterModels: ["z-ai/glm-5.2:free"] } as unknown);
  assert.deepEqual(legacy.routers, [{ id: FREE_ROUTER_ID, name: "Emma Free Router", models: ["z-ai/glm-5.2:free"] }]);
  assert.equal(validateSettings({ ...defaultSettings, selectedModel: "free-router" }).selectedModel, "router:free");
});

test("the OpenRouter listing is parsed, priced, and filtered to models Emma can actually use", async () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "vendor/model",
    name: "Vendor Model",
    context_length: 8192,
    supported_parameters: ["tools"],
    pricing: { prompt: "0.000001", completion: "0.000002" },
    architecture: { input_modalities: ["text", "image"] },
    ...over,
  });
  const served = (data: unknown[]) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch;
    return () => { globalThis.fetch = original; };
  };

  let restore = served([
    row(),
    row({ id: "vendor/no-tools", supported_parameters: ["temperature"] }),
    row({ id: "vendor/no-window", context_length: 0 }),
    row({ id: "not-a-path", name: "Malformed Id" }),
    row({ name: "Duplicate" }),
    row({
      id: "vendor/free-thinker",
      name: "Free Thinker",
      pricing: { prompt: "0", completion: "0" },
      reasoning: { supported_efforts: ["low", "max", "future_mode"], mandatory: true },
    }),
    row({
      id: "vendor/default-stops",
      name: "Default Stops",
      supported_parameters: ["tools", "reasoning_effort"],
    }),
  ]);
  try {
    const { models } = await fetchOpenRouterCatalog();
    assert.deepEqual(models.map((entry) => entry.id), ["vendor/default-stops", "vendor/free-thinker", "vendor/model"]);

    const paid = models.find((entry) => entry.id === "vendor/model")!;
    assert.equal(paid.free, false);
    assert.equal(paid.promptMicroUsdPerMtok, 1_000_000);
    assert.equal(paid.completionMicroUsdPerMtok, 2_000_000);
    assert.deepEqual(paid.inputModalities, ["image"]);
    assert.deepEqual(paid.reasoningEfforts, []);

    const thinker = models.find((entry) => entry.id === "vendor/free-thinker")!;
    assert.equal(thinker.free, true);
    assert.deepEqual(thinker.reasoningEfforts, ["low", "max", "future_mode"]);
    assert.equal(thinker.reasoningMandatory, true);

    assert.deepEqual(models.find((entry) => entry.id === "vendor/default-stops")!.reasoningEfforts, ["low", "medium", "high"]);
  } finally { restore(); }

  restore = served([row({ supported_parameters: ["temperature"] })]);
  try {
    await assert.rejects(fetchOpenRouterCatalog(), /no models Emma can use/);
  } finally { restore(); }
});

test("a provider probe reports its models and whether the picked one calls tools", async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "qwen3-8b" }, { id: 7 }, { id: "  " }] }), { status: 200 });
    const body = JSON.parse(String(init?.body)) as { model: string; tools: unknown[] };
    assert.equal(body.model, "qwen3-8b");
    assert.equal(body.tools.length, 1);
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "call-1" }] } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const probe = await probeProvider("http://127.0.0.1:1234/v1", "", "qwen3-8b");
    assert.deepEqual(probe.models, ["qwen3-8b"]);
    assert.equal(probe.tools, true);
    assert.equal(probe.error, "");
    assert.deepEqual(seen, ["http://127.0.0.1:1234/v1/models", "http://127.0.0.1:1234/v1/chat/completions"]);
  } finally { globalThis.fetch = original; }

  globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
  try {
    const probe = await probeProvider("https://api.example.test/v1", "key", "some-model");
    assert.deepEqual(probe.models, []);
    assert.equal(probe.tools, false);
    assert.match(probe.error, /401/);
  } finally { globalThis.fetch = original; }
});

test("an OpenRouter key answer reads as credit left, a free key, or neither", () => {
  const paid = readKeyBalance({ data: { label: "emma", usage: 1.5, limit: 10, limit_remaining: 8.5, is_free_tier: false } });
  assert.equal(paid.remaining, 8.5);
  assert.equal(paid.freeTier, false);
  assert.equal(balanceLine(paid), "$8.50 of credit left.");

  const spent = readKeyBalance({ data: { usage: 10, limit: 10, limit_remaining: 0, is_free_tier: false } });
  assert.ok(outOfCredit(spent));
  assert.match(balanceLine(spent), /Out of credit/);

  const free = readKeyBalance({ data: { usage: 0, limit: null, limit_remaining: null, is_free_tier: true } });
  assert.equal(free.remaining, null);
  assert.ok(!outOfCredit(free));
  assert.match(balanceLine(free), /Free key/);

  const unlimited = readKeyBalance({ data: { usage: 3 } });
  assert.equal(unlimited.remaining, null);
  assert.equal(balanceLine(unlimited), "Credit on file.");

  assert.match(balanceLine({ keyed: false, freeTier: false, remaining: null, usage: 0, error: "" }), /No key yet/);
  assert.equal(balanceLine({ keyed: true, freeTier: false, remaining: null, usage: 0, error: "OpenRouter rejected that key." }), "OpenRouter rejected that key.");
})

test("council pricing reads cached rates and treats unavailable prices as zero", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "emma-rates-"));
  const file = path.join(dir, "catalog.json");
  try {
    assert.deepEqual(modelRates(file, "priced"), { input: 0, output: 0 });
    await writeFile(file, JSON.stringify({ models: [
      { id: "priced", promptMicroUsdPerMtok: 2_000_000, completionMicroUsdPerMtok: 8_000_000 },
      { id: "invalid", promptMicroUsdPerMtok: -1, completionMicroUsdPerMtok: "8" },
    ] }));
    assert.deepEqual(modelRates(file, "priced"), { input: 2_000_000, output: 8_000_000 });
    assert.deepEqual(modelRates(file, "invalid"), { input: 0, output: 0 });
    assert.deepEqual(modelRates(file, "missing"), { input: 0, output: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
