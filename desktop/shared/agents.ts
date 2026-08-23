/* The live agent tree. Main owns the running loops; the renderer only ever reads
   these records, so everything here is plain data with no handles in it. */

import type { PermissionMode } from "./permissions";

/** How deep `task` may nest. A subagent that could spawn again is a fork bomb with a credit card. */
export const MAX_AGENT_DEPTH = 2;
export const MAX_LIVE_SUBAGENTS = 8;
/**
 * Threads that may have an agent working in them at once. A spawned thread's
 * agent can spawn threads of its own, so the same ceiling `task` needs is the
 * one this needs — for the same reason, and counted across the whole process.
 */
export const MAX_LIVE_THREADS = 8;

/**
 * What a `threads` spawn prints at the end of its first line, so the transcript
 * can draw the thread it started instead of a sentence saying that it did — the
 * same trick `ARTIFACT_MARKER` plays. The title rides along because a card is
 * drawn from the tool result alone, with no second lookup.
 */
export const THREADS_MARKER = /\[threads:([a-z0-9-]{1,96}):([^\]\n]{1,128})]$/;

/** One spawned thread, as the transcript's card reads it back off a tool result. */
export function spawnedThread(output: string | undefined): { id: string; title: string } | undefined {
  const found = THREADS_MARKER.exec((output ?? "").split("\n", 1)[0].trim());
  return found ? { id: found[1], title: found[2] } : undefined;
}

/**
 * A turn one thread sent into another, marked at the head of the message itself.
 *
 * Sender travels in the text because a stored message is a role and a string and
 * nothing else. It earns its place twice over: the transcript names the thread
 * instead of calling it "You", and the agent reading it knows it is being talked
 * to by another agent rather than by the user.
 */
const FROM_THREAD_MARKER = /^\[thread ([a-z0-9-]{1,96}) messaged]\n/;

export function fromThread(sender: string, text: string): string {
  return `[thread ${sender} messaged]\n${text}`;
}

/** Who sent a stored turn, and its text with the marker taken back off. */
export function sentByThread(content: string): { from?: string; body: string } {
  const found = FROM_THREAD_MARKER.exec(content);
  return found ? { from: found[1], body: content.slice(found[0].length) } : { body: content };
}

/* Stable, distinguishable at a 8px dot, and readable on both themes. Assigned by
   spawn order and never reused while the parent turn is alive. */
export const AGENT_COLORS = [
  "#4f9dff",
  "#f2a13c",
  "#57c785",
  "#c77dff",
  "#ff6b81",
  "#3fc7d4",
  "#e0c341",
  "#8f9bff",
] as const;

export function agentColor(index: number): string {
  return AGENT_COLORS[index % AGENT_COLORS.length];
}

export type AgentStatus = "running" | "waiting" | "done" | "failed" | "stopped";

export type LiveAgent = {
  threadId: string;
  /** Absent on the root agent of a turn. */
  parentThreadId?: string;
  title: string;
  color: string;
  status: AgentStatus;
  mode: PermissionMode;
  model: string;
  /** What it is doing right now, in the user's words — "reading src/main.ts", "bash". */
  activity: string;
  startedAt: number;
  endedAt?: number;
  steps: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Milliseconds of model generation, so tokens per second is honest about wall time. */
  generationMs: number;
  /** Set when the loop ended badly, for the tab to show instead of a blank transcript. */
  error?: string;
};

export function tokensPerSecond(agent: Pick<LiveAgent, "outputTokens" | "generationMs">): number {
  return agent.generationMs > 0 ? agent.outputTokens / (agent.generationMs / 1000) : 0;
}

/**
 * One tool call, live. The coding harness reports these as it works; the
 * transcript shows them so a turn is not silent between the prompt and the answer.
 */
export type ThreadStep = {
  threadId: string;
  toolCallId: string;
  title: string;
  /** ACP's tool kind — `read`, `edit`, `execute`, `search`, `fetch`, `other`. */
  kind: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  /** The call's arguments, as JSON. ACP sends these once, on the opening `tool_call`. */
  input?: string;
  output?: string;
  /** When this status was observed, so a run can be laid out on a timeline. */
  at: number;
  /**
   * What the call did to a file, when it wrote one. Stamped where the change is
   * seen — both loops already build the before/after pair for the Changes tab —
   * so the transcript can read `Edited knowledge.rs +145 −1` off the step rather
   * than re-deriving it from a tool name and a JSON argument blob it does not
   * own the shape of.
   */
  edit?: { path: string; added: number; removed: number };
};

/**
 * What a thread's subagents run on, as the inspector set it: an OpenRouter model ID
 * and the thinking effort to ask it for. Set on the child thread before its first
 * step, so a subagent runs its whole life on one model.
 */
export type SubagentRoute = { model: string; effort: string };

/** A pending question from the loop. Lives here because both main and the renderer name it. */
export type PermissionAsk = {
  id: string;
  threadId: string;
  tool: string;
  summary: string;
  /** The argument worth reading before approving: a command line, a path. */
  detail: string;
};

/** One file the agent rewrote, kept so the changes tab can show a diff and revert it. */
export type FileChange = {
  folderId: string;
  path: string;
  /** Null when the tool created the file. */
  before: string | null;
  after: string;
  at: number;
};

/** A command still running after the tool call that started it returned. */
export type BackgroundTask = {
  id: string;
  command: string;
  /** Name of the folder it was started in, for the sidebar row. */
  folder: string;
  status: "running" | "exited";
  /** Null while running, and for a command that never started. */
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
};

export type DiffStat = { added: number; removed: number; files: number };

/* ponytail: line-level LCS on files bounded to MAX_FILE_BYTES. A word-level diff
   reads better on prose; swap the unit if the changes tab is used for writing. */
export function diffLines(before: string, after: string): { kind: " " | "+" | "-"; text: string }[] {
  const left = before.length ? before.split("\n") : [];
  const right = after.length ? after.split("\n") : [];
  // Trim the matching head and tail first: edits are local, and this keeps the
  // quadratic table off whole-file rewrites of otherwise identical content.
  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1;
  let tail = 0;
  while (tail < left.length - head && tail < right.length - head && left[left.length - 1 - tail] === right[right.length - 1 - tail]) tail += 1;
  const a = left.slice(head, left.length - tail);
  const b = right.slice(head, right.length - tail);
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: { kind: " " | "+" | "-"; text: string }[] = left.slice(0, head).map((text) => ({ kind: " " as const, text }));
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: " ", text: a[i] }); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { out.push({ kind: "-", text: a[i] }); i += 1; }
    else { out.push({ kind: "+", text: b[j] }); j += 1; }
  }
  for (; i < a.length; i += 1) out.push({ kind: "-", text: a[i] });
  for (; j < b.length; j += 1) out.push({ kind: "+", text: b[j] });
  for (const text of left.slice(left.length - tail)) out.push({ kind: " ", text });
  return out;
}

/** One write, as the step that made it reports it. */
export function editStat(change: FileChange): NonNullable<ThreadStep["edit"]> {
  const { added, removed } = diffStat([change]);
  return { path: change.path, added, removed };
}

export function diffStat(changes: FileChange[]): DiffStat {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    for (const line of diffLines(change.before ?? "", change.after)) {
      if (line.kind === "+") added += 1;
      else if (line.kind === "-") removed += 1;
    }
  }
  return { added, removed, files: changes.length };
}

/** Latest write per file wins, so the tab diffs against what was there before the turn. */
export function collapseChanges(changes: FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const change of changes) {
    const key = `${change.folderId}:${change.path}`;
    const first = byPath.get(key);
    byPath.set(key, first ? { ...change, before: first.before } : change);
  }
  return [...byPath.values()].filter((change) => change.before !== change.after);
}
