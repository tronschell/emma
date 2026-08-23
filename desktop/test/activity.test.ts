import assert from "node:assert/strict";
import test from "node:test";

import { activityDays } from "../src/activity";

test("activity covers the current week only", () => {
  const days = activityDays(["2026-08-17T10:00:00Z", "2026-08-17T11:00:00Z", "2026-01-02T10:00:00Z"], new Date("2026-08-20T00:00:00Z"));
  assert.equal(days.length, 7);
  assert.equal(days[0].date, "2026-08-16");
  assert.equal(days[1].count, 2);
  assert.equal(days.at(-1)?.date, "2026-08-22");
});
