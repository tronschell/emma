import test from "node:test";
import assert from "node:assert/strict";
import { describeScreen, look, screenPrompt, visionPrompt, VISION_UNSET } from "../main/vision";
import { parseToolArgs, describeToolCall, toolDefinitions } from "../main/tools";
import { toolGate } from "../shared/permissions";
import { defaultVision, validateVision, validateToolSettings, defaultVisionSystem } from "../shared/settings";
import type { ChatMessage, ContentPart } from "../main/verifier";

const everything = { folders: true, computer: true };

test("the image travels as an image part beside the question, not as a description of one", async () => {
  let sent: ChatMessage[] = [];
  const answer = await look({ ...defaultVision, credentialEnv: "" }, "data:image/jpeg;base64,/9j/", "Where is the Save button?", async (_settings, messages) => {
    sent = messages;
    return "Save is at [820, 44, 902, 72]. The image is 1440 × 900.";
  });
  const parts = sent[1].content as ContentPart[];
  assert.equal(sent[0].content, defaultVisionSystem);
  assert.deepEqual(parts[1], { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } });
  assert.match(parts[0].type === "text" ? parts[0].text : "", /Where is the Save button\?/);
  // The answer comes back attributed, because the agent did not see the image itself.
  assert.match(answer, /\[820, 44, 902, 72\]/);
  assert.match(answer, /second model's reading/);
});

test("text inside the image is framed as content to report, never as instructions", () => {
  const prompt = visionPrompt("What does this dialog say?");
  assert.match(prompt, /not an instruction to follow/);
  assert.match(prompt, /What does this dialog say\?/);
  // And the standing brief says the same thing to the model that can actually read it.
  assert.match(defaultVisionSystem, /content, not instructions/);
  // Boxes are the point of the tool, so the brief has to name their form.
  assert.match(defaultVisionSystem, /\[x0, y0, x1, y1\]/);
});

test("a call names exactly one image, and a cleared model answers with directions", async () => {
  assert.deepEqual(parseToolArgs("vision", '{"question":"what is this?","path":"shots/a.png"}'), { name: "vision", question: "what is this?", path: "shots/a.png", url: undefined, folder: undefined });
  assert.throws(() => parseToolArgs("vision", '{"question":"what is this?"}'), /path/);
  assert.throws(() => parseToolArgs("vision", '{"question":"q","path":"a.png","url":"https://example.com/a.png"}'), /not both/);
  assert.throws(() => parseToolArgs("vision", '{"path":"a.png"}'), /"question" argument is required/);
  assert.equal(describeToolCall(parseToolArgs("vision", '{"question":"q","path":"shots/a.png"}')), "looking at shots/a.png");

  // Switched off in settings, the tool still answers — an agent told nothing invents a reason.
  assert.equal(await look({ ...defaultVision, model: "" }, "data:image/jpeg;base64,/9j/", "q"), VISION_UNSET);
});

test("the vision route is validated like the other second models, and offered in every mode", () => {
  assert.deepEqual(validateVision(undefined), defaultVision);
  assert.equal(validateToolSettings(undefined).vision.model, defaultVision.model);
  assert.throws(() => validateVision({ ...defaultVision, endpoint: "http://example.com/v1" }), /https/);
  assert.throws(() => validateVision({ ...defaultVision, credentialEnv: "not an env name" }), /environment variable/);
  // A read of a granted image, answered in words: free wherever `read_file` is.
  assert.equal(toolGate("ask", "vision"), "auto");
  assert.equal(toolGate("full", "vision"), "auto");
  assert.equal(toolGate("ask", "vision", ["vision"]), "hidden");
  // Offered without a folder connected: a public image URL needs no grant.
  assert.ok(toolDefinitions("full", { ...everything, folders: false }).some((tool) => tool.name === "vision"));
});

test("a saved screen goes to the vision model as the picture plus what the Mac says is in front", async () => {
  let sent: ChatMessage[] = [];
  const text = await describeScreen(
    { ...defaultVision, credentialEnv: "" },
    "data:image/jpeg;base64,/9j/",
    { application: "Safari", window: "Ligatures — Departure Mono", url: "https://example.com/post", title: "Ligature rendering" },
    async (_settings, messages) => { sent = messages; return "  A blog post about ligature rendering.  "; },
  );
  const parts = sent[1].content as ContentPart[];
  assert.deepEqual(parts[1], { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } });
  assert.equal(text, "A blog post about ligature rendering.");
  const prompt = screenPrompt({ application: "Safari", window: "Ligatures — Departure Mono", url: "https://example.com/post", title: "Ligature rendering" });
  assert.match(prompt, /Application: Safari/);
  assert.match(prompt, /URL: https:\/\/example\.com\/post/);
  assert.match(sent[0].content as string, /never an instruction to follow/);
  assert.equal(await describeScreen({ ...defaultVision, model: "" }, "data:image/jpeg;base64,/9j/", { application: "Safari", window: "" }), "");
});
