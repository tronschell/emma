import test from "node:test";
import assert from "node:assert/strict";
import { asJob, bestValue, estimateMicroDollars, exhaustedBudget, improved, iterationPrompt, parseScore, readMetric, resultsRow, RESULTS_HEADER } from "../main/research";

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
