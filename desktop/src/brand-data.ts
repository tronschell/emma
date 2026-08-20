export type BrandRenderData = { src?: string; fallback: string };

export function matchesLocalAlias(value: string, alias: string): boolean {
  if (value === alias) return true;
  if (!value.startsWith(alias)) return false;
  return /^(?:[0-9]|[-:._])/.test(value.slice(alias.length));
}

export function brandRenderData(brand: { asset?: { src: string }; fallback?: string } | undefined): BrandRenderData {
  return { src: brand?.asset?.src, fallback: brand?.fallback ?? "◇" };
}
