import { metricNames, stat, type Arm, type Improvement, type Metric, type Stat } from "./improvement";
import { isThinkingLevel, thinkingLabel, validateJudge, type VerifierSettings } from "./settings";

export const MAX_BENCH_CASES = 12;
export const MAX_BENCH_RUNS = 24;
export const MAX_BENCH_PROMPT_CHARS = 4096;
export const MAX_BENCH_RUBRIC_CHARS = 1024;
export const MAX_BENCH_ANSWER_CHARS = 4096;
export const MAX_JUDGE_NOTE_CHARS = 400;
export const MAX_BENCH_SHELL_CHARS = 1024;
export const MAX_BENCH_STEP_LIMIT = 10_000;
export const MAX_BENCH_CASE_MINUTES = 600;
export const MIN_BENCH_PAIRS = 6;

export type BenchMetric = Metric | "failed";

export const benchMetricNames: Record<BenchMetric, string> = { ...metricNames, failed: "turns that ended badly" };

export type BenchCase = {
  id: string;
  title: string;
  prompt: string;
  folderId: string;
  fromThreadId: string;
  createdAt: number;
  rubric?: string;
  solution?: string;
  setup?: string;
  check?: string;
};

export type BenchResult = {
  caseId: string;
  arm: Arm;
  failures: number;
  blocks: number;
  steps: number;
  requests: number;
  tokens: number;
  cost: number;
  ms: number;
  failed: number;
  out?: number;
  judge?: number;
  judgeNote?: string;
  answer?: string;
  threadId?: string;
};

export type BenchRun = {
  id: string;
  improvementId: string;
  attempt: number;
  mode: string;
  model: string;
  effort?: string;
  label?: string;
  brand?: string;
  metric: BenchMetric;
  stepLimit?: number;
  caseMinutes?: number;
  startedAt: number;
  finishedAt?: number;
  plannedCases: number;
  caseIds: string[];
  threads: string[];
  state: "running" | "done" | "stopped";
  results: BenchResult[];
};

export type Bench = { cases: BenchCase[]; runs: BenchRun[]; judge?: VerifierSettings };

const text = (value: unknown, max: number) => (typeof value === "string" ? value : "").slice(0, max);
const count = (value: unknown) => { const number = Math.round(Number(value) || 0); return Number.isFinite(number) ? Math.max(0, number) : 0; };
const ids = (value: unknown, max: number) => (Array.isArray(value) ? value : []).flatMap((entry) => (text(entry, 64) ? [text(entry, 64)] : [])).slice(-max);
export const score = (value: unknown): number | null => {
  const number = Number(value);
  return typeof value === "number" && Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
};
const metricOf = (value: unknown): BenchMetric => (typeof value === "string" && Object.hasOwn(benchMetricNames, value) ? value as BenchMetric : "failed");

function validateResults(value: unknown): BenchResult[] {
  const raw = Array.isArray(value) ? value : [];
  return raw.slice(-MAX_BENCH_CASES * 2).flatMap((entry): BenchResult[] => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const caseId = text(item.caseId, 64);
    if (!caseId || (item.arm !== "a" && item.arm !== "b")) return [];
    return [{
      caseId,
      arm: item.arm,
      failures: count(item.failures),
      blocks: count(item.blocks),
      steps: count(item.steps),
      requests: count(item.requests),
      tokens: count(item.tokens),
      cost: count(item.cost),
      ms: count(item.ms),
      failed: item.failed ? 1 : 0,
      ...(Number.isFinite(Number(item.out)) && Number(item.out) > 0 ? { out: count(item.out) } : {}),
      ...(score(item.judge) === null ? {} : { judge: score(item.judge) as number }),
      ...(text(item.judgeNote, MAX_JUDGE_NOTE_CHARS) ? { judgeNote: text(item.judgeNote, MAX_JUDGE_NOTE_CHARS) } : {}),
      ...(text(item.answer, MAX_BENCH_ANSWER_CHARS) ? { answer: text(item.answer, MAX_BENCH_ANSWER_CHARS) } : {}),
      ...(text(item.threadId, 64) ? { threadId: text(item.threadId, 64) } : {}),
    }];
  });
}

const spendable = (runs: readonly BenchRun[]): BenchRun[] => [
  ...runs.filter((run) => run.state === "stopped" || (run.state === "done" && !run.improvementId)),
  ...runs.filter((run) => run.state === "done" && run.improvementId),
  ...runs.filter((run) => run.state === "running"),
];

export function prunedRuns(runs: readonly BenchRun[]): BenchRun[] {
  const over = runs.length - MAX_BENCH_RUNS;
  if (over <= 0) return [...runs];
  const gone = new Set(spendable(runs).slice(0, over).map((run) => run.id));
  return runs.filter((run) => !gone.has(run.id));
}
export function validateBench(value: unknown): Bench {
  const store = (value && typeof value === "object" ? value : {}) as { cases?: unknown; runs?: unknown; judge?: unknown };
  const rawCases = Array.isArray(store.cases) ? store.cases : [];
  const rawRuns = Array.isArray(store.runs) ? store.runs : [];
  const cases = rawCases.slice(-MAX_BENCH_CASES).flatMap((entry): BenchCase[] => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const id = text(item.id, 64);
    const prompt = text(item.prompt, MAX_BENCH_PROMPT_CHARS).trim();
    const folderId = text(item.folderId, 64);
    if (!id || !prompt || !folderId) return [];
    return [{
      id,
      title: text(item.title, 200) || "Untitled case",
      prompt,
      folderId,
      fromThreadId: text(item.fromThreadId, 64),
      createdAt: count(item.createdAt),
      ...(text(item.rubric, MAX_BENCH_RUBRIC_CHARS).trim() ? { rubric: text(item.rubric, MAX_BENCH_RUBRIC_CHARS).trim() } : {}),
      ...(text(item.solution, MAX_BENCH_ANSWER_CHARS).trim() ? { solution: text(item.solution, MAX_BENCH_ANSWER_CHARS).trim() } : {}),
      ...(text(item.setup, MAX_BENCH_SHELL_CHARS).trim() ? { setup: text(item.setup, MAX_BENCH_SHELL_CHARS).trim() } : {}),
      ...(text(item.check, MAX_BENCH_SHELL_CHARS).trim() ? { check: text(item.check, MAX_BENCH_SHELL_CHARS).trim() } : {}),
    }];
  });
  const runs = rawRuns.flatMap((entry): BenchRun[] => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const id = text(item.id, 64);
    if (!id) return [];
    const caseIds = ids(item.caseIds, MAX_BENCH_CASES);
    const improvementId = text(item.improvementId, 64);
    const row: BenchRun = {
      id,
      improvementId,
      attempt: improvementId ? Math.max(1, count(item.attempt)) : 0,
      mode: text(item.mode, 32),
      model: text(item.model, 200),
      ...(isThinkingLevel(item.effort) && item.effort ? { effort: item.effort } : {}),
      ...(text(item.label, 120) ? { label: text(item.label, 120) } : {}),
      ...(text(item.brand, 32) ? { brand: text(item.brand, 32) } : {}),
      metric: metricOf(item.metric),
      ...(count(item.stepLimit) ? { stepLimit: Math.min(count(item.stepLimit), MAX_BENCH_STEP_LIMIT) } : {}),
      ...(count(item.caseMinutes) ? { caseMinutes: Math.min(count(item.caseMinutes), MAX_BENCH_CASE_MINUTES) } : {}),
      startedAt: count(item.startedAt),
      ...(count(item.finishedAt) ? { finishedAt: count(item.finishedAt) } : {}),
      plannedCases: Math.min(count(item.plannedCases) || caseIds.length, MAX_BENCH_CASES),
      caseIds,
      threads: ids(item.threads, MAX_BENCH_CASES * 2),
      state: item.state === "done" ? "done" : item.state === "stopped" ? "stopped" : "running",
      results: validateResults(item.results),
    };
    return [row.state === "done" && !runComplete(row) ? { ...row, state: "stopped" } : row];
  });
  let judge: VerifierSettings | undefined;
  try { judge = validateJudge(store.judge); } catch { judge = undefined; }
  return { cases, runs: prunedRuns(runs), ...(judge?.model && store.judge ? { judge } : {}) };
}

export const lastLine = (output: string): string =>
  output.split("\n").map((line) => line.trim()).filter(Boolean).at(-1)?.slice(0, MAX_JUDGE_NOTE_CHARS) ?? "";

export const runKey = (run: Pick<BenchRun, "model" | "effort">): string => run.effort ? `${run.model}@${run.effort}` : run.model;

export const runName = (run: Pick<BenchRun, "model" | "effort" | "label">): string => {
  const name = run.label || run.model.split("/").pop() || run.model;
  return run.effort ? `${name} · ${thinkingLabel(run.effort).toLowerCase()}` : name;
};

export const runArms = (run: BenchRun): number => (run.improvementId ? 2 : 1);

export const runExpected = (run: BenchRun): number => run.plannedCases * runArms(run);

export const runComplete = (run: BenchRun): boolean => run.results.length >= runExpected(run);

export const runMetric = (run: BenchRun): BenchMetric => metricOf(run.metric);

export const attemptsOf = (runs: readonly BenchRun[], ids: readonly string[]): BenchRun[] =>
  runs.filter((run) => run.improvementId && ids.includes(run.improvementId) && run.state === "done").sort((left, right) => left.startedAt - right.startedAt);

export type Pair = { caseId: string; a: number; b: number; d: number };

export function pairsOf(run: BenchRun, metric: BenchMetric): Pair[] {
  const seen = new Map<string, { a: number[]; b: number[] }>();
  for (const result of run.results) {
    const bucket = seen.get(result.caseId) ?? { a: [], b: [] };
    bucket[result.arm].push(result[metric]);
    seen.set(result.caseId, bucket);
  }
  return run.caseIds.flatMap((caseId): Pair[] => {
    const bucket = seen.get(caseId);
    if (!bucket?.a.length || !bucket.b.length) return [];
    const a = stat(bucket.a).mean;
    const b = stat(bucket.b).mean;
    return [{ caseId, a, b, d: b - a }];
  });
}

const T_95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];

export function tCritical(df: number): number {
  return T_95[Math.min(Math.max(1, Math.round(df)), T_95.length) - 1];
}

export function signTest(wins: number, losses: number): number {
  const m = wins + losses;
  if (m <= 0) return 1;
  const k = Math.min(wins, losses);
  let term = 1;
  let tail = 1;
  for (let j = 1; j <= k; j += 1) {
    term *= (m - j + 1) / j;
    tail += term;
  }
  return Math.min(1, (2 * tail) / 2 ** m);
}

export type Paired = {
  n: number;
  a: Stat;
  b: Stat;
  d: Stat;
  delta: number | null;
  se: number;
  t: number | null;
  tCritical: number;
  tClear: boolean;
  wins: number;
  losses: number;
  ties: number;
  signP: number;
  signClear: boolean;
  ci: number;
  short: string;
  verdict: "improved" | "regressed" | "unproven" | "pending";
};

export function paired(run: BenchRun, metric: BenchMetric): Paired {
  const pairs = pairsOf(run, metric);
  const n = pairs.length;
  const a = stat(pairs.map((pair) => pair.a));
  const b = stat(pairs.map((pair) => pair.b));
  const d = stat(pairs.map((pair) => pair.d));
  const se = n ? d.sd / Math.sqrt(n) : 0;
  const critical = tCritical(n - 1);
  const t = se > 0 ? d.mean / se : null;
  const tClear = t !== null && Math.abs(t) > critical;
  const wins = pairs.filter((pair) => pair.d < 0).length;
  const losses = pairs.filter((pair) => pair.d > 0).length;
  const untied = wins + losses;
  const signP = signTest(wins, losses);
  const signClear = untied > 0 && signP <= 0.05;
  const short = run.state !== "done" ? "run unfinished"
    : n < MIN_BENCH_PAIRS ? `${n} of ${MIN_BENCH_PAIRS} pairs`
    : untied < MIN_BENCH_PAIRS ? `${untied} untied of ${MIN_BENCH_PAIRS}`
    : t !== null && !tClear ? "gap inside the noise"
    : !signClear ? "not one-way enough"
    : "";
  const verdict: Paired["verdict"] = run.state !== "done" ? "pending"
    : short ? "unproven"
    : d.mean < 0 ? "improved" : "regressed";
  return {
    n,
    a,
    b,
    d,
    delta: n && a.mean !== 0 ? ((b.mean - a.mean) / Math.abs(a.mean)) * 100 : null,
    se,
    t,
    tCritical: critical,
    tClear,
    wins,
    losses,
    ties: n - wins - losses,
    signP,
    signClear,
    ci: critical * se,
    short,
    verdict,
  };
}

export const RECORD_JOIN = " · ";

export function benchLine(run: BenchRun, kept: boolean): string {
  const metric = runMetric(run);
  const result = paired(run, metric);
  const change = !result.n ? "no comparable cases"
    : result.delta === null ? `${result.d.mean > 0 ? "+" : ""}${result.d.mean.toFixed(2)} per case from a zero baseline`
    : `${result.delta > 0 ? "+" : ""}${result.delta.toFixed(0)}%`;
  const pairs = `${result.n} paired ${result.n === 1 ? "case" : "cases"}`;
  return [
    `${kept ? "Kept" : "Reverted"} at ${pairs}`,
    benchMetricNames[metric],
    change,
    result.verdict,
    ...(run.attempt > 1 ? [`attempt ${run.attempt}`] : []),
    result.signP < 0.001 ? "p<0.001" : `p=${result.signP.toFixed(3)}`,
  ].join(RECORD_JOIN);
}

export const recordVerdict = (record: string | undefined): Paired["verdict"] | "" => {
  const said = (record ?? "").split(RECORD_JOIN);
  return said.includes("improved") ? "improved" : said.includes("regressed") ? "regressed" : said.includes("unproven") ? "unproven" : "";
};

export const provenCount = (improvements: readonly Improvement[]): number =>
  improvements.filter((item) => item.state === "kept" && recordVerdict(item.result) === "improved").length;

export type Point = { runId: string; at: number; mean: number; n: number };

export function scoreboard(runs: readonly BenchRun[], metric: BenchMetric, under: { mode: string; model: string }): Point[] {
  const eligible = runs
    .filter((run) => !run.improvementId && run.state === "done" && runMetric(run) === metric && run.mode === under.mode && run.model === under.model && run.caseIds.length)
    .sort((left, right) => left.startedAt - right.startedAt);
  const buckets = new Map<string, BenchRun[]>();
  for (const run of eligible) for (const caseId of run.caseIds) buckets.set(caseId, [...(buckets.get(caseId) ?? []), run]);
  const family = [...buckets.values()].sort((left, right) => right.length - left.length || right[right.length - 1].startedAt - left[left.length - 1].startedAt)[0];
  if (!family) return [];
  const shared = family.reduce((keep, run) => keep.filter((caseId) => run.caseIds.includes(caseId)), [...family[0].caseIds]);
  return family.flatMap((run): Point[] => {
    const values = shared.flatMap((caseId) => {
      const samples = run.results.filter((result) => result.caseId === caseId && result.arm === "a");
      return samples.length ? [stat(samples.map((result) => result[metric])).mean] : [];
    });
    return values.length ? [{ runId: run.id, at: run.startedAt, mean: stat(values).mean, n: values.length }] : [];
  });
}

export type BoardMetric = "judge" | "cost" | "ms" | "tokens" | "out" | "steps" | "perCase";
export type CellMetric = Exclude<BoardMetric, "perCase"> | "failed";

export const boardMetricNames: Record<BoardMetric, string> = {
  judge: "judge score",
  cost: "cost",
  ms: "time",
  tokens: "tokens",
  out: "output + thinking",
  steps: "tool calls",
  perCase: "cost per case",
};

export const cellMetricNames: Record<CellMetric, string> = {
  judge: "judge score",
  cost: "cost",
  ms: "time",
  tokens: "tokens",
  out: "output + thinking",
  steps: "tool calls",
  failed: "ended badly",
};

export const lowerIsBetter: Record<BoardMetric, boolean> = { judge: false, cost: true, ms: true, tokens: true, out: true, steps: true, perCase: true };

export type BoardCell = {
  caseId: string;
  threadId: string;
  judge: number | null;
  judgeNote: string;
  answer: string;
  cost: number;
  ms: number;
  tokens: number;
  out: number;
  steps: number;
  requests: number;
  failed: number;
};

export type BoardRow = {
  model: string;
  name: string;
  brand: string;
  runId: string;
  at: number;
  partial: boolean;
  cells: BoardCell[];
  judge: number | null;
  cost: number;
  ms: number;
  tokens: number;
  out: number;
  steps: number;
  failed: number;
  perCase: number;
};

export type Board = { caseIds: string[]; rows: BoardRow[]; skipped: number };

const cellOf = (run: BenchRun, caseId: string): BoardCell | null => {
  const found = run.results.find((result) => result.caseId === caseId && result.arm === "a");
  if (!found) return null;
  return {
    caseId,
    threadId: found.threadId ?? "",
    judge: typeof found.judge === "number" ? found.judge : null,
    judgeNote: found.judgeNote ?? "",
    answer: found.answer ?? "",
    cost: found.cost,
    ms: found.ms,
    tokens: found.tokens,
    out: found.out ?? 0,
    steps: found.steps,
    requests: found.requests,
    failed: found.failed,
  };
};

export function modelBoard(runs: readonly BenchRun[], cases: readonly BenchCase[]): Board {
  const known = new Set(cases.map((row) => row.id));
  const latest = new Map<string, BenchRun>();
  for (const run of runs) {
    if (run.improvementId || run.state !== "done" || runArms(run) !== 1 || !run.model) continue;
    const held = latest.get(runKey(run));
    if (!held || run.startedAt >= held.startedAt) latest.set(runKey(run), run);
  }
  const coverage = (run: BenchRun) => new Set(run.results.filter((result) => result.arm === "a" && known.has(result.caseId)).map((result) => result.caseId));
  const picked = [...latest.values()].filter((run) => coverage(run).size);
  if (!picked.length) return { caseIds: [], rows: [], skipped: 0 };
  const covered = picked.map(coverage);
  const union = new Set(covered.flatMap((set) => [...set]));
  const caseIds = cases.map((row) => row.id).filter((id) => covered.every((set) => set.has(id)));
  const rows = picked.flatMap((run, index): BoardRow[] => {
    const cells = caseIds.flatMap((id) => { const cell = cellOf(run, id); return cell ? [cell] : []; });
    if (!cells.length) return [];
    const sum = (key: "cost" | "ms" | "tokens" | "out" | "steps" | "failed") => cells.reduce((total, cell) => total + cell[key], 0);
    const scores = cells.flatMap((cell) => cell.judge === null ? [] : [cell.judge]);
    return [{
      model: runKey(run),
      name: runName(run),
      brand: run.brand ?? "",
      runId: run.id,
      at: run.startedAt,
      partial: covered[index].size < union.size,
      cells,
      judge: scores.length ? scores.reduce((total, value) => total + value, 0) / scores.length : null,
      cost: sum("cost"),
      ms: sum("ms"),
      tokens: sum("tokens"),
      out: sum("out"),
      steps: sum("steps"),
      failed: sum("failed"),
      perCase: sum("cost") / cells.length,
    }];
  });
  rows.sort((left, right) => (right.judge ?? -1) - (left.judge ?? -1) || left.cost - right.cost || left.model.localeCompare(right.model));
  return { caseIds, rows, skipped: union.size - caseIds.length };
}

export const boardValue = (row: BoardRow, metric: BoardMetric): number => metric === "judge" ? row.judge ?? 0 : row[metric];

export type FrontierPoint = { id: string; x: number; y: number };

export function frontier(points: readonly FrontierPoint[], xLower: boolean, yLower: boolean): string[] {
  const asGood = (left: number, right: number, lower: boolean) => lower ? left <= right : left >= right;
  const better = (left: number, right: number, lower: boolean) => lower ? left < right : left > right;
  return points
    .filter((point) => !points.some((other) => other.id !== point.id
      && asGood(other.x, point.x, xLower) && asGood(other.y, point.y, yLower)
      && (better(other.x, point.x, xLower) || better(other.y, point.y, yLower))))
    .map((point) => point.id);
}

export const boardFrontier = (rows: readonly BoardRow[], x: BoardMetric, y: BoardMetric): Set<string> =>
  new Set(frontier(rows.map((row) => ({ id: row.model, x: boardValue(row, x), y: boardValue(row, y) })), lowerIsBetter[x], lowerIsBetter[y]));

export type LabelPoint = { id: string; x: number; y: number; width: number };
export type LabelBox = { id: string; x: number; y: number; anchor: "start" | "end" };
type Rect = { x1: number; y1: number; x2: number; y2: number };

const crosses = (rect: Rect, ax: number, ay: number, bx: number, by: number): boolean => {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  for (const [p, q] of [[-dx, ax - rect.x1], [dx, rect.x2 - ax], [-dy, ay - rect.y1], [dy, rect.y2 - ay]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
};
const overlaps = (one: Rect, two: Rect): boolean => one.x1 < two.x2 && two.x1 < one.x2 && one.y1 < two.y2 && two.y1 < one.y2;

export function placeLabels(points: readonly LabelPoint[], path: readonly string[], bounds: { left: number; right: number; top: number; bottom: number }, gap = 12, lineHeight = 11, radius = 10): LabelBox[] {
  const at = new Map(points.map((point) => [point.id, point]));
  const segments = path.slice(1).flatMap((id, index) => {
    const from = at.get(path[index]);
    const to = at.get(id);
    return from && to ? [[from.x, from.y, to.x, to.y] as const] : [];
  });
  const marks = points.map((point): Rect => ({ x1: point.x - radius, y1: point.y - radius, x2: point.x + radius, y2: point.y + radius }));
  const taken: Rect[] = [];
  return points.map((point, index) => {
    const above = point.y - radius - 3;
    const below = point.y + radius + lineHeight;
    const candidates: LabelBox[] = [
      { id: point.id, x: point.x + gap, y: point.y + 4, anchor: "start" },
      { id: point.id, x: point.x - gap, y: point.y + 4, anchor: "end" },
      { id: point.id, x: point.x - point.width / 2, y: above, anchor: "start" },
      { id: point.id, x: point.x - point.width / 2, y: below, anchor: "start" },
      { id: point.id, x: point.x + gap, y: above, anchor: "start" },
      { id: point.id, x: point.x - gap, y: above, anchor: "end" },
      { id: point.id, x: point.x + gap, y: below, anchor: "start" },
      { id: point.id, x: point.x - gap, y: below, anchor: "end" },
      { id: point.id, x: point.x - point.width / 2, y: above - lineHeight - 4, anchor: "start" },
      { id: point.id, x: point.x - point.width / 2, y: below + lineHeight + 4, anchor: "start" },
      { id: point.id, x: point.x + gap, y: above - lineHeight - 4, anchor: "start" },
      { id: point.id, x: point.x - gap, y: above - lineHeight - 4, anchor: "end" },
      { id: point.id, x: point.x + gap, y: below + lineHeight + 4, anchor: "start" },
      { id: point.id, x: point.x - gap, y: below + lineHeight + 4, anchor: "end" },
    ];
    const rectOf = (box: LabelBox): Rect => ({ x1: (box.anchor === "end" ? box.x - point.width : box.x) - 2, y1: box.y - lineHeight + 1, x2: (box.anchor === "end" ? box.x : box.x + point.width) + 2, y2: box.y + 4 });
    const penalty = (rect: Rect) => (rect.x1 < bounds.left || rect.x2 > bounds.right || rect.y1 < bounds.top || rect.y2 > bounds.bottom ? 100 : 0)
      + segments.filter(([ax, ay, bx, by]) => crosses(rect, ax, ay, bx, by)).length * 10
      + taken.filter((used) => overlaps(rect, used)).length * 20
      + marks.filter((mark, other) => other !== index && overlaps(rect, mark)).length * 8;
    const pick = candidates.map((box) => ({ box, cost: penalty(rectOf(box)) })).reduce((least, next) => next.cost < least.cost ? next : least).box;
    taken.push(rectOf(pick));
    return pick;
  });
}

export function exampleBench(): Bench {
  const at = Date.UTC(2026, 0, 1);
  const titles = ["Fix the flaky updater test", "Add CSV export to thread stats", "Debounce the search box", "Retry the gateway on 429"];
  const cases: BenchCase[] = titles.map((title, index) => ({ id: `example-case-${index}`, title, prompt: `${title}. Keep the checks green and say what the root cause was.`, folderId: "example", fromThreadId: "", createdAt: at }));
  const models: { model: string; judge: number[]; cost: number; ms: number; tokens: number; out: number; steps: number }[] = [
    { model: "anthropic/claude-opus-5", judge: [0.96, 0.9, 0.92, 0.88], cost: 412_000, ms: 148_000, tokens: 61_000, out: 14_200, steps: 21 },
    { model: "anthropic/claude-sonnet-5", judge: [0.9, 0.86, 0.88, 0.8], cost: 121_000, ms: 96_000, tokens: 52_000, out: 9_800, steps: 24 },
    { model: "openai/gpt-5.5", judge: [0.92, 0.7, 0.9, 0.84], cost: 233_000, ms: 171_000, tokens: 74_000, out: 22_400, steps: 33 },
    { model: "google/gemini-3.7-flash", judge: [0.84, 0.75, 0.8, 0.7], cost: 22_000, ms: 61_000, tokens: 40_000, out: 7_000, steps: 19 },
    { model: "z-ai/glm-5", judge: [0.8, 0.62, 0.84, 0.55], cost: 38_000, ms: 204_000, tokens: 88_000, out: 31_000, steps: 41 },
  ];
  const runs: BenchRun[] = models.map((entry, index) => ({
    id: `example-run-${index}`,
    improvementId: "",
    attempt: 0,
    mode: "auto",
    model: entry.model,
    metric: "failed",
    startedAt: at + index * 3_600_000,
    finishedAt: at + index * 3_600_000 + 600_000,
    plannedCases: cases.length,
    caseIds: cases.map((row) => row.id),
    threads: [],
    state: "done",
    results: cases.map((row, caseIndex): BenchResult => {
      const weight = (0.7 + (0.6 * ((caseIndex * 7 + index * 3) % 5)) / 5) / cases.length;
      const steps = Math.round(entry.steps * weight);
      return {
        caseId: row.id,
        arm: "a",
        failures: caseIndex % 3 === 0 ? 1 : 0,
        blocks: 0,
        steps,
        requests: steps + 2,
        tokens: Math.round(entry.tokens * weight),
        cost: Math.round(entry.cost * weight),
        ms: Math.round(entry.ms * weight),
        failed: entry.judge[caseIndex] < 0.6 ? 1 : 0,
        out: Math.round(entry.out * weight),
        judge: entry.judge[caseIndex],
        judgeNote: "Example score; no judge ran.",
      };
    }),
  }));
  return { cases, runs };
}
