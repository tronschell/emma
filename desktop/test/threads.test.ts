import assert from "node:assert/strict";
import test from "node:test";

const stored = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value); },
};
(globalThis as unknown as { dispatchEvent: unknown }).dispatchEvent = () => true;

import { nested, newest, since, spawnedAgents, spawnedByTurn, threadAt, threadDepth, threadLabel } from "../src/threads";
import { handTags, pinnedThreads, setThreadPinned, setThreadTag, setThreadUnread, threadTags, unreadThreads } from "../src/context";
import type { Thread } from "../src/types";
import { AGENT_COLORS, type LiveAgent } from "../shared/agents";

function thread(id: string, updatedAt: string, parentThreadId?: string): Thread {
  return {
    id, title: "New thread", createdAt: "2026-01-01T00:00:00Z", updatedAt, messages: [], parentThreadId,
  };
}

test("the sidebar lists whatever moved last first, branch and all", () => {
  const threads = [
    thread("a", "2026-01-01T10:00:00Z"),
    thread("b", "2026-01-01T09:00:00Z"),
    thread("c", "2026-01-01T08:00:00Z"),
  ];
  assert.deepEqual(nested(threads).map((item) => item.id), ["a", "b", "c"]);

  threads[2] = thread("c", "2026-01-01T11:00:00Z");
  assert.deepEqual(nested(threads).map((item) => item.id), ["c", "a", "b"]);

  assert.deepEqual(nested([...threads, thread("d", "not a date")]).map((item) => item.id), ["c", "a", "b", "d"]);
});

test("a sub thread stays under its owner and carries it up the list", () => {
  const threads = [
    thread("a", "2026-01-01T10:00:00Z"),
    thread("b", "2026-01-01T09:00:00Z"),
    thread("b-sub", "2026-01-01T11:00:00Z", "b"),
    thread("orphan", "2026-01-01T12:00:00Z", "filed-elsewhere"),
  ];
  assert.deepEqual(nested(threads).map((item) => item.id), ["orphan", "b", "b-sub", "a"]);
  assert.equal(threadDepth(threads, threads[3]), 0);
  assert.equal(threadDepth(threads, threads[2]), 1);
});

test("an idle sub thread says how long ago it moved, in one column's worth", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const at = (updatedAt: string) => since(thread("a", updatedAt), now);
  assert.equal(at("2026-01-01T11:59:40Z"), "<1m");
  assert.equal(at("2026-01-01T11:48:00Z"), "12m");
  assert.equal(at("2026-01-01T09:00:00Z"), "3h");
  assert.equal(at("2025-12-27T12:00:00Z"), "5d");
  assert.equal(at("not a date"), "—");
});

test("the tags offered back are the user's own, normalized and most-used first", () => {
  stored.clear();
  setThreadTag("t1", "Billing");
  setThreadTag("t2", " billing ");
  setThreadTag("t3", "research");
  assert.deepEqual(handTags(), ["billing", "research"]);

  stored.clear();
  setThreadTag("t1", "billing", true);
  assert.deepEqual(handTags(), []);
});

test("a guess never lands on a tag the user applied, and is always correctable", () => {
  stored.clear();
  setThreadTag("mine", "billing");
  setThreadTag("mine", "research", true);
  assert.deepEqual(threadTags().mine, { tag: "billing", auto: false });

  setThreadTag("guessed", "research", true);
  assert.deepEqual(threadTags().guessed, { tag: "research", auto: true });
  setThreadTag("guessed", "billing");
  assert.deepEqual(threadTags().guessed, { tag: "billing", auto: false });
  setThreadTag("guessed", "  ");
  assert.equal(threadTags().guessed, undefined);
});

test("an unnamed thread is called after what was asked in it", () => {
  const asked: Thread = { ...thread("a", "2026-01-01T10:00:00Z"), messages: [{ role: "user", content: "  what is\n  in this folder  ", timestamp: "2026-01-01T10:00:00Z" }] };
  assert.equal(threadLabel(asked), "what is in this folder");
  assert.equal(threadLabel(thread("b", "2026-01-01T10:00:00Z")), "New thread");
  assert.equal(threadLabel({ ...asked, title: "Rome in June" }), "Rome in June");
});

test("⌘1 – ⌘9 index the project the open thread is filed under", () => {
  const projects = [
    { threads: [thread("a", "2026-01-01T10:00:00Z"), thread("b", "2026-01-01T09:00:00Z")] },
    { threads: [thread("c", "2026-01-01T08:00:00Z"), thread("d", "2026-01-01T07:00:00Z")] },
  ];
  assert.equal(threadAt(projects, "d", 0), "c");
  assert.equal(threadAt(projects, "d", 1), "d");
  assert.equal(threadAt(projects, "d", 2), "");
  assert.equal(threadAt(projects, "", 1), "b");
  assert.equal(threadAt([], "a", 0), "");
});

test("pinning a thread keeps the newest pin first and unpinning forgets it", () => {
  stored.clear();
  setThreadPinned("a", true);
  setThreadPinned("b", true);
  assert.deepEqual(pinnedThreads(), ["b", "a"]);

  setThreadPinned("b", true);
  assert.deepEqual(pinnedThreads(), ["b", "a"]);

  setThreadPinned("a", false);
  assert.deepEqual(pinnedThreads(), ["b"]);
});

test("marking a thread unread is durable and reversible", () => {
  stored.clear();
  setThreadUnread("a", true);
  setThreadUnread("b", true);
  setThreadUnread("a", true);
  assert.deepEqual(unreadThreads(), ["a", "b"]);
  setThreadUnread("a", false);
  assert.deepEqual(unreadThreads(), ["b"]);
});

test("a subagent chip lands on the turn that spawned it, live ones on the turn still running", () => {
  const child = (id: string, name: string, createdAt: string, brief: string): Thread => ({
    id, title: name, kind: "subagent", parentThreadId: "main", createdAt, updatedAt: createdAt,
    messages: [{ role: "user", content: brief, timestamp: createdAt }, { role: "assistant", content: "done", timestamp: createdAt }],
  });
  const messages = [
    { role: "user" as const, content: "go", timestamp: "2026-01-01T10:00:00Z" },
    { role: "assistant" as const, content: "did", timestamp: "2026-01-01T10:05:00Z" },
    { role: "user" as const, content: "again", timestamp: "2026-01-01T10:06:00Z" },
    { role: "assistant" as const, content: "did again", timestamp: "2026-01-01T10:09:00Z" },
  ];
  const threads = [
    child("t1", "Ada", "2026-01-01T10:01:00Z", "read  the\ndocs"),
    child("t2", "Milo", "2026-01-01T10:07:00Z", "port the callers"),
    { id: "other", title: "Zed", kind: "subagent" as const, parentThreadId: "elsewhere", createdAt: "2026-01-01T10:02:00Z", updatedAt: "2026-01-01T10:02:00Z", messages: [] },
  ];
  const live: LiveAgent[] = [{
    threadId: "t3", parentThreadId: "main", title: "Iris", color: "#4f9dff", status: "running", mode: "ask", model: "m", prompt: "",
    activity: "reading src/main.ts", tool: true, startedAt: Date.parse("2026-01-01T10:10:00Z"), steps: 1, toolCalls: 1,
    inputTokens: 0, outputTokens: 0, generationMs: 0,
  }];

  const spawned = spawnedAgents(threads, live, "main");
  assert.deepEqual(spawned.map((item) => item.id), ["t1", "t2", "t3"]);
  assert.equal(spawned[0].brief, "read the docs");
  assert.equal(spawned[2].brief, "reading src/main.ts");
  assert.equal(spawned[2].color, "#4f9dff", "a live subagent keeps the colour the rail gave it");
  assert.equal(spawned[0].color, AGENT_COLORS[0], "a forgotten one still reads a stable colour");

  const { turns, loose } = spawnedByTurn(messages, spawned);
  assert.deepEqual(turns.get(1)?.map((item) => item.name), ["Ada"]);
  assert.deepEqual(turns.get(3)?.map((item) => item.name), ["Milo"]);
  assert.deepEqual(loose.map((item) => item.name), ["Iris"]);
});

test("a project is ranked by the last thing said anywhere in it", () => {
  const stale = [thread("old-a", "2026-01-01T09:00:00Z"), thread("old-b", "2026-01-02T09:00:00Z")];
  const hot = [thread("new-a", "2026-01-05T09:00:00Z")];
  assert.equal(newest([]), 0);
  assert.ok(newest(hot) > newest(stale));

  // Reopening a long-dormant thread carries its whole project to the top.
  stale[0] = thread("old-a", "2026-01-06T09:00:00Z");
  const groups = [{ id: "hot", threads: hot }, { id: "stale", threads: stale }]
    .sort((left, right) => newest(right.threads) - newest(left.threads));
  assert.deepEqual(groups.map((group) => group.id), ["stale", "hot"]);
});
