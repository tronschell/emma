import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_GOAL_TOKEN_BUDGET, GOAL_BLOCKED_TURNS, MAX_GOAL_TURNS, goalDrivesAgain, goalResult, goalTitle,
  markedGoal, usageLimitedFailure, type Goal,
} from "../shared/goal";
import { goalBlock } from "../main/system-prompt";
import { describeToolCall, parseToolArgs, type ToolArgs } from "../main/tools";
import { towardGoal } from "../main/agent-loop";

const goal = (extra: Partial<Goal> = {}): Goal => ({
  objective: "Get the flaky login test green on CI",
  status: "active",
  evidence: "",
  blockedReason: "",
  blockedStreak: 0,
  blockedAtTurn: 0,
  tokenBudget: DEFAULT_GOAL_TOKEN_BUDGET,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  turns: 0,
  createdAt: "2026-08-24T00:00:00Z",
  updatedAt: "2026-08-24T00:00:00Z",
  ...extra,
});

const args = (value: Record<string, unknown>) => parseToolArgs("goal", JSON.stringify(value)) as Extract<ToolArgs, { name: "goal" }>;

test("each action names its own missing argument rather than half-doing the call", () => {
  assert.equal(args({}).action, "get", "an argument-free call reads the goal");
  assert.throws(() => args({ action: "wonder" }), /action must be one of/);
  assert.throws(() => args({ action: "set" }), /objective/);
  assert.throws(() => args({ action: "update" }), /status/);
  assert.throws(() => args({ action: "update", status: "paused-ish" }), /status must be one of/);
  assert.throws(() => args({ action: "extend" }), /extraTokens/);
  assert.throws(() => args({ action: "set", objective: "x", tokenBudget: 0 }), /whole number/);
  assert.throws(() => args({ action: "set", objective: "x", tokenBudget: 1e12 }), /tokenBudget must be between/);
  assert.deepEqual(args({ action: "set", objective: " Ship it ", tokenBudget: 50_000 }), {
    name: "goal", action: "set", objective: "Ship it", tokenBudget: 50_000,
    status: undefined, evidence: undefined, reason: undefined, extraTokens: undefined,
  });
});

test("completion is refused without evidence, and a blocker without a reason to compare", () => {
  assert.throws(() => args({ action: "update", status: "complete" }), /evidence/);
  assert.throws(() => args({ action: "update", status: "blocked" }), /reason/);
  assert.equal(args({ action: "update", status: "complete", evidence: "npm test printed 42 passing" }).evidence, "npm test printed 42 passing");
});

test("every result that points at a live goal carries the marker the card is drawn off", () => {
  for (const action of ["set", "get", "update", "extend"] as const) {
    const text = goalResult(action, "thread-7", goal());
    assert.equal(markedGoal(text), "thread-7", `${action} lost its marker`);
  }
  assert.equal(markedGoal(goalResult("clear", "thread-7", goal())), undefined);
  assert.equal(markedGoal(goalResult("get", "thread-7", undefined)), undefined);
  assert.match(goalResult("clear", "thread-7", goal()), /The goal is cleared/);

  const across = goalResult("set", "thread-7", goal({ objective: "Get CI green.\nDone means: every check passes." }));
  assert.equal(markedGoal(across), "thread-7");
});

test("the result tells the model what the state now means for it", () => {
  const set = goalResult("set", "t", goal({ tokenBudget: 120_000 }));
  assert.match(set, /120,000 tokens/);
  assert.match(set, /outlives this turn/);

  const halfSpent = goalResult("get", "t", goal({ tokensUsed: 90_000, turns: 4, timeUsedSeconds: 612 }));
  assert.match(halfSpent, /90,000 of 200,000 tokens spent and 110,000 left/);
  assert.match(halfSpent, /612 seconds/);
  assert.match(halfSpent, new RegExp(`turn 4 of at most ${MAX_GOAL_TURNS}`));

  const first = goalResult("update", "t", goal({ blockedStreak: 1, blockedReason: "the CI runner has no network" }));
  assert.match(first, new RegExp(`Blocker recorded — 1 of ${GOAL_BLOCKED_TURNS}`), "a blocker that has not repeated is counted, not obeyed");
  assert.match(first, /stays active/, "one blocked report leaves the goal active");
  assert.match(first, /Keep working/, "and says so, rather than leaving the model to guess");

  const stuck = goalResult("update", "t", goal({ status: "blocked", blockedStreak: 3, blockedReason: "the CI runner has no network" }));
  assert.match(stuck, /^Blocked: the CI runner has no network\./);
  assert.match(stuck, /pursuit stops here/);

  const done = goalResult("update", "t", goal({ status: "complete", evidence: "npm test printed 42 passing", turns: 6, tokensUsed: 71_000 }));
  assert.match(done, /^Achieved:/);
  assert.match(done, /6 turns and 71,000 of the 200,000 tokens/);

  const broke = goalResult("update", "t", goal({ status: "budgetLimited", tokensUsed: 200_000 }));
  assert.match(broke, /extend/);
  assert.match(goalResult("clear", "t", undefined), /pursuing nothing now/);
});

test("a goal drives another turn until something says otherwise", () => {
  assert.ok(goalDrivesAgain({ goal: goal({ turns: 3, tokensUsed: 40_000 }) }));
  assert.ok(!goalDrivesAgain({ goal: undefined }), "no goal, no continuation");
  assert.ok(!goalDrivesAgain({ goal: goal({ tokensUsed: DEFAULT_GOAL_TOKEN_BUDGET }) }), "the budget is the ceiling");
  assert.ok(!goalDrivesAgain({ goal: goal({ turns: MAX_GOAL_TURNS }) }), "and the turn count is the backstop");
  assert.ok(!goalDrivesAgain({ goal: goal({ status: "paused" }) }));
  assert.ok(!goalDrivesAgain({ goal: goal({ status: "complete", evidence: "it ships" }) }));
  assert.ok(!goalDrivesAgain({ goal: goal({ status: "blocked" }) }));
  assert.ok(!goalDrivesAgain({ goal: goal({ status: "usageLimited" }) }));
  assert.ok(!goalDrivesAgain({ goal: goal(), subagent: true }), "a subagent works inside someone else's turn, so nothing is driven at it");
  assert.ok(!goalDrivesAgain({ goal: goal(), halted: true }), "the user's Stop ends the pursuit, not just the turn it landed on");
});

test("a thread the user archived is never driven at on its own", () => {
  const source = readFileSync(path.join(__dirname, "..", "..", "main", "main.ts"), "utf8").split("\n");
  const guard = source.find((line) => line.includes("if (subagent ||"));
  const loop = source.find((line) => line.includes("goalDrivesAgain({ goal: goals.get(threadId)"));
  assert.ok(guard, "continueGoal's entry guard is not where the test looks for it");
  assert.match(guard, /thread\?\.archivedAt/, "an archived thread must not have a goal continuation driven at it");
  assert.ok(loop, "continueGoal's loop condition is not where the test looks for it");
  assert.match(loop, /!archived &&/, "archiving during a goal must end the continuation loop, not only block its entry");
  assert.ok(goalDrivesAgain({ goal: goal({ turns: 3, tokensUsed: 40_000 }) }), "an unarchived thread with an active goal still is");
});

test("a provider limit is not a goal that failed", () => {
  assert.ok(usageLimitedFailure("Provider returned 429 Too Many Requests"));
  assert.ok(usageLimitedFailure("openrouter: rate limit exceeded"));
  assert.ok(usageLimitedFailure("insufficient credits for this model"));
  assert.ok(!usageLimitedFailure("the build failed: 3 type errors"));
  assert.ok(!usageLimitedFailure(undefined));
});

test("the turn is told the objective, the numbers, and what completion costs", () => {
  const block = goalBlock(goal({ turns: 2, tokensUsed: 45_000, timeUsedSeconds: 300 }));
  assert.match(block, /Get the flaky login test green on CI/);
  assert.match(block, /45,000 of 200,000 spent, 155,000 left/);
  assert.match(block, /Time spent pursuing this goal: 300 seconds/);
  assert.match(block, /persists across turns/);
  assert.match(block, /never redefine success/);
  assert.match(block, /Never call it complete because the budget is nearly gone/);
  assert.match(block, new RegExp(`${GOAL_BLOCKED_TURNS} consecutive goal turns`));
  assert.match(block, /plan tool/);
});

test("what a thread starts while pursuing a goal is told what it is part of", () => {
  assert.match(towardGoal({ objective: "Get CI green" }, "Read the flake"), /pursuing an objective[\s\S]*Get CI green[\s\S]*Read the flake/);
  assert.equal(towardGoal({}, "Read the flake"), "Read the flake");
});

test("a goal set on an unnamed thread names it", () => {
  assert.equal(goalTitle("Get the flaky login test green on CI. Then tell me."), "Get the flaky login test green on CI.");
  assert.equal(goalTitle("Migrate every caller of send() off the old signature and make the suite pass"), "Migrate every caller of send() off the old…");
  assert.equal(goalTitle("  Ship  it  "), "Ship it");
});

test("the call reads back in the user's words on the agent rail", () => {
  assert.equal(describeToolCall(args({ action: "set", objective: "Get CI green" })), "setting this thread's goal: Get CI green");
  assert.equal(describeToolCall(args({ action: "update", status: "paused" })), "marking the goal paused");
  assert.equal(describeToolCall(args({ action: "clear" })), "clearing this thread's goal");
});
