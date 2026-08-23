/* A turn's live state, kept outside React. The thread pane is keyed by thread id,
   so moving to another project unmounts it — and the turn it started has to
   outlive that. Everything a running turn owns lives here instead: what the agent
   is streaming, what is queued behind it, and what failed. */

import { useSyncExternalStore } from "react";
import type { ThreadStep } from "../shared/agents";
import { readVisualization, type Visualization } from "../shared/visualize";
import { charLabel } from "../shared/usage";
import type { Message } from "./types";
import { recordExperiment } from "./context";
import { reasonText } from "./errors";

/** One prompt, ready to hand over: the composer resolves its context at Enter, not at send. */
export type QueuedTurn = {
  content: string;
  /** Messages already in the thread when this was typed — where its echo stops standing in. */
  after: number;
  params: Record<string, string>;
  /** Called only if the host took it, so the context ledger records deliveries, not attempts. */
  delivered?: () => void;
};

/**
 * One piece of a turn, in the order it arrived: what the agent said, what it
 * thought, or one thing it did.
 *
 * A turn is not one answer with a list of tool calls under it — it is an
 * alternation, and holding the text in a single buffer glued every stretch of
 * narration to the next one with no boundary between them. The boundary is the
 * point, so the arrival order is what is kept.
 */
export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "step"; step: ThreadStep }
  /** Something the harness did to the window mid-turn, in the place it happened. */
  | { kind: "notice"; text: string };

/**
 * The blocks of each landed turn, against the message it produced — the stored
 * copy of a turn is one string and has lost the boundaries.
 *
 * This session's turns match from the end, since `landed` holds the last ones the
 * thread ran; everything before them comes from the cache, by the timestamp of the
 * message itself. A turn older than the cache keeps has only its string and reads
 * as one, the way every turn did before any of this was kept.
 */
export function pairBlocks(messages: Message[], landed: Block[][], cached: Record<string, Block[]>): (Block[] | undefined)[] {
  const assistants = messages.reduce((count, item) => item.role === "assistant" ? count + 1 : count, 0);
  let seen = -1;
  return messages.map((item) => {
    if (item.role !== "assistant") return undefined;
    seen += 1;
    return landed[seen - (assistants - landed.length)] ?? cached[item.timestamp];
  });
}

/**
 * Whether a message really is the turn it was paired with: the stored string
 * contains the words this session streamed, so a few of them are enough to tell.
 *
 * Matching from the end is only provisional — the reply of a turn that just landed
 * reaches the transcript a moment after the run does, and until it arrives every
 * pair is off by one. Those are worth drawing, since the next render corrects them,
 * but not worth keeping: this is what stops one being cached against the wrong reply.
 */
export function wrote(content: string, blocks: Block[]): boolean {
  const said = blocks.find((block) => (block.kind === "text" || block.kind === "thinking") && block.text.trim().length > 8);
  return !said || content.includes((said as { text: string }).text.trim().slice(0, 40));
}

/** A turn's blocks as the transcript draws them: prose in place, tool calls in lists. */
export type Grouped =
  | { kind: "text" | "thinking" | "notice"; text: string }
  /** `keep` is how many of these rows the list may show before the rest fold away. */
  | { kind: "steps"; steps: ThreadStep[]; keep: number }
  /** A picture the turn drew, in the flow where it drew it. */
  | { kind: "visual"; visual: Visualization };

/**
 * Consecutive calls fold into one list, so a burst of them reads as a block of work
 * and not as a stack of one-row lists — `keep` of its rows plainly, the rest behind
 * the caret.
 *
 * A burst ends where prose does. The budget used to be spent across the whole turn
 * into a single shared list, which was pushed where the *first* call happened and
 * then went on collecting every call after it — so a turn read as one lump of tool
 * calls at the top followed by all of its words, whatever order it really went in,
 * and a call made after a line of narration was drawn above the line it followed.
 *
 * A `visualize` call is the exception, and it leaves the list entirely: the fold
 * exists because a call is machinery beside the answer, and a picture drawn to
 * explain the answer *is* the answer. Behind the caret it would be a chart nobody
 * ever sees, so it becomes its own block, in the place it happened.
 */
export function groupBlocks(blocks: Block[], keep: number): Grouped[] {
  const grouped: Grouped[] = [];
  for (const block of blocks) {
    const visual = block.kind === "step" ? readVisualization(block.step) : undefined;
    if (visual) grouped.push({ kind: "visual", visual });
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
  /** Driven by another window — Quick Ask, a quick action — so `drain` is not what ends it. */
  foreign: boolean;
  /** The turn handed over, echoed until the host's own copy of it lands. */
  pending: QueuedTurn | null;
  blocks: Block[];
  /**
   * The blocks of every turn this session has landed, oldest first — one entry
   * per assistant message it wrote, newest last.
   *
   * A turn used to hand its blocks straight back to `blocks`, which the next
   * turn then cleared, so sending a second prompt erased the first turn's tool
   * calls and its narration boundaries and left the flat stored string in their
   * place. It read as Emma deleting its own work.
   */
  landed: Block[][];
  /** In flight first, then everything typed while it worked. */
  queue: QueuedTurn[];
  error: string;
  /** The last turn on this thread ended because the user stopped it, not because it finished. */
  stopped: boolean;
  /** A turn that never landed, put back in the composer whenever one is mounted. */
  draft: string;
};

const IDLE: Run = { sending: false, foreign: false, pending: null, blocks: [], landed: [], queue: [], error: "", stopped: false, draft: "" };
const runs = new Map<string, Run>();
const listeners = new Set<() => void>();
let wired = false;
/// The last reload a composer handed over, so a queue that was waiting on someone
/// else's turn can still drain when that turn ends.
let refresh: () => unknown = () => undefined;
const read = (threadId: string) => runs.get(threadId) ?? IDLE;

function write(threadId: string, change: Partial<Run> | ((run: Run) => Partial<Run>)) {
  const current = read(threadId);
  runs.set(threadId, { ...current, ...(typeof change === "function" ? change(current) : change) });
  for (const listener of listeners) listener();
}

/// Text joins the block it is still writing, and opens a new one otherwise —
/// which is what puts a break either side of every tool call.
export function appendText(blocks: Block[], kind: "text" | "thinking", delta: string): Block[] {
  const tail = blocks.at(-1);
  return tail?.kind === kind
    ? [...blocks.slice(0, -1), { kind, text: tail.text + delta }]
    : [...blocks, { kind, text: delta }];
}

/// Latest status per tool call wins, updated where the call started rather than
/// appended: a call that finishes belongs next to the text that opened it, not at
/// the end of a turn that has moved on without it.
export function mergeStep(blocks: Block[], step: ThreadStep): Block[] {
  const at = blocks.findIndex((block) => block.kind === "step" && block.step.toolCallId === step.toolCallId);
  if (at < 0) return [...blocks, { kind: "step", step }];
  const next = [...blocks];
  next[at] = { kind: "step", step };
  return next;
}

/// A turn this window never sent: the notch asks in a thread of its own, and the
/// workspace was showing that thread empty until the whole turn landed. Its deltas
/// and tool calls arrive here all the same, so the run is opened on the first one
/// and closed again when main stops reporting the agent as alive.
function adoptForeign(threadId: string) {
  write(threadId, { sending: true, foreign: true, blocks: [], pending: null, error: "", stopped: false });
}

/// One pair of listeners for every thread rather than one per pane: a delta for a
/// thread nobody is looking at still belongs to its run.
export function wire() {
  if (wired) return;
  wired = true;
  window.emma.onAgents((live) => {
    // A stopped turn ends with no closing message — asking the model for one is
    // more generation, which is what the button ended — so this is the only thing
    // in the transcript that says why it went quiet.
    for (const agent of live) {
      if (agent.status === "stopped" && runs.has(agent.threadId) && !read(agent.threadId).stopped) write(agent.threadId, { stopped: true });
    }
    for (const [threadId, run] of runs) {
      if (!run.foreign) continue;
      if (live.some((agent) => agent.threadId === threadId && (agent.status === "running" || agent.status === "waiting"))) continue;
      // Its blocks stand in for the message it just wrote, exactly as a turn
      // this window sent does — `drain` is not the only way a turn ends here.
      write(threadId, (current) => ({ sending: false, foreign: false, landed: current.blocks.length ? [...current.landed, current.blocks] : current.landed }));
      // Anything typed here while the other window's turn ran was queued rather
      // than sent, so this is where it finally goes.
      if (read(threadId).queue.length) void drain(threadId, refresh);
    }
  });
  window.emma.onDelta(({ threadId, delta, thinking }) => {
    if (!read(threadId).sending) adoptForeign(threadId);
    // An empty delta is the loop restarting the answer on a fallback provider, so
    // it drops the answer it is about to rewrite and keeps the reasoning behind it.
    if (!delta) {
      write(threadId, (run) => ({ blocks: run.blocks.at(-1)?.kind === "text" ? run.blocks.slice(0, -1) : run.blocks }));
      return;
    }
    write(threadId, (run) => ({ blocks: appendText(run.blocks, thinking ? "thinking" : "text", delta) }));
  });
  window.emma.onStep((step) => {
    if (!read(step.threadId).sending) adoptForeign(step.threadId);
    write(step.threadId, (run) => ({ blocks: mergeStep(run.blocks, step) }));
  });
  window.emma.onContextExperiment((fired) => {
    const { threadId, prunedResults, reinjected, savedTokens, addedTokens } = fired;
    if (!read(threadId).sending) adoptForeign(threadId);
    // Totalled per thread here rather than in the pane: the pane is unmounted
    // whenever you are looking at another project, and the step still happened.
    recordExperiment(threadId, fired);
    write(threadId, (run) => ({ blocks: [...run.blocks, { kind: "notice", text: experimentNotice(prunedResults, reinjected, savedTokens, addedTokens) }] }));
  });
}

/// What the two levers did, in the user's words. Both can fire on the same step,
/// and the count is the point of the pruning one: "tools pruned" without a number
/// reads as an error rather than as the setting the user switched on doing its job.
/// The token figures are what each lever did to that one request — the whole
/// reason for switching either on — so they ride the same line, signed.
export function experimentNotice(prunedResults: number, reinjected: boolean, savedTokens = 0, addedTokens = 0): string {
  const pruned = prunedResults ? `${prunedResults} older tool ${prunedResults === 1 ? "result" : "results"} pruned${savedTokens ? ` (−${charLabel(savedTokens)} tokens)` : ""}` : "";
  const repeated = reinjected ? `your prompt repeated to the model${addedTokens ? ` (+${charLabel(addedTokens)} tokens)` : ""}` : "";
  return [pruned, repeated].filter(Boolean).join(", ");
}

export function useRun(threadId: string) {
  return useSyncExternalStore((listener) => {
    wire();
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => read(threadId));
}

/**
 * Sends a turn, or queues it behind the one already running. Enter never blocks
 * and never interrupts: steering is the other door into a running turn.
 */
export function sendTurn(threadId: string, turn: QueuedTurn, reload: () => unknown) {
  refresh = reload;
  write(threadId, (run) => ({ queue: [...run.queue, turn] }));
  if (!read(threadId).sending) void drain(threadId, reload);
}

/** Drops something still waiting. Index counts from the first queued turn, not the running one. */
export function dropQueued(threadId: string, index: number) {
  write(threadId, (run) => ({ queue: run.queue.filter((_, at) => at !== index + (run.sending ? 1 : 0)) }));
}

/** Hands back the text of a failed turn once, for whichever composer asks first. */
export function takeDraft(threadId: string) {
  const { draft } = read(threadId);
  if (draft) write(threadId, { draft: "" });
  return draft;
}

async function drain(threadId: string, reload: () => unknown) {
  for (;;) {
    const next = read(threadId).queue[0];
    if (!next) return;
    write(threadId, { sending: true, foreign: false, pending: next, blocks: [], error: "", stopped: false });
    let failed = false;
    try {
      await window.emma.request("sendMessage", { threadId, content: next.content, ...next.params });
      next.delivered?.();
    } catch (reason) {
      // Blocks go with the failed turn: they belong to a message that never
      // landed, and left behind they would attach to the turn before it.
      failed = true;
      write(threadId, { pending: null, blocks: [], error: reasonText(reason), draft: next.content });
      await reload();
    }
    // The blocks outlive the stream and stand in for the landed message: the host
    // stores a turn as one string, so re-reading it from there is what collapsed
    // the turn back into a wall of text the moment it finished. Kept per turn
    // rather than in one buffer, so the next prompt does not take the last turn's
    // transcript down with it. The transcript caches them against the message they
    // wrote, which is what carries them past a restart.
    write(threadId, (run) => ({
      sending: false,
      queue: run.queue.slice(1),
      landed: failed || !run.blocks.length ? run.landed : [...run.landed, run.blocks],
    }));
  }
}
