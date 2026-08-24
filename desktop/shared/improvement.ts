/* What the Agent page is made of: the friction in Emma's own past runs, the
   changes proposed about it, and whether a change actually helped.

   Everything here is pure and reads only what is already on disk — the span
   traces a finished turn leaves on its thread. Nothing is sent anywhere, and no
   model is asked: a pattern the user has to approve had better be one they can
   check, so detection is arithmetic over receipts they can open.

   The renderer draws all of this; main imports only the record types and the
   block that rides a turn, because it is the half that applies a change. */

import { decodeSpans, traceHeader, type TraceSpan } from "./trace";

/** Which standing text a change is written into. Two, because there are two prompts Emma owns. */
export type Lever = "instructions" | "verifier";
/** What a trial counts per turn. All three are costs, so lower is always better. */
export type Metric = "failures" | "blocks" | "steps";
/** `a` runs without the change, `b` with it. Flipped per turn, in main. */
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

/**
 * One change Emma proposed about itself.
 *
 * It starts as a trial and ends kept or reverted; nothing here rewrites the
 * user's own settings text, so reverting is deleting a row rather than trying
 * to unpick an edit made to a paragraph they wrote.
 */
export type Improvement = {
  id: string;
  title: string;
  lever: Lever;
  addition: string;
  metric: Metric;
  /** When the trial began. Only turns after this count as samples. */
  startedAt: number;
  state: "trial" | "kept" | "reverted";
  decidedAt?: number;
  /** What the comparison read when it was decided, for the history row. */
  result?: string;
};

/** Kept improvements ride every turn; at most this many, so the block stays a page and not a book. */
export const MAX_KEPT = 12;
/** Rows the page keeps at all. Past this the oldest decided ones go. */
export const MAX_IMPROVEMENTS = 40;
export const MAX_ADDITION_CHARS = 1024;
/** Turns per arm before a difference is worth reading at all. */
export const MIN_ARM_TURNS = 6;

export type Improvements = { items: Improvement[] };

const text = (value: unknown, max: number) => (typeof value === "string" ? value : "").slice(0, max);

/** The store as it comes back off localStorage: anything unreadable is no improvements at all. */
export function validateImprovements(value: unknown): Improvements {
  const raw = (value && typeof value === "object" ? (value as { items?: unknown }).items : undefined) ?? [];
  if (!Array.isArray(raw)) return { items: [] };
  const items = raw.slice(-MAX_IMPROVEMENTS).flatMap((entry): Improvement[] => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const lever: Lever = item.lever === "verifier" ? "verifier" : "instructions";
    const metric: Metric = item.metric === "blocks" ? "blocks" : item.metric === "steps" ? "steps" : "failures";
    const state = item.state === "kept" ? "kept" : item.state === "reverted" ? "reverted" : "trial";
    const addition = text(item.addition, MAX_ADDITION_CHARS).trim();
    const id = text(item.id, 64);
    if (!id || !addition) return [];
    return [{
      id,
      title: text(item.title, 200) || "Untitled change",
      lever,
      addition,
      metric,
      startedAt: Number(item.startedAt) || 0,
      state,
      ...(Number(item.decidedAt) ? { decidedAt: Number(item.decidedAt) } : {}),
      ...(text(item.result, 200) ? { result: text(item.result, 200) } : {}),
    }];
  });
  return { items };
}

/** What main is told: the kept text per lever, and the one trial it should be flipping a coin over. */
export type AppliedImprovements = {
  kept: Record<Lever, string>;
  trial?: { lever: Lever; addition: string };
};

/**
 * The additions as prompt text.
 *
 * Written as lessons rather than as orders, and marked as Emma's own, so a model
 * reading them can tell them apart from the user's standing instructions — which
 * outrank them, and which this never touches.
 */
export function lessonBlock(additions: readonly string[]): string {
  const lines = additions.map((item) => item.trim()).filter(Boolean).slice(0, MAX_KEPT);
  if (!lines.length) return "";
  return ["What Emma has learned from its own past runs, and applies unless the user says otherwise:", ...lines.map((line) => `- ${line}`)].join("\n");
}

export function applied(store: Improvements): AppliedImprovements {
  const kept = { instructions: "", verifier: "" } as Record<Lever, string>;
  for (const lever of ["instructions", "verifier"] as const) {
    kept[lever] = lessonBlock(store.items.filter((item) => item.state === "kept" && item.lever === lever).map((item) => item.addition));
  }
  const trial = store.items.find((item) => item.state === "trial");
  return { kept, ...(trial ? { trial: { lever: trial.lever, addition: trial.addition } } : {}) };
}

/* ---------------------------------------------------------------------------
   Reading the record.

   One stored trace is one finished turn. Everything below is derived from the
   spans in it: what ran, what failed, and — when Emma's own loop drove the turn
   — which arm of a running trial it was on. */

export type Turn = {
  threadId: string;
  thread: string;
  at: number;
  arm: Arm | "";
  /** Tool calls that came back failed. */
  failures: number;
  /** Calls the auto verifier would not clear. */
  blocks: number;
  steps: number;
  /** False when the run itself ended failed — stopped, out of steps, or an error. */
  ok: boolean;
  spans: TraceSpan[];
};

/** Spans that are neither the frame around the run nor a request to the model. */
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

/* ---------------------------------------------------------------------------
   Friction.

   A pattern is a tool that keeps failing, or a call the auto verifier keeps
   refusing to clear. Both are grouped by the tool rather than by the message,
   because the message is where the detail is and the tool is where the fix is. */

export type Friction = {
  key: string;
  kind: "tool" | "verifier";
  /** The tool, as the trace names it: `bash` on Emma's own loop, `execute` from the harness. */
  tool: string;
  hits: number;
  /** Turns it happened in, which is the number that says whether it is a pattern. */
  turns: number;
  lastAt: number;
  /** The thing that went wrong, in the words of whatever wrote it, newest first. */
  evidence: { at: number; thread: string; threadId: string; text: string }[];
};

/** Enough to recognise the pattern; the thread itself is where the whole story is. */
const MAX_EVIDENCE = 4;
const MAX_EVIDENCE_CHARS = 220;
/** Below this it is one bad afternoon, not something to change the prompt over. */
export const MIN_FRICTION_TURNS = 2;

const clamp = (value: string) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_EVIDENCE_CHARS ? `${flat.slice(0, MAX_EVIDENCE_CHARS)}…` : flat;
};

/** The call a verifier review was about, out of the prompt it was sent. */
export function reviewedTool(input: string | undefined): string {
  return /^Proposed action:[ \t]*(.+)$/m.exec(input ?? "")?.[1].trim().slice(0, 64) || "a call";
}

/** The verifier's own words. Its reply is a JSON line when it behaved, and prose when it did not. */
export function blockReason(output: string | undefined): string {
  const found = /"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(output ?? "");
  return clamp(found ? found[1].replace(/\\"/g, '"') : (output ?? ""));
}

export function frictionOf(turns: readonly Turn[]): Friction[] {
  const found = new Map<string, Friction>();
  // Which turns each pattern has already been counted in — the number that decides
  // whether it is a pattern is turns, not hits, so ten failures in one bad run is one.
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
  // Newest first, so the four pieces of evidence kept are the four most recent.
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

/**
 * The change to try, as a first draft.
 *
 * Deliberately a skeleton with the real error quoted into it rather than a
 * confident sentence: Emma can see *that* something keeps going wrong, and the
 * evidence is enough to say what it was, but what to do instead is the part a
 * template would be making up. The page hands this to a textarea, and it is the
 * user — or Emma, asked in a thread — who finishes it.
 */
export function draftProposal(friction: Friction): Pick<Improvement, "title" | "lever" | "metric" | "addition"> {
  const worst = friction.evidence[0]?.text ?? "";
  if (friction.kind === "verifier") {
    return {
      title: `The auto verifier keeps blocking ${friction.tool}`,
      lever: "verifier",
      metric: "blocks",
      addition: `${friction.tool} was blocked in ${friction.turns} turns. It said: “${worst}”. Clear this when it is what the user asked for — say here exactly which case is allowed, and what still is not.`,
    };
  }
  return {
    title: `${friction.tool} keeps failing`,
    lever: "instructions",
    metric: "failures",
    addition: `${friction.tool} failed in ${friction.turns} turns, most recently with “${worst}”. When that happens, do this instead of trying the same call again: `,
  };
}

/* ---------------------------------------------------------------------------
   The trial.

   The change is not switched on: it is switched on for a coin flip's worth of
   turns and off for the rest, and the two halves are compared. Before-and-after
   would credit the change with whatever else changed that week — a different
   model, easier work, a Tuesday — and this does not. */

export type Stat = { n: number; mean: number; sd: number };

export function stat(values: readonly number[]): Stat {
  const n = values.length;
  if (!n) return { n: 0, mean: 0, sd: 0 };
  const mean = values.reduce((total, value) => total + value, 0) / n;
  // Sample standard deviation: with one turn there is no spread to speak of yet.
  const sd = n < 2 ? 0 : Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1));
  return { n, mean, sd };
}

export type Comparison = {
  a: Stat;
  b: Stat;
  /** Percent change from the arm without the change to the arm with it; negative is better. */
  delta: number | null;
  /** True when the gap is bigger than the noise in both arms — roughly two standard errors. */
  clear: boolean;
  /** Why there is no verdict yet, or "" when there is one. */
  waiting: string;
};

export function compare(turns: readonly Turn[], trial: Improvement): Comparison {
  const samples = (arm: Arm) => turns.filter((turn) => turn.arm === arm && turn.at >= trial.startedAt).map((turn) => sampleOf(turn, trial.metric));
  const a = stat(samples("a"));
  const b = stat(samples("b"));
  const delta = a.n && b.n && a.mean !== 0 ? ((b.mean - a.mean) / Math.abs(a.mean)) * 100 : null;
  // Standard error of the difference. Two of them is the usual "not noise" line,
  // and with counts this small it is the honest place to draw it.
  const error = 2 * Math.sqrt((a.n ? a.sd ** 2 / a.n : 0) + (b.n ? b.sd ** 2 / b.n : 0));
  const enough = a.n >= MIN_ARM_TURNS && b.n >= MIN_ARM_TURNS;
  const clear = enough && Math.abs(b.mean - a.mean) > error && error > 0;
  const short = Math.max(0, MIN_ARM_TURNS - Math.min(a.n, b.n));
  return { a, b, delta, clear, waiting: enough ? "" : `${short} more ${short === 1 ? "turn" : "turns"} needed on the thinner arm` };
}

/** What the history row says about a trial that was decided. */
export function resultLine(comparison: Comparison, kept: boolean): string {
  const change = comparison.delta === null ? "no comparable turns" : `${comparison.delta > 0 ? "+" : ""}${comparison.delta.toFixed(0)}%`;
  return `${kept ? "Kept" : "Reverted"} at ${comparison.a.n}/${comparison.b.n} turns · ${change}${comparison.clear ? "" : " · within the noise"}`;
}
