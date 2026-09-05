import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliRuns } from "../main/cli";
import { cliInputIds } from "../shared/cli";
import { parseToolArgs } from "../main/tools";
import { writeFakeCli } from "./fake-cli";

test("CLI handoffs validate sources and pass only the latest stdout through a chain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "emma-cli-chain-"));
  const binary = await writeFakeCli(directory, `const prompt = process.argv.at(-1);\nprocess.stderr.write('diagnostic-only\\n');\nif (prompt === 'fail') process.exit(2);\nprocess.stdout.write(prompt === 'large' ? 'x'.repeat(270000) : 'Result: ' + prompt);\n`);
  const runs = new CliRuns(() => undefined);
  const paths = Reflect.get(runs, "paths") as Map<string, string>;
  for (const bin of ["claude", "codex", "pi"]) paths.set(bin, binary);
  const start = (cli: string, prompt: string, fromRuns?: string[], threadId = "t1") => runs.start({ cli, prompt, fromRuns, threadId, cwd: directory, folder: "fixture", unattended: false });
  try {
    const a = await start("claude", "first draft");
    await runs.send(a.id, "revised draft");
    const b = await start("codex", "review", [a.id]);
    const output = runs.output(b.id, 32768)!;
    assert.match(output.result, /revised draft/);
    assert.doesNotMatch(output.result, /first draft|diagnostic-only|\[exit|\$ /);
    assert.deepEqual(b.inputs, [{ id: a.id, cli: "claude", turn: 2 }]);
    const c = await start("pi", "combine", [a.id, b.id]);
    assert.equal(c.inputs?.length, 2);
    assert.match(runs.output(c.id, 32768)!.result, /Source: codex/);
    await assert.rejects(start("pi", "wrong thread", [a.id], "t2"), /not available in this thread/);
    await assert.rejects(runs.send(a.id, "self", [a.id]), /own output/);
    const failed = await start("pi", "fail");
    assert.equal(failed.status, "failed");
    await assert.rejects(start("pi", "review", [failed.id]), /finish successfully/);
    const large = await start("pi", "large");
    assert.equal(runs.output(large.id, 32768)?.resultTruncated, true);
    await assert.rejects(start("pi", "review", [large.id]), /capture limit/);
    await assert.rejects(start("pi", "-bad"), /not a flag/);
    await assert.rejects(start("pi", "x".repeat(33000)), /too large/);
    await start("codex", "new session");
    await assert.rejects(runs.send(b.id, "old session"), /newest run/);
    const running = start("pi", "one");
    await assert.rejects(start("claude", "two"), /Another harness/);
    await running;
    assert.deepEqual(cliInputIds([a.id, a.id]), [a.id]);
    for (const value of ["cli1", [1], ["bad"], ["cli" + "1".repeat(65)], Array(9).fill("cli1")]) assert.throws(() => cliInputIds(value), /fromRuns/);
    assert.deepEqual(parseToolArgs("cli", JSON.stringify({ cli: "pi", prompt: "combine", fromRuns: [a.id, b.id] })).name, "cli");
    assert.throws(() => parseToolArgs("cli", JSON.stringify({ cli: "pi", prompt: "combine", fromRuns: [3] })), /fromRuns/);
  } finally {
    await runs.stopAll();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a harness reached through a Windows shim receives a multi-line prompt intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "emma-cli-multiline-"));
  const binary = await writeFakeCli(directory, "process.stdout.write(process.argv.at(-1));\n");
  const runs = new CliRuns(() => undefined);
  (Reflect.get(runs, "paths") as Map<string, string>).set("claude", binary);
  try {
    const run = await runs.start({ threadId: "t1", cli: "claude", prompt: "first line\nsecond line", cwd: directory, folder: "fixture", unattended: false });
    assert.equal(run.status, "idle");
    assert.equal(runs.output(run.id, 32768)!.result, "first line\nsecond line");
  } finally {
    await runs.stopAll();
    await rm(directory, { recursive: true, force: true });
  }
});
