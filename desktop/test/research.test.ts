import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asJob, bestValue, configureResearch, estimateMicroDollars, exhaustedBudget, improved, iterationPrompt, parseScore, readMetric, researchJobIds, resultsRow, RESULTS_HEADER, startResearchJob, stopResearchJob, unattendedRefusal, type ResearchDeps, type ResearchJob } from "../main/research";
import { UNATTENDED_PERMISSION_MODE, type PermissionMode } from "../shared/permissions";

const job = (extra: Record<string, unknown> = {}) => asJob({
  id: "research-1",
  title: "nanochat val_bpb",
  projectDir: "/tmp/nanochat",
  metricName: "val_bpb",
  metricKind: "grep",
  direction: "lower",
  evalCommand: "uv run train.py 2>&1",
  proposerModel: "vendor/model",
  permissionMode: "full",
  status: "running",
  ...extra,
});

test("the metric is the last time the run printed it, and its absence is a crash", () => {
  const output = [
    "step 100/1000 loss 3.21",
    "val_bpb: 1.004500",
    "resuming from checkpoint",
    "val_bpb: 0.997900",
    "done in 41s",
  ].join("\n");
  // A run that prints the key twice is reporting progress; the final one is the result.
  assert.equal(readMetric("val_bpb", output), 0.9979);
  // A metric that never appears — a crashed run, a typo'd key — has no value at all.
  assert.equal(readMetric("val_bpb", "Traceback (most recent call last):\nValueError\n[exit 1]"), undefined);
  assert.equal(readMetric("val_bpb", "the val_bpb: 0.5 was mid-line"), undefined);
  assert.equal(readMetric("accuracy", "accuracy: 8.1e-2 on the held-out set"), 0.081);
  assert.equal(readMetric("delta", "delta: -3"), -3);
  // The name is data, not a pattern.
  assert.equal(readMetric("a.b", "axb: 1\na.b: 2"), 2);
});

test("a judge answer is read defensively, and nonsense is a crash rather than a hang", () => {
  assert.equal(parseScore("72"), 72);
  assert.equal(parseScore("**Score: 84** — most suites pass"), 84);
  assert.equal(parseScore("I cannot score this output."), undefined);
});

test("keeping and reverting run in both directions", () => {
  assert.equal(improved(0.99, 1.01, "lower"), true);
  assert.equal(improved(1.02, 1.01, "lower"), false);
  assert.equal(improved(91, 88, "higher"), true);
  assert.equal(improved(87, 88, "higher"), false);
  // The first measurement has nothing to beat.
  assert.equal(improved(500, undefined, "lower"), true);
  assert.equal(improved(500, undefined, "higher"), true);
  // A tie is not an improvement, in either direction.
  assert.equal(improved(1.01, 1.01, "lower"), false);
  assert.equal(improved(88, 88, "higher"), false);

  const iterations = [
    { index: 1, value: 1.004, outcome: "discard", note: "", commit: "a" },
    { index: 2, value: undefined, outcome: "crash", note: "", commit: "b" },
    { index: 3, value: 0.997, outcome: "keep", note: "", commit: "c" },
  ];
  assert.equal(bestValue(iterations, "lower"), 0.997);
  assert.equal(bestValue(iterations, "higher"), 1.004);
  assert.equal(bestValue([], "lower"), undefined);
});

test("an exhausted budget pauses with the one that stopped it, and zero is no limit", () => {
  assert.equal(exhaustedBudget(job()), undefined);
  assert.equal(exhaustedBudget(job({ maxSeconds: 0, spentSeconds: 99999 })), undefined);
  assert.match(exhaustedBudget(job({ maxSeconds: 3600, spentSeconds: 3600 })) ?? "", /time budget/);
  assert.match(exhaustedBudget(job({ maxTokens: 1000, spentTokens: 4000 })) ?? "", /token budget/);
  assert.match(exhaustedBudget(job({ maxMicroDollars: 5_000_000, spentMicroDollars: 5_100_000 })) ?? "", /spend budget is used up — \$5\.10 of \$5\.00/);
  // Both spent: the note names the first one checked rather than listing them.
  assert.match(exhaustedBudget(job({ maxSeconds: 10, spentSeconds: 20, maxTokens: 10, spentTokens: 20 })) ?? "", /time budget/);
});

test("results.tsv is one tab-separated row an iteration, header included", () => {
  assert.equal(RESULTS_HEADER, "commit\tvalue\toutcome\tdescription\n");
  assert.equal(resultsRow("a1b2c3d4e5f6", 0.9979, "keep", "switched the optimizer to muon"), "a1b2c3d4e5f6\t0.9979\tkeep\tswitched the optimizer to muon\n");
  // A crash has no number, and a description that wrapped is one line again.
  assert.equal(resultsRow("a1b2c3d4e5f6", undefined, "crash", "raised the\n  learning rate"), "a1b2c3d4e5f6\t-\tcrash\traised the learning rate\n");
  assert.equal(resultsRow("", 1, "discard", ""), "-\t1\tdiscard\t-\n");
});

test("the iteration prompt carries the state and forbids the agent measuring itself", () => {
  const prompt = iterationPrompt(job({
    prompt: "Only touch @train.py, and read /muon first",
    iterations: [
      { index: 1, value: 1.0045, outcome: "discard", note: "raised the learning rate" },
      { index: 2, value: 0.9979, outcome: "keep", note: "switched the optimizer to muon" },
    ],
  }), 3);
  assert.match(prompt, /Iteration 3/);
  assert.match(prompt, /val_bpb, where lower is better/);
  assert.match(prompt, /Best so far: 0.9979/);
  assert.match(prompt, /switched the optimizer to muon/);
  assert.match(prompt, /Do not run that command yourself/);
  assert.match(prompt, /ONE change/);
  // The brief is carried verbatim — its "/" and "@" tokens are resolved by the run,
  // not rewritten here — and the loop's own instruction still comes after it.
  assert.match(prompt, /Only touch @train\.py, and read \/muon first/);
  assert.ok(prompt.indexOf("Only touch") < prompt.indexOf("ONE change"));
  // A job without a brief says nothing about one.
  assert.doesNotMatch(iterationPrompt(job(), 1), /brief for this experiment/);
});

test("a job off the snapshot survives numbers arriving as strings", () => {
  const stored = job({ maxSeconds: "3600", spentTokens: "1200", iterations: [{ index: "1", value: null, outcome: "crash", note: "n", commit: "c" }] });
  assert.equal(stored.maxSeconds, 3600);
  assert.equal(stored.spentTokens, 1200);
  assert.equal(stored.iterations[0].index, 1);
  assert.equal(stored.iterations[0].value, undefined);
});

test("spend is tokens times the model's rate, and a rate the catalog lacks costs nothing", () => {
  assert.equal(estimateMicroDollars({ inputTokens: 1_000_000, outputTokens: 500_000 }, { input: 3_000_000, output: 15_000_000 }), 10_500_000);
  assert.equal(estimateMicroDollars({ inputTokens: 4000, outputTokens: 900 }, { input: 0, output: 0 }), 0);
});

test("an experiment nobody is watching refuses to start in a mode that waits for an answer", () => {
  assert.equal(unattendedRefusal(job()), undefined);
  assert.equal(unattendedRefusal(job({ permissionMode: "acceptEdits" })), undefined);
  const refusal = unattendedRefusal(job({ permissionMode: "ask" })) ?? "";
  assert.match(refusal, /Accept edits/);
  assert.match(refusal, /nobody is there/);

  assert.notEqual(UNATTENDED_PERMISSION_MODE, "ask", "a new experiment must be offered a mode it can actually run in");
  const form = readFileSync(path.join(__dirname, "..", "..", "src", "research.tsx"), "utf8").split("\n");
  const picked = form.find((line) => line.includes("setMode] = useState"));
  assert.ok(picked, "the experiment form's mode state is not where the test looks for it");
  assert.match(picked, /UNATTENDED_PERMISSION_MODE/);
});

type TurnCall = { threadId: string; content: string; mode: PermissionMode; title: string; model: string };

function harness(seed: Record<string, unknown>) {
  const turns: TurnCall[] = [];
  const threads: string[] = [];
  const git: string[][] = [];
  const snapshots: ResearchJob[] = [];
  const answers = ["changed the optimizer", "72"];
  let current = asJob(seed);
  let commits = 0;
  let paused = "";
  const projectDir = mkdtempSync(path.join(tmpdir(), "research-loop-"));
  current = { ...current, projectDir };

  const deps: ResearchDeps = {
    async request(method, params) {
      if (method === "snapshot") {
        snapshots.push(current);
        return { researchJobs: [current] };
      }
      if (method === "createThread") {
        threads.push(params.title);
        return { id: `thread-${threads.length}` };
      }
      if (method === "setResearchJobStatus") paused = params.note ?? "";
      if (method === "recordResearchIteration") current = { ...current, status: "paused" };
      return {};
    },
    async turn(request) {
      turns.push(request as TurnCall);
      return { messages: [{ role: "assistant", content: answers[turns.length - 1] ?? "" }] };
    },
    stopTurn() {},
    async run() { return "val_bpb: 0.5"; },
    async runGit(_cwd, args) {
      git.push(args);
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return projectDir;
      if (args[0] === "rev-parse" && args[1] === "HEAD") return String(commits).padStart(12, "a");
      if (args[0] === "diff") return "train.py";
      if (args[0] === "commit") commits += 1;
      return "";
    },
    attachProject() {},
    async resolve(prompt) { return { content: prompt }; },
    usage() { return { inputTokens: 0, outputTokens: 0 }; },
    catalogFile: path.join(projectDir, "no-catalog.json"),
    changed() {},
  };
  configureResearch(deps);
  return {
    turns,
    threads,
    git,
    note: () => paused,
    snapshots,
    flipTo(mode: PermissionMode) { current = { ...current, permissionMode: mode }; },
    async drain(jobId: string) {
      startResearchJob(jobId);
      for (let tick = 0; tick < 4000 && researchJobIds().includes(jobId); tick += 1) await new Promise((done) => setTimeout(done, 1));
      stopResearchJob(jobId);
      rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

test("a job saved as Ask is refused by the loop before it opens a thread or touches the repository", async () => {
  const rig = harness({ id: "loop-ask", title: "ask job", permissionMode: "ask", status: "running", evalCommand: "true", metricName: "val_bpb" });
  await rig.drain("loop-ask");
  assert.match(rig.note(), /nobody is there/);
  assert.deepEqual(rig.threads, []);
  assert.deepEqual(rig.git, []);
  assert.deepEqual(rig.turns, []);
});

test("a running job switched to Ask pauses instead of deadlocking its next iteration", async () => {
  const rig = harness({ id: "loop-flip", title: "flip job", permissionMode: "acceptEdits", status: "running", evalCommand: "true", metricName: "val_bpb" });
  const started = rig.drain("loop-flip");
  for (let tick = 0; tick < 4000 && rig.snapshots.length < 1; tick += 1) await new Promise((done) => setTimeout(done, 1));
  rig.flipTo("ask");
  await started;
  assert.match(rig.note(), /nobody is there/);
  assert.equal(rig.threads.length, 1);
  assert.deepEqual(rig.turns, []);
});

test("the judge scores in the job's own mode, never one that waits for an answer", async () => {
  const rig = harness({ id: "loop-judge", title: "judge job", permissionMode: "full", metricKind: "judge", status: "running", evalCommand: "true", metricName: "quality", direction: "higher" });
  await rig.drain("loop-judge");
  assert.equal(rig.turns.length, 2);
  assert.match(rig.turns[1].title, /judge/);
  assert.equal(rig.turns[1].mode, "full");
  assert.notEqual(rig.turns[1].mode, "ask");
});

test("the experiment form starts a new job in a mode the runner will actually accept", () => {
  const form = readFileSync(path.join(__dirname, "..", "..", "src", "research.tsx"), "utf8");
  const picked = /const \[mode, setMode\] = useState<PermissionMode>\((.+)\);/.exec(form)?.[1];
  assert.equal(picked, "job?.permissionMode ?? UNATTENDED_PERMISSION_MODE");
  assert.equal(unattendedRefusal(job({ permissionMode: UNATTENDED_PERMISSION_MODE })), undefined);
});

test("an armed two-press delete is filled, not just relabelled", () => {
  const base = path.join(__dirname, "..", "..");
  assert.match(readFileSync(path.join(base, "src/index.css"), "utf8"), /button\[data-armed="true"\][^\n]*background: var\(--danger\)/);
  for (const [file, marker] of [["src/research.tsx", "research-danger"], ["src/App.tsx", "task-danger"], ["src/mobile.tsx", "reset-data"]] as const) {
    const line = readFileSync(path.join(base, file), "utf8").split("\n").find((row) => row.includes(`className="${marker}"`));
    assert.ok(line, `${file} no longer has a ${marker} button`);
    assert.match(line, /data-armed=\{/);
  }
});
