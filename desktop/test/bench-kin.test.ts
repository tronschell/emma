import test from "node:test";
import assert from "node:assert/strict";
import { benchKin } from "../src/bench-run";
import type { Thread } from "../src/types";

const threadOf = (id: string, over: Partial<Thread> = {}): Thread => ({
  id,
  title: id,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  messages: [],
  ...over,
});

test("a bench run reaches every descendant of every case thread, however deep, and nothing else", () => {
  const kin = benchKin([
    threadOf("grandchild", { parentThreadId: "child" }),
    threadOf("child", { parentThreadId: "case" }),
    threadOf("case"),
    threadOf("release-notes"),
    threadOf("under-release-notes", { parentThreadId: "release-notes" }),
    threadOf("cycle-a", { parentThreadId: "cycle-b" }),
    threadOf("cycle-b", { parentThreadId: "cycle-a" }),
  ], ["case"]);

  assert.deepEqual([...kin].sort(), ["case", "child", "grandchild"]);
});
