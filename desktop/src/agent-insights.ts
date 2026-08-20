import type { Snapshot } from "./types";

export interface AgentInsights {
  window: { start: string; end: string; days: number };
  domains: { domain: string; count: number; titles: string[] }[];
  categories: { category: string; base: string; count: number; titles: string[] }[];
  activity: { week: string; count: number }[];
}

export function deriveAgentInsights(snapshot: Snapshot, now = new Date()): AgentInsights {
  const end = new Date(now);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 60);
  const pages = snapshot.pages.filter((page) => {
    const added = new Date(page.addedAt);
    return !Number.isNaN(added.valueOf()) && added >= start && added <= end;
  });
  const domains = new Map<string, { count: number; titles: string[] }>();
  const categories = new Map<string, { category: string; base: string; count: number; titles: string[] }>();
  const activity = new Map<string, number>();
  const baseNames = new Map(snapshot.knowledgeBases.map((base) => [base.id, base.name]));

  for (const page of pages) {
    const pageDomains = new Set(
      [page.context.sourceUrl, ...page.sources.map((source) => source.url)]
        .filter((url): url is string => Boolean(url))
        .flatMap((url) => {
          try { return [new URL(url).hostname.toLowerCase().replace(/^www\./, "")]; }
          catch { return []; }
        }),
    );
    for (const domain of pageDomains) {
      const item = domains.get(domain) ?? { count: 0, titles: [] };
      item.count += 1;
      item.titles.push(page.title);
      domains.set(domain, item);
    }
    const base = baseNames.get(page.knowledgeBaseId) ?? "Unknown base";
    const categoryKey = `${base}\0${page.category}`;
    const category = categories.get(categoryKey) ?? { category: page.category, base, count: 0, titles: [] };
    category.count += 1;
    category.titles.push(page.title);
    categories.set(categoryKey, category);

    const added = new Date(page.addedAt);
    const monday = new Date(Date.UTC(added.getUTCFullYear(), added.getUTCMonth(), added.getUTCDate()));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const week = monday.toISOString().slice(0, 10);
    activity.set(week, (activity.get(week) ?? 0) + 1);
  }

  const ranked = <T extends { count: number }>(items: T[]) => items.sort((left, right) => right.count - left.count || JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    window: { start: start.toISOString(), end: end.toISOString(), days: 60 },
    domains: ranked([...domains].map(([domain, value]) => ({ domain, ...value }))),
    categories: ranked([...categories.values()]),
    activity: [...activity].sort(([left], [right]) => left.localeCompare(right)).map(([week, count]) => ({ week, count })),
  };
}
