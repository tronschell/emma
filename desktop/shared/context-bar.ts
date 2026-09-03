export const CONTEXT_WIDGETS = [
  { type: "stats", label: "Thread stats", glyph: "▦", blurb: "Any of the numbers this thread has: counts, speed, tokens, cache, context, pruning.", orientable: true },
  { type: "context", label: "Context window", glyph: "▤", blurb: "What the last turn carried, by kind, against the model's stated window.", orientable: true },
  { type: "timeline", label: "Timeline", glyph: "⌇", blurb: "Every turn as a waterfall — model requests, tool calls, subagents.", orientable: false },
  { type: "tasklist", label: "Tasks", glyph: "☷", blurb: "The durable nested checklist for complex work this agent is doing itself.", orientable: false },
  { type: "plan", label: "Plan", glyph: "◰", blurb: "The plan this thread is working through, drawn as a graph of subagents. Press a node to light its wave.", orientable: false },
  { type: "subagents", label: "Subagents", glyph: "⌸", blurb: "One row per subagent, into the transcript it is writing.", orientable: true },
  { type: "subthreads", label: "Sub threads", glyph: "⑃", blurb: "Threads this one started, working or idle. They outlive their runs, so the rows stay.", orientable: true },
  { type: "machine", label: "Machine", glyph: "◫", blurb: "This computer while the thread runs: CPU, memory, GPU and network, as numbers.", orientable: true },
  { type: "machinegraph", label: "Machine graph", glyph: "∿", blurb: "The last minute of CPU, memory, GPU and network, each as a sparkline.", orientable: true },
  { type: "machinemeters", label: "Machine meters", glyph: "▥", blurb: "The same four readings as segmented gauges — the shape you read across the room.", orientable: true },
  { type: "git", label: "Git", glyph: "⑂", blurb: "Branch, working tree, and the diff behind it. Empty outside a repo.", orientable: false },
] as const;

export type ContextWidgetType = (typeof CONTEXT_WIDGETS)[number]["type"];

export const CONTEXT_METRICS = [
  { id: "messages", label: "Messages" },
  { id: "replies", label: "Emma replies" },
  { id: "attachments", label: "Attachments" },
  { id: "calls", label: "Tool calls" },
  { id: "rate", label: "Avg tok/s" },
  { id: "output", label: "Output tokens" },
  { id: "cache", label: "Cache hit rate" },
  { id: "cacheWrites", label: "Cache writes" },
  { id: "cost", label: "Cost/task" },
  { id: "elapsed", label: "Generation time" },
  { id: "context", label: "Context carried" },
  { id: "window", label: "Context window" },
  { id: "free", label: "Context free" },
  { id: "share", label: "Context used" },
  { id: "largest", label: "Largest segment" },
  { id: "subagents", label: "Subagents" },
  { id: "subthreads", label: "Sub threads" },
  { id: "saved", label: "Pruning saved" },
  { id: "added", label: "Pruning added" },
  { id: "pruned", label: "Pruned results" },
  { id: "reinjections", label: "Reinjections" },
] as const;

export type ContextMetric = (typeof CONTEXT_METRICS)[number]["id"];

export const DEFAULT_METRICS: ContextMetric[] = ["messages", "replies", "attachments", "calls", "rate", "output", "cache", "cacheWrites", "cost"];

export function cacheHitRate(generations: readonly { cacheInputTokens?: number; cacheReadTokens?: number }[]): number | undefined {
  let input = 0;
  let read = 0;
  for (const generation of generations) {
    if (generation.cacheInputTokens === undefined || generation.cacheReadTokens === undefined) continue;
    input += generation.cacheInputTokens;
    read += generation.cacheReadTokens;
  }
  return input ? read / input : undefined;
}

export function cacheWriteTokens(generations: readonly { cacheWriteTokens?: number }[]): number | undefined {
  let total = 0;
  let reported = false;
  for (const generation of generations) {
    const tokens = generation.cacheWriteTokens;
    if (tokens === undefined || !Number.isSafeInteger(tokens) || tokens < 0) continue;
    if (!Number.isSafeInteger(total + tokens)) return undefined;
    total += tokens;
    reported = true;
  }
  return reported ? total : undefined;
}

export function costPerTask(generations: readonly { costMicroUsd?: number }[]): number | undefined {
  let total = 0;
  let reported = 0;
  for (const generation of generations) {
    const cost = generation.costMicroUsd;
    if (cost === undefined || !Number.isSafeInteger(cost) || cost < 0) continue;
    if (!Number.isSafeInteger(total + cost)) return undefined;
    total += cost;
    reported += 1;
  }
  return reported ? total / reported : undefined;
}

export function costLabel(costMicroUsd: number | undefined): string {
  return costMicroUsd === undefined ? "—" : `$${(costMicroUsd / 1_000_000).toFixed(6)}`;
}

export const metricDefinition = (id: ContextMetric) => CONTEXT_METRICS.find((metric) => metric.id === id)!;
const isMetric = (value: unknown): value is ContextMetric => CONTEXT_METRICS.some((metric) => metric.id === value);

export type WidgetOrientation = "vertical" | "horizontal";

export interface ContextWidget {
  type: ContextWidgetType;
  orientation: WidgetOrientation;
  metrics?: ContextMetric[];
}

export interface ContextPage {
  id: string;
  name: string;
  widgets: ContextWidget[];
}

export const MAX_CONTEXT_PAGES = 4;
export const MAX_PAGE_NAME = 20;

export const widgetDefinition = (type: ContextWidgetType) => CONTEXT_WIDGETS.find((item) => item.type === type)!;
const isWidgetType = (value: unknown): value is ContextWidgetType => CONTEXT_WIDGETS.some((item) => item.type === value);

export const defaultContextPages: ContextPage[] = [
  {
    id: "p1",
    name: "Context",
    widgets: [
      { type: "stats", orientation: "horizontal" },
      { type: "context", orientation: "vertical" },
      { type: "timeline", orientation: "vertical" },
    ],
  },
  {
    id: "p2",
    name: "Run",
    widgets: [
      { type: "tasklist", orientation: "vertical" },
      { type: "plan", orientation: "vertical" },
      { type: "subagents", orientation: "vertical" },
      { type: "subthreads", orientation: "vertical" },
      { type: "git", orientation: "vertical" },
    ],
  },
  {
    id: "p3",
    name: "Machine",
    widgets: [
      { type: "machinemeters", orientation: "vertical" },
      { type: "machinegraph", orientation: "vertical" },
      { type: "machine", orientation: "horizontal" },
    ],
  },
];

export function nextPageId(pages: readonly ContextPage[]): string {
  for (let index = 1; index <= MAX_CONTEXT_PAGES; index += 1) {
    const id = `p${index}`;
    if (!pages.some((page) => page.id === id)) return id;
  }
  return `p${MAX_CONTEXT_PAGES}`;
}

export function validateContextPages(value: unknown): ContextPage[] {
  if (value === undefined || value === null) return structuredClone(defaultContextPages);
  if (!Array.isArray(value) || !value.length || value.length > MAX_CONTEXT_PAGES) throw new Error(`Keep 1 to ${MAX_CONTEXT_PAGES} context bar pages`);
  const pages = value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("A context bar page is invalid");
    const page = item as Partial<ContextPage>;
    if (typeof page.id !== "string" || !/^p[1-9]$/.test(page.id)) throw new Error("A context bar page is invalid");
    if (typeof page.name !== "string" || !page.name.trim() || page.name.length > MAX_PAGE_NAME) throw new Error(`Name every context bar page, in ${MAX_PAGE_NAME} characters or fewer`);
    if (!Array.isArray(page.widgets) || page.widgets.length > CONTEXT_WIDGETS.length) throw new Error("A context bar page is invalid");
    const widgets = page.widgets.map((entry) => {
      const widget = entry as Partial<ContextWidget>;
      if (!widget || !isWidgetType(widget.type)) throw new Error("A context bar component is invalid");
      const orientation = widget.orientation === "horizontal" ? "horizontal" : "vertical";
      const picked = Array.isArray(widget.metrics) ? [...new Set(widget.metrics.filter(isMetric))] : [];
      return {
        type: widget.type,
        orientation: widgetDefinition(widget.type).orientable ? orientation : "vertical",
        ...(widget.type === "stats" && picked.length ? { metrics: picked } : {}),
      } as ContextWidget;
    });
    if (new Set(widgets.map((widget) => widget.type)).size !== widgets.length) throw new Error("A component can only appear once on a page");
    return { id: page.id, name: page.name.trim(), widgets };
  });
  if (new Set(pages.map((page) => page.id)).size !== pages.length) throw new Error("Context bar pages must have distinct ids");
  return pages;
}
