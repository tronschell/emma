import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { catalogSeed } from "./catalog-seed";

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
  id.length <= 128 && /^[A-Za-z0-9\-_.:]+\/[A-Za-z0-9\-_.:]+$/.test(id)
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

  /** Runs `fetch`, diffs it against the cache, and falls back to the cache when it fails. */
  async refresh(fetch: () => Promise<Catalog>): Promise<CatalogResult> {
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
