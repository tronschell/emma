import assert from "node:assert/strict";
import test from "node:test";

const stored = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value); },
};
(globalThis as unknown as { dispatchEvent: unknown }).dispatchEvent = () => true;

import { nested, since, threadDepth, threadLabel } from "../src/threads";
import { handTags, setThreadTag, threadTags } from "../src/context";
import type { Thread } from "../src/types";

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
