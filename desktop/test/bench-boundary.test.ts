import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime, benchReplay, benchThread, haltBench, inheritBench, ownBench, refuseBenchTurn, type LoopDeps, type TurnRequest } from "../main/agent-loop";
import { Harness } from "../main/harness";
import { parseToolArgs } from "../main/tools";

const library = {
  threads: [
    { id: "case", title: "Bench · fix the flaky test", messages: [] },
    { id: "child", title: "planner", parentThreadId: "case", messages: [] },
    { id: "grandchild", title: "writer", parentThreadId: "child", messages: [] },
    { id: "release-notes", title: "Release notes", messages: [] },
  ],
};

const started: { turn: TurnRequest; owner?: string }[] = [];

const runtime = () => {
  started.length = 0;
  const deps: LoopDeps = {
    request: async (method) => method === "snapshot" ? library : {},
    ask: () => undefined,
    answered: () => undefined,
    verify: async () => ({ model: "", prompt: "", reply: "", attempts: 0 }),
    advise: async () => ({ model: "", text: "" }),
    spawnTurn: (turn, owner) => { refuseBenchTurn(turn.threadId); started.push({ turn, owner }); },
    changed: () => undefined,
    step: () => undefined,
  };
  return new AgentRuntime(deps);
};

const replay = <T>(bench: boolean, run: () => T): T => bench ? benchReplay.run(true, run) : run();

const message = (bench: boolean, thread: string) =>
  replay(bench, () => runtime().runThreadTool(parseToolArgs("threads", JSON.stringify({ action: "message", thread, prompt: "do the thing" })), {
    threadId: "case", content: "replay", mode: "acceptEdits", title: "Bench · fix the flaky test", bench,
  }));

const stopping = (bench: boolean, agent: string) =>
  replay(bench, () => runtime().runThreadTool(parseToolArgs("agents", JSON.stringify({ agent, stop: true })), {
    threadId: "case", content: "replay", mode: "acceptEdits", title: "Bench · fix the flaky test", bench,
  }));

test("the boundary lives where a turn is dispatched, so every tool is covered by one refusal", () => {
  ownBench("case");
  assert.equal(inheritBench("child", "case"), false, "a live bench parent hands ownership down, not a stop");
  assert.equal(inheritBench("grandchild", "child"), false);
  assert.equal(inheritBench("release-notes", "someone-else"), false, "a thread the bench never started stays the user's");

  benchReplay.run(true, () => {
    assert.throws(() => refuseBenchTurn("release-notes"), /measured bench replay/);
    refuseBenchTurn("case");
    refuseBenchTurn("grandchild");
  });
  refuseBenchTurn("release-notes");
});

test("a bench replay cannot start a turn in a thread it did not create", async () => {
  await assert.rejects(() => message(true, "release-notes"), /measured bench replay/);
  assert.deepEqual(started, [], "the refused call still started a turn in the user's thread");
});

test("a bench replay may still drive the threads it started itself, however deep", async () => {
  assert.match(await message(true, "grandchild"), /starts a turn of its own/);
  assert.equal(started.length, 1);
  assert.equal(started[0].turn.threadId, "grandchild");
});

test("a messaged thread is told which thread owns it, or it runs in a scratch dir Emma never deletes", async () => {
  await message(true, "grandchild");
  assert.equal(started[0].owner, "case", "no owner means no folder: the turn measures an empty directory");
});

test("a turn that is not a replay reaches any thread, as the tool has always let it", async () => {
  assert.match(await message(false, "release-notes"), /starts a turn of its own/);
  assert.equal(started.length, 1);
  assert.equal(started[0].turn.bench, undefined, "the flag is stamped where the turn is dispatched, never forwarded here");
});

test("a bench replay cannot stop an agent in a thread it did not create", async () => {
  await assert.rejects(() => stopping(true, "release-notes"), /measured bench replay/);
  assert.match(await stopping(true, "grandchild"), /Stopped grandchild/, "the threads it started are still its own to stop");
  assert.match(await stopping(true, "case"), /Stopped case/, "and so is the one it is running in");
  assert.match(await stopping(false, "release-notes"), /Stopped release-notes/, "a turn that is not a replay stops what it always could");
});

test("stopping a bench thread stops everything under it in one pass, and everything born under it after", () => {
  ownBench("arm");
  inheritBench("arm-child", "arm");
  inheritBench("arm-grandchild", "arm-child");
  assert.deepEqual(haltBench("arm").sort(), ["arm", "arm-child", "arm-grandchild"]);
  for (const id of ["arm", "arm-child", "arm-grandchild"]) {
    assert.throws(() => refuseBenchTurn(id), /has been stopped/, `${id} can still be put to work`);
  }
  assert.equal(inheritBench("late", "arm-grandchild"), true, "a descendant born after the stop starts running instead of arriving stopped");
  assert.throws(() => refuseBenchTurn("late"), /has been stopped/);
  assert.deepEqual(haltBench("arm"), [], "a second sweep is a no-op, so containment converges");
  assert.equal(benchThread("late"), true);
});

const fakeAgent = path.join(process.cwd(), "test", "fake-acp-agent.mjs");
const workspace = tmpdir();

const harness = () => new Harness({
  binaryPath: process.execPath,
  args: [fakeAgent],
  home: path.join(tmpdir(), `emma-bench-boundary-${process.pid}`),
  cwd: workspace,
  mcpServers: async () => [],
  onDelta: () => {},
  onThought: () => {},
  onToolCall: () => {},
  onContextExperiment: () => {},
  onRoutedModel: () => {},
  onContextBreakdown: () => {},
  onUsage: () => {},
  onChildStart: (child) => Promise.resolve(`thread_for_${child.childId}`),
  onChildEnd: () => {},
  onPlan: () => {},
  onPermission: async () => "allow_once",
  onToolRequest: async () => "",
  onLog: () => {},
});

test("a stop landing while the session is still opening is not swallowed", async () => {
  const client = harness();
  try {
    const turn = client.prompt("stop-during-setup", workspace, "measure this", "acceptEdits");
    await client.cancel("stop-during-setup");
    await assert.rejects(turn, /stopped before it reached the model/);
  } finally {
    client.close();
  }
});

test("a stop is spent by the turn it stopped, so the next message still runs", async () => {
  const client = harness();
  try {
    await client.cancel("stop-then-send").catch(() => undefined);
    const { stopReason } = await client.prompt("stop-then-send", workspace, "do it", "acceptEdits");
    assert.equal(stopReason, "end_turn");
  } finally {
    client.close();
  }
});
