import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lastAssistantMessage } from "./agent-loop";
import { asPermissionMode, type PermissionMode } from "../shared/permissions";

export const MAX_EVAL_MS = 15 * 60_000;
export const RESULTS_FILE = "results.tsv";
export const RESULTS_HEADER = "commit\tvalue\toutcome\tdescription\n";
const MAX_NOTE_CHARS = 280;
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
  request(method: string, params: Record<string, string>): Promise<unknown>;
  turn(request: { threadId: string; content: string; mode: PermissionMode; title: string; model: string; params?: Record<string, string> }): Promise<unknown>;
  stopTurn(threadId: string): void;
  run(cwd: string, command: string, timeoutMs?: number): Promise<string>;
  runGit(cwd: string, args: string[], timeoutMs?: number): Promise<string>;
  attachProject(threadId: string, directory: string): void;
  resolve(prompt: string): Promise<{ content: string; skillContext?: string }>;
  usage(threadId: string): { inputTokens: number; outputTokens: number };
  catalogFile: string;
  changed(): void;
};

let deps: ResearchDeps | undefined;

async function commitGit(cwd: string, args: string[]): Promise<string> {
  const staged = (await deps!.runGit(cwd, ["diff", "--cached", "--name-only"])).trim();
  return staged ? deps!.runGit(cwd, args) : "";
}

export function configureResearch(next: ResearchDeps) {
  deps = next;
}

export function readMetric(name: string, output: string): number | undefined {
  const key = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...output.matchAll(new RegExp(`^[ \\t]*${key}:[ \\t]*(-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)`, "gm"))];
  const last = matches.at(-1);
  const value = last ? Number(last[1]) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

export function parseScore(answer: string): number | undefined {
  const match = /-?\d+(?:\.\d+)?/.exec(answer.replace(/[,`*_]/g, ""));
  const value = match ? Number(match[0]) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

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

export function unattendedRefusal(job: ResearchJob): string | undefined {
  if (job.permissionMode !== "ask") return undefined;
  return "This experiment runs as Ask, so every edit and command an iteration makes waits for an answer that nobody is there to give, and times out as a refusal after 10 minutes. Set it to Accept edits — where the agent's one change goes through and commands still ask — or to Full access, then press play.";
}

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

export function resultsRow(commit: string, value: number | undefined, outcome: string, description: string): string {
  const cells = [
    commit || "-",
    value === undefined ? "-" : String(value),
    outcome,
    description.replace(/\s+/g, " ").trim().slice(0, 200) || "-",
  ];
  return `${cells.join("\t")}\n`;
}

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
    job.prompt.trim() ? `The brief for this experiment, from the person running it:\n${job.prompt.trim()}\n` : "",
    "Make exactly ONE change to the project — the single most promising thing you can think of that has not been tried. Then stop and answer with one short line naming what you changed. Emma commits it, measures it, and reverts it if it did not help.",
  ].join("\n");
}

export function estimateMicroDollars(tokens: { inputTokens: number; outputTokens: number }, rates: { input: number; output: number }): number {
  return Math.round((tokens.inputTokens * rates.input + tokens.outputTokens * rates.output) / 1_000_000);
}

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
    for (const thread of [this.threadId, this.judgeThreadId]) if (thread) deps!.stopTurn(thread);
  }

  async loop() {
    try {
      let job = await this.read();
      const refusal = unattendedRefusal(job) ?? await this.checkRepository(job);
      if (refusal) return await this.pause(refusal);
      this.threadId = job.threadId || await this.openThread(job);
      deps!.attachProject(this.threadId, job.projectDir);
      await deps!.runGit(job.projectDir, ["add", "-A"]);
      await commitGit(job.projectDir, ["commit", "-q", "-m", `${job.title} · carried over`]);
      while (!this.stopped) {
        job = await this.read();
        if (job.status !== "running") return;
        const blocked = unattendedRefusal(job) ?? exhaustedBudget(job);
        if (blocked) return await this.pause(blocked);
        await this.iterate(job);
      }
    } catch (error) {
      await this.pause(`Paused: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
    }
  }

  private async iterate(job: ResearchJob) {
    const startedAt = Date.now();
    const index = job.iterations.length + 1;
    const before = (await deps!.runGit(job.projectDir, ["rev-parse", "HEAD"])).trim();
    const { content, skillContext } = await deps!.resolve(iterationPrompt(job, index));
    const answer = lastAssistantMessage(await deps!.turn({
      threadId: this.threadId,
      content,
      mode: job.permissionMode,
      title: job.title,
      model: job.proposerModel,
      ...(skillContext ? { params: { skillContext } } : {}),
    })) ?? "";
    if (this.stopped) return;
    const usage = deps!.usage(this.threadId);
    const description = answer.split("\n").filter(Boolean).at(-1) ?? "";
    await deps!.runGit(job.projectDir, ["add", "-A"]);
    await commitGit(job.projectDir, ["commit", "-q", "-m", `${job.title} · iteration ${index}`]);
    const after = (await deps!.runGit(job.projectDir, ["rev-parse", "HEAD"])).trim();
    const commit = after.slice(0, 12);

    let value: number | undefined;
    let note = description;
    if (after === before) {
      note = `No change: ${description || "the agent edited nothing."}`;
    } else {
      const output = await deps!.run(job.projectDir, job.evalCommand, MAX_EVAL_MS);
      value = job.metricKind === "judge" ? await this.judge(job, output) : readMetric(job.metricName, output);
      if (value === undefined) note = `Crashed: ${job.metricName} never came out of the eval. ${description}`;
    }
    const best = bestValue(job.iterations, job.direction);
    const keep = value !== undefined && improved(value, best, job.direction);
    const outcome = value === undefined ? "crash" : keep ? "keep" : "discard";
    const rows = this.readResults(job.projectDir);
    if (!keep && after !== before) await deps!.runGit(job.projectDir, ["reset", "--hard", before]);
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
      mode: job.permissionMode,
      title: `${job.title} · judge`,
      model: job.proposerModel,
    })) ?? "";
    return parseScore(answer);
  }

  private async openThread(job: ResearchJob, suffix = ""): Promise<string> {
    const thread = await deps!.request("createThread", { title: `${job.title}${suffix}`.slice(0, 120) }) as { id?: string };
    if (!thread?.id) throw new Error("Emma could not open a thread for this job");
    if (!suffix) await deps!.request("setResearchJobThread", { jobId: this.jobId, threadId: thread.id });
    return thread.id;
  }

  private async checkRepository(job: ResearchJob): Promise<string | undefined> {
    const top = (await deps!.runGit(job.projectDir, ["rev-parse", "--show-toplevel"])).trim();
    if (!path.isAbsolute(top)) return `${job.projectDir} is not a git repository. Keeping and reverting an iteration is git, so run \`git init\` there first, commit what is already in it, and press play.`;
    const head = (await deps!.runGit(job.projectDir, ["rev-parse", "HEAD"])).trim();
    if (!/^[0-9a-f]{7,40}$/i.test(head)) return `${job.projectDir} has no commits yet, so there is nothing to revert a bad iteration to. Run \`git add -A && git commit -m "before autoresearch"\` there, then press play.`;
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
    const job = (await researchJobs()).find((candidate) => candidate.id === this.jobId);
    if (!job) throw new Error("That autoresearch job is gone");
    return job;
  }

  private async pause(note: string) {
    await deps!.request("setResearchJobStatus", { jobId: this.jobId, status: "paused", note: note.slice(0, 512) });
    deps!.changed();
  }
}
