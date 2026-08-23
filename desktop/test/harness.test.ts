import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { withThinking } from "../shared/thinking";
import { artifactWritten } from "../shared/artifacts";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { defaultHarnessExperiments, validateHarnessExperiments } from "../shared/settings";
import { Harness, HARNESS_MODE_ID, callEscapesWorkspace, contextExperimentFired, describePath, effortOption, escapesRoot, experimentOption, failedTurn, harnessKey, toolOutput, turnUsageReported, unwrapMcpResult, type HarnessToolCall, type PermissionAsk, type PermissionContext, type PermissionOption } from "../main/harness";

/** The fixture lives beside this test in source, not in the compiled output. */
const fakeAgent = path.join(process.cwd(), "test", "fake-acp-agent.mjs");

/** A real directory: `spawn` reports a missing cwd as ENOENT on the binary. */
const workspace = tmpdir();

function harness(
  answer: (ask: PermissionAsk, options: PermissionOption[]) => Promise<string | null>,
  idleMs?: number,
  runTool: (threadId: string, name: string, args: Record<string, unknown>) => Promise<string> = async () => "",
) {
  const deltas: { threadId: string; delta: string }[] = [];
  const thoughts: string[] = [];
  const calls: HarnessToolCall[] = [];
  const asks: PermissionAsk[] = [];
  const contexts: PermissionContext[] = [];
  const children: { parentThreadId: string; childId: string; title: string }[] = [];
  const ended: string[] = [];
  const usages: { threadId: string; inputTokens: number; outputTokens: number }[] = [];
  const toolRequests: { threadId: string; name: string; args: Record<string, unknown> }[] = [];
  const client = new Harness({
    binaryPath: process.execPath,
    args: [fakeAgent],
    home: tmpdir(),
    cwd: workspace,
    idleMs,
    mcpServers: async () => [],
    onDelta: (threadId, delta) => deltas.push({ threadId, delta }),
    onThought: (_threadId, delta) => thoughts.push(delta),
    onToolCall: (call) => calls.push(call),
    onContextExperiment: () => {},
    onUsage: (threadId, usage) => usages.push({ threadId, ...usage }),
    onChildStart: (child) => { children.push(child); return Promise.resolve(`thread_for_${child.childId}`); },
    onChildEnd: (threadId) => ended.push(threadId),
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
  });
  return { client, deltas, text: () => deltas.map((entry) => entry.delta), thoughts, calls, asks, contexts, children, ended, usages, toolRequests };
}

test("every mode routes its decision back to Emma", () => {
  // `acceptEdits` used to become the harness's `auto`, which does not check the
  // granted folder and hands commands to a hardcoded in-harness reviewer model;
  // `full` became `yolo`, which keeps no floor at all. Emma is the only side
  // that knows what the user granted, so every mode arrives here as `ask`.
  assert.equal(HARNESS_MODE_ID, "ask");
});

test("a path outside the workspace is an escape, and one inside is not", () => {
  const root = path.join(tmpdir(), `emma-sandbox-${process.pid}`);
  mkdirSync(path.join(root, "inside"), { recursive: true });
  writeFileSync(path.join(root, "inside", "file.txt"), "x");

  assert.equal(escapesRoot(root, "inside/file.txt"), false);
  assert.equal(escapesRoot(root, "inside/not-yet-created.txt"), false);
  assert.equal(escapesRoot(root, "."), false);
  // The leaf of a write usually does not exist yet, so a new nested path under
  // the root has to be allowed rather than treated as unresolvable.
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
  // Resolving only the leaf would call this contained: every component of the
  // path is nominally under the root.
  assert.equal(escapesRoot(root, "bridge/owned.txt"), true);
});

test("an escape is caught in any path-shaped argument, not just the first", () => {
  const root = path.join(tmpdir(), `emma-args-${process.pid}`);
  mkdirSync(root, { recursive: true });

  assert.equal(callEscapesWorkspace(root, { path: "inside.txt" }), false);
  assert.equal(callEscapesWorkspace(root, { command: "echo hi" }), false);
  assert.equal(callEscapesWorkspace(root, undefined), false);
  // A rename is the interesting one: the source is innocent and the destination
  // is the escape, so checking one field would pass it.
  assert.equal(callEscapesWorkspace(root, { old_path: "inside.txt", new_path: "/etc/cron.d/owned" }), true);
  assert.equal(callEscapesWorkspace(root, { source: "a.txt", destination: "../../b.txt" }), true);
  assert.equal(callEscapesWorkspace(root, { paths: ["ok.txt", "/etc/passwd"] }), true);
  assert.equal(callEscapesWorkspace(root, { cwd: "/" }), true);
});

test("a refused turn is a failure rather than an answer", () => {
  // The harness reports a provider or auth failure as ordinary assistant text
  // and still resolves the call, so without this the error string was recorded
  // into the thread as though Emma had said it.
  assert.equal(failedTurn("refused"), true);
  assert.equal(failedTurn("end_turn"), false);
  assert.equal(failedTurn("cancelled"), false);
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

// A tool from a user's MCP server answers through the harness wrapped in an
// envelope. Unwrapped, the transcript shows the tool's own words; wrapped, it
// showed a line of raw JSON and the artifact marker was unreachable.
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

  // The case that actually happens. The harness passes on a 200-byte prefix of
  // any tool's output, so the envelope arrives cut mid-string and unparseable —
  // which is why there is a fallback at all.
  const long = `${wrote}${" and it has a long tail".repeat(6)}`;
  const cut = envelope(long).slice(0, 200);
  assert.throws(() => JSON.parse(cut), "the fixture has to be genuinely broken or this proves nothing");
  assert.equal(unwrapMcpResult(cut), long.slice(0, unwrapMcpResult(cut).length), "what survived is the tool's words, not a brace fragment");

  // Emma's own tools are native, so their answer arrives as plain text and the
  // whole 200 bytes are theirs. The `[artifact:…]` marker leads the line for
  // exactly this reason: a title long enough to push a trailing marker off the
  // cut is the regression the card used to vanish for.
  const artifact = `[artifact:long-one] Created the artifact "${"x".repeat(200)}"`.slice(0, 200);
  assert.equal(unwrapMcpResult(artifact), artifact, "a native tool's words are not an envelope");
  assert.equal(artifactWritten({ status: "completed", output: artifact }), "long-one");

  // Left alone unless it is really one of these: no `tool` key, not JSON, or
  // JSON that simply is the answer.
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
    // Upstream ACP has no usage field, so a turn's real cost only exists if the
    // fork's extension survives the round trip.
    assert.ok(usage.outputTokens > 0, JSON.stringify(usage));
    // The mode Emma set round-tripped through the harness — as `ask`, because
    // `acceptEdits` deliberately does not map through: the harness's own
    // accept-edits mode skips the granted-folder check entirely.
    assert.ok(text().join("").includes("mode=ask"), text().join(""));
    assert.ok(text().join("").includes("thinking"));
    // Reasoning arrives on its own channel and must not land in the answer, or
    // the transcript reads as a scratchpad with the reply buried in it.
    assert.equal(thoughts.join(""), "weighing it up");
    assert.ok(!text().join("").includes("weighing"));
    assert.ok(text().join("").endsWith("done"));

    assert.equal(asks.length, 1);
    assert.equal(asks[0].threadId, "thread-1");
    assert.ok(asks[0].detail.includes("echo hi"));

    const final = calls.at(-1);
    assert.equal(final?.status, "completed");
    assert.equal(final?.output, "hi");
    // The update carries only `status` and `content`. Without merging, the step
    // in the transcript would lose its name and become an untitled "other".
    assert.equal(final?.title, "bash");
    assert.equal(final?.kind, "execute");
  } finally {
    client.close();
  }
});

test("a subagent's words land on a thread of its own, never in its parent's answer", async () => {
  const { client, deltas, calls, children, ended, usages } = harness(async () => "allow_once");
  try {
    await client.prompt("thread-parent", workspace, "spawn a subagent", "ask");
    // Whatever a subagent says would otherwise be recorded as the parent's reply:
    // one turn on the harness is one durable message, and the child has no
    // session of its own to keep its words apart.
    assert.deepEqual(children, [{ parentThreadId: "thread-parent", childId: "child_1", title: "read the docs" }]);
    const parent = deltas.filter((entry) => entry.threadId === "thread-parent").map((entry) => entry.delta).join("");
    assert.ok(parent.includes("parent speaks"), parent);
    assert.ok(!parent.includes("child speaks"), parent);
    assert.equal(deltas.filter((entry) => entry.threadId === "thread_for_child_1").map((entry) => entry.delta).join(""), "child speaks");
    // And its tool calls go to the same place, so the child's tab shows the work
    // rather than the parent's transcript showing it twice.
    assert.equal(calls.filter((call) => call.threadId === "thread_for_child_1").length, 1);
    assert.equal(calls.filter((call) => call.threadId === "thread-parent" && call.toolCallId === "call_1").length, 0);
    // What it spent, on its own thread. A subagent tab reading zero tokens is how
    // "the child is doing nothing" looked, when it was working the whole time.
    assert.deepEqual(usages, [{ threadId: "thread_for_child_1", inputTokens: 777, outputTokens: 42 }]);
    // Ended exactly once, so nothing is left showing as running forever.
    assert.deepEqual(ended, ["thread_for_child_1"]);
  } finally {
    client.close();
  }
});

test("one of Emma's own tools runs in Emma and its answer reaches the harness", async () => {
  // The harness advertises these natively and has no implementation for them:
  // the call comes back down the pipe as `_emma/callTool`, and if this round
  // trip breaks every Emma tool is advertised and then fails on use.
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
  // The harness blocks on this request with no deadline of its own — a rejected
  // promise that never became a reply would strand the turn forever.
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
    // `threadId` is what decides whose folder, mode and settings the call is
    // checked against, so a request Emma cannot place must not reach a tool.
    assert.deepEqual(toolRequests, []);
    assert.equal(text().at(-1), "error:Unknown session or tool");
  } finally {
    client.close();
  }
});

test("a message for a subagent is carried to the harness that owns it", async () => {
  const { client } = harness(async () => "allow_once");
  try {
    await client.prompt("thread-parent", workspace, "spawn a subagent", "ask");
    // Emma's own steering queue is drained by Emma's loop, and nothing drains it
    // for a run the harness is driving — so a message meant for a harness
    // subagent has to leave the process or it is never delivered at all.
    await client.steerChild("child_1", "look at the tests too");
    await assert.rejects(() => client.steerChild("child_gone", "hello"), /child_unavailable/);
  } finally {
    client.close();
  }
});

test("a turn longer than the idle window survives on the updates it streams", async () => {
  // The timeout used to be a wall clock, so a long build — subagents, dozens of
  // tool calls — was killed mid-flight while it was visibly still working. Here
  // the turn runs about three idle windows and must still finish.
  const { client, text } = harness(async () => "allow_once", 100);
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
    // The harness takes its workspace from its process cwd and ignores the cwd in
    // `session/new`, so a mismatch here means files land outside the caller's
    // workspace. It must fail loudly rather than write there.
    await assert.rejects(
      () => client.prompt("thread-3", "/tmp/somewhere-else", "do it", "ask"),
      new RegExp(`bound to ${workspace}`),
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

test("a thread whose session another thread displaced still gets its own turn back", async () => {
  // One harness process serves every thread in a workspace, and it holds exactly
  // one session: a second thread's `session/new` replaces the first thread's
  // without waiting for anything. Left alone, the first thread's next prompt ran
  // in the second thread's session — its updates arrived tagged with that
  // session, were routed to that thread, and this one recorded a turn with no
  // text in it and a stop reason to explain the silence.
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
  // Not politeness: the harness answers a second `session/prompt` with "Prompt
  // already in progress", and the session swap that precedes one is not gated on
  // the running turn at all. Interleaved, the two turns would run in each
  // other's sessions.
  const { client, deltas } = harness(async () => "allow_once", 2000);
  try {
    await Promise.all([
      client.prompt("thread-slow", workspace, "slow", "ask"),
      client.prompt("thread-quick", workspace, "slow", "ask"),
    ]);
    // The fixture streams eight chunks per turn, and each turn's chunks carry
    // the session that was active when they were sent. Run together, both turns'
    // chunks land on whichever thread created a session last.
    for (const threadId of ["thread-slow", "thread-quick"]) {
      const spoken = deltas.filter((entry) => entry.threadId === threadId).map((entry) => entry.delta).join("");
      assert.ok(spoken.endsWith("........"), `${threadId} got ${JSON.stringify(spoken)}`);
    }
    // And one contiguous run each, rather than the two interleaving.
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
  } finally {
    parent.client.close();
    spare.client.close();
  }
});

test("a requested compaction is asked for between turns, before the prompt it makes room for", async () => {
  // The harness answers `session/compact` with "Prompt already in progress" if
  // one is running, and the turn in flight is reading the very history it would
  // rewrite. So the only safe moment is here, inside the queued turn and ahead
  // of `session/prompt` — which is also the first turn a smaller history helps.
  const { client, text } = harness(async () => "allow_once");
  try {
    await client.prompt("thread-c", workspace, "do it", "ask");
    assert.ok(!text().join("").includes("compacted"), "an unrequested turn compacted anyway");
    await client.prompt("thread-c", workspace, "do it", "ask", undefined, { compact: true });
    const spoken = text().join("");
    assert.ok(spoken.includes("compacted "), spoken);
    // Ahead of the answer that turn streamed, not after it.
    assert.ok(spoken.indexOf("compacted ") < spoken.lastIndexOf("done"), spoken);
    // And once: an armed thread is not a thread that compacts every turn.
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

test("a session forgotten mid-turn still routes the rest of that turn", async () => {
  // Forgotten from inside the turn, which is when `install_mcp` does it: the
  // next turn must build a session that includes the new server, but the
  // running one has to keep reporting. Clearing the reverse map here silenced
  // every remaining update and cancelled every remaining permission request.
  const made = harness(async () => { made.client.forgetAllSessions(); return "allow_once"; });
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
  // The harness parses this string key=number at a time, so a rename on either
  // side has to break here rather than silently disabling both experiments.
  const settings = validateHarnessExperiments({ reinjectPromptSteps: 15, reinjectPromptPercent: 0, pruneToolsSteps: 0, pruneToolsPercent: 70 });
  assert.equal(experimentOption(settings), "reinject_steps=15,reinject_percent=0,prune_steps=0,prune_percent=70");

  // Out of range, negative, fractional, and junk are rejected like every other setting here.
  for (const bad of [{ reinjectPromptSteps: 999 }, { reinjectPromptPercent: -5 }, { pruneToolsSteps: 2.5 }, { pruneToolsPercent: "70" }])
    assert.throws(() => validateHarnessExperiments(bad), /invalid/);
  assert.deepEqual(validateHarnessExperiments(undefined), defaultHarnessExperiments);
  assert.equal(experimentOption(defaultHarnessExperiments), "reinject_steps=0,reinject_percent=0,prune_steps=0,prune_percent=0");
});

test("the thinking option carries the stop and the list the harness checks it against", () => {
  // `acp/server.zig:parseReasoningEffort` splits on the semicolon and refuses a stop
  // it cannot name, so a change to either half has to break here rather than leave
  // every request quietly reasoning at the model's default again.
  assert.equal(effortOption({ level: "high", published: ["low", "medium", "high"] }), "high;low,medium,high");
  // The default is a value, and it is the one that must reach the session: without
  // it a slider dragged back to Default leaves last turn's effort in place.
  assert.equal(effortOption({ level: "", published: ["low", "medium", "high"] }), "auto;low,medium,high");
  // A model with no thinking knob still publishes that, so a stale one is cleared.
  assert.equal(effortOption({ level: "", published: [] }), "auto;");
});

test("a fired experiment is read off the info channel without swallowing the retry status", () => {
  // The exact shape `acp/types.zig:writeContextExperimentInfoUpdate` writes. A
  // rename on either side leaves the levers silently invisible in the transcript.
  assert.deepEqual(
    contextExperimentFired({ sessionUpdate: "session_info_update", _meta: { fx: { contextExperiment: { prunedResults: 6, reinjected: false, savedTokens: 12_400, addedTokens: 0 } } } }),
    { prunedResults: 6, reinjected: false, savedTokens: 12_400, addedTokens: 0 },
  );
  assert.deepEqual(
    contextExperimentFired({ _meta: { fx: { contextExperiment: { prunedResults: 0, reinjected: true, savedTokens: 0, addedTokens: 310 } } } }),
    { prunedResults: 0, reinjected: true, savedTokens: 0, addedTokens: 310 },
  );
  // An older harness reports the levers without the token figures; the tally it
  // feeds has to stay a number rather than becoming NaN for the rest of a thread.
  assert.deepEqual(
    contextExperimentFired({ _meta: { fx: { contextExperiment: { prunedResults: 2, reinjected: false } } } }),
    { prunedResults: 2, reinjected: false, savedTokens: 0, addedTokens: 0 },
  );
  // A step where neither lever did anything says nothing, and the retry status
  // this channel also carries must fall through to the recovery path below it.
  assert.equal(contextExperimentFired({ _meta: { fx: { contextExperiment: { prunedResults: 0, reinjected: false } } } }), undefined);
  assert.equal(contextExperimentFired({ _meta: { fx: { modelResponseRecovery: { message: "retrying" } } } }), undefined);
  assert.equal(contextExperimentFired({}), undefined);
});

test("a step's usage is read off the same info channel", () => {
  assert.deepEqual(
    turnUsageReported({ sessionUpdate: "session_info_update", _meta: { fx: { turnUsage: { inputTokens: 24_100, outputTokens: 3_200 } } } }),
    { inputTokens: 24_100, outputTokens: 3_200 },
  );
  assert.deepEqual(turnUsageReported({ _meta: { fx: { turnUsage: {} } } }), { inputTokens: 0, outputTokens: 0 });
  assert.equal(turnUsageReported({ _meta: { fx: { contextExperiment: { prunedResults: 2, reinjected: false } } } }), undefined);
  assert.equal(turnUsageReported({ _meta: { fx: { modelResponseRecovery: { message: "retrying" } } } }), undefined);
  assert.equal(turnUsageReported({}), undefined);
});
