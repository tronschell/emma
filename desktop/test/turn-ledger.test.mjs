import test from "node:test";
import assert from "node:assert/strict";
import { tracesOf, turnOf } from "../scripts/ledger.mjs";

const trace = [
  '{"v":1,"thread":"t1","model":"glm-5.3-flash","family":"glm","mode":"full","requests":"2","in":"1200","out":"300","cost":"4200","ms":"9100","discovery":"1","stop":"end_turn"}',
  '{"id":"agent:t1","name":"run","kind":"agent","startedAt":1,"endedAt":2,"status":"ok"}',
  '{"id":"call:1","name":"bash","kind":"execute","startedAt":1,"endedAt":2,"status":"failed"}',
  '{"id":"call:2","name":"read","kind":"read","startedAt":1,"endedAt":2,"status":"ok"}',
  '{"id":"call:3","name":"review","kind":"verifier","startedAt":1,"endedAt":2,"status":"failed"}',
].join("\n");

const markdown = `---\ntrace-count: 1\n---\n\n## Message 1\n\n"hello"\n\n## Trace 1\n\nTime: 2026-09-03T16:30:04Z\n\n${JSON.stringify(trace)}\n`;

test("the ledger reads every trace block off a thread's Markdown", () => {
  const found = tracesOf(markdown);
  assert.equal(found.length, 1);
  assert.equal(found[0].timestamp, "2026-09-03T16:30:04Z");

  const turn = turnOf(found[0], "from-the-filename");
  assert.equal(turn.thread, "t1");
  assert.equal(turn.model, "glm-5.3-flash");
  assert.equal(turn.cost, "4200");
  assert.equal(turn.stop, "end_turn");
  assert.equal(turn.v, undefined, "the format version is not a fact about the turn");
  assert.equal(turn.at, "2026-09-03T16:30:04Z");
  assert.equal(turn.failures, 1);
  assert.equal(turn.blocks, 1);
  assert.equal(turn.steps, 2, "a verifier review is not a step the agent took");
  assert.equal(turn.ok, true);
});

test("a thread with no trace, and a turn from before the header, both read without throwing", () => {
  assert.deepEqual(tracesOf('---\ntrace-count: 0\n---\n\n## Message 1\n\n"hi"\n'), []);
  const bare = turnOf({ timestamp: "", text: '{"id":"agent:t1","name":"run","kind":"agent","startedAt":1,"endedAt":2,"status":"failed"}' }, "t9");
  assert.equal(bare.thread, "t9");
  assert.equal(bare.ok, false);
  assert.equal(bare.model, undefined);
});
