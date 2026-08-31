import { usageDay } from "../shared/invocations";
import type { Thread } from "./types";

export interface DayGrid {
  weeks: string[][];
  months: { label: string; column: number }[];
}

export interface ProjectActivity {
  name: string;
  threads: number;
  messages: number;
  days: Record<string, number>;
  lastAt: number;
}

export interface LineageRow {
  thread: Thread;
  depth: number;
  open: number[];
  up: boolean;
  down: boolean;
  elbow: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_WEEKS = 54;

export function dayOf(stamp: string): string {
  const at = new Date(stamp);
  return Number.isNaN(at.getTime()) ? "" : usageDay(at);
}

export function countDays(stamps: string[]): Record<string, number> {
  const days: Record<string, number> = {};
  for (const stamp of stamps) {
    const key = dayOf(stamp);
    if (key) days[key] = (days[key] ?? 0) + 1;
  }
  return days;
}

export const messageDays = (threads: Thread[]) => countDays(threads.flatMap((thread) => thread.messages.map((message) => message.timestamp)));

export function weekGrid(from: Date, to: Date): DayGrid {
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  cursor.setDate(cursor.getDate() - cursor.getDay());
  const last = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  const weeks: string[][] = [];
  const months: { label: string; column: number }[] = [];
  while (cursor.getTime() <= last && weeks.length < MAX_WEEKS) {
    const week: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const label = MONTHS[cursor.getMonth()];
      if (!index && cursor.getDate() <= 7 && months.at(-1)?.label !== label) months.push({ label, column: weeks.length });
      week.push(usageDay(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return { weeks, months };
}

export const heatLevel = (count: number, peak: number) => count <= 0 ? 0 : Math.min(4, Math.ceil(count / Math.max(peak, 1) * 4));

export function streak(days: Record<string, number>, today = new Date()): number {
  const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!days[usageDay(cursor)]) cursor.setDate(cursor.getDate() - 1);
  let run = 0;
  while (days[usageDay(cursor)] && run < 4000) {
    run += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return run;
}

export function activeYears(days: Record<string, number>, today = new Date()): number[] {
  const earliest = Object.keys(days).sort()[0];
  const first = Number(earliest?.slice(0, 4)) || today.getFullYear();
  const years: number[] = [];
  for (let year = today.getFullYear(); year >= first && years.length < 40; year -= 1) years.push(year);
  return years;
}

export function projectActivity(threads: Thread[], nameOf: (thread: Thread) => string): ProjectActivity[] {
  const rows = new Map<string, ProjectActivity>();
  for (const thread of threads) {
    const name = nameOf(thread) || "Other";
    const row = rows.get(name) ?? { name, threads: 0, messages: 0, days: {}, lastAt: 0 };
    row.threads += 1;
    row.messages += thread.messages.length;
    row.lastAt = Math.max(row.lastAt, new Date(thread.updatedAt).getTime() || 0);
    for (const message of thread.messages) {
      const key = dayOf(message.timestamp);
      if (key) row.days[key] = (row.days[key] ?? 0) + 1;
    }
    rows.set(name, row);
  }
  return [...rows.values()].sort((left, right) => right.messages - left.messages || right.threads - left.threads);
}

export function lineage(threads: Thread[], limit: number): LineageRow[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const children = new Map<string, Thread[]>();
  const roots: Thread[] = [];
  for (const thread of threads) {
    const parent = thread.parentThreadId && byId.has(thread.parentThreadId) ? thread.parentThreadId : "";
    if (!parent) { roots.push(thread); continue; }
    children.set(parent, [...(children.get(parent) ?? []), thread]);
  }
  const recent = (left: Thread, right: Thread) => right.updatedAt.localeCompare(left.updatedAt);
  for (const list of children.values()) list.sort(recent);
  roots.sort(recent);

  const rows: LineageRow[] = [];
  const walk = (thread: Thread, depth: number, open: number[], first: boolean, last: boolean) => {
    if (rows.length >= limit) return;
    const kids = children.get(thread.id) ?? [];
    rows.push({
      thread,
      depth,
      open,
      up: depth > 0 ? false : !first,
      down: kids.length > 0 || (!depth && !last),
      elbow: depth > 0,
    });
    const nested = last ? open : [...open, depth];
    kids.forEach((kid, index) => walk(kid, depth + 1, nested, !index, index === kids.length - 1));
  };
  roots.forEach((root, index) => walk(root, 0, [], !index, index === roots.length - 1));
  return rows;
}
