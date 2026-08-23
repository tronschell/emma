import assert from "node:assert/strict";
import test from "node:test";

import { activityDays, activityGrid } from "../src/activity";

test("activity covers the current week only", () => {
  const days = activityDays(["2026-08-17T10:00:00Z", "2026-08-17T11:00:00Z", "2026-01-02T10:00:00Z"], new Date("2026-08-20T00:00:00Z"));
  assert.equal(days.length, 7);
  assert.equal(days[0].date, "2026-08-16");
  assert.equal(days[1].count, 2);
  assert.equal(days.at(-1)?.date, "2026-08-22");
});

test("activityGrid lays out weeks ending on the current week's Saturday", () => {
  const grid = activityGrid(["2026-08-17T10:00:00Z", "2026-08-17T11:00:00Z", "2026-08-19T10:00:00Z"], 2, new Date("2026-08-20T00:00:00Z"));
  assert.equal(grid.weeks.length, 2);
  assert.ok(grid.weeks.every((column) => column.length === 7));
  const week = grid.weeks.find((column) => column.some((day) => day.date === "2026-08-17"));
  assert.equal(week?.reduce((total, day) => total + day.count, 0), 3);
  assert.equal(grid.max, 2);
});
