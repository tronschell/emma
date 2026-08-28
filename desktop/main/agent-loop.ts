
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { agentColor, collapseChanges, fromThread, MAX_LIVE_THREADS, type FileChange, type LiveAgent, type PermissionAsk, type SubagentRoute, type ThreadStep } from "../shared/agents";
import type { PermissionMode } from "../shared/permissions";
import { takeArm } from "./system-prompt";
import { decodeSpans, encodeSpans, renderTrace, type TraceSpan, type TraceStatus } from "../shared/trace";
import { MAX_TOOL_OUTPUT_BYTES, MAX_TRACES_READ, type AnyToolArgs, type LoopArgs } from "./tools";
import type { VerifierRequest, VerifierReview } from "./verifier";
import type { Advice } from "./advisor";

const MAX_ASK_MS = 10 * 60 * 1000;
const CHARS_PER_TOKEN = 4;
const LIVE_REFRESH_MS = 250;

export const OWN_TOOLS = new Set(["read_trace", "threads", "agents", "advisor"]);
const ownedHere = (args: AnyToolArgs): args is LoopArgs => OWN_TOOLS.has(args.name);

export const towardGoal = (turn: { objective?: string }, text: string): string =>
  turn.objective ? `The thread that sent this is pursuing an objective of its own, and this is part of it: ${turn.objective}\n\n${text}` : text;

const benchOwned = new Set<string>();
const benchParents = new Map<string, string>();
const benchHalted = new Set<string>();

export const benchReplay = new AsyncLocalStorage<true>();

export const benchThread = (threadId: string) => benchOwned.has(threadId);

export function ownBench(threadId: string) {
  benchOwned.add(threadId);
}

export function inheritBench(threadId: string, parentThreadId: string): boolean {
  if (!benchOwned.has(parentThreadId)) return false;
  benchOwned.add(threadId);
  benchParents.set(threadId, parentThreadId);
  if (!benchHalted.has(parentThreadId)) return false;
  benchHalted.add(threadId);
  return true;
}

export function haltBench(threadId: string): string[] {
  if (!benchOwned.has(threadId) || benchHalted.has(threadId)) return [];
  const under = (id: string) => {
    const seen = new Set<string>();
    for (let at = benchParents.get(id); at && !seen.has(at); at = benchParents.get(at)) {
      if (at === threadId) return true;
      seen.add(at);
    }
    return false;
  };
  const tree = [threadId, ...[...benchOwned].filter((id) => !benchHalted.has(id) && under(id))];
  for (const id of tree) benchHalted.add(id);
  return tree;
}

export function refuseBenchTurn(threadId: string) {
  if (benchHalted.has(threadId)) {
    throw new Error(`${threadId} belongs to a bench replay that has been stopped, so nothing starts a turn in it. Say that in your answer instead.`);
  }
  if (benchReplay.getStore() && !benchOwned.has(threadId)) {
    throw new Error(`${threadId} is the user's own thread, and this turn is a measured bench replay. A replay starts turns only in its own thread and in the threads it started itself, so it cannot start one there. Use threads spawn to start a thread of your own and send the work there.`);
  }
}

function startedBy(threads: readonly SnapshotThread[], sender: string, thread: string): boolean {
  const parents = new Map(threads.map((item) => [item.id, item.parentThreadId ?? ""]));
  const seen = new Set<string>();
  for (let at = parents.get(thread) ?? ""; at && !seen.has(at); at = parents.get(at) ?? "") {
    if (at === sender) return true;
    seen.add(at);
  }
  return false;
}

export type TurnRequest = {
  threadId: string;
  content: string;
  mode: PermissionMode;
  title: string;
  model?: string;
  effort?: string;
  parentThreadId?: string;
  depth?: number;
  nested?: boolean;
  subagent?: SubagentRoute;
  params?: Record<string, string>;
  parentSpanId?: string;
  objective?: string;
  goalTurn?: boolean;
  continueRecovery?: boolean;
  bench?: boolean;
};

export type LoopDeps = {
  request(method: string, params: Record<string, string>): Promise<unknown>;
  ask(request: PermissionAsk): void;
  answered(id: string, allowed: boolean): void;
  stopped?(threadId: string): void;
  verify(request: VerifierRequest, threadId: string): Promise<VerifierReview>;
  advise(transcript: string): Promise<Advice>;
  spawnTurn(turn: TurnRequest, owner?: string): Promise<unknown> | void;
  changed(): void;
  step(step: ThreadStep): void;
};

type Run = Omit<LiveAgent, "tool"> & {
  goal: string;
  review?: VerifierReview;
  stopped: boolean;
  depth: number;
  changes: FileChange[];
  tools: Set<string>;
  spans: TraceSpan[];
  adopted: boolean;
  traced: boolean;
};

export class AgentRuntime {
  private readonly runs = new Map<string, Run>();
  private readonly asks = new Map<string, { run: Run; settle: (allowed: boolean) => void }>();
  private spawned = 0;
  private streamedAt = 0;
  private verifications = 0;

  constructor(private readonly deps: LoopDeps) {}

  list(): LiveAgent[] {
    return [...this.runs.values()]
      .map((run): LiveAgent => ({
        threadId: run.threadId, parentThreadId: run.parentThreadId, title: run.title, color: run.color,
        status: run.status, mode: run.mode, model: run.model, activity: run.activity, prompt: run.prompt,
        tool: run.spans.some((span) => span.id.startsWith("call:") && span.status === "running"),
        startedAt: run.startedAt, endedAt: run.endedAt, steps: run.steps, toolCalls: run.toolCalls,
        inputTokens: run.inputTokens, outputTokens: run.outputTokens, generationMs: run.generationMs, effort: run.effort, error: run.error,
      }))
      .sort((left, right) => left.startedAt - right.startedAt);
  }

  get busy() {
    return [...this.runs.values()].some((run) => run.status === "running" || run.status === "waiting");
  }

  isLive(threadId: string): boolean {
    const run = this.runs.get(threadId);
    return !!run && !run.stopped && run.endedAt === undefined && (run.status === "running" || run.status === "waiting");
  }

  spans(): Record<string, TraceSpan[]> {
    const trees: Record<string, TraceSpan[]> = {};
    for (const run of this.runs.values()) {
      if (run.traced) continue;
      trees[run.threadId] = this.subtree(run.threadId).flatMap((member) => member.spans);
    }
    return trees;
  }

  noteDelta(threadId: string, text: string): boolean {
    const run = this.runs.get(threadId);
    if (run?.stopped) return false;
    if (!run || run.status === "done") return true;
    run.outputTokens += Math.ceil(text.length / CHARS_PER_TOKEN);
    run.generationMs = Date.now() - run.startedAt;
    if (run.adopted && !run.spans.some((span) => span.kind === "model" && span.endedAt === undefined)) {
      run.spans.push({ id: `model:${run.threadId}:${run.spans.length}`, parentId: run.spans[0].id, name: "model", kind: "model", startedAt: Date.now(), status: "running" });
      this.deps.changed();
    }
    const answering = run.spans.find((span) => span.kind === "model" && span.endedAt === undefined);
    if (answering) answering.tokens = (answering.tokens ?? 0) + Math.ceil(text.length / CHARS_PER_TOKEN);
    const now = Date.now();
    if (now - this.streamedAt >= LIVE_REFRESH_MS) {
      this.streamedAt = now;
      this.deps.changed();
    }
    return true;
  }

  private closeModelSpan(run: Run, at = Date.now()) {
    const span = run.spans.find((candidate) => candidate.kind === "model" && candidate.endedAt === undefined);
    if (!span) return;
    span.endedAt = Math.max(at, span.startedAt);
    span.status = "ok";
  }

  async runThreadTool(args: AnyToolArgs, turn: TurnRequest): Promise<string> {
    if (!ownedHere(args)) throw new Error(`${args.name} is not one of Emma's thread tools.`);
    return await this.runOwnTool(args, turn, this.runs.get(turn.threadId));
  }

  private async runOwnTool(args: LoopArgs, turn: TurnRequest, run: Run | undefined): Promise<string> {
    switch (args.name) {
      case "read_trace": return await this.readTrace(turn, args.thread, args.limit);
      case "threads": return await this.runThreadsTool(args, turn);
      case "agents": return await this.runAgentsTool(args, turn);
      case "advisor": {
        if (!run) throw new Error("The advisor reads this run's own transcript, which is not available here.");
        return await this.consultAdvisor(run, turn, args.question);
      }
    }
  }

  private async runAgentsTool(args: Extract<LoopArgs, { name: "agents" }>, turn: TurnRequest): Promise<string> {
    if (args.message !== undefined) this.steer(args.agent!, args.message);
    if (args.stop) {
      const sender = turn.parentThreadId ?? turn.threadId;
      if (turn.bench && args.agent !== sender && !startedBy(await this.library(), sender, args.agent!)) {
        throw new Error(`${args.agent} is the user's own thread, and this turn is a measured bench replay. A replay stops only itself and the threads it started, so it cannot stop that one. Leave it alone and say so in your answer.`);
      }
      this.stop(args.agent!);
      return `Stopped ${args.agent} and anything running under it.`;
    }
    const live = this.list();
    if (!live.length) return "Nothing is running. Emma clears finished agents when a new turn starts, so an empty list is normal between turns.";
    return live
      .map((agent) => {
        const under = agent.parentThreadId ? ` under ${agent.parentThreadId}` : "";
        const cost = `${agent.inputTokens}+${agent.outputTokens} tokens`;
        const why = agent.error ? ` · ${agent.error}` : "";
        return `${agent.threadId} · ${agent.status}${under} · ${agent.mode} · ${agent.model ?? "default"} · ${agent.toolCalls} tool calls · ${cost}
  ${agent.title} — ${agent.activity}${why}`;
      })
      .join("\n");
  }

  steer(threadId: string, _text: string) {
    if (!this.runs.has(threadId)) throw new Error("That agent is no longer running.");
    throw new Error("Emma could not reach the turn that is running on this thread. Wait for it to finish, then send it again.");
  }

  setMode(threadId: string, mode: PermissionMode) {
    for (const run of this.runs.values()) {
      if (run.threadId === threadId || run.parentThreadId === threadId) run.mode = mode;
    }
    this.deps.changed();
  }

  stop(threadId: string) {
    for (const run of this.subtree(threadId)) this.stopRun(run);
    this.deps.changed();
  }

  stopAll() {
    for (const run of this.runs.values()) this.stopRun(run);
    this.deps.changed();
  }

  private stopRun(run: Run) {
    if (run.stopped) return;
    run.stopped = true;
    this.cancelAsks(run.threadId);
    this.deps.stopped?.(run.threadId);
  }

  answer(id: string, allowed: boolean) {
    this.asks.get(id)?.settle(allowed);
  }

  private cancelAsks(threadId: string) {
    for (const ask of this.asks.values()) if (ask.run.threadId === threadId) ask.settle(false);
  }

  changes(threadId: string): FileChange[] {
    const collected: FileChange[] = [];
    for (const run of this.runs.values()) {
      if (run.threadId === threadId || run.parentThreadId === threadId) collected.push(...run.changes);
    }
    return collapseChanges(collected.sort((left, right) => left.at - right.at));
  }

  noteChange(threadId: string, change: FileChange) {
    this.runs.get(threadId)?.changes.push(change);
  }

  forget(threadId: string) {
    for (const [id, run] of this.runs) {
      if (id !== threadId && run.parentThreadId !== threadId) continue;
      this.cancelAsks(id);
      if (run.status !== "running" && run.status !== "waiting") this.runs.delete(id);
    }
    this.deps.changed();
  }

  private open(turn: TurnRequest): Run {
    const depth = turn.depth ?? 0;
    if (this.runs.get(turn.threadId)?.status === "running") throw new Error("That thread already has a turn in flight.");
    this.cancelAsks(turn.threadId);
    if (depth > 0) this.spawned += 1;
    const run: Run = {
      threadId: turn.threadId,
      parentThreadId: turn.parentThreadId,
      title: turn.title,
      color: agentColor(depth === 0 ? 0 : this.spawned),
      status: "running",
      mode: turn.mode,
      model: turn.model ?? "",
      activity: "thinking",
      prompt: turn.content,
      startedAt: Date.now(),
      steps: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      generationMs: 0,
      effort: turn.effort ?? "",
      goal: towardGoal(turn, turn.content),
      stopped: false,
      depth,
      changes: [],
      tools: new Set(),
      spans: [],
      adopted: false,
      traced: false,
    };
    run.spans.push({
      id: `agent:${run.threadId}`,
      parentId: turn.parentSpanId,
      name: turn.title || "Agent",
      kind: "agent",
      startedAt: run.startedAt,
      status: "running",
    });
    this.runs.set(turn.threadId, run);
    this.deps.changed();
    return run;
  }

  private closeRun(run: Run, status: TraceStatus, error?: string) {
    const span = run.spans[0];
    if (span.endedAt !== undefined) return;
    span.endedAt = run.endedAt ?? Date.now();
    span.status = status;
    span.output = error;
  }

  private subtree(threadId: string): Run[] {
    const found: Run[] = [];
    const seen = new Set<string>();
    const queue = [threadId];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const run = this.runs.get(id);
      if (run) found.push(run);
      for (const child of this.runs.values()) if (child.parentThreadId === id) queue.push(child.threadId);
    }
    return found;
  }

  private flushTrace(run: Run) {
    if (run.depth !== 0 || run.traced) return;
    run.traced = true;
    const at = Date.now();
    const spans = this.subtree(run.threadId)
      .flatMap((member) => member.spans)
      .map((span) => span.endedAt === undefined ? { ...span, endedAt: Math.max(at, span.startedAt) } : span);
    const arm = takeArm(run.threadId);
    const trace = encodeSpans(spans, { thread: run.threadId, model: run.model || "unknown", ...(arm ? { arm } : {}) });
    if (!trace) return;
    void this.deps.request("recordTrace", { threadId: run.threadId, trace })
      .catch((error: unknown) => console.error("Emma: could not record the turn's trace", error));
  }

  adopt(turn: TurnRequest): void {
    this.open(turn).adopted = true;
  }

  noteUsage(threadId: string, usage: { inputTokens: number; outputTokens: number }): void {
    const run = this.runs.get(threadId);
    if (!run) return;
    if (usage.inputTokens > 0) run.inputTokens = usage.inputTokens;
    if (usage.outputTokens > 0) run.outputTokens = usage.outputTokens;
    this.deps.changed();
  }

  noteTool(threadId: string, toolCallId: string, activity: string, step?: ThreadStep): void {
    const run = this.runs.get(threadId);
    if (!run || run.status === "done") return;
    run.activity = activity;
    if (!run.tools.has(toolCallId)) {
      this.closeModelSpan(run, step?.at ?? Date.now());
      run.tools.add(toolCallId);
      run.toolCalls += 1;
      run.steps += 1;
      run.spans.push({
        id: `call:${toolCallId}`,
        parentId: run.spans[0].id,
        name: step?.title || activity || "tool call",
        kind: step?.kind ?? "other",
        startedAt: step?.at ?? Date.now(),
        status: "running",
      });
    }
    const span = run.spans.find((candidate) => candidate.id === `call:${toolCallId}`);
    if (!span) return;
    if (step?.title) span.name = step.title;
    if (step?.input) span.input = step.input;
    if (step?.output) {
      span.output = step.output;
      span.tokens = Math.ceil(step.output.length / CHARS_PER_TOKEN);
    }
    if (step?.status === "completed" || step?.status === "failed") {
      span.status = step.status === "failed" ? "failed" : "ok";
      span.endedAt = Math.max(step.at, span.startedAt);
    }
    this.deps.changed();
  }

  spanFor(threadId: string): string | undefined {
    return this.runs.get(threadId)?.spans[0]?.id;
  }

  finish(threadId: string, error?: string): void {
    const run = this.runs.get(threadId);
    if (!run) return;
    run.status = run.stopped ? "stopped" : error ? "failed" : "done";
    run.activity = error ?? "finished";
    run.error = error;
    run.endedAt = Date.now();
    this.cancelAsks(threadId);
    run.generationMs = Math.max(run.generationMs, run.endedAt - run.startedAt, 1);
    this.closeRun(run, error ? "failed" : "ok", error);
    for (const span of run.spans) if (span.endedAt === undefined && span.status === "running") span.endedAt = run.endedAt;
    this.flushTrace(run);
    this.deps.changed();
  }

  private async readTrace(turn: TurnRequest, thread: string | undefined, limit: number): Promise<string> {
    const result = await this.deps.request("readTrace", { threadId: thread ?? turn.threadId });
    const traces = Array.isArray(result) ? result : [];
    const recent = traces.slice(-Math.min(limit, MAX_TRACES_READ));
    if (!recent.length) return "That thread has no recorded traces. Emma stores one when a turn ends, so the turn you are in now is not in there yet.";
    return recent
      .map((entry) => {
        const text = String((entry as { text?: unknown }).text ?? "");
        const spans = decodeSpans(text);
        const body = spans.length ? renderTrace(spans, Date.now()) : text;
        return `--- recorded ${(entry as { timestamp?: unknown }).timestamp ?? "unknown"}\n${body}`;
      })
      .join("\n\n");
  }

  private async readThread(thread: string | undefined, limit: number): Promise<string> {
    const entries = await this.library();
    if (!thread) {
      if (!entries.length) return "Emma has no threads yet.";
      return entries
        .map((item) => {
          const owned = item.parentThreadId ? ` under ${item.parentThreadId}` : "";
          const archived = item.archivedAt ? " · archived" : "";
          const run = this.runs.get(item.id);
          const working = run && (run.status === "running" || run.status === "waiting") ? ` · ${run.status}: ${run.activity}` : "";
          return `${item.id} · ${item.kind ?? "main"}${owned}${archived} · ${item.messages?.length ?? 0} messages · updated ${item.updatedAt}${working}\n  ${item.title}`;
        })
        .join("\n");
    }
    const found = this.findThread(await this.library(), thread);
    const messages = found.messages ?? [];
    const recent = messages.slice(-limit);
    const older = messages.length - recent.length;
    const head = `${found.title} · ${found.kind ?? "main"} · ${messages.length} messages${older ? `, the ${older} oldest not shown` : ""}`;
    if (!recent.length) return `${head}\nNothing has been said in it yet.`;
    return [head, ...recent.map((message) => `\n--- ${message.role} · ${message.timestamp}\n${message.content}`)].join("\n");
  }

  private async consultAdvisor(run: Run, turn: TurnRequest, question: string | undefined): Promise<string> {
    const history = await this.readThread(turn.threadId, 20).catch(() => "(this thread's earlier messages could not be read)");
    const transcript = [
      `The user asked, this turn: ${turn.content}`,
      question ? `\nThe agent is asking you specifically: ${question}` : "",
      `\n--- earlier in this thread\n${history}`,
      `\n--- what the agent has done so far this turn\n${renderTrace(run.spans, Date.now()) || "(nothing yet)"}`,
    ].filter(Boolean).join("\n");
    const advice = await this.deps.advise(transcript);
    if (advice.error) return advice.text;
    return `Advice from ${advice.model || "the advisor"}:\n\n${advice.text}`;
  }

  private async runThreadsTool(args: Extract<LoopArgs, { name: "threads" }>, turn: TurnRequest): Promise<string> {
    switch (args.action) {
      case "list": return await this.readThread(undefined, args.limit);
      case "read": return await this.readThread(args.thread, args.limit);
      case "rename": return await this.renameThread(turn, args.title!);
      case "spawn": return await this.spawnThread(turn, args.title!, args.prompt);
      case "message": return await this.messageThread(turn, args.thread!, args.prompt!);
    }
  }

  private async spawnThread(turn: TurnRequest, title: string, prompt?: string): Promise<string> {
    const owner = turn.parentThreadId ?? turn.threadId;
    const working = [...this.runs.values()].filter((run) => !run.parentThreadId && (run.status === "running" || run.status === "waiting")).length;
    if (prompt && working >= MAX_LIVE_THREADS) {
      return `Emma already has ${MAX_LIVE_THREADS} threads working. Wait for one to finish, or spawn this one without a prompt so the user can start it.`;
    }
    const created = await this.deps.request("createThread", { parentThreadId: owner, title });
    const threadId = (created as { id?: unknown }).id;
    if (typeof threadId !== "string") throw new Error("Emma returned an invalid thread");
    const mark = `[threads:${threadId}:${title}]`;
    if (!prompt) {
      return `Started the thread "${title}" (${threadId}), in this project and owned by this thread. ${mark}\n\nIt is empty and nothing is running in it, so tell the user it is there and what it is for.`;
    }
    this.start({ threadId, content: fromThread(owner, towardGoal(turn, prompt)), mode: turn.mode, model: turn.model, title, subagent: turn.subagent }, owner);
    return `Started the thread "${title}" (${threadId}) and put its own agent to work in it. ${mark}\n\n`
      + `It runs beside this turn and nothing comes back here. Use threads list to see how it is doing, threads read ${threadId} for what it has said, and threads message to send it something.`;
  }

  private async messageThread(turn: TurnRequest, thread: string, text: string): Promise<string> {
    const sender = turn.parentThreadId ?? turn.threadId;
    if (thread === sender) throw new Error("That is the thread you are in. Say it in your answer instead.");
    const library = await this.library();
    const found = this.findThread(library, thread);
    const run = this.runs.get(thread);
    if (run && (run.status === "running" || run.status === "waiting")) {
      this.steer(thread, text);
      return `Sent to "${found.title}" (${thread}). A turn was already running there, so this went into that turn rather than starting one; read it back with threads read ${thread}.`;
    }
    this.start({ threadId: thread, content: fromThread(sender, towardGoal(turn, text)), mode: turn.mode, model: turn.model, title: found.title }, sender);
    return `Sent to "${found.title}" (${thread}). Nothing was running there, so this starts a turn of its own; read it back with threads read ${thread}.`;
  }

  private start(turn: TurnRequest, owner?: string): void {
    void Promise.resolve(this.deps.spawnTurn({ ...turn, nested: true }, owner)).catch((error: unknown) => console.error("Emma: a thread's own turn failed", error));
  }

  private findThread(library: readonly SnapshotThread[], thread: string): SnapshotThread {
    const found = library.find((item) => item.id === thread);
    if (!found) throw new Error(`Emma has no thread with the ID ${thread}. Call threads with action list to see the ones it does have.`);
    return found;
  }

  private async library(): Promise<SnapshotThread[]> {
    const result = await this.deps.request("snapshot", {});
    const threads = (result as { threads?: unknown })?.threads;
    if (!Array.isArray(threads)) throw new Error("Emma returned an invalid library");
    return threads as SnapshotThread[];
  }

  private async renameThread(turn: TurnRequest, title: string): Promise<string> {
    await this.deps.request("renameThread", { threadId: turn.parentThreadId ?? turn.threadId, title });
    return `This thread is now called "${title}". The sidebar already shows it, so do not announce it as a separate step.`;
  }

  async question(ask: Omit<PermissionAsk, "id">, options: { humanOnly?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
    const run = this.runs.get(ask.threadId);
    if (!run) return false;
    const current = () => this.runs.get(ask.threadId) === run && !run.stopped && run.endedAt === undefined;
    const live = () => current() && !options.signal?.aborted;
    if (!live()) return false;
    const id = randomUUID();
    let held: { status: Run["status"]; activity: string } | undefined;
    const allowed = await new Promise<boolean>((resolve) => {
      const settle = (allowed: boolean) => {
        if (!this.asks.delete(id)) return;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        allowed = allowed && live();
        if (held) this.deps.answered(id, allowed);
        if (held && current() && run.status === "waiting") {
          run.status = held.status;
          run.activity = held.activity;
          this.deps.changed();
        }
        resolve(allowed);
      };
      const abort = () => settle(false);
      const timer = setTimeout(abort, MAX_ASK_MS);
      this.asks.set(id, { run, settle });
      options.signal?.addEventListener("abort", abort, { once: true });
      const show = () => {
        if (!this.asks.has(id)) return;
        if (!live()) { settle(false); return; }
        held = { status: run.status, activity: run.activity };
        run.status = "waiting";
        run.activity = `waiting for your approval · ${ask.summary}`;
        try {
          this.deps.changed();
          this.deps.ask({ id, ...ask });
        } catch {
          settle(false);
        }
      };
      if (run.mode === "auto" && !options.humanOnly) {
        void this.reviewed(run, ask).then((review) => {
          if (!this.asks.has(id)) return;
          if (!live()) { settle(false); return; }
          if (review.verdict?.allow) { settle(true); return; }
          const said = review.verdict ? `blocked this: ${review.verdict.reason || "no reason given"}` : `could not answer: ${review.error ?? "no verdict"}`;
          ask = { ...ask, detail: `${ask.detail}\n\n[auto agent] ${said}` };
          show();
        }).catch(() => settle(false));
      } else show();
    });
    return allowed && live();
  }

  private async reviewed(run: Run, ask: Omit<PermissionAsk, "id">): Promise<VerifierReview> {
    const request: VerifierRequest = {
      goal: run.goal,
      title: run.title,
      activity: run.activity,
      tool: ask.tool,
      summary: ask.summary,
      detail: ask.detail,
    };
    this.verifications += 1;
    const toolCallId = `verify:${run.threadId}:${this.verifications}`;
    const span: TraceSpan = {
      id: `call:${toolCallId}`,
      parentId: run.spans[0].id,
      name: "auto agent · reviewing",
      kind: "verifier",
      startedAt: Date.now(),
      status: "running",
      input: "",
    };
    run.spans.push(span);
    this.deps.changed();
    const review = await this.deps.verify(request, run.threadId);
    const title = review.verdict?.allow ? "auto agent approved" : review.verdict ? "auto agent blocked" : "auto agent could not answer";
    span.name = `${title} · ${ask.summary}`;
    span.input = review.prompt;
    span.output = review.error ? `${review.error}${review.reply ? `\n\n${review.reply}` : ""}` : review.reply;
    span.status = review.verdict?.allow ? "ok" : "failed";
    span.endedAt = Date.now();
    this.deps.step({
      threadId: ask.threadId,
      toolCallId,
      title,
      kind: "verifier",
      status: review.verdict?.allow ? "completed" : "failed",
      input: review.prompt,
      output: span.output,
      at: span.endedAt,
    });
    this.deps.changed();
    run.review = review;
    return review;
  }

}

type SnapshotThread = {
  id: string;
  title: string;
  kind?: string;
  parentThreadId?: string | null;
  archivedAt?: string | null;
  updatedAt?: string;
  messages?: { role: string; content: string; timestamp: string }[];
};

const TRUNCATION_NOTICE = "\n[truncated]";

export function bounded(value: string): string {
  if (Buffer.byteLength(value) <= MAX_TOOL_OUTPUT_BYTES) return value;
  const limit = MAX_TOOL_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE);
  let kept = value;
  while (Buffer.byteLength(kept) > limit) kept = kept.slice(0, Math.floor(kept.length * (limit / Buffer.byteLength(kept))));
  return `${kept}${TRUNCATION_NOTICE}`;
}

export function lastAssistantMessage(result: unknown): string | undefined {
  const messages = (result as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message?.role === "assistant" && typeof message.content === "string") return message.content;
  }
  return undefined;
}
