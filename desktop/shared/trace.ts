/* One turn as a span tree, the way MLflow and LangSmith draw it.

   `AgentRuntime` is the one writer: it opens a span for the run, one per model
   request and one per tool call, on both paths — its own loop and the coding
   harness — so a turn's wall clock is accounted for rather than inferred. This
   file is only the geometry of the bars, the storage format, and the same tree
   written for a model instead of for the eye.

   Everything here is pure. `encodeSpans`/`decodeSpans` are what put a finished
   turn on the thread and read it back after a restart; `renderTrace` is what a
   model is given when it asks what a past turn did. */

export type TraceStatus = "running" | "ok" | "failed";

export type TraceSpan = {
  id: string;
  /** Absent on the root span of the turn. */
  parentId?: string;
  name: string;
  /** `agent` for a run, `model` for one request to the model, otherwise the tool's kind. */
  kind: string;
  startedAt: number;
  /** Absent while the span is still open, which is what makes a bar run to `now`. */
  endedAt?: number;
  status: TraceStatus;
  /** The call's arguments as the model sent them, so a trace says *why* a step went wrong. */
  input?: string;
  output?: string;
  /**
   * Roughly what this span added to the thread's context: the answer a model
   * request streamed back, the text a tool call handed the model. Estimated at
   * four characters a token, like everything else this side counts, and absent
   * on a span that put nothing in the window — or on any trace recorded before
   * this field existed, which is why the context axis is offered only when
   * something reports one.
   */
  tokens?: number;
};

/** Percent of the axis a zero-length span still gets, so an instant call is visible. */
const MIN_BAR = 1.5;

export type TraceRow = {
  span: TraceSpan;
  depth: number;
  /** Where the bar starts and how wide it is, as percentages of the whole turn. */
  offset: number;
  width: number;
  durationMs: number;
  children: number;
};

/**
 * Depth-first rows with waterfall geometry, measured against the whole turn so
 * every bar shares one axis — which is the only reason a nested bar says
 * anything about when it ran inside its parent.
 */
export function layoutSpans(spans: readonly TraceSpan[], now: number, collapsed: ReadonlySet<string> = new Set()): TraceRow[] {
  if (!spans.length) return [];
  const close = (span: TraceSpan) => span.endedAt ?? now;
  const start = Math.min(...spans.map((span) => span.startedAt));
  // At least a millisecond wide: a turn whose spans all landed in the same tick
  // would otherwise divide by zero.
  const total = Math.max(1, Math.max(...spans.map(close)) - start);

  const ids = new Set(spans.map((span) => span.id));
  const children = new Map<string, TraceSpan[]>();
  const roots: TraceSpan[] = [];
  for (const span of spans) {
    // An orphan is a root, not a dropped row.
    const parent = span.parentId && ids.has(span.parentId) ? span.parentId : undefined;
    if (!parent) roots.push(span);
    else children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  for (const list of children.values()) list.sort((left, right) => left.startedAt - right.startedAt);
  roots.sort((left, right) => left.startedAt - right.startedAt);

  const rows: TraceRow[] = [];
  const walk = (list: TraceSpan[], depth: number) => {
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

/**
 * The same tree, measured in tokens instead of milliseconds.
 *
 * Every span's start and end are rewritten to its place on a cumulative context
 * axis — what the window already held when it ran, and what it left behind — so
 * `layoutSpans` draws the growth waterfall with the geometry it already has and
 * there is no second set of bars to keep in step with the first. A span's extent
 * is itself plus everything under it, siblings laid end to end in the order they
 * ran, which makes a bar's width its share of the turn's growth.
 *
 * Nothing else changes: same ids, same parents, same depth-first order, because
 * cumulative positions rise in exactly the order the spans already sort in.
 */
export function tokenAxis(spans: readonly TraceSpan[]): TraceSpan[] {
  const rows = layoutSpans(spans, 0);
  // The parent of each row, as an index: in a depth-first list it is the last
  // row seen one level up, which is cheaper than building the tree a second time.
  const seen: number[] = [];
  const parents = rows.map((row, index) => {
    seen[row.depth] = index;
    return row.depth ? seen[row.depth - 1] : -1;
  });
  const totals = rows.map((row) => Math.max(0, row.span.tokens ?? 0));
  // Backwards, so a child is finished before its parent asks for its total.
  for (let index = rows.length - 1; index > 0; index -= 1) {
    if (parents[index] >= 0) totals[parents[index]] += totals[index];
  }
  // A parent's children fill from its own start; whatever is left at the end of
  // its extent is what the parent itself added, which is the flame-graph reading.
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
  /** Real clock, not the collapsed axis: when the thread first ran and last did anything. */
  from: number;
  to: number;
  modelRequests: number;
  toolCalls: number;
  failed: number;
  slowest?: { name: string; ms: number };
  /** Tool names by total time spent in them, heaviest first. */
  tools: { name: string; count: number; ms: number }[];
};

/* What counts as a tool call. A run's own span is the frame around the work, so
   counting it would double every millisecond under it; a model request is the
   asking rather than the doing; and the Auto verifier's review is a permission
   answer, which the live counter on the run does not count either. */
const isCall = (span: TraceSpan) => span.kind !== "agent" && span.kind !== "model" && span.kind !== "verifier";

/** Tool calls in a span tree — a stored turn's, or a whole thread's flattened. */
export function countCalls(spans: readonly TraceSpan[]): number {
  return spans.filter(isCall).length;
}

/**
 * The counts behind a waterfall, for the reader who wants the numbers rather
 * than the bars. Takes raw spans — every turn's, flattened — so the times are
 * wall clock and not the end-to-end axis the panel draws.
 */
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

/** Roughly this many gridlines under the expanded waterfall. */
const AXIS_TICKS = 6;

/**
 * Round tick marks — 1, 2, 2.5 or 5 times a power of ten — so the expanded
 * view's axis reads `500ms 1.00s 1.50s` rather than whatever sixth of the turn
 * happens to be. `step` is also the spacing of the gridlines behind the bars.
 */
export function axisTicks(totalMs: number): { step: number; marks: number[] } {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, totalMs / AXIS_TICKS)));
  const step = [1, 2, 2.5, 5, 10]
    .map((factor) => factor * magnitude)
    .find((candidate) => totalMs / candidate <= AXIS_TICKS) ?? magnitude * 10;
  const marks: number[] = [];
  // Stops just short of the end: a label sitting exactly at 100% hangs off the
  // right edge, and it says nothing the total above the rows has not said.
  for (let at = 0; at <= totalMs * 0.995; at += step) marks.push(at);
  return { step, marks };
}

/** `888ms`, `3.87s`, `2m 04s` — the same reading LangSmith gives a span. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

/* ---------------------------------------------------------------------------
   The trace as a model reads it.

   An indented outline rather than JSON: the same tree costs roughly a third of
   the tokens without the braces and repeated key names, and a model already
   reads indentation as nesting. It is rendered on the way out of storage rather
   than into it — what a thread keeps is the spans themselves, because the
   inspector has to draw them again after a restart. */

/** One trace in the durable record. `crates/core` clamps again at its own boundary. */
export const MAX_TRACE_CHARS = 16 * 1024;
/** How much of one argument list or one result a span line keeps. */
const MAX_SPAN_TEXT = 240;
/** Room reserved for the elision note, so clamping never overshoots the cap. */
const ELISION_ROOM = 64;

/** One line, whitespace collapsed: a trace is read by line, so a span may not wrap. */
function oneLine(value: string, max = MAX_SPAN_TEXT): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Drops the middle of an oversized trace rather than the whole thing.
 *
 * Head and tail are what diagnose a run — what it set out to do and where it
 * ended up — so the budget is spent from both ends and the repetitive middle,
 * which is exactly what a stuck agent produces, is what goes.
 */
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

/**
 * Renders a span tree as the text a model is given.
 *
 * The `#N` ids are depth-first positions, which is what makes "look at span 7"
 * mean something once the trace is on disk and the live ids are gone.
 */
export function renderTrace(spans: readonly TraceSpan[], now: number, header: Record<string, string> = {}): string {
  const rows = layoutSpans(spans, now);
  if (!rows.length) return "";
  const fields = Object.entries({ ...header, spans: String(rows.length) }).map(([key, value]) => `${key}=${value}`);
  const lines = [`trace v1 ${fields.join(" ")}`];
  rows.forEach((row, index) => {
    const pad = "  ".repeat(row.depth);
    const { span } = row;
    const name = span.kind === "agent" ? `agent ${JSON.stringify(oneLine(span.name, 64))}` : oneLine(span.name, 64);
    lines.push(`${pad}#${index + 1} ${name} ${formatDuration(row.durationMs)} ${span.status}`);
    // Indented under their span so the outline still reads as one tree.
    if (span.input) lines.push(`${pad}   in ${oneLine(span.input)}`);
    if (span.output) lines.push(`${pad}   ${span.status === "failed" ? "err" : "out"} ${oneLine(span.output)}`);
  });
  return clampTrace(lines.join("\n"));
}

/* ---------------------------------------------------------------------------
   The trace as the thread keeps it.

   One span per line, so `clampTrace` here and `elide_middle` in `crates/core`
   both cut whole spans out of the middle and whatever survives still parses.
   Core treats the whole thing as opaque bounded text; this is the only place
   that knows it is JSON. */

/** How much of one argument list or one result a stored span keeps. */
const MAX_STORED_TEXT = 1024;

function stored(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > MAX_STORED_TEXT ? `${value.slice(0, MAX_STORED_TEXT)}…` : value;
}

/** A finished turn's spans as the text `recordTrace` stores on the thread. */
export function encodeSpans(spans: readonly TraceSpan[], header: Record<string, string> = {}): string {
  if (!spans.length) return "";
  const lines = [JSON.stringify({ v: 1, ...header })];
  for (const span of spans) {
    lines.push(JSON.stringify({ ...span, input: stored(span.input), output: stored(span.output) }));
  }
  return clampTrace(lines.join("\n"));
}

/**
 * The header line of a stored trace: what `encodeSpans` was given, plus its `v`.
 *
 * Its own reader because the header is where a turn's own facts live — which
 * model ran it, and which arm of a running trial it was on — and `decodeSpans`
 * skips it by design. A trace written before a field existed simply lacks it.
 */
export function traceHeader(text: string): Record<string, string> {
  const first = text.split("\n", 1)[0]?.trim() ?? "";
  if (!first.startsWith("{")) return {};
  let value: unknown;
  try { value = JSON.parse(first); } catch { return {}; }
  if (!value || typeof value !== "object") return {};
  // A span is not a header: an older trace whose first line is one reads as empty.
  const fields = value as Record<string, unknown>;
  if (typeof fields.id === "string") return {};
  return Object.fromEntries(Object.entries(fields).flatMap(([key, item]) => typeof item === "string" ? [[key, item]] : []));
}

/** Spans back out of a stored trace. Lines that are not spans — the header, an
 *  elision note, a trace written before this format — are skipped, not thrown. */
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
      parentId: typeof span.parentId === "string" ? span.parentId : undefined,
      name: span.name,
      kind: typeof span.kind === "string" ? span.kind : "other",
      startedAt: span.startedAt,
      endedAt: typeof span.endedAt === "number" ? span.endedAt : undefined,
      status: span.status === "failed" ? "failed" : span.status === "running" ? "running" : "ok",
      input: typeof span.input === "string" ? span.input : undefined,
      output: typeof span.output === "string" ? span.output : undefined,
      tokens: typeof span.tokens === "number" ? span.tokens : undefined,
    });
  }
  return spans;
}
