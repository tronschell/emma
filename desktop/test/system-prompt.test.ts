import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImprovements, setSystemPrompt, withTrialArm, writeHarnessPrompt } from "../main/system-prompt";
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

test("the harness gets the same block as its global instructions file", () => {
  const home = mkdtempSync(path.join(tmpdir(), "emma-harness-"));
  setSystemPrompt("Answer in French.");
  writeHarnessPrompt(home);
  assert.match(readFileSync(path.join(home, ".fx", "AGENTS.md"), "utf8"), /Answer in French\./);
  setSystemPrompt("");
  writeHarnessPrompt(home);
  assert.equal(readFileSync(path.join(home, ".fx", "AGENTS.md"), "utf8"), "");
});

test("an over-long prompt is refused on the way in, and a missing one falls back to the default", () => {
  const settings = { ...defaultSettings, systemPrompt: "x".repeat(MAX_SYSTEM_PROMPT_CHARS + 1) };
  assert.throws(() => validateSettings(settings));
  assert.equal(validateSettings({ ...defaultSettings, systemPrompt: undefined }).systemPrompt, "");
  assert.throws(() => validateOverlayPreferences({ notchGap: 180, cursorOrbsEnabled: true, systemPrompt: "x".repeat(MAX_SYSTEM_PROMPT_CHARS + 1) }));
  assert.equal(validateOverlayPreferences({ notchGap: 180, cursorOrbsEnabled: true }).systemPrompt, undefined);
  assert.equal(validateOverlayPreferences({ notchGap: 180, cursorOrbsEnabled: true, systemPrompt: "Answer in French." }).systemPrompt, "Answer in French.");
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
