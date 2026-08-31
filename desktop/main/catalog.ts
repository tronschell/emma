import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { catalogSeed } from "./catalog-seed";
import { DEEPSEEK_BALANCE_URL, MODEL_ID, providerChatUrl, providerModelsUrl, type KeyBalance } from "../shared/settings";

export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number;
  inputModalities: string[];
  /** The thinking modes this model offers, weakest first; absent or empty means none. */
  reasoningEfforts?: string[];
  reasoningMandatory?: boolean;
  free: boolean;
  /** What a million tokens costs, in micro-dollars ($1 = 1_000_000). 0 is free, or unpublished. */
  promptMicroUsdPerMtok?: number;
  completionMicroUsdPerMtok?: number;
}

export interface Catalog {
  selectedModel?: string;
  models: CatalogModel[];
}

/** What the models page renders: the catalog plus what changed since the last fetch. */
export interface CatalogResult extends Catalog {
  added: string[];
  removed: string[];
  fetchedAt: string;
  /** True when the fetch failed and these models came off disk instead. */
  stale: boolean;
  error?: string;
}

const isModel = (value: unknown): value is CatalogModel => {
  const model = value as CatalogModel;
  return !!model && typeof model === "object" && typeof model.id === "string" && typeof model.name === "string"
    && typeof model.contextLength === "number" && Array.isArray(model.inputModalities);
};

/** The listing is public, so this request carries no credential — browsing models works before a key exists. */
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?supported_parameters=tools&sort=most-popular";
const MAX_CATALOG_MODELS = 2048;
/** The closed effort vocabulary, weakest first. A model may publish any subset. */
const EFFORT_NAMES = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODALITIES = ["image", "file", "audio"];

/** A price string in dollars per token, as micro-dollars per million tokens. Unreadable is 0. */
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

/**
 * A listing row is remote input, so every field is checked before it becomes a model: a
 * malformed id, an unprintable name or a nonsense window is one vendor's bad row, dropped
 * rather than allowed to poison the picker.
 */
const readable = (id: string, name: string, contextLength: number, modalities: string[]) =>
  id.length <= 128 && MODEL_ID.test(id)
  && name.trim().length > 0 && name.length <= 256
  // eslint-disable-next-line no-control-regex
  && !/[\u0000-\u001f\u007f]/.test(name)
  && Number.isInteger(contextLength) && contextLength >= 1 && contextLength <= 100_000_000
  && modalities.every((modality) => MODALITIES.includes(modality));

/**
 * OpenRouter's live tool-capable catalog.
 *
 * Emma advertises tools on every turn, so a model without tool support fails the moment it
 * is used and never belongs in the list. Everything else is the vendor's own metadata,
 * validated on the way in.
 */
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
    const published = Array.isArray(reasoning?.supported_efforts) ? reasoning.supported_efforts : [];
    let reasoningEfforts = EFFORT_NAMES.filter((effort) => published.includes(effort));
    // `reasoning_effort` with no published list: OpenRouter's own three-stop default, so the
    // knob is offered with the vendor default behind it rather than a value it would reject.
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

/**
 * The OpenRouter catalog, cached on disk so the models page paints instantly, survives a
 * dead network, and can say what actually changed when the user reloads it. The bundled
 * seed covers the very first launch, before any fetch has ever landed.
 */
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
      // A cache older than the seed is still worth keeping: it is what this user last saw.
      if (models.length) this.models = models;
      if (typeof stored.fetchedAt === "string") this.fetchedAt = stored.fetchedAt;
    } catch { /* No cache yet, or an unreadable one: the seed stands in. */ }
  }

  /**
   * A model's context window, from whatever the cache last saw.
   *
   * The harness only recognises a few model-id prefixes and treats every other
   * window as unknown, which silently caps its history at a fixed default and
   * disables its token-pressure compaction. This is the number it is missing.
   */
  contextLength(id: string | undefined): number | undefined {
    if (!id) return undefined;
    return this.models.find((model) => model.id === id)?.contextLength;
  }

  /**
   * The thinking efforts a model publishes, weakest first.
   *
   * The same reason as the window above: the harness's own capability table knows a
   * handful of prefixes and nothing about this model, so an effort it was not told
   * about is dropped rather than sent. This is the list it is missing, and the one a
   * stop off the slider is checked against before it ever reaches a request.
   */
  reasoningEfforts(id: string | undefined): string[] {
    if (!id) return [];
    return this.models.find((model) => model.id === id)?.reasoningEfforts ?? [];
  }

  /** Every model this cache has seen, for callers checking that an ID is still listed. */
  ids(): string[] {
    return this.models.map((model) => model.id);
  }

  /**
   * Runs `fetch`, diffs it against the cache, and falls back to the cache when it fails.
   *
   * A cache younger than `maxAgeMs` is served as-is: every page that lists models asks for
   * one, so without this a single window paints and fires a fetch per caller. One fetch is
   * shared while it is in flight, for the same reason.
   */
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
    catch { /* A cache that cannot be written is a slower next launch, not a failed reload. */ }
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
