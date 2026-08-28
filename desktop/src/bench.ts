import { validateBench, type Bench } from "../shared/bench";
import { benchLive, containBench } from "./bench-run";

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
