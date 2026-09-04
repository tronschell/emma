import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applied, compare, distinctTurns, draftProposal, frictionOf, readTurn, readTurns, retryDraft, startTrial, turnsInScope, validateImprovements, type Improvement, type Lever } from "../shared/improvement";
import { encodeSpans, renderTrace, traceHeader, type TraceSpan } from "../shared/trace";
import { forceArm, setImprovements, setSystemPrompt, takeArm, withTrialArm, writeHarnessPrompt } from "../main/system-prompt";
import { parseToolArgs } from "../main/tools";
import { AgentRuntime } from "../main/agent-loop";

const change = (lever: Lever, addition: string, scope = "", state: Improvement["state"] = "kept"): Improvement =>
  ({ id: `${lever}-${scope}`, title: lever, lever, addition, scope, metric: "failures", startedAt: 1, look: 1, state });

const stored = (model: string, at: number, failed = true) => readTurn({ timestamp: new Date(at).toISOString(), text: encodeSpans([
  { id: "agent:t", kind: "agent", name: "Task", startedAt: at, endedAt: at + 1, status: "ok" },
  { id: "call:t", parentId: "agent:t", kind: "read", name: "Reading", tool: "read_tool_result", startedAt: at, status: failed ? "failed" : "ok", output: "start_byte must be a bare JSON number" },
], { model, arm: "b" }) }, { id: `t${at}`, title: "Task" });

test("all levers retain their scope across validation, trials, retry and runtime resolution", () => {
  const payloads: [Lever, string][] = [["instructions", "Read first."], ["verifier", "Keep the guard."], ["prompt", "Batch reads."], ["tools", '{"read_tool_result":"Pass numeric offsets."}'], ["advertise", "memory"], ["knobs", "autoCompactPercent=55"]];
  for (const [lever, addition] of payloads) {
    const item = change(lever, addition, "family:glm");
    const store = validateImprovements({ items: [item] });
    assert.equal(store.items[0].scope, "family:glm");
    const trial = startTrial([], retryDraft(item), 2)[0];
    assert.equal(trial.scope, "family:glm");
    assert.equal(applied({ items: [trial] }, "z-ai/glm-5.3-flash").trial?.length, 1);
    assert.equal(applied({ items: [trial] }, "openai/gpt-5.6-luna").trial, undefined);
    for (const scope of ["family:nope", "model:", "model:unknown", "model:x y", "family:glm".repeat(30), 42]) {
      assert.deepEqual(validateImprovements({ items: [{ ...item, scope }] }).items, []);
    }
  }
  const many = Array.from({ length: 12 }, (_, i) => ({ ...change("instructions", `GLM ${i}`, "family:glm"), id: `g${i}` }));
  assert.match(applied({ items: [...many, change("instructions", "GPT only", "family:gpt")] }, "gpt-5.6-luna").kept.instructions, /GPT only/);
  const specific = applied({ items: [change("tools", '{"read_file":"exact"}', "model:z-ai/glm-5.3-flash"), change("tools", '{"read_file":"global"}'), change("tools", '{"read_file":"family"}', "family:glm")] }, "glm-5.3-flash");
  assert.equal(specific.kept.toolHints.read_file, "exact");
});

test("model drilldowns use complete evidence counts and scope the draft without blaming successful models", () => {
  const runs = [stored("openrouter:Z-AI/GLM-5.3-Flash", 100), stored("z-ai/glm-5.3-flash", 200), stored("z-ai/glm-5", 300), stored("gpt-5.6-luna", 400, false), stored("", 500, false)];
  assert.equal(runs[0].family, "glm");
  assert.equal(runs[0].model, "z-ai/glm-5.3-flash");
  assert.equal(turnsInScope(runs, "family:glm").length, 3);
  assert.equal(turnsInScope(runs, "unknown").length, 1);
  assert.equal(frictionOf(runs, "family:gpt").length, 0);
  const [all] = frictionOf(runs);
  assert.equal(all.scope, "family:glm");
  assert.deepEqual(all.models.map((row) => [row.model, row.turns]).sort(), [["z-ai/glm-5", 1], ["z-ai/glm-5.3-flash", 2]]);
  const [exact] = frictionOf(runs, "model:glm-5.3-flash");
  assert.equal(exact.turns, 2);
  assert.equal(draftProposal(exact).scope, "model:glm-5.3-flash");
  assert.equal(draftProposal(exact).lever, "tools");
  assert.equal(frictionOf([...runs, stored("", 600)])[0].scope, "");
  const sameTime = [stored("glm-5.3-flash", 700), stored("glm-5.3-flash", 700)];
  assert.equal(frictionOf(sameTime)[0].turns, 2);
});

test("a scoped comparison excludes other models and runs from another trial", () => {
  const trial = change("instructions", "Read first", "family:glm", "trial");
  const runs = [stored("glm-5.3-flash", 100), stored("gpt-5.6-luna", 200), stored("", 300), { ...stored("glm-5.3-flash", 400), trials: ["other"] }];
  assert.equal(compare(runs, trial).b.n, 1);
});

test("scoped lessons reach only matching turns and are replaced in the prompt when a thread switches models", () => {
  const home = mkdtempSync(path.join(tmpdir(), "emma-scoped-prompt-"));
  setSystemPrompt("Base.");
  setImprovements({ items: [change("instructions", "GLM lesson", "family:glm"), change("tools", '{"read_file":"GLM hint"}', "model:glm-5.3-flash"), change("prompt", "GLM trial", "family:glm", "trial")] });
  const turn = { threadId: "switch", title: "Task", content: "Do it", mode: "ask" as const, model: "provider:plan-zai" };
  forceArm(turn.threadId, "b");
  const glm = withTrialArm(turn, "glm-5.3-flash");
  assert.equal(glm.toolHints?.read_file, "GLM hint");
  assert.equal(glm.params, undefined);
  writeHarnessPrompt(home, { model: "glm-5.3-flash", addition: glm.promptAddition });
  assert.match(readFileSync(path.join(home, ".fx/system-prompt.md"), "utf8"), /GLM lesson[\s\S]*GLM trial/);
  assert.equal(readFileSync(path.join(home, ".fx/AGENTS.md"), "utf8"), "");
  const gpt = withTrialArm({ ...turn, model: "gpt-5.6-luna" });
  assert.equal(gpt.promptAddition, undefined);
  assert.equal(gpt.toolHints, undefined);
  assert.equal(takeArm(turn.threadId), "");
  writeHarnessPrompt(home, { model: gpt.model, addition: gpt.promptAddition });
  assert.equal(readFileSync(path.join(home, ".fx/system-prompt.md"), "utf8").trim(), "Base.");
  setSystemPrompt("");
  setImprovements({ items: [] });
});

test("subagent failures and saved run inputs keep their own model attribution", () => {
  const spans: TraceSpan[] = [
    { id: "agent:root", kind: "agent", name: "Parent", model: "gpt-5.6-luna", startedAt: 1, status: "ok" },
    { id: "agent:child", parentId: "agent:root", kind: "agent", name: "Child", model: "glm-5.3-flash", startedAt: 2, status: "failed", context: { model: "glm-5.3-flash", in: "100", out: "20" } },
    { id: "call:child", parentId: "agent:child", name: "Reading", tool: "read_file", kind: "read", startedAt: 3, status: "failed", output: "file missing" },
  ];
  const text = encodeSpans(spans, { model: "gpt-5.6-luna", systemPrompt: "Saved prompt\nsecond line", skillContext: "Saved skill", configuration: '{"toolHints":{}}' });
  const [parent, child] = readTurns({ timestamp: "2026-09-04T00:00:00Z", text }, { id: "root", title: "Parent" });
  assert.equal(parent.failures, 0);
  assert.equal(child.failures, 1);
  assert.equal(child.family, "glm");
  assert.equal(child.tokens, 120);
  assert.equal(distinctTurns([parent, child, { ...child, at: child.at + 100, failures: 2 }]).length, 2);
  assert.equal(distinctTurns([child, { ...child, at: child.at + 100, failures: 2 }])[0].failures, 2);
  assert.equal(parent.context.systemPrompt, "Saved prompt\nsecond line");
  assert.match(renderTrace(spans, 5, traceHeader(text)), /systemPrompt="Saved prompt\\nsecond line"/);
  const legacy = spans.map((span) => ({ ...span, model: undefined, context: undefined }));
  assert.equal(readTurns({ timestamp: "2026-09-04T00:00:00Z", text: encodeSpans(legacy, { model: "gpt-5.6-luna" }) }, { id: "root", title: "Parent" })[1].model, "");
});

test("trace pagination validates its input", () => {
  assert.deepEqual(parseToolArgs("read_trace", '{"limit":8,"offset":16}'), { name: "read_trace", thread: undefined, limit: 8, offset: 16 });
  assert.throws(() => parseToolArgs("read_trace", '{"offset":-1}'));
  assert.throws(() => parseToolArgs("read_trace", '{"offset":"16"}'));
});

test("a child that finishes after its parent saves its final model, context and failures", () => {
  const records: { threadId: string; trace: string }[] = [];
  const agents = new AgentRuntime({
    request: async (method, params) => { if (method === "recordTrace") records.push({ threadId: params.threadId, trace: params.trace }); return {}; },
    ask: () => {}, answered: () => undefined, changed: () => {}, step: () => {}, spawnTurn: () => {},
    verify: async () => ({ model: "", prompt: "", reply: "", attempts: 0, error: "unused" }),
    advise: async () => ({ model: "", text: "unused" }),
  });
  agents.adopt({ threadId: "parent", title: "Parent", content: "Inspect", model: "gpt-5.6-luna", mode: "full" });
  agents.adopt({ threadId: "child", parentThreadId: "parent", depth: 1, title: "Child", content: "Inspect", model: "glm-5.3-flash", mode: "full" });
  agents.noteContext("child", { systemPrompt: "Child prompt", trials: "glm-trial", arm: "b" });
  agents.finish("parent");
  agents.noteTool("child", "read1", "Read file", { threadId: "child", toolCallId: "read1", title: "Read file", toolName: "read_file", kind: "read", status: "failed", output: "Missing file", at: Date.now() });
  agents.finish("child", "Failed");
  const saved = records.find((record) => record.threadId === "child");
  assert.ok(saved);
  const child = readTurn({ timestamp: new Date().toISOString(), text: saved.trace }, { id: "child", title: "Child" });
  assert.equal(child.model, "glm-5.3-flash");
  assert.equal(child.failures, 1);
  assert.equal(child.context.systemPrompt, "Child prompt");
  assert.equal(child.arm, "b");
});
