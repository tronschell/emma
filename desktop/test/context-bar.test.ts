import test from "node:test";
import assert from "node:assert/strict";
import { validateContextPages, DEFAULT_METRICS } from "../shared/context-bar";

const page = (widgets: unknown[]) => [{ id: "p1", name: "Context", widgets }];

test("a stats component keeps the metrics it knows, deduped, and drops the rest", () => {
  const [kept] = validateContextPages(page([{ type: "stats", orientation: "horizontal", metrics: ["calls", "calls", "share", "nonsense"] }]));
  assert.deepEqual(kept.widgets[0].metrics, ["calls", "share"]);
});

test("metrics only stick to stats, and an unusable list falls back to the six defaults", () => {
  const [stripped] = validateContextPages(page([
    { type: "stats", orientation: "horizontal", metrics: ["nonsense"] },
    { type: "timeline", orientation: "vertical", metrics: ["calls"] },
  ]));
  assert.equal(stripped.widgets[0].metrics, undefined);
  assert.equal(stripped.widgets[1].metrics, undefined);
  assert.equal(DEFAULT_METRICS.length, 6);
});
