/* The one agent loop. Every input surface — the composer, Quick Ask, a quick
   action, a page chat, a scheduled job, a subagent — runs a turn through here, so
   there is exactly one place that decides how many steps a turn gets, what asks
   permission, and what the agent list is showing.
   Execution of a tool call itself stays in main.ts, next to the runtimes that own
   the filesystem, the pointer and the sidecar; this file only decides whether and
   when it happens. */

import { randomUUID } from "node:crypto";
import { agentColor, collapseChanges, editStat, fromThread, MAX_AGENT_DEPTH, MAX_LIVE_SUBAGENTS, MAX_LIVE_THREADS, type FileChange, type LiveAgent, type PermissionAsk, type SubagentRoute, type ThreadStep } from "../shared/agents";
import { isBareGrep, toolGate, type PermissionMode } from "../shared/permissions";
import { takeArm, withSystemPrompt } from "./system-prompt";
import { decodeSpans, encodeSpans, renderTrace, type TraceSpan, type TraceStatus } from "../shared/trace";
import { describeToolCall, parseToolArgs, toolDefinitions, MAX_TOOL_OUTPUT_BYTES, MAX_TRACES_READ, type AnyToolArgs, type LoopArgs, type ToolArgs, type ToolAvailability } from "./tools";
import type { VerifierRequest, VerifierReview } from "./verifier";
import type { Advice } from "./advisor";
import { MEMORY_PROTOCOL } from "./memory";
import { PLANNING_PROTOCOL } from "./plans";

/** Model steps in one turn. The sidecar refuses past its own ceiling too. */
export const MAX_TURN_STEPS = 120;
/** Wall clock for one turn, subagents included. Long enough to build something, short enough to notice. */
export const MAX_TURN_MS = 30 * 60 * 1000;
const MAX_CALLS_PER_STEP = 8;
/** How long a permission dialog may sit unanswered before the call is treated as declined. */
const MAX_ASK_MS = 10 * 60 * 1000;
/** ponytail: ~4 characters a token, the same estimate the context inspector uses. */
const CHARS_PER_TOKEN = 4;

/**
 * Tools `AgentRuntime` answers itself rather than handing to main's executor:
 * the traces they read are the ones it writes, and the threads and agents they
 * read, steer and start are the ones it runs.
 */
export const OWN_TOOLS = new Set(["read_trace", "threads", "agents", "advisor"]);
const ownedHere = (args: AnyToolArgs): args is LoopArgs => OWN_TOOLS.has(args.name);

/** What a stopped run's abandoned request rejects with, so the turn ends as stopped rather than failed. */
class Stopped extends Error {}
const STOP_NOTE = "You stopped this run.";

export type TurnRequest = {
  threadId: string;
  content: string;
  mode: PermissionMode;
  title: string;
  /** What the composer's picker is on. Main knows the name; the host reports no model back. */
  model?: string;
  parentThreadId?: string;
  depth?: number;
  /** The model this run's subagents take, if the thread's inspector pinned one. */
  subagent?: SubagentRoute;
  /** Extra params for the first `sendMessage` only — screen context, an attached skill. */
  params?: Record<string, string>;
  /** The `task` call that spawned this run, so its spans nest under that call. */
  parentSpanId?: string;
};

export type LoopDeps = {
  /** One host request. Rejects on a host error, exactly as `Host.request` does. */
  request(method: string, params: Record<string, string>): Promise<unknown>;
  /** Runs one validated call. Throwing is fine: the message goes back to the model. */
  execute(args: ToolArgs, turn: TurnRequest): Promise<string>;
  /** What is connected right now for this thread. */
  available(threadId: string, depth: number): ToolAvailability;
  /** Puts the question in front of the user. The reply comes back through `answer`. */
  ask(request: PermissionAsk): void;
  /** Auto mode's second model. Never rejects: a review it could not get back is a review without a verdict. */
  /** `threadId` is the run this call is on: a trial on the verifier's rules only reaches half the turns. */
  verify(request: VerifierRequest, threadId: string): Promise<VerifierReview>;
  /** The advisor's second model. Never rejects either: no advice is a turn that carries on unadvised. */
  advise(transcript: string): Promise<Advice>;
  /** Tool names switched off in Settings → Tools, read per call so a change lands on the next one. */
  disabledTools(): readonly string[];
  /** A JPEG data URL of the screen, attached only while the computer tool is advertised. */
  screenshot(): Promise<string | undefined>;
  /**
   * Starts a turn on another thread and does not wait for it — how a `threads`
   * spawn puts an agent to work beside this one. Optional because the fallback
   * is this loop's own `run`; main passes the door every other surface uses, so
   * a spawned thread runs on the harness whenever the harness is what Emma is
   * running, and carries its project's standing instructions either way.
   *
   * `owner` is the thread the spawn came out of, when there is one: a brand new
   * thread has no folder of its own yet, and it is meant to work where the
   * thread that started it works.
   */
  spawnTurn?(turn: TurnRequest, owner?: string): Promise<unknown> | void;
  /** Called whenever the agent list changes, and when a run ends. */
  changed(): void;
  /** One tool call's live status, so the transcript shows the work while it happens. */
  step(step: ThreadStep): void;
};

type Run = LiveAgent & {
  /** What was asked of this run, which is the goal Auto mode's verifier judges a call against. */
  goal: string;
  /** The verdict on the call being gated right now, so a refusal can be quoted back to the model. */
  review?: VerifierReview;
  /** Text the user typed at this agent while it was working, delivered with the next results. */
  steering: string[];
  stopped: boolean;
  /** Rejects the moment this run is stopped, so a request in flight is abandoned rather than waited out. */
  halt: Promise<never>;
  halted: (reason: Stopped) => void;
  depth: number;
  changes: FileChange[];
  /** What each call wrote, by call id, so its step can carry the `+145 −1`. */
  edits: Map<string, ThreadStep["edit"]>;
  /** Call ids already counted, so a repeated status update is not a second call. */
  tools: Set<string>;
  /** This run's own spans, root first. Subagents keep theirs on their own Run. */
  spans: TraceSpan[];
  /** True when an external loop drives this run, so waiting on the model is timed from its deltas. */
  adopted: boolean;
  /** The call being performed right now, so a `task` it spawns can nest under it. */
  activeSpan?: string;
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
  /** Only to key one review's span and step apart from the next one's. */
  private verifications = 0;

  constructor(private readonly deps: LoopDeps) {}

  list(): LiveAgent[] {
    // Rebuilt field by field rather than by rest-spread: the private half of a Run
    // holds the stop flag and the change log, and neither belongs in the renderer.
    return [...this.runs.values()]
      .map((run): LiveAgent => ({
        threadId: run.threadId, parentThreadId: run.parentThreadId, title: run.title, color: run.color,
        status: run.status, mode: run.mode, model: run.model, activity: run.activity,
        startedAt: run.startedAt, endedAt: run.endedAt, steps: run.steps, toolCalls: run.toolCalls,
        inputTokens: run.inputTokens, outputTokens: run.outputTokens, generationMs: run.generationMs, error: run.error,
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
      if (run.depth !== 0 || run.traced) continue;
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
   * One request to the model, timed. This is where a turn's wall clock mostly
   * goes, so without these spans a waterfall shows a few milliseconds of tools
   * inside a thirty-second bar and explains none of it.
   */
  private async requestSpan(run: Run, name: string, method: string, params: Record<string, string>): Promise<unknown> {
    const span: TraceSpan = {
      id: `model:${run.threadId}:${run.spans.length}`,
      parentId: run.spans[0].id,
      name,
      kind: "model",
      startedAt: Date.now(),
      status: "running",
      // What this request carried, which is what the span is for: a slow step is
      // only diagnosable next to what was sent. Screen captures and tool schemas
      // are left out — they are megabytes, and neither is what changed.
      input: params.content ?? params.results,
    };
    run.spans.push(span);
    this.deps.changed();
    try {
      // Raced against the stop rather than simply awaited. Every layer under this
      // one is serial and takes no cancellation, so the request cannot be called
      // back — it can only be walked away from, and its rejection is pre-handled
      // because nothing is left to await it once the race is over.
      // ponytail: the provider bills for the rest of that answer, and the host
      // still writes it to the thread. Truly cancelling it needs a cancel path
      // through the Rust host and the Zig sidecar, which are both one-at-a-time.
      const pending = this.deps.request(method, params);
      pending.catch(() => undefined);
      const result = await Promise.race([pending, run.halt]);
      // Only for the label: an unreadable turn is the caller's error to raise.
      const calls = ((): { name: string }[] => { try { return toolCalls(result); } catch { return []; } })();
      span.status = "ok";
      span.output = calls.length ? `asked for ${calls.map((call) => call.name).join(", ")}` : "answered";
      return result;
    } catch (error) {
      span.status = "failed";
      span.output = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      span.endedAt = Date.now();
      // The prompt this request carried, on top of the answer the deltas already
      // added. Tool results are deliberately not counted here: they are already
      // on the call spans that produced them, and the context axis lays every
      // span end to end, so counting them twice would double the turn's growth.
      if (params.content) span.tokens = (span.tokens ?? 0) + Math.ceil(params.content.length / CHARS_PER_TOKEN);
      this.deps.changed();
    }
  }

  /**
   * The tools this class answers itself, run on behalf of a caller that has no
   * `Run` of its own.
   *
   * The harness owns its own loop, so its turns never reach `runTool`; without
   * this its MCP bridge would advertise `threads` and friends and then fail
   * on the call, which is worse than not offering them. `advisor` works too: a
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
      case "agents": return this.runAgentsTool(args, turn.mode, turn.parentThreadId ?? turn.threadId);
      case "advisor": {
        if (!run) throw new Error("The advisor reads this run's own transcript, which is not available here.");
        return await this.consultAdvisor(run, turn, args.question);
      }
    }
  }

  /** The live agent rail as the model reads it: what is running, and the two levers on it. */
  private runAgentsTool(args: Extract<LoopArgs, { name: "agents" }>, mode: PermissionMode, sender: string): string {
    // The gate table is per tool, and this one both reads and acts. Listing is a
    // read and belongs in plan mode; steering and stopping are not, so they are
    // refused here rather than by hiding the whole tool.
    if (mode === "plan" && (args.message !== undefined || args.stop)) {
      throw new Error("Plan mode does not steer or stop a running agent. Read the list and say what should change.");
    }
    if (args.message !== undefined) { this.steer(args.agent!, args.message, sender); return `Queued for ${args.agent}. It arrives with that agent's next batch of tool results.`; }
    if (args.stop) { this.stop(args.agent!); return `Stopped ${args.agent} and anything running under it.`; }
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
   * Queues a message for a running agent; it arrives with the next batch of tool
   * results. `from` is the thread that sent it, when it was a thread and not the
   * user — the queue holds the finished line so there is one place that decides
   * who a mid-run message is attributed to.
   */
  steer(threadId: string, text: string, from?: string) {
    const run = this.runs.get(threadId);
    if (!run) throw new Error("That agent is no longer running.");
    // An adopted run belongs to the coding harness, and the queue below is drained
    // by this loop alone: a message left on one is taken and never delivered. The
    // harness steers its own subagents — that path is handled before this one.
    if (run.adopted) throw new Error("That thread is running on the coding harness, which takes nothing mid-turn. Wait for it to finish, then send it again.");
    if (run.steering.length >= 8) throw new Error("That agent already has messages waiting.");
    run.steering.push(from ? `Thread ${from} says, while you work: ${text}` : `The user says, while you work: ${text}`);
    run.activity = "steering queued";
    this.deps.changed();
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

  stop(threadId: string) {
    const run = this.runs.get(threadId);
    if (!run) return;
    this.halt(run);
    // Children die with their parent: nothing is left driving a thread nobody is reading.
    for (const child of this.runs.values()) if (child.parentThreadId === threadId) this.halt(child);
    this.deps.changed();
  }

  stopAll() {
    for (const run of this.runs.values()) this.halt(run);
    for (const resolve of this.asks.values()) resolve(false);
    this.asks.clear();
    this.deps.changed();
  }

  /**
   * Sets the flag and abandons whatever the run is waiting on.
   *
   * The flag alone only landed at the top of the next step, so a stop pressed
   * mid-answer sat there while the model finished talking — which is not what the
   * button says it does. Rejecting `halt` is what ends the turn where it stands.
   */
  private halt(run: Run) {
    run.stopped = true;
    // Idempotent on purpose rather than guarded on the flag: `close` sets the flag
    // before its own wrap-up request, and a stop pressed during that one still has
    // to reach it. Rejecting a settled promise is a no-op.
    run.halted(new Stopped(STOP_NOTE));
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

  noteChange(threadId: string, change: FileChange) {
    const run = this.runs.get(threadId);
    if (!run) return;
    run.changes.push(change);
    // The call that is running right now is the one that wrote it, and its step
    // is reported after the tool returns — so this is in time to ride along.
    const call = run.activeSpan?.startsWith("call:") ? run.activeSpan.slice("call:".length) : undefined;
    if (call) run.edits.set(call, editStat(change));
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
    let halted!: (reason: Stopped) => void;
    // Rejects on a stop and is raced against every host request. Nothing awaits it
    // on a run that finishes normally, so its rejection is pre-handled here rather
    // than left to come back as an unhandled one.
    const halt = new Promise<never>((_, reject) => { halted = reject; });
    halt.catch(() => undefined);
    const run: Run = {
      threadId: turn.threadId,
      parentThreadId: turn.parentThreadId,
      title: turn.title,
      color: agentColor(depth === 0 ? 0 : this.spawned),
      status: "running",
      mode: turn.mode,
      model: turn.model ?? "",
      activity: "thinking",
      startedAt: Date.now(),
      steps: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      generationMs: 0,
      goal: turn.content,
      steering: [],
      stopped: false,
      halt,
      halted,
      depth,
      changes: [],
      edits: new Map(),
      tools: new Set(),
      spans: [],
      adopted: false,
      traced: false,
    };
    // The run's own span, and the root of everything it does. A subagent's hangs
    // off the `task` call that asked for it rather than off its parent thread, so
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
   * token budget that stops an autoresearch job reads these, so leaving the
   * input side at zero let a job run to roughly twice its stated budget.
   */
  noteUsage(threadId: string, usage: { inputTokens: number; outputTokens: number }): void {
    const run = this.runs.get(threadId);
    if (!run) return;
    run.inputTokens += usage.inputTokens;
    if (usage.outputTokens > 0) run.outputTokens = usage.outputTokens;
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
   * Where a run spawned by this thread hangs in the trace: the call it came out
   * of, or the thread's own root when nothing here is driving the calls — an
   * adopted run's tool calls are made by someone else's loop and never open one.
   */
  spanFor(threadId: string): string | undefined {
    const run = this.runs.get(threadId);
    return run?.activeSpan ?? run?.spans[0]?.id;
  }

  /** Closes out an adopted run. An error message marks it failed instead of done. */
  finish(threadId: string, error?: string): void {
    const run = this.runs.get(threadId);
    if (!run) return;
    run.status = error ? "failed" : "done";
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

  /**
   * Drives one turn to a real answer: ask the model, run what it asks for behind
   * the mode's gate, submit the results, repeat. Returns the host's final turn.
   */
  /**
   * The user's standing instructions ride every turn, including a subagent's:
   * `delegate` reaches `run` directly without passing through main's `driveTurn`,
   * so applying them here is what keeps the two paths saying the same thing.
   */
  async run(request: TurnRequest): Promise<unknown> {
    const depth = request.depth ?? 0;
    // Rebuilt every step off the run's live mode, so switching out of Plan mid-run
    // hands the model the writes it was not offered a moment ago.
    const advertised = () => toolDefinitions(this.runs.get(request.threadId)?.mode ?? request.mode, this.deps.available(request.threadId, depth), this.deps.disabledTools());
    const advertises = (name: string) => advertised().some((tool) => tool.name === name);
    // The Anthropic API prepends the memory protocol to the system prompt whenever
    // the memory tool is in `tools`. Emma advertises it over an OpenAI-compatible
    // route where nothing does that for us, so the turn carries it instead — and
    // only when the tool is actually there to obey it with.
    // Same rule for planning, plus a depth of zero: this run is the one that would
    // break a job up, and a step's subagent already has its brief.
    const turn = withSystemPrompt(request, [
      ...(advertises("memory") ? [MEMORY_PROTOCOL] : []),
      ...(depth === 0 && advertises("plan") ? [PLANNING_PROTOCOL] : []),
    ]);
    const run = this.open(turn);
    const startedAt = run.startedAt;
    try {
      const tools = () => JSON.stringify(advertised());
      const screen = async () => (advertises("computer") ? await this.deps.screenshot() : undefined);
      const firstScreen = await screen();
      run.inputTokens += Math.ceil(turn.content.length / CHARS_PER_TOKEN);
      let result = await this.requestSpan(run, "model · prompt", "sendMessage", {
        ...turn.params,
        threadId: turn.threadId,
        content: turn.content,
        tools: tools(),
        ...(firstScreen ? { screenContext: firstScreen } : {}),
      });
      while (true) {
        // Ahead of reading the answer, not after it: a stop that landed while a
        // tool ran used to be ignored whenever the model came back with nothing
        // left to call, and the run reported itself finished.
        if (run.stopped) return await this.close(run, turn, "stopped", STOP_NOTE, false);
        const calls = toolCalls(result);
        if (!calls.length) {
          run.status = "done";
          run.activity = "finished";
          run.endedAt = Date.now();
          this.closeRun(run, "ok");
          this.deps.changed();
          return result;
        }
        run.steps += 1;
        if (run.steps > MAX_TURN_STEPS) return await this.close(run, turn, "stopped", `I stopped after ${MAX_TURN_STEPS} steps without finishing. Ask me to continue if the rest is still worth doing.`);
        if (Date.now() - startedAt > MAX_TURN_MS) return await this.close(run, turn, "stopped", "I ran out of time on this turn. Ask me to continue where I left off.");
        const results = [];
        for (const call of calls.slice(0, MAX_CALLS_PER_STEP)) {
          results.push({ id: call.id, content: bounded(await this.perform(run, turn, call)) });
        }
        for (const message of run.steering.splice(0)) {
          // Steering rides on the last result rather than as a user turn: the thread
          // is mid-step, and a second user message there is not a shape the sidecar has.
          results[results.length - 1].content = bounded(`${results[results.length - 1].content}\n\n[${message}]`);
        }
        run.activity = "thinking";
        this.deps.changed();
        const nextScreen = await screen();
        const payload = JSON.stringify(results);
        // Estimated, not reported: the host gives back output tokens only, so the
        // input side counts what this loop actually handed over.
        run.inputTokens += Math.ceil(payload.length / CHARS_PER_TOKEN);
        result = await this.requestSpan(run, `model · step ${run.steps}`, "submitToolResult", {
          threadId: turn.threadId,
          results: payload,
          tools: tools(),
          ...(nextScreen ? { screenContext: nextScreen } : {}),
        });
      }
    } catch (error) {
      // The request this run walked away from is not a failure to report — the
      // user asked for it — so it ends the turn the same way the flag does.
      if (error instanceof Stopped) return await this.close(run, turn, "stopped", STOP_NOTE, false);
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.activity = "failed";
      run.endedAt = Date.now();
      this.closeRun(run, "failed", run.error);
      this.deps.changed();
      throw error;
    } finally {
      if (run.status === "running" || run.status === "waiting") {
        run.status = "stopped";
        run.endedAt = Date.now();
      }
      run.generationMs = Math.max(run.generationMs, 1);
      // A stop is not a success, and the trace is about what happened rather than
      // whose fault it was, so it lands with the failures.
      this.closeRun(run, run.status === "done" ? "ok" : "failed", run.error);
      this.flushTrace(run);
      this.deps.changed();
    }
  }

  /** Spawns a subagent on its own thread and returns its final answer as a tool result. */
  async delegate(parent: TurnRequest, title: string, prompt: string): Promise<string> {
    const depth = (parent.depth ?? 0) + 1;
    if (depth > MAX_AGENT_DEPTH) return "Subagents cannot spawn their own subagents. Do this part of the work yourself.";
    const live = [...this.runs.values()].filter((run) => run.status === "running" && run.parentThreadId).length;
    if (live >= MAX_LIVE_SUBAGENTS) return `Emma already has ${MAX_LIVE_SUBAGENTS} subagents running. Wait for one to finish, or do this part yourself.`;
    const created = await this.deps.request("createThread", { parentThreadId: parent.threadId, title, kind: "subagent" });
    const threadId = (created as { id?: unknown }).id;
    if (typeof threadId !== "string") throw new Error("Emma host returned an invalid thread");
    this.spawned += 1;
    // Pinned before the first step, so the whole subagent runs on one model. A route
    // the host will not take — a stale catalog, an effort the model dropped — is not
    // worth failing the work over, so the child runs where its parent runs and the
    // label says so rather than claiming a model it never reached.
    let model = parent.model;
    if (parent.subagent?.model) {
      try {
        await this.deps.request("setThreadModel", { threadId, modelId: parent.subagent.model, effort: parent.subagent.effort });
        model = parent.subagent.model;
      } catch (error) {
        console.error("Emma: the subagent's model could not be set", error);
      }
    }
    const outcome = await this.run({
      threadId,
      content: prompt,
      mode: parent.mode,
      model,
      title,
      parentThreadId: parent.threadId,
      depth,
      // Inherited, so a subagent's own subagent takes the same route.
      subagent: parent.subagent,
      // The `task` call currently being performed on the parent, so the child's
      // whole tree hangs under the call that asked for it.
      parentSpanId: this.runs.get(parent.threadId)?.activeSpan,
    });
    // A subagent can be stopped on its own from the agent rail, and the parent
    // reads this string — "finished without an answer" would be a lie about why.
    if (!lastAssistantMessage(outcome) && this.runs.get(threadId)?.status === "stopped") return "That subagent was stopped before it answered.";
    return lastAssistantMessage(outcome) ?? "That subagent finished without an answer.";
  }

  /**
   * Runs one call behind the mode's gate, turning every refusal into something the
   * model can read, and leaves a span behind either way.
   *
   * The span is opened here rather than in `executeTool`, because a refused, a
   * declined and an invalidly-argued call are all things a run got stuck on and
   * all things the trace has to show.
   */
  private async perform(run: Run, turn: TurnRequest, call: { id: string; name: string; arguments: string }): Promise<string> {
    const span: TraceSpan = {
      id: `call:${call.id}`,
      parentId: run.spans[0].id,
      name: call.name,
      kind: call.name,
      startedAt: Date.now(),
      status: "running",
      input: call.arguments,
    };
    run.spans.push(span);
    const outer = run.activeSpan;
    run.activeSpan = span.id;
    // The renderer's step list is fed from here rather than from the trace: the
    // trace flushes when the run ends, and this is the half worth watching live.
    const report = (status: ThreadStep["status"], output?: string) => this.deps.step({
      threadId: turn.threadId, toolCallId: call.id, title: span.name, kind: call.name,
      status, input: call.arguments, output, at: Date.now(), edit: run.edits.get(call.id),
    });
    report("in_progress");
    const settle = (output: string, status: TraceStatus) => {
      span.status = status;
      span.output = output;
      // What the model is handed back, which is exactly what this call cost the
      // context. A refusal is a cost too, and a short one, which is half of why
      // the trace shows both.
      span.tokens = Math.ceil(output.length / CHARS_PER_TOKEN);
      return output;
    };
    try {
      return await this.attempt(run, turn, call, settle);
    } finally {
      span.endedAt = Date.now();
      run.activeSpan = outer;
      report(span.status === "failed" ? "failed" : "completed", span.output);
    }
  }

  private async attempt(
    run: Run,
    turn: TurnRequest,
    call: { id: string; name: string; arguments: string },
    settle: (output: string, status: TraceStatus) => string,
  ): Promise<string> {
    let args: AnyToolArgs;
    try { args = parseToolArgs(call.name, call.arguments); }
    catch (error) { return settle(error instanceof Error ? error.message : "Those tool arguments were invalid.", "failed"); }
    // `run.mode`, not the mode the turn opened on: the picker is live, and a user
    // who switches to Auto mid-run means the next call, not the next turn.
    let gate = toolGate(run.mode, call.name, this.deps.disabledTools());
    if (gate === "hidden") {
      return settle(this.deps.disabledTools().includes(call.name)
        ? `${call.name} is switched off in Settings → Tools, so it is not available. Do the work another way, or tell the user where to turn it back on.`
        : `Emma is in ${run.mode} mode, which does not allow ${call.name}.`, "failed");
    }
    // Accept edits already lets writes through. A bare grep is strictly less than that
    // — it reads, and reads are auto in every mode — so it does not stop the run either.
    if (gate === "ask" && run.mode === "acceptEdits" && args.name === "bash" && isBareGrep(args.command)) gate = "auto";
    run.activity = describeToolCall(args);
    run.toolCalls += 1;
    this.deps.changed();
    if (gate === "ask") {
      run.status = "waiting";
      this.deps.changed();
      const allowed = await this.confirm(run, args);
      run.status = run.stopped ? "stopped" : "running";
      this.deps.changed();
      // A verifier's refusal goes back as feedback rather than as a bare no: the
      // model has to know *why* it was rejected, or its next attempt is the same
      // call with the argument order changed.
      const rejected = run.mode === "auto" ? run.review?.verdict : undefined;
      if (!allowed) {
        return settle(rejected && !rejected.allow
          ? `The auto verifier rejected that, and the user did not override it. Its reason: ${rejected.reason || "none given"}. Do not run it again as written — do the thing the user actually asked for, or ask them what they want.`
          : "The user declined that. Ask them what to do instead, or try another way.", "failed");
      }
    }
    if (run.stopped) return settle("The user stopped this run.", "failed");
    // Answered here rather than in main's executor: the traces this reads are the
    // ones this class writes, and the threads it reads and starts are the ones it
    // runs, so nothing outside it has to know either exists.
    if (ownedHere(args)) {
      try { return settle(await this.runOwnTool(args, turn, run), "ok"); }
      catch (error) { return settle(`That failed: ${error instanceof Error ? error.message : "unknown error"}`, "failed"); }
    }
    // A failed tool is the model's problem to solve, not a dead turn.
    try { return settle(await this.deps.execute(args, turn), "ok"); }
    catch (error) { return settle(`That failed: ${error instanceof Error ? error.message : "unknown error"}`, "failed"); }
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
    const found = await this.findThread(thread);
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
   * Emma's durable timelines, as the model works with them.
   *
   * The split this tool draws is the one the app is built on: a thread is a
   * conversation that keeps its history and outlives every run in it, an agent
   * is the loop doing a job inside one. So spawning leaves something behind for
   * the user whether or not an agent ever works in it, and `message` starts a
   * turn on a quiet thread rather than failing — there is always someone there
   * to talk to, even when nothing is running.
   */
  private async runThreadsTool(args: Extract<LoopArgs, { name: "threads" }>, turn: TurnRequest): Promise<string> {
    // One gate row per tool, and this one both reads and acts: listing, reading
    // and renaming change nothing and belong in plan mode, while a new row in
    // the sidebar and an agent put to work do not.
    if (turn.mode === "plan" && (args.action === "spawn" || args.action === "message")) {
      throw new Error("Plan mode does not start threads or put agents to work. Say which threads should be spawned and what each one is for.");
    }
    switch (args.action) {
      case "list": return await this.readThread(undefined, args.limit);
      case "read": return await this.readThread(args.thread, args.limit);
      case "rename": return await this.renameThread(turn, args.title!);
      case "spawn": return await this.spawnThread(turn, args.title!, args.prompt);
      case "message": return await this.messageThread(turn, args.thread!, args.prompt!);
    }
  }

  /**
   * Starts a thread of its own, owned by the thread this turn is in, and with a
   * prompt puts a main agent to work in it beside this turn.
   *
   * That agent is not a subagent: nothing comes back here, it runs at the top
   * level of the agent list, and the thread it works in stays in the sidebar
   * once it stops. What it inherits is the mode — so its own writes and commands
   * hit the gate table exactly as they would here, rather than escaping through
   * the spawn.
   */
  private async spawnThread(turn: TurnRequest, title: string, prompt?: string): Promise<string> {
    // Owned by the thread the user can actually see. A subagent's transcript is
    // not in the sidebar, so hanging a sub thread off one would hide it; the one
    // hop up is enough, because a subagent cannot spawn a subagent.
    const owner = turn.parentThreadId ?? turn.threadId;
    // Counted before the thread is created, so a refused spawn does not leave an
    // empty row behind. Only threads working on their own are counted: subagents
    // have a ceiling of their own, over in `delegate`.
    const working = [...this.runs.values()].filter((run) => !run.parentThreadId && (run.status === "running" || run.status === "waiting")).length;
    if (prompt && working >= MAX_LIVE_THREADS) {
      return `Emma already has ${MAX_LIVE_THREADS} threads working. Wait for one to finish, or spawn this one without a prompt so the user can start it.`;
    }
    const created = await this.deps.request("createThread", { parentThreadId: owner, title });
    const threadId = (created as { id?: unknown }).id;
    if (typeof threadId !== "string") throw new Error("Emma returned an invalid thread");
    // The transcript draws a card for the thread off this marker, so it has to
    // end the first line — see `THREADS_MARKER`.
    const mark = `[threads:${threadId}:${title}]`;
    if (!prompt) {
      return `Started the thread "${title}" (${threadId}), in this project and owned by this thread. ${mark}\n\nIt is empty and nothing is running in it, so tell the user it is there and what it is for.`;
    }
    this.start({ threadId, content: fromThread(owner, prompt), mode: turn.mode, model: turn.model, title, subagent: turn.subagent }, owner);
    return `Started the thread "${title}" (${threadId}) and put its own agent to work in it. ${mark}\n\n`
      + `It runs beside this turn and nothing comes back here. Use threads list to see how it is doing, threads read ${threadId} for what it has said, and threads message to send it something.`;
  }

  /**
   * Sends text into another thread: steering the agent working there if one is,
   * and starting a turn of its own if none is. One door, because from out here
   * "talk to that thread" is one intention — whether something happens to be
   * running in it at this instant is Emma's business, not the model's.
   */
  private async messageThread(turn: TurnRequest, thread: string, text: string): Promise<string> {
    const sender = turn.parentThreadId ?? turn.threadId;
    if (thread === sender) throw new Error("That is the thread you are in. Say it in your answer instead.");
    // Checked against the library first: a bad ID would otherwise fail later, in
    // a turn nobody is reading, after this call had already said it was sent.
    const found = await this.findThread(thread);
    const run = this.runs.get(thread);
    if (run && (run.status === "running" || run.status === "waiting")) {
      this.steer(thread, text, sender);
      return `Queued for ${thread}. It arrives with that agent's next batch of tool results.`;
    }
    this.start({ threadId: thread, content: fromThread(sender, text), mode: turn.mode, model: turn.model, title: found.title });
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
    const drive = this.deps.spawnTurn ?? ((request: TurnRequest) => this.run(request));
    void Promise.resolve(drive(turn, owner)).catch((error: unknown) => console.error("Emma: a thread's own turn failed", error));
  }

  /** Every thread Emma has stored, which is what the model reads its library as. */
  private async library(): Promise<SnapshotThread[]> {
    const result = await this.deps.request("snapshot", {});
    const threads = (result as { threads?: unknown })?.threads;
    if (!Array.isArray(threads)) throw new Error("Emma returned an invalid library");
    return threads as SnapshotThread[];
  }

  private async findThread(thread: string): Promise<SnapshotThread> {
    const found = (await this.library()).find((item) => item.id === thread);
    if (!found) throw new Error(`Emma has no thread with the ID ${thread}. Call threads with action list to see the ones it does have.`);
    return found;
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
    return new Promise<boolean>((resolve) => {
      const settle = (allowed: boolean) => { if (this.asks.delete(id)) { clearTimeout(timer); resolve(allowed); } };
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
      // Under the call being reviewed where there is one; the harness asks without
      // one in hand, and then the run's own root is the honest parent.
      parentId: run.activeSpan ?? run.spans[0].id,
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

  private confirm(run: Run, args: AnyToolArgs): Promise<boolean> {
    return this.question({ threadId: run.threadId, tool: args.name, summary: describeToolCall(args), detail: detailOf(args) });
  }

  /**
   * Ends a turn with words rather than a silent stop, so the thread has an answer in it.
   *
   * `summarise` is off for a user stop, and has to be: asking the model to sum up
   * is one more generation, which is exactly what the button was pressed to end —
   * the stop read as making Emma talk more. There is nowhere to put it either,
   * since the host is still finishing the request this run just abandoned.
   */
  private async close(run: Run, turn: TurnRequest, status: Run["status"], message: string, summarise = true) {
    run.stopped = true;
    const result = summarise
      ? await this.requestSpan(run, "model · wrap up", "sendMessage", { threadId: turn.threadId, content: `[System] ${message} Say so, briefly, and summarise what you got done.` })
        .catch(() => undefined)
      : undefined;
    run.status = status;
    run.activity = message;
    run.endedAt = Date.now();
    this.closeRun(run, "failed", message);
    this.deps.changed();
    return result;
  }
}

/** One thread as the snapshot carries it. Only the parts `threads` reads. */
type SnapshotThread = {
  id: string;
  title: string;
  kind?: string;
  parentThreadId?: string | null;
  archivedAt?: string | null;
  updatedAt?: string;
  messages?: { role: string; content: string; timestamp: string }[];
};

function detailOf(args: AnyToolArgs): string {
  switch (args.name) {
    case "bash": return args.command;
    case "write_file": return `${args.path} · ${args.content.length.toLocaleString()} characters`;
    case "computer": return JSON.stringify(args.args).slice(0, 512);
    // Which of Emma's own tools, and what it is handed. The script itself is not
    // repeated here: `write_tool` put it in this transcript when it was written.
    case "run_tool": return `${args.tool ?? ""} ${args.input ?? ""}`.trim().slice(0, 512);
    case "mcp_tool": return `${args.tool} ${JSON.stringify(args.args)}`.slice(0, 512);
    // The process this starts, spelled out. Environment values are named, never
    // shown: the question is which program runs, not what it is handed.
    case "install_mcp": return `${[args.command, ...args.argv].join(" ")}${Object.keys(args.env).length ? ` · env: ${Object.keys(args.env).sort().join(", ")}` : ""}`.slice(0, 512);
    default: return "";
  }
}

const TRUNCATION_NOTICE = "\n[truncated]";

/** The sidecar's ceiling is bytes, not characters, and the notice counts against it. */
export function bounded(value: string): string {
  if (Buffer.byteLength(value) <= MAX_TOOL_OUTPUT_BYTES) return value;
  const limit = MAX_TOOL_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE);
  let kept = value;
  while (Buffer.byteLength(kept) > limit) kept = kept.slice(0, Math.floor(kept.length * (limit / Buffer.byteLength(kept))));
  return `${kept}${TRUNCATION_NOTICE}`;
}

export function toolCalls(result: unknown): { id: string; name: string; arguments: string }[] {
  if (!result || typeof result !== "object") throw new Error("Emma host returned an invalid turn");
  const calls = (result as Record<string, unknown>).toolCalls;
  if (calls === undefined) return [];
  if (!Array.isArray(calls) || calls.length > MAX_CALLS_PER_STEP) throw new Error("Emma host returned an invalid turn");
  return calls.map((call) => {
    if (!call || typeof call !== "object") throw new Error("Emma host returned an invalid tool call");
    const candidate = call as Record<string, unknown>;
    if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || typeof candidate.arguments !== "string") throw new Error("Emma host returned an invalid tool call");
    return { id: candidate.id, name: candidate.name, arguments: candidate.arguments };
  });
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
