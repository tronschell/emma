import assert from "node:assert/strict";
import test from "node:test";

const stored = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value); },
};
(globalThis as unknown as { dispatchEvent: unknown }).dispatchEvent = () => true;

import { latestRate, latestReply } from "../src/threads";
import { segmentItems } from "../src/context";
import type { Message, Thread } from "../src/types";

const answer: Message = {
  role: "assistant",
  content: "The build is green.",
  timestamp: "2026-08-23T10:01:00.000Z",
  generation: { outputTokens: 400, durationMilliseconds: 8_000, inputTokens: 3_000, model: "z-ai/glm-5.3-flash" },
};

const notice: Message = { role: "system", content: "This run stopped: you stopped it", timestamp: "2026-08-23T10:01:30.000Z" };

const asked = (content: string): Message => ({ role: "user", content, timestamp: "2026-08-23T10:00:00.000Z" });

const threadOf = (...messages: Message[]): Thread => ({
  id: "t1",
  title: "Notice",
  createdAt: "2026-08-23T10:00:00.000Z",
  updatedAt: "2026-08-23T10:02:00.000Z",
  messages: [asked("did it build?"), ...messages],
});

test("a turn that ends in a notice still shows the answer the model gave", () => {
  assert.equal(latestReply(threadOf(answer, notice)), "The build is green.");
});

test("a turn that ends in a notice still reports the rate the answer ran at", () => {
  assert.equal(latestRate(threadOf(answer, notice)), 50);
});

test("a turn that is only a notice shows the notice and has no rate", () => {
  assert.equal(latestReply(threadOf(notice)), "This run stopped: you stopped it");
  assert.equal(latestRate(threadOf(notice)), 0);
});

test("a turn that answered nothing does not borrow the answer of the turn before it", () => {
  const stale = threadOf(answer, asked("and now?"), notice);
  assert.equal(latestReply(stale), "This run stopped: you stopped it");
  assert.equal(latestRate(stale), 0);
});

test("a turn that ends in an answer is unchanged", () => {
  assert.equal(latestReply(threadOf(answer)), "The build is green.");
  assert.equal(latestRate(threadOf(answer)), 50);
});

test("the context breakdown calls a notice a notice, not Emma", async () => {
  const items = await segmentItems("messages", threadOf(answer, notice).messages, "t1");
  assert.deepEqual(items.map((item) => item.name), ["1. You", "2. Emma", "3. Notice"]);
});
