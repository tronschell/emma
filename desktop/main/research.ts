/* One autoresearch job, running. Core stores the job and its iterations and never
   runs one; everything an iteration is made of — an agent turn, a shell command,
   git — lives in this process, so the loop lives here next to them.

   The pure parts are exported on their own: reading the metric out of an eval's
   output, deciding whether a number is an improvement, and choosing the budget
   that stopped a run are the parts worth testing, and none of them need Electron. */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lastAssistantMessage } from "./agent-loop";
import { asPermissionMode, type PermissionMode } from "../shared/permissions";

/**
 * A run of the eval command gets far longer than a tool call's 120 seconds: it is
 * a training run or a test suite, and karpathy's take five minutes each.
 */
export const MAX_EVAL_MS = 15 * 60_000;
/** The row per iteration the user reads outside Emma, in the project itself. */
export const RESULTS_FILE = "results.tsv";
export const RESULTS_HEADER = "commit\tvalue\toutcome\tdescription\n";
/** Mirrors core's ceiling on an iteration note, so nothing is refused on the way in. */
const MAX_NOTE_CHARS = 280;
/** Iterations shown to the proposer. Enough to see the trend, short enough to read. */
const RECENT_ITERATIONS = 6;

export type ResearchIteration = {
  index: number;
  value?: number;
  outcome: string;
  note: string;
  commit: string;
};

export type ResearchJob = {
  id: string;
  title: string;
  projectDir: string;
  metricName: string;
  metricKind: string;
  metricPrompt: string;
  direction: string;
  evalCommand: string;
  prompt: string;
  proposerModel: string;
  permissionMode: PermissionMode;
  maxSeconds: number;
  maxTokens: number;
  maxMicroDollars: number;
  spentSeconds: number;
  spentTokens: number;
  spentMicroDollars: number;
  status: string;
  threadId: string;
  iterations: ResearchIteration[];
};

export type ResearchDeps = {
  /** One host request, exactly as `Host.request` does it. */
  request(method: string, params: Record<string, string>): Promise<unknown>;
  /** One full turn on a thread — the same run the composer drives. */
  turn(request: { threadId: string; content: string; mode: PermissionMode; title: string; model: string }): Promise<unknown>;
  /** Ends a turn in flight, so a pause does not wait out the model. */
  stopTurn(threadId: string): void;
  /** One shell command in a directory, with its own deadline. */
  run(cwd: string, command: string, timeoutMs?: number): Promise<string>;
  /** Grants the project folder and attaches it, so the turn's file and bash tools point at it. */
  attachProject(threadId: string, directory: string): void;
  /** Resolves the "/skill" and "@file" tokens of the job's prompt, as a scheduled run does. */
  resolve(prompt: string, threadId: string): Promise<string>;
  /** What the turn that just finished cost, as the agent list counted it. */
  usage(threadId: string): { inputTokens: number; outputTokens: number };
  /** The cached OpenRouter catalog, for the model's price. */
  catalogFile: string;
  /** Tells the windows something changed, so the graph moves as the run goes. */
  changed(): void;
};

let deps: ResearchDeps | undefined;

export function configureResearch(next: ResearchDeps) {
  deps = next;
}

/** The last `^<name>:` line the eval printed, as a number. Absent means the run crashed. */
export function readMetric(name: string, output: string): number | undefined {
  const key = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Anything after the number is the run's own commentary — a step count, units —
  // so the line is matched up to the number and no further.
  const matches = [...output.matchAll(new RegExp(`^[ \\t]*${key}:[ \\t]*(-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)`, "gm"))];
  const last = matches.at(-1);
  const value = last ? Number(last[1]) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

/** A judge answers in prose however it is asked not to, so the first number wins. */
export function parseScore(answer: string): number | undefined {
  const match = /-?\d+(?:\.\d+)?/.exec(answer.replace(/[,`*_]/g, ""));
  const value = match ? Number(match[0]) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

/** Whether this iteration is kept. The first number ever measured is always the best one. */
export function improved(value: number, best: number | undefined, direction: string): boolean {
  if (best === undefined) return true;
  return direction === "lower" ? value < best : value > best;
}

export function bestValue(iterations: ResearchIteration[], direction: string): number | undefined {
  let best: number | undefined;
  for (const iteration of iterations) {
    if (iteration.value !== undefined && improved(iteration.value, best, direction)) best = iteration.value;
  }
  return best;
}

/** The budget that has run out, worded so raising it is the obvious next move. */
export function exhaustedBudget(job: ResearchJob): string | undefined {
  if (job.maxSeconds > 0 && job.spentSeconds >= job.maxSeconds) {
    return `Paused: the time budget is used up — ${job.spentSeconds}s of ${job.maxSeconds}s. Raise it and press play to carry on.`;
  }
  if (job.maxTokens > 0 && job.spentTokens >= job.maxTokens) {
    return `Paused: the token budget is used up — ${job.spentTokens} of ${job.maxTokens} tokens. Raise it and press play to carry on.`;
  }
  if (job.maxMicroDollars > 0 && job.spentMicroDollars >= job.maxMicroDollars) {
    return `Paused: the spend budget is used up — ${dollars(job.spentMicroDollars)} of ${dollars(job.maxMicroDollars)}. Raise it and press play to carry on.`;
  }
  return undefined;
}

const dollars = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

/** One line of `results.tsv`: the karpathy convention, readable in any spreadsheet. */
export function resultsRow(commit: string, value: number | undefined, outcome: string, description: string): string {
  const cells = [
    commit || "-",
    value === undefined ? "-" : String(value),
    outcome,
    description.replace(/\s+/g, " ").trim().slice(0, 200) || "-",
  ];
  return `${cells.join("\t")}\n`;
}

/**
 * What the proposer is told. It carries where the run is up to and what has already
 * been tried, and it forbids running the eval itself: Emma runs it, so the number
 * can never be reported by the thing being measured.
 */
export function iterationPrompt(job: ResearchJob, index: number): string {
  const best = bestValue(job.iterations, job.direction);
  const recent = job.iterations.slice(-RECENT_ITERATIONS).map((iteration) =>
    `  ${iteration.index}  ${iteration.value === undefined ? "no value" : iteration.value}  ${iteration.outcome}  ${iteration.note || "(no note)"}`);
  return [
    `Iteration ${index} of the autoresearch job "${job.title}".`,
    "",
    `Metric: ${job.metricName}, where ${job.direction} is better. Best so far: ${best === undefined ? "nothing measured yet" : best}.`,
    `Emma measures it by running \`${job.evalCommand}\` after you stop. Do not run that command yourself, and do not commit anything.`,
    "",
    recent.length ? `What has been tried:\n${recent.join("\n")}` : "Nothing has been tried yet.",
    "",
    // The user's own words outrank the loop's boilerplate, so they come last and
    // are named as the brief: what to try, what to leave alone, what to read first.
    job.prompt.trim() ? `The brief for this experiment, from the person running it:\n${job.prompt.trim()}\n` : "",
    "Make exactly ONE change to the project — the single most promising thing you can think of that has not been tried. Then stop and answer with one short line naming what you changed. Emma commits it, measures it, and reverts it if it did not help.",
  ].join("\n");
}

/** Estimated spend. A rate the catalog does not carry yet reads as zero rather than blocking a run. */
export function estimateMicroDollars(tokens: { inputTokens: number; outputTokens: number }, rates: { input: number; output: number }): number {
  return Math.round((tokens.inputTokens * rates.input + tokens.outputTokens * rates.output) / 1_000_000);
}

/**
 * The model's price in micro-dollars per million tokens, off the cached catalog.
 * A price OpenRouter never published reads as zero: a job whose spend cannot be
 * priced still runs, it just cannot be stopped by the spend budget.
 */
export function modelRates(catalogFile: string, modelId: string): { input: number; output: number } {
  try {
    const stored = JSON.parse(readFileSync(catalogFile, "utf8")) as { models?: Record<string, unknown>[] };
    const model = stored.models?.find((candidate) => candidate.id === modelId);
    const rate = (name: string) => {
      const value = model?.[name];
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
    };
    return { input: rate("promptMicroUsdPerMtok"), output: rate("completionMicroUsdPerMtok") };
  } catch {
    return { input: 0, output: 0 };
  }
}

/** A job as the snapshot reports it. Numbers may arrive as strings, as host params do. */
export function asJob(raw: unknown): ResearchJob {
  const value = (raw ?? {}) as Record<string, unknown>;
  const text = (name: string) => (typeof value[name] === "string" ? value[name] : "");
  const count = (name: string) => {
    const parsed = Number(value[name] ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const iterations = Array.isArray(value.iterations) ? value.iterations : [];
  return {
    id: text("id"),
    title: text("title"),
    projectDir: text("projectDir"),
    metricName: text("metricName"),
    metricKind: text("metricKind") || "grep",
    metricPrompt: text("metricPrompt"),
    direction: text("direction") || "lower",
    evalCommand: text("evalCommand"),
    prompt: text("prompt"),
    proposerModel: text("proposerModel"),
    permissionMode: asPermissionMode(value.permissionMode),
    maxSeconds: count("maxSeconds"),
    maxTokens: count("maxTokens"),
    maxMicroDollars: count("maxMicroDollars"),
    spentSeconds: count("spentSeconds"),
    spentTokens: count("spentTokens"),
    spentMicroDollars: count("spentMicroDollars"),
    status: text("status"),
    threadId: text("threadId"),
    iterations: iterations.map((item) => {
      const iteration = (item ?? {}) as Record<string, unknown>;
      const measured = Number(iteration.value);
      return {
        index: Number(iteration.index ?? 0) || 0,
        value: iteration.value === null || iteration.value === undefined || !Number.isFinite(measured) ? undefined : measured,
        outcome: typeof iteration.outcome === "string" ? iteration.outcome : "",
        note: typeof iteration.note === "string" ? iteration.note : "",
        commit: typeof iteration.commit === "string" ? iteration.commit : "",
      };
    }),
  };
}

const runners = new Map<string, Runner>();

/** Every job with a loop running right now. */
export function researchJobIds(): string[] {
  return [...runners.keys()];
}

export function startResearchJob(jobId: string) {
  if (runners.has(jobId)) return;
  const runner = new Runner(jobId);
  runners.set(jobId, runner);
  void runner.loop().finally(() => {
    if (runners.get(jobId) === runner) runners.delete(jobId);
  });
}

export function stopResearchJob(jobId: string) {
  const runner = runners.get(jobId);
  if (!runner) return;
  runners.delete(jobId);
  runner.stop();
}

/**
 * Recovery. Nothing about a run lives only in memory, so a job still marked running
 * after a quit or a crash simply picks up at its next iteration; whatever the killed
 * iteration had written uncommitted is what a revert would have discarded anyway.
 */
export async function resumeResearchJobs() {
  for (const job of await researchJobs()) {
    if (job.status === "running") startResearchJob(job.id);
  }
}

export async function researchJobs(): Promise<ResearchJob[]> {
  const snapshot = await deps!.request("snapshot", {}) as { researchJobs?: unknown[] };
  return (snapshot.researchJobs ?? []).map(asJob);
}

class Runner {
  private stopped = false;
  private threadId = "";
  private judgeThreadId = "";

  constructor(private readonly jobId: string) {}

  stop() {
    this.stopped = true;
    // The flag alone only stops the loop between iterations; a turn in flight has
    // to be told, or a pause waits out however long the model wants to keep going.
    for (const thread of [this.threadId, this.judgeThreadId]) if (thread) deps!.stopTurn(thread);
  }

  async loop() {
    try {
      let job = await this.read();
      const refusal = await this.checkRepository(job);
      if (refusal) return await this.pause(refusal);
      this.threadId = job.threadId || await this.openThread(job);
      // The folder grant is what points the turn's file and bash tools at the
      // project; there is no per-turn path override, and inventing one would put
      // an agent somewhere the user never granted.
      deps!.attachProject(this.threadId, job.projectDir);
      // Every iteration measures the difference between HEAD and what it wrote, so
      // it has to start from a clean tree. Anything left over — an iteration killed
      // mid-turn, or the user's own edits — is committed rather than reset: it would
      // otherwise be measured as part of the next experiment, and discarding a
      // stranger's uncommitted work is not this loop's call to make.
      await deps!.run(job.projectDir, `git add -A && git commit -q -m ${quote(`${job.title} · carried over`)} || true`);
      while (!this.stopped) {
        job = await this.read();
        // Paused from the workspace, or finished by something else: the store is
        // the truth about whether this loop should still be going.
        if (job.status !== "running") return;
        const spent = exhaustedBudget(job);
        if (spent) return await this.pause(spent);
        await this.iterate(job);
      }
    } catch (error) {
      // Machinery breaking is not an experiment result: pausing says so and stops,
      // rather than spinning through iterations that all fail the same way.
      await this.pause(`Paused: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
    }
  }

  private async iterate(job: ResearchJob) {
    const startedAt = Date.now();
    const index = job.iterations.length + 1;
    const before = (await deps!.run(job.projectDir, "git rev-parse HEAD")).trim();
    // The proposer model is Emma's own selection, so a running job is also what the
    // app is pointed at. ponytail: per-turn models need a `sendMessage` parameter the
    // host does not have; add one and this line goes away.
    await deps!.request("selectOpenRouterModel", { modelId: job.proposerModel });
    const answer = lastAssistantMessage(await deps!.turn({
      threadId: this.threadId,
      // The brief is written in the composer's grammar but nobody is at the composer,
      // so the run resolves its own tokens: the named skill rides the turn and every
      // named file is read into it.
      content: await deps!.resolve(iterationPrompt(job, index), this.threadId),
      mode: job.permissionMode,
      title: job.title,
      model: job.proposerModel,
    })) ?? "";
    if (this.stopped) return;
    const usage = deps!.usage(this.threadId);
    const description = answer.split("\n").filter(Boolean).at(-1) ?? "";
    await deps!.run(job.projectDir, `git add -A && git commit -q -m ${quote(`${job.title} · iteration ${index}`)} || true`);
    const after = (await deps!.run(job.projectDir, "git rev-parse HEAD")).trim();
    const commit = after.slice(0, 12);

    let value: number | undefined;
    let note = description;
    if (after === before) {
      // Nothing was edited, so there is nothing to measure: an eval run costs the
      // user five minutes to confirm the number it already has.
      note = `No change: ${description || "the agent edited nothing."}`;
    } else {
      // No early exit past this point even when the job was paused mid-eval: the
      // number has already been paid for, so it is worth keeping or reverting on.
      const output = await deps!.run(job.projectDir, job.evalCommand, MAX_EVAL_MS);
      value = job.metricKind === "judge" ? await this.judge(job, output) : readMetric(job.metricName, output);
      if (value === undefined) note = `Crashed: ${job.metricName} never came out of the eval. ${description}`;
    }
    const best = bestValue(job.iterations, job.direction);
    const keep = value !== undefined && improved(value, best, job.direction);
    const outcome = value === undefined ? "crash" : keep ? "keep" : "discard";
    // Read before the revert and written after it: `results.tsv` is committed by the
    // next iteration's `git add -A`, so a reset would otherwise take the earlier rows with it.
    const rows = this.readResults(job.projectDir);
    if (!keep && after !== before) await deps!.run(job.projectDir, `git reset --hard ${quote(before)}`);
    this.writeResults(job.projectDir, rows + resultsRow(commit, value, outcome, note));

    const microDollars = estimateMicroDollars(usage, modelRates(deps!.catalogFile, job.proposerModel));
    await deps!.request("recordResearchIteration", {
      jobId: this.jobId,
      outcome,
      durationMilliseconds: String(Date.now() - startedAt),
      inputTokens: String(usage.inputTokens),
      outputTokens: String(usage.outputTokens),
      microDollars: String(microDollars),
      ...(value === undefined ? {} : { value: String(value) }),
      ...(note.trim() ? { note: note.trim().slice(0, MAX_NOTE_CHARS) } : {}),
      ...(commit ? { commit } : {}),
    });
    deps!.changed();
  }

  /** A model scoring the eval's output against the job's rubric, on a thread of its own. */
  private async judge(job: ResearchJob, output: string): Promise<number | undefined> {
    this.judgeThreadId ||= await this.openThread(job, " · judge");
    const answer = lastAssistantMessage(await deps!.turn({
      threadId: this.judgeThreadId,
      content: [
        `Score this output against the rubric. Answer with the number alone — no words, no units.`,
        "",
        `Rubric: ${job.metricPrompt || `a ${job.metricName} score, where ${job.direction} is better`}`,
        "",
        "Output:",
        output.slice(0, 32 * 1024),
      ].join("\n"),
      // No folder is attached to this thread and the mode changes nothing, so the
      // judge has the output in front of it and nothing else.
      mode: "plan",
      title: `${job.title} · judge`,
      model: job.proposerModel,
    })) ?? "";
    return parseScore(answer);
  }

  private async openThread(job: ResearchJob, suffix = ""): Promise<string> {
    const thread = await deps!.request("createThread", { title: `${job.title}${suffix}`.slice(0, 120) }) as { id?: string };
    if (!thread?.id) throw new Error("Emma could not open a thread for this job");
    // The job's own thread is recorded, so every iteration lands in one transcript
    // and the transcript is the log. The judge's is this process's business only.
    if (!suffix) await deps!.request("setResearchJobThread", { jobId: this.jobId, threadId: thread.id });
    return thread.id;
  }

  /** Refuses a project git cannot undo, in words the user can act on. */
  private async checkRepository(job: ResearchJob): Promise<string | undefined> {
    const top = (await deps!.run(job.projectDir, "git rev-parse --show-toplevel")).trim();
    if (!top.startsWith("/")) return `${job.projectDir} is not a git repository. Keeping and reverting an iteration is git, so run \`git init\` there first, commit what is already in it, and press play.`;
    const head = (await deps!.run(job.projectDir, "git rev-parse HEAD")).trim();
    if (!/^[0-9a-f]{7,40}$/.test(head)) return `${job.projectDir} has no commits yet, so there is nothing to revert a bad iteration to. Run \`git add -A && git commit -m "before autoresearch"\` there, then press play.`;
    return undefined;
  }

  private readResults(directory: string): string {
    try { return readFileSync(path.join(directory, RESULTS_FILE), "utf8"); }
    catch { return RESULTS_HEADER; }
  }

  private writeResults(directory: string, contents: string) {
    try { writeFileSync(path.join(directory, RESULTS_FILE), contents, "utf8"); }
    catch (error) { console.error("Emma: could not write results.tsv", error); }
  }

  private async read(): Promise<ResearchJob> {
    // Re-read every iteration rather than once: everything but the metric can be
    // edited while a job runs, and the spent totals are core's to add up.
    const job = (await researchJobs()).find((candidate) => candidate.id === this.jobId);
    if (!job) throw new Error("That autoresearch job is gone");
    return job;
  }

  private async pause(note: string) {
    await deps!.request("setResearchJobStatus", { jobId: this.jobId, status: "paused", note: note.slice(0, 512) });
    deps!.changed();
  }
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
