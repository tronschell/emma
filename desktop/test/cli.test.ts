import test from "node:test";
import assert from "node:assert/strict";
import { CLI_HARNESSES, cliHarness, describeRuns, terminalText, type CliRun } from "../shared/cli";
import { CLI_PLANS, cliPlan } from "../shared/settings";
import { shellArguments } from "../main/platform";
import { signedIn } from "../main/cli";
import { parseToolArgs, toolDefinitions } from "../main/tools";
import { toolGate } from "../shared/permissions";

test("terminal text drops escapes and lets a rewritten line win", () => {
  assert.equal(terminalText("\u001B[32mdone\u001B[0m"), "done");
  assert.equal(terminalText("\u001B]0;title\u0007ok"), "ok");
  assert.equal(terminalText("working /\rworking -\rworking \\"), "working \\");
  assert.equal(terminalText("abcdef\rXY"), "XYcdef");
  assert.equal(terminalText("one\ntwo"), "one\ntwo");
});

test("every harness builds a start and a resume argv carrying the prompt", () => {
  for (const harness of CLI_HARNESSES) {
    const session = "11111111-2222-3333-4444-555555555555";
    for (const argv of [harness.start("fix the parser", session), harness.resume("and the tests", session)]) {
      assert.ok(argv.length > 0, `${harness.id} built an empty argv`);
      assert.ok(argv.some((part) => part.includes("the")), `${harness.id} dropped the prompt`);
      assert.ok(argv.includes("fix the parser") || argv.includes("and the tests"), `${harness.id} split the prompt`);
    }
    if (harness.ownsSession) assert.ok(harness.resume("x", session).includes(session), `${harness.id} ignores its session id`);
  }
  assert.equal(cliHarness("nope"), undefined);
});

test("the cli tool refuses a call that would spawn nothing useful", () => {
  assert.throws(() => parseToolArgs("cli", JSON.stringify({ cli: "claude" })), /prompt/);
  assert.throws(() => parseToolArgs("cli", JSON.stringify({ prompt: "go" })), /cli.*required/);
  assert.throws(() => parseToolArgs("cli", JSON.stringify({ cli: "emacs", prompt: "go" })), /does not know/);
  assert.throws(() => parseToolArgs("cli", JSON.stringify({ action: "send", prompt: "go" })), /id.*required/);
  assert.throws(() => parseToolArgs("cli", JSON.stringify({ action: "detonate", cli: "pi", prompt: "go" })), /action must be/);
  assert.deepEqual(parseToolArgs("cli", JSON.stringify({ cli: "codex", prompt: "go", unattended: true })), {
    name: "cli", action: "run", cli: "codex", id: undefined, prompt: "go", unattended: true, folder: undefined,
  });
  assert.deepEqual(parseToolArgs("cli_runs", JSON.stringify({ id: "cli1", stop: true })), { name: "cli_runs", id: "cli1", stop: true });
});

test("starting a CLI stops to ask; watching one does not", () => {
  assert.equal(toolGate("ask", "cli"), "ask");
  assert.equal(toolGate("acceptEdits", "cli"), "ask");
  assert.equal(toolGate("full", "cli"), "auto");
  assert.equal(toolGate("ask", "cli_runs"), "auto");
  const names = toolDefinitions("ask", { folders: true, computer: false }).map((tool) => tool.name);
  assert.ok(names.includes("cli") && names.includes("cli_runs"));
  assert.ok(!toolDefinitions("ask", { folders: false, computer: false }).map((tool) => tool.name).includes("cli"));
});

test("the run list reads as one line each", () => {
  const run: CliRun = {
    id: "cli1", cli: "codex", threadId: "t1", title: "fix the parser", cwd: "/tmp/p", folder: "p",
    status: "idle", exitCode: 0, turns: 2, startedAt: 0, turnStartedAt: 0, unattended: false,
  };
  assert.equal(describeRuns([]), "No CLI runs have been started in this session.");
  assert.match(describeRuns([run]), /cli1 {2}codex {2}idle {2}2 turns {2}p {2}fix the parser/);
});

test("a plan sign-in runs the vendor's own command and nothing the renderer names", () => {
  assert.equal(cliPlan("opencode"), undefined);
  assert.equal(cliPlan("codex; rm -rf ~"), undefined);
  assert.equal(cliPlan("codex")?.signIn, "codex login");
  for (const plan of CLI_PLANS) {
    assert.doesNotMatch(plan.signIn, /[;&|<>$`(){}[\]*?~#\n]/);
    assert.ok(shellArguments(plan.signIn).at(-1)?.split("\n").includes(plan.signIn));
    assert.doesNotMatch(plan.authFile, /^[/~]|\.\./);
  }
});

test("only a plan CLI reports a sign-in, and it never asks for the secret itself", async () => {
  assert.equal(await signedIn("opencode"), undefined);
  assert.equal(await signedIn("cursor"), undefined);
  assert.equal(typeof await signedIn("codex"), "boolean");
});
