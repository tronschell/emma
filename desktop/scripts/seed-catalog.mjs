// Regenerates the bundled OpenRouter seed: what the models page shows on a first launch
// with no network and no API key. The listing is public, so this needs no credential.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://openrouter.ai/api/v1/models?supported_parameters=tools&sort=most-popular";
const MODALITIES = new Set(["image", "file", "audio"]);
const zero = (value) => Number.parseFloat(value) === 0;

const response = await fetch(ENDPOINT, { headers: { Accept: "application/json" } });
if (!response.ok) throw new Error(`OpenRouter answered ${response.status}`);
const { data } = await response.json();
if (!Array.isArray(data) || !data.length) throw new Error("OpenRouter returned no models");

// Same rows the sidecar drops: a model with no context length is one vendor's bad listing.
const models = data.filter((model) => Number(model.context_length) > 0).map((model) => ({
  id: model.id,
  name: model.name,
  contextLength: Number(model.context_length),
  inputModalities: (model.architecture?.input_modalities ?? []).filter((item) => MODALITIES.has(item)),
  free: zero(model.pricing?.prompt) && zero(model.pricing?.completion),
}));

const body = models.map((model) => JSON.stringify(model)).join(",\n  ");
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../main/catalog-seed.ts");
writeFileSync(file, `import type { CatalogModel } from "./catalog";

/**
 * A snapshot of OpenRouter's tool-capable catalog, bundled so the models page has something
 * to show on a first launch with no network and no API key. Refreshed on disk by the first
 * successful fetch; regenerate with \`npm run seed:catalog\`.
 */
export const catalogSeed: CatalogModel[] = [
  ${body},
];
`);
console.log(`${models.length} models written to ${file}`);
