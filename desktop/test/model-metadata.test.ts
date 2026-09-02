import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelMetadataCatalog } from "../main/model-metadata";
import type { CatalogModel } from "../main/catalog";
import type { ProviderProfile } from "../shared/settings";

const openrouter: CatalogModel[] = [{
  id: "openai/gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  contextLength: 1_050_000,
  inputModalities: ["image"],
  reasoningEfforts: ["low", "max"],
  free: false,
  promptMicroUsdPerMtok: 4_000_000,
  completionMicroUsdPerMtok: 20_000_000,
}];

const direct: ProviderProfile = {
  id: "plan-openai",
  name: "OpenAI",
  modelId: "gpt-5.6-sol",
  baseUrl: "https://api.openai.com/v1",
  credentialEnv: "OPENAI_API_KEY",
  contextWindow: 0,
  insecure: false,
};

const modelsDev = {
  openrouter: {
    id: "openrouter",
    models: {
      "openai/gpt-5.6-sol": {
        id: "openai/gpt-5.6-sol",
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1_050_000, input: 922_000, output: 128_000 },
        cost: { input: 5, output: 25 },
      },
    },
  },
  zai: {
    id: "zai",
    api: "https://api.z.ai/api/paas/v4",
    models: { "glm-5.3-flash": { id: "glm-5.3-flash", limit: { context: 1_000_000, output: 131_072 } } },
  },
  openai: {
    id: "openai",
    models: {
      "gpt-5.6-sol": {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        description: "Frontier model",
        family: "gpt-sol",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "max", "ultra", "future_mode"] }],
        tool_call: true,
        structured_output: true,
        temperature: false,
        knowledge: "2026-02-16",
        release_date: "2026-07-09",
        last_updated: "2026-07-09",
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        limit: { context: 1_050_000, input: 922_000, output: 128_000 },
        cost: { input: 4, output: 20, cache_read: 0.4 },
      },
    },
  },
};

test("model metadata stays distinct for OpenRouter, direct API, and Codex subscription routes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "emma-model-metadata-"));
  const codexFile = path.join(dir, "codex-models.json");
  try {
    await writeFile(codexFile, JSON.stringify({
      fetched_at: "2026-08-31T04:28:22Z",
      models: [{
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        description: "Latest frontier agentic coding model.",
        context_window: 272_000,
        max_context_window: 872_000,
        effective_context_window_percent: 95,
        default_reasoning_level: "low",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }, { effort: "ultra" }],
        input_modalities: ["text", "image"],
      }, { slug: "gpt-reserve", visibility: "hide", context_window: 999_999 }],
    }));
    const catalog = new ModelMetadataCatalog(dir, codexFile);
    const refreshed = await catalog.refresh(0, async () => modelsDev);
    assert.equal(refreshed.stale, false);
    const routes = catalog.routes(openrouter, [direct]);
    assert.equal(routes["openrouter:openai/gpt-5.6-sol"].contextWindow, 1_050_000);
    assert.equal(routes["openrouter:openai/gpt-5.6-sol"].maxOutputTokens, 128_000);
    assert.equal(routes["openrouter:openai/gpt-5.6-sol"].inputUsdPerMillion, 4);
    assert.equal(routes["provider:plan-openai"].contextWindow, 1_050_000);
    assert.equal(routes["provider:plan-openai"].maxOutputTokens, 128_000);
    assert.deepEqual(routes["provider:plan-openai"].reasoningEfforts, ["low", "max", "ultra", "future_mode"]);
    assert.equal(routes["codex:gpt-5.6-sol"].contextWindow, 258_400);
    assert.equal(routes["codex:gpt-5.6-sol"].advertisedContextWindow, 272_000);
    assert.equal(routes["codex:gpt-5.6-sol"].maximumContextWindow, 872_000);
    assert.deepEqual(routes["codex:gpt-5.6-sol"].reasoningEfforts, ["low", "max", "ultra"]);
    assert.equal(routes["codex:gpt-reserve"], undefined);

    const preset: ProviderProfile = { ...direct, id: "p-zai", name: "Z.AI", modelId: "glm-5.3-flash", baseUrl: "https://api.z.ai/api/paas/v4/", credentialEnv: "ZAI_API_KEY" };
    assert.equal(catalog.routes(openrouter, [preset])["provider:p-zai"].contextWindow, 1_000_000);

    const manual = { ...direct, id: "manual", contextWindow: 64_000 };
    const overridden = catalog.routes(openrouter, [manual])["provider:manual"];
    assert.equal(overridden.source, "manual");
    assert.equal(overridden.contextWindow, 64_000);

    const reopened = new ModelMetadataCatalog(dir, codexFile);
    const offline = await reopened.refresh(0, async () => Promise.reject(new Error("offline")));
    assert.equal(offline.stale, true);
    assert.equal(reopened.routes(openrouter, [direct])["provider:plan-openai"].contextWindow, 1_050_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex metadata hot reloads and keeps the last good file during a partial rewrite", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "emma-codex-metadata-"));
  const codexFile = path.join(dir, "codex-models.json");
  const save = async (slug: string, context: number, offset: number) => {
    await writeFile(codexFile, JSON.stringify({ models: [{ slug, context_window: context, effective_context_window_percent: 90 }] }));
    const changed = new Date(Date.now() + offset);
    await utimes(codexFile, changed, changed);
  };
  try {
    await save("gpt-first", 100_000, 1_000);
    const catalog = new ModelMetadataCatalog(dir, codexFile);
    assert.equal(catalog.routes([], [])["codex:gpt-first"].contextWindow, 90_000);

    await writeFile(codexFile, "{");
    const partial = new Date(Date.now() + 2_000);
    await utimes(codexFile, partial, partial);
    assert.equal(catalog.routes([], [])["codex:gpt-first"].contextWindow, 90_000);

    await save("gpt-second", 200_000, 3_000);
    const routes = catalog.routes([], []);
    assert.equal(routes["codex:gpt-first"], undefined);
    assert.equal(routes["codex:gpt-second"].contextWindow, 180_000);

    await rm(codexFile, { force: true });
    assert.equal(catalog.routes([], [])["codex:gpt-second"].contextWindow, 180_000);

    await save("gpt-third", 300_000, 4_000);
    assert.equal(catalog.routes([], [])["codex:gpt-third"].contextWindow, 270_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("metadata refreshes once per age window and routes hundreds of new OpenRouter models", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "emma-model-scale-"));
  try {
    const catalog = new ModelMetadataCatalog(dir, path.join(dir, "missing-codex.json"));
    let loads = 0;
    const load = async () => {
      loads++;
      return { openrouter: { models: { "vendor/new-release": { limit: { context: 400_000 } } } } };
    };
    await Promise.all([catalog.refresh(0, load), catalog.refresh(0, load)]);
    assert.equal(loads, 1);
    await catalog.refresh(60_000, load);
    assert.equal(loads, 1);
    await catalog.refresh(0, load);
    assert.equal(loads, 2);

    const models: CatalogModel[] = Array.from({ length: 750 }, (_, index) => ({
      id: `vendor/model-${index}`,
      name: `Model ${index}`,
      contextLength: 128_000 + index,
      inputModalities: [],
      free: false,
    }));
    models.push({ id: "vendor/new-release", name: "New Release", contextLength: 500_000, inputModalities: [], free: false });
    const routes = catalog.routes(models, []);
    assert.equal(Object.keys(routes).length, 751);
    assert.equal(routes["openrouter:vendor/model-749"].contextWindow, 128_749);
    assert.equal(routes["openrouter:vendor/new-release"].contextWindow, 500_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
