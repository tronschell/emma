import assert from "node:assert/strict";
import test from "node:test";

import { runOf, sendTurn, settleRun, wire, type Block, type QueuedTurn } from "../src/runs";
import type { Message } from "../src/types";

type Delta = { threadId: string; delta: string };

let onDelta: (value: Delta) => void = () => undefined;
const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
let hold = false;
let release: (() => void) | undefined;

const emma = {
  request: async (_method: string, params: Record<string, string>) => {
    onDelta({ threadId: params.threadId, delta: `reply ${params.content}` });
    if (hold) await new Promise<void>((resolve) => { release = resolve; });
  },
  onDelta: (listener: (value: Delta) => void) => { onDelta = listener; return () => undefined; },
  onStep: () => () => undefined,
  onCompacted: () => () => undefined,
  onContextExperiment: () => () => undefined,
  onRoutedModel: () => () => undefined,
  onContextBreakdown: () => () => undefined,
  onAgents: () => () => undefined,
  listAgents: () => Promise.resolve([]),
  listSpans: () => Promise.resolve({}),
  livePartial: () => Promise.resolve({}),
  stopAgent: () => undefined,
};

(globalThis as unknown as { window: unknown }).window = { emma };
wire();

const turn = (content: string): QueuedTurn => ({ content, after: 0, params: {} });
const message = (content: string, timestamp: string): Message => ({ role: "assistant", content, timestamp, generation: null });
const runMessage = (content: string, timestamp: string): Message[] => [message(`reply ${content}`, timestamp)];

async function complete(id: string, content: string): Promise<Block[]> {
  hold = false;
  sendTurn(id, turn(content), () => undefined);
  await wait();
  const blocks = runOf(id).blocks;
  assert.ok(blocks.length);
  assert.equal(runOf(id).sending, false);
  return blocks;
}

test("settleRun releases cached landed turns and only the transient fields", async () => {
  const id = "settlement-success";
  const blocks = await complete(id, "success");
  const [reply] = runMessage("success", "success-time");
  runOf(id).stopped = true;
  runOf(id).draft = "draft";
  runOf(id).held = [turn("held")];
  runOf(id).routed = "model";
  settleRun(id, [reply], { [reply.timestamp]: blocks });
  assert.deepEqual(runOf(id).blocks, []);
  assert.deepEqual(runOf(id).landed, []);
  assert.equal(runOf(id).pending, null);
  assert.equal(runOf(id).stopped, true);
  assert.equal(runOf(id).draft, "draft");
  assert.deepEqual(runOf(id).held, [turn("held")]);
  assert.equal(runOf(id).routed, "model");
});

test("settleRun keeps a completion whose reply is absent or mismatched", async () => {
  const absent = "settlement-absent";
  const absentBlocks = await complete(absent, "absent");
  settleRun(absent, [message("older reply", "older-time")], { "older-time": absentBlocks });
  assert.ok(runOf(absent).blocks.length);
  assert.equal(runOf(absent).landed.length, 1);

  const mismatched = "settlement-mismatch";
  const mismatchedBlocks = await complete(mismatched, "mismatch");
  settleRun(mismatched, [message("different reply", "mismatch-time")], { "mismatch-time": mismatchedBlocks });
  assert.ok(runOf(mismatched).blocks.length);
  assert.equal(runOf(mismatched).landed.length, 1);
});

test("settleRun keeps all landed turns until every cache entry is present", async () => {
  const id = "settlement-partial";
  const first = await complete(id, "first");
  const second = await complete(id, "second");
  const replies = [...runMessage("first", "first-time"), ...runMessage("second", "second-time")];
  settleRun(id, replies, { "first-time": first });
  assert.ok(runOf(id).blocks.length);
  assert.equal(runOf(id).landed.length, 2);
  settleRun(id, replies, { "first-time": first, "second-time": [] });
  assert.ok(runOf(id).blocks.length);
  assert.equal(runOf(id).landed.length, 2);
  settleRun(id, replies, { "first-time": first, "second-time": second });
  assert.deepEqual(runOf(id).blocks, []);
  assert.deepEqual(runOf(id).landed, []);
});

test("settleRun keeps stopped, foreign, queued and in-flight runs intact", async () => {
  const stopped = "settlement-stopped";
  const stoppedBlocks = await complete(stopped, "stopped");
  runOf(stopped).stopped = true;
  settleRun(stopped, runMessage("stopped", "stopped-time"), { "stopped-time": stoppedBlocks });
  assert.deepEqual(runOf(stopped).blocks, []);

  const foreign = "settlement-foreign";
  const foreignBlocks = await complete(foreign, "foreign");
  runOf(foreign).foreign = true;
  settleRun(foreign, runMessage("foreign", "foreign-time"), { "foreign-time": foreignBlocks });
  assert.ok(runOf(foreign).blocks.length);

  const queued = "settlement-queued";
  const queuedBlocks = await complete(queued, "queued");
  runOf(queued).queue = [turn("next")];
  settleRun(queued, runMessage("queued", "queued-time"), { "queued-time": queuedBlocks });
  assert.ok(runOf(queued).blocks.length);
  assert.equal(runOf(queued).queue.length, 1);
  runOf(queued).queue = [];

  const inFlight = "settlement-in-flight";
  const inFlightBlocks = await complete(inFlight, "done");
  hold = true;
  sendTurn(inFlight, turn("next"), () => undefined);
  await wait();
  settleRun(inFlight, runMessage("done", "done-time"), { "done-time": inFlightBlocks });
  assert.equal(runOf(inFlight).sending, true);
  assert.ok(runOf(inFlight).queue.length);
  release?.();
  release = undefined;
  hold = false;
  await wait();
});

test("settleRun keeps a run when its completed blocks are no longer the landed tail", async () => {
  const id = "settlement-stale-blocks";
  const blocks = await complete(id, "stale");
  runOf(id).blocks = [...blocks];
  settleRun(id, runMessage("stale", "stale-time"), { "stale-time": blocks });
  assert.ok(runOf(id).blocks.length);
  assert.equal(runOf(id).landed.length, 1);
});
