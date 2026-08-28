import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../main/agent-loop";
import type { VerifierReview } from "../main/verifier";
import type { PermissionAsk } from "../shared/agents";
import type { PermissionMode } from "../shared/permissions";

const permitted: VerifierReview = { model: "verifier", prompt: "review", reply: "allow", attempts: 1, verdict: { allow: true, reason: "test" } };
const application = { threadId: "thread-one", tool: "computer", summary: "Control TextEdit", detail: "TextEdit only, for this turn" };

function fixture(mode: PermissionMode = "ask", verify = async () => permitted, onStop?: (threadId: string) => void) {
  const asked: PermissionAsk[] = [];
  const answered: { id: string; allowed: boolean }[] = [];
  const stopped: string[] = [];
  let reviews = 0;
  const runtime = new AgentRuntime({
    request: async () => ({}),
    ask: (ask) => asked.push(ask),
    answered: (id, allowed) => answered.push({ id, allowed }),
    stopped: (threadId) => { stopped.push(threadId); onStop?.(threadId); },
    verify: () => { reviews += 1; return verify(); },
    advise: async () => ({ model: "", text: "" }),
    spawnTurn: () => {},
    changed: () => {},
    step: () => {},
  });
  runtime.adopt({ threadId: application.threadId, mode, title: "Test", content: "Control TextEdit" });
  return { runtime, asked, answered, stopped, reviews: () => reviews };
}

test("human-only application approval always reaches the user in Auto and Full", async () => {
  for (const mode of ["auto", "full"] as const) {
    const { runtime, asked, answered, reviews } = fixture(mode);
    const pending = runtime.question(application, { humanOnly: true });
    assert.equal(asked.length, 1);
    assert.equal(reviews(), 0);
    assert.equal(runtime.list()[0].status, "waiting");
    runtime.answer(asked[0].id, true);
    assert.equal(await pending, true);
    assert.deepEqual(answered, [{ id: asked[0].id, allowed: true }]);
    assert.equal(runtime.list()[0].status, "running");
  }
});

test("ordinary Auto permissions still use the verifier", async () => {
  const { runtime, asked, reviews } = fixture("auto");
  assert.equal(await runtime.question({ ...application, tool: "terminal" }), true);
  assert.equal(reviews(), 1);
  assert.equal(asked.length, 0);
});

test("an aborted application request cannot be granted by a late answer", async () => {
  const { runtime, asked, answered } = fixture();
  const controller = new AbortController();
  const pending = runtime.question(application, { humanOnly: true, signal: controller.signal });
  controller.abort();
  runtime.answer(asked[0].id, true);
  assert.equal(await pending, false);
  assert.deepEqual(answered, [{ id: asked[0].id, allowed: false }]);
  assert.equal(runtime.list()[0].status, "running");
  assert.equal(await runtime.question(application, { humanOnly: true, signal: controller.signal }), false);
  assert.equal(asked.length, 1);
});

test("stopping a thread cancels its descendant asks without answering another thread", async () => {
  const { runtime, asked, answered } = fixture();
  runtime.adopt({ threadId: "child", parentThreadId: application.threadId, mode: "ask", title: "Child", content: "Test" });
  runtime.adopt({ threadId: "grandchild", parentThreadId: "child", mode: "ask", title: "Grandchild", content: "Test" });
  runtime.adopt({ threadId: "other", mode: "ask", title: "Other", content: "Test" });
  const pending = [application.threadId, "child", "grandchild", "other"].map((threadId) => runtime.question({ ...application, threadId }, { humanOnly: true }));
  runtime.stop(application.threadId);
  for (const ask of asked) runtime.answer(ask.id, true);
  assert.deepEqual(await Promise.all(pending), [false, false, false, true]);
  assert.deepEqual(answered.map((answer) => answer.allowed), [false, false, false, true]);
  assert.equal(await runtime.question(application, { humanOnly: true }), false);
});

test("finishing, forgetting and stopping all resolve outstanding asks exactly once", async () => {
  for (const close of [
    (runtime: AgentRuntime) => runtime.finish(application.threadId),
    (runtime: AgentRuntime) => runtime.forget(application.threadId),
    (runtime: AgentRuntime) => runtime.stopAll(),
  ]) {
    const { runtime, asked, answered } = fixture();
    const pending = runtime.question(application, { humanOnly: true });
    close(runtime);
    runtime.answer(asked[0].id, true);
    assert.equal(await pending, false);
    assert.deepEqual(answered, [{ id: asked[0].id, allowed: false }]);
  }
});

test("an old permission cannot approve a replacement turn", async () => {
  const { runtime, asked, answered } = fixture();
  const old = runtime.question(application, { humanOnly: true });
  runtime.adopt({ threadId: application.threadId, mode: "full", title: "Replacement", content: "New task" });
  const replacement = runtime.question(application, { humanOnly: true });
  runtime.answer(asked[0].id, true);
  assert.equal(await old, false);
  assert.deepEqual(answered, [{ id: asked[0].id, allowed: false }]);
  assert.equal(runtime.list()[0].status, "waiting");
  runtime.answer(asked[1].id, true);
  assert.equal(await replacement, true);
});

test("stopping after an answer but before its continuation still denies the request", async () => {
  const { runtime, asked } = fixture();
  const pending = runtime.question(application, { humanOnly: true });
  runtime.answer(asked[0].id, true);
  runtime.stop(application.threadId);
  assert.equal(await pending, false);
});

test("cancellation settles even while the verifier has not returned", async () => {
  for (const close of [
    (runtime: AgentRuntime, controller: AbortController) => controller.abort(),
    (runtime: AgentRuntime) => runtime.stop(application.threadId),
    (runtime: AgentRuntime) => runtime.finish(application.threadId),
  ]) {
    let release!: (review: VerifierReview) => void;
    const { runtime, asked } = fixture("auto", () => new Promise((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const pending = runtime.question(application, { signal: controller.signal });
    close(runtime, controller);
    assert.equal(await pending, false);
    release(permitted);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(asked, []);
  }
});

test("unanswered permissions time out and discard later replies", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { runtime, asked, answered } = fixture();
  const pending = runtime.question(application, { humanOnly: true });
  context.mock.timers.tick(10 * 60 * 1000);
  runtime.answer(asked[0].id, true);
  assert.equal(await pending, false);
  assert.deepEqual(answered, [{ id: asked[0].id, allowed: false }]);
  assert.equal(runtime.list()[0].status, "running");
});

test("missing and finished turns cannot request application access", async () => {
  const { runtime, asked } = fixture();
  assert.equal(await runtime.question({ ...application, threadId: "missing" }, { humanOnly: true }), false);
  runtime.finish(application.threadId);
  assert.equal(await runtime.question(application, { humanOnly: true }), false);
  assert.deepEqual(asked, []);
});

test("live state excludes stopped runs before their harness has finished", async () => {
  const { runtime, asked } = fixture();
  assert.equal(runtime.isLive("missing"), false);
  assert.equal(runtime.isLive(application.threadId), true);
  const pending = runtime.question(application, { humanOnly: true });
  assert.equal(runtime.isLive(application.threadId), true);
  runtime.answer(asked[0].id, true);
  assert.equal(await pending, true);
  runtime.stop(application.threadId);
  assert.equal(runtime.list()[0].status, "running");
  assert.equal(runtime.isLive(application.threadId), false);
  runtime.finish(application.threadId);
  assert.equal(runtime.isLive(application.threadId), false);
  runtime.adopt({ threadId: application.threadId, mode: "ask", title: "Next", content: "Next turn" });
  assert.equal(runtime.isLive(application.threadId), true);
  runtime.finish(application.threadId);
  assert.equal(runtime.isLive(application.threadId), false);
});

test("every direct stop route revokes an already-approved app grant once", async () => {
  for (const stop of [
    (runtime: AgentRuntime) => runtime.stop(application.threadId),
    (runtime: AgentRuntime) => runtime.stopAll(),
    (runtime: AgentRuntime) => runtime.runThreadTool({ name: "agents", agent: application.threadId, stop: true }, { threadId: application.threadId, mode: "full", title: "Test", content: "Stop" }),
  ]) {
    const grant = new AbortController();
    const { runtime, asked, stopped } = fixture("full", undefined, (threadId) => {
      assert.equal(runtime.isLive(threadId), false);
      if (threadId === application.threadId) grant.abort();
    });
    const approval = runtime.question(application, { humanOnly: true, signal: grant.signal });
    runtime.answer(asked[0].id, true);
    assert.equal(await approval, true);
    assert.equal(grant.signal.aborted, false);
    await stop(runtime);
    assert.equal(grant.signal.aborted, true);
    assert.equal(runtime.isLive(application.threadId), false);
    runtime.stop(application.threadId);
    runtime.stopAll();
    assert.deepEqual(stopped, [application.threadId]);
  }
});

test("stopping a parent revokes descendant grants without touching unrelated runs", () => {
  const grant = new AbortController();
  const { runtime, stopped } = fixture("ask", undefined, (threadId) => {
    if (threadId === "grandchild") grant.abort();
  });
  runtime.adopt({ threadId: "child", parentThreadId: application.threadId, mode: "ask", title: "Child", content: "Test" });
  runtime.adopt({ threadId: "grandchild", parentThreadId: "child", mode: "ask", title: "Grandchild", content: "Test" });
  runtime.adopt({ threadId: "other", mode: "ask", title: "Other", content: "Test" });
  runtime.stop(application.threadId);
  assert.equal(grant.signal.aborted, true);
  assert.deepEqual(stopped, [application.threadId, "child", "grandchild"]);
  assert.equal(runtime.isLive("grandchild"), false);
  assert.equal(runtime.isLive("other"), true);
  runtime.stopAll();
  assert.deepEqual(stopped, [application.threadId, "child", "grandchild", "other"]);
  assert.equal(runtime.isLive("other"), false);
});
