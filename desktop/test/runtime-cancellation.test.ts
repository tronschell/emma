import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { AgentRuntime, OWN_TOOLS, benchReplay, type LoopDeps, type TurnRequest } from "../main/agent-loop";
import { Harness } from "../main/harness";
import type { HarnessLogLine } from "../shared/harness-log";
import { describeToolCall, parseToolArgs } from "../main/tools";
import { toolGate } from "../shared/permissions";
import type { PermissionAsk } from "../shared/agents";
import type { VerifierReview } from "../main/verifier";

const source = ts.createSourceFile("main.ts", readFileSync(path.join(process.cwd(), "main/main.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const execute = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "runEmmaTool")!;
const compiled = ts.transpileModule(`(${execute.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const turn: TurnRequest = { threadId: "t", title: "inert", content: "inert", mode: "auto" };
const allow: VerifierReview = { model: "fake", prompt: "", reply: "", attempts: 1, verdict: { allow: true, reason: "inert" } };
const ask = { threadId: "t", tool: "run_tool", summary: "inert", detail: "inert" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(deps: Partial<LoopDeps> = {}, mode = turn.mode) {
  const asked: PermissionAsk[] = [];
  const answered: boolean[] = [];
  const agents = new AgentRuntime({
    request: async () => ({}), ask: (value) => asked.push(value), answered: (_id, value) => answered.push(value),
    verify: async () => allow, advise: async () => ({ model: "fake", text: "inert" }),
    spawnTurn() {}, changed() {}, step() {}, ...deps,
  });
  const current = { ...turn, mode };
  agents.adopt(current);
  const harnessTurns = new Map([[turn.threadId, current]]);
  let executed = 0;
  const run = runInNewContext(compiled, {
    HARNESS_TOOL_NAMES: {}, harnessTurns, agents, toolGate, toolSettings: { disabledTools: [] },
    whyUnavailable: () => undefined, parseToolArgs, describeToolCall, OWN_TOOLS, benchReplay,
    executeTool: async () => { executed++; return "inert"; },
  }) as (threadId: string, name: string, args: Record<string, unknown>) => Promise<string>;
  return { agents, asked, answered, harnessTurns, run: () => run("t", "run_tool", { name: "inert-marker" }), executed: () => executed };
}

for (const stop of ["stop", "stopAll", "finish", "cleanup", "replace", "map-cleanup", "map-replace"] as const) {
  for (const review of [allow, { ...allow, verdict: { allow: false, reason: "no" } }, { ...allow, verdict: undefined, error: "offline" }]) {
    test(`${stop} during verifier ${review.error ?? review.verdict?.allow} never executes`, async () => {
      const pending = deferred<VerifierReview>();
      const f = fixture({ verify: () => pending.promise });
      const result = f.run();
      const rejected = assert.rejects(result);
      if (stop === "cleanup" || stop === "replace") {
        f.agents.finish("t");
        f.agents.forget("t");
        if (stop === "replace") f.agents.adopt(turn);
      } else if (stop === "map-cleanup") f.harnessTurns.delete("t");
      else if (stop === "map-replace") f.harnessTurns.set("t", { ...turn });
      else f.agents[stop]("t");
      pending.resolve(review);
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const request of f.asked) f.agents.answer(request.id, true);
      await rejected;
      assert.equal(f.executed(), 0);
      if (!stop.startsWith("map-")) assert.equal(f.asked.length, 0);
    });
  }
}

for (const action of ["stop", "stopAll", "finish", "replace"] as const) {
  test(`${action} settles human asks and ignores late allow`, async () => {
    const f = fixture({}, "ask");
    const result = f.run();
    const rejected = assert.rejects(result);
    const id = f.asked[0].id;
    if (action === "replace") f.agents.adopt({ ...turn, mode: "ask" });
    else f.agents[action]("t");
    f.agents.answer(id, true);
    await rejected;
    assert.deepEqual(f.answered, [false]);
    assert.equal(f.executed(), 0);
  });
}

test("human approval followed synchronously by stop cannot resolve true", async () => {
  const f = fixture({}, "ask");
  const result = f.agents.question(ask);
  f.agents.answer(f.asked[0].id, true);
  f.agents.stop("t");
  assert.equal(await result, false);
});

test("stopping a parent cancels descendants without cancelling an unrelated ask", async () => {
  const f = fixture({}, "ask");
  f.agents.adopt({ ...turn, threadId: "child", parentThreadId: "t", mode: "ask" });
  f.agents.adopt({ ...turn, threadId: "grandchild", parentThreadId: "child", mode: "ask" });
  f.agents.adopt({ ...turn, threadId: "other", mode: "ask" });
  const pending = ["t", "child", "grandchild", "other"].map((threadId) => f.agents.question({ ...ask, threadId }));
  f.agents.stop("t");
  assert.equal(f.answered.length, 3);
  for (const request of f.asked) f.agents.answer(request.id, true);
  assert.deepEqual(await Promise.all(pending), [false, false, false, true]);
});

test("stale authorizations stay invalid across replacement and missing runs never ask", async () => {
  const f = fixture();
  const authorized = f.agents.authorization("t");
  assert.equal(authorized(), true);
  f.agents.finish("t");
  f.agents.adopt(turn);
  assert.equal(authorized(), false);
  assert.equal(f.agents.authorization("t")(), true);
  assert.equal(await f.agents.question({ ...ask, threadId: "missing" }), false);
  f.agents.stop("t");
  assert.equal(await f.agents.question(ask), false);
  await assert.rejects(f.run());
  assert.equal(f.asked.length, 0);
  assert.equal(f.executed(), 0);
});

for (const mode of ["auto", "ask", "full"] as const) {
  test(`unstopped ${mode} approval executes exactly once`, async () => {
    const f = fixture({}, mode);
    const result = f.run();
    if (mode === "ask") f.agents.answer(f.asked[0].id, true);
    assert.equal(await result, "inert");
    assert.equal(f.executed(), 1);
  });
}

for (const cancel of ["none", "parent", "child", "parent-of-child"] as const) {
  test(`fake ACP peer receives ${cancel === "none" ? "normal allow" : `no allow after ${cancel} cancel`}`, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "emma-cancel-test-"));
    const entered = deferred<void>();
    const decision = deferred<string>();
    const logs: HarnessLogLine[] = [];
    const client = new Harness({
      binaryPath: process.execPath, args: [path.join(process.cwd(), "test/fake-acp-agent.mjs")], home, cwd: tmpdir(),
      mcpServers: async () => [], onDelta() {}, onThought() {}, onToolCall() {}, onUsage() {}, onPlan() {},
      onContextExperiment() {}, onRoutedModel() {}, onContextBreakdown() {},
      onChildStart: async () => "child", onChildEnd() {}, onToolRequest: async () => "inert",
      onPermission: async () => { entered.resolve(); return await decision.promise; }, onLog: (line) => logs.push(line),
    });
    try {
      const result = client.prompt("t", tmpdir(), cancel.endsWith("child") ? "childask" : "inert", "ask");
      await entered.promise;
      if (cancel.startsWith("parent")) await client.cancel("t");
      if (cancel === "child") await client.cancelChild("child_1").catch(() => undefined);
      decision.resolve("allow_once");
      await result;
      const reply = logs.find((line) => line.flow === "out" && line.body.includes('"id":99'));
      assert.ok(reply);
      assert.equal(reply.body.includes('"optionId":"allow_once"'), cancel === "none");
      if (cancel.startsWith("parent")) assert.ok(logs.some((line) => line.flow === "out" && line.body.includes('"method":"session/cancel"')));
    } finally {
      client.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("a child adopted after its parent stops cannot authorize a tool", async () => {
  const f = fixture();
  f.agents.stop("t");
  f.agents.adopt({ ...turn, threadId: "late-child", parentThreadId: "t" });
  assert.equal(await f.agents.question({ ...ask, threadId: "late-child" }), false);
  assert.equal(f.asked.length, 0);
});

test("a rejected verifier after stop cannot execute", async () => {
  const pending = deferred<void>();
  const f = fixture({ verify: async () => { await pending.promise; throw new Error("inert failure"); } });
  const result = f.run();
  const rejected = assert.rejects(result);
  f.agents.stop("t");
  pending.resolve();
  await rejected;
  assert.equal(f.executed(), 0);
});

for (const child of [false, true]) {
  test(`a new parent turn ${child ? "preserves a surviving child's approval" : "invalidates its own stale approval"}`, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "emma-replacement-test-"));
    const entered = deferred<void>();
    const decision = deferred<string>();
    const logs: HarnessLogLine[] = [];
    const client = new Harness({
      binaryPath: process.execPath, args: [path.join(process.cwd(), "test/fake-acp-agent.mjs")], home, cwd: tmpdir(),
      mcpServers: async () => [], onDelta() {}, onThought() {}, onToolCall() {}, onUsage() {}, onPlan() {},
      onContextExperiment() {}, onRoutedModel() {}, onContextBreakdown() {},
      onChildStart: async () => "child", onChildEnd() {}, onToolRequest: async () => "inert",
      onPermission: async (ask) => {
        if (ask.id !== "pending-approval") return "allow_once";
        entered.resolve();
        return await decision.promise;
      },
      onLog: (line) => logs.push(line),
    });
    const peer = client as unknown as {
      sessions: Map<string, string>;
      handlePermission(id: number, params: Record<string, unknown>): Promise<void>;
    };
    try {
      await client.prompt("t", tmpdir(), "orphan", "ask");
      const pending = peer.handlePermission(777, {
        sessionId: peer.sessions.get("t"),
        toolCall: { toolCallId: "pending-approval", title: "inert", rawInput: {} },
        options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
        ...(child ? { _meta: { fx: { child: { id: "child_1", title: "inert", state: "running" } } } } : {}),
      });
      await entered.promise;
      await client.prompt("t", tmpdir(), "inert", "ask");
      decision.resolve("allow_once");
      await pending;
      const reply = logs.find((line) => line.flow === "out" && line.body.includes('"id":777'));
      assert.ok(reply);
      assert.equal(reply.body.includes('"optionId":"allow_once"'), child);
    } finally {
      client.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
}

function nativeFixture(f: ReturnType<typeof fixture>, kind = "execute", threadId = "t") {
  let permission!: ts.Expression;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "onPermission") permission = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  const onPermission = runInNewContext(ts.transpileModule(`(${permission.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, { agents: f.agents, broadcast() {} });
  const client = new Harness({ onPermission } as ConstructorParameters<typeof Harness>[0]);
  const replies: { result: { outcome: { optionId?: string } } }[] = [];
  const peer = client as unknown as {
    threadsBySession: Map<string, string>;
    handlePermission(id: number, params: Record<string, unknown>): Promise<void>;
  };
  peer.threadsBySession.set("session", threadId);
  Object.assign(client, { send: (reply: typeof replies[number]) => replies.push(reply) });
  return {
    run: () => peer.handlePermission(1, {
      sessionId: "session", options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }],
      toolCall: { toolCallId: "call", title: "inert", kind, rawInput: {} },
    }),
    replies,
  };
}

for (const mode of ["full", "acceptEdits"] as const) {
  test(`${mode} to Ask immediately gates app tools and native edits`, async () => {
    const f = fixture({}, mode);
    const native = nativeFixture(f, "edit");
    f.agents.setMode("t", "ask");
    const app = f.run();
    const rejected = assert.rejects(app);
    const acp = native.run();
    assert.equal(f.asked.length, 2);
    assert.equal(f.executed(), 0);
    assert.equal(native.replies.length, 0);
    for (const request of f.asked) f.agents.answer(request.id, false);
    await Promise.all([rejected, acp]);
    assert.equal(f.executed(), 0);
    assert.equal(native.replies[0].result.outcome.optionId, "deny");
  });
}

for (const boundary of ["app", "native"] as const) {
  test(`Auto to Ask during ${boundary} review requires a human answer`, async () => {
    const review = deferred<VerifierReview>();
    const f = fixture({ verify: () => review.promise });
    const native = nativeFixture(f);
    const pending = boundary === "app" ? f.run() : native.run();
    f.agents.setMode("t", "ask");
    review.resolve(allow);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.asked.length, 1);
    assert.equal(f.executed(), 0);
    assert.equal(native.replies.length, 0);
    f.agents.answer(f.asked[0].id, true);
    await pending;
    if (boundary === "app") assert.equal(f.executed(), 1);
    else assert.equal(native.replies[0].result.outcome.optionId, "allow");
  });
}

for (const mode of ["full", "acceptEdits", "auto", "ask"] as const) {
  test(`unchanged ${mode} native edit retains its policy`, async () => {
    const f = fixture({}, mode);
    const native = nativeFixture(f, "edit");
    const pending = native.run();
    if (mode === "ask") f.agents.answer(f.asked[0].id, true);
    await pending;
    assert.equal(f.asked.length, mode === "ask" ? 1 : 0);
    assert.equal(native.replies[0].result.outcome.optionId, "allow");
  });
}

test("mode changes reach descendants and newly adopted children without changing unrelated runs", () => {
  const f = fixture({}, "full");
  f.agents.adopt({ ...turn, threadId: "child", parentThreadId: "t", mode: "full" });
  f.agents.adopt({ ...turn, threadId: "grandchild", parentThreadId: "child", mode: "full" });
  f.agents.adopt({ ...turn, threadId: "other", mode: "full" });
  f.agents.setMode("t", "ask");
  f.agents.adopt({ ...turn, threadId: "late-child", parentThreadId: "child", mode: "full" });
  for (const id of ["t", "child", "grandchild", "late-child"]) assert.equal(f.agents.mode(id), "ask");
  assert.equal(f.agents.mode("other"), "full");
});

for (const channel of ["desktop", "mobile"] as const) {
  test(`${channel} context setter changes active app and native authorization`, async () => {
    let setter = "";
    const visit = (node: ts.Node) => {
      if (channel === "mobile" && ts.isCaseClause(node) && node.expression.getText(source) === '"setThreadContext"') {
        setter = `(params) => ${node.statements[0].getText(source)}`;
      }
      if (channel === "desktop" && ts.isCallExpression(node) && node.expression.getText(source) === "ipcMain.handle"
        && node.arguments[0]?.getText(source) === '"emma:set-thread-context"') setter = node.arguments[1].getText(source);
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.ok(setter);
    const f = fixture({}, "full");
    const context = { threadId: "t", folderIds: [], mode: "ask", model: "" };
    const set = runInNewContext(ts.transpileModule(`(${setter})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      agents: f.agents, threadContexts: new Map(), threadContextRequest: () => context, mainWindowSender() {}, overlay: undefined,
    });
    if (channel === "desktop") set({ sender: { mainFrame: {} } }, context);
    else set(context);
    const native = nativeFixture(f);
    const app = f.run();
    const rejected = assert.rejects(app);
    const acp = native.run();
    assert.equal(f.asked.length, 2);
    for (const request of f.asked) f.agents.answer(request.id, false);
    await Promise.all([rejected, acp]);
    assert.equal(f.executed(), 0);
    assert.equal(native.replies[0].result.outcome.optionId, "deny");
  });
}

test("spawn inherits mode changed while thread creation awaits", async () => {
  const created = deferred<unknown>();
  const spawned: TurnRequest[] = [];
  const f = fixture({ request: () => created.promise, spawnTurn: (request) => { spawned.push(request); } }, "full");
  const pending = f.agents.runThreadTool({ name: "threads", action: "spawn", title: "inert", prompt: "inert", limit: 10 }, { ...turn, mode: "full" });
  f.agents.setMode("t", "ask");
  created.resolve({ id: "child" });
  await pending;
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].mode, "ask");
});


test("a native grandchild asks under its parent's updated mode", async () => {
  const f = fixture({}, "full");
  f.agents.adopt({ ...turn, threadId: "child", parentThreadId: "t", mode: "full" });
  f.agents.adopt({ ...turn, threadId: "grandchild", parentThreadId: "child", mode: "full" });
  const native = nativeFixture(f, "execute", "grandchild");
  f.agents.setMode("t", "ask");
  const pending = native.run();
  assert.equal(f.asked.length, 1);
  assert.equal(f.asked[0].threadId, "grandchild");
  f.agents.answer(f.asked[0].id, false);
  await pending;
  assert.equal(native.replies[0].result.outcome.optionId, "deny");
});
