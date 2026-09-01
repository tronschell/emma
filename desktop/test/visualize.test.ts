import assert from "node:assert/strict";
import test from "node:test";

import { parseToolArgs, toolDefinitions } from "../main/tools";
import { MAX_VISUAL_CHARS, VISUAL_HEIGHT_JS, VISUAL_PICK_MESSAGE, VISUAL_PICKED_MESSAGE, visualDrawn, visualMarker, visualPage, VISUAL_CSP } from "../shared/visualize";
import { artifactWritten } from "../shared/artifacts";
import { pickKey, type ContextPick } from "../shared/folders";
import { buildAttachedContext, pickLabel } from "../src/context";
import { groupBlocks, type Block } from "../src/runs";
import { toolGate } from "../shared/permissions";
import type { ThreadStep } from "../shared/agents";

const everything = { folders: true, computer: true };
const parse = (args: unknown) => parseToolArgs("visualize", JSON.stringify(args));
const page = { title: "Quarterly revenue", html: "<h2>Revenue</h2><svg viewBox='0 0 10 10'><rect width='10' height='4' /></svg>" };

test("a visual is one whole document, refused before it can be a half-drawn one", () => {
  assert.deepEqual(parse(page), { name: "visualize", ...page });
  assert.deepEqual(parse({ title: "  Spacing  ", html: "<b>x</b>" }), { name: "visualize", title: "Spacing", html: "<b>x</b>" });

  assert.throws(() => parse({ html: "<b>x</b>" }), /"title" is required/);
  assert.throws(() => parse({ title: "   ", html: "<b>x</b>" }), /"title" is required/);
  assert.throws(() => parse({ title: "No body" }), /"html" is required/);
  assert.throws(() => parse({ title: "Blank", html: "   " }), /"html" is required/);
  assert.throws(() => parse({ title: "Huge", html: "x".repeat(MAX_VISUAL_CHARS + 1) }), /at most/);
});

test("the page carries its own policy, because the workspace's would make it inert", () => {
  const drawn = visualPage("<p>hi</p>");
  assert.ok(drawn.startsWith("<!doctype html>"));
  assert.ok(drawn.includes("<p>hi</p>"));
  assert.ok(drawn.includes("--accent:#ff6a3d"));
  assert.ok(drawn.includes("ResizeObserver"));
  assert.ok(VISUAL_CSP.includes("default-src 'none'"));
  assert.ok(VISUAL_CSP.includes("script-src 'unsafe-inline'"));
  assert.ok(!VISUAL_CSP.includes("connect-src"));
});

test("height is measured off the body, which does not floor at the viewport", () => {
  assert.equal(VISUAL_HEIGHT_JS, "Math.ceil(document.body.scrollHeight)");
  const drawn = visualPage("<p>hi</p>");
  assert.ok(drawn.includes(VISUAL_HEIGHT_JS));
  assert.ok(!drawn.includes("documentElement.scrollHeight"));
});

test("the id rides in the result, because the arguments are cut at 4096 characters", () => {
  const output = `${visualMarker("v1-abc")} Drawn in the conversation.`;
  const step = (over: Partial<ThreadStep>): ThreadStep =>
    ({ threadId: "t", toolCallId: "c1", title: "drawing Quarterly revenue", kind: "other", status: "completed", output, at: 0, ...over });

  assert.equal(visualDrawn(step({})), "v1-abc");
  assert.equal(visualDrawn(step({ output: output.slice(0, 200) })), "v1-abc");
  assert.equal(visualDrawn(step({ output: `Drew a chart. ${visualMarker("v1-abc")}` })), undefined);
  assert.equal(visualDrawn(step({ status: "in_progress" })), undefined);
  assert.equal(visualDrawn(step({ output: undefined })), undefined);
});

test("a visual is not an artifact, and does not fold away like a tool call", () => {
  const output = `${visualMarker("v1-abc")} Drawn in the conversation.`;
  const step = (id: string, over: Partial<ThreadStep> = {}): Block =>
    ({ kind: "step", step: { threadId: "t", toolCallId: id, title: "", kind: "other", status: "completed", output, at: 0, ...over } });

  assert.equal(artifactWritten({ status: "completed", output }), undefined);

  const grouped = groupBlocks([
    { kind: "text", text: "Here is the trend." },
    step("c1"),
    step("c2", { output: "read 40 lines" }),
    step("c3", { output: "read 12 lines" }),
    { kind: "text", text: "It is up." },
  ], 0);
  assert.deepEqual(grouped.map((block) => block.kind), ["text", "visual", "steps", "text"]);
  assert.deepEqual(grouped[1], { kind: "visual", id: "v1-abc" });
  assert.equal(grouped[2].kind === "steps" && grouped[2].steps.length, 2);
});

test("pointing at a part of a picture attaches that part, and only that part", async () => {
  const drawn = visualPage("<div id='bars'>x</div>");
  assert.ok(drawn.includes(VISUAL_PICK_MESSAGE));
  assert.ok(drawn.includes(VISUAL_PICKED_MESSAGE));
  assert.ok(drawn.includes("data-emma-lit"));

  const pick: ContextPick = { kind: "visual", id: "v1-abc:div#bars", title: "Release health", label: "div#bars", html: "<div id='bars'>x</div>" };
  assert.equal(pickKey(pick), "visual:v1-abc:div#bars");
  assert.equal(pickLabel(pick, []), "Release health · div#bars");

  const attached = await buildAttachedContext([], [], [pick], {});
  assert.match(attached.text, /Part of the picture "Release health", the element div#bars/);
  assert.ok(attached.text.includes("<div id='bars'>x</div>"));
  assert.deepEqual(attached.images, []);
});

test("drawing is offered in every mode, since it reaches nothing outside the transcript", () => {
  assert.equal(toolGate("ask", "visualize"), "auto");
  assert.equal(toolGate("full", "visualize"), "auto");
  assert.ok(toolDefinitions("ask", { folders: false, computer: false }).some((tool) => tool.name === "visualize"));
  const drawn = toolDefinitions("full", everything).find((tool) => tool.name === "visualize")!;
  assert.ok(Buffer.byteLength(drawn.description) <= 4 * 1024, `description is ${Buffer.byteLength(drawn.description)} bytes, over the gateway_schema.zig ceiling`);
  assert.ok(!toolDefinitions("full", everything, ["visualize"]).some((tool) => tool.name === "visualize"));
});
