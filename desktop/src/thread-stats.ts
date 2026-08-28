import { CHARS_PER_TOKEN, rateByContext, type ContextUse } from "../shared/usage";
import { toCsv, type Cell } from "../shared/csv";
import { decodeSpans, traceHeader, type TraceSpan } from "../shared/trace";
import { tokensPerSecond, type LiveAgent } from "../shared/agents";
import { planProgress, type Plan } from "../shared/plan";
import { buildLedger, threadBreakdown, threadExperiments, threadFolders, threadMode, threadTags, threadUses, type ContextBreakdown, type Ledger } from "./context";
import type { Message, Snapshot, Thread } from "./types";

export interface Sheet {
  name: string;
  rows: Cell[][];
}

export interface StatsSources {
  thread: Thread;
  traces: { timestamp: string; text: string }[];
  ledger: Ledger;
  agents: LiveAgent[];
  subthreads: Thread[];
  uses: ContextUse[];
  breakdown: ContextBreakdown;
  plans: Plan[];
  folders: string[];
  mode: string;
  tag: string;
  exportedAt: number;
}

const RATE_FLOOR = 4096;
const rate = (tokens: number, ms: number) => ms > 0 ? Number((tokens / ms * 1000).toFixed(3)) : 0;
const stamp = (at: number | undefined) => at === undefined ? "" : new Date(at).toISOString();
const estTokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);
const bucket = (inputTokens: number) => RATE_FLOOR * 2 ** Math.floor(Math.log2(Math.max(inputTokens, RATE_FLOOR) / RATE_FLOOR));
const share = (part: number, whole: number) => whole > 0 ? Number((part / whole).toFixed(5)) : 0;

interface Turn {
  timestamp: string;
  model: string;
  arm: string;
  spans: TraceSpan[];
}

function readTurns(traces: readonly { timestamp: string; text: string }[]): Turn[] {
  return traces.map((trace) => {
    const header = traceHeader(trace.text);
    return { timestamp: trace.timestamp, model: header.model ?? "", arm: header.arm ?? "", spans: decodeSpans(trace.text) };
  });
}

function depthOf(span: TraceSpan, byId: Map<string, TraceSpan>): number {
  let depth = 0;
  let parent = span.parentId ? byId.get(span.parentId) : undefined;
  while (parent && depth < 32) {
    depth += 1;
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return depth;
}

const isCall = (span: TraceSpan) => span.kind !== "agent" && span.kind !== "model" && span.kind !== "verifier";
const spanMs = (span: TraceSpan, now: number) => Math.max(0, (span.endedAt ?? now) - span.startedAt);
const outputTokensOf = (thread: Thread) => thread.messages.reduce((sum, message) => sum + (message.generation?.outputTokens ?? 0), 0);
const generationMsOf = (thread: Thread) => thread.messages.reduce((sum, message) => sum + (message.generation?.durationMilliseconds ?? 0), 0);

function summarySheet(sources: StatsSources, turns: Turn[]): Sheet {
  const { thread, ledger, breakdown, agents, subthreads, uses, folders, exportedAt } = sources;
  const spans = turns.flatMap((turn) => turn.spans);
  const generations = thread.messages.flatMap((message) => message.generation ? [message.generation] : []);
  const inputTokens = generations.reduce((sum, one) => sum + one.inputTokens, 0);
  const failed = spans.filter((span) => span.status === "failed").length;
  const calls = spans.filter(isCall);
  const callMs = calls.reduce((sum, span) => sum + spanMs(span, exportedAt), 0);
  const requests = spans.filter((span) => span.kind === "model");
  const wall = spans.length ? Math.max(...spans.map((span) => span.endedAt ?? exportedAt)) - Math.min(...spans.map((span) => span.startedAt)) : 0;
  const goal = thread.goal;
  return {
    name: "summary",
    rows: [
      ["Metric", "Value"],
      ["Thread id", thread.id],
      ["Title", thread.title],
      ["Kind", thread.kind ?? "main"],
      ["Parent thread id", thread.parentThreadId ?? ""],
      ["Scheduled job id", thread.scheduledJobId ?? ""],
      ["Tag", sources.tag],
      ["Permission mode", sources.mode],
      ["Folders", folders.join(" | ")],
      ["Created at", thread.createdAt],
      ["Updated at", thread.updatedAt],
      ["Archived at", thread.archivedAt ?? ""],
      ["Exported at", stamp(exportedAt)],
      ["Lifespan (hours)", Number(((Date.parse(thread.updatedAt) - Date.parse(thread.createdAt)) / 3_600_000).toFixed(3))],
      ["Messages", thread.messages.length],
      ["User messages", thread.messages.filter((message) => message.role === "user").length],
      ["Assistant messages", thread.messages.filter((message) => message.role === "assistant").length],
      ["System messages", thread.messages.filter((message) => message.role === "system").length],
      ["Transcript characters", thread.messages.reduce((sum, message) => sum + message.content.length, 0)],
      ["Turns with telemetry", generations.length],
      ["Output tokens", ledger.tokens],
      ["Input tokens", inputTokens],
      ["Total tokens", ledger.tokens + inputTokens],
      ["Generation time (ms)", ledger.elapsed],
      ["Average output tokens per second", rate(ledger.tokens, ledger.elapsed)],
      ["Fastest turn tokens per second", generations.reduce((top, one) => Math.max(top, rate(one.outputTokens, one.durationMilliseconds)), 0)],
      ["Output tokens per turn", generations.length ? Number((ledger.tokens / generations.length).toFixed(2)) : 0],
      ["Models used", [...new Set(generations.map((one) => one.model).filter(Boolean))].join(" | ")],
      ["Traced turns", turns.length],
      ["Spans recorded", spans.length],
      ["Model requests", requests.length],
      ["Tool calls", calls.length],
      ["Failed spans", failed],
      ["Failure rate", share(failed, spans.length)],
      ["Tool time (ms)", callMs],
      ["Average tool call (ms)", calls.length ? Number((callMs / calls.length).toFixed(2)) : 0],
      ["Traced wall clock (ms)", wall],
      ["Distinct tools", new Set(calls.map((span) => span.name)).size],
      ["Context carried (characters)", ledger.total],
      ["Context carried (tokens)", ledger.carriedTokens],
      ["Context window (tokens)", Math.round(ledger.capacity / CHARS_PER_TOKEN)],
      ["Context free (tokens)", Math.round(ledger.free / CHARS_PER_TOKEN)],
      ["Context used share", share(ledger.total, ledger.whole)],
      ["Largest context segment", ledger.largest ? `${ledger.largest.label} · ${estTokens(ledger.largest.chars)} tokens` : ""],
      ["Ledger attachments", uses.length],
      ["System prompt characters", breakdown.systemPromptBytes],
      ["System tool characters", breakdown.systemToolsBytes],
      ["MCP tool characters", breakdown.mcpToolsBytes],
      ["Skill characters", breakdown.skillsBytes],
      ["Memory file characters", breakdown.memoryBytes],
      ["Pruning saved tokens", ledger.experiments.savedTokens],
      ["Pruning added tokens", ledger.experiments.addedTokens],
      ["Pruned tool results", ledger.experiments.prunedResults],
      ["Prompt reinjections", ledger.experiments.reinjections],
      ["Sub threads", subthreads.length],
      ["Live agents", agents.length],
      ["Plans", sources.plans.length],
      ["Goal objective", goal?.objective ?? ""],
      ["Goal status", goal?.status ?? ""],
      ["Goal turns", goal?.turns ?? ""],
      ["Goal tokens used", goal?.tokensUsed ?? ""],
      ["Goal token budget", goal?.tokenBudget ?? ""],
      ["Goal seconds used", goal?.timeUsedSeconds ?? ""],
      ["Goal blocked reason", goal?.blockedReason ?? ""],
    ],
  };
}

function turnsSheet(thread: Thread, exportedAt: number): Sheet {
  const rows: Cell[][] = [[
    "index", "role", "timestamp", "secondsSincePrevious", "characters", "estimatedTokens", "model",
    "inputTokens", "outputTokens", "totalTokens", "durationMs", "tokensPerSecond", "contextBucketTokens",
    "cumulativeOutputTokens", "cumulativeMs",
  ]];
  let cumulativeTokens = 0;
  let cumulativeMs = 0;
  let previous = 0;
  thread.messages.forEach((message: Message, index) => {
    const at = Date.parse(message.timestamp) || exportedAt;
    const generation = message.generation ?? undefined;
    cumulativeTokens += generation?.outputTokens ?? 0;
    cumulativeMs += generation?.durationMilliseconds ?? 0;
    rows.push([
      index,
      message.role,
      message.timestamp,
      previous ? Number(((at - previous) / 1000).toFixed(3)) : 0,
      message.content.length,
      estTokens(message.content.length),
      generation?.model ?? "",
      generation?.inputTokens ?? "",
      generation?.outputTokens ?? "",
      generation ? generation.inputTokens + generation.outputTokens : "",
      generation?.durationMilliseconds ?? "",
      generation ? rate(generation.outputTokens, generation.durationMilliseconds) : "",
      generation ? bucket(generation.inputTokens) : "",
      cumulativeTokens,
      cumulativeMs,
    ]);
    previous = at;
  });
  return { name: "turns", rows };
}

function spansSheet(turns: Turn[], exportedAt: number): Sheet {
  const rows: Cell[][] = [[
    "turnTimestamp", "turnModel", "turnArm", "spanId", "parentSpanId", "depth", "name", "kind", "status",
    "startedAt", "endedAt", "durationMs", "offsetMsInTurn", "tokens", "tokensPerSecond",
    "inputCharacters", "outputCharacters", "input", "output",
  ]];
  for (const turn of turns) {
    const byId = new Map(turn.spans.map((span) => [span.id, span]));
    const origin = turn.spans.length ? Math.min(...turn.spans.map((span) => span.startedAt)) : 0;
    for (const span of turn.spans) {
      const ms = spanMs(span, exportedAt);
      rows.push([
        turn.timestamp, turn.model, turn.arm, span.id, span.parentId ?? "", depthOf(span, byId),
        span.name, span.kind, span.status, stamp(span.startedAt), stamp(span.endedAt), ms, span.startedAt - origin,
        span.tokens ?? "", span.tokens === undefined ? "" : rate(span.tokens, ms),
        span.input?.length ?? 0, span.output?.length ?? 0, span.input ?? "", span.output ?? "",
      ]);
    }
  }
  return { name: "spans", rows };
}

function toolsSheet(turns: Turn[], exportedAt: number): Sheet {
  const tools = new Map<string, { name: string; kind: string; calls: number; failed: number; ms: number; slowest: number; tokens: number; turns: Set<string> }>();
  for (const turn of turns) {
    for (const span of turn.spans) {
      if (!isCall(span)) continue;
      const key = `${span.kind} ${span.name}`;
      const tally = tools.get(key) ?? { name: span.name, kind: span.kind, calls: 0, failed: 0, ms: 0, slowest: 0, tokens: 0, turns: new Set<string>() };
      const ms = spanMs(span, exportedAt);
      tally.calls += 1;
      tally.failed += span.status === "failed" ? 1 : 0;
      tally.ms += ms;
      tally.slowest = Math.max(tally.slowest, ms);
      tally.tokens += span.tokens ?? 0;
      tally.turns.add(turn.timestamp);
      tools.set(key, tally);
    }
  }
  const rows: Cell[][] = [["tool", "kind", "calls", "failed", "failureRate", "turnsUsedIn", "totalMs", "averageMs", "slowestMs", "resultTokens", "tokensPerCall"]];
  for (const tally of [...tools.values()].sort((left, right) => right.ms - left.ms)) {
    rows.push([
      tally.name, tally.kind, tally.calls, tally.failed, share(tally.failed, tally.calls), tally.turns.size,
      tally.ms, Number((tally.ms / tally.calls).toFixed(2)), tally.slowest, tally.tokens,
      Number((tally.tokens / tally.calls).toFixed(2)),
    ]);
  }
  return { name: "tools", rows };
}

function modelsSheet(thread: Thread, turns: Turn[], exportedAt: number): Sheet {
  const models = new Map<string, { turns: number; input: number; output: number; ms: number; requests: number; requestMs: number; requestTokens: number; failed: number }>();
  const take = (model: string) => {
    const tally = models.get(model) ?? { turns: 0, input: 0, output: 0, ms: 0, requests: 0, requestMs: 0, requestTokens: 0, failed: 0 };
    models.set(model, tally);
    return tally;
  };
  for (const message of thread.messages) {
    if (!message.generation) continue;
    const tally = take(message.generation.model || "unknown");
    tally.turns += 1;
    tally.input += message.generation.inputTokens;
    tally.output += message.generation.outputTokens;
    tally.ms += message.generation.durationMilliseconds;
  }
  for (const turn of turns) {
    for (const span of turn.spans) {
      if (span.kind !== "model") continue;
      const tally = take(turn.model || "unknown");
      tally.requests += 1;
      tally.requestMs += spanMs(span, exportedAt);
      tally.requestTokens += span.tokens ?? 0;
      tally.failed += span.status === "failed" ? 1 : 0;
    }
  }
  const rows: Cell[][] = [["model", "turns", "inputTokens", "outputTokens", "totalTokens", "generationMs", "tokensPerSecond", "modelRequests", "failedRequests", "requestMs", "streamedTokens"]];
  for (const [model, tally] of [...models.entries()].sort((left, right) => right[1].output - left[1].output)) {
    rows.push([
      model, tally.turns, tally.input, tally.output, tally.input + tally.output, tally.ms, rate(tally.output, tally.ms),
      tally.requests, tally.failed, tally.requestMs, tally.requestTokens,
    ]);
  }
  return { name: "models", rows };
}

function rateSheet(thread: Thread): Sheet {
  const rows: Cell[][] = [["contextBucketTokens", "outputTokensPerSecond", "turns"]];
  for (const point of rateByContext(thread.messages.flatMap((message) => message.generation ? [message.generation] : []))) {
    rows.push([point.context, Number(point.rate.toFixed(3)), point.turns]);
  }
  return { name: "rate-by-context", rows };
}

function contextSheet(ledger: Ledger): Sheet {
  const rows: Cell[][] = [["kind", "label", "characters", "estimatedTokens", "turnsCarried", "shareOfWindow"]];
  for (const row of ledger.rows) rows.push([row.kind, row.label, row.chars, estTokens(row.chars), row.turns, share(row.chars, ledger.whole)]);
  rows.push(["free", "Free space", ledger.free, estTokens(ledger.free), "", share(ledger.free, ledger.whole)]);
  rows.push(["capacity", "Stated window", ledger.capacity, estTokens(ledger.capacity), "", ledger.capacity ? 1 : 0]);
  return { name: "context-ledger", rows };
}

function subthreadsSheet(subthreads: readonly Thread[], agents: readonly LiveAgent[]): Sheet {
  const rows: Cell[][] = [["threadId", "title", "kind", "createdAt", "updatedAt", "archivedAt", "messages", "outputTokens", "generationMs", "tokensPerSecond", "liveStatus", "activity", "goalStatus"]];
  for (const thread of subthreads) {
    const agent = agents.find((one) => one.threadId === thread.id);
    const tokens = outputTokensOf(thread);
    const ms = generationMsOf(thread);
    rows.push([
      thread.id, thread.title, thread.kind ?? "main", thread.createdAt, thread.updatedAt, thread.archivedAt ?? "",
      thread.messages.length, tokens, ms, rate(tokens, ms), agent?.status ?? "idle", agent?.activity ?? "", thread.goal?.status ?? "",
    ]);
  }
  return { name: "sub-threads", rows };
}

function agentsSheet(agents: readonly LiveAgent[], exportedAt: number): Sheet {
  const rows: Cell[][] = [["threadId", "parentThreadId", "title", "status", "mode", "model", "activity", "startedAt", "endedAt", "elapsedMs", "steps", "toolCalls", "inputTokens", "outputTokens", "generationMs", "tokensPerSecond", "error"]];
  for (const agent of agents) {
    rows.push([
      agent.threadId, agent.parentThreadId ?? "", agent.title, agent.status, agent.mode, agent.model, agent.activity,
      stamp(agent.startedAt), stamp(agent.endedAt), (agent.endedAt ?? exportedAt) - agent.startedAt,
      agent.steps, agent.toolCalls, agent.inputTokens, agent.outputTokens, agent.generationMs,
      Number(tokensPerSecond(agent).toFixed(3)), agent.error ?? "",
    ]);
  }
  return { name: "agents", rows };
}

function planSheet(plans: readonly Plan[]): Sheet {
  const rows: Cell[][] = [["planId", "planTitle", "planUpdatedAt", "stepsDone", "steps", "tasksDone", "tasks", "revisions", "stepId", "stepTitle", "stepStatus", "needs", "stepTasksDone", "stepTasks", "brief", "result"]];
  for (const plan of plans) {
    const progress = planProgress(plan);
    for (const step of plan.steps) {
      rows.push([
        plan.id, plan.title, plan.updatedAt, progress.done, progress.steps, progress.doneTasks, progress.tasks, plan.revisions?.length ?? 0,
        step.id, step.title, step.status, step.needs.join(" | "),
        step.tasks.filter((task) => task.done).length, step.tasks.length, step.brief, step.result ?? "",
      ]);
    }
  }
  return { name: "plan", rows };
}

export function threadStatsSheets(sources: StatsSources): Sheet[] {
  const turns = readTurns(sources.traces);
  return [
    summarySheet(sources, turns),
    turnsSheet(sources.thread, sources.exportedAt),
    spansSheet(turns, sources.exportedAt),
    toolsSheet(turns, sources.exportedAt),
    modelsSheet(sources.thread, turns, sources.exportedAt),
    rateSheet(sources.thread),
    contextSheet(sources.ledger),
    subthreadsSheet(sources.subthreads, sources.agents),
    agentsSheet(sources.agents, sources.exportedAt),
    planSheet(sources.plans),
  ];
}

export function statsFolderName(thread: Thread, at: number): string {
  const slug = (thread.title || "thread").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "thread";
  return `${slug}-${new Date(at).toISOString().slice(0, 16).replace(/[:T-]/g, "")}`;
}

export function statsFiles(sources: StatsSources): { name: string; text: string }[] {
  return threadStatsSheets(sources).map((sheet) => ({ name: `${sheet.name}.csv`, text: toCsv(sheet.rows) }));
}

export async function collectStats(threadId: string, contextTokens: number): Promise<StatsSources | undefined> {
  const [snapshot, traces, agents, plans] = await Promise.all([
    window.emma.request<Snapshot>("snapshot"),
    window.emma.threadTraces(threadId).catch(() => []),
    window.emma.listAgents().catch(() => []),
    window.emma.listPlans().catch(() => []),
  ]);
  const thread = snapshot.threads.find((one) => one.id === threadId);
  if (!thread) return undefined;
  const uses = threadUses(threadId);
  const breakdown = threadBreakdown(threadId);
  const experiments = threadExperiments(threadId);
  const mine = agents.filter((agent) => agent.threadId === threadId || agent.parentThreadId === threadId);
  return {
    thread,
    traces,
    ledger: buildLedger(thread, uses, contextTokens, mine.filter((agent) => agent.threadId === threadId), experiments, 0, breakdown),
    agents: mine,
    subthreads: snapshot.threads.filter((one) => one.parentThreadId === threadId),
    uses,
    breakdown,
    plans: plans.filter((plan) => plan.threadId === threadId),
    folders: threadFolders(threadId),
    mode: threadMode(threadId),
    tag: threadTags()[threadId]?.tag ?? "",
    exportedAt: Date.now(),
  };
}
