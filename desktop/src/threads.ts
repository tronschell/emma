/* How the sidebar shapes the thread list: what each row is called, which rows own
   which, and what order they stand in. Pure functions over the snapshot — the
   filing into projects is `threadFolders` in context.ts, and everything visual is
   in App. */

import { sentByThread } from "../shared/agents";
import type { Thread } from "./types";

/// The host names every thread "New thread" until it is renamed, so fall back to what was asked.
export function threadLabel(thread: Thread): string {
  const title = thread.title.trim();
  if (title && title !== "New thread") return title;
  const first = thread.messages.find((item) => item.role === "user")?.content ?? "";
  const asked = sentByThread(first).body.trim().replace(/\s+/g, " ");
  if (!asked) return "New thread";
  return asked.length > 48 ? `${asked.slice(0, 47)}…` : asked;
}

/// Sub threads read as a list under the thread that started them, so a project
/// group is ordered parent-first and each child follows its own parent. A thread
/// whose parent is not in this group — filed elsewhere, archived — is listed at
/// the top level here rather than disappearing with it.
///
/// Within one level the order is latest activity first, and a branch is ranked by
/// the newest thing anywhere under it: an answer landing in a sub thread pulls the
/// whole branch to the top, because what the user is looking for after an agent
/// replies is the conversation that just moved, not the one that owns it.
export function nested(threads: Thread[], parent = ""): Thread[] {
  return threads
    .filter((item) => ownerIn(threads, item) === parent)
    .map((item) => {
      const under = nested(threads, item.id);
      return { item, under, at: under.reduce((latest, child) => Math.max(latest, stamp(child)), stamp(item)) };
    })
    .sort((left, right) => right.at - left.at)
    .flatMap((entry) => [entry.item, ...entry.under]);
}

/// When a thread last had anything said in it. A thread file with an unreadable
/// date sorts last rather than to the top, where `NaN` would have put it.
function stamp(thread: Thread): number {
  return Date.parse(thread.updatedAt) || 0;
}

/// How long since a thread last had anything said in it, in the width a 288px
/// column can spare: "<1m", "12m", "3h", "5d". A duration rather than "now",
/// because it is read both on its own and inside "last moved … ago". `now` is a
/// parameter so the same row can be asserted about without waiting for a clock.
export function since(thread: Thread, now = Date.now()): string {
  const minutes = Math.round((now - stamp(thread)) / 60_000);
  if (!stamp(thread) || !Number.isFinite(minutes)) return "—";
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/// How deep to indent one row: the number of owners above it that are on screen.
export function threadDepth(threads: Thread[], thread: Thread): number {
  let depth = 0;
  let owner = ownerIn(threads, thread);
  // Parents are always older than their children, so a chain cannot loop; the
  // cap is only so a hand-edited thread file cannot hang the sidebar.
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
