import test from "node:test";
import assert from "node:assert/strict";
import { CLI_HARNESSES, cliHarness, describeRuns, tailLines, terminalText, type CliRun } from "../shared/cli";
import { parseToolArgs, toolDefinitions } from "../main/tools";
import { toolGate } from "../shared/permissions";

test("terminal text drops escapes and lets a rewritten line win", () => {
  assert.equal(terminalText("\u001B[32mdone\u001B[0m"), "done");
  assert.equal(terminalText("\u001B]0;title\u0007ok"), "ok");
  // A spinner rewrites its own line; only the last write is on screen.
  assert.equal(terminalText("working /\rworking -\rworking \\"), "working \\");
  // A short rewrite does not erase what it did not cover — real terminal behaviour.
  assert.equal(terminalText("abcdef\rXY"), "XYcdef");
  assert.equal(terminalText("one\ntwo"), "one\ntwo");
  assert.equal(tailLines("a\nb\nc\nd\n\n", 2), "c\nd");
});

test("every harness builds a start and a resume argv carrying the prompt", () => {
  for (const harness of CLI_HARNESSES) {
    const session = "11111111-2222-3333-4444-555555555555";
    for (const argv of [harness.start("fix the parser", session), harness.resume("and the tests", session)]) {
      assert.ok(argv.length > 0, `${harness.id} built an empty argv`);
      assert.ok(argv.some((part) => part.includes("the")), `${harness.id} dropped the prompt`);
      // The prompt is its own argv entry, never spliced into a flag: that is what
      // keeps a prompt containing a space or a quote from becoming arguments.
      assert.ok(argv.includes("fix the parser") || argv.includes("and the tests"), `${harness.id} split the prompt`);
    }
    // A CLI claiming to own the session must actually put the id on the line.
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

test("starting a CLI is gated like bash; watching one is not", () => {
  assert.equal(toolGate("plan", "cli"), "hidden");
  assert.equal(toolGate("ask", "cli"), "ask");
  // The one that matters: accepting edits must not silently accept another agent.
  assert.equal(toolGate("acceptEdits", "cli"), "ask");
  assert.equal(toolGate("full", "cli"), "auto");
  assert.equal(toolGate("plan", "cli_runs"), "auto");
  const names = toolDefinitions("ask", { folders: true, computer: false, mcp: false, canSpawn: true }).map((tool) => tool.name);
  assert.ok(names.includes("cli") && names.includes("cli_runs"));
  // No folder, nothing to run in — so it is not advertised at all.
  assert.ok(!toolDefinitions("ask", { folders: false, computer: false, mcp: false, canSpawn: true }).map((tool) => tool.name).includes("cli"));
});

test("the run list reads as one line each", () => {
  const run: CliRun = {
    id: "cli1", cli: "codex", threadId: "t1", title: "fix the parser", cwd: "/tmp/p", folder: "p",
    status: "idle", exitCode: 0, turns: 2, startedAt: 0, turnStartedAt: 0, unattended: false,
  };
  assert.equal(describeRuns([]), "No CLI runs have been started in this session.");
  assert.match(describeRuns([run]), /cli1 {2}codex {2}idle {2}2 turns {2}p {2}fix the parser/);
});
