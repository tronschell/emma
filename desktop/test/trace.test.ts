import test from "node:test";
import assert from "node:assert/strict";
import { axisTicks, clampTrace, countCalls, decodeSpans, encodeSpans, formatDuration, layoutSpans, renderTrace, summarizeSpans, tokenAxis, type TraceSpan } from "../shared/trace";

const span = (id: string, startedAt: number, endedAt: number | undefined, extra: Partial<TraceSpan> = {}): TraceSpan =>
  ({ id, name: id, kind: "read", startedAt, endedAt, status: "ok", ...extra });

/** The shape `AgentRuntime` writes: a run, its model requests, its calls, a subagent. */
const turn = (): TraceSpan[] => [
  span("agent:root", 1000, 5000, { name: "root", kind: "agent" }),
  span("model:root:1", 1000, 1500, { name: "model · prompt", kind: "model", output: "asked for read_file" }),
  span("call:a", 1500, 2000, { name: "call a", input: '{"path":"a.txt"}', output: "ok\nfine" }),
  span("agent:kid", 2000, 3000, { name: "kid", kind: "agent", parentId: "call:a" }),
  span("call:b", 2500, 3000, { name: "call b", parentId: "agent:kid", status: "failed", output: "no such file" }),
];

test("spans lay out depth-first against one axis", () => {
  const spans = turn().map((item) => (item.id === "call:a" || item.id === "model:root:1" ? { ...item, parentId: "agent:root" } : item));
  const rows = layoutSpans(spans, 9999);
  assert.deepEqual(rows.map((row) => [row.span.id, row.depth]), [
    ["agent:root", 0], ["model:root:1", 1], ["call:a", 1], ["agent:kid", 2], ["call:b", 3],
  ]);
  assert.deepEqual([rows[0].offset, rows[0].width, rows[0].durationMs], [0, 100, 4000]);
  // The model request ran 1000–1500: at the start, an eighth wide.
  assert.deepEqual([rows[1].offset, rows[1].width], [0, 12.5]);
  assert.equal(rows[0].children, 2);

  // A collapsed span hides its subtree and nothing else.
  assert.deepEqual(layoutSpans(spans, 9999, new Set(["call:a"])).map((row) => row.span.id), ["agent:root", "model:root:1", "call:a"]);
});

test("an open span runs to the clock and an instant one still draws", () => {
  const spans = [span("agent:t", 1000, undefined, { kind: "agent", status: "running" }), span("call:a", 1000, 1000)];
  const rows = layoutSpans(spans, 3000);
  assert.equal(rows[0].durationMs, 2000);
  assert.equal(rows.find((row) => row.span.id === "call:a")!.width, 1.5, "a zero-length call keeps a visible sliver");
});

test("the context axis lays growth end to end and a parent covers what is under it", () => {
  const weights: Record<string, number> = { "model:root:1": 100, "call:a": 300, "call:b": 200 };
  const spans = turn().map((item) => ({
    ...item,
    parentId: item.id === "call:a" || item.id === "model:root:1" ? "agent:root" : item.parentId,
    tokens: weights[item.id],
  }));
  // The run holds all 600; the model's answer is the first 100; call:a covers its
  // subagent's 200 and then its own 300; the subagent's only cost is its call.
  assert.deepEqual(tokenAxis(spans).map((span) => [span.id, span.startedAt, span.endedAt]), [
    ["agent:root", 0, 600], ["model:root:1", 0, 100], ["call:a", 100, 600], ["agent:kid", 100, 300], ["call:b", 100, 300],
  ]);
  // A trace from before spans were weighed collapses rather than throwing.
  assert.deepEqual(tokenAxis(turn()).map((span) => span.endedAt), [0, 0, 0, 0, 0]);

  // How the timeline reconciles with the context ledger: the root carries the mass
  // no span accounts for — schemas, system prompt, retrieval — and its extent is
  // that plus its subtree, leaving the difference as an unfilled tail.
  const withBaseline = spans.map((item) => (item.id === "agent:root" ? { ...item, tokens: 400 } : item));
  const laid = tokenAxis(withBaseline);
  assert.deepEqual([laid[0].startedAt, laid[0].endedAt], [0, 1000], "the root totals the ledger, not just what its steps grew");
  assert.equal(laid[laid.length - 3].endedAt, 600, "its children still stop where their own growth ends");
});

test("the rendered trace numbers its spans depth-first and keeps one span to one line", () => {
  const spans = turn().map((item) => (item.id === "call:a" || item.id === "model:root:1" ? { ...item, parentId: "agent:root" } : item));
  const text = renderTrace(spans, 9999, { thread: "root", model: "m" });
  assert.deepEqual(text.split("\n"), [
    "trace v1 thread=root model=m spans=5",
    '#1 agent "root" 4.00s ok',
    "  #2 model · prompt 500ms ok",
    "     out asked for read_file",
    "  #3 call a 500ms ok",
    '     in {"path":"a.txt"}',
    "     out ok fine",
    '    #4 agent "kid" 1.00s ok',
    "      #5 call b 500ms failed",
    "         err no such file",
  ]);
  assert.equal(renderTrace([], 9999), "", "nothing happened, so there is nothing to record");
});

test("spans survive the round trip through the thread", () => {
  const spans = turn();
  const decoded = decodeSpans(encodeSpans(spans, { thread: "root" }));
  // Through JSON on both sides: a decoded span carries the absent fields as
  // explicit `undefined`, which is the same span and not the same object.
  assert.deepEqual(JSON.parse(JSON.stringify(decoded)), JSON.parse(JSON.stringify(spans)), "what the inspector draws after a restart is what it drew live");
  assert.deepEqual(decodeSpans(""), [], "nothing recorded, nothing to draw");
  // A trace written before spans were stored, and a clamped one, must not throw.
  assert.deepEqual(decodeSpans("trace v1 thread=root\n#1 agent \"root\" 4.00s ok"), []);
  assert.deepEqual(decodeSpans(encodeSpans(spans).split("\n").slice(0, 2).concat("  … 3 lines elided …").join("\n")).map((item) => item.id), ["agent:root"]);
  assert.equal(encodeSpans([]), "", "no spans, no record");
});

test("a stored span keeps its arguments but not a whole file", () => {
  const [stored] = decodeSpans(encodeSpans([span("call:a", 1, 2, { input: "x".repeat(4096) })]));
  assert.ok(stored.input!.length < 1100, `kept ${stored.input!.length} characters`);
  assert.ok(stored.input!.endsWith("…"));
});

test("an oversized trace loses its middle, not the run", () => {
  const lines = Array.from({ length: 500 }, (_unused, index) => `#${index} bash 1ms ok`);
  const clamped = clampTrace(lines.join("\n"), 512);
  assert.ok(clamped.length <= 512, `clamped to ${clamped.length}`);
  assert.ok(clamped.startsWith("#0 bash"), "the start of the run says what it set out to do");
  assert.ok(clamped.endsWith("#499 bash 1ms ok"), "the end says where it got to");
  assert.match(clamped, /… \d+ lines elided …/);
  assert.equal(clampTrace("short", 512), "short", "under the cap, untouched");
});

test("durations read the way a span label should", () => {
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(888), "888ms");
  assert.equal(formatDuration(3870), "3.87s");
  assert.equal(formatDuration(124_000), "2m 04s");
});

test("the lifecycle summary counts work, not the frame around it", () => {
  // Two turns of the same shape, so a tally has something to add up.
  const spans = [...turn(), ...turn().map((item) => ({ ...item, id: `${item.id}#2`, startedAt: item.startedAt + 10_000, endedAt: item.endedAt === undefined ? undefined : item.endedAt + 10_000 }))];
  const summary = summarizeSpans(spans, 99_999)!;
  assert.equal(summary.from, 1000, "first turn's start, in real clock time");
  assert.equal(summary.to, 15_000, "last turn's end, gap included");
  assert.equal(summary.modelRequests, 2);
  assert.equal(summary.toolCalls, 4, "agent spans are the frame, not the work");
  assert.equal(summary.failed, 2);
  // call:a ran 500ms twice, call:b 500ms twice — a tie broken by first seen.
  assert.deepEqual(summary.tools.map((tool) => [tool.name, tool.count, tool.ms]), [["call a", 2, 1000], ["call b", 2, 1000]]);
  assert.deepEqual(summary.slowest, { name: "call a", ms: 500 });

  // An open span is measured to the clock, like its bar is.
  const open = summarizeSpans([span("call:c", 1000, undefined)], 4000)!;
  assert.deepEqual(open.slowest, { name: "call:c", ms: 3000 });
  assert.equal(summarizeSpans([], 0), undefined);

  // The Auto verifier's review is an answer to a permission ask, not a call, and
  // the running count on the loop does not count one either.
  const reviewed = [...turn(), span("call:verify:1", 1600, 1900, { name: "auto agent approved · call a", kind: "verifier" })];
  assert.equal(summarizeSpans(reviewed, 99_999)!.toolCalls, 2);
  assert.equal(countCalls(reviewed), 2);
});

test("the axis ticks on round numbers and stops short of the end", () => {
  const at = (ms: number) => axisTicks(ms);
  assert.equal(at(2600).step, 500, "a 2.6s turn reads in half-seconds");
  assert.deepEqual(at(2600).marks, [0, 500, 1000, 1500, 2000, 2500]);
  // Exactly divisible: the last mark would sit on the right edge, so it is dropped.
  assert.deepEqual(at(3000).marks, [0, 500, 1000, 1500, 2000, 2500]);
  assert.deepEqual(at(60_000).step, 10_000);
  // Never more than a tick per gridline slot, at any magnitude — and never zero.
  for (const ms of [0, 1, 7, 250, 999, 45_000, 3_600_000]) {
    const { step, marks } = at(ms);
    assert.ok(step > 0, `${ms}ms: a step of ${step} would loop forever`);
    assert.ok(marks.length <= 7, `${ms}ms: ${marks.length} ticks is a crowded axis`);
    assert.equal(marks[0], 0);
  }
});
