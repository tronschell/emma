import test from "node:test";
import assert from "node:assert/strict";
import { buildLedger, NO_EXPERIMENTS, type ContextBreakdown } from "../src/context";
import { countCalls, encodeSpans, decodeSpans, type TraceSpan } from "../shared/trace";
import type { ContextUse } from "../shared/usage";
import type { LiveAgent } from "../shared/agents";
import type { Thread } from "../src/types";

const thread = (replies: number): Thread => ({
  id: "t1",
  title: "Ledger",
  knowledgeBaseId: "kb",
  sourceKnowledgeBaseIds: [],
  createdAt: "2026-08-23T10:00:00.000Z",
  updatedAt: "2026-08-23T10:04:00.000Z",
  messages: Array.from({ length: replies * 2 }, (_, index) => index % 2 === 0
    ? { role: "user" as const, content: "x".repeat(100), timestamp: "2026-08-23T10:00:00.000Z" }
    : { role: "assistant" as const, content: "x".repeat(900), timestamp: "2026-08-23T10:01:00.000Z", generation: { outputTokens: 400, durationMilliseconds: 8_000, inputTokens: 3_000, model: "anthropic/claude-sonnet-4.5" } }),
});

const working = (toolCalls: number): LiveAgent => ({
  threadId: "t1",
  title: "Ledger",
  color: "#4f9dff",
  status: "running",
  mode: "acceptEdits",
  model: "sonnet",
  activity: "bash",
  startedAt: 0,
  steps: toolCalls,
  toolCalls,
  inputTokens: 9_000,
  outputTokens: 700,
  generationMs: 12_000,
});

/* One turn as `AgentRuntime` records it: the run's own span, a model request per
   step, the seven `bash` calls, and one Auto review of one of them. */
const turnSpans = (calls: number): TraceSpan[] => [
  { id: "agent:root", name: "Turn", kind: "agent", startedAt: 0, endedAt: 40_000, status: "ok" },
  { id: "model:1", parentId: "agent:root", name: "model", kind: "model", startedAt: 0, endedAt: 900, status: "ok" },
  ...Array.from({ length: calls }, (_, index): TraceSpan => ({ id: `call:c${index}`, parentId: "agent:root", name: "bash", kind: "execute", startedAt: 1_000 + index * 100, endedAt: 1_050 + index * 100, status: "ok" })),
  { id: "call:verify:1", parentId: "agent:root", name: "auto agent approved · bash", kind: "verifier", startedAt: 1_000, endedAt: 1_400, status: "ok" },
];

test("a landed turn's tool calls are counted off its stored trace, not lost with the run", () => {
  const calls = countCalls(decodeSpans(encodeSpans(turnSpans(7))));
  assert.equal(calls, 7, "the run's own span, its model requests and the Auto review are not calls");
  // What the tile read the moment the turn ended: nothing in flight any more.
  assert.equal(buildLedger(thread(1), [], 200_000, [], NO_EXPERIMENTS, calls).calls, 7);
  assert.equal(buildLedger(thread(1), [], 200_000, [], NO_EXPERIMENTS).calls, 0, "with no trace read back there is nothing to count");
});

test("the count does not step as a turn lands", () => {
  const before = buildLedger(thread(1), [], 200_000, [working(7)], NO_EXPERIMENTS, 4);
  const after = buildLedger(thread(2), [], 200_000, [], NO_EXPERIMENTS, 11);
  assert.equal(before.calls, 11);
  assert.equal(after.calls, 11);
});

test("the tiles beside it are read off the durable record too", () => {
  const attachment: ContextUse = { kind: "messages", label: "notes/plan.txt", chars: 4_000, turns: 2 };
  const landed = buildLedger(thread(3), [attachment], 200_000, [], NO_EXPERIMENTS, 9);
  assert.equal(landed.messages, 6);
  assert.equal(landed.replies, 3);
  assert.equal(landed.attachments, 1);
  assert.equal(landed.tokens, 1_200);
});

const BREAKDOWN: ContextBreakdown = { systemPromptBytes: 4_000, systemToolsBytes: 2_000, mcpToolsBytes: 0, skillsBytes: 1_000, memoryBytes: 1_000 };

test("the harness prefix is named category by category, and never invented", () => {
  const named = buildLedger(thread(1), [], 200_000, [], NO_EXPERIMENTS, 0, BREAKDOWN);
  assert.deepEqual(
    named.rows.filter((row) => row.kind !== "messages").map((row) => [row.kind, row.label, row.chars]),
    [["system", "System prompt", 4_000], ["tools", "System tools", 2_000], ["skills", "Skills", 1_000], ["memory", "Memory files", 1_000]],
    "a workspace with no MCP server gets no MCP row rather than a zero one",
  );
  const unreported = buildLedger(thread(1), [], 200_000, [], NO_EXPERIMENTS);
  assert.equal(unreported.rows.every((row) => row.kind === "messages"), true, "a thread the harness has not reported on states no prefix at all");
});

test("naming the prefix moves mass out of the residual, it does not add any", () => {
  const before = buildLedger(thread(1), [], 200_000, [], NO_EXPERIMENTS);
  const after = buildLedger(thread(1), [], 200_000, [], NO_EXPERIMENTS, 0, BREAKDOWN);
  assert.equal(after.total, before.total, "the window is what the provider billed either way");
  const residual = (ledger: typeof before) => ledger.rows.find((row) => row.label === "Tool results & retries")?.chars ?? 0;
  assert.equal(residual(before) - residual(after), 8_000);
});
