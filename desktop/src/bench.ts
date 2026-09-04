import { attemptsOf, runComplete, validateBench, MAX_BENCH_CASES, MAX_BENCH_PROMPT_CHARS, MAX_BENCH_RUBRIC_CHARS, MAX_BENCH_SHELL_CHARS, type Bench, type BenchCase, type BenchMetric, type BenchRun } from "../shared/bench";
import { benchLive, containBench, driveBench, type BenchProgress } from "./bench-run";
import { readImprovements, saveImprovements } from "./improvements";
import { startTrial, type Improvement } from "../shared/improvement";
import { SETTINGS_KEY, validateSettings, type VerifierSettings } from "../shared/settings";
import { scopeApplies, scopeLabel } from "../shared/prompts";

const KEY = "emma.bench.v1";

export function readBench(): Bench {
  try { return validateBench(JSON.parse(localStorage.getItem(KEY) ?? "null")); }
  catch { return { cases: [], runs: [] }; }
}

export function saveBench(next: Bench): Bench {
  const valid = validateBench(next);
  localStorage.setItem(KEY, JSON.stringify(valid));
  return valid;
}

export function sweepBench(): Bench {
  const store = readBench();
  const stale = store.runs.filter((run) => run.state === "running" && run.id !== benchLive());
  if (!stale.length) return store;
  void containBench(stale.flatMap((run) => run.threads));
  const at = Date.now();
  const stopping = new Set(stale.map((run) => run.id));
  return saveBench({ ...store, runs: store.runs.map((run) => stopping.has(run.id) ? { ...run, state: "stopped", finishedAt: at } : run) });
}

export function addBenchCase(input: { title: string; prompt: string; folderId: string; fromThreadId?: string; rubric?: string; solution?: string; setup?: string; check?: string }): { id: string; store: Bench } {
  const current = readBench();
  if (current.cases.length >= MAX_BENCH_CASES) throw new Error(`The bench holds ${MAX_BENCH_CASES} cases. Remove one first.`);
  const taken = new Set(current.cases.map((row) => row.id));
  const at = Date.now();
  let id = `case-${at.toString(36)}`;
  for (let next = 2; taken.has(id); next += 1) id = `case-${at.toString(36)}-${next}`;
  const row: BenchCase = {
    id,
    title: input.title,
    prompt: input.prompt.slice(0, MAX_BENCH_PROMPT_CHARS),
    folderId: input.folderId,
    fromThreadId: input.fromThreadId ?? "",
    createdAt: at,
    ...(input.rubric?.trim() ? { rubric: input.rubric.trim().slice(0, MAX_BENCH_RUBRIC_CHARS) } : {}),
    ...(input.solution ? { solution: input.solution } : {}),
    ...(input.setup?.trim() ? { setup: input.setup.trim().slice(0, MAX_BENCH_SHELL_CHARS) } : {}),
    ...(input.check?.trim() ? { check: input.check.trim().slice(0, MAX_BENCH_SHELL_CHARS) } : {}),
  };
  const store = saveBench({ ...current, cases: [...current.cases, row] });
  if (!store.cases.some((item) => item.id === id)) throw new Error("That case is missing a prompt or a folder.");
  return { id, store };
}

function store(input: { onStore?: (store: Bench) => void }, next: Bench): void {
  const saved = saveBench(next);
  input.onStore?.(saved);
}

export function startBench(input: {
  cases: readonly BenchCase[];
  metric: BenchMetric;
  mode: string;
  model: string;
  effort?: string;
  improvement?: Improvement;
  stepLimit?: number;
  caseMinutes?: number;
  describe?: { label?: string; brand?: string };
  judge?: VerifierSettings;
  onStore?: (store: Bench) => void;
  onProgress?: (progress: BenchProgress | null) => void;
  onJudgeError?: (note: string) => void;
}): { runId: string; finished: Promise<void> } {
  const current = readBench();
  if (current.runs.some((row) => row.state === "running")) throw new Error("A bench is already running.");
  const { improvement } = input;
  const model = input.model.startsWith("provider:")
    ? validateSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null")).providers.find((profile) => profile.id === input.model.slice(9))?.modelId ?? ""
    : input.model;
  if (improvement && !scopeApplies(improvement.scope ?? "", model)) throw new Error(`This trial applies to ${scopeLabel(improvement.scope ?? "")}. Choose a matching model for the bench.`);
  const run: BenchRun = {
    id: `run-${Date.now().toString(36)}`,
    improvementId: improvement?.id ?? "",
    attempt: improvement ? Math.max(0, ...attemptsOf(current.runs, [improvement.id]).map((row) => row.attempt)) + 1 : 0,
    metric: input.metric,
    mode: input.mode,
    model: input.model,
    ...(input.effort ? { effort: input.effort } : {}),
    ...input.describe,
    ...(input.stepLimit ? { stepLimit: input.stepLimit } : {}),
    ...(input.caseMinutes ? { caseMinutes: input.caseMinutes } : {}),
    startedAt: Date.now(),
    plannedCases: input.cases.length,
    caseIds: input.cases.map((row) => row.id),
    threads: [],
    state: "running",
    results: [],
  };
  const patch = (runId: string, next: (row: BenchRun) => BenchRun) => {
    const held = readBench();
    store(input, { ...held, runs: held.runs.map((row) => row.id === runId ? next(row) : row) });
  };
  store(input, { ...current, runs: [...current.runs, run] });
  const finished = driveBench({
    run,
    cases: input.cases,
    ...(input.judge ? { judge: input.judge } : {}),
    onThread: (runId, threadId) => patch(runId, (row) => ({ ...row, threads: [...row.threads, threadId] })),
    onResult: (runId, value) => patch(runId, (row) => ({ ...row, results: [...row.results, value] })),
    onProgress: (progress) => input.onProgress?.(progress),
    onJudgeError: (note) => input.onJudgeError?.(note),
  }).finally(() => {
    patch(run.id, (row) => ({ ...row, state: runComplete(row) ? "done" : "stopped", finishedAt: Date.now() }));
    input.onProgress?.(null);
  });
  return { runId: run.id, finished };
}

export function installBenchHook() {
  window.emmaBench = {
    importCases: (cases) => cases.map((item) => addBenchCase(item).id),
    start: (options) => {
      const store = readBench();
      const chosen = options.caseIds?.length ? store.cases.filter((row) => options.caseIds!.includes(row.id)) : store.cases;
      const improvement = options.arms === "ab" ? readImprovements().items.find((row) => row.state === "trial") : undefined;
      if (options.arms === "ab" && !improvement) throw new Error("Nothing is on trial, so there is no b arm to run.");
      const started = startBench({
        cases: chosen,
        metric: options.metric ?? "failed",
        mode: options.mode ?? "auto",
        model: options.model ?? "",
        ...(options.effort ? { effort: options.effort } : {}),
        ...(improvement ? { improvement } : {}),
        ...(options.stepLimit ? { stepLimit: options.stepLimit } : {}),
        ...(options.caseMinutes ? { caseMinutes: options.caseMinutes } : {}),
        ...(store.judge ? { judge: store.judge } : {}),
      });
      void started.finished.catch(() => undefined);
      return started.runId;
    },
    read: () => readBench(),
    trial: (items) => {
      const at = Date.now();
      const next = items.reduce((held: Improvement[], item, index) => startTrial(held, {
        title: `Headless ${item.lever} trial`,
        lever: item.lever,
        metric: "failures",
        addition: item.addition,
        ...(item.scope ? { scope: item.scope } : {}),
        look: 1,
      }, at + index), readImprovements().items);
      return saveImprovements({ items: next }).items.filter((row) => row.state === "trial").map((row) => row.id);
    },
    revert: () => {
      const at = Date.now();
      const items = readImprovements().items.map((row) => row.state === "trial" ? { ...row, state: "reverted" as const, decidedAt: at, result: "Reverted from the headless bench driver" } : row);
      saveImprovements({ items });
    },
  };
}
