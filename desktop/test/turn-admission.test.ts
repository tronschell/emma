import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import type { TurnRequest } from "../main/agent-loop";

test("turn admission preserves active same-thread ownership until its cleanup finishes", async () => {
  const source = readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  const runTurnSource = source.match(/async function runTurn\(turn\) \{[\s\S]*?(?=\nasync function runRequest\()/)?.[0];
  assert.ok(runTurnSource);
  const owner = {};
  const grant = {};
  const harnessRuns = new Map<string, unknown>([["active", owner]]);
  const grants = new Map<string, unknown>([["active", grant]]);
  const forgotten: string[] = [];
  const started: string[] = [];
  const runTurn = runInNewContext(`${runTurnSource}\nrunTurn`, {
    harnessRuns,
    agents: { forget: (threadId: string) => forgotten.push(threadId) },
    threadSubagent: () => undefined,
    harnessModel: (model: string) => model,
    selectedModel: "model",
    selectedEffort: "",
    activeGoal: () => undefined,
    harnessCwd: (threadId: string) => `/workspace/${threadId}`,
    settings_1: { codexSlug: () => undefined },
    turnRoute: async () => undefined,
    harness_1: { harnessKey: (cwd: string) => cwd },
    node_path_1: { default: path },
    electron_1: { app: { getPath: () => "/test-data" } },
    toolSettings: { disabledTools: [] },
    harnessClient: () => ({}),
    system_prompt_1: {
      writeHarnessPrompt: () => {},
      withGoal: (turn: TurnRequest) => turn,
      withTrialArm: (turn: TurnRequest) => turn,
    },
    runOnHarness: async (_client: unknown, _cwd: string, turn: TurnRequest) => {
      grants.delete(turn.threadId);
      harnessRuns.set(turn.threadId, {});
      started.push(turn.threadId);
      return turn.threadId;
    },
    harnesses: new Map(),
    changed: () => {},
  }) as (turn: TurnRequest) => Promise<string>;

  const blocked = { threadId: "active", content: "new request", mode: "full" as const, title: "Active thread" };
  await assert.rejects(runTurn(blocked), /still running or finishing/);
  assert.deepEqual(forgotten, []);
  assert.deepEqual(started, []);
  assert.equal(harnessRuns.get("active"), owner);
  assert.equal(grants.get("active"), grant);
  assert.deepEqual(Object.keys(blocked), ["threadId", "content", "mode", "title"]);

  assert.equal(await runTurn({ threadId: "other", content: "hello", mode: "ask", title: "Other thread" }), "other");
  assert.deepEqual(started, ["other"]);
  assert.equal(harnessRuns.get("active"), owner);
  assert.equal(grants.get("active"), grant);

  harnessRuns.delete("active");
  assert.equal(await runTurn(blocked), "active");
  assert.deepEqual(forgotten, ["other", "active"]);
  assert.deepEqual(started, ["other", "active"]);
});

test("sendMessage keeps explicit context without automatically loading a learned skill", () => {
  const source = readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  assert.doesNotMatch(source, /bestLearnedSkill|skillParams/);
  const runRequest = source.match(/async function runRequest\(request\) \{[\s\S]*?(?=\nconst desktopIdentity)/)?.[0];
  assert.ok(runRequest);
  assert.match(runRequest, /params: extra/);
});
