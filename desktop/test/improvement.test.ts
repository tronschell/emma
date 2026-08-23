import test from "node:test";
import assert from "node:assert/strict";
import { encodeSpans, traceHeader, type TraceSpan } from "../shared/trace";
import { applied, compare, frictionOf, lessonBlock, readTurn, validateImprovements, MIN_ARM_TURNS, type Improvement, type Turn } from "../shared/improvement";

const span = (over: Partial<TraceSpan>): TraceSpan => ({ id: `s-${over.name ?? "x"}-${over.startedAt ?? 0}`, name: "step", kind: "bash", startedAt: 1, endedAt: 2, status: "ok", ...over });
const thread = { id: "thread-1", title: "Ship it" };
const turn = (arm: "a" | "b", failures: number): Turn =>
  readTurn({ timestamp: "2026-08-20T00:00:00Z", text: encodeSpans([span({ kind: "agent", name: "run" }), ...Array.from({ length: failures }, (_, i) => span({ startedAt: i, status: "failed", output: "boom" }))], { thread: thread.id, arm }) }, thread);

test("a turn is read back off its own trace, arm and all", () => {
  const text = encodeSpans([
    span({ kind: "agent", name: "run", status: "failed" }),
    span({ kind: "bash", status: "failed", output: "zsh: command not found: rg" }),
    span({ kind: "verifier", status: "failed", input: "Proposed action: bash\nCommand: rm -rf /tmp/x", output: '{"allow": false, "reason": "deletes outside the project"}' }),
  ], { thread: thread.id, model: "local", arm: "b" });
  // The header is a header, not a span: decodeSpans skips it, traceHeader reads it.
  assert.equal(traceHeader(text).arm, "b");
  assert.deepEqual(traceHeader('{"id":"s1","name":"x","startedAt":1}'), {});
  assert.deepEqual(traceHeader("not json"), {});

  const read = readTurn({ timestamp: "2026-08-20T00:00:00Z", text }, thread);
  assert.equal(read.arm, "b");
  assert.equal(read.failures, 1);
  assert.equal(read.blocks, 1);
  assert.equal(read.steps, 1, "a verifier review is not a step the agent took");
  assert.equal(read.ok, false);

  const [tool, verifier] = frictionOf([read, { ...read, at: 2 }]).sort((left, right) => left.kind.localeCompare(right.kind));
  assert.equal(tool.tool, "bash");
  assert.match(tool.evidence[0].text, /command not found/);
  assert.equal(tool.evidence[0].threadId, thread.id);
  assert.equal(verifier.tool, "bash", "the blocked call is named in the verifier's own prompt");
  assert.equal(verifier.evidence[0].text, "deletes outside the project");
  assert.equal(frictionOf([read]).length, 0, "once is not a pattern");
});

test("a trial waits for both arms, then only calls a gap that beats the noise", () => {
  const trial: Improvement = { id: "i1", title: "t", lever: "instructions", addition: "x", metric: "failures", startedAt: 0, state: "trial" };
  const thin = compare([turn("a", 3), turn("b", 0)], trial);
  assert.equal(thin.clear, false);
  assert.match(thin.waiting, new RegExp(`${MIN_ARM_TURNS - 1} more`));

  const arm = (side: "a" | "b", counts: number[]) => counts.map((count) => turn(side, count));
  const noisy = compare([...arm("a", [0, 6, 0, 6, 0, 6]), ...arm("b", [6, 0, 6, 0, 6, 0])], trial);
  assert.equal(noisy.waiting, "");
  assert.equal(noisy.clear, false, "same mean, wide spread — nothing to read");

  const real = compare([...arm("a", [3, 3, 4, 3, 3, 4]), ...arm("b", [0, 0, 1, 0, 0, 1])], trial);
  assert.equal(real.clear, true);
  assert.ok((real.delta ?? 0) < -70);

  // Turns from before the trial started are not its samples.
  assert.equal(compare([...arm("a", [1, 1, 1, 1, 1, 1]), ...arm("b", [0, 0, 0, 0, 0, 0])], { ...trial, startedAt: Date.now() }).a.n, 0);
});

test("only kept improvements ride a turn, and a junk store is no improvements", () => {
  const store = validateImprovements({
    items: [
      { id: "a", title: "Kept", lever: "instructions", addition: "Prefer rg over grep.", metric: "failures", startedAt: 1, state: "kept" },
      { id: "b", title: "Gone", lever: "instructions", addition: "Never do this.", metric: "failures", startedAt: 1, state: "reverted" },
      { id: "c", title: "Trying", lever: "verifier", addition: "Clear reads under the project root.", metric: "blocks", startedAt: 2, state: "trial" },
      { id: "", addition: "no id" },
      { addition: "", id: "d" },
    ],
  });
  assert.equal(store.items.length, 3);
  const use = applied(store);
  assert.match(use.kept.instructions, /Prefer rg over grep\./);
  assert.doesNotMatch(use.kept.instructions, /Never do this/);
  assert.equal(use.kept.verifier, "", "a trial is not kept text — it rides only arm b");
  assert.deepEqual(use.trial, { lever: "verifier", addition: "Clear reads under the project root." });
  assert.equal(lessonBlock([" ", ""]), "");
  assert.deepEqual(validateImprovements("nonsense"), { items: [] });
});
