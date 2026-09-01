import test from "node:test";
import assert from "node:assert/strict";
import { cacheHitRate, cacheWriteTokens, costLabel, costPerTask, validateContextPages, DEFAULT_METRICS } from "../shared/context-bar";

const page = (widgets: unknown[]) => [{ id: "p1", name: "Context", widgets }];

test("a stats component keeps the metrics it knows, deduped, and drops the rest", () => {
  const [kept] = validateContextPages(page([{ type: "stats", orientation: "horizontal", metrics: ["calls", "calls", "share", "nonsense"] }]));
  assert.deepEqual(kept.widgets[0].metrics, ["calls", "share"]);
});

test("metrics only stick to stats, and an unusable list falls back to the defaults", () => {
  const [stripped] = validateContextPages(page([
    { type: "stats", orientation: "horizontal", metrics: ["nonsense"] },
    { type: "timeline", orientation: "vertical", metrics: ["calls"] },
  ]));
  assert.equal(stripped.widgets[0].metrics, undefined);
  assert.equal(stripped.widgets[1].metrics, undefined);
  assert.equal(DEFAULT_METRICS.length, 9);
});

test("cache hit rate is weighted across reported generations", () => {
  assert.equal(cacheHitRate([]), undefined);
  assert.equal(cacheHitRate([{ cacheInputTokens: 100, cacheReadTokens: 0 }]), 0);
  assert.equal(cacheHitRate([{ cacheInputTokens: 100, cacheReadTokens: 80 }, { cacheInputTokens: 300, cacheReadTokens: 120 }, {}]), 0.5);
});

test("cache writes preserve exact zero and omit unavailable values", () => {
  assert.equal(cacheWriteTokens([]), undefined);
  assert.equal(cacheWriteTokens([{}]), undefined);
  assert.equal(cacheWriteTokens([{ cacheWriteTokens: 0 }, {}]), 0);
  assert.equal(cacheWriteTokens([{ cacheWriteTokens: 10 }, { cacheWriteTokens: 4 }]), 14);
});

test("cost per task only uses reported provider costs", () => {
  assert.equal(costPerTask([]), undefined);
  assert.equal(costPerTask([{}]), undefined);
  assert.equal(costPerTask([{ costMicroUsd: 0 }, {}]), 0);
  assert.equal(costPerTask([{ costMicroUsd: 100 }, { costMicroUsd: 300 }, {}]), 200);
  assert.equal(costLabel(undefined), "—");
  assert.equal(costLabel(1_234), "$0.001234");
});
