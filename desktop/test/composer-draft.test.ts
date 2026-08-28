import test from "node:test";
import assert from "node:assert/strict";
import { setThreadDraft, threadDraft } from "../src/context";

/// Renderer storage, in a test runner that has none.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

test("an unsent prompt and its attachments come back to the thread that held them", () => {
  store.clear();
  const picks = [{ kind: "attachment" as const, id: "a1", name: "shot.png", path: "/tmp/shot.png" }];
  setThreadDraft("t1", { text: "half a thought", picks });
  assert.deepEqual(threadDraft("t1"), { text: "half a thought", picks });
  assert.deepEqual(threadDraft("t2"), { text: "", picks: [] });
});

test("sending clears the draft, and junk in storage reads as empty", () => {
  store.clear();
  setThreadDraft("t1", { text: "sent now", picks: [] });
  setThreadDraft("t1", { text: "", picks: [] });
  assert.deepEqual(threadDraft("t1"), { text: "", picks: [] });
  store.set("emma.threadDraft.v1.t3", "{oops");
  assert.deepEqual(threadDraft("t3"), { text: "", picks: [] });
  store.set("emma.threadDraft.v1.t4", JSON.stringify({ text: 7, picks: [{ kind: "nope" }, null] }));
  assert.deepEqual(threadDraft("t4"), { text: "", picks: [] });
});
