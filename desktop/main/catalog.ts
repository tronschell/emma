import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { catalogSeed } from "./catalog-seed";
import { DEEPSEEK_BALANCE_URL, MODEL_ID, providerChatUrl, providerModelsUrl, type KeyBalance } from "../shared/settings";

export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number;
  inputModalities: string[];

  reasoningEfforts?: string[];
  reasoningMandatory?: boolean;
  free: boolean;

  promptMicroUsdPerMtok?: number;
  completionMicroUsdPerMtok?: number;
}

export interface Catalog {
  selectedModel?: string;
  models: CatalogModel[];
}

export interface CatalogResult extends Catalog {
  added: string[];
  removed: string[];
  fetchedAt: string;

  stale: boolean;
  error?: string;
}

const isModel = (value: unknown): value is CatalogModel => {
  const model = value as CatalogModel;
  return !!model && typeof model === "object" && typeof model.id === "string" && typeof model.name === "string"
    && typeof model.contextLength === "number" && Array.isArray(model.inputModalities);
};

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?supported_parameters=tools&sort=most-popular";
const MAX_CATALOG_MODELS = 2048;
const EFFORT_NAMES = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const EFFORT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const MODALITIES = ["image", "file", "audio"];

const microUsdPerMtok = (value: unknown): number => {
  if (typeof value !== "string") return 0;
  const usdPerToken = Number.parseFloat(value);
  if (!Number.isFinite(usdPerToken) || usdPerToken <= 0) return 0;
  return Math.round(usdPerToken * 1e12);
};

const isZeroPrice = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed === 0;
};

const supportsParameter = (value: unknown, name: string) => Array.isArray(value) && value.includes(name);

const readable = (id: string, name: string, contextLength: number, modalities: string[]) =>
  id.length <= 128 && MODEL_ID.test(id)
  && name.trim().length > 0 && name.length <= 256
  // eslint-disable-next-line no-control-regex
  && !/[\u0000-\u001f\u007f]/.test(name)
  && Number.isInteger(contextLength) && contextLength >= 1 && contextLength <= 100_000_000
  && modalities.every((modality) => MODALITIES.includes(modality));

export async function fetchOpenRouterCatalog(timeoutMs = 30_000): Promise<Catalog> {
  const response = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`OpenRouter answered ${response.status}.`);
  const body = await response.json() as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("OpenRouter returned an unreadable catalog.");
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const row of body.data as Record<string, unknown>[]) {
    if (models.length === MAX_CATALOG_MODELS) break;
    if (!row || typeof row !== "object") continue;
    const pricing = row.pricing as Record<string, unknown> | undefined;
    if (!pricing || typeof pricing !== "object") continue;
    if (!supportsParameter(row.supported_parameters, "tools")) continue;
    const id = typeof row.id === "string" ? row.id : "";
    const name = typeof row.name === "string" ? row.name : "";
    const contextLength = typeof row.context_length === "number" ? row.context_length : 0;
    const architecture = row.architecture as Record<string, unknown> | undefined;
    const listed = Array.isArray(architecture?.input_modalities) ? architecture.input_modalities : [];
    const inputModalities = listed.filter((modality): modality is string => MODALITIES.includes(modality as string));
    if (!readable(id, name, contextLength, inputModalities) || seen.has(id)) continue;
    seen.add(id);
    const reasoning = row.reasoning as Record<string, unknown> | undefined;
    const published = Array.isArray(reasoning?.supported_efforts)
      ? [...new Set(reasoning.supported_efforts.filter((effort): effort is string => typeof effort === "string" && EFFORT_NAME.test(effort)))]
      : [];
    let reasoningEfforts = [...EFFORT_NAMES.filter((effort) => published.includes(effort)), ...published.filter((effort) => !EFFORT_NAMES.includes(effort))];
    if (!reasoningEfforts.length && supportsParameter(row.supported_parameters, "reasoning_effort")) {
      reasoningEfforts = ["low", "medium", "high"];
    }
    models.push({
      id,
      name,
      contextLength,
      inputModalities,
      reasoningEfforts,
      reasoningMandatory: reasoning?.mandatory === true,
      free: isZeroPrice(pricing.prompt) && isZeroPrice(pricing.completion),
      promptMicroUsdPerMtok: microUsdPerMtok(pricing.prompt),
      completionMicroUsdPerMtok: microUsdPerMtok(pricing.completion),
    });
  }
  if (!models.length) throw new Error("OpenRouter listed no models Emma can use — check your connection and try again");
  models.sort((left, right) => left.name.localeCompare(right.name));
  return { models };
}

export class CatalogCache {
  private readonly file: string;
  private models: CatalogModel[];
  private fetchedAt = "";
  private inFlight?: Promise<CatalogResult>;

  constructor(userData: string) {
    this.file = path.join(userData, "openrouter-catalog.json");
    this.models = catalogSeed.filter(isModel);
    try {
      const stored = JSON.parse(readFileSync(this.file, "utf8")) as { models?: unknown; fetchedAt?: unknown };
      const models = Array.isArray(stored.models) ? stored.models.filter(isModel) : [];
      if (models.length) this.models = models;
      if (typeof stored.fetchedAt === "string") this.fetchedAt = stored.fetchedAt;
    } catch { return; }
  }

  contextLength(id: string | undefined): number | undefined {
    if (!id) return undefined;
    return this.models.find((model) => model.id === id)?.contextLength;
  }

  reasoningEfforts(id: string | undefined): string[] {
    if (!id) return [];
    return this.models.find((model) => model.id === id)?.reasoningEfforts ?? [];
  }

  ids(): string[] {
    return this.models.map((model) => model.id);
  }

  async refresh(fetch: () => Promise<Catalog>, maxAgeMs = 0): Promise<CatalogResult> {
    if (maxAgeMs && Date.now() - Date.parse(this.fetchedAt) < maxAgeMs) {
      return { models: this.models, added: [], removed: [], fetchedAt: this.fetchedAt, stale: false };
    }
    if (!this.inFlight) {
      this.inFlight = this.fetchNow(fetch);
      void this.inFlight.finally(() => { this.inFlight = undefined; });
    }
    return this.inFlight;
  }

  private async fetchNow(fetch: () => Promise<Catalog>): Promise<CatalogResult> {
    const previous = new Set(this.models.map((model) => model.id));
    let catalog: Catalog;
    try {
      catalog = await fetch();
    } catch (reason) {
      return {
        models: this.models,
        added: [],
        removed: [],
        fetchedAt: this.fetchedAt,
        stale: true,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
    const models = catalog.models.filter(isModel);
    const current = new Set(models.map((model) => model.id));
    this.models = models;
    this.fetchedAt = new Date().toISOString();
    try { writeFileSync(this.file, JSON.stringify({ fetchedAt: this.fetchedAt, models }), { mode: 0o600 }); }
    catch (error) { console.warn("Emma could not cache the model catalog", error); }
    return {
      selectedModel: catalog.selectedModel,
      models,
      added: models.filter((model) => !previous.has(model.id)).map((model) => model.id),
      removed: [...previous].filter((id) => !current.has(id)),
      fetchedAt: this.fetchedAt,
      stale: false,
    };
  }
}

export type ProviderProbe = { models: string[]; tools: boolean; error: string };

const MAX_PROBE_MODELS = 512;
const PROBE_TIMEOUT_MS = 20_000;

const PROBE_TOOL = {
  type: "function",
  function: {
    name: "emma_probe",
    description: "Report the weather. Call this tool to answer.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

export async function listProviderModels(baseUrl: string, key: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<string[]> {
  const response = await fetch(providerModelsUrl(baseUrl), {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`The endpoint answered ${response.status} when asked for its models.`);
  const body = await response.json() as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("The endpoint returned no model list.");
  return body.data
    .map((row) => (row as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string" && !!id.trim() && id.length <= 128)
    .slice(0, MAX_PROBE_MODELS);
}

export async function probeProviderTools(baseUrl: string, key: string, model: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const response = await fetch(providerChatUrl({ baseUrl }), {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
      tools: [PROBE_TOOL],
      max_tokens: 64,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`The endpoint answered ${response.status} when asked for a tool call.`);
  const body = await response.json() as { choices?: { message?: { tool_calls?: unknown } }[] };
  return Array.isArray(body.choices?.[0]?.message?.tool_calls) && body.choices[0].message.tool_calls.length > 0;
}

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

const finiteNumber = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

export function readKeyBalance(body: unknown): KeyBalance {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  return {
    keyed: true,
    freeTier: data?.is_free_tier === true,
    remaining: finiteNumber(data?.limit_remaining) ?? finiteNumber(data?.limit),
    usage: finiteNumber(data?.usage) ?? 0,
    error: "",
  };
}

export async function fetchOpenRouterBalance(key: string, timeoutMs = 15_000): Promise<KeyBalance> {
  const blank: KeyBalance = { keyed: !!key, freeTier: false, remaining: null, usage: 0, error: "" };
  if (!key) return blank;
  try {
    const response = await fetch(OPENROUTER_KEY_URL, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 401 || response.status === 403) return { ...blank, error: "OpenRouter rejected that key." };
    if (!response.ok) return { ...blank, error: `OpenRouter answered ${response.status} when asked about the key.` };
    return readKeyBalance(await response.json());
  } catch (reason) {
    return { ...blank, error: reason instanceof Error ? reason.message : String(reason) };
  }
}

export async function fetchDeepSeekBalance(key: string, timeoutMs = 15_000): Promise<KeyBalance> {
  const blank: KeyBalance = { keyed: !!key, freeTier: false, remaining: null, usage: 0, error: "" };
  if (!key) return blank;
  try {
    const response = await fetch(DEEPSEEK_BALANCE_URL, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 401 || response.status === 403) return { ...blank, error: "DeepSeek rejected that key." };
    if (!response.ok) return { ...blank, error: `DeepSeek answered ${response.status} when asked about the key.` };
    return readDeepSeekBalance(await response.json());
  } catch (reason) {
    return { ...blank, error: reason instanceof Error ? reason.message : String(reason) };
  }
}

export function readDeepSeekBalance(body: unknown): KeyBalance {
  const data = body as { is_available?: unknown; balance_infos?: unknown } | null;
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos as Record<string, unknown>[] : [];
  const info = infos.find((item) => item.currency === "USD") ?? infos[0];
  const total = typeof info?.total_balance === "string" ? Number.parseFloat(info.total_balance) : null;
  return {
    keyed: true,
    freeTier: false,
    remaining: total !== null && Number.isFinite(total) ? total : null,
    usage: 0,
    error: data?.is_available === false && !total ? "DeepSeek reports this key cannot be used." : "",
    currency: typeof info?.currency === "string" ? info.currency : undefined,
  };
}

export async function probeProvider(baseUrl: string, key: string, model: string): Promise<ProviderProbe> {
  const probe: ProviderProbe = { models: [], tools: false, error: "" };
  try { probe.models = await listProviderModels(baseUrl, key); }
  catch (reason) { probe.error = reason instanceof Error ? reason.message : String(reason); }
  if (!model) return probe;
  try { probe.tools = await probeProviderTools(baseUrl, key, model); }
  catch (reason) { if (!probe.error) probe.error = reason instanceof Error ? reason.message : String(reason); }
  return probe;
}

export function modelRates(catalogFile: string, modelId: string): { input: number; output: number } {
  try {
    const stored = JSON.parse(readFileSync(catalogFile, "utf8")) as { models?: Record<string, unknown>[] };
    const model = stored.models?.find((candidate) => candidate.id === modelId);
    const rate = (name: string) => {
      const value = model?.[name];
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
    };
    return { input: rate("promptMicroUsdPerMtok"), output: rate("completionMicroUsdPerMtok") };
  } catch {
    return { input: 0, output: 0 };
  }
}
