import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CODEX_MODEL_ID, CODEX_PREFIX, planForProfile, type ProviderProfile } from "../shared/settings";
import type { CatalogModel } from "./catalog";

export type RouteModelMetadata = {
  source: "openrouter" | "models.dev" | "codex" | "manual";
  name?: string;
  description?: string;
  family?: string;
  contextWindow?: number;
  advertisedContextWindow?: number;
  maximumContextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  reasoning?: boolean;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  toolCall?: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  knowledgeCutoff?: string;
  releaseDate?: string;
  updatedAt?: string;
  fetchedAt?: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cacheReadUsdPerMillion?: number;
};

export type MetadataRefresh = { fetchedAt: string; stale: boolean; error?: string };

type JsonObject = Record<string, unknown>;
type ModelsDevCatalog = Record<string, JsonObject>;

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_FILE = "model-metadata.json";
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PROVIDERS = 512;
const MAX_MODELS = 4096;
const SAFE_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SAFE_EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
const PLAN_PROVIDER: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  deepseek: "deepseek",
  qwen: "alibaba-coding-plan",
  zai: "zai-coding-plan",
  kimi: "kimi-for-coding",
  minimax: "minimax-coding-plan",
  gemini: "google",
  mistral: "mistral",
};

const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;

const text = (value: unknown, maximum = 4096): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= maximum ? value : undefined;

const tokens = (value: unknown): number | undefined =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) <= 100_000_000 ? value as number : undefined;

const money = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000 ? value : undefined;

const strings = (value: unknown, maximum = 64): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const result = [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 64))].slice(0, maximum);
  return result.length ? result : undefined;
};

function validCatalog(value: unknown): ModelsDevCatalog {
  const input = object(value);
  if (!input) throw new Error("models.dev returned an unreadable catalog.");
  const catalog = Object.create(null) as ModelsDevCatalog;
  for (const [providerId, rawProvider] of Object.entries(input).slice(0, MAX_PROVIDERS)) {
    const provider = object(rawProvider);
    const rawModels = object(provider?.models);
    if (!SAFE_PROVIDER.test(providerId) || !provider || !rawModels) continue;
    const models = Object.create(null) as JsonObject;
    for (const [modelId, rawModel] of Object.entries(rawModels).slice(0, MAX_MODELS)) {
      const model = object(rawModel);
      if (SAFE_MODEL.test(modelId) && model) models[modelId] = model;
    }
    if (Object.keys(models).length) catalog[providerId] = { ...provider, models };
  }
  if (!Object.keys(catalog).length) throw new Error("models.dev listed no readable providers.");
  return catalog;
}

export async function fetchModelsDevCatalog(timeoutMs = 30_000): Promise<ModelsDevCatalog> {
  const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`models.dev answered ${response.status}.`);
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BYTES) throw new Error("models.dev returned a catalog that is too large.");
  return validCatalog(JSON.parse(body) as unknown);
}

function modelsDevMetadata(catalog: ModelsDevCatalog, fetchedAt: string, providerId: string, modelId: string): RouteModelMetadata | undefined {
  const provider = catalog[providerId];
  const model = object(object(provider?.models)?.[modelId]);
  if (!model) return undefined;
  const limit = object(model.limit);
  const modalities = object(model.modalities);
  const cost = object(model.cost);
  const efforts = Array.isArray(model.reasoning_options)
    ? model.reasoning_options.flatMap((option) => {
      const row = object(option);
      return row?.type === "effort" ? strings(row.values) ?? [] : [];
    }).filter((effort) => SAFE_EFFORT.test(effort))
    : [];
  return {
    source: "models.dev",
    name: text(model.name, 256),
    description: text(model.description),
    family: text(model.family, 128),
    contextWindow: tokens(limit?.context),
    maxInputTokens: tokens(limit?.input),
    maxOutputTokens: tokens(limit?.output),
    inputModalities: strings(modalities?.input),
    outputModalities: strings(modalities?.output),
    reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
    reasoningEfforts: [...new Set(efforts)],
    toolCall: typeof model.tool_call === "boolean" ? model.tool_call : undefined,
    structuredOutput: typeof model.structured_output === "boolean" ? model.structured_output : undefined,
    temperature: typeof model.temperature === "boolean" ? model.temperature : undefined,
    knowledgeCutoff: text(model.knowledge, 64),
    releaseDate: text(model.release_date, 64),
    updatedAt: text(model.last_updated, 64),
    fetchedAt,
    inputUsdPerMillion: money(cost?.input),
    outputUsdPerMillion: money(cost?.output),
    cacheReadUsdPerMillion: money(cost?.cache_read),
  };
}

function codexMetadata(row: JsonObject, fetchedAt: string): RouteModelMetadata | undefined {
  const slug = text(row.slug, 128);
  if (!slug || !CODEX_MODEL_ID.test(slug) || row.visibility === "hide") return undefined;
  const advertised = tokens(row.context_window);
  const percent = typeof row.effective_context_window_percent === "number" && row.effective_context_window_percent > 0 && row.effective_context_window_percent <= 100
    ? row.effective_context_window_percent
    : 100;
  const efforts = Array.isArray(row.supported_reasoning_levels)
    ? row.supported_reasoning_levels.flatMap((value) => {
      const effort = text(object(value)?.effort, 32);
      return effort && SAFE_EFFORT.test(effort) ? [effort] : [];
    })
    : [];
  return {
    source: "codex",
    name: text(row.display_name, 256),
    description: text(row.description),
    contextWindow: advertised ? Math.floor(advertised * percent / 100) : undefined,
    advertisedContextWindow: advertised,
    maximumContextWindow: tokens(row.max_context_window),
    inputModalities: strings(row.input_modalities),
    reasoningEfforts: [...new Set(efforts)],
    defaultReasoningEffort: text(row.default_reasoning_level, 32),
    toolCall: true,
    fetchedAt,
  };
}

export class ModelMetadataCatalog {
  private readonly file: string;
  private catalog: ModelsDevCatalog = {};
  private fetchedAt = "";
  private inFlight?: Promise<MetadataRefresh>;
  private codexModified = -1;
  private codexModels = new Map<string, RouteModelMetadata>();

  constructor(userData: string, private readonly codexFile = path.join(homedir(), ".codex", "models_cache.json")) {
    this.file = path.join(userData, CACHE_FILE);
    try {
      const stored = JSON.parse(readFileSync(this.file, "utf8")) as { catalog?: unknown; fetchedAt?: unknown };
      this.catalog = validCatalog(stored.catalog);
      if (typeof stored.fetchedAt === "string") this.fetchedAt = stored.fetchedAt;
    } catch (error) { void error; }
  }

  async refresh(maxAgeMs = 0, load: () => Promise<unknown> = fetchModelsDevCatalog): Promise<MetadataRefresh> {
    if (maxAgeMs && Date.now() - Date.parse(this.fetchedAt) < maxAgeMs) return { fetchedAt: this.fetchedAt, stale: false };
    if (!this.inFlight) {
      this.inFlight = this.fetchNow(load);
      void this.inFlight.finally(() => { this.inFlight = undefined; });
    }
    return this.inFlight;
  }

  provider(profile: ProviderProfile): RouteModelMetadata | undefined {
    const providerId = this.providerId(profile);
    const found = providerId ? modelsDevMetadata(this.catalog, this.fetchedAt, providerId, profile.modelId) : undefined;
    if (!profile.contextWindow) return found;
    return { ...found, source: "manual", contextWindow: profile.contextWindow };
  }

  /**
   * Which models.dev provider a profile is talking to. A plan knows its own; anything else —
   * a preset, a custom endpoint — is matched on the base URL models.dev publishes, so direct
   * providers state their windows without a per-provider table to keep up to date.
   */
  private providerId(profile: ProviderProfile): string | undefined {
    const plan = planForProfile(profile);
    if (plan) return PLAN_PROVIDER[plan.id] ?? plan.id;
    const api = profile.baseUrl.replace(/\/+$/, "");
    return api ? Object.keys(this.catalog).find((id) => text(this.catalog[id]?.api, 512) === api) : undefined;
  }

  codex(slug: string): RouteModelMetadata | undefined {
    this.readCodex();
    return this.codexModels.get(slug);
  }

  routes(openrouter: readonly CatalogModel[], profiles: readonly ProviderProfile[]): Record<string, RouteModelMetadata> {
    const routes: Record<string, RouteModelMetadata> = {};
    for (const model of openrouter) {
      const published = modelsDevMetadata(this.catalog, this.fetchedAt, "openrouter", model.id);
      routes[`openrouter:${model.id}`] = {
        ...published,
        source: "openrouter",
        name: model.name,
        contextWindow: model.contextLength,
        inputModalities: model.inputModalities,
        reasoningEfforts: model.reasoningEfforts?.length ? model.reasoningEfforts : published?.reasoningEfforts,
        toolCall: true,
        inputUsdPerMillion: model.promptMicroUsdPerMtok === undefined ? published?.inputUsdPerMillion : model.promptMicroUsdPerMtok / 1_000_000,
        outputUsdPerMillion: model.completionMicroUsdPerMtok === undefined ? published?.outputUsdPerMillion : model.completionMicroUsdPerMtok / 1_000_000,
      };
    }
    for (const profile of profiles) {
      const found = this.provider(profile);
      if (found) routes[`provider:${profile.id}`] = found;
    }
    this.readCodex();
    for (const [slug, found] of this.codexModels) routes[`${CODEX_PREFIX}${slug}`] = found;
    return routes;
  }

  private async fetchNow(load: () => Promise<unknown>): Promise<MetadataRefresh> {
    try {
      const catalog = validCatalog(await load());
      this.catalog = catalog;
      this.fetchedAt = new Date().toISOString();
      try { writeFileSync(this.file, JSON.stringify({ fetchedAt: this.fetchedAt, catalog }), { mode: 0o600 }); } catch (error) { void error; }
      return { fetchedAt: this.fetchedAt, stale: false };
    } catch (reason) {
      return { fetchedAt: this.fetchedAt, stale: true, error: reason instanceof Error ? reason.message : String(reason) };
    }
  }

  private readCodex() {
    let modified: number;
    try { modified = statSync(this.codexFile).mtimeMs; } catch { return; }
    if (modified === this.codexModified) return;
    try {
      const body = JSON.parse(readFileSync(this.codexFile, "utf8")) as { fetched_at?: unknown; models?: unknown };
      const fetchedAt = typeof body.fetched_at === "string" ? body.fetched_at : "";
      if (!Array.isArray(body.models) || body.models.length > MAX_MODELS) return;
      const models = new Map<string, RouteModelMetadata>();
      for (const value of body.models) {
        const row = object(value);
        const found = row && codexMetadata(row, fetchedAt);
        const slug = row && text(row.slug, 128);
        if (found && slug) models.set(slug, found);
      }
      this.codexModels = models;
      this.codexModified = modified;
    } catch (error) { void error; }
  }
}
