import test from "node:test";
import assert from "node:assert/strict";
import { activeYears, countDays, heatLevel, lineage, projectActivity, streak, weekGrid } from "../src/activity";
import type { Thread } from "../src/types";

const thread = (id: string, over: Partial<Thread> = {}): Thread => ({
  id,
  title: id,
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
  messages: [],
  ...over,
});

test("countDays buckets local days and drops unparseable stamps", () => {
  const days = countDays(["2026-08-20T10:00:00.000Z", "2026-08-20T11:00:00.000Z", "nonsense"]);
  assert.equal(Object.values(days).reduce((sum, count) => sum + count, 0), 2);
  assert.equal(Object.keys(days).length, 1);
});

test("weekGrid starts on a Sunday and covers whole weeks", () => {
  const grid = weekGrid(new Date(2026, 0, 1), new Date(2026, 11, 31));
  assert.ok(grid.weeks.length >= 52 && grid.weeks.length <= 54);
  assert.ok(grid.weeks.every((week) => week.length === 7));
  assert.equal(grid.weeks[0][0], "2025-12-28");
  assert.equal(grid.months[0].label, "Jan");
});

test("heatLevel is zero for nothing and four at the peak", () => {
  assert.equal(heatLevel(0, 10), 0);
  assert.equal(heatLevel(1, 10), 1);
  assert.equal(heatLevel(10, 10), 4);
  assert.equal(heatLevel(3, 0), 4);
});

test("streak counts back from today and tolerates an idle today", () => {
  const today = new Date(2026, 7, 27);
  assert.equal(streak({ "2026-08-27": 2, "2026-08-26": 1, "2026-08-24": 9 }, today), 2);
  assert.equal(streak({ "2026-08-26": 1, "2026-08-25": 1 }, today), 2);
  assert.equal(streak({}, today), 0);
});

test("activeYears runs back to the earliest day recorded", () => {
  assert.deepEqual(activeYears({ "2024-03-02": 1, "2026-01-01": 1 }, new Date(2026, 7, 27)), [2026, 2025, 2024]);
});

test("projectActivity groups by folder name and falls back to Other", () => {
  const rows = projectActivity([
    thread("a", { messages: [{ role: "user", content: "", timestamp: "2026-08-20T10:00:00.000Z" }] }),
    thread("b", { messages: [{ role: "user", content: "", timestamp: "2026-08-20T10:00:00.000Z" }] }),
    thread("c"),
  ], (item) => item.id === "c" ? "" : "emma");
  assert.deepEqual(rows.map((row) => row.name), ["emma", "Other"]);
  assert.equal(rows[0].threads, 2);
  assert.equal(rows[0].messages, 2);
  assert.equal(Object.values(rows[0].days)[0], 2);
});

test("lineage nests subagents under their parent and keeps the spine open", () => {
  const rows = lineage([
    thread("root-new", { updatedAt: "2026-08-26T10:00:00.000Z" }),
    thread("root-old", { updatedAt: "2026-08-20T10:00:00.000Z" }),
    thread("kid", { parentThreadId: "root-new", updatedAt: "2026-08-25T10:00:00.000Z" }),
    thread("orphan", { parentThreadId: "gone", updatedAt: "2026-08-01T10:00:00.000Z" }),
  ], 10);
  assert.deepEqual(rows.map((row) => row.thread.id), ["root-new", "kid", "root-old", "orphan"]);
  assert.deepEqual(rows.map((row) => row.depth), [0, 1, 0, 0]);
  assert.deepEqual(rows[1].open, [0]);
  assert.equal(rows[1].elbow, true);
  assert.equal(rows[0].up, false);
  assert.equal(rows[0].down, true);
  assert.equal(rows.at(-1)!.down, false);
});

test("lineage stops at the row limit", () => {
  const many = Array.from({ length: 20 }, (_, index) => thread(`t${index}`));
  assert.equal(lineage(many, 5).length, 5);
});
