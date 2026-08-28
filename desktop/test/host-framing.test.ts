import assert from "node:assert/strict";
import test from "node:test";
import { BoundedLines, HostResponses, MAX_HOST_CHUNK_BYTES, parseHostLine } from "../main/ndjson";

const frame = (id: string, chunk: string, sequence: number, end = false) => JSON.stringify({ id, chunk, sequence, end });

test("host chunks preserve Unicode across pipe boundaries and interleaved requests and due jobs", () => {
  const responses = new HostResponses();
  const lines = new BoundedLines(16 * 1024 * 1024);
  const first = { id: "1", ok: true, result: { messages: ["🙂漢字\n\\\"".repeat(20_000)], traces: ["trace 🙂"] } };
  const encoded = JSON.stringify(first);
  const dueJob = { dueJob: { jobId: "j", threadId: "t", title: "T", prompt: "p", nodes: "", variables: "{}", permissionMode: "full", model: "", depth: 0 } };
  const second = { id: "2", ok: false, error: "request failed" };
  const wire: string[] = [];
  let sequence = 0;
  for (let offset = 0; offset < encoded.length;) {
    let end = Math.min(encoded.length, offset + 8000);
    if (/[\uD800-\uDBFF]/.test(encoded[end - 1])) end--;
    wire.push(frame("1", encoded.slice(offset, end), sequence++, end === encoded.length));
    if (!offset) wire.push(frame("2", JSON.stringify(second), 0, true), JSON.stringify(dueJob));
    offset = end;
  }
  const bytes = Buffer.from(`${wire.join("\n")}\n`);
  const completed = [];
  for (let offset = 0; offset < bytes.length; offset += 137) {
    for (const line of lines.push(bytes.subarray(offset, offset + 137))) {
      const response = responses.push(parseHostLine(line));
      if (response) completed.push(response);
    }
  }
  lines.end();
  responses.end();
  assert.deepEqual(completed, [second, dueJob, first]);
});

test("host framing rejects malformed, missing, duplicate and mismatched chunks", () => {
  for (const value of [
    { id: "1", chunk: "", sequence: 0, end: true },
    { id: "1", chunk: "x", sequence: -1, end: true },
    { id: "1", chunk: "x", sequence: 0.5, end: true },
    { id: "1", chunk: "x", sequence: 0 },
    { id: "1", chunk: "x", sequence: 0, end: true, ok: true },
    { id: "1", chunk: "x", sequence: 0, end: true, dueJob: {} },
    { id: "1", chunk: "x".repeat(MAX_HOST_CHUNK_BYTES + 1), sequence: 0, end: true },
  ]) assert.throws(() => parseHostLine(JSON.stringify(value)), /chunk envelope/);
  const responses = new HostResponses();
  const first = parseHostLine(frame("1", "{", 0));
  assert.throws(() => responses.push(parseHostLine(frame("1", "x", 1))), /sequence/);
  responses.push(first);
  assert.throws(() => responses.push(first), /sequence/);
  assert.throws(() => responses.end(), /mid-response/);
  assert.throws(() => responses.push({ id: "1", ok: true, result: null }), /final chunk/);
  responses.clear();
  responses.end();
  for (const text of ['{"id":"other","ok":true,"result":null}', '{"id":"1","chunk":"x","sequence":0,"end":true}', 'not json']) {
    assert.throws(() => responses.push(parseHostLine(frame("1", text, 0, true))));
  }
  const lines = new BoundedLines(1024);
  lines.push(Buffer.from('{"id":"1"'));
  assert.throws(() => lines.end(), /mid-line/);
});

test("an oversized aggregate rejects only its request and drains through the final chunk", () => {
  const responses = new HostResponses(10);
  assert.equal(responses.push(parseHostLine(frame("1", "x".repeat(11), 0))), undefined);
  const second = { id: "2", ok: true as const, result: "healthy" };
  assert.deepEqual(responses.push(second), second);
  assert.equal(responses.push(parseHostLine(frame("1", "discarded", 1))), undefined);
  const rejected = responses.push(parseHostLine(frame("1", "last", 2, true)));
  assert.equal(rejected && "ok" in rejected && rejected.ok, false);
  assert.deepEqual(responses.push({ ...second, id: "3" }), { ...second, id: "3" });
  responses.end();
});
