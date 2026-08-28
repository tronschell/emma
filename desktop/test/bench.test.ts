import test from "node:test";
import assert from "node:assert/strict";
import { encodeSpans, type TraceSpan } from "../shared/trace";
import { compare, readTurn, type Arm, type Improvement } from "../shared/improvement";
import { attemptsOf, benchLine, benchMetricNames, MAX_BENCH_CASES, MAX_BENCH_RUNS, paired, pairsOf, provenCount, recordVerdict, runComplete, runMetric, scoreboard, signTest, tCritical, validateBench, type BenchMetric, type BenchResult, type BenchRun } from "../shared/bench";

const span = (over: Partial<TraceSpan>): TraceSpan => ({ id: `s-${over.name ?? "x"}-${over.startedAt ?? 0}`, name: "step", kind: "bash", startedAt: 1, endedAt: 2, status: "ok", ...over });
const turnOf = (arm: Arm, steps: number, ok = true, bad = 0) =>
  readTurn({
    timestamp: "2026-08-20T00:00:00Z",
    text: encodeSpans([span({ kind: "agent", name: "run", status: ok ? "ok" : "failed" }), ...Array.from({ length: steps }, (_, index) => span({ startedAt: index, status: index < bad ? "failed" : "ok" }))], { arm }),
  }, { id: `t-${arm}-${steps}`, title: "case" });
const resultOf = (caseId: string, arm: Arm, steps: number, ok = true, bad = 0): BenchResult => {
  const turn = turnOf(arm, steps, ok, bad);
  return { caseId, arm, failures: turn.failures, blocks: turn.blocks, steps: turn.steps, failed: turn.ok ? 0 : 1 };
};
const runOf = (over: Partial<BenchRun>): BenchRun => ({ id: "r1", improvementId: "i1", attempt: 1, mode: "auto", model: "opus", metric: "steps", startedAt: 1, plannedCases: over.caseIds?.length ?? 0, caseIds: [], threads: [], state: "done", results: [], ...over });
const armedRun = (a: readonly number[], b: readonly number[], over: Partial<BenchRun> = {}): BenchRun => {
  const caseIds = a.map((_, index) => `c${index}`);
  return runOf({ caseIds, results: caseIds.flatMap((id, index) => [resultOf(id, "a", a[index]), resultOf(id, "b", b[index])]), ...over });
};

test("a paired run reads the gap inside each case and not the spread between them", () => {
  const a = [2, 5, 9, 16, 25, 40];
  const b = a.map((value) => value - 1);
  const read = paired(armedRun(a, b), "steps");
  assert.equal(read.n, 6);
  assert.equal(read.d.mean, -1);
  assert.equal(read.wins, 6);
  assert.equal(read.verdict, "improved");

  const trial: Improvement = { id: "i1", title: "t", lever: "instructions", addition: "x", metric: "steps", startedAt: 0, look: 1, state: "trial" };
  const unpaired = compare([...a.map((value) => turnOf("a", value)), ...b.map((value) => turnOf("b", value))], trial);
  assert.equal(unpaired.clear, false, "unpaired, the same six wins drown in the spread between the cases");
});

test("a run with no variance in its differences rests on the sign test, and never claims a t-test", () => {
  const a = [3, 4, 5, 6, 7, 8];
  const flat = paired(armedRun(a, a.map((value) => value - 2)), "steps");
  assert.equal(flat.se, 0, "every case moved by the same amount, so there is no spread to divide by");
  assert.equal(flat.t, null);
  assert.equal(flat.tClear, false, "a t-test that could not be computed did not clear");
  assert.equal(flat.ci, 0, "and its interval is zero for the same reason, which is why a reader must ask t first");
  assert.equal(flat.signClear, true);
  assert.ok(flat.signP <= 0.05);
  assert.equal(flat.short, "");
  assert.equal(flat.verdict, "improved", "six one-way cases is a verdict the sign test carries on its own");

  const ends = runOf({ caseIds: a.map((_, index) => `c${index}`), results: a.flatMap((_, index) => [resultOf(`c${index}`, "a", 4, false), resultOf(`c${index}`, "b", 4)]) });
  const badly = paired(ends, "failed");
  assert.equal(badly.d.mean, -1, "a turn that ended badly is a cost like the other three");
  assert.equal(badly.verdict, "improved");
  assert.equal(benchMetricNames.failed, "turns that ended badly");
});

test("the sign test needs six one-way cases, and one outlier does not carry a run", () => {
  const five = paired(armedRun([4, 4, 4, 4, 4], [3, 3, 3, 3, 3]), "steps");
  assert.equal(signTest(5, 0), 0.0625);
  assert.ok(five.signP > 0.05, "five one-way cases cannot reach 0.05 even unanimously");
  assert.equal(five.verdict, "unproven");

  const outlier = paired(armedRun([52, 3, 3, 2, 2, 2], [2, 2, 2, 3, 3, 3]), "steps");
  assert.ok(outlier.d.mean < -8, "the mean says the change is a big win");
  assert.equal(outlier.wins, 3);
  assert.equal(outlier.losses, 3);
  assert.equal(outlier.signClear, false);
  assert.equal(outlier.verdict, "unproven");
  assert.equal(tCritical(5), 2.571);
  assert.equal(tCritical(99), 2.042);
});

test("a run is read only when it is done, and a junk store is no bench", () => {
  const a = [3, 4, 5, 6, 7, 8];
  const b = a.map((value) => value - 2);
  assert.equal(paired(armedRun(a, b, { state: "running" }), "steps").verdict, "pending");
  assert.equal(paired(armedRun(a, b, { state: "stopped" }), "steps").verdict, "pending", "stopping a run that looks good buys no verdict");

  assert.equal(paired(armedRun(a, b, { caseIds: ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"], plannedCases: 8 }), "steps").n, 6, "a case that never ran contributes no pair");

  const twice = armedRun([4, 4, 4, 4, 4, 4], [3, 3, 3, 3, 3, 3]);
  twice.results.push(resultOf("c0", "b", 1));
  assert.equal(pairsOf(twice, "steps")[0].b, 2, "a case run twice on one arm is averaged, not last-one-wins");

  assert.deepEqual(validateBench("nonsense"), { cases: [], runs: [] });
  const store = validateBench({
    cases: [
      ...Array.from({ length: 8 }, (_, index) => ({ id: `c${index}`, title: "Case", prompt: "Do the thing.", folderId: "f1", createdAt: 1 })),
      { id: "no-prompt", prompt: "  ", folderId: "f1" },
      { id: "no-folder", prompt: "Do the thing." },
    ],
    runs: [{ id: "r1", caseIds: ["c1", "c2"], state: "nonsense", results: [{ caseId: "c1", arm: "z" }, { caseId: "c1", arm: "a", steps: -4, failed: 3 }] }],
  });
  assert.equal(store.cases.length, 8);
  assert.equal(store.cases.some((item) => item.id === "no-folder"), false);
  assert.equal(validateBench({ cases: Array.from({ length: 20 }, (_, index) => ({ id: `c${index}`, prompt: "Do the thing.", folderId: "f1" })) }).cases.length, MAX_BENCH_CASES);
  assert.equal(store.runs[0].state, "running");
  assert.deepEqual(store.runs[0].results.map((item) => [item.arm, item.steps, item.failed]), [["a", 0, 1]], "a turn either ended badly or it did not");
  const full = armedRun(Array.from({ length: MAX_BENCH_CASES }, () => 4), Array.from({ length: MAX_BENCH_CASES }, () => 3));
  assert.equal(validateBench({ cases: [], runs: [full] }).runs[0].results.length, MAX_BENCH_CASES * 2, "a full paired run is the whole window and loses nothing to it");

  const overrun = validateBench({ cases: [], runs: [{ id: "r2", threads: Array.from({ length: MAX_BENCH_CASES * 3 }, (_, index) => `t${index}`) }] }).runs[0];
  assert.equal(overrun.threads.length, MAX_BENCH_CASES * 2);
  assert.equal(overrun.threads.at(-1), `t${MAX_BENCH_CASES * 3 - 1}`, "the newest case threads are the ones a crash left running, so they are the ones the sweep must keep");
});

test("the scoreboard only compares runs over the cases they share", () => {
  const baseline = (id: string, at: number, caseIds: string[], steps: number[], over: Partial<BenchRun> = {}) =>
    runOf({ id, improvementId: "", startedAt: at, caseIds, results: caseIds.map((caseId, index) => resultOf(caseId, "a", steps[index])), ...over });
  const runs = [
    baseline("r1", 10, ["c1", "c2", "c3"], [10, 20, 40]),
    baseline("r2", 20, ["c1", "c2"], [6, 8]),
    baseline("r3", 30, ["c1", "c2"], [1, 1], { model: "haiku" }),
    runOf({ id: "r4", startedAt: 40, caseIds: ["c1", "c2"], results: [resultOf("c1", "a", 1), resultOf("c2", "a", 1)] }),
  ];
  const points = scoreboard(runs, "steps", { mode: "auto", model: "opus" });
  assert.deepEqual(points.map((point) => point.runId), ["r1", "r2"], "a different model is a different history, and a trial run is not a baseline");
  assert.equal(points[0].mean, 15, "the case only the first run had does not inflate it");
  assert.equal(points[0].n, 2);
  assert.equal(points[1].mean, 7);
  assert.deepEqual(scoreboard(runs, "steps", { mode: "auto", model: "sonnet" }), []);
});

test("one tie is enough to block a run the t-test clears outright, and the panel is told which", () => {
  const caseIds = ["c0", "c1", "c2", "c3", "c4", "c5"];
  const run = runOf({
    caseIds,
    metric: "failed",
    results: caseIds.flatMap((id, index) => [resultOf(id, "a", 4, index < 5 ? false : true), resultOf(id, "b", 4)]),
  });
  const read = paired(run, "failed");
  assert.equal(read.n, 6);
  assert.equal(read.ties, 1);
  assert.equal(read.wins, 5);
  assert.ok(read.t !== null && read.t < -4.9, "five of five failures gone is a huge t");
  assert.equal(read.tClear, true);
  assert.equal(read.signP, 0.0625, "2/2^5 cannot reach 0.05, and lowering the bar is the dishonest fix");
  assert.equal(read.verdict, "unproven");
  assert.equal(read.short, "5 untied of 6", "the blocker is the tie, not the pair count");
  assert.equal(benchLine(run, true), `Kept at 6 paired cases · turns that ended badly · -100% · unproven · p=0.063`);
});

test("a run that shares no cases with the history does not erase the history", () => {
  const baseline = (id: string, at: number, caseIds: string[], steps: number[]) =>
    runOf({ id, improvementId: "", startedAt: at, caseIds, results: caseIds.map((caseId, index) => resultOf(caseId, "a", steps[index])) });
  const overlapping = [
    baseline("r1", 10, ["c1", "c2", "c3", "c4", "c5", "c6"], [10, 10, 10, 40, 40, 40]),
    baseline("r2", 20, ["c1", "c2", "c3", "c7", "c8", "c9"], [4, 4, 4, 40, 40, 40]),
  ];
  const points = scoreboard(overlapping, "steps", { mode: "auto", model: "opus" });
  assert.deepEqual(points.map((point) => point.runId), ["r1", "r2"]);
  assert.deepEqual(points.map((point) => point.n), [3, 3], "only the three cases both runs ran are scored");
  assert.equal(points[0].mean, 10);
  assert.equal(points[1].mean, 4);

  const disjoint = [...overlapping, baseline("r3", 30, ["x1", "x2", "x3"], [1, 1, 1])];
  assert.deepEqual(scoreboard(disjoint, "steps", { mode: "auto", model: "opus" }).map((point) => point.runId), ["r1", "r2"], "the newest run standing alone does not delete the curve");
});

test("a run is complete only when it has every case-arm it declared", () => {
  const caseIds = ["c0", "c1", "c2", "c3", "c4", "c5"];
  const full = armedRun([4, 4, 4, 4, 4, 4], [3, 3, 3, 3, 3, 3]);
  assert.equal(runComplete(full), true);
  assert.equal(runComplete({ ...full, plannedCases: 12, caseIds: [...caseIds, ...caseIds.map((id) => `${id}x`)] }), false);
  assert.equal(runComplete({ ...full, results: full.results.slice(0, -1) }), false);
  const solo = runOf({ improvementId: "", caseIds, plannedCases: 6, results: caseIds.map((id) => resultOf(id, "a", 4)) });
  assert.equal(runComplete(solo), true, "a baseline run declares one arm, not two");
  assert.equal(runComplete({ ...solo, results: solo.results.slice(0, -1) }), false);
});

test("a run is read under the metric it stamped, and no other", () => {
  const caseIds = ["c0", "c1", "c2", "c3", "c4", "c5"];
  const run = runOf({ caseIds, metric: "failed", results: caseIds.flatMap((id) => [resultOf(id, "a", 4, false), resultOf(id, "b", 4)]) });
  assert.equal(runMetric(run), "failed");
  assert.equal(paired(run, runMetric(run)).verdict, "improved");
  assert.equal(paired(run, "steps").verdict, "unproven", "the same run says nothing about tool calls, and the metric is not a knob after the fact");
  const line = benchLine(run, true);
  assert.ok(line.includes(benchMetricNames.failed), line);
  assert.equal(line.includes(benchMetricNames.steps), false, "the record names the metric the run declared, never a later selection");
  assert.equal(runMetric({ ...run, metric: "shopping" as never }), "failed", "a stored metric that is not a metric reads as the default");
});

test("a second attempt at the same trial is named in the record", () => {
  const tied = armedRun([4, 4, 4, 4, 4, 4], [4, 4, 4, 4, 4, 4], { id: "r1", startedAt: 10 });
  const won = armedRun([4, 4, 4, 4, 4, 4], [3, 3, 3, 3, 3, 3], { id: "r2", startedAt: 20, attempt: 2 });
  assert.equal(paired(tied, "steps").verdict, "unproven");
  assert.deepEqual(attemptsOf([won, tied], ["i1"]).map((row) => row.id), ["r1", "r2"], "every done run of the improvement, oldest first");
  assert.deepEqual(attemptsOf([tied, won], []), []);
  assert.equal(benchLine(tied, false).includes("attempt"), false, "a first look is not an attempt count");
  assert.ok(benchLine(won, true).includes("attempt 2"), benchLine(won, true));
});

test("every record names the population its own look ran, so a shrunk case set shows across the lineage", () => {
  const twelve = Array.from({ length: 12 }, () => 4);
  const first = armedRun(twelve, twelve.map((value, index) => index < 6 ? value - 1 : value + 1), { id: "r1", startedAt: 10 });
  const survivors = armedRun([4, 4, 4, 4, 4, 4], [3, 3, 3, 3, 3, 3], { id: "r2", startedAt: 20, attempt: 2 });
  assert.equal(paired(first, "steps").verdict, "unproven");
  assert.equal(paired(survivors, "steps").verdict, "improved");
  assert.equal(benchLine(first, false), `Reverted at 12 paired cases · ${benchMetricNames.steps} · 0% · unproven · p=1.000`);
  const shopped = benchLine(survivors, true);
  assert.equal(shopped, `Kept at 6 paired cases · ${benchMetricNames.steps} · -25% · improved · attempt 2 · p=0.031`);
  assert.equal(shopped.includes("12"), false, "the second look states the six it ran and cannot restate a population it did not");
});

test("a change is proven by the record it was kept on, and the window cannot unprove it", () => {
  const won = armedRun([4, 4, 4, 4, 4, 4], [3, 3, 3, 3, 3, 3], { id: "r1", startedAt: 10 });
  const lost = armedRun([3, 3, 3, 3, 3, 3], [4, 4, 4, 4, 4, 4], { id: "r3", startedAt: 30 });
  const kept: Improvement = { id: "i1", title: "t", lever: "instructions", addition: "x", metric: "steps", startedAt: 0, look: 1, state: "kept", result: benchLine(won, true) };
  assert.equal(paired(lost, "steps").verdict, "regressed");
  assert.equal(provenCount([kept]), 1, "the record says improved, and it says so with no run left in the store to consult");
  assert.equal(provenCount([kept, { ...kept, id: "i2" }]), 2);
  assert.equal(provenCount([{ ...kept, state: "reverted" }]), 0, "a change the user threw away is not proven");
  assert.equal(provenCount([{ ...kept, state: "trial" }]), 0, "a trial still running has proven nothing");
  assert.equal(provenCount([{ ...kept, result: benchLine(lost, true) }]), 0, "a change kept over a run that read regressed is kept, not proven");
  assert.equal(provenCount([{ ...kept, result: undefined }]), 0, "a change kept with no bench record behind it is not proven");
  assert.equal(provenCount([{ ...kept, result: "Kept at 6 paired cases · improved by a lot" }]), 0, "the verdict is a field of the record, not a word somewhere in it");
  assert.equal(recordVerdict(benchLine(armedRun([4, 4, 4, 4, 4, 4], [4, 4, 4, 4, 4, 4], {}), true)), "unproven");
  assert.equal(recordVerdict("Reverted at 3/4 turns · +12%"), "", "the live split writes no verdict, so it reads as none");
});

test("the curve plots only the runs that stamped the metric it is drawn under", () => {
  const shared = ["c1", "c2"];
  const baseline = (id: string, at: number, steps: number, metric: BenchMetric) =>
    runOf({ id, improvementId: "", metric, startedAt: at, caseIds: shared, results: shared.map((caseId) => resultOf(caseId, "a", steps)) });
  const runs = [baseline("r1", 10, 20, "failed"), baseline("r2", 20, 10, "failed"), baseline("r3", 30, 6, "steps")];
  assert.deepEqual(scoreboard(runs, "failed", { mode: "auto", model: "opus" }).map((point) => point.runId), ["r1", "r2"]);
  assert.deepEqual(scoreboard(runs, "steps", { mode: "auto", model: "opus" }).map((point) => point.runId), ["r3"], "one cheap run under a new metric does not re-read the two behind it");
  assert.equal(scoreboard(runs, "steps", { mode: "auto", model: "opus" })[0].mean, 6);
});

test("a full run against a spotless baseline had cases, whatever the percentage cannot say", () => {
  const caseIds = ["c0", "c1", "c2", "c3", "c4", "c5"];
  const run = runOf({ caseIds, metric: "failures", results: caseIds.flatMap((id) => [resultOf(id, "a", 3), resultOf(id, "b", 3, true, 1)]) });
  const read = paired(run, "failures");
  assert.equal(read.n, 6);
  assert.equal(read.a.mean, 0);
  assert.equal(read.delta, null, "a percentage of nothing is not a number");
  assert.equal(read.verdict, "regressed");
  const line = benchLine(run, false);
  assert.equal(line.includes("no comparable cases"), false, "six pairs is not no cases");
  assert.equal(line, `Reverted at 6 paired cases · ${benchMetricNames.failures} · +1.00 per case from a zero baseline · regressed · p=0.031`);
  assert.equal(benchLine(runOf({ caseIds: [], plannedCases: 0 }), false), "Reverted at 0 paired cases · tool calls per turn · no comparable cases · unproven · p=1.000");
});

test("a stored done that is short of the case-arms it declared is demoted on the way in", () => {
  const caseIds = Array.from({ length: 12 }, (_, index) => `c${index}`);
  const forged = runOf({ id: "forged", caseIds, plannedCases: 12, results: caseIds.slice(0, 9).flatMap((id) => [resultOf(id, "a", 4), resultOf(id, "b", 3)]) });
  assert.equal(paired({ ...forged, state: "done" }, "steps").verdict, "improved", "the reading has no shortfall rule of its own: nine one-way pairs is an improved run");
  const store = validateBench({ cases: [], runs: [forged, armedRun([4, 4, 4, 4, 4, 4], [3, 3, 3, 3, 3, 3], { id: "whole" })] });
  assert.equal(store.runs[0].state, "stopped", "eighteen of twenty-four case-arms is a stopped run whatever the row claims");
  assert.equal(paired(store.runs[0], "steps").verdict, "pending");
  assert.equal(store.runs[1].state, "done", "a run holding every case-arm it declared is untouched");
  assert.equal(paired(store.runs[1], "steps").verdict, "improved");
});

test("the attempt a run is is carried on the run, and no window can renumber it", () => {
  const attemptRun = (id: string, at: number, attempt: number) => armedRun([4, 4, 4, 4, 4, 4], [3, 3, 3, 3, 3, 3], { id, startedAt: at, attempt });
  const stored = validateBench({ cases: [], runs: [attemptRun("r1", 10, 3), attemptRun("r2", 20, 0)] }).runs;
  assert.deepEqual(stored.map((run) => run.attempt), [3, 1], "a run stored without a stamp is a first look, not one more than the run before it in the window");
  assert.equal(validateBench({ cases: [], runs: [runOf({ id: "b0", improvementId: "" })] }).runs[0].attempt, 0, "a baseline is not an attempt at anything");

  const third = attemptRun("r3", 30, 3);
  const baselines = Array.from({ length: MAX_BENCH_RUNS }, (_, index) => runOf({ id: `b${index}`, improvementId: "", startedAt: 100 + index }));
  const window = validateBench({ cases: [], runs: [attemptRun("r1", 10, 1), attemptRun("r2", 20, 2), third, ...baselines] }).runs;
  assert.equal(window.length, MAX_BENCH_RUNS);
  assert.deepEqual(attemptsOf(window, ["i1"]).map((run) => run.attempt), [1, 2, 3], "the evidence behind a decided record is what the ceiling may not spend");
  assert.deepEqual(window.filter((run) => !run.improvementId).map((run) => run.id).slice(0, 2), ["b3", "b4"], "the oldest baselines are what went, oldest first");
  const paired24 = Array.from({ length: MAX_BENCH_RUNS - 1 }, (_, index) => attemptRun(`k${index}`, index, 1));
  const spent = validateBench({ cases: [], runs: [attemptRun("r1", 10, 1), runOf({ id: "b", improvementId: "", state: "stopped" }), ...paired24] }).runs;
  assert.equal(spent.length, MAX_BENCH_RUNS);
  assert.equal(spent.some((run) => run.id === "b"), false, "a stopped run measured nothing, so it is what the ceiling spends first");
  assert.equal(spent.some((run) => run.id === "r1"), true, "and the paired run behind a record outlives it");
  assert.equal(validateBench({ cases: [], runs: [attemptRun("r1", 10, 1), ...paired24, attemptRun("k99", 99, 1), attemptRun("k98", 98, 1)] }).runs.some((run) => run.id === "r1"), false, "with nothing cheaper left the oldest paired run is what goes, and only then");
  assert.equal(validateBench({ cases: [], runs: [runOf({ id: "live", state: "running" }), ...baselines, ...baselines] }).runs.some((run) => run.id === "live"), true, "a run still going is never spent");
  const line = benchLine(third, true);
  assert.ok(line.includes("attempt 3"), line);
  assert.equal(benchLine(attemptRun("r4", 40, 1), true).includes("attempt"), false, "a first look counts nothing to name");
});

test("a later look reads as a later look with nothing of the earlier ones left in the store", () => {
  const retried: Improvement = { id: "i2", title: "bash keeps failing", lever: "instructions", addition: "Use rg.", metric: "steps", startedAt: 2, look: 2, state: "kept", origin: "i1" };
  const won = armedRun([4, 4, 4, 4, 4, 4], [3, 3, 3, 3, 3, 3], { id: "r2", improvementId: "i2", startedAt: 20, attempt: 2 });
  const line = benchLine(won, true);
  assert.deepEqual(attemptsOf([won], ["i1"]), [], "the first look's run is gone");
  assert.equal(line, `Kept at 6 paired cases · ${benchMetricNames.steps} · -25% · improved · attempt 2 · p=0.031`);
  assert.equal(provenCount([{ ...retried, result: line }]), 1, "the retry stands on its own record");
  assert.equal(provenCount([{ ...retried, id: "i1", origin: undefined }]), 0, "and it does not lend that record to the look before it");
});
