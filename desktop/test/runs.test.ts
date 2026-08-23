import assert from "node:assert/strict";
import test from "node:test";

import { appendText, dropQueued, groupBlocks, mergeStep, pairBlocks, sendTurn, takeDraft, thinkingOf, wire, withoutThinking, wrote, type Block } from "../src/runs";
import type { LiveAgent, ThreadStep } from "../shared/agents";
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
/* Main broadcasts to every window, so the store is driven from outside here too. */
let pushDelta: (value: { threadId: string; delta: string }) => void = () => undefined;
let pushAgents: (value: LiveAgent[]) => void = () => undefined;
(globalThis as unknown as { window: unknown }).window = {
  emma: {
    request: (method: string, params: { content: string }) => request(method, params),
    onDelta: (listener: typeof pushDelta) => { pushDelta = listener; return () => undefined; },
    onStep: () => () => undefined,
    onContextExperiment: () => () => undefined,
    onAgents: (listener: typeof pushAgents) => { pushAgents = listener; return () => undefined; },
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

const liveAgent = (threadId: string): LiveAgent =>
  ({ threadId, title: "t", color: "#000", status: "running", mode: "auto", model: "", activity: "", startedAt: 0, steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, generationMs: 0 });

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

test("a turn the host refuses hands its text back once", async () => {
  let reloaded = 0;
  request = () => Promise.reject(new Error("host is down"));
  sendTurn("failed", turn("lost prompt"), () => { reloaded += 1; });
  await settle();
  assert.equal(reloaded, 1);
  assert.equal(takeDraft("failed"), "lost prompt");
  assert.equal(takeDraft("failed"), "");
});
