import { useSyncExternalStore } from "react";
import type { LiveAgent, ThreadStep } from "../shared/agents";
import { decodeSpans, traceHeader, type TraceSpan } from "../shared/trace";
import { visualDrawn } from "../shared/visualize";
import { charLabel } from "../shared/usage";
import { splitThinking } from "../shared/thinking";
import type { Message } from "./types";
import { recordBreakdown, recordExperiment } from "./context";
import { reasonText } from "./errors";

export type QueuedTurn = {
  content: string;
  after: number;
  params: Record<string, string>;
  prepare?: () => Promise<Pick<QueuedTurn, "params" | "delivered">>;
  attached?: boolean;
  cancelled?: boolean;
  delivered?: () => void;
  notice?: string;
};

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "step"; step: ThreadStep }

  | { kind: "notice"; text: string; plain?: boolean; steer?: boolean };

const voice = (blocks: Block[], least: number) =>
  blocks.find((block) => (block.kind === "text" || block.kind === "thinking") && block.text.trim().length > least) as { text: string } | undefined;

export function pairBlocks(messages: Message[], landed: Block[][], cached: Record<string, Block[]>): (Block[] | undefined)[] {
  const spots = messages.flatMap((item, at) => item.role === "user" ? [] : [at]);
  const paired = new Map<number, Block[]>();
  const spare: Block[][] = [];
  for (const blocks of landed) {
    const said = voice(blocks, 0);
    if (!said) { spare.push(blocks); continue; }
    const spot = spots.find((at) => !paired.has(at) && messages[at].content.includes(said.text.trim().slice(0, 40)));
    if (spot !== undefined) paired.set(spot, blocks);
  }
  const open = spots.filter((at) => !paired.has(at));
  const take = Math.min(spare.length, open.length);
  for (let at = 0; at < take; at += 1) paired.set(open[open.length - take + at], spare[spare.length - take + at]);
  return messages.map((item, at) => paired.get(at) ?? (item.role === "user" ? undefined : cached[item.timestamp]));
}

export function wrote(content: string, blocks: Block[]): boolean {
  const said = voice(blocks, 8);
  return !said || content.includes(said.text.trim().slice(0, 40));
}

export function arrived(messages: Message[], blocks: Block[]): boolean {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    if (messages[at].role === "assistant") return wrote(messages[at].content, blocks);
  }
  return false;
}

export function thinkingOf(blocks: Block[]): string {
  return blocks
    .flatMap((block) => block.kind === "thinking" ? [block.text] : block.kind === "text" ? [splitThinking(block.text).thinking] : [])
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function withoutThinking(blocks: Block[]): Block[] {
  return blocks.flatMap<Block>((block) => {
    if (block.kind === "thinking") return [];
    if (block.kind !== "text") return [block];
    const { answer } = splitThinking(block.text);
    return answer.trim() ? [{ kind: "text", text: answer }] : [];
  });
}

export type Grouped =
  | { kind: "text" | "thinking"; text: string }
  | { kind: "notice"; text: string; plain?: boolean; steer?: boolean }

  | { kind: "steps"; steps: ThreadStep[]; keep: number }

  | { kind: "visual"; id: string };

export function groupBlocks(blocks: Block[], keep: number): Grouped[] {
  const grouped: Grouped[] = [];
  for (const block of blocks) {
    const visual = block.kind === "step" ? visualDrawn(block.step) : undefined;
    if (visual) grouped.push({ kind: "visual", id: visual });
    else if (block.kind !== "step") grouped.push(block);
    else {
      const tail = grouped.at(-1);
      if (tail?.kind === "steps") tail.steps.push(block.step);
      else grouped.push({ kind: "steps", steps: [block.step], keep });
    }
  }
  return grouped;
}

export type Run = {
  sending: boolean;
  foreign: boolean;
  pending: QueuedTurn | null;
  blocks: Block[];
  landed: Block[][];
  queue: QueuedTurn[];
  held: QueuedTurn[];
  stopped: boolean;
  draft: string;
  activeAt: number;
  routed: string;
};

const IDLE: Run = { sending: false, foreign: false, pending: null, blocks: [], landed: [], queue: [], held: [], stopped: false, draft: "", activeAt: 0, routed: "" };
const runs = new Map<string, Run>();
const listeners = new Set<() => void>();
let wired = false;

let refresh: () => unknown = () => undefined;
const read = (threadId: string) => runs.get(threadId) ?? IDLE;

function write(threadId: string, change: Partial<Run> | ((run: Run) => Partial<Run>)) {
  const current = read(threadId);
  runs.set(threadId, { ...current, ...(typeof change === "function" ? change(current) : change) });
  for (const listener of listeners) listener();
}

export function appendText(blocks: Block[], kind: "text" | "thinking", delta: string): Block[] {
  const tail = blocks.at(-1);
  return tail?.kind === kind
    ? [...blocks.slice(0, -1), { kind, text: tail.text + delta }]
    : [...blocks, { kind, text: delta }];
}

export function mergeStep(blocks: Block[], step: ThreadStep): Block[] {
  const at = blocks.findIndex((block) => block.kind === "step" && block.step.toolCallId === step.toolCallId);
  if (at < 0) return [...blocks, { kind: "step", step }];
  const next = [...blocks];
  next[at] = { kind: "step", step };
  return next;
}

function adoptForeign(threadId: string) {
  write(threadId, { sending: true, foreign: true, blocks: [], pending: null, stopped: false, activeAt: Date.now() });
  void rehydrate(threadId, began(threadId));
}

const generations = new Map<string, number>();
let generation = 0;

function began(threadId: string): number {
  generation += 1;
  generations.set(threadId, generation);
  return generation;
}

export function joinPartial(restored: string, held: string): string {
  for (let size = Math.min(restored.length, held.length); size > 0; size -= 1) {
    if (restored.endsWith(held.slice(0, size))) return restored + held.slice(size);
  }
  return restored + held;
}

const marked = (span: TraceSpan) => span.id.startsWith("call:") || span.id.startsWith("steer:");

export const isSteer = (block: Block) => block.kind === "notice" && !!block.steer;

export function restoreBlocks(threadId: string, spans: TraceSpan[], partial?: { text: string; thinking: string }): Block[] {
  const byId = new Map(spans.map((span) => [span.id, span]));
  const ownedHere = (span: TraceSpan) => {
    let at = byId.get(span.parentId ?? "");
    for (let hops = spans.length; at && hops > 0; hops -= 1) {
      if (at.id.startsWith("agent:")) return at.id === `agent:${threadId}`;
      at = byId.get(at.parentId ?? "");
    }
    return true;
  };
  const calls = spans
    .filter((span) => marked(span) && ownedHere(span))
    .sort((left, right) => left.startedAt - right.startedAt)
    .map((span) => ({
      said: span.said,
      block: (span.id.startsWith("steer:")
        ? { kind: "notice", text: span.input ?? "", plain: true, steer: true }
        : {
          kind: "step",
          step: {
            threadId,
            toolCallId: span.id.slice("call:".length),
            title: span.name,
            kind: span.kind,
            status: span.status === "ok" ? "completed" : span.status === "failed" ? "failed" : span.status === "cancelled" ? "cancelled" : "in_progress",
            input: span.input,
            output: span.output,
            at: span.startedAt,
          },
        }) as Block,
    }))
    .filter((mark) => mark.block.kind !== "notice" || mark.block.text.trim().length > 0);
  const answer = partial?.text ?? "";
  const said = (text: string | undefined, kind: "text" | "thinking"): Block[] => text?.trim() ? [{ kind, text }] : [];
  const blocks = said(partial?.thinking, "thinking");
  let cut = 0;
  for (const call of calls) {
    const at = call.said === undefined ? cut : Math.min(call.said, answer.length);
    if (at > cut) blocks.push(...said(answer.slice(cut, at), "text"));
    cut = Math.max(cut, at);
    blocks.push(call.block);
  }
  return [...blocks, ...said(answer.slice(cut), "text")];
}

const TRACE_OF_TURN_MS = 60_000;
const RECOVERED_TRACE_OF_TURN_MS = 2 * TRACE_OF_TURN_MS;

export function tracedBlocks(threadId: string, messages: Message[], traces: readonly { timestamp: string; text: string }[]): Record<string, Block[]> {
  const recorded = traces
    .map((trace) => ({ at: Date.parse(trace.timestamp), spans: decodeSpans(trace.text), within: traceHeader(trace.text).recovered === "session" ? RECOVERED_TRACE_OF_TURN_MS : TRACE_OF_TURN_MS }))
    .filter((trace) => Number.isFinite(trace.at) && trace.spans.some(marked))
    .sort((left, right) => left.at - right.at);
  const turns: Record<string, Block[]> = {};
  let at = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const when = Date.parse(message.timestamp);
    if (!Number.isFinite(when)) continue;
    while (at + 1 < recorded.length && Math.abs(recorded[at + 1].at - when) <= Math.abs(recorded[at].at - when)) at += 1;
    const trace = recorded[at];
    if (!trace || Math.abs(trace.at - when) > trace.within) continue;
    at += 1;
    const { answer, thinking } = splitThinking(message.content);
    const blocks = restoreBlocks(threadId, trace.spans, { text: answer, thinking });
    if (blocks.some((block) => block.kind === "step" || isSteer(block))) turns[message.timestamp] = blocks;
  }
  return turns;
}

function rehydrate(threadId: string, token: number) {
  void Promise.all([window.emma.listSpans(), window.emma.livePartial()])
    .then(([spans, partial]) => {
      const restored = restoreBlocks(threadId, spans[threadId] ?? [], partial[threadId]);
      if (!restored.length || generations.get(threadId) !== token) return;
      write(threadId, (run) => {
        const calls = new Set(run.blocks.flatMap((block) => block.kind === "step" ? [block.step.toolCallId] : []));
        const held = run.blocks.filter((block) => !isSteer(block));
        const blocks = restored.flatMap((block): Block[] => {
          if (block.kind === "step") return calls.has(block.step.toolCallId) ? [] : [block];
          if (block.kind !== "text" && block.kind !== "thinking") return [block];
          const at = held.findIndex((other) => other.kind === block.kind);
          if (at < 0) return [block];
          const [taken] = held.splice(at, 1);
          return [{ kind: block.kind, text: joinPartial(block.text, "text" in taken ? taken.text : "") }];
        });
        return { blocks: [...blocks, ...held] };
      });
    })
    .catch(() => undefined);
}

function reconcile(live: LiveAgent[]) {
  for (const agent of live) {
    if (agent.status === "stopped" && runs.has(agent.threadId) && !read(agent.threadId).stopped) write(agent.threadId, { stopped: true });
    if (agent.status !== "running" && agent.status !== "waiting") continue;
    if (!read(agent.threadId).sending) adoptForeign(agent.threadId);
    if (!read(agent.threadId).pending && typeof agent.prompt === "string" && agent.prompt.trim()) {
      write(agent.threadId, { pending: { content: agent.prompt, after: 0, params: {} } });
    }
  }
  for (const [threadId, run] of runs) {
    if (!run.foreign) continue;
    if (live.some((agent) => agent.threadId === threadId && (agent.status === "running" || agent.status === "waiting"))) continue;

    began(threadId);
    write(threadId, (current) => ({ sending: false, foreign: false, landed: current.blocks.length ? [...current.landed, current.blocks] : current.landed }));

    if (read(threadId).queue.length) void drain(threadId, refresh);
  }
}

export function wire() {
  if (wired) return;
  wired = true;
  window.emma.onAgents(reconcile);
  void window.emma.listAgents().then(reconcile).catch(() => undefined);
  window.emma.onDelta(({ threadId, delta, thinking }) => {
    if (!read(threadId).sending) adoptForeign(threadId);

    if (!delta) {
      write(threadId, (run) => ({ blocks: run.blocks.at(-1)?.kind === "text" ? run.blocks.slice(0, -1) : run.blocks, activeAt: Date.now() }));
      return;
    }
    write(threadId, (run) => ({ blocks: appendText(run.blocks, thinking ? "thinking" : "text", delta), activeAt: Date.now() }));
  });
  window.emma.onStep((step) => {
    if (!read(step.threadId).sending) adoptForeign(step.threadId);
    write(step.threadId, (run) => ({ blocks: mergeStep(run.blocks, step), activeAt: Date.now() }));
  });
  window.emma.onCompacted(({ threadId, removedTurns, modelWritten }) => {
    if (!read(threadId).sending) adoptForeign(threadId);
    write(threadId, (run) => ({ blocks: [...run.blocks, { kind: "notice" as const, text: compactionNotice(removedTurns, modelWritten), plain: true }] }));
  });
  window.emma.onContextExperiment((fired) => {
    const { threadId, prunedResults, reinjected, savedTokens, addedTokens } = fired;
    if (!read(threadId).sending) adoptForeign(threadId);

    recordExperiment(threadId, fired);
    write(threadId, (run) => ({ blocks: [...run.blocks, { kind: "notice", text: experimentNotice(prunedResults, reinjected, savedTokens, addedTokens) }] }));
  });
  window.emma.onRoutedModel(({ threadId, model, fellBack }) => {
    if (!read(threadId).sending) adoptForeign(threadId);
    write(threadId, (run) => run.routed === model ? { routed: model } : {
      routed: model,
      blocks: fellBack ? [...run.blocks, { kind: "notice" as const, text: `Fell back to ${model} — the model above it stopped answering`, plain: true }] : run.blocks,
    });
  });
  window.emma.onContextBreakdown(({ threadId, ...parts }) => recordBreakdown(threadId, parts));
}

export function compactionNotice(removedTurns: number, modelWritten: boolean): string {
  const summary = modelWritten ? "a summary" : "a rough summary the model did not write";
  return `Context compacted — ${removedTurns} ${removedTurns === 1 ? "turn" : "turns"} became ${summary}`;
}

export function experimentNotice(prunedResults: number, reinjected: boolean, savedTokens = 0, addedTokens = 0): string {
  const pruned = prunedResults ? `${prunedResults} older tool ${prunedResults === 1 ? "result" : "results"} pruned${savedTokens ? ` (−${charLabel(savedTokens)} tokens)` : ""}` : "";
  const repeated = reinjected ? `your prompt repeated to the model${addedTokens ? ` (+${charLabel(addedTokens)} tokens)` : ""}` : "";
  return [pruned, repeated].filter(Boolean).join(", ");
}

export type RunFailure = { threadId: string; text: string };
export const RUN_ERROR_EVENT = "emma:run-error";

export const runOf = (threadId: string): Run => read(threadId);

export const turnToRetry = (threadId: string): QueuedTurn | null => {
  const run = read(threadId);
  return run.sending ? run.pending : null;
};

export function settleRun(threadId: string, messages: Message[], cached: Record<string, Block[]>): void {
  const run = read(threadId);
  const settled = run.landed.at(-1);
  if (run.sending || run.foreign || run.queue.length || !settled?.length || run.blocks !== settled) return;
  const paired = pairBlocks(messages, run.landed, {});
  if (paired.filter(Boolean).length < run.landed.length) return;
  for (const [at, blocks] of paired.entries()) {
    if (!blocks) continue;
    const message = messages[at];
    if (!blocks.length || !wrote(message.content, blocks) || !Array.isArray(cached[message.timestamp]) || !cached[message.timestamp].length) return;
  }
  write(threadId, { blocks: [], landed: [], pending: null });
}

export function useRun(threadId: string) {
  return useSyncExternalStore((listener) => {
    wire();
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => read(threadId));
}

export function sendTurn(threadId: string, turn: QueuedTurn, reload: () => unknown) {
  refresh = reload;
  write(threadId, (run) => ({ queue: [...run.queue, turn] }));
  if (!read(threadId).sending) void drain(threadId, reload);
}

const inFlight = (run: Run) => (run.sending && !run.foreign ? 1 : 0);

export const canSteer = (turn: QueuedTurn) => !turn.attached && Object.keys(turn.params).length === 0;

export function queuedTurns(run: Run) {
  return run.queue.slice(inFlight(run));
}

export function dropQueued(threadId: string, index: number) {
  write(threadId, (run) => ({ queue: run.queue.filter((_, at) => at !== index + inFlight(run)) }));
}

export function steerRunning(threadId: string, content: string) {
  const block: Block = { kind: "notice", text: content, plain: true, steer: true };
  write(threadId, (run) => ({ blocks: [...run.blocks, block] }));
  return window.emma.steerAgent({ threadId, text: content }).catch((reason: unknown) => {
    write(threadId, (run) => ({ blocks: run.blocks.filter((item) => item !== block) }));
    throw reason;
  });
}

export function steerQueued(threadId: string, index: number) {
  const run = read(threadId);
  const at = index + inFlight(run);
  const turn = run.queue[at];
  if (!turn || !canSteer(turn)) return;
  write(threadId, { queue: run.queue.filter((_, item) => item !== at) });
  void steerRunning(threadId, turn.content).catch((reason: unknown) => {
    write(threadId, (current) => ({ queue: [...current.queue.slice(0, inFlight(current)), turn, ...current.queue.slice(inFlight(current))] }));
    dispatchEvent(new CustomEvent<RunFailure>(RUN_ERROR_EVENT, { detail: { threadId, text: reasonText(reason) } }));
    interruptQueued(threadId, 0);
  });
}

export function interruptQueued(threadId: string, index: number) {
  const run = read(threadId);
  const at = index + inFlight(run);
  const turn = run.queue[at];
  if (!turn) return;
  if (run.pending?.prepare) run.pending.cancelled = true;
  const queue = [...run.queue];
  const [picked] = queue.splice(at, 1);
  queue.splice(inFlight(run), 0, picked);
  write(threadId, { queue });
  window.emma.stopAgent(threadId);
}

export function stopTurn(threadId: string, turn?: QueuedTurn, reload: () => unknown = refresh) {
  const run = read(threadId);
  if (run.pending?.prepare) run.pending.cancelled = true;
  write(threadId, {
    queue: [...run.queue.slice(0, inFlight(run)), ...(turn ? [turn] : [])],
    held: [...run.held, ...run.queue.slice(inFlight(run))],
  });
  window.emma.stopAgent(threadId);
  if (turn && !run.sending) void drain(threadId, reload);
}

export function releaseHeld(threadId: string, index: number, reload: () => unknown) {
  const turn = read(threadId).held[index];
  if (!turn) return;
  write(threadId, (run) => ({ held: run.held.filter((_, at) => at !== index) }));
  sendTurn(threadId, turn, reload);
}

export function dropHeld(threadId: string, index: number) {
  write(threadId, (run) => ({ held: run.held.filter((_, at) => at !== index) }));
}

export function takeDraft(threadId: string) {
  const { draft } = read(threadId);
  if (draft) write(threadId, { draft: "" });
  return draft;
}

async function drain(threadId: string, reload: () => unknown) {
  for (;;) {
    const next = read(threadId).queue[0];
    if (!next) return;
    began(threadId);
    write(threadId, {
      sending: true, foreign: false, pending: next, stopped: false, activeAt: Date.now(),
      blocks: next.notice ? [{ kind: "notice", text: next.notice, plain: true }] : [],
    });
    let failed = false;
    try {
      if (next.prepare) {
        Object.assign(next, await next.prepare());
        delete next.prepare;
      }
      if (next.cancelled) write(threadId, { pending: null, draft: next.content, stopped: true });
      else {
        await window.emma.request("sendMessage", { threadId, content: next.content, ...next.params });
        next.delivered?.();
      }
    } catch (reason) {
      failed = true;
      write(threadId, { pending: null, blocks: [], draft: next.content });
      dispatchEvent(new CustomEvent<RunFailure>(RUN_ERROR_EVENT, { detail: { threadId, text: reasonText(reason) } }));
      await reload();
    }

    write(threadId, (run) => ({
      sending: false,
      queue: run.queue.slice(1),
      landed: failed || !run.blocks.length ? run.landed : [...run.landed, run.blocks],
    }));
  }
}
