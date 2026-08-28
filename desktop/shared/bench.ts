import { metricNames, stat, type Arm, type Improvement, type Metric, type Stat } from "./improvement";

export const MAX_BENCH_CASES = 12;
export const MAX_BENCH_RUNS = 24;
export const MAX_BENCH_PROMPT_CHARS = 4096;
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
};

export type BenchResult = {
  caseId: string;
  arm: Arm;
  failures: number;
  blocks: number;
  steps: number;
  failed: number;
};

export type BenchRun = {
  id: string;
  improvementId: string;
  attempt: number;
  mode: string;
  model: string;
  metric: BenchMetric;
  startedAt: number;
  finishedAt?: number;
  plannedCases: number;
  caseIds: string[];
  threads: string[];
  state: "running" | "done" | "stopped";
  results: BenchResult[];
};

export type Bench = { cases: BenchCase[]; runs: BenchRun[] };

const text = (value: unknown, max: number) => (typeof value === "string" ? value : "").slice(0, max);
const count = (value: unknown) => Math.max(0, Math.round(Number(value) || 0));
const ids = (value: unknown, max: number) => (Array.isArray(value) ? value : []).flatMap((entry) => (text(entry, 64) ? [text(entry, 64)] : [])).slice(-max);
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
      failed: item.failed ? 1 : 0,
    }];
  });
}

const spendable = (runs: readonly BenchRun[]): BenchRun[] => [
  ...runs.filter((run) => run.state === "stopped" || (run.state === "done" && !run.improvementId)),
  ...runs.filter((run) => run.state === "done" && run.improvementId),
];

export function prunedRuns(runs: readonly BenchRun[]): BenchRun[] {
  const over = runs.length - MAX_BENCH_RUNS;
  if (over <= 0) return [...runs];
  const gone = new Set(spendable(runs).slice(0, over).map((run) => run.id));
  return runs.filter((run) => !gone.has(run.id));
}
export function validateBench(value: unknown): Bench {
  const store = (value && typeof value === "object" ? value : {}) as { cases?: unknown; runs?: unknown };
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
      createdAt: Number(item.createdAt) || 0,
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
      metric: metricOf(item.metric),
      startedAt: Number(item.startedAt) || 0,
      ...(Number(item.finishedAt) ? { finishedAt: Number(item.finishedAt) } : {}),
      plannedCases: Math.min(count(item.plannedCases) || caseIds.length, MAX_BENCH_CASES),
      caseIds,
      threads: ids(item.threads, MAX_BENCH_CASES * 2),
      state: item.state === "done" ? "done" : item.state === "stopped" ? "stopped" : "running",
      results: validateResults(item.results),
    };
    return [row.state === "done" && !runComplete(row) ? { ...row, state: "stopped" } : row];
  });
  return { cases, runs: prunedRuns(runs) };
}

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
