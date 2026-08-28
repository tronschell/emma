import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { forceArm, setImprovements, setPrompts, setSystemPrompt, takeArm, turnArm, withTrialArm, writeHarnessPrompt } from "../main/system-prompt";
import { DEFAULT_SYSTEM_PROMPT, familiesOf, forkPreset, promptSegments, resolvePrompt, validatePrompts, type PromptPreset } from "../shared/prompts";
import { assertCatalog, CONNECTIONS, describeConnections, detectConnections, outdatedConnections, setUpConnection } from "../main/connections";
import { defaultSettings, MAX_CONNECTIONS, MAX_SYSTEM_PROMPT_CHARS, validateConnections, validateOverlayPreferences, validateSettings } from "../shared/settings";

const turn = { threadId: "thread-1", content: "Hi", mode: "ask", title: "This thread" } as const;

test("only the change on trial rides the turn, and only on the half that drew it", () => {
  // Nothing on trial: every turn goes out exactly as it came in, because the
  // standing instructions reach the harness through its own file.
  setImprovements({ kept: { instructions: "Answer in French.", verifier: "" } });
  assert.equal(withTrialArm({ ...turn }).params, undefined);

  setImprovements({ kept: { instructions: "", verifier: "" }, trial: { lever: "instructions", addition: "Cite the file you read it in." } });
  // One turn lands on one arm, so this is read across enough of them to see both.
  const carried = Array.from({ length: 40 }, (_value, index) => withTrialArm({ ...turn, threadId: `thread-${index}`, params: { skillContext: "Follow the review procedure." } }));
  const b = carried.filter((sent) => /Cite the file you read it in\./.test(sent.params!.skillContext));
  assert.ok(b.length > 0 && b.length < carried.length, `every turn landed on the same arm (${b.length} of ${carried.length})`);
  // The attached skill is still there underneath it, whichever way the turn landed.
  assert.ok(carried.every((sent) => /Follow the review procedure\./.test(sent.params!.skillContext)));
  setImprovements({ kept: { instructions: "", verifier: "" } });
});

test("a pinned arm decides the turn it was pinned for, and no turn after it", () => {
  setImprovements({ kept: { instructions: "", verifier: "" } });
  assert.equal(turnArm("bench-1"), "");
  forceArm("bench-1", "b");
  assert.equal(turnArm("bench-1"), "b");
  assert.equal(turnArm("bench-1"), "");

  setImprovements({ kept: { instructions: "", verifier: "" }, trial: { lever: "instructions", addition: "Cite the file you read it in." } });
  forceArm("bench-2", "a");
  assert.equal(withTrialArm({ ...turn, threadId: "bench-2" }).params, undefined);
  forceArm("bench-3", "b");
  assert.match(withTrialArm({ ...turn, threadId: "bench-3" }).params!.skillContext, /Cite the file you read it in\./);

  forceArm("bench-4", "b");
  assert.equal(turnArm("bench-4"), "b");
  const after = Array.from({ length: 40 }, () => turnArm("bench-4"));
  assert.ok(after.includes("a") && after.includes("b"), `the pin outlived its turn (${after.join("")})`);
  setImprovements({ kept: { instructions: "", verifier: "" } });
});

const later = <T>(read: () => T): T => {
  const clock = Date.now;
  Date.now = () => clock() + 10 * 60_000;
  try { return read(); } finally { Date.now = clock; }
};

test("a pin whose turn never came goes stale, and the turn that finds it runs as if it had never been made", () => {
  setImprovements({ kept: { instructions: "", verifier: "" } });
  forceArm("stale-1", "b");
  assert.equal(later(() => turnArm("stale-1")), "");

  setImprovements({ kept: { instructions: "", verifier: "" }, trial: { lever: "instructions", addition: "Cite the file you read it in." } });
  for (let index = 0; index < 40; index += 1) forceArm(`stale-b-${index}`, "b");
  const drawn = later(() => Array.from({ length: 40 }, (_value, index) => turnArm(`stale-b-${index}`)));
  assert.ok(drawn.includes("a") && drawn.includes("b"), `a stale pin still decided the turn (${drawn.join("")})`);

  forceArm("fresh-1", "b");
  assert.equal(turnArm("fresh-1"), "b");
  const after = Array.from({ length: 40 }, () => turnArm("fresh-1"));
  assert.ok(after.includes("a") && after.includes("b"), `the pin outlived its turn (${after.join("")})`);
  setImprovements({ kept: { instructions: "", verifier: "" } });
});

test("the arm map fills with subagents without ever evicting the turn still running", () => {
  setImprovements({ kept: { instructions: "", verifier: "" }, trial: { lever: "instructions", addition: "Cite the file you read it in." } });
  forceArm("root-1", "b");
  assert.equal(turnArm("root-1"), "b");
  const spawned = Array.from({ length: 200 }, (_value, index) => turnArm(`sub-${index}`, "root-1"));
  assert.ok(spawned.every((arm) => arm === "b"), `${spawned.filter((arm) => arm !== "b").length} of ${spawned.length} subagents flipped their own coin`);
  assert.equal(takeArm("root-1"), "b");
  setImprovements({ kept: { instructions: "", verifier: "" } });
});

test("the Settings prompt is the harness's own prompt, not a note under it", () => {
  const home = mkdtempSync(path.join(tmpdir(), "emma-harness-"));
  setSystemPrompt("Answer in French.");
  writeHarnessPrompt(home);
  assert.match(readFileSync(path.join(home, ".fx", "system-prompt.md"), "utf8"), /Answer in French\./);
  assert.equal(readFileSync(path.join(home, ".fx", "AGENTS.md"), "utf8"), "");
  setSystemPrompt("");
  writeHarnessPrompt(home);
  assert.equal(readFileSync(path.join(home, ".fx", "system-prompt.md"), "utf8"), "");
});

test("a conditional prompt reaches the harness only on the models it names", () => {
  const home = mkdtempSync(path.join(tmpdir(), "emma-harness-scope-"));
  const read = () => readFileSync(path.join(home, ".fx", "system-prompt.md"), "utf8");
  setSystemPrompt("Answer in French.");
  setPrompts([
    { id: "opus", name: "Opus", body: "Plan before you edit.", scope: "family:opus", enabled: true },
    { id: "one", name: "One model", body: "Keep it terse.", scope: "model:openrouter:deepseek/deepseek-chat", enabled: true },
    { id: "off", name: "Off", body: "Never sent.", scope: "", enabled: false },
  ]);
  writeHarnessPrompt(home, { model: "anthropic/claude-opus-4.5" });
  assert.match(read(), /Answer in French\.[\s\S]*Plan before you edit\./);
  assert.doesNotMatch(read(), /Keep it terse\.|Never sent\./);
  writeHarnessPrompt(home, { model: "deepseek/deepseek-chat" });
  assert.match(read(), /Keep it terse\./);
  assert.doesNotMatch(read(), /Plan before you edit\./);
  // Nothing matches, so the global text is the whole of it.
  writeHarnessPrompt(home, { model: "meta-llama/llama-4" });
  assert.equal(read().trim(), "Answer in French.");
  setPrompts([]);
  setSystemPrompt("");
});

test("the variables a prompt writes are filled from the turn, and unknown braces are left alone", () => {
  const home = mkdtempSync(path.join(tmpdir(), "emma-harness-vars-"));
  setSystemPrompt("Model {model}, family {model_family}, in {workspace} on {mode}. Tools: {available_tools}. Left {alone}.");
  writeHarnessPrompt(home, { model: "anthropic/claude-sonnet-4.5", workspace: "/tmp/work", mode: "ask" });
  const written = readFileSync(path.join(home, ".fx", "system-prompt.md"), "utf8");
  assert.match(written, /Model anthropic\/claude-sonnet-4\.5, family Sonnet, in \/tmp\/work on ask\./);
  assert.match(written, /Tools: [a-z_]+(, [a-z_]+)+\./);
  assert.match(written, /Left \{alone\}\./);
  writeHarnessPrompt(home, { model: "openrouter:deepseek/deepseek-chat", workspace: "/tmp/work", mode: "ask" });
  assert.match(readFileSync(path.join(home, ".fx", "system-prompt.md"), "utf8"), /Model deepseek\/deepseek-chat,/);
  setSystemPrompt("");
});

test("a family is read off the model id, whatever route names it", () => {
  assert.deepEqual(familiesOf("openrouter:anthropic/claude-opus-4.5"), ["opus"]);
  assert.deepEqual(familiesOf("local:qwen3-coder"), ["qwen"]);
  assert.deepEqual(familiesOf("deepseek/deepseek-r1"), ["deepseek"]);
  assert.deepEqual(familiesOf("some/unknown-model"), []);
});

test("the narrower prompt is read last, so it wins where the two disagree", () => {
  const presets: PromptPreset[] = [
    { id: "pinned", name: "Pinned", body: "third", scope: "model:anthropic/claude-opus-4.5", enabled: true },
    { id: "every", name: "Every", body: "second", scope: "", enabled: true },
    { id: "family", name: "Family", body: "middle", scope: "family:opus", enabled: true },
  ];
  assert.equal(resolvePrompt("first", presets, "anthropic/claude-opus-4.5"), "first\n\nsecond\n\nmiddle\n\nthird");
});

test("a fork copies the body and lands switched off, so it cannot change a turn by being made", () => {
  const preset: PromptPreset = { id: "src", name: "Opus", body: "Plan first.", scope: "family:opus", enabled: true };
  const fork = forkPreset(preset, "copy1");
  assert.deepEqual(fork, { id: "copy1", name: "Opus copy", body: "Plan first.", scope: "family:opus", enabled: false });
});

test("a variable is painted, a brace Emma cannot fill is not", () => {
  const segments = promptSegments("use {model} not {nope}");
  assert.deepEqual(segments.map((segment) => segment.text), ["use ", "{model}", " not ", "{nope}"]);
  assert.equal(typeof segments[1].hue, "number");
  assert.equal(segments[3].unknown, true);
});

test("a corrupt prompt list is refused rather than half-loaded", () => {
  assert.deepEqual(validatePrompts(undefined, 100), []);
  assert.equal(validatePrompts([{ id: "abc", name: " Named ", body: "x" }], 100)[0].name, "Named");
  // Missing means on: a prompt written before this field existed still rides.
  assert.equal(validatePrompts([{ id: "abc", name: "Named", body: "x" }], 100)[0].enabled, true);
  assert.throws(() => validatePrompts([{ id: "abc", name: "A", body: "x" }, { id: "abc", name: "B", body: "y" }], 100));
  assert.throws(() => validatePrompts([{ id: "abc", name: "A", body: "x".repeat(101) }], 100));
  assert.throws(() => validatePrompts([{ id: "abc", name: "A", body: "x", scope: "family:nope" }], 100));
  assert.throws(() => validatePrompts([{ id: "abc", name: "A", body: "x", scope: "whatever" }], 100));
  assert.throws(() => validatePrompts([{ id: "abc", name: "", body: "x" }], 100));
});

test("an over-long prompt is refused on the way in, and a missing one falls back to the default", () => {
  const settings = { ...defaultSettings, systemPrompt: "x".repeat(MAX_SYSTEM_PROMPT_CHARS + 1) };
  assert.throws(() => validateSettings(settings));
  assert.equal(validateSettings({ ...defaultSettings, systemPrompt: undefined }).systemPrompt, DEFAULT_SYSTEM_PROMPT);
  // A store written while this field was an addition holds "", which is not a choice to keep.
  assert.equal(validateSettings({ ...defaultSettings, systemPrompt: "" }).systemPrompt, DEFAULT_SYSTEM_PROMPT);
  assert.throws(() => validateOverlayPreferences({ notchGap: 180, cursorOrbsEnabled: true, systemPrompt: "x".repeat(MAX_SYSTEM_PROMPT_CHARS + 1) }));
  assert.equal(validateOverlayPreferences({ notchGap: 180, cursorOrbsEnabled: true }).systemPrompt, undefined);
  assert.equal(validateOverlayPreferences({ notchGap: 180, cursorOrbsEnabled: true, systemPrompt: "Answer in French." }).systemPrompt, "Answer in French.");
  // The conditional prompts ride the same message, so they are held to the same validation.
  const carried = validateOverlayPreferences({ notchGap: 180, cursorOrbsEnabled: true, prompts: [{ id: "abc", name: "Opus", body: "Plan first.", scope: "family:opus", enabled: true }] });
  assert.deepEqual(carried.prompts, [{ id: "abc", name: "Opus", body: "Plan first.", scope: "family:opus", enabled: true }]);
  assert.equal(validateOverlayPreferences({ notchGap: 180, cursorOrbsEnabled: true }).prompts, undefined);
  assert.throws(() => validateOverlayPreferences({ notchGap: 180, cursorOrbsEnabled: true, prompts: [{ id: "abc", name: "Opus", body: "x", scope: "family:nope" }] }));
});

test("every catalogued connection is a bare name, so the probe never needs quoting", () => {
  assert.doesNotThrow(() => assertCatalog());
  assert.throws(() => assertCatalog([{ id: "bad", label: "Bad", binaries: ["rm -rf /; echo"], detail: "", formula: "bad" }]));
  // Install and update interpolate the formula into a brew command, so it is held to the same standard.
  assert.throws(() => assertCatalog([{ id: "bad", label: "Bad", binaries: ["bad"], detail: "", formula: "gh; rm -rf /" }]));
});

test("only connections that are both switched on and installed reach the agent", () => {
  const detected = [
    { id: "obsidian", label: "Obsidian", detail: "Notes.", formula: "yakitrak/yakitrak/obsidian-cli", binary: "obsidian-cli" },
    { id: "github", label: "GitHub", detail: "Issues.", formula: "gh", binary: "" },
  ];
  assert.equal(describeConnections(detected, []), "");
  // Switched on but missing from this Mac: says nothing rather than sending the agent after a binary that is not there.
  assert.equal(describeConnections(detected, ["github"]), "");
  const block = describeConnections(detected, ["obsidian", "github"]);
  assert.match(block, /Obsidian — `obsidian-cli`/);
  assert.doesNotMatch(block, /GitHub/);
});

test("the catalog is probed with one shell, and unknown or repeated ids never persist", async () => {
  const detected = await detectConnections();
  assert.equal(detected.length, CONNECTIONS.length);
  // /bin/bash is always installed, so probing for it proves the probe finds what is there.
  assert.equal((await detectConnections([{ id: "shell", label: "Shell", binaries: ["bash"], detail: "", formula: "bash" }]))[0].binary, "bash");
  assert.deepEqual(validateConnections(undefined), []);
  assert.deepEqual(validateConnections(["obsidian"]), ["obsidian"]);
  assert.throws(() => validateConnections(["obsidian", "obsidian"]));
  assert.throws(() => validateConnections(["Obsidian"]));
  assert.throws(() => validateConnections(Array.from({ length: MAX_CONNECTIONS + 1 }, (_value, index) => `tool-${index}`)));
});

test("the update check reads brew's list, and setup only runs a catalogued formula", async () => {
  // `brew outdated` names core formulae bare and tapped ones in full, so an id is
  // matched on the last segment either way. Whatever this Mac has, the answer is
  // a subset of the catalog and never anything else.
  const stale = await outdatedConnections();
  assert.ok(stale.every((id) => CONNECTIONS.some((entry) => entry.id === id)));
  await assert.rejects(() => setUpConnection("not-in-the-catalog", "install"), /Unknown connection/);
});
