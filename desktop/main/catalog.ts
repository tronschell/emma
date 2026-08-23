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
