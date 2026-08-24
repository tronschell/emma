import test from "node:test";
import assert from "node:assert/strict";
import { allocateCells, charLabel, mergeUses, rateByContext, shareLabel, systemChars, CHARS_PER_TOKEN, MAX_USES } from "../shared/usage";

test("a repeated segment counts its turns and keeps its latest size", () => {
  const first = mergeUses([], [{ kind: "messages", label: "notes/plan.txt", chars: 100 }, { kind: "skills", label: "claude/review", chars: 40 }]);
  const second = mergeUses(first, [{ kind: "messages", label: "notes/plan.txt", chars: 250 }]);
  assert.deepEqual(second[0], { kind: "messages", label: "notes/plan.txt", chars: 250, turns: 2 });
  assert.deepEqual(second[1], { kind: "skills", label: "claude/review", chars: 40, turns: 1 });
  const flooded = Array.from({ length: MAX_USES + 8 }, (_, index) => ({ kind: "messages" as const, label: `file-${index}`, chars: 1 }));
  assert.equal(mergeUses(second, flooded).length, MAX_USES);
});

test("the grid is always full, and every segment keeps at least one cell", () => {
  const cells = allocateCells([{ key: "history", chars: 40_000 }, { key: "file", chars: 300 }, { key: "skill", chars: 20 }], 48);
  assert.equal(cells.length, 48);
  assert.equal(cells.filter((key) => key === "skill").length, 1);
  assert.equal(cells.filter((key) => key === "history").length, 46);
  assert.deepEqual(allocateCells([{ key: "skill", chars: 0 }], 48), []);
  assert.equal(allocateCells(Array.from({ length: 60 }, (_, index) => ({ key: `k${index}`, chars: 10 })), 48).length, 48);
});

test("the invisible half of a turn is a residual, never an invention", () => {
  // 4,000 billed input tokens is 16,000 characters; the transcript this side
  // measured was 344 of them, so the system prompt and tool schemas are the rest.
  assert.equal(systemChars(4_000, 344), 4_000 * CHARS_PER_TOKEN - 344);
  // No usage reported, or a transcript that already covers the input: no row.
  assert.equal(systemChars(0, 344), 0);
  assert.equal(systemChars(10, 10_000), 0);
});

test("speed is pooled per doubling of context, ascending", () => {
  const turn = (inputTokens: number, outputTokens: number, durationMilliseconds: number) => ({ inputTokens, outputTokens, durationMilliseconds });
  const curve = rateByContext([
    turn(70_000, 500, 10_000), // 64K
    turn(900, 100, 1_000),     // under the floor, so 4K
    turn(5_000, 300, 1_000),   // 4K
    turn(8_192, 100, 2_000),   // 8K — exactly on the boundary, not in 4K
    turn(9_000, 0, 0),         // no measured time is not a rate
  ]);
  assert.deepEqual(curve.map((point) => point.context), [4096, 8192, 65_536]);
  // 400 tokens over 2s pooled, not the average of 100/s and 300/s.
  assert.deepEqual(curve.map((point) => Math.round(point.rate)), [200, 50, 50]);
  assert.deepEqual(curve.map((point) => point.turns), [2, 1, 1]);
  assert.deepEqual(rateByContext([]), []);
});

test("sizes read at a glance", () => {
  assert.deepEqual([charLabel(940), charLabel(4200), charLabel(42_000)], ["940", "4.2k", "42k"]);
  assert.deepEqual([shareLabel(400, 1000), shareLabel(1, 1000), shareLabel(5, 0)], ["40.0%", "0.1%", "—"]);
});
