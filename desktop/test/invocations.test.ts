import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { daysUnder, mcpServerPrefix, mcpToolKey, modelKey, readUsage, recordUse, skillKey } from "../main/invocations";
import { byUse, recentDays, rowSeries, rowTotal, usageDay, usageSeries, type UsageRow } from "../shared/invocations";

test("keys name a skill by source and an MCP call by its tool", () => {
  assert.equal(skillKey("skill:codex:0:review"), "skill/codex/review");
  assert.equal(skillKey("skill:codex:1:review"), "skill/codex/review");
  assert.equal(skillKey("mcp:emma:0:linear"), "");
  assert.equal(skillKey("not a skill id"), "");
  assert.equal(mcpToolKey("mcp__linear__create_issue"), "mcp/mcp__linear__create_issue");
  assert.equal(mcpToolKey("read_file"), "");
  assert.equal(mcpToolKey(undefined), "");
});

test("uses are counted once per call, summed per server, and dropped after ninety days", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "emma-usage-"));
  try {
    const today = usageDay(new Date());
    const stale = usageDay(new Date(Date.now() - 120 * 86_400_000));
    await writeFile(path.join(userData, "usage.json"), JSON.stringify({ "skill/codex/review": { [stale]: 4 }, "bogus key": { [today]: 9 } }));

    await recordUse(userData, skillKey("skill:codex:0:review"));
    await recordUse(userData, mcpToolKey("mcp__linear__create_issue"), "thread-1:call-1");
    await recordUse(userData, mcpToolKey("mcp__linear__create_issue"), "thread-1:call-1");
    await recordUse(userData, mcpToolKey("mcp__linear__list_issues"), "thread-1:call-2");
    await recordUse(userData, "", "thread-1:call-3");

    const usage = await readUsage(userData);
    assert.deepEqual(usage["skill/codex/review"], { [today]: 1 });
    assert.equal(usage["bogus key"], undefined);
    assert.deepEqual(usage["mcp/mcp__linear__create_issue"], { [today]: 1 });
    assert.deepEqual(daysUnder(usage, mcpServerPrefix("linear")), { [today]: 2 });
    assert.deepEqual(daysUnder(usage, mcpServerPrefix("other")), {});
    assert.match(await readFile(path.join(userData, "usage.json"), "utf8"), /mcp__linear__create_issue/);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("a corrupt or missing usage file reads as no usage at all", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "emma-usage-"));
  try {
    assert.deepEqual(await readUsage(userData), {});
    await writeFile(path.join(userData, "usage.json"), "{ not json");
    assert.deepEqual(await readUsage(userData), {});
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("the chart series follows the day window, oldest first", () => {
  const days = recentDays(3, new Date(2026, 7, 26));
  assert.deepEqual(days, ["2026-08-24", "2026-08-25", "2026-08-26"]);
  const rows: UsageRow[] = [
    { id: "a", name: "alpha", source: "codex", days: { "2026-08-24": 2, "2026-08-26": 1 } },
    { id: "b", name: "beta", source: "codex", days: { "2026-08-26": 5 } },
  ];
  assert.deepEqual(rowSeries(rows[0], days), [2, 0, 1]);
  assert.deepEqual(usageSeries(rows, days), [2, 0, 6]);
  assert.equal(rowTotal(rows[1]), 5);
  assert.deepEqual(byUse(rows).map((row) => row.name), ["beta", "alpha"]);
});

test("a model key survives a round trip through the store", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "emma-model-usage-"));
  try {
    assert.equal(modelKey("z-ai/glm-5.2:free"), "model/z-ai/glm-5.2:free");
    assert.equal(modelKey("auto"), "model/auto");
    assert.equal(modelKey("a model with spaces"), "");
    assert.equal(modelKey(undefined), "");
    await recordUse(home, modelKey("z-ai/glm-5.2:free"));
    await recordUse(home, modelKey("z-ai/glm-5.2:free"));
    const usage = await readUsage(home);
    assert.equal(Object.values(usage["model/z-ai/glm-5.2:free"])[0], 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
