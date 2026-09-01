import { agentColor, sentByThread, type LiveAgent } from "../shared/agents";
import type { Message, Thread } from "./types";

export function threadLabel(thread: Thread, limit = 48): string {
  const title = thread.title.trim();
  if (title && title !== "New thread") return title;
  const first = thread.labelPrompt ?? thread.messages.find((item) => item.role === "user")?.content ?? "";
  const asked = sentByThread(first).body.trim().replace(/\s+/g, " ");
  if (asked) return asked.length > limit ? `${asked.slice(0, limit - 1)}…` : asked;
  return thread.displayTitle?.trim() || "New thread";
}

export function nested(threads: Thread[], parent = ""): Thread[] {
  const ids = new Set(threads.map((item) => item.id));
  const children = new Map<string, Thread[]>();
  for (const item of threads) {
    const owner = ids.has(item.parentThreadId ?? "") ? item.parentThreadId ?? "" : "";
    const kin = children.get(owner);
    if (kin) kin.push(item);
    else children.set(owner, [item]);
  }
  const under = (owner: string): Thread[] => (children.get(owner) ?? [])
    .map((item) => {
      const kin = under(item.id);
      return { item, kin, at: kin.reduce((latest, child) => Math.max(latest, stamp(child)), stamp(item)) };
    })
    .sort((left, right) => right.at - left.at)
    .flatMap((entry) => [entry.item, ...entry.kin]);
  return under(parent);
}

function stamp(thread: Thread): number {
  return Date.parse(thread.updatedAt) || 0;
}

export function newest(threads: Thread[]): number {
  return threads.reduce((latest, item) => Math.max(latest, stamp(item)), 0);
}

export function since(thread: Thread, now = Date.now()): string {
  const minutes = Math.round((now - stamp(thread)) / 60_000);
  if (!stamp(thread) || !Number.isFinite(minutes)) return "—";
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

export function threadDepth(threads: Thread[], thread: Thread): number {
  let depth = 0;
  let owner = ownerIn(threads, thread);
  while (owner && depth < 8) {
    depth += 1;
    owner = ownerIn(threads, threads.find((item) => item.id === owner)!);
  }
  return depth;
}

export function ownerIn(threads: Thread[], thread: Thread): string {
  const parent = thread.parentThreadId ?? "";
  return threads.some((item) => item.id === parent) ? parent : "";
}

export function threadAt(projects: { threads: Thread[] }[], current: string, index: number): string {
  const group = projects.find((item) => item.threads.some((entry) => entry.id === current)) ?? projects[0];
  return group?.threads[index]?.id ?? "";
}

export type Spawned = { id: string; name: string; brief: string; color: string; at: number };

export function spawnedAgents(threads: Thread[], agents: LiveAgent[], parentThreadId: string): Spawned[] {
  const found = new Map<string, Spawned>();
  for (const item of threads) {
    if (item.kind !== "subagent" || item.parentThreadId !== parentThreadId) continue;
    const asked = sentByThread(item.subagentBrief ?? item.messages.find((message) => message.role === "user")?.content ?? "").body;
    found.set(item.id, { id: item.id, name: item.title, brief: asked.trim().replace(/\s+/g, " "), color: "", at: Date.parse(item.createdAt) || 0 });
  }
  for (const agent of agents) {
    if (agent.parentThreadId !== parentThreadId) continue;
    const known = found.get(agent.threadId);
    found.set(agent.threadId, {
      id: agent.threadId,
      name: agent.title,
      brief: known?.brief || agent.activity,
      color: agent.color,
      at: known?.at || agent.startedAt,
    });
  }
  return [...found.values()]
    .sort((left, right) => left.at - right.at)
    .map((item, index) => item.color ? item : { ...item, color: agentColor(index) });
}

export function spawnedByTurn(messages: Message[], spawned: Spawned[]): { turns: Map<number, Spawned[]>; loose: Spawned[] } {
  const ends = messages.map((item) => item.role === "assistant" ? Date.parse(item.timestamp) : NaN);
  const turns = new Map<number, Spawned[]>();
  const loose: Spawned[] = [];
  for (const agent of spawned) {
    const index = ends.findIndex((end) => end >= agent.at);
    if (index < 0) loose.push(agent);
    else turns.set(index, [...(turns.get(index) ?? []), agent]);
  }
  return { turns, loose };
}
