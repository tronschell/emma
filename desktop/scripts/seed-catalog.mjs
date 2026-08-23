// Regenerates the bundled OpenRouter seed: what the models page shows on a first launch
// with no network and no API key. The listing is public, so this needs no credential.
//
// The parsing lives in main/catalog.ts and nowhere else, so the seed is exactly what a
// live fetch produces — same validation, same dedupe, same fields. A second parser here
// is how the seed came to be missing efforts and prices the live catalog already had.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchOpenRouterCatalog } from "../dist-main/main/catalog.js";

const { models } = await fetchOpenRouterCatalog();
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
