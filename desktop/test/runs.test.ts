import assert from "node:assert/strict";
import test from "node:test";

import { appendText, arrived, dropQueued, groupBlocks, joinPartial, mergeStep, pairBlocks, releaseHeld, restoreBlocks, runOf, sendTurn, stopTurn, takeDraft, thinkingOf, wire, withoutThinking, wrote, type Block } from "../src/runs";
import type { LiveAgent, ThreadStep } from "../shared/agents";
import type { TraceSpan } from "../shared/trace";
import { cachedBlocks, rememberBlocks, setThreadFolders, threadFolders } from "../src/context";
import type { Message } from "../src/types";

/* Node has no web storage, and the block cache only ever asks it for three things. */
const stored = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value); },
  removeItem: (key: string) => { stored.delete(key); },
};
/* The sidebar listens for a folder change on the window; nothing here does. */
(globalThis as unknown as { dispatchEvent: unknown }).dispatchEvent = () => true;

/* A fake host that answers when this test says so, which is the whole point: the
   queue only means anything while a turn is still open. */
const sent: string[] = [];
let release: (() => void) | null = null;
let request: (method: string, params: { content: string }) => Promise<unknown> = (_method, params) => {
  sent.push(params.content);
  return new Promise<void>((resolve) => { release = resolve; });
};
const stopped: string[] = [];
/* What main still holds of a turn in flight, which is all a reloaded window has. */
let liveSpans: Record<string, TraceSpan[]> = {};
let livePartials: Record<string, { text: string; thinking: string }> = {};
/* Main broadcasts to every window, so the store is driven from outside here too. */
let pushDelta: (value: { threadId: string; delta: string }) => void = () => undefined;
let pushAgents: (value: LiveAgent[]) => void = () => undefined;
(globalThis as unknown as { window: unknown }).window = {
  emma: {
    request: (method: string, params: { content: string }) => request(method, params),
    onDelta: (listener: typeof pushDelta) => { pushDelta = listener; return () => undefined; },
    onStep: () => () => undefined,
    onContextExperiment: () => () => undefined,
    onRoutedModel: () => () => undefined,
    onContextBreakdown: () => () => undefined,
    onAgents: (listener: typeof pushAgents) => { pushAgents = listener; return () => undefined; },
    listAgents: () => Promise.resolve([]),
    listSpans: () => Promise.resolve(liveSpans),
    livePartial: () => Promise.resolve(livePartials),
    stopAgent: (threadId?: string) => { stopped.push(threadId ?? ""); },
  },
};

const turn = (content: string) => ({ content, after: 0, params: {} });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a turn typed while one is running waits for it, in order", async () => {
  sendTurn("thread", turn("first"), () => undefined);
  sendTurn("thread", turn("second"), () => undefined);
  sendTurn("thread", turn("third"), () => undefined);
  // Queueing never opens a second turn on the same thread.
  assert.deepEqual(sent, ["first"]);
  release!();
  await settle();
  assert.deepEqual(sent, ["first", "second"]);
  release!();
  await settle();
  assert.deepEqual(sent, ["first", "second", "third"]);
  release!();
  await settle();
});

test("a stop sends what you typed next and holds the rest", async () => {
  sent.length = 0;
  stopped.length = 0;
  sendTurn("interrupt", turn("running"), () => undefined);
  sendTurn("interrupt", turn("queued behind it"), () => undefined);
  stopTurn("interrupt", undefined, () => undefined);
  sendTurn("interrupt", turn("no, do this instead"), () => undefined);
  assert.deepEqual(stopped, ["interrupt"]);
  release!();
  await settle();
  assert.deepEqual(sent, ["running", "no, do this instead"]);
  release!();
  await settle();
  assert.deepEqual(sent, ["running", "no, do this instead"]);
  releaseHeld("interrupt", 0, () => undefined);
  await settle();
  assert.deepEqual(sent, ["running", "no, do this instead", "queued behind it"]);
  release!();
  await settle();
});

test("swapping the model mid-turn stops it and sends the same prompt again", async () => {
  sent.length = 0;
  stopped.length = 0;
  sendTurn("stalled", turn("render the map"), () => undefined);
  assert.deepEqual(sent, ["render the map"]);
  stopTurn("stalled", { ...turn("render the map"), notice: "Model changed to Opus — Stealth answered nothing for 4m" }, () => undefined);
  assert.deepEqual(stopped, ["stalled"]);
  // Not before the stopped turn has ended: one thread runs one turn.
  assert.deepEqual(sent, ["render the map"]);
  release!();
  await settle();
  assert.deepEqual(sent, ["render the map", "render the map"]);
  release!();
  await settle();
});

test("dropping a queued turn counts past the one already running", async () => {
  sent.length = 0;
  sendTurn("drop", turn("running"), () => undefined);
  sendTurn("drop", turn("keep"), () => undefined);
  sendTurn("drop", turn("drop me"), () => undefined);
  dropQueued("drop", 1);
  release!();
  await settle();
  release!();
  await settle();
  assert.deepEqual(sent, ["running", "keep"]);
});

const step = (toolCallId: string, status: ThreadStep["status"]): ThreadStep =>
  ({ threadId: "t", toolCallId, title: "read", kind: "read", status, at: 0 });

test("a turn is blocks in arrival order, not one buffer with the calls under it", () => {
  let blocks: Block[] = [];
  blocks = appendText(blocks, "text", "Scaffold");
  blocks = appendText(blocks, "text", " files:");
  blocks = mergeStep(blocks, step("a", "in_progress"));
  blocks = appendText(blocks, "text", "One write hiccuped");
  // A finished call updates its own row rather than landing after the text that
  // came while it ran.
  blocks = mergeStep(blocks, step("a", "completed"));
  assert.deepEqual(blocks.map((block) => block.kind), ["text", "step", "text"]);
  assert.equal(blocks[0].kind === "text" && blocks[0].text, "Scaffold files:");
  assert.equal(blocks[1].kind === "step" && blocks[1].step.status, "completed");
});

test("reasoning keeps its own block instead of merging into the answer", () => {
  const blocks = appendText(appendText([], "thinking", "hm"), "text", "done");
  assert.deepEqual(blocks.map((block) => block.kind), ["thinking", "text"]);
});

test("a turn's reasoning is one train of thought, and the calls either side of it are one list", () => {
  // Both shapes at once: the reasoning channel's own blocks, and a provider that
  // inlined its scratchpad in the text.
  const blocks: Block[] = [
    { kind: "thinking", text: "first " },
    { kind: "step", step: step("a", "completed") },
    { kind: "thinking", text: " second" },
    { kind: "step", step: step("b", "completed") },
    { kind: "text", text: "<think>third</think>the answer" },
  ];
  assert.equal(thinkingOf(blocks), "first\n\nsecond\n\nthird");
  // The scratchpad is gone, the answer keeps only its answer, and the two calls
  // it used to sit between are now adjacent — so they fold into a single list.
  assert.deepEqual(groupBlocks(withoutThinking(blocks), 0), [
    { kind: "steps", steps: [step("a", "completed"), step("b", "completed")], keep: 0 },
    { kind: "text", text: "the answer" },
  ]);
  // A turn that only thought leaves nothing to draw, not an empty paragraph.
  assert.deepEqual(withoutThinking([{ kind: "text", text: "<think>all of it</think>" }]), []);
});

const liveAgent = (threadId: string, prompt = ""): LiveAgent =>
  ({ threadId, prompt, title: "t", color: "#000", status: "running", mode: "auto", model: "", activity: "", tool: false, startedAt: 0, steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, generationMs: 0 });

test("a turn the notch started owns its thread here too, and hands it back when it ends", async () => {
  sent.length = 0;
  request = (_method, params) => { sent.push(params.content); return new Promise<void>((resolve) => { release = resolve; }); };
  wire();
  // Nothing in this window sent it, so the first delta is what opens the run.
  pushDelta({ threadId: "notch", delta: "working" });
  sendTurn("notch", turn("typed in the workspace"), () => undefined);
  assert.deepEqual(sent, []);
  // Main stops reporting the agent: the thread is free, so the wait drains.
  pushAgents([liveAgent("elsewhere")]);
  await settle();
  assert.deepEqual(sent, ["typed in the workspace"]);
  release!();
  await settle();
});

test("a run main is still driving is picked back up after this window loses its state", async () => {
  sent.length = 0;
  request = (_method, params) => { sent.push(params.content); return new Promise<void>((resolve) => { release = resolve; }); };
  wire();
  pushAgents([liveAgent("reloaded")]);
  sendTurn("reloaded", turn("typed after the reload"), () => undefined);
  assert.deepEqual(sent, []);
  pushAgents([]);
  await settle();
  assert.deepEqual(sent, ["typed after the reload"]);
  release!();
  await settle();
});

test("a recovered run draws the prompt main is still working on", async () => {
  wire();
  pushAgents([liveAgent("recovered-echo", "port the old ledger")]);
  assert.equal(runOf("recovered-echo").sending, true);
  assert.equal(runOf("recovered-echo").pending?.content, "port the old ledger");
  pushAgents([]);
  await settle();
  assert.equal(runOf("recovered-echo").sending, false);
});

test("a reloaded window puts the running turn's calls and answer back", async () => {
  liveSpans = {
    "recovered-blocks": [
      { id: "agent:recovered-blocks", name: "This thread", kind: "agent", startedAt: 0, status: "running" },
      { id: "call:2", name: "read runs.ts", kind: "read", startedAt: 2, status: "ok", output: "…" },
      { id: "call:1", name: "grep adoptForeign", kind: "search", startedAt: 1, status: "ok" },
    ],
  };
  livePartials = { "recovered-blocks": { text: "Found it: ", thinking: "where does the state live" } };
  wire();
  pushAgents([liveAgent("recovered-blocks", "why is the transcript empty")]);
  await settle();
  const blocks = runOf("recovered-blocks").blocks;
  assert.deepEqual(blocks.map((block) => block.kind === "step" ? block.step.title : block.text),
    ["where does the state live", "grep adoptForeign", "read runs.ts", "Found it: "]);
  // The stream carries on into the restored answer rather than opening a second one.
  pushDelta({ threadId: "recovered-blocks", delta: "here" });
  await settle();
  const text = runOf("recovered-blocks").blocks.filter((block) => block.kind === "text");
  assert.deepEqual(text.map((block) => block.text), ["Found it: here"]);
  liveSpans = {};
  livePartials = {};
  pushAgents([]);
  await settle();
});

test("a turn main has said nothing about yet restores as nothing", () => {
  assert.deepEqual(restoreBlocks("quiet", [], undefined), []);
});

test("a parent's restore leaves its subagents' calls to the subagent", () => {
  const spans: TraceSpan[] = [
    { id: "agent:parent", name: "Parent", kind: "agent", startedAt: 0, status: "running" },
    { id: "call:own", name: "read runs.ts", kind: "read", startedAt: 1, status: "ok", parentId: "agent:parent" },
    { id: "call:spawn", name: "subagent", kind: "subagent", startedAt: 2, status: "running", parentId: "agent:parent" },
    { id: "agent:child", name: "Child", kind: "agent", startedAt: 3, status: "running", parentId: "call:spawn" },
    { id: "call:theirs", name: "grep in the child", kind: "search", startedAt: 4, status: "ok", parentId: "agent:child" },
  ];
  const calls = (threadId: string) => restoreBlocks(threadId, spans).map((block) => block.kind === "step" ? block.step.toolCallId : block.kind);
  assert.deepEqual(calls("parent"), ["own", "spawn"]);
  assert.deepEqual(calls("child"), ["theirs"]);
});

test("a delta that beat the restore is folded into the answer, not left standing alone", async () => {
  liveSpans = {};
  livePartials = { "recovered-overlap": { text: "The answer is 42, because ", thinking: "" } };
  wire();
  pushDelta({ threadId: "recovered-overlap", delta: "of the mice" });
  await settle();
  const blocks = runOf("recovered-overlap").blocks.filter((block) => block.kind === "text");
  assert.deepEqual(blocks.map((block) => block.text), ["The answer is 42, because of the mice"]);
  livePartials = {};
  pushAgents([]);
  await settle();
});

test("a restore that lands after its run ended is dropped", async () => {
  liveSpans = { "stale-restore": [{ id: "call:9", name: "read old.ts", kind: "read", startedAt: 1, status: "ok" }] };
  livePartials = { "stale-restore": { text: "the previous answer", thinking: "" } };
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const spansOf = window.emma.listSpans;
  window.emma.listSpans = () => held.then(() => liveSpans);
  wire();
  pushAgents([liveAgent("stale-restore", "the old prompt")]);
  await settle();
  pushAgents([]);
  await settle();
  release?.();
  await settle();
  assert.deepEqual(runOf("stale-restore").blocks, []);
  window.emma.listSpans = spansOf;
  liveSpans = {};
  livePartials = {};
});

test("overlapping text keeps whichever stream ran longer", () => {
  assert.equal(joinPartial("abcdef", "def"), "abcdef");
  assert.equal(joinPartial("abcdef", "defgh"), "abcdefgh");
  assert.equal(joinPartial("abcdef", ""), "abcdef");
  assert.equal(joinPartial("abc", "xyz"), "abcxyz");
});

test("a turn's tool calls are drawn where they happened, and a burst of them is one list", () => {
  // A call, a line about it, a call: four lists, each under the line it followed.
  const alternating: Block[] = [{ kind: "text", text: "reading" }];
  for (const id of ["a", "b", "c", "d"]) alternating.push({ kind: "step", step: step(id, "completed") }, { kind: "text", text: `did ${id}` });
  assert.deepEqual(groupBlocks(alternating, 0).map((block) => block.kind),
    ["text", "steps", "text", "steps", "text", "steps", "text", "steps", "text"]);

  // A burst with no prose in it still folds to one list, so it costs one caret.
  const burst: Block[] = [
    { kind: "text", text: "reading" },
    ...["a", "b", "c"].map((id): Block => ({ kind: "step", step: step(id, "completed") })),
    { kind: "text", text: "done" },
  ];
  const grouped = groupBlocks(burst, 0);
  assert.deepEqual(grouped.map((block) => block.kind), ["text", "steps", "text"]);
  assert.equal(grouped[1].kind === "steps" && grouped[1].steps.length, 3);
});

const said = (role: Message["role"], content: string, timestamp: string): Message =>
  ({ role, content, timestamp, generation: null });

test("landed turns are kept against the message each one wrote, and read back after a restart", () => {
  /* A thread with three replies, of which this session ran the last two — and one
     of those it never heard, because the notch answered it while the workspace was
     closed. That is what makes position alone unsafe to key on. */
  const messages = [
    said("user", "one", "2026-08-22T10:00:00Z"), said("assistant", "the first answer", "2026-08-22T10:00:01Z"),
    said("user", "two", "2026-08-22T10:01:00Z"), said("assistant", "answered in the notch", "2026-08-22T10:01:01Z"),
    said("user", "three", "2026-08-22T10:02:00Z"), said("assistant", "the third answer", "2026-08-22T10:02:01Z"),
  ];
  const third: Block[] = [{ kind: "text", text: "the third answer" }, { kind: "step", step: step("a", "completed") }];
  rememberBlocks("kept", Object.fromEntries(pairBlocks(messages, [third], {})
    .flatMap((blocks, index) => blocks && wrote(messages[index].content, blocks) ? [[messages[index].timestamp, blocks]] : [])));

  // Next launch: nothing in the run store, everything from storage.
  const paired = pairBlocks(messages, [], cachedBlocks("kept"));
  assert.deepEqual(paired[5], third);
  // …and on the reply this window never saw, rather than one message earlier.
  assert.equal(paired[3], undefined);
});

test("a thread keeps one folder, and one stored before that was true collapses onto its project", () => {
  // The whole point of the clamp: this id is `emma-cli`'s working directory, and a
  // second folder beside it would be reachable by Emma's tools and by nothing the
  // CLI runs itself.
  setThreadFolders("bound", ["project", "beside-it", "and-another"]);
  assert.deepEqual(threadFolders("bound"), ["project"]);
  // Written by an older build, straight past the setter.
  stored.set("emma.threadFolders.v1", JSON.stringify({ legacy: ["first", "second"] }));
  assert.deepEqual(threadFolders("legacy"), ["first"]);
  assert.deepEqual(threadFolders("never-opened"), []);
});

test("a turn whose reply has not landed yet is drawn, but not cached against the wrong one", () => {
  const messages = [said("assistant", "the first answer", "2026-08-22T10:00:01Z"), said("user", "two", "2026-08-22T10:01:00Z")];
  // The run ended before the transcript caught up, so this pairs onto the older reply.
  const blocks: Block[] = [{ kind: "text", text: "the answer to the second prompt" }];
  const paired = pairBlocks(messages, [blocks], {});
  assert.deepEqual(paired[0], blocks);
  assert.equal(wrote(messages[0].content, paired[0]!), false);
});

test("a finished turn stays drawn where it happened until the reply it wrote arrives", () => {
  const messages = [
    said("user", "one", "2026-08-22T10:00:00Z"), said("assistant", "the first answer", "2026-08-22T10:00:01Z"),
    said("user", "two", "2026-08-22T10:01:00Z"),
  ];
  const first: Block[] = [{ kind: "text", text: "the first answer" }];
  const second: Block[] = [{ kind: "text", text: "the answer to the second prompt" }];
  assert.equal(arrived(messages, second), false);
  const paired = pairBlocks(messages, [first, second], {});
  assert.deepEqual(paired[1], second);
  const held = pairBlocks(messages, [first, second].slice(0, -1), {});
  assert.deepEqual(held[1], first);

  const answered = [...messages, said("assistant", "the answer to the second prompt, at length", "2026-08-22T10:01:01Z")];
  assert.equal(arrived(answered, second), true);
  assert.deepEqual(pairBlocks(answered, [first, second], {})[3], second);
});

test("a turn the host refuses hands its text back once", async () => {
  let reloaded = 0;
  request = () => Promise.reject(new Error("host is down"));
  sendTurn("failed", turn("lost prompt"), () => { reloaded += 1; });
  await settle();
  assert.equal(reloaded, 1);
  assert.equal(takeDraft("failed"), "lost prompt");
  assert.equal(takeDraft("failed"), "");
});
