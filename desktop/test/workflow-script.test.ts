import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runWorkflowScript, workflowScriptPath } from "../main/workflow-script";

test("a workflow script reads stdin and stays inside a connected folder", async (context) => {
  const base = await mkdtemp(path.join(tmpdir(), "emma-workflow-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const connected = path.join(base, "connected");
  const outside = path.join(base, "outside.sh");
  const script = path.join(connected, "calculate.sh");
  await mkdir(connected);
  await writeFile(script, "#!/bin/sh\ninput=$(cat)\nprintf 'calculated:%s' \"$input\"\n");
  await writeFile(outside, "#!/bin/sh\nprintf outside\n");
  assert.equal(await runWorkflowScript(script, "4,9", [connected]), "calculated:4,9");
  await assert.rejects(() => workflowScriptPath(outside, [connected]), /inside a connected folder/);
  const link = path.join(connected, "escape.sh");
  await symlink(outside, link);
  await assert.rejects(() => workflowScriptPath(link, [connected]), /inside a connected folder/);
});
