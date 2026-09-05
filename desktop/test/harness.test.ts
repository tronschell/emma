import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { withThinking } from "../shared/thinking";
import { artifactWritten } from "../shared/artifacts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { defaultHarnessExperiments, validateHarnessExperiments } from "../shared/settings";
import { CLOSED_BY_EMMA, fixPrompt, harnessHealth, STALL_MS, stoppedReason, type HarnessLogLine, type HarnessState } from "../shared/harness-log";
import { Harness, HARNESS_MODE_ID, INTERRUPTED_CALL, RESTARTED_BY_YOU, explainFailure, callEscapesWorkspace, compactionReported, contextBreakdownReported, contextExperimentFired, describePath, effortOption, escapesRoot, experimentOption, failedTurn, harnessKey, recoveredSessionTraces, toolCallText, toolOutput, turnUsageReported, unwrapMcpResult, type HarnessToolCall, type PermissionAsk, type PermissionContext, type PermissionOption } from "../main/harness";
import { decodeSpans, encodeSpans } from "../shared/trace";

const fakeAgent = path.join(process.cwd(), "test", "fake-acp-agent.mjs");

const workspace = tmpdir();

function harness(
  answer: (ask: PermissionAsk, options: PermissionOption[]) => Promise<string | null>,
  idleMs?: number,
  runTool: (threadId: string, name: string, args: Record<string, unknown>) => Promise<string> = async () => "",
  home = path.join(tmpdir(), `emma-harness-${process.pid}`),
) {
  const deltas: { threadId: string; delta: string }[] = [];
  const thoughts: string[] = [];
  const calls: HarnessToolCall[] = [];
  const asks: PermissionAsk[] = [];
  const contexts: PermissionContext[] = [];
  const children: { parentThreadId: string; childId: string; title: string }[] = [];
  const ended: { threadId: string; reason?: string }[] = [];
  const usages: { threadId: string; inputTokens: number; outputTokens: number }[] = [];
  const toolRequests: { threadId: string; name: string; args: Record<string, unknown> }[] = [];
  const logs: HarnessLogLine[] = [];
  const phases: string[] = [];
  const compactions: { threadId: string; removedTurns: number; summaryChars: number; modelWritten: boolean }[] = [];
  const client = new Harness({
    binaryPath: process.execPath,
    args: [fakeAgent],
    home,
    cwd: workspace,
    idleMs,
    mcpServers: async () => [],
    onDelta: (threadId, delta) => deltas.push({ threadId, delta }),
    onThought: (_threadId, delta) => thoughts.push(delta),
    onToolCall: (call) => calls.push(call),
    onCompacted: (threadId, compacted) => compactions.push({ threadId, ...compacted }),
    onContextExperiment: () => {},
    onRoutedModel: () => {},
    onContextBreakdown: () => {},
    onUsage: (threadId, usage) => usages.push({ threadId, ...usage }),
    onChildStart: (child) => { children.push(child); return Promise.resolve(`thread_for_${child.childId}`); },
    onChildEnd: (threadId, reason) => ended.push({ threadId, reason }),
    onPlan: () => {},
    onPermission: (ask, options, context) => {
      asks.push(ask);
      contexts.push(context);
      return answer(ask, options);
    },
    onToolRequest: (threadId, name, args) => {
      toolRequests.push({ threadId, name, args });
      return runTool(threadId, name, args);
    },
    onPhase: (_threadId, phase) => phases.push(phase),
    onLog: (line) => logs.push(line),
  });
  return { client, logs, phases, deltas, text: () => deltas.map((entry) => entry.delta), thoughts, calls, asks, contexts, children, ended, usages, toolRequests, compactions };
}

test("every mode routes its decision back to Emma", () => {

  assert.equal(HARNESS_MODE_ID, "ask");
});

test("session checkpoints restore tool calls missing from a stored trace", () => {
  const home = mkdtempSync(path.join(tmpdir(), "emma-recovered-trace-"));
  const sessionId = "session-one";
  const threadId = "thread-one";
  const session = path.join(home, ".fx", "sessions", sessionId);
  mkdirSync(session, { recursive: true });
  writeFileSync(path.join(home, "emma-sessions.json"), JSON.stringify({ [threadId]: sessionId }));
  writeFileSync(path.join(session, "checkpoint.json"), JSON.stringify({
    state: {
      updated_at_ms: 400_000,
      history: [{
        execution: {
          tool_steps: [{
            tool_calls: [{ id: "old", name: "search_tools", arguments_json: "{}" }],
            tool_results: [{ tool_call_id: "old", tool_name: "search_tools", status: "success", output: "old", created_at_ms: 1_000 }],
          }],
        },
      }],
      recovery_checkpoint: {
        execution: {
          tool_steps: [
            {
              tool_calls: [{ id: "one", name: "read_file", arguments_json: "{\"path\":\"a.txt\"}" }],
              tool_results: [{ tool_call_id: "one", tool_name: "read_file", status: "success", output: "one", created_at_ms: 300_000 }],
            },
            {
              tool_calls: [{ id: "two", name: "edit_file", arguments_json: "{\"path\":\"a.txt\"}" }],
              tool_results: [{ tool_call_id: "two", tool_name: "edit_file", status: "failure", output: "two", created_at_ms: 300_001 }],
            },
          ],
        },
      },
    },
  }));
  const root = { id: `agent:${threadId}`, name: "This thread", kind: "agent", startedAt: 250_000, endedAt: 400_000, status: "failed" as const };
  const stored = [{
    timestamp: new Date(400_000).toISOString(),
    text: encodeSpans([root, { id: "call:two", parentId: root.id, name: "Editing file", kind: "edit", startedAt: 350_000, endedAt: 350_001, status: "failed" }]),
  }];
  try {
    const recovered = recoveredSessionTraces(home, threadId, stored);
    const calls = recovered.flatMap((trace) => decodeSpans(trace.text)).filter((span) => span.id.startsWith("call:"));
    assert.deepEqual(calls.map((call) => call.id), ["call:old", "call:one", "call:two"]);
    assert.equal(calls[1].input, "{\"path\":\"a.txt\"}");
    assert.equal(calls[2].output, "two");
    assert.equal(calls[2].status, "failed");
    assert.deepEqual(recoveredSessionTraces(home, threadId, recovered), recovered);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a path outside the workspace is an escape, and one inside is not", () => {
  const root = path.join(tmpdir(), `emma-sandbox-${process.pid}`);
  mkdirSync(path.join(root, "inside"), { recursive: true });
  writeFileSync(path.join(root, "inside", "file.txt"), "x");

  assert.equal(escapesRoot(root, "inside/file.txt"), false);
  assert.equal(escapesRoot(root, "inside/not-yet-created.txt"), false);
  assert.equal(escapesRoot(root, "."), false);

  assert.equal(escapesRoot(root, "brand/new/nested.txt"), false);

  assert.equal(escapesRoot(root, "../escaped.txt"), true);
  assert.equal(escapesRoot(root, "/etc/passwd"), true);
  assert.equal(escapesRoot(root, path.join(tmpdir(), "elsewhere.txt")), true);
});

test("a symlink pointing out of the workspace does not smuggle a write through", () => {
  const root = path.join(tmpdir(), `emma-symlink-${process.pid}`);
  const outside = path.join(tmpdir(), `emma-outside-${process.pid}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  try { symlinkSync(outside, path.join(root, "bridge")); } catch { return; }

  assert.equal(escapesRoot(root, "bridge/owned.txt"), true);
});

test("an escape is caught in any path-shaped argument, not just the first", () => {
  const root = path.join(tmpdir(), `emma-args-${process.pid}`);
  mkdirSync(root, { recursive: true });

  assert.equal(callEscapesWorkspace(root, { path: "inside.txt" }), false);
  assert.equal(callEscapesWorkspace(root, { command: "echo hi" }), false);
  assert.equal(callEscapesWorkspace(root, undefined), false);

  assert.equal(callEscapesWorkspace(root, { old_path: "inside.txt", new_path: "/etc/cron.d/owned" }), true);
  assert.equal(callEscapesWorkspace(root, { source: "a.txt", destination: "../../b.txt" }), true);
  assert.equal(callEscapesWorkspace(root, { paths: ["ok.txt", "/etc/passwd"] }), true);
  assert.equal(callEscapesWorkspace(root, { cwd: "/" }), true);
});

test("a refused turn is a failure rather than an answer", () => {

  assert.equal(failedTurn("refused"), true);
  assert.equal(failedTurn("end_turn"), false);
  assert.equal(failedTurn("cancelled"), false);
});

test("a bare Zig error name is read out as words with a way forward", () => {
  assert.match(explainFailure("RequestTooLarge"), /outgrew what this model accepts/);
  assert.equal(explainFailure("InvalidProviderResponse"), "invalid provider response — the agent gave up on this turn. Send Continue to pick it back up");
  assert.equal(explainFailure("Timeout"), "timeout — the agent gave up on this turn. Send Continue to pick it back up");
  assert.equal(explainFailure("The model refused this turn."), "The model refused this turn.");
  assert.equal(explainFailure("429 rate limit reached"), "429 rate limit reached");
});

test("a file mutation is described by its path rather than by the word file_mutation", () => {
  assert.equal(describePath({ path: "src/main.ts" }), "src/main.ts");
  assert.equal(describePath({ old_path: "a", new_path: "b" }), "b");
  assert.equal(describePath({ command: "echo hi" }), undefined);
  assert.equal(describePath(undefined), undefined);
});

test("tool output keeps text blocks and ignores everything else", () => {
  assert.equal(toolOutput(undefined), undefined);
  assert.equal(toolOutput([]), undefined);
  assert.equal(toolOutput([{ type: "content", content: { type: "image", data: "x" } }]), undefined);
  assert.equal(
    toolOutput([
      { type: "content", content: { type: "text", text: "one" } },
      { type: "content", content: { type: "text", text: "two" } },
    ]),
    "one\ntwo",
  );
});

test("an MCP result is unwrapped from the envelope the harness reports it in", () => {
  const envelope = (text: string) => JSON.stringify({
    server: "linear", tool: "mcp_linear_create_issue",
    result: { resultType: "complete", content: [{ type: "text", text }] },
  });
  const wrote = 'Created ENG-412 "Ship the migration"\nIt is assigned to you.';
  assert.equal(unwrapMcpResult(envelope(wrote)), wrote);
  assert.equal(
    toolOutput([{ type: "content", content: { type: "text", text: envelope(wrote) } }]),
    wrote,
    "the unwrap happens where tool output is read, so every reader gets the text",
  );

  const long = `${wrote}${" and it has a long tail".repeat(6)}`;
  const cut = envelope(long).slice(0, 200);
  assert.throws(() => JSON.parse(cut), "the fixture has to be genuinely broken or this proves nothing");
  assert.equal(unwrapMcpResult(cut), long.slice(0, unwrapMcpResult(cut).length), "what survived is the tool's words, not a brace fragment");

  const artifact = `[artifact:long-one] Created the artifact "${"x".repeat(200)}"`.slice(0, 200);
  assert.equal(unwrapMcpResult(artifact), artifact, "a native tool's words are not an envelope");
  assert.equal(artifactWritten({ status: "completed", output: artifact }), "long-one");

  assert.equal(unwrapMcpResult("plain text"), "plain text");
  assert.equal(unwrapMcpResult('{"result":{"content":[{"type":"text","text":"x"}]}}'), '{"result":{"content":[{"type":"text","text":"x"}]}}');
  assert.equal(unwrapMcpResult('{"tool":"x","result":'), '{"tool":"x","result":');
  assert.equal(unwrapMcpResult('{"tool":"x","result":null}'), '{"tool":"x","result":null}');
});

test("one turn streams deltas, reports tool calls, and an allow reaches the harness", async () => {
  const { client, text, thoughts, calls, asks } = harness(async () => "allow_once");
  try {
    const { stopReason, usage } = await client.prompt("thread-1", workspace, "do it", "acceptEdits");
    assert.equal(stopReason, "end_turn");

    assert.ok(usage.outputTokens > 0, JSON.stringify(usage));

    assert.ok(text().join("").includes("mode=ask"), text().join(""));
    assert.ok(text().join("").includes("thinking"));

    assert.equal(thoughts.join(""), "weighing it up");
    assert.ok(!text().join("").includes("weighing"));
    assert.ok(text().join("").endsWith("done"));

    assert.equal(asks.length, 1);
    assert.equal(asks[0].threadId, "thread-1");
    assert.ok(asks[0].detail.includes("echo hi"));

    const final = calls.at(-1);
    assert.equal(final?.status, "completed");
    assert.equal(final?.output, "hi");

    assert.equal(final?.title, "bash");
    assert.equal(final?.kind, "execute");
  } finally {
    client.close();
  }
});

test("a harness that has gone quiet reports how long, and closing it hands the wedged turn back", async () => {

  const { client, deltas } = harness(async () => "allow_once");
  const wedged = client.prompt("thread-1", workspace, "wedge", "ask");
  while (!deltas.some((entry) => entry.delta === "wedged")) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(client.silentFor < 1000, `just heard from it: ${client.silentFor}`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(client.silentFor >= 50, `nothing since: ${client.silentFor}`);
  client.close();
  const closed = await wedged.then(() => "", (error: Error) => error.message);
  assert.match(closed, /Harness closed/);
  assert.equal(explainFailure(closed), "Emma was closed while it was in flight. Send Continue to pick it back up");
});

test("restarting the agent says so, rather than blaming a close", async () => {
  const { client, deltas } = harness(async () => "allow_once");
  const wedged = client.prompt("thread-1", workspace, "wedge", "ask");
  while (!deltas.some((entry) => entry.delta === "wedged")) await new Promise((resolve) => setTimeout(resolve, 10));
  client.close(RESTARTED_BY_YOU);
  const restarted = await wedged.then(() => "", (error: Error) => error.message);
  assert.equal(explainFailure(restarted), "You restarted the agent while this run was in flight. Send Continue to pick it back up");
});

function departingChild(leaveAfterEof: boolean) {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as string | null,
    killed: false,
    pid: undefined,
    kill() {
      child.killed = true;
      return true;
    },
    stdin: {
      destroyed: false,
      end() {
        if (!leaveAfterEof) return;
        setTimeout(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        }, 5);
      },
    },
  });
  return child;
}

test("closing lets emma-cli leave on its own once its stdin ends", async () => {
  const { client } = harness(async () => "allow_once");
  const child = departingChild(true);
  (client as unknown as { child: unknown }).child = child;
  await client.close();
  assert.equal(child.killed, false);
  assert.equal(child.exitCode, 0);
});

test("closing still kills an emma-cli that ignores its stdin ending", async () => {
  const { client } = harness(async () => "allow_once");
  const child = departingChild(false);
  (client as unknown as { child: unknown }).child = child;
  await client.close();
  assert.equal(child.killed, true);
});

test("a turn the agent never answers is handed back, and the wedged agent is replaced", async () => {

  const { client } = harness(async () => "allow_once", 500);
  await assert.rejects(client.prompt("thread-wedged", workspace, "wedge", "ask"), /stopped answering/);
  assert.equal(client.running, false);
  client.close();
});

test("a tool call still running keeps its silent turn alive past the idle window", async () => {
  const { client, calls } = harness(async () => "allow_once", 500);
  try {
    const { stopReason } = await client.prompt("thread-longtool", workspace, "longtool", "ask");
    assert.equal(stopReason, "end_turn");
    assert.equal(calls.at(-1)?.status, "completed");
    assert.equal(client.running, true);
  } finally {
    await client.close();
  }
});

test("a permission ask left open on screen does not kill the agent waiting on it", async () => {
  const { client, asks } = harness(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return "allow_once";
  }, 500);
  try {
    const { stopReason } = await client.prompt("thread-slowask", workspace, "run it", "ask");
    assert.equal(stopReason, "end_turn");
    assert.equal(asks.length, 1);
    assert.equal(client.running, true);
  } finally {
    await client.close();
  }
});

test("a subagent's words land on a thread of its own, never in its parent's answer", async () => {
  const { client, deltas, calls, children, ended, usages } = harness(async () => "allow_once");
  try {
    await client.prompt("thread-parent", workspace, "spawn a subagent", "ask");

    assert.deepEqual(children, [{ parentThreadId: "thread-parent", childId: "child_1", title: "read the docs" }]);
    const parent = deltas.filter((entry) => entry.threadId === "thread-parent").map((entry) => entry.delta).join("");
    assert.ok(parent.includes("parent speaks"), parent);
    assert.ok(!parent.includes("child speaks"), parent);
    assert.equal(deltas.filter((entry) => entry.threadId === "thread_for_child_1").map((entry) => entry.delta).join(""), "child speaks");

    assert.equal(calls.filter((call) => call.threadId === "thread_for_child_1").length, 1);
    assert.equal(calls.filter((call) => call.threadId === "thread-parent" && call.toolCallId === "call_1").length, 0);

    assert.deepEqual(usages, [{ threadId: "thread_for_child_1", inputTokens: 777, outputTokens: 42 }]);

    assert.deepEqual(ended, [{ threadId: "thread_for_child_1", reason: undefined }]);
  } finally {
    client.close();
  }
});

test("a subagent paused by a terminal provider failure ends with that reason", async () => {
  const { client, ended } = harness(async () => "allow_once");
  const inner = client as unknown as { threadsBySession: Map<string, string>; handleUpdate: (params: Record<string, unknown>) => void };
  inner.threadsBySession.set("session-child", "thread-parent");
  const tag = (state: string) => ({ child: { id: "child_1", title: "read the docs", state } });

  inner.handleUpdate({
    sessionId: "session-child",
    update: {
      sessionUpdate: "session_info_update",
      _meta: { fx: { ...tag("running"), modelResponseRecovery: { state: "paused", kind: "terminal_provider_error", cause: "provider_error", message: "The provider refused the request" } } },
    },
  });
  await Promise.resolve();
  assert.equal(client.paused.get("thread_for_child_1")?.message, "The provider refused the request");

  inner.handleUpdate({ sessionId: "session-child", update: { sessionUpdate: "session_info_update", _meta: { fx: tag("ended") } } });
  await Promise.resolve();

  assert.deepEqual(ended, [{ threadId: "thread_for_child_1", reason: "The provider refused the request" }]);
  assert.equal(client.paused.has("thread_for_child_1"), false);
  client.close();
});

test("a subagent left running when its process dies is told, not left spinning", async () => {
  const { client, children, ended } = harness(async () => "allow_once");
  await client.prompt("thread-parent", workspace, "orphan a subagent", "ask");
  assert.deepEqual(children.map((child) => child.childId), ["child_1"]);

  assert.equal(client.busy, true);
  assert.deepEqual(ended, []);
  client.close();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(ended, [{ threadId: "thread_for_child_1", reason: "Harness closed" }]);
  assert.equal(client.busy, false);
});

test("one of Emma's own tools runs in Emma and its answer reaches the harness", async () => {

  const { client, text, toolRequests } = harness(async () => "allow_once", undefined, async () => "two threads");
  try {
    await client.prompt("thread-1", workspace, "emmatool", "ask");
    assert.deepEqual(toolRequests, [{ threadId: "thread-1", name: "threads", args: { action: "list", limit: 5 } }]);
    assert.equal(text().at(-1), "output:11:two threads");
  } finally {
    client.close();
  }
});

test("a tool that throws in Emma answers the harness instead of hanging it", async () => {

  const { client, text } = harness(async () => "allow_once", undefined, async () => { throw new Error("not in plan mode"); });
  try {
    await client.prompt("thread-1", workspace, "emmatool", "ask");
    assert.equal(text().at(-1), "output:16:not in plan ");
  } finally {
    client.close();
  }
});

test("a tool that answers with more than the cap is cut, not sent whole", async () => {
  const { client, text } = harness(async () => "allow_once", undefined, async () => "x".repeat(70_000));
  try {
    await client.prompt("thread-1", workspace, "emmatool", "ask");
    assert.equal(text().at(-1), `output:${64 * 1024}:xxxxxxxxxxxx`);
  } finally {
    client.close();
  }
});

test("a call naming a session Emma does not know is refused, not run", async () => {
  const { client, text, toolRequests } = harness(async () => "allow_once", undefined, async () => "ran anyway");
  try {
    await client.prompt("thread-1", workspace, "emmatool nosession", "ask");

    assert.deepEqual(toolRequests, []);
    assert.equal(text().at(-1), "error:Unknown session or tool");
  } finally {
    client.close();
  }
});

test("computer calls from the current parent turn reach Emma once", async () => {
  const { client, text, toolRequests } = harness(async () => "allow_once", undefined, async () => "apps");
  try {
    await client.prompt("thread-computer", workspace, "computer replay", "full");
    assert.deepEqual(toolRequests, [{ threadId: "thread-computer", name: "computer", args: { action: "list_apps" } }]);
    assert.ok(text().includes("computer:apps"));
    assert.match(text().at(-1) ?? "", /Computer use must be performed by the parent turn/);
  } finally {
    client.close();
  }
});

test("child and unattributed computer calls never reach Emma", async () => {
  for (const scenario of ["child", "unknown", "completed"]) {
    const { client, text, toolRequests } = harness(async () => "allow_once", undefined, async () => "ran anyway");
    try {
      await client.prompt("thread-computer", workspace, `computer ${scenario}`, "auto");
      assert.deepEqual(toolRequests, [], scenario);
      assert.match(text().at(-1) ?? "", /Computer use must be performed by the parent turn/, scenario);
    } finally {
      client.close();
    }
  }
});

test("an older child cannot borrow a later parent turn's computer access", async () => {
  const { client, text, toolRequests } = harness(async () => "allow_once", undefined, async () => "apps");
  try {
    await client.prompt("thread-computer", workspace, "orphan a subagent", "full");
    await client.prompt("thread-computer", workspace, "computer oldchild", "full");
    assert.deepEqual(toolRequests, [{ threadId: "thread-computer", name: "computer", args: { action: "list_apps" } }]);
    assert.match(text().at(-2) ?? "", /Computer use must be performed by the parent turn/);
    assert.equal(text().at(-1), "computer:apps");
  } finally {
    client.close();
  }
});

test("unconsumed parent computer call IDs expire at the end of their turn", async () => {
  const { client, text, toolRequests } = harness(async () => "allow_once", undefined, async () => "ran anyway");
  try {
    await client.prompt("thread-computer", workspace, "computer prime", "full");
    await client.prompt("thread-computer", workspace, "computer stale", "full");
    assert.deepEqual(toolRequests, []);
    assert.match(text().at(-1) ?? "", /Computer use must be performed by the parent turn/);
  } finally {
    client.close();
  }
});

test("a message for a subagent is carried to the harness that owns it", async () => {
  const { client } = harness(async () => "allow_once");
  try {
    await client.prompt("thread-parent", workspace, "spawn a subagent", "ask");

    await client.steerChild("child_1", "look at the tests too");
    await assert.rejects(() => client.steerChild("child_gone", "hello"), /child_unavailable/);
  } finally {
    client.close();
  }
});

test("a turn longer than the idle window survives on the updates it streams", async () => {

  const { client, text } = harness(async () => "allow_once", 250);
  try {
    const { stopReason } = await client.prompt("thread-slow", workspace, "slow", "ask");
    assert.equal(stopReason, "end_turn");
    assert.equal(text().join("").endsWith("........"), true, text().join(""));
  } finally {
    client.close();
  }
});

test("a turn for another directory is refused instead of written to the wrong one", async () => {
  const { client } = harness(async () => "allow_once");
  try {

    await assert.rejects(
      () => client.prompt("thread-3", "/tmp/somewhere-else", "do it", "ask"),
      (error: unknown) => String(error).includes(`bound to ${workspace}`),
    );
  } finally {
    client.close();
  }
});

test("a declined permission denies the tool rather than silently allowing it", async () => {
  const { client, calls } = harness(async () => null);
  try {
    const { stopReason } = await client.prompt("thread-2", workspace, "do it", "ask");
    assert.equal(stopReason, "end_turn");
    const final = calls.at(-1);
    assert.equal(final?.status, "failed");
    assert.equal(final?.output, "denied");
  } finally {
    client.close();
  }
});

test("a subagent's permission question is asked against the subagent, not its parent", async () => {

  const { client, asks, children } = harness(async () => "allow_once");
  try {
    const { stopReason } = await client.prompt("thread-parent", workspace, "childask", "ask");
    assert.equal(stopReason, "end_turn");
    assert.deepEqual(children.map((child) => child.childId), ["child_1"]);
    assert.equal(asks.length, 1);
    assert.equal(asks[0].threadId, "thread_for_child_1");
    assert.equal(asks[0].tool, "index.html");
  } finally {
    client.close();
  }
});

test("a thread whose session another thread displaced still gets its own turn back", async () => {

  const { client, deltas } = harness(async () => "allow_once");
  try {
    await client.prompt("thread-a", workspace, "do it", "ask");
    await client.prompt("thread-b", workspace, "do it", "ask");
    const before = deltas.length;
    await client.prompt("thread-a", workspace, "do it", "ask");
    const back = deltas.slice(before);
    assert.ok(back.length > 0, "the second turn on thread-a streamed nothing at all");
    assert.deepEqual([...new Set(back.map((entry) => entry.threadId))], ["thread-a"]);
  } finally {
    client.close();
  }
});

test("two threads sharing a process take their turns one at a time", async () => {

  const { client, deltas } = harness(async () => "allow_once", 2000);
  try {
    await Promise.all([
      client.prompt("thread-slow", workspace, "slow", "ask"),
      client.prompt("thread-quick", workspace, "slow", "ask"),
    ]);

    for (const threadId of ["thread-slow", "thread-quick"]) {
      const spoken = deltas.filter((entry) => entry.threadId === threadId).map((entry) => entry.delta).join("");
      assert.ok(spoken.endsWith("........"), `${threadId} got ${JSON.stringify(spoken)}`);
    }

    const order = deltas.filter((entry) => entry.delta === ".").map((entry) => entry.threadId);
    assert.equal(order.filter((id, index) => index > 0 && id !== order[index - 1]).length, 1, order.join(","));
  } finally {
    client.close();
  }
});

const settles = (turn: Promise<unknown>, ms: number) =>
  Promise.race([turn.then(() => "ran", () => "ran"), new Promise<string>((resolve) => setTimeout(resolve, ms, "queued"))]);

test("a turn started inside a turn needs a process of its own, not the one its parent is running on", async () => {
  const spare = harness(async () => "allow_once");
  const nested: string[] = [];
  let queued: Promise<unknown> = Promise.resolve();
  const parent: ReturnType<typeof harness> = harness(async () => "allow_once", undefined, async () => {
    queued = parent.client.prompt("thread-sub", workspace, "do it", "ask");
    nested.push(await settles(queued, 300));
    nested.push(await settles(spare.client.prompt("thread-sub", workspace, "do it", "ask"), 5000));
    return "";
  });
  try {
    await spare.client.start();
    await parent.client.prompt("thread-root", workspace, "emmatool", "ask");
    assert.deepEqual(nested, ["queued", "ran"], "a turn started inside a turn waits for the turn that started it");
    await queued;
    assert.equal(harnessKey(workspace), workspace);
    assert.notEqual(harnessKey(workspace, "thread-sub"), harnessKey(workspace));
    assert.notEqual(harnessKey(workspace, "thread-sub"), harnessKey(workspace, "thread-other"));
    assert.notEqual(harnessKey(workspace, undefined, "deepseek"), harnessKey(workspace));
    assert.notEqual(harnessKey(workspace, undefined, "deepseek"), harnessKey(workspace, undefined, "zai"));
    assert.equal(harnessKey(workspace, undefined, ""), harnessKey(workspace));
  } finally {
    parent.client.close();
    spare.client.close();
  }
});

test("a requested compaction is asked for between turns, before the prompt it makes room for", async () => {

  const { client, text } = harness(async () => "allow_once");
  try {
    await client.prompt("thread-c", workspace, "do it", "ask");
    assert.ok(!text().join("").includes("compacted"), "an unrequested turn compacted anyway");
    await client.prompt("thread-c", workspace, "do it", "ask", undefined, { compact: true });
    const spoken = text().join("");
    assert.ok(spoken.includes("compacted "), spoken);

    assert.ok(spoken.indexOf("compacted ") < spoken.lastIndexOf("done"), spoken);

    await client.prompt("thread-c", workspace, "do it", "ask");
    assert.equal(text().join("").split("compacted ").length - 1, 1);
  } finally {
    client.close();
  }
});

test("separately-streamed reasoning rejoins the answer as one foldable message", () => {
  assert.equal(withThinking("", "answer"), "answer");
  assert.equal(withThinking(undefined, "answer"), "answer");
  assert.equal(withThinking("  why  ", "answer"), "<think>why</think>\nanswer");
});

test("a thread keeps its harness session across a restart", async () => {
  const home = path.join(tmpdir(), `emma-harness-restart-${process.pid}`);
  const index = (dir: string) => JSON.parse(readFileSync(path.join(dir, "emma-sessions.json"), "utf8")) as Record<string, string>;

  const first = harness(async () => "allow_once", undefined, async () => "", home);
  try {
    await first.client.prompt("thread-a", workspace, "one", "ask");
    await first.client.prompt("thread-b", workspace, "two", "ask");
  } finally {
    first.client.close();
  }
  const before = index(home)["thread-b"];
  assert.ok(before?.startsWith("sess_2_"), before);
  assert.notEqual(index(home)["thread-a"], before);

  const alias = path.join(tmpdir(), `emma-harness-alias-${process.pid}`);
  try { symlinkSync(home, alias, "junction"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const second = harness(async () => "allow_once", undefined, async () => "", alias);
  try {
    const { stopReason } = await second.client.prompt("thread-b", workspace, "again", "ask");
    assert.equal(stopReason, "end_turn");
    assert.ok(second.text().join("").endsWith("done"), second.text().join(""));
    assert.deepEqual(second.deltas.map((entry) => entry.threadId).at(-1), "thread-b");
  } finally {
    second.client.close();
  }
  assert.equal(index(alias)["thread-b"], before);
});

test("a session forgotten mid-turn still routes the rest of that turn", async () => {

  const made = harness(async () => { made.client.forgetSession("thread-4"); return "allow_once"; });
  const { client, text, calls } = made;
  try {
    const { stopReason } = await client.prompt("thread-4", workspace, "do it", "ask");
    assert.equal(stopReason, "end_turn");
    assert.ok(text().join("").endsWith("done"), text().join(""));
    assert.equal(calls.at(-1)?.status, "completed");
  } finally {
    client.close();
  }
});

test("experiment settings survive the round trip from the settings page to the harness option", () => {

  const settings = validateHarnessExperiments({ autoCompactPercent: 80, reinjectPromptSteps: 15, reinjectPromptPercent: 0, pruneToolsSteps: 0, pruneToolsPercent: 70 });
  assert.equal(experimentOption(settings), "compact_percent=80,reinject_steps=15,reinject_percent=0,prune_steps=0,prune_percent=70,command_timeout_minutes=10");
  assert.equal(validateHarnessExperiments({}).autoCompactPercent, 70);

  for (const bad of [{ reinjectPromptSteps: 999 }, { reinjectPromptPercent: -5 }, { pruneToolsSteps: 2.5 }, { pruneToolsPercent: "70" }])
    assert.throws(() => validateHarnessExperiments(bad), /invalid/);
  assert.throws(() => validateHarnessExperiments({ autoCompactPercent: 101 }), /invalid/);
  // A zero-minute command timeout would terminate every command the instant it started.
  for (const bad of [{ commandTimeoutMinutes: 0 }, { commandTimeoutMinutes: 121 }, { commandTimeoutMinutes: 1.5 }])
    assert.throws(() => validateHarnessExperiments(bad), /invalid/);
  assert.equal(validateHarnessExperiments({}).commandTimeoutMinutes, 10);
  assert.deepEqual(validateHarnessExperiments(undefined), defaultHarnessExperiments);
  assert.equal(validateHarnessExperiments({}).semanticGrep, false);
  assert.equal(validateHarnessExperiments({ semanticGrep: 1 }).semanticGrep, false);
  assert.equal(validateHarnessExperiments({ semanticGrep: true, embeddingModel: "local/embeddinggemma-300m" }).embeddingModel, "local/embeddinggemma-300m");
  assert.equal(validateHarnessExperiments({}).embeddingModel, "local/potion-code-16m-v2");
  assert.equal(validateHarnessExperiments({ embeddingModel: "hosted/openrouter/voyageai/voyage-code-4" }).embeddingModel, "hosted/openrouter/voyageai/voyage-code-4");
  assert.throws(() => validateHarnessExperiments({ embeddingModel: "qwen/text-embedding-v4" }), /invalid/);
  assert.throws(() => validateHarnessExperiments({ embeddingModel: "hosted/openrouter/openai/gpt-4o" }), /invalid/);
  assert.equal(experimentOption(defaultHarnessExperiments), "compact_percent=70,reinject_steps=0,reinject_percent=0,prune_steps=0,prune_percent=0,command_timeout_minutes=10");
});

test("the thinking option carries the stop and the list the harness checks it against", () => {

  assert.equal(effortOption({ level: "high", published: ["low", "medium", "high"] }), "high;low,medium,high");

  assert.equal(effortOption({ level: "", published: ["low", "medium", "high"] }), "auto;low,medium,high");

  assert.equal(effortOption({ level: "", published: [] }), "auto;");
});

test("a fired experiment is read off the info channel without swallowing the retry status", () => {

  assert.deepEqual(
    contextExperimentFired({ sessionUpdate: "session_info_update", _meta: { fx: { contextExperiment: { prunedResults: 6, reinjected: false, savedTokens: 12_400, addedTokens: 0 } } } }),
    { prunedResults: 6, reinjected: false, savedTokens: 12_400, addedTokens: 0 },
  );
  assert.deepEqual(
    contextExperimentFired({ _meta: { fx: { contextExperiment: { prunedResults: 0, reinjected: true, savedTokens: 0, addedTokens: 310 } } } }),
    { prunedResults: 0, reinjected: true, savedTokens: 0, addedTokens: 310 },
  );

  assert.deepEqual(
    contextExperimentFired({ _meta: { fx: { contextExperiment: { prunedResults: 2, reinjected: false } } } }),
    { prunedResults: 2, reinjected: false, savedTokens: 0, addedTokens: 0 },
  );

  assert.equal(contextExperimentFired({ _meta: { fx: { contextExperiment: { prunedResults: 0, reinjected: false } } } }), undefined);
  assert.equal(contextExperimentFired({ _meta: { fx: { modelResponseRecovery: { message: "retrying" } } } }), undefined);
  assert.equal(contextExperimentFired({}), undefined);
});

test("a step's usage is read off the same info channel", () => {
  assert.deepEqual(
    turnUsageReported({ sessionUpdate: "session_info_update", _meta: { fx: { turnUsage: { inputTokens: 24_100, outputTokens: 3_200, cacheInputTokens: 41_000, cacheReadTokens: 30_000 } } } }),
    { inputTokens: 24_100, outputTokens: 3_200, cacheInputTokens: 41_000, cacheReadTokens: 30_000 },
  );
  assert.deepEqual(turnUsageReported({ _meta: { fx: { turnUsage: {} } } }), { inputTokens: 0, outputTokens: 0 });
  assert.equal(turnUsageReported({ _meta: { fx: { contextExperiment: { prunedResults: 2, reinjected: false } } } }), undefined);
  assert.equal(turnUsageReported({ _meta: { fx: { modelResponseRecovery: { message: "retrying" } } } }), undefined);
  assert.equal(turnUsageReported({}), undefined);
});

test("provider cache writes and cost preserve exact zero and reject non-integers", () => {
  assert.deepEqual(
    turnUsageReported({ _meta: { fx: { turnUsage: { inputTokens: 10, outputTokens: 2, cacheWriteTokens: 0, costMicroUsd: 0 } } } }),
    { inputTokens: 10, outputTokens: 2, cacheWriteTokens: 0, costMicroUsd: 0 },
  );
  assert.deepEqual(
    turnUsageReported({ _meta: { fx: { turnUsage: { inputTokens: 10, outputTokens: 2, cacheWriteTokens: 1.5, costMicroUsd: Number.MAX_SAFE_INTEGER + 1 } } } }),
    { inputTokens: 10, outputTokens: 2 },
  );
});

test("the prefix breakdown crosses the same channel, byte for byte with the Zig that writes it", () => {
  const wire = '{"sessionUpdate":"session_info_update","_meta":{"fx":{"contextBreakdown":{"systemPromptBytes":9100,"systemToolsBytes":84000,"mcpToolsBytes":34400,"skillsBytes":5500,"memoryBytes":915}}}}';
  assert.deepEqual(contextBreakdownReported(JSON.parse(wire)), {
    systemPromptBytes: 9_100, systemToolsBytes: 84_000, mcpToolsBytes: 34_400, skillsBytes: 5_500, memoryBytes: 915,
  });
  assert.deepEqual(contextBreakdownReported({ _meta: { fx: { contextBreakdown: {} } } }), {
    systemPromptBytes: 0, systemToolsBytes: 0, mcpToolsBytes: 0, skillsBytes: 0, memoryBytes: 0,
  });
  assert.equal(contextBreakdownReported({ _meta: { fx: { turnUsage: { inputTokens: 10 } } } }), undefined);
  assert.equal(contextBreakdownReported({}), undefined);
});

test("everything Emma sends the agent is recorded, minus the streamed chunks", async () => {
  const { client, logs } = harness(async () => "allow_once");
  try {
    await client.prompt("thread-1", workspace, "do it", "acceptEdits");
    const sent = logs.filter((line) => line.flow === "out");
    const prompt = sent.find((line) => line.label.startsWith("session/prompt"));
    assert.ok(prompt, sent.map((line) => line.label).join(", "));
    assert.ok(prompt.body.includes("do it"), prompt.body);
    assert.ok(sent.some((line) => line.label.startsWith("initialize")));
    assert.ok(sent.some((line) => line.label.startsWith("session/set_mode")));

    const read = logs.filter((line) => line.flow === "in");
    assert.ok(read.length > 0);
    assert.ok(!read.some((line) => line.body.includes("_chunk")), read.map((line) => line.body).join("\n"));
  } finally {
    client.close();
  }
});

test("the user prompt stays ahead of attached context", async () => {
  const { client, logs } = harness(async () => "allow_once");
  try {
    await client.prompt("thread-1", workspace, "reply with the marker", "ask", undefined, { skillContext: "Attached local context. Treat this as reference data." });
    const prompt = logs.find((line) => line.flow === "out" && line.label.startsWith("session/prompt"));
    assert.ok(prompt, logs.map((line) => line.label).join(", "));
    const body = JSON.parse(prompt.body) as { params?: { prompt?: { text?: string }[] } };
    assert.deepEqual(body.params?.prompt?.map((part) => part.text), [
      "reply with the marker",
      "Attached local context. Treat this as reference data.",
    ]);
  } finally {
    client.close();
  }
});

test("a process that dies says so on the log, and a close Emma asked for does not", async () => {
  const { client, logs } = harness(async () => "allow_once");
  await client.prompt("thread-1", workspace, "hello", "ask");
  client.close();
  const stopped = logs.filter((line) => line.flow === "err" && line.label === "stopped");
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].body, CLOSED_BY_EMMA);
  assert.equal(harnessHealth([{ cwd: workspace, running: false, busy: false, silentMs: 10, failure: CLOSED_BY_EMMA }]), "ready");
});

test("a handshake the agent refuses leaves a dead client, not a running one", async () => {
  const { client, logs } = harness(async () => "allow_once", undefined, async () => "", path.join(tmpdir(), `emma-refused-handshake-${process.pid}`));
  await assert.rejects(client.prompt("thread-1", workspace, "refuse-initialize", "ask"));
  assert.equal(client.running, false);
  assert.equal(client.state.failure, "no credential");
  assert.ok(logs.some((line) => line.flow === "in" && line.label.startsWith("error")), logs.map((line) => line.label).join(", "));
  client.close();
});

test("health reads the process, and offline is a death Emma did not ask for", () => {
  const state = (extra: Partial<HarnessState>): HarnessState =>
    ({ cwd: workspace, running: false, busy: false, silentMs: 0, failure: "", ...extra });
  assert.equal(harnessHealth([]), "ready");
  assert.equal(harnessHealth([state({ running: true })]), "online");
  assert.equal(harnessHealth([state({ running: true, silentMs: STALL_MS + 1 })]), "online");
  assert.equal(harnessHealth([state({ running: true, busy: true, silentMs: STALL_MS + 1 })]), "stalled");
  assert.equal(harnessHealth([state({ failure: "emma-cli exited with code 1" })]), "offline");
  assert.equal(harnessHealth([state({ failure: CLOSED_BY_EMMA })]), "ready");
  assert.equal(stoppedReason([state({ failure: '"work" is no longer at /tmp/work — reconnect it from the ＋ menu.' })]), '"work" is no longer at /tmp/work — reconnect it from the ＋ menu.');
  assert.equal(stoppedReason([state({ running: true })]), "");
  assert.equal(stoppedReason([state({ failure: CLOSED_BY_EMMA })]), "");
});

test("the fix prompt carries the failure and the traffic, not just the word broken", () => {
  const prompt = fixPrompt({
    processes: [{ cwd: workspace, running: false, busy: false, silentMs: 4000, failure: "emma-cli exited with code 101" }],
    lines: [
      { at: 0, flow: "out", label: "session/prompt #7", body: '{"method":"session/prompt"}' },
      { at: 1, flow: "err", label: "stderr", body: "thread 'main' panicked" },
    ],
  });
  assert.ok(prompt.includes("agent offline"), prompt);
  assert.ok(prompt.includes("emma-cli exited with code 101"));
  assert.ok(prompt.includes("thread 'main' panicked"));
  assert.ok(prompt.includes("desktop/main/harness.ts"));
});

test("a blank title on a progress update is nothing to merge, not a wipe", () => {
  assert.equal(toolCallText("  Read src/App.tsx "), "Read src/App.tsx");
  assert.equal(toolCallText(""), null);
  assert.equal(toolCallText("   "), null);
  assert.equal(toolCallText(undefined), null);
});

test("a first turn names what it is waiting on, so the wait is never just \u201cworking\u201d", async () => {
  const { client, phases } = harness(async () => null, undefined, async () => "", path.join(tmpdir(), `emma-phases-${process.pid}-${Date.now()}`));
  try {
    await client.prompt("thread-phase", workspace, "hello", "ask");
  } finally {
    client.close();
  }
  assert.deepEqual(phases, [
    "starting the agent",
    "opening this thread's session",
    "running startup hooks",
    "setting up the session",
    "sending the prompt",
    "waiting for the model",
  ]);
});

test("an automatic compaction is read off its own update, and bounded", () => {
  assert.deepEqual(
    compactionReported({ sessionUpdate: "_emma_compacted", removedTurns: 12, summaryChars: 2480, modelWritten: true }),
    { removedTurns: 12, summaryChars: 2480, modelWritten: true },
  );
  assert.deepEqual(
    compactionReported({ sessionUpdate: "_emma_compacted", removedTurns: "3", summaryChars: -9, modelWritten: "yes" }),
    undefined,
  );
  assert.deepEqual(
    compactionReported({ sessionUpdate: "_emma_compacted", removedTurns: 4.7, summaryChars: -9, modelWritten: "yes" }),
    { removedTurns: 4, summaryChars: 0, modelWritten: false },
  );
  assert.equal(compactionReported({ sessionUpdate: "_emma_compacted", removedTurns: 0, summaryChars: 100, modelWritten: true }), undefined);
  assert.equal(compactionReported({ sessionUpdate: "session_info_update", removedTurns: 12 }), undefined);
});

test("stopping a turn leaves no tool call still working", async () => {
  const run = harness(async () => {
    await run.client.cancel("thread_stop");
    return null;
  });
  await run.client.prompt("thread_stop", workspace, "run something", "ask").catch(() => undefined);
  run.client.close();
  const stopped = run.calls.find((call) => call.status === "cancelled");
  assert.equal(stopped?.toolCallId, "call_1");
  assert.equal(stopped?.output, INTERRUPTED_CALL);
  assert.equal(run.calls.find((call) => call.toolCallId === "call_1")?.status, "pending");
});

test("a paused recovery is kept as the reason a run stopped", () => {
  const { client } = harness(async () => "allow_once");
  const apply = (recovery: Record<string, unknown>) =>
    (client as unknown as { applyUpdate: (threadId: string, update: Record<string, unknown>) => void })
      .applyUpdate("t1", { sessionUpdate: "session_info_update", _meta: { fx: { modelResponseRecovery: recovery } } });

  apply({ state: "active", message: "⚠ Response ended early · retrying request", attempt: 3, attemptLimit: 10 });
  assert.equal(client.paused.get("t1"), undefined);

  apply({ state: "paused", message: "⚠ Response ended early · recovery paused after 10/10 attempts", attempt: 10, attemptLimit: 10 });
  assert.deepEqual(client.paused.get("t1"), { message: "⚠ Response ended early · recovery paused after 10/10 attempts", cause: undefined, requiredAction: undefined });

  apply({ state: "paused", message: "⚠ Provider unavailable · quota", attempt: 1, attemptLimit: 6, delaySeconds: 4 });
  assert.deepEqual(client.paused.get("t1"), { message: "⚠ Provider unavailable · quota (attempt 1 of 6), retrying in 4s", cause: undefined, requiredAction: undefined });

  apply({ state: "paused", kind: "terminal_provider_error", cause: "request_limit_reached", message: "⚠ Provider limit reached · usage limit · recovery paused after 1/6 attempts", attempt: 1, attemptLimit: 6 });
  assert.deepEqual(client.paused.get("t1"), { message: "⚠ Provider limit reached · usage limit · recovery paused after 1/6 attempts", cause: "request_limit_reached", requiredAction: undefined });

  apply({ state: "paused", kind: "content_filter", requiredAction: "change_request", message: "⚠ blocked · content filter · change the request" });
  assert.deepEqual(client.paused.get("t1"), { message: "⚠ blocked · content filter · change the request", cause: undefined, requiredAction: "change_request" });

  apply({ state: "paused", kind: "content_filter", requiredAction: "change_request", message: "⚠ blocked · content filter · change the request", attempt: 1, attemptLimit: 10 });
  assert.deepEqual(client.paused.get("t1"), { message: "⚠ blocked · content filter · change the request", cause: undefined, requiredAction: "change_request" });

  apply({ state: "recovered", message: "✓ recovered" });
  assert.equal(client.paused.get("t1"), undefined);
});

test("the model's own image input is published to the harness, and stays unsent when the desktop does not know it", async () => {
  const known = harness(async () => "allow_once");
  try {
    await known.client.prompt("thread-vision", workspace, "do it", "ask", undefined, { imageInput: true });
    assert.ok(known.text().join("").includes("cfg:image_input=true"), known.text().join(""));
  } finally {
    known.client.close();
  }

  const unknown = harness(async () => "allow_once");
  try {
    await unknown.client.prompt("thread-vision", workspace, "do it", "ask", undefined, { contextWindow: 1000 });
    assert.ok(unknown.text().join("").includes("cfg:context_window=1000"), unknown.text().join(""));
    assert.ok(!unknown.text().join("").includes("cfg:image_input"), unknown.text().join(""));
  } finally {
    unknown.client.close();
  }
});

test("a trial's tool hints and preselected tools reach the session, and clear on the turn that drops them", async () => {
  const { client, text } = harness(async () => "allow_once");
  try {
    await client.prompt("thread-trial", workspace, "arm b", "ask", undefined, {
      toolHints: { threads: "Hinted threads." },
      preselect: ["threads", "knowledge"],
    });
    const armed = text().join("");
    assert.ok(armed.includes(`cfg:tool_hints={"threads":"Hinted threads."}`), armed);
    assert.ok(armed.includes("cfg:preselect=threads,knowledge"), armed);

    const before = text().join("").length;
    await client.prompt("thread-trial", workspace, "arm a", "ask");
    const cleared = text().join("").slice(before);
    assert.ok(cleared.includes("cfg:tool_hints= "), cleared);
    assert.ok(cleared.includes("cfg:preselect= "), cleared);

    const after = text().join("").length;
    await client.prompt("thread-trial", workspace, "arm a again", "ask");
    const quiet = text().join("").slice(after);
    assert.ok(!quiet.includes("cfg:tool_hints"), quiet);
    assert.ok(!quiet.includes("cfg:preselect"), quiet);
  } finally {
    client.close();
  }
});

test("a content filter that ends the turn is reported as blocked, not as a model error", async () => {
  const { client } = harness(async () => "allow_once");
  await assert.rejects(
    client.prompt("t_filtered", workspace, "filtered please", "ask"),
    { message: "⚠ blocked · content filter · change the request" },
  );
  assert.equal(client.paused.get("t_filtered")?.requiredAction, "change_request");
  client.close();
});

test("a recovery replayed while the session opens is not why the next run stopped", async () => {
  const { client } = harness(
    async () => "allow_once",
    undefined,
    undefined,
    path.join(tmpdir(), `emma-harness-stale-recovery-${process.pid}`),
  );
  await client.prompt("t_stale", workspace, "hello", "ask");
  assert.equal(client.paused.get("t_stale"), undefined);
  client.close();
});

test("a run whose project folder was deleted names the folder, not the agent binary", async () => {
  const gone = path.join(tmpdir(), `emma-gone-${process.pid}`);
  rmSync(gone, { recursive: true, force: true });
  const client = new Harness({
    binaryPath: process.execPath,
    args: [fakeAgent],
    home: tmpdir(),
    cwd: gone,
    mcpServers: async () => [],
  } as unknown as ConstructorParameters<typeof Harness>[0]);
  await assert.rejects(() => client.start(), (error: unknown) => String(error).includes(`is no longer at ${gone}`));
  assert.match(client.state.failure, /reconnect it from the ＋ menu/);
  assert.doesNotMatch(client.state.failure, /ENOENT/);
});

test("the configured vision route reaches the child, and no vision route leaves the session route alone", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "emma-vision-env-"));
  const dump = path.join(scratch, "env.json");
  const agent = path.join(scratch, "agent.mjs");
  writeFileSync(agent, [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(process.env.EMMA_TEST_ENV_DUMP, JSON.stringify(process.env));',
    `await import(${JSON.stringify(pathToFileURL(fakeAgent).href)});`,
  ].join("\n"));
  process.env.EMMA_TEST_ENV_DUMP = dump;
  const start = async (vision?: { model: string; chatUrl: string; apiKey: string }) => {
    const client = new Harness({
      binaryPath: process.execPath,
      args: [agent],
      home: path.join(scratch, "home"),
      cwd: workspace,
      apiKey: "session-key",
      chatUrl: "https://session.example/v1/chat/completions",
      vision,
      mcpServers: async () => [],
      onDelta: () => {},
      onThought: () => {},
      onToolCall: () => {},
      onCompacted: () => {},
      onContextExperiment: () => {},
      onRoutedModel: () => {},
      onContextBreakdown: () => {},
      onUsage: () => {},
      onChildStart: () => Promise.resolve("t"),
      onChildEnd: () => {},
      onPlan: () => {},
      onPermission: async () => null,
      onToolRequest: async () => "",
    });
    await client.start();
    const env = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>;
    client.close();
    return env;
  };

  const configured = await start({ model: "vendor/eyes:free", chatUrl: "https://vision.example/v1/chat/completions", apiKey: "vision-key" });
  assert.equal(configured.EMMA_PROVIDER_API_KEY, "session-key");
  assert.equal(configured.EMMA_PROVIDER_CHAT_URL, "https://session.example/v1/chat/completions");
  assert.equal(configured.EMMA_VISION_MODEL, "vendor/eyes:free");
  assert.equal(configured.EMMA_VISION_CHAT_URL, "https://vision.example/v1/chat/completions");
  assert.equal(configured.EMMA_VISION_API_KEY, "vision-key");

  const bare = await start();
  assert.equal(bare.EMMA_PROVIDER_CHAT_URL, "https://session.example/v1/chat/completions");
  assert.equal(bare.EMMA_VISION_MODEL, undefined);
  assert.equal(bare.EMMA_VISION_CHAT_URL, undefined);
  assert.equal(bare.EMMA_VISION_API_KEY, undefined);

  delete process.env.EMMA_TEST_ENV_DUMP;
  rmSync(scratch, { recursive: true, force: true });
});
