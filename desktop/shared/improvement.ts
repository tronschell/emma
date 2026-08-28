import { decodeSpans, traceHeader, type TraceSpan } from "./trace";

export type Lever = "instructions" | "verifier";
export type Metric = "failures" | "blocks" | "steps";
export type Arm = "a" | "b";

export const leverNames: Record<Lever, string> = {
  instructions: "Standing instructions",
  verifier: "Auto verifier rules",
};

export const metricNames: Record<Metric, string> = {
  failures: "failed tool calls per turn",
  blocks: "verifier blocks per turn",
  steps: "tool calls per turn",
};

export type Improvement = {
  id: string;
  title: string;
  lever: Lever;
  addition: string;
  metric: Metric;
  startedAt: number;
  look: number;
  state: "trial" | "kept" | "reverted";
  decidedAt?: number;
  result?: string;
  origin?: string;
};

export const MAX_KEPT = 12;
export const MAX_IMPROVEMENTS = 40;
export const MAX_ADDITION_CHARS = 1024;
export const MAX_RESULT_CHARS = 1024;
export const MIN_ARM_TURNS = 6;

export type Improvements = { items: Improvement[] };

const text = (value: unknown, max: number) => (typeof value === "string" ? value : "").slice(0, max);

const record = (value: unknown): string => {
  const line = typeof value === "string" ? value : "";
  if (line.length <= MAX_RESULT_CHARS) return line;
  const cut = line.slice(0, MAX_RESULT_CHARS + 1);
  return cut.slice(0, Math.max(0, cut.lastIndexOf(" ")));
};

const disposable = (items: readonly Improvement[]): Improvement[] => {
  const cited = new Set(items.filter((item) => item.state !== "reverted").map(lineageOf));
  return items.filter((item) => item.state === "reverted" && !cited.has(lineageOf(item)));
};

export function pruned(items: readonly Improvement[]): Improvement[] {
  const over = items.length - MAX_IMPROVEMENTS;
  if (over <= 0) return [...items];
  const gone = new Set(disposable(items).slice(0, over).map((item) => item.id));
  return items.filter((item) => !gone.has(item.id));
}

export const room = (items: readonly Improvement[]): number => MAX_IMPROVEMENTS - items.length + disposable(items).length;

export function validateImprovements(value: unknown): Improvements {
  const raw = (value && typeof value === "object" ? (value as { items?: unknown }).items : undefined) ?? [];
  if (!Array.isArray(raw)) return { items: [] };
  const items = raw.flatMap((entry): Improvement[] => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const lever: Lever = item.lever === "verifier" ? "verifier" : "instructions";
    const metric: Metric = item.metric === "blocks" ? "blocks" : item.metric === "steps" ? "steps" : "failures";
    const state = item.state === "kept" ? "kept" : item.state === "reverted" ? "reverted" : "trial";
    const addition = text(item.addition, MAX_ADDITION_CHARS).trim();
    const id = text(item.id, 64);
    const origin = text(item.origin, 64);
    const again = !!origin && origin !== id;
    if (!id || !addition) return [];
    return [{
      id,
      title: text(item.title, 200) || "Untitled change",
      lever,
      addition,
      metric,
      startedAt: Number(item.startedAt) || 0,
      look: again ? Math.max(2, Math.round(Number(item.look)) || 0) : 1,
      state,
      ...(Number(item.decidedAt) ? { decidedAt: Number(item.decidedAt) } : {}),
      ...(record(item.result) ? { result: record(item.result) } : {}),
      ...(again ? { origin } : {}),
    }];
  });
  return { items: pruned(items) };
}

export type AppliedImprovements = {
  kept: Record<Lever, string>;
  trial?: { lever: Lever; addition: string };
};

export function lessonBlock(additions: readonly string[]): string {
  const lines = additions.map((item) => item.trim()).filter(Boolean).slice(0, MAX_KEPT);
  if (!lines.length) return "";
  return ["What Emma has learned from its own past runs, and applies unless the user says otherwise:", ...lines.map((line) => `- ${line}`)].join("\n");
}

export function heldBack(items: readonly Improvement[]): string[] {
  const trial = items.find((item) => item.state === "trial");
  const superseded = trial ? lineageOf(trial) : "";
  return (["instructions", "verifier"] as const).flatMap((lever) => {
    const rows = items.filter((item) => item.state === "kept" && item.lever === lever);
    const riding = new Set(rows.filter((item) => lineageOf(item) !== superseded).slice(0, MAX_KEPT).map((item) => item.id));
    return rows.filter((item) => !riding.has(item.id)).map((item) => item.id);
  });
}

export function applied(store: Improvements): AppliedImprovements {
  const trial = store.items.find((item) => item.state === "trial");
  const held = new Set(heldBack(store.items));
  const kept = { instructions: "", verifier: "" } as Record<Lever, string>;
  for (const lever of ["instructions", "verifier"] as const) {
    kept[lever] = lessonBlock(store.items.filter((item) => item.state === "kept" && item.lever === lever && !held.has(item.id)).map((item) => item.addition));
  }
  return { kept, ...(trial ? { trial: { lever: trial.lever, addition: trial.addition } } : {}) };
}

export type Turn = {
  threadId: string;
  thread: string;
  at: number;
  arm: Arm | "";
  failures: number;
  blocks: number;
  steps: number;
  ok: boolean;
  spans: TraceSpan[];
};

const isCall = (span: TraceSpan) => span.kind !== "agent" && span.kind !== "model";
const isVerifier = (span: TraceSpan) => span.kind === "verifier";

export function readTurn(trace: { timestamp: string; text: string }, thread: { id: string; title: string }): Turn {
  const spans = decodeSpans(trace.text);
  const header = traceHeader(trace.text);
  const at = Date.parse(trace.timestamp);
  const calls = spans.filter(isCall);
  return {
    threadId: thread.id,
    thread: thread.title,
    at: Number.isNaN(at) ? 0 : at,
    arm: header.arm === "a" || header.arm === "b" ? header.arm : "",
    failures: calls.filter((span) => !isVerifier(span) && span.status === "failed").length,
    blocks: calls.filter((span) => isVerifier(span) && span.status === "failed").length,
    steps: calls.filter((span) => !isVerifier(span)).length,
    ok: !spans.some((span) => span.kind === "agent" && span.status === "failed"),
    spans,
  };
}

export const sampleOf = (turn: Turn, metric: Metric): number => turn[metric];

export type Friction = {
  key: string;
  kind: "tool" | "verifier";
  tool: string;
  hits: number;
  turns: number;
  lastAt: number;
  evidence: { at: number; thread: string; threadId: string; text: string }[];
};

const MAX_EVIDENCE = 4;
const MAX_EVIDENCE_CHARS = 220;
export const MIN_FRICTION_TURNS = 2;

const clamp = (value: string) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_EVIDENCE_CHARS ? `${flat.slice(0, MAX_EVIDENCE_CHARS)}…` : flat;
};

export function reviewedTool(input: string | undefined): string {
  return /^Proposed action:[ \t]*(.+)$/m.exec(input ?? "")?.[1].trim().slice(0, 64) || "a call";
}

export function blockReason(output: string | undefined): string {
  const found = /"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(output ?? "");
  return clamp(found ? found[1].replace(/\\"/g, '"') : (output ?? ""));
}

export function frictionOf(turns: readonly Turn[]): Friction[] {
  const found = new Map<string, Friction>();
  const counted = new Map<string, Set<string>>();
  const add = (kind: Friction["kind"], tool: string, turn: Turn, detail: string) => {
    const key = `${kind}:${tool}`;
    const item = found.get(key) ?? { key, kind, tool, hits: 0, turns: 0, lastAt: 0, evidence: [] };
    const seen = counted.get(key) ?? new Set<string>();
    counted.set(key, seen);
    item.hits += 1;
    if (!seen.has(turn.threadId + turn.at)) { seen.add(turn.threadId + turn.at); item.turns += 1; }
    item.lastAt = Math.max(item.lastAt, turn.at);
    if (detail && item.evidence.length < MAX_EVIDENCE) item.evidence.push({ at: turn.at, thread: turn.thread, threadId: turn.threadId, text: detail });
    found.set(key, item);
  };
  for (const turn of [...turns].sort((left, right) => right.at - left.at)) {
    for (const span of turn.spans) {
      if (!isCall(span) || span.status !== "failed") continue;
      if (isVerifier(span)) add("verifier", reviewedTool(span.input), turn, blockReason(span.output));
      else add("tool", span.kind || "tool", turn, clamp(span.output ?? ""));
    }
  }
  return [...found.values()]
    .filter((item) => item.turns >= MIN_FRICTION_TURNS)
    .sort((left, right) => right.turns - left.turns || right.hits - left.hits || right.lastAt - left.lastAt);
}

export type Draft = Pick<Improvement, "title" | "lever" | "metric" | "addition" | "look" | "origin">;

export function draftProposal(friction: Friction): Draft {
  const worst = friction.evidence[0]?.text ?? "";
  if (friction.kind === "verifier") {
    return {
      title: `The auto verifier keeps blocking ${friction.tool}`,
      lever: "verifier",
      metric: "blocks",
      look: 1,
      addition: `${friction.tool} was blocked in ${friction.turns} turns. It said: “${worst}”. Clear this when it is what the user asked for — say here exactly which case is allowed, and what still is not.`,
    };
  }
  return {
    title: `${friction.tool} keeps failing`,
    lever: "instructions",
    metric: "failures",
    look: 1,
    addition: `${friction.tool} failed in ${friction.turns} turns, most recently with “${worst}”. When that happens, do this instead of trying the same call again: `,
  };
}

export const lineageOf = (item: Improvement): string => item.origin || item.id;

export function attemptIds(items: readonly Improvement[], improvementId: string): string[] {
  const of = items.find((row) => row.id === improvementId);
  if (!of) return improvementId ? [improvementId] : [];
  return items
    .filter((row) => lineageOf(row) === lineageOf(of))
    .sort((left, right) => left.startedAt - right.startedAt)
    .map((row) => row.id);
}

export const retryDraft = (item: Improvement): Draft =>
  ({ title: item.title, lever: item.lever, metric: item.metric, addition: item.addition, look: item.look + 1, origin: lineageOf(item) });

export type Stat = { n: number; mean: number; sd: number };

export function stat(values: readonly number[]): Stat {
  const n = values.length;
  if (!n) return { n: 0, mean: 0, sd: 0 };
  const mean = values.reduce((total, value) => total + value, 0) / n;
  const sd = n < 2 ? 0 : Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1));
  return { n, mean, sd };
}

export type Comparison = {
  a: Stat;
  b: Stat;
  delta: number | null;
  clear: boolean;
  waiting: string;
};

export function compare(turns: readonly Turn[], trial: Improvement): Comparison {
  const samples = (arm: Arm) => turns.filter((turn) => turn.arm === arm && turn.at >= trial.startedAt).map((turn) => sampleOf(turn, trial.metric));
  const a = stat(samples("a"));
  const b = stat(samples("b"));
  const delta = a.n && b.n && a.mean !== 0 ? ((b.mean - a.mean) / Math.abs(a.mean)) * 100 : null;
  const error = 2 * Math.sqrt((a.n ? a.sd ** 2 / a.n : 0) + (b.n ? b.sd ** 2 / b.n : 0));
  const enough = a.n >= MIN_ARM_TURNS && b.n >= MIN_ARM_TURNS;
  const clear = enough && Math.abs(b.mean - a.mean) > error && (error > 0 || b.mean !== a.mean);
  const short = Math.max(0, MIN_ARM_TURNS - Math.min(a.n, b.n));
  return { a, b, delta, clear, waiting: enough ? "" : `${short} more ${short === 1 ? "turn" : "turns"} needed on the thinner arm` };
}

export function startTrial(items: readonly Improvement[], draft: Draft, at: number): Improvement[] {
  const addition = draft.addition.trim();
  if (!addition || room(items) <= 0 || items.some((row) => row.state === "trial")) return [...items];
  const taken = new Set(items.map((row) => row.id));
  let id = `imp-${at.toString(36)}`;
  for (let next = 2; taken.has(id); next += 1) id = `imp-${at.toString(36)}-${next}`;
  return [...items, { id, title: draft.title, lever: draft.lever, addition, metric: draft.metric, startedAt: at, look: draft.look, state: "trial", ...(draft.origin && draft.origin !== id ? { origin: draft.origin } : {}) }];
}

export function revertLine(comparison: Comparison): string {
  const change = comparison.delta === null ? "no comparable turns" : `${comparison.delta > 0 ? "+" : ""}${comparison.delta.toFixed(0)}%`;
  return `Reverted at ${comparison.a.n}/${comparison.b.n} turns · ${change}${comparison.clear ? "" : " · within the noise"}`;
}
