

export type TraceStatus = "running" | "ok" | "failed" | "cancelled";

export type TraceSpan = {
  id: string;
  model?: string;
  tool?: string;
  context?: Record<string, string>;

  parentId?: string;
  name: string;

  kind: string;
  startedAt: number;

  endedAt?: number;
  status: TraceStatus;

  input?: string;
  output?: string;
  said?: number;

  tokens?: number;
};

const MIN_BAR = 1.5;

const MAX_DEPTH = 64;

export type TraceRow = {
  span: TraceSpan;
  depth: number;

  offset: number;
  width: number;
  durationMs: number;
  children: number;
};

export function layoutSpans(spans: readonly TraceSpan[], now: number, collapsed: ReadonlySet<string> = new Set()): TraceRow[] {
  if (!spans.length) return [];
  const close = (span: TraceSpan) => span.endedAt ?? now;

  let start = Infinity;
  let last = -Infinity;
  for (const span of spans) {
    if (span.startedAt < start) start = span.startedAt;
    const end = close(span);
    if (end > last) last = end;
  }

  const total = Math.max(1, last - start);

  const ids = new Set(spans.map((span) => span.id));
  const children = new Map<string, TraceSpan[]>();
  const roots: TraceSpan[] = [];
  for (const span of spans) {

    const parent = span.parentId && ids.has(span.parentId) ? span.parentId : undefined;
    if (!parent) roots.push(span);
    else children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  for (const list of children.values()) list.sort((left, right) => left.startedAt - right.startedAt);
  roots.sort((left, right) => left.startedAt - right.startedAt);

  const rows: TraceRow[] = [];
  const walk = (list: TraceSpan[], depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const span of list) {
      const kids = children.get(span.id) ?? [];
      const durationMs = Math.max(0, close(span) - span.startedAt);
      const offset = ((span.startedAt - start) / total) * 100;
      rows.push({
        span,
        depth,
        offset,
        width: Math.min(100 - offset, Math.max(MIN_BAR, (durationMs / total) * 100)),
        durationMs,
        children: kids.length,
      });
      if (!collapsed.has(span.id)) walk(kids, depth + 1);
    }
  };
  walk(roots, 0);
  return rows;
}

export function tokenAxis(spans: readonly TraceSpan[]): TraceSpan[] {
  const rows = layoutSpans(spans, 0);

  const seen: number[] = [];
  const parents = rows.map((row, index) => {
    seen[row.depth] = index;
    return row.depth ? seen[row.depth - 1] : -1;
  });
  const totals = rows.map((row) => Math.max(0, row.span.tokens ?? 0));

  for (let index = rows.length - 1; index > 0; index -= 1) {
    if (parents[index] >= 0) totals[parents[index]] += totals[index];
  }

  const cursors = rows.map(() => 0);
  let root = 0;
  return rows.map((row, index) => {
    const parent = parents[index];
    const at = parent >= 0 ? cursors[parent] : root;
    if (parent >= 0) cursors[parent] = at + totals[index];
    else root = at + totals[index];
    cursors[index] = at;
    return { ...row.span, startedAt: at, endedAt: at + totals[index] };
  });
}

export type TraceSummary = {

  from: number;
  to: number;
  modelRequests: number;
  toolCalls: number;
  failed: number;
  slowest?: { name: string; ms: number };

  tools: { name: string; count: number; ms: number }[];
};

const isCall = (span: TraceSpan) => span.kind !== "agent" && span.kind !== "model" && span.kind !== "verifier";

export function countCalls(spans: readonly TraceSpan[]): number {
  return spans.filter(isCall).length;
}

export function summarizeSpans(spans: readonly TraceSpan[], now: number): TraceSummary | undefined {
  if (!spans.length) return undefined;
  const close = (span: TraceSpan) => span.endedAt ?? now;
  const tools = new Map<string, { name: string; count: number; ms: number }>();
  const summary: TraceSummary = { from: Infinity, to: -Infinity, modelRequests: 0, toolCalls: 0, failed: 0, tools: [] };
  for (const span of spans) {
    const ms = Math.max(0, close(span) - span.startedAt);
    summary.from = Math.min(summary.from, span.startedAt);
    summary.to = Math.max(summary.to, close(span));
    if (span.status === "failed") summary.failed += 1;
    if (span.kind === "model") { summary.modelRequests += 1; continue; }
    if (!isCall(span)) continue;
    summary.toolCalls += 1;
    const tally = tools.get(span.name) ?? { name: span.name, count: 0, ms: 0 };
    tools.set(span.name, { name: span.name, count: tally.count + 1, ms: tally.ms + ms });
    if (!summary.slowest || ms > summary.slowest.ms) summary.slowest = { name: span.name, ms };
  }
  summary.tools = [...tools.values()].sort((left, right) => right.ms - left.ms);
  return summary;
}

const AXIS_TICKS = 6;

export function axisTicks(totalMs: number): { step: number; marks: number[] } {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, totalMs / AXIS_TICKS)));
  const step = [1, 2, 2.5, 5, 10]
    .map((factor) => factor * magnitude)
    .find((candidate) => totalMs / candidate <= AXIS_TICKS) ?? magnitude * 10;
  const marks: number[] = [];

  for (let at = 0; at <= totalMs * 0.995; at += step) marks.push(at);
  return { step, marks };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export const MAX_TRACE_CHARS = 1024 * 1024;

const MAX_SPAN_TEXT = 240;

const ELISION_ROOM = 64;

function oneLine(value: string, max = MAX_SPAN_TEXT): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function compactionNotice(removedTurns: number, modelWritten: boolean): string {
  const summary = modelWritten ? "a summary" : "a rough summary the model did not write";
  return `Context compacted — ${removedTurns} ${removedTurns === 1 ? "turn" : "turns"} became ${summary}`;
}

export function clampTrace(text: string, max = MAX_TRACE_CHARS): string {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const head: string[] = [];
  const tail: string[] = [];
  const budget = Math.max(0, max - ELISION_ROOM);
  let used = 0;
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const fromHead = head.length <= tail.length;
    const line = fromHead ? lines[low] : lines[high - 1];
    if (used + line.length + 1 > budget) break;
    used += line.length + 1;
    if (fromHead) { head.push(line); low += 1; } else { tail.push(line); high -= 1; }
  }
  return [...head, `  … ${high - low} lines elided …`, ...tail.reverse()].join("\n");
}

export function renderTrace(spans: readonly TraceSpan[], now: number, header: Record<string, string> = {}): string {
  const rows = layoutSpans(spans, now);
  if (!rows.length) return "";
  const fields = Object.entries({ ...header, spans: String(rows.length) }).map(([key, value]) => `${key}=${/\s/.test(value) ? JSON.stringify(value) : value}`);
  const lines = [`trace v1 ${fields.join(" ")}`];
  rows.forEach((row, index) => {
    const pad = "  ".repeat(row.depth);
    const { span } = row;
    const name = span.kind === "agent" ? `agent ${JSON.stringify(oneLine(span.name, 64))}` : oneLine(span.name, 64);
    lines.push(`${pad}#${index + 1} ${name}${span.model ? ` [model=${span.model}]` : ""}${span.tool ? ` [tool=${span.tool}]` : ""} ${formatDuration(row.durationMs)} ${span.status}`);
    if (span.context) lines.push(`${pad}   context ${JSON.stringify(span.context)}`);

    if (span.input) lines.push(`${pad}   in ${oneLine(span.input)}`);
    if (span.output) lines.push(`${pad}   ${span.status === "failed" ? "err" : "out"} ${oneLine(span.output)}`);
  });
  return clampTrace(lines.join("\n"));
}

const MAX_STORED_TEXT = 16 * 1024;

function stored(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > MAX_STORED_TEXT ? `${value.slice(0, MAX_STORED_TEXT)}…` : value;
}

export function encodeSpans(spans: readonly TraceSpan[], header: Record<string, string> = {}): string {
  if (!spans.length) return "";
  const lines = [JSON.stringify({ v: 1, ...header })];
  for (const span of spans) {
    lines.push(JSON.stringify({ ...span, input: stored(span.input), output: stored(span.output) }));
  }
  return clampTrace(lines.join("\n"));
}

export function traceHeader(text: string): Record<string, string> {
  const first = text.split("\n", 1)[0]?.trim() ?? "";
  if (!first.startsWith("{")) return {};
  let value: unknown;
  try { value = JSON.parse(first); } catch { return {}; }
  if (!value || typeof value !== "object") return {};

  const fields = value as Record<string, unknown>;
  if (typeof fields.id === "string") return {};
  return Object.fromEntries(Object.entries(fields).flatMap(([key, item]) => typeof item === "string" ? [[key, item]] : []));
}

export function decodeSpans(text: string): TraceSpan[] {
  const spans: TraceSpan[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== "object") continue;
    const span = value as Record<string, unknown>;
    if (typeof span.id !== "string" || typeof span.name !== "string" || typeof span.startedAt !== "number") continue;
    spans.push({
      id: span.id,
      model: typeof span.model === "string" ? span.model : undefined,
      tool: typeof span.tool === "string" ? span.tool : undefined,
      context: span.context && typeof span.context === "object" && !Array.isArray(span.context)
        ? Object.fromEntries(Object.entries(span.context).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined,
      parentId: typeof span.parentId === "string" ? span.parentId : undefined,
      name: span.name,
      kind: typeof span.kind === "string" ? span.kind : "other",
      startedAt: span.startedAt,
      endedAt: typeof span.endedAt === "number" ? span.endedAt : undefined,
      status: span.status === "failed" ? "failed" : span.status === "running" ? "running" : span.status === "cancelled" ? "cancelled" : "ok",
      input: typeof span.input === "string" ? span.input : undefined,
      output: typeof span.output === "string" ? span.output : undefined,
      tokens: typeof span.tokens === "number" ? span.tokens : undefined,
      said: typeof span.said === "number" && span.said >= 0 ? span.said : undefined,
    });
  }
  return spans;
}
