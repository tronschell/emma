/* What Emma knows about a run that the harness does not.

   This used to be an agent loop of its own — ask the model, gate what it asked
   for, submit the results, repeat — running beside the one in `emma-cli`. Two
   loops meant every rule had to be written twice and the second copy drifted, so
   the loop is gone and the harness is the only one left.

   What stays is everything the harness has no idea about: the agent rail and its
   spans, the durable traces, the permission channel and Auto mode's verifier, and
   the four tools whose answers are this file's own records — `threads`,
   `read_trace`, `agents` and `advisor`. A harness turn is *adopted* here (see
   `adopt`), which is what keeps the rail live for a run this file no longer drives. */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { agentColor, collapseChanges, fromThread, MAX_LIVE_THREADS, type FileChange, type LiveAgent, type PermissionAsk, type SubagentRoute, type ThreadStep } from "../shared/agents";
import type { PermissionMode } from "../shared/permissions";
import { takeArm } from "./system-prompt";
import { decodeSpans, encodeSpans, renderTrace, type TraceSpan, type TraceStatus } from "../shared/trace";
import { MAX_TOOL_OUTPUT_BYTES, MAX_TRACES_READ, type AnyToolArgs, type LoopArgs } from "./tools";
import type { VerifierRequest, VerifierReview } from "./verifier";
import type { Advice } from "./advisor";

/** How long a permission dialog may sit unanswered before the call is treated as declined. */
const MAX_ASK_MS = 10 * 60 * 1000;
/** ponytail: ~4 characters a token, the same estimate the context inspector uses. */
const CHARS_PER_TOKEN = 4;
const LIVE_REFRESH_MS = 250;

/**
 * Tools `AgentRuntime` answers itself rather than handing to main's executor:
 * the traces they read are the ones it writes, and the threads and agents they
 * read, steer and start are the ones it runs.
 */
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
  /** What the composer's picker is on. Main knows the name; the host reports no model back. */
  model?: string;
  /** The thinking stop to ask that model for. Blank is its own default; unset lets main fill it in. */
  effort?: string;
  parentThreadId?: string;
  depth?: number;
  /**
   * Started from inside another turn, so it needs a harness process of its own.
   *
   * One process holds one session and takes one turn at a time, so a turn started
   * from a tool call queues behind the very turn that started it — which is why a
   * `threads spawn` with a prompt looked like it had hung until the parent stopped.
   */
  nested?: boolean;
  /** The model this run's subagents take, if the thread's inspector pinned one. */
  subagent?: SubagentRoute;
  /** Extra params for the first `sendMessage` only — screen context, an attached skill. */
  params?: Record<string, string>;
  /** The `subagent` call that spawned this run, so its spans nest under that call. */
  parentSpanId?: string;
  objective?: string;
  goalTurn?: boolean;
  continueRecovery?: boolean;
  bench?: boolean;
};

export type LoopDeps = {
  /** One host request. Rejects on a host error, exactly as `Host.request` does. */
  request(method: string, params: Record<string, string>): Promise<unknown>;
  /** Puts the question in front of the user. The reply comes back through `answer`. */
  ask(request: PermissionAsk): void;
  /** Every path an ask settles on: the user's answer, a stop, and the timeout alike. */
  answered(id: string, allowed: boolean): void;
  /** Auto mode's second model. Never rejects: a review it could not get back is a review without a verdict. */
  /** `threadId` is the run this call is on: a trial on the verifier's rules only reaches half the turns. */
  verify(request: VerifierRequest, threadId: string): Promise<VerifierReview>;
  /** The advisor's second model. Never rejects either: no advice is a turn that carries on unadvised. */
  advise(transcript: string): Promise<Advice>;
  /**
   * Runs one turn on the harness, through the same door every other surface takes.
   *
   * Required, not optional: it used to fall back to this file's own loop, and
   * with that loop gone there is nothing behind it. Every caller here is a
   * `threads` spawn or message, which starts a turn and does not wait for it.
   *
   * `owner` is the thread the spawn came out of, when there is one: a brand new
   * thread has no folder of its own yet, and it is meant to work where the
   * thread that started it works.
   */
  spawnTurn(turn: TurnRequest, owner?: string): Promise<unknown> | void;
  /** Called whenever the agent list changes, and when a run ends. */
  changed(): void;
  /** One tool call's live status, so the transcript shows the work while it happens. */
  step(step: ThreadStep): void;
};

// `tool` is read off the spans in `list()`, so a Run never carries its own copy.
type Run = Omit<LiveAgent, "tool"> & {
  /** What was asked of this run, which is the goal Auto mode's verifier judges a call against. */
  goal: string;
  /** The verdict on the call being gated right now, so a refusal can be quoted back to the model. */
  review?: VerifierReview;
  stopped: boolean;
  depth: number;
  changes: FileChange[];
  /** Call ids already counted, so a repeated status update is not a second call. */
  tools: Set<string>;
  /** This run's own spans, root first. Subagents keep theirs on their own Run. */
  spans: TraceSpan[];
  /** True when an external loop drives this run, so waiting on the model is timed from its deltas. */
  adopted: boolean;
  /** Set once the trace has been handed to the host, so a run flushes exactly once. */
  traced: boolean;
};

/**
 * Every agent alive in this process, keyed by thread. Subagents are ordinary Emma
 * threads with a parent, so their transcript, telemetry and tab come from the same
 * snapshot the root thread does — nothing here duplicates what the host stores.
 */
export class AgentRuntime {
  private readonly runs = new Map<string, Run>();
  private readonly asks = new Map<string, (allowed: boolean) => void>();
  private spawned = 0;
  private streamedAt = 0;
  /** Only to key one review's span and step apart from the next one's. */
  private verifications = 0;

  constructor(private readonly deps: LoopDeps) {}

  list(): LiveAgent[] {
    // Rebuilt field by field rather than by rest-spread: the private half of a Run
    // holds the stop flag and the change log, and neither belongs in the renderer.
    return [...this.runs.values()]
      .map((run): LiveAgent => ({
        threadId: run.threadId, parentThreadId: run.parentThreadId, title: run.title, color: run.color,
        status: run.status, mode: run.mode, model: run.model, activity: run.activity, prompt: run.prompt,
        // Derived, not stored: a call's span is already opened and closed around
        // the tool, so "a tool is in flight" is a read of the spans rather than a
        // second copy of the same fact that can drift out of step with them.
        tool: run.spans.some((span) => span.id.startsWith("call:") && span.status === "running"),
        startedAt: run.startedAt, endedAt: run.endedAt, steps: run.steps, toolCalls: run.toolCalls,
        inputTokens: run.inputTokens, outputTokens: run.outputTokens, generationMs: run.generationMs, effort: run.effort, error: run.error,
      }))
      .sort((left, right) => left.startedAt - right.startedAt);
  }

  get busy() {
    return [...this.runs.values()].some((run) => run.status === "running" || run.status === "waiting");
  }

  /**
   * Every live span, grouped by the thread whose turn they belong to.
   *
   * A subagent's spans travel with its parent's: the whole point of the tree is
   * that one turn reads as one waterfall, however many threads ran inside it.
   */
  spans(): Record<string, TraceSpan[]> {
    const trees: Record<string, TraceSpan[]> = {};
    for (const run of this.runs.values()) {
      // A traced run is on the thread now, and the inspector reads it from
      // there. Reporting it as live too drew the turn that just ended twice —
      // once as itself and once as "This turn" — and counted its minutes twice
      // in the timeline's total.
      if (run.traced) continue;
      trees[run.threadId] = this.subtree(run.threadId).flatMap((member) => member.spans);
    }
    return trees;
  }

  /**
   * Streamed assistant text, used for a live tokens-per-second before the turn lands.
   *
   * Returns false when the text is no longer this thread's answer, which is what
   * keeps a stopped run's abandoned request from carrying on writing into the
   * transcript for as long as the model keeps talking.
   */
  noteDelta(threadId: string, text: string): boolean {
    const run = this.runs.get(threadId);
    if (run?.stopped) return false;
    if (!run || run.status === "done") return true;
    run.outputTokens += Math.ceil(text.length / CHARS_PER_TOKEN);
    run.generationMs = Date.now() - run.startedAt;
    // An adopted run's requests are made by someone else's loop, so the only
    // evidence of one is the tokens coming back.
    // ponytail: the bar therefore starts at the first token, not at the request —
    // time to first token lands in the gap before it. Exact spans need the
    // harness to report request boundaries.
    if (run.adopted && !run.spans.some((span) => span.kind === "model" && span.endedAt === undefined)) {
      run.spans.push({ id: `model:${run.threadId}:${run.spans.length}`, parentId: run.spans[0].id, name: "model", kind: "model", startedAt: Date.now(), status: "running" });
      this.deps.changed();
    }
    // The same tokens, on the request that is streaming them: what a model span
    // costs the context is what it wrote, and the deltas are the only place both
    // loops agree on that. Counted here rather than in `requestSpan` so the
    // adopted path — where nothing here made the request — reports it too.
    const answering = run.spans.find((span) => span.kind === "model" && span.endedAt === undefined);
    if (answering) answering.tokens = (answering.tokens ?? 0) + Math.ceil(text.length / CHARS_PER_TOKEN);
    // The transcript has its own delta channel, but the agent list does not, so
    // every reading taken off it — the context ledger's tiles, the rate, the
    // agent rail — sat still for the whole of a turn and jumped when it landed.
    // Rate-limited rather than sent per token: this is the whole list plus every
    // live span, and a fast model streams hundreds of deltas a second.
    const now = Date.now();
    if (now - this.streamedAt >= LIVE_REFRESH_MS) {
      this.streamedAt = now;
      this.deps.changed();
    }
    return true;
  }

  /** Closes an adopted run's open model span: the model stopped talking and something else started. */
  private closeModelSpan(run: Run, at = Date.now()) {
    const span = run.spans.find((candidate) => candidate.kind === "model" && candidate.endedAt === undefined);
    if (!span) return;
    span.endedAt = Math.max(at, span.startedAt);
    span.status = "ok";
  }

  /**
   * The tools this class answers itself, run on behalf of a caller that has no
   * `Run` of its own.
   *
   * The harness owns its own loop, so its turns never reach `runTool`; without
   * this it would advertise `threads` and friends and then fail on the call,
   * which is worse than not offering them. `advisor` works too: a
   * harness turn is adopted, so its `Run` and the spans the advisor reads are
   * both here.
   */
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

  /**
   * Refuses a message aimed at a turn already in flight.
   *
   * Steering belongs to the harness — `session/steer` for a thread's own turn,
   * `session/steer_child` for a subagent's — and main routes both before they
   * reach here. What is left is a run this loop no longer holds a live harness
   * for, and a queue it would never drain is worse than a refusal.
   */
  steer(threadId: string, _text: string) {
    if (!this.runs.has(threadId)) throw new Error("That agent is no longer running.");
    throw new Error("Emma could not reach the turn that is running on this thread. Wait for it to finish, then send it again.");
  }

  /**
   * Re-points a running turn at the mode the picker is on now. Subagents move with
   * it: they were spawned under the parent's mode and inherit changes to it for the
   * same reason. A permission question already on screen stands — the user answers
   * the one they were asked; everything after it takes the new mode.
   */
  setMode(threadId: string, mode: PermissionMode) {
    for (const run of this.runs.values()) {
      if (run.threadId === threadId || run.parentThreadId === threadId) run.mode = mode;
    }
    this.deps.changed();
  }

  /**
   * Marks a run stopped. The harness is what actually ends it — main cancels the
   * session alongside this — and the flag is what stops the abandoned turn's
   * remaining text reaching the transcript, and what makes `finish` report the
   * run as stopped rather than as whatever the cancelled prompt returned.
   */
  stop(threadId: string) {
    const run = this.runs.get(threadId);
    if (!run) return;
    run.stopped = true;
    // Children die with their parent: nothing is left driving a thread nobody is reading.
    for (const child of this.runs.values()) if (child.parentThreadId === threadId) child.stopped = true;
    this.deps.changed();
  }

  stopAll() {
    for (const run of this.runs.values()) run.stopped = true;
    for (const resolve of this.asks.values()) resolve(false);
    this.asks.clear();
    this.deps.changed();
  }

  /** Resolves a pending permission ask. Unknown ids are ignored, not an error. */
  answer(id: string, allowed: boolean) {
    this.asks.get(id)?.(allowed);
    this.asks.delete(id);
  }

  /** Files this thread and its subagents rewrote, newest write per path. */
  changes(threadId: string): FileChange[] {
    const collected: FileChange[] = [];
    for (const run of this.runs.values()) {
      if (run.threadId === threadId || run.parentThreadId === threadId) collected.push(...run.changes);
    }
    return collapseChanges(collected.sort((left, right) => left.at - right.at));
  }

  /**
   * One file a run rewrote, for the review sheet. The `+145 −1` on the call's
   * own step is main's to report — it holds the before-and-after and the call
   * it belongs to, and this only ever knew which call was running because it
   * was making them.
   */
  noteChange(threadId: string, change: FileChange) {
    this.runs.get(threadId)?.changes.push(change);
  }

  /** Clears finished agents for a thread, so a new turn starts with a clean list. */
  forget(threadId: string) {
    for (const [id, run] of this.runs) {
      if ((id === threadId || run.parentThreadId === threadId) && run.status !== "running" && run.status !== "waiting") this.runs.delete(id);
    }
    this.deps.changed();
  }

  private open(turn: TurnRequest): Run {
    const depth = turn.depth ?? 0;
    if (this.runs.get(turn.threadId)?.status === "running") throw new Error("That thread already has a turn in flight.");
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
    // The run's own span, and the root of everything it does. A subagent's hangs
    // off the `subagent` call that asked for it rather than off its parent thread, so
    // the trace reads as one tree rather than two lists side by side.
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

  /** Closes the run's own span. Idempotent, because several paths end a run. */
  private closeRun(run: Run, status: TraceStatus, error?: string) {
    const span = run.spans[0];
    if (span.endedAt !== undefined) return;
    span.endedAt = run.endedAt ?? Date.now();
    span.status = status;
    span.output = error;
  }

  /** This run and everything it spawned, however deep. */
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

  /**
   * Hands this turn's whole span tree to the host, once, when the root run ends.
   *
   * Only at depth 0: a subagent's spans are already inside its parent's tree, and
   * writing them twice would put the same work in two threads. A trace that fails
   * to record is not worth failing a finished turn over, so the error is swallowed.
   */
  private flushTrace(run: Run) {
    if (run.depth !== 0 || run.traced) return;
    run.traced = true;
    // Closed on the way out, not in place: a subagent still working when its
    // parent's turn ended keeps running and keeps its live bar, but the copy on
    // the thread has to be finished. An open span in a stored trace is read
    // against the current clock every time the trace is drawn, so one of these
    // made the turn — and the thread's total above it — grow in real time
    // forever after the turn had ended.
    const at = Date.now();
    const spans = this.subtree(run.threadId)
      .flatMap((member) => member.spans)
      .map((span) => span.endedAt === undefined ? { ...span, endedAt: Math.max(at, span.startedAt) } : span);
    // Stored as spans rather than as the rendered outline: the inspector draws
    // this turn's waterfall again from it after a restart, and a model still
    // reads the outline because `readTrace` renders on the way out.
    // The arm rides the header, because the arm is a fact about the turn rather
    // than about any span in it — and it is what the Agent page compares a
    // trial's two halves by. A turn that ran while nothing was on trial has none.
    const arm = takeArm(run.threadId);
    const trace = encodeSpans(spans, { thread: run.threadId, model: run.model || "unknown", ...(arm ? { arm } : {}) });
    if (!trace) return;
    void this.deps.request("recordTrace", { threadId: run.threadId, trace })
      .catch((error: unknown) => console.error("Emma: could not record the turn's trace", error));
  }

  /**
   * Registers a run for a turn something else is driving — the coding harness
   * owns its own loop, so nothing here calls `run()` on that path and the agent
   * rail, the live rate and the tool count would otherwise stay empty.
   * `noteDelta`, `noteChange` and `steer` all key off this same record.
   */
  adopt(turn: TurnRequest): void {
    this.open(turn).adopted = true;
  }

  /**
   * The real token counts for an adopted run, replacing the estimate.
   *
   * An adopted run's numbers are inferred from the text coming back, and its
   * input side is never counted at all — nothing here made the request. The
   * harness reports both per model step, and every live reading of the window —
   * the context ledger, the `context` tool, the token budget that stops an
   * autoresearch job — is only as current as the last one of these.
   *
   * Assigned rather than summed: the harness already reports the turn's running
   * totals, and its input side is the last step's request rather than a sum,
   * because each step resends the whole conversation.
   */
  noteUsage(threadId: string, usage: { inputTokens: number; outputTokens: number }): void {
    const run = this.runs.get(threadId);
    if (!run) return;
    if (usage.inputTokens > 0) run.inputTokens = usage.inputTokens;
    if (usage.outputTokens > 0) run.outputTokens = usage.outputTokens;
    this.deps.changed();
  }

  /**
   * One tool call an external loop reported. Counted once per call id, because
   * the harness sends a `tool_call` and then a `tool_call_update` per status
   * change and every one of them arrives here.
   *
   * `step` is the whole record when the caller has it. Without it a span still
   * opens on first sight and closes with the run, which is enough to see that a
   * call happened but not what it did or whether it worked.
   */
  noteTool(threadId: string, toolCallId: string, activity: string, step?: ThreadStep): void {
    const run = this.runs.get(threadId);
    if (!run || run.status === "done") return;
    run.activity = activity;
    if (!run.tools.has(toolCallId)) {
      // The model finished asking and the work started, so the waiting ends here.
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
    // An update that omits a field keeps what the opening call said, exactly as
    // the harness client's own merge does.
    if (step?.title) span.name = step.title;
    if (step?.input) span.input = step.input;
    if (step?.output) {
      span.output = step.output;
      // A result is what a call puts in the window, so the harness's calls weigh
      // on the context axis the same as this loop's do.
      span.tokens = Math.ceil(step.output.length / CHARS_PER_TOKEN);
    }
    if (step?.status === "completed" || step?.status === "failed") {
      span.status = step.status === "failed" ? "failed" : "ok";
      span.endedAt = Math.max(step.at, span.startedAt);
    }
    this.deps.changed();
  }

  /**
   * Where a run spawned by this thread hangs in the trace: its root span. The
   * calls themselves are made by the harness's loop, which never tells this one
   * which of them is in flight, so a spawn nests under the thread rather than
   * under the `subagent` call that asked for it.
   */
  spanFor(threadId: string): string | undefined {
    return this.runs.get(threadId)?.spans[0]?.id;
  }

  /** Closes out an adopted run. An error message marks it failed instead of done. */
  finish(threadId: string, error?: string): void {
    const run = this.runs.get(threadId);
    if (!run) return;
    // A cancelled prompt comes back looking like an ordinary end, so what the
    // rail says about a stopped run has to come from the stop, not from here.
    run.status = run.stopped ? "stopped" : error ? "failed" : "done";
    run.activity = error ?? "finished";
    run.error = error;
    run.endedAt = Date.now();
    run.generationMs = Math.max(run.generationMs, run.endedAt - run.startedAt, 1);
    // The run's own span first: the sweep below closes every open span, and with
    // the root among them `closeRun` took its already-closed early return and
    // left the turn recorded as permanently "running", with no error on it.
    this.closeRun(run, error ? "failed" : "ok", error);
    // A call the harness never closed out ends with the run rather than hanging
    // open in the trace forever.
    for (const span of run.spans) if (span.endedAt === undefined && span.status === "running") span.endedAt = run.endedAt;
    this.flushTrace(run);
    this.deps.changed();
  }

  /** The stored traces of a thread's past turns, newest last, as the model reads them. */
  private async readTrace(turn: TurnRequest, thread: string | undefined, limit: number): Promise<string> {
    const result = await this.deps.request("readTrace", { threadId: thread ?? turn.threadId });
    const traces = Array.isArray(result) ? result : [];
    const recent = traces.slice(-Math.min(limit, MAX_TRACES_READ));
    if (!recent.length) return "That thread has no recorded traces. Emma stores one when a turn ends, so the turn you are in now is not in there yet.";
    return recent
      .map((entry) => {
        const text = String((entry as { text?: unknown }).text ?? "");
        const spans = decodeSpans(text);
        // A trace recorded before spans were stored is already the outline.
        const body = spans.length ? renderTrace(spans, Date.now()) : text;
        return `--- recorded ${(entry as { timestamp?: unknown }).timestamp ?? "unknown"}\n${body}`;
      })
      .join("\n\n");
  }

  /**
   * Emma's own threads as the model reads them: the whole library as an index
   * without an argument, one thread's transcript with it.
   *
   * Every kind is listed — root threads, sub threads and subagent transcripts —
   * because a subagent starts blind by design, and the thread it was spawned out
   * of is exactly the context it is missing.
   */
  private async readThread(thread: string | undefined, limit: number): Promise<string> {
    const entries = await this.library();
    if (!thread) {
      if (!entries.length) return "Emma has no threads yet.";
      return entries
        .map((item) => {
          const owned = item.parentThreadId ? ` under ${item.parentThreadId}` : "";
          const archived = item.archivedAt ? " · archived" : "";
          // What is happening in it right now, which the stored snapshot cannot
          // know: a thread with an agent in it is the one worth checking on.
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

  /**
   * Asks the advisor, having built its view of the turn.
   *
   * The tool takes no transcript argument on purpose — Anthropic's does not
   * either, because an executor that gets to choose what its reviewer sees will
   * leave out the part it is wrong about. So the view is assembled here from the
   * two things only the loop holds: the thread as the user would read it, and
   * this run's own spans, which are every tool call made so far this turn.
   */
  private async consultAdvisor(run: Run, turn: TurnRequest, question: string | undefined): Promise<string> {
    // Best effort: an advisor is worth asking about the work in front of it even
    // when the stored transcript cannot be read, and the spans alone still say
    // what this turn has done.
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

  /**
   * Emma's timelines, as the model works with them.
   *
   * The split this tool draws is the one the app is built on: a thread is a
   * conversation that keeps its history and outlives every run in it, an agent
   * is the loop doing a job inside one. So spawning leaves something behind for
   * the user whether or not an agent ever works in it, and `message` starts a
   * turn on a quiet thread rather than failing — there is always someone there
   * to talk to, even when nothing is running.
   */
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

  /**
   * Hands a turn to whoever owns turns in this process and walks away.
   *
   * Nothing awaits it: the thread it runs in is the user's conversation now, not
   * this one's, so a failure belongs in that thread's own transcript and its own
   * row in the agent list rather than coming back here as a tool error.
   */
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

  /**
   * Renames the thread the user can see. A subagent runs in a transcript that is
   * not in the sidebar, so it renames the thread it was spawned out of — the same
   * one hop up a spawn takes, for the same reason.
   */
  private async renameThread(turn: TurnRequest, title: string): Promise<string> {
    await this.deps.request("renameThread", { threadId: turn.parentThreadId ?? turn.threadId, title });
    return `This thread is now called "${title}". The sidebar already shows it, so do not announce it as a separate step.`;
  }

  /**
   * Puts one permission question to the user and waits for `answer`, or gives up
   * so a dialog that never arrived cannot hang the turn.
   *
   * In `auto` the verifier model is asked first, and a call it clears never
   * reaches the user at all. Anything else — it says no, it is not configured,
   * its endpoint is down, it will not answer in the format — falls through to the
   * dialog below carrying what it did say, because the failure of a second model
   * is not permission to skip the first question.
   *
   * Public because the coding harness gates its own tools and asks through here:
   * one channel, one timeout, one place a question can be silently lost, and one
   * place the verifier had to be added for both loops to get it.
   */
  async question(ask: Omit<PermissionAsk, "id">): Promise<boolean> {
    const run = this.runs.get(ask.threadId);
    if (run?.mode === "auto") {
      const review = await this.reviewed(run, ask);
      if (review.verdict?.allow) return true;
      const said = review.verdict ? `blocked this: ${review.verdict.reason || "no reason given"}` : `could not answer: ${review.error ?? "no verdict"}`;
      ask = { ...ask, detail: `${ask.detail}\n\n[auto agent] ${said}` };
    }
    const id = randomUUID();
    // The rail and the agent's own panel read `status` and `activity`, so a run
    // parked on a question said "running · thinking" while it waited — the whole
    // reason a subagent's dialog looked like a hang rather than a question.
    const held = run ? { status: run.status, activity: run.activity } : undefined;
    if (run) {
      run.status = "waiting";
      run.activity = `waiting for your approval · ${ask.summary}`;
      this.deps.changed();
    }
    return new Promise<boolean>((resolve) => {
      const settle = (allowed: boolean) => {
        if (!this.asks.delete(id)) return;
        clearTimeout(timer);
        this.deps.answered(id, allowed);
        if (run && held && run.status === "waiting") {
          run.status = held.status;
          run.activity = held.activity;
          this.deps.changed();
        }
        resolve(allowed);
      };
      const timer = setTimeout(() => settle(false), MAX_ASK_MS);
      this.asks.set(id, settle);
      this.deps.ask({ id, ...ask });
    });
  }

  /**
   * One verifier review, on the record: a span under the call it is about, and a
   * step of its own in the transcript.
   *
   * Both carry the whole prompt and the whole reply. An approval nobody can read
   * afterwards is a worse deal than the dialog it replaced, so what the small
   * model was told and what it said are exactly as visible as the call itself.
   */
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
      // The harness asks without the call in hand, so the run's own root is the
      // honest parent.
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

/** The ceiling is bytes, not characters, and the notice counts against it. */
export function bounded(value: string): string {
  if (Buffer.byteLength(value) <= MAX_TOOL_OUTPUT_BYTES) return value;
  const limit = MAX_TOOL_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE);
  let kept = value;
  while (Buffer.byteLength(kept) > limit) kept = kept.slice(0, Math.floor(kept.length * (limit / Buffer.byteLength(kept))));
  return `${kept}${TRUNCATION_NOTICE}`;
}

/** The answer a finished turn ended on, as the host reports the thread back. */
export function lastAssistantMessage(result: unknown): string | undefined {
  const messages = (result as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message?.role === "assistant" && typeof message.content === "string") return message.content;
  }
  return undefined;
}
