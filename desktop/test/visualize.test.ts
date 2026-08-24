import assert from "node:assert/strict";
import test from "node:test";

import { parseToolArgs, toolDefinitions } from "../main/tools";
import { readVisualization, VISUAL_MARKER, type Visualization } from "../shared/visualize";
import { artifactWritten } from "../shared/artifacts";
import { groupBlocks, type Block } from "../src/runs";
import { toolGate } from "../shared/permissions";
import type { ThreadStep } from "../shared/agents";

const everything = { folders: true, computer: true };
const parse = (args: unknown) => parseToolArgs("visualize", JSON.stringify(args));
const quarters = { kind: "line", labels: ["Q1", "Q2", "Q3"], values: [4, 9, 7], caption: "Revenue" };

test("a visualization is refused before it can draw something the numbers do not say", () => {
  assert.deepEqual(parse(quarters), { name: "visualize", ...quarters });
  // Bar is the default, and a caption is optional: the picture is the explanation.
  assert.deepEqual(parse({ labels: ["a"], values: [1] }), { name: "visualize", kind: "bar", labels: ["a"], values: [1], caption: "" });

  // A label with no number, or a number with no label, is a chart that quietly
  // misreads — every point after the gap slides onto the wrong label.
  assert.throws(() => parse({ labels: ["a", "b"], values: [1] }), /same length/);
  assert.throws(() => parse({ labels: [], values: [] }), /non-empty/);
  // "1.2k" and "43%" are what a model reaches for, and both plot as a gap the
  // reader takes for zero.
  assert.throws(() => parse({ labels: ["a"], values: ["1.2k"] }), /finite number/);
  assert.throws(() => parse({ labels: ["a"], values: [Number.NaN] }), /finite number/);
  assert.throws(() => parse({ labels: [""], values: [1] }), /non-empty string/);
  assert.throws(() => parse({ labels: ["x".repeat(64)], values: [1] }), /24 characters/);
  assert.throws(() => parse({ kind: "pie", labels: ["a"], values: [1] }), /bar, line, area/);
  const many = Array.from({ length: 13 }, (_item, at) => at);
  assert.throws(() => parse({ labels: many.map(String), values: many }), /at most 12/);
});

test("the picture rides in the arguments, because the result is cut at 200 bytes", () => {
  const output = `${VISUAL_MARKER} Drawn in the conversation, under the answer you are writing.`;
  const step = (over: Partial<ThreadStep>): ThreadStep =>
    ({ threadId: "t", toolCallId: "c1", title: "drawing a line chart", kind: "other", status: "completed", input: JSON.stringify(quarters), output, at: 0, ...over });

  // What the renderer draws is the call's own arguments — the result never
  // carried them, so the harness cutting it changes nothing.
  assert.deepEqual(readVisualization(step({})), quarters as Visualization);
  assert.deepEqual(readVisualization(step({ output: output.slice(0, 200) })), quarters as Visualization);

  // The marker is the whole test, and it has to lead: on the harness the tool's
  // name never reaches the renderer, and the tail of the result is what gets cut.
  assert.equal(readVisualization(step({ output: `Drew a chart. ${VISUAL_MARKER}` })), undefined);
  assert.equal(readVisualization(step({ status: "in_progress" })), undefined);
  // Arguments that aged out of the transcript cache, or were truncated on the way
  // in: a step row again, never a half-drawn chart.
  assert.equal(readVisualization(step({ input: '{"labels":["Q1","Q2"' })), undefined);
  assert.equal(readVisualization(step({ input: undefined })), undefined);
  // And the renderer re-runs the same validator main did, so a payload main would
  // have refused cannot become a chart by arriving from somewhere else.
  assert.equal(readVisualization(step({ input: JSON.stringify({ labels: ["a", "b"], values: [1] }) })), undefined);
});

test("a visualization is not an artifact, and does not fold away like a tool call", () => {
  const output = `${VISUAL_MARKER} Drawn in the conversation.`;
  const step = (id: string, over: Partial<ThreadStep> = {}): Block =>
    ({ kind: "step", step: { threadId: "t", toolCallId: id, title: "", kind: "other", status: "completed", input: JSON.stringify(quarters), output, at: 0, ...over } });

  // Nothing on the Artifacts page, no id in that namespace: the two markers are
  // separate so a picture can never be mistaken for a file the user keeps.
  assert.equal(artifactWritten({ status: "completed", output }), undefined);

  // Steps fold behind one caret; the picture does not, or it would be a chart
  // nobody ever sees. Drawn where it happened, between the two stretches of talk.
  const grouped = groupBlocks([
    { kind: "text", text: "Here is the trend." },
    step("c1"),
    step("c2", { input: "{}", output: "read 40 lines" }),
    step("c3", { input: "{}", output: "read 12 lines" }),
    { kind: "text", text: "It is up." },
  ], 0);
  assert.deepEqual(grouped.map((block) => block.kind), ["text", "visual", "steps", "text"]);
  assert.deepEqual(grouped[1], { kind: "visual", visual: quarters });
  // The two ordinary calls still fold, and the picture never spent their budget.
  assert.equal(grouped[2].kind === "steps" && grouped[2].steps.length, 2);
});

test("drawing is offered in every mode, since it reaches nothing outside the transcript", () => {
  assert.equal(toolGate("ask", "visualize"), "auto");
  assert.equal(toolGate("full", "visualize"), "auto");
  // No folder, no MCP, no Mac: a picture needs none of them.
  assert.ok(toolDefinitions("ask", { folders: false, computer: false }).some((tool) => tool.name === "visualize"));
  // The description reaches the model over MCP, which truncates it at 1024 bytes —
  // and the argument rules are the tail that would be cut.
  const drawn = toolDefinitions("full", everything).find((tool) => tool.name === "visualize")!;
  assert.ok(Buffer.byteLength(drawn.description) <= 1024, `description is ${Buffer.byteLength(drawn.description)} bytes`);
  assert.ok(!toolDefinitions("full", everything, ["visualize"]).some((tool) => tool.name === "visualize"));
});
