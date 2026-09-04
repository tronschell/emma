import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, type LoopDeps } from "../main/agent-loop";
import { traceHeader } from "../shared/trace";
import { readTurn, sampleOf, validateImprovements } from "../shared/improvement";
import { validateBench } from "../shared/bench";

const runtime = (recorded: string[]) => new AgentRuntime({
  request: async (method: string, params: Record<string, string>) => { if (method === "recordTrace") recorded.push(params.trace); return {}; },
  ask: () => {},
  answered: () => undefined,
  verify: async () => ({ model: "", prompt: "", reply: "", attempts: 0, error: "no verifier" }),
  advise: async () => ({ model: "", text: "no advisor" }),
  spawnTurn: () => {},
  changed: () => {},
  step: () => {},
} as LoopDeps);

test("a finished turn's trace header carries what the turn cost", () => {
  const recorded: string[] = [];
  const agents = runtime(recorded);
  agents.adopt({ threadId: "t1", content: "build it", mode: "acceptEdits", title: "Build it", model: "openrouter:Anthropic/Claude-Sonnet-4.5" });
  agents.noteDelta("t1", "thinking about it");
  agents.noteUsage("t1", { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900, costMicroUsd: 4200 });
  const answering = agents.spans().t1.find((span) => span.kind === "model");
  assert.equal(answering?.tokens, 1500, "the provider's own count did not land on the open model span");
  agents.noteTool("t1", "call-1", "select_tool", { threadId: "t1", toolCallId: "call-1", title: "select_tool", kind: "other", status: "completed", at: Date.now() });
  agents.noteDelta("t1", "the answer");
  agents.noteUsage("t1", { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900, costMicroUsd: 4200 });
  agents.finish("t1", undefined, "end_turn");

  const header = traceHeader(recorded.at(-1) ?? "");
  assert.equal(header.model, "anthropic/claude-sonnet-4.5", "the header keeps the key's prefix instead of the bare provider id");
  assert.equal(header.family, "sonnet");
  assert.equal(header.mode, "acceptEdits");
  assert.equal(header.requests, "2");
  assert.equal(header.in, "1200");
  assert.equal(header.out, "300");
  assert.equal(header.cacheRead, "900");
  assert.equal(header.cost, "4200");
  assert.equal(header.discovery, "1");
  assert.equal(header.stop, "end_turn");
  assert.ok(Number(header.ms) >= 0);

  const turn = readTurn({ timestamp: "2026-09-03T00:00:00Z", text: recorded.at(-1) ?? "" }, { id: "t1", title: "Build it" });
  assert.equal(turn.requests, 2);
  assert.equal(turn.tokens, 1500);
  assert.equal(turn.cost, 4200);
  assert.equal(sampleOf(turn, "cost"), 4200);
  assert.ok(turn.ms >= 0);
});

test("a turn from before the ledger reads as zero, and the new metrics survive validation", () => {
  const old = readTurn({ timestamp: "2026-08-01T00:00:00Z", text: '{"v":1,"thread":"t1","model":"local:qwen3"}\n{"id":"agent:t1","name":"run","kind":"agent","startedAt":1,"endedAt":2,"status":"ok"}' }, { id: "t1", title: "Old" });
  assert.deepEqual([old.requests, old.tokens, old.cost, old.ms], [0, 0, 0, 0]);

  assert.equal(validateImprovements({ items: [{ id: "i1", addition: "do less", metric: "cost" }] }).items[0].metric, "cost");
  assert.equal(validateImprovements({ items: [{ id: "i1", addition: "do less", metric: "nonsense" }] }).items[0].metric, "failures");
  const bench = validateBench({ cases: [], runs: [{ id: "r1", improvementId: "i1", metric: "ms", results: [{ caseId: "c1", arm: "a", requests: 3, tokens: 12, cost: 7, ms: 900 }] }] });
  assert.deepEqual(bench.runs[0].results[0].requests, 3);
  assert.deepEqual([bench.runs[0].results[0].tokens, bench.runs[0].results[0].cost, bench.runs[0].results[0].ms], [12, 7, 900]);
});
