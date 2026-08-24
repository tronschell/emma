import assert from "node:assert/strict";
import test from "node:test";

/* Node has no web storage, and the tag store only ever asks it for two things. */
const stored = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value); },
};
/* The sidebar listens for a tag change on the window; nothing here does. */
(globalThis as unknown as { dispatchEvent: unknown }).dispatchEvent = () => true;

import { nested, since, threadDepth, threadLabel } from "../src/threads";
import { AUTO_FILE_EXAMPLES, autoTagStatus, handTags, setThreadTag, threadTags } from "../src/context";
import { pickTag } from "../main/tagger";
import type { Thread } from "../src/types";

/** Only the fields the sidebar shapes a row from; the snapshot carries more. */
function thread(id: string, updatedAt: string, parentThreadId?: string): Thread {
  return {
    id, title: "New thread", createdAt: "2026-01-01T00:00:00Z", updatedAt, messages: [],
    knowledgeBaseId: "", sourceKnowledgeBaseIds: [], parentThreadId,
  };
}

test("the sidebar lists whatever moved last first, branch and all", () => {
  const threads = [
    thread("a", "2026-01-01T10:00:00Z"),
    thread("b", "2026-01-01T09:00:00Z"),
    thread("c", "2026-01-01T08:00:00Z"),
  ];
  assert.deepEqual(nested(threads).map((item) => item.id), ["a", "b", "c"]);

  // The whole point: an agent answers in the oldest thread and it goes to the top.
  threads[2] = thread("c", "2026-01-01T11:00:00Z");
  assert.deepEqual(nested(threads).map((item) => item.id), ["c", "a", "b"]);

  // A thread the snapshot has no date for sorts last rather than to the top.
  assert.deepEqual(nested([...threads, thread("d", "not a date")]).map((item) => item.id), ["c", "a", "b", "d"]);
});

test("a sub thread stays under its owner and carries it up the list", () => {
  const threads = [
    thread("a", "2026-01-01T10:00:00Z"),
    thread("b", "2026-01-01T09:00:00Z"),
    // Spawned by b an hour ago and answered a minute ago: b is the branch that
    // just moved, so both rows belong above a, in that order.
    thread("b-sub", "2026-01-01T11:00:00Z", "b"),
    thread("orphan", "2026-01-01T12:00:00Z", "filed-elsewhere"),
  ];
  assert.deepEqual(nested(threads).map((item) => item.id), ["orphan", "b", "b-sub", "a"]);
  // A parent that is not in this group leaves its child at the top level, where
  // the user can still reach it.
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
  // A thread file with an unreadable date says so rather than claiming "now".
  assert.equal(at("not a date"), "—");
});

test("Emma files threads by itself only once one hand tag has enough to learn from", () => {
  stored.clear();
  assert.deepEqual(autoTagStatus(), { ready: false, category: "", examples: 0 });

  // One short of the threshold, and the count is what the user is shown.
  for (let index = 1; index < AUTO_FILE_EXAMPLES; index += 1) setThreadTag(`t${index}`, "Billing");
  setThreadTag("other", "research");
  assert.deepEqual(autoTagStatus(), { ready: false, category: "billing", examples: AUTO_FILE_EXAMPLES - 1 });

  // The fifth crosses it. Tags are normalized on the way in, so "Billing " and
  // "billing" are one category rather than two that never reach five.
  setThreadTag(`t${AUTO_FILE_EXAMPLES}`, " billing ");
  assert.deepEqual(autoTagStatus(), { ready: true, category: "billing", examples: AUTO_FILE_EXAMPLES });
  assert.deepEqual(handTags(), ["billing", "research"]);

  // Emma's own guesses are counted for nothing: they would otherwise become the
  // examples arguing for more of the same.
  stored.clear();
  for (let index = 1; index <= AUTO_FILE_EXAMPLES; index += 1) setThreadTag(`t${index}`, "billing", true);
  assert.deepEqual(autoTagStatus(), { ready: false, category: "", examples: 0 });
  assert.deepEqual(handTags(), []);
});

test("a guess never lands on a tag the user applied, and is always correctable", () => {
  stored.clear();
  setThreadTag("mine", "billing");
  setThreadTag("mine", "research", true);
  assert.deepEqual(threadTags().mine, { tag: "billing", auto: false });

  // The other way round is the whole point of auto-filing, and typing over a
  // guess makes it the user's own.
  setThreadTag("guessed", "research", true);
  assert.deepEqual(threadTags().guessed, { tag: "research", auto: true });
  setThreadTag("guessed", "billing");
  assert.deepEqual(threadTags().guessed, { tag: "billing", auto: false });
  // Emptying the field clears the row.
  setThreadTag("guessed", "  ");
  assert.equal(threadTags().guessed, undefined);
});

test("the categorizer only ever answers with a tag the user made", () => {
  const tags = ["billing", "billing-eu", "research"];
  assert.equal(pickTag("billing", tags), "billing");
  // Small models narrate. The tag is read out of the sentence rather than parsed.
  assert.equal(pickTag('tag: "research".', tags), "research");
  // The longest match wins, or "billing-eu" would file as "billing".
  assert.equal(pickTag("billing-eu", tags), "billing-eu");
  // A refusal and an invented category both come back as no tag, not as a new one.
  assert.equal(pickTag("none of these fit", tags), "");
  assert.equal(pickTag("invoices", tags), "");
});

test("an unnamed thread is called after what was asked in it", () => {
  const asked: Thread = { ...thread("a", "2026-01-01T10:00:00Z"), messages: [{ role: "user", content: "  what is\n  in this folder  ", timestamp: "2026-01-01T10:00:00Z" }] };
  assert.equal(threadLabel(asked), "what is in this folder");
  assert.equal(threadLabel(thread("b", "2026-01-01T10:00:00Z")), "New thread");
  assert.equal(threadLabel({ ...asked, title: "Rome in June" }), "Rome in June");
});
