import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_HARNESSES, cliHarness, cliOptions, validateCliOptions } from "../shared/cli";
import { CliRuns } from "../main/cli";
import { codexEfforts, modelTableIds } from "../main/cli-models";
import { parseToolArgs } from "../main/tools";
import { NO_MULTILINE_PROMPT, writeFakeCli } from "./fake-cli";

test("harnesses pass native model and effort flags on first and follow-up turns", () => {
  for (const [id, flag, effort] of [["claude", "--effort", "max"], ["codex", "--config", "max"], ["pi", "--thinking", "xhigh"], ["opencode", "--variant", "custom-deep"], ["antigravity", "--effort", "high"]]) {
    const harness = cliHarness(id!)!;
    for (const build of [harness.start, harness.resume]) {
      const argv = build("build it", "session", "exact-model", effort);
      assert.equal(argv[argv.indexOf("--model") + 1], "exact-model");
      assert.equal(argv[argv.indexOf(flag!) + 1], id === "codex" ? 'model_reasoning_effort="max"' : effort);
      assert.equal(argv.at(-1), "build it");
      assert.ok(!argv.includes(harness.unattended[0] ?? "missing"));
    }
  }
  assert.ok(cliHarness("codex")!.resume("continue", "session").indexOf("--color") < cliHarness("codex")!.resume("continue", "session").indexOf("resume"));
  assert.equal(cliHarness("antigravity")?.bin, "agy");
  for (const harness of CLI_HARNESSES) assert.ok(harness.start("go", "session", "exact-model").includes("exact-model"));
});

test("tool options preserve exact selections, explicit resets, and reject malformed or unsupported choices", () => {
  const args = parseToolArgs("cli", JSON.stringify({ cli: "codex", model: "gpt-5.6-luna", effort: "max", prompt: "Implement", fromRuns: ["cli1"] }));
  assert.equal(args.name, "cli");
  assert.deepEqual(cliOptions(args), { model: "gpt-5.6-luna", effort: "max" });
  assert.deepEqual(cliOptions({}), {});
  assert.deepEqual(cliOptions({ model: "", effort: "" }), { model: "", effort: "" });
  for (const model of [null, 2, "--dangerously-skip-permissions", "x\n--evil", "x\0", "$(touch /tmp/no)", "x".repeat(257)]) assert.throws(() => cliOptions({ model }), /Invalid harness model/);
  assert.throws(() => validateCliOptions("antigravity", { effort: "max" }), /does not support/);
  assert.throws(() => validateCliOptions("gemini", { effort: "high" }), /does not support/);
  assert.throws(() => validateCliOptions("cursor", { effort: "high" }), /does not support/);
  assert.deepEqual(validateCliOptions("opencode", { effort: "my-deep-variant" }), { effort: "my-deep-variant" });
  assert.deepEqual(parseToolArgs("cli_runs", '{"cli":"codex","refresh":true}'), { name: "cli_runs", id: undefined, stop: false, cli: "codex", refresh: true });
  assert.throws(() => parseToolArgs("cli_runs", '{"cli":"codex","id":"cli1"}'), /not both/);
  assert.deepEqual(codexEfforts({ models: [{ slug: "luna", supported_reasoning_levels: [{ effort: "high" }, { effort: "max" }] }] }), { luna: ["high", "max"] });
  assert.deepEqual(codexEfforts({ models: [null, { slug: "no-thinking", supported_reasoning_levels: [null] }] }), { "no-thinking": [] });
  assert.deepEqual(modelTableIds("Model  Name\nclaude-sonnet-4-6  Claude Sonnet\ngemini-3.8-flash-high   Gemini\n"), ["claude-sonnet-4-6", "gemini-3.8-flash-high"]);
});

test("a harness chain keeps independent model and effort selections across resume and resets", { skip: NO_MULTILINE_PROMPT }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "emma-cli-options-"));
  const binary = await writeFakeCli(directory, `process.stdout.write(JSON.stringify({args:process.argv.slice(2),effort:process.env.CLAUDE_CODE_EFFORT_LEVEL}));\n`);
  const runs = new CliRuns(() => undefined);
  const paths = Reflect.get(runs, "paths") as Map<string, string>;
  for (const harness of CLI_HARNESSES) paths.set(harness.bin, binary);
  try {
    const a = await runs.start({ threadId: "t", cli: "claude", cwd: directory, folder: "fixture", unattended: false, prompt: "Plan", model: "sonnet", effort: "high" });
    assert.match(runs.output(a.id, 32768)!.result, /"effort":"high"/);
    const b = await runs.start({ threadId: "t", cli: "codex", cwd: directory, folder: "fixture", unattended: false, prompt: "Build", model: "gpt-5.6-luna", effort: "max", fromRuns: [a.id] });
    assert.equal(b.model, "gpt-5.6-luna");
    assert.equal(b.effort, "max");
    assert.equal(b.inputs?.[0]?.id, a.id);
    const followup = await runs.send(b.id, "Finish");
    assert.equal(followup.effort, "max");
    const argv = JSON.parse(runs.output(b.id, 32768)!.result).args as string[];
    assert.ok(argv.includes('model_reasoning_effort="max"'));
    assert.ok(argv.includes("gpt-5.6-luna"));
    await runs.send(b.id, "Reset", undefined, { model: "", effort: "" });
    assert.equal(runs.get(b.id)?.model, undefined);
    assert.equal(runs.get(b.id)?.effort, undefined);
    assert.ok(!(JSON.parse(runs.output(b.id, 32768)!.result).args as string[]).includes("--model"));
    await assert.rejects(runs.setOptions(a.id, { effort: "ultra" }), /does not support/);
    assert.equal(runs.get(a.id)?.effort, "high");
    await runs.setOptions(a.id, { model: "haiku", effort: "low" });
    assert.equal(runs.get(a.id)?.model, "haiku");
    const working = runs.send(a.id, "Again");
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (runs.get(a.id)?.status === "running") await assert.rejects(runs.setOptions(a.id, { effort: "max" }), /Wait for this turn/);
    await working;
  } finally {
    await runs.stopAll();
    await rm(directory, { recursive: true, force: true });
  }
});
