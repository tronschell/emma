import test from "node:test";
import assert from "node:assert/strict";
import { readStepsReply, stepsPrompt, suggestNextSteps } from "../main/next-steps";
import { MAX_STEP_TITLE, emptyWorkState, validateSteps, validateWorkState, type WorkState } from "../shared/next-steps";
import { defaultSteps } from "../src/next-steps";
import type { VerifierSettings } from "../shared/settings";

const dirty: WorkState = {
  project: "emma",
  branch: "dev",
  ahead: 2,
  behind: 1,
  files: [{ path: "desktop/src/App.tsx", state: "modified" }, { path: "docs/tools.md", state: "modified" }],
  largest: { path: "desktop/src/App.tsx", added: 40, removed: 12 },
  threads: ["Rework the empty state"],
};

const free: VerifierSettings = { model: "z-ai/glm-5.2:free", endpoint: "https://openrouter.ai/api/v1/chat/completions", credentialEnv: "", system: "" };

const reply = (steps: unknown) => JSON.stringify({ steps });

test("a well formed reply becomes steps", () => {
  const steps = readStepsReply(reply([
    { title: "Commit the tree", detail: "Two files are unstaged", prompt: "Stage and commit what is here." },
    { title: "Open the pull request", detail: "dev is two ahead", prompt: "Draft the PR for this branch." },
    { title: "Update docs/tools.md", detail: "It drifted", prompt: "Check docs/tools.md against the code." },
  ]));
  assert.equal(steps.length, 3);
  assert.equal(steps[0].title, "Commit the tree");
});

test("thinking tags and prose around the object are stripped", () => {
  const steps = readStepsReply(`<think>weighing it up</think>Here you go:\n${reply([
    { title: "One", detail: "a", prompt: "do one" },
    { title: "Two", detail: "b", prompt: "do two" },
    { title: "Three", detail: "c", prompt: "do three" },
  ])}\nHope that helps.`);
  assert.deepEqual(steps.map((step) => step.title), ["One", "Two", "Three"]);
});

test("fewer than three usable steps is no answer at all", () => {
  assert.deepEqual(readStepsReply(reply([{ title: "One", detail: "a", prompt: "do one" }])), []);
  assert.deepEqual(readStepsReply(reply([
    { title: "One", detail: "a", prompt: "do one" },
    { title: "one", detail: "a", prompt: "again" },
    { title: "", detail: "c", prompt: "do three" },
    { title: "Four", detail: "d", prompt: "" },
  ])), []);
});

test("nothing parseable is no answer, never a throw", () => {
  assert.deepEqual(readStepsReply("I would start with the tests."), []);
  assert.deepEqual(readStepsReply("{ not json }"), []);
  assert.deepEqual(validateSteps("steps"), []);
});

test("titles, details and prompts are clamped", () => {
  const steps = readStepsReply(reply([
    { title: "x".repeat(400), detail: "y".repeat(400), prompt: "z".repeat(900) },
    { title: "Two", detail: "b", prompt: "do two" },
    { title: "Three", detail: "c", prompt: "do three" },
  ]));
  assert.equal(steps[0].title.length, MAX_STEP_TITLE);
  assert.ok(steps[0].prompt.length <= 400);
});

test("at most five steps come back", () => {
  const steps = readStepsReply(reply(Array.from({ length: 9 }, (_, index) => ({ title: `Step ${index}`, detail: "d", prompt: "p" }))));
  assert.equal(steps.length, 5);
});

test("the prompt quotes the state and names the files", () => {
  const prompt = stepsPrompt(dirty);
  assert.ok(prompt.includes("<<<STATE"));
  assert.ok(prompt.includes("STATE>>>"));
  assert.ok(prompt.includes("modified\tdesktop/src/App.tsx"));
  assert.ok(prompt.includes("ahead of upstream: 2"));
});

test("a clean tree still describes itself", () => {
  assert.ok(stepsPrompt({ ...emptyWorkState, project: "emma" }).includes("(the working tree is clean)"));
});

test("no model and no key means no call", async () => {
  let called = false;
  const ask = async () => { called = true; return ""; };
  assert.deepEqual(await suggestNextSteps(dirty, { ...free, model: "" }, ask), []);
  assert.equal(called, false);
  assert.deepEqual(await suggestNextSteps(dirty, { ...free, credentialEnv: "EMMA_KEY_THAT_IS_NOT_SET" }, ask), []);
  assert.equal(called, false);
});

test("a model that fails or rambles leaves the caller with nothing", async () => {
  assert.deepEqual(await suggestNextSteps(dirty, free, async () => { throw new Error("no route"); }), []);
  assert.deepEqual(await suggestNextSteps(dirty, free, async () => "sure, try harder"), []);
});

test("a good model answer is passed through", async () => {
  const steps = await suggestNextSteps(dirty, free, async () => reply([
    { title: "Commit the tree", detail: "a", prompt: "commit" },
    { title: "Open the PR", detail: "b", prompt: "draft it" },
    { title: "Update the docs", detail: "c", prompt: "check them" },
  ]));
  assert.deepEqual(steps.map((step) => step.title), ["Commit the tree", "Open the PR", "Update the docs"]);
});

test("the fallback reads the working tree", () => {
  const steps = defaultSteps(dirty);
  assert.ok(steps.length >= 3 && steps.length <= 5);
  assert.equal(steps[0].title, "Commit 2 changed files");
  assert.equal(steps[1].title, "Review App.tsx");
  assert.ok(steps.some((step) => step.title.includes("pull request")));
  assert.ok(steps.every((step) => step.prompt.trim()));
});

test("the fallback still fills three tiles with nothing to go on", () => {
  const steps = defaultSteps(emptyWorkState);
  assert.equal(steps.length, 3);
  assert.ok(steps.every((step) => step.title && step.prompt));
});

test("one changed file reads as one file", () => {
  const steps = defaultSteps({ ...emptyWorkState, files: [{ path: "a.ts", state: "modified" }] });
  assert.equal(steps[0].title, "Commit 1 changed file");
});

test("the ipc boundary clamps whatever the renderer sends", () => {
  const state = validateWorkState({
    project: "  emma\n",
    branch: "dev",
    ahead: -4,
    behind: 1.5,
    files: [{ path: "a.ts", state: "modified" }, { path: "", state: "modified" }, ...Array.from({ length: 80 }, () => ({ path: "b.ts", state: "new" }))],
    largest: { path: "a.ts", added: 3, removed: "many" },
    threads: ["one", 7, "two"],
  });
  assert.equal(state.project, "emma");
  assert.equal(state.ahead, 0);
  assert.equal(state.behind, 0);
  assert.equal(state.files.length, 39);
  assert.deepEqual(state.largest, { path: "a.ts", added: 3, removed: 0 });
  assert.deepEqual(state.threads, ["one", "two"]);
  assert.throws(() => validateWorkState("nope"));
});
