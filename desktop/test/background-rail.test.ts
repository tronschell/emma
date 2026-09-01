import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { BackgroundTask } from "../shared/agents";

const source = ts.createSourceFile("agents.tsx", readFileSync(path.resolve(__dirname, "../../src/agents.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const rail = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "BackgroundRail");
assert.ok(rail);
let polling: ts.CallExpression | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.arguments[0].getText(source).includes("readBackground")) polling = node;
  ts.forEachChild(node, visit);
}
visit(rail);
assert.ok(polling);
assert.equal(polling.arguments[1].getText(source), "[open]");
const setupCode = ts.transpile(`const setup = ${polling.arguments[0].getText(source)}; return setup;`, { target: ts.ScriptTarget.ES2022 });

type Reading = { task: BackgroundTask; output: string } | null;
type Timer = { callback: () => void; cleared: boolean };

const task = (status: BackgroundTask["status"]): BackgroundTask => ({ id: "bg1", command: "echo ready", folder: "test", status, exitCode: status === "exited" ? 0 : null, startedAt: 1 });

test("background rail makes its final read and stops after exit", async () => {
  const exercise = async (readings: Reading[]) => {
    const outputs: string[] = [];
    const ids: string[] = [];
    const timers: Timer[] = [];
    let clears = 0;
    const environment = {
      open: "bg1",
      setOutput: (value: string) => outputs.push(value),
      window: { emma: { readBackground: async (id: string) => { ids.push(id); return readings.shift() ?? null; } } },
      setInterval: (callback: () => void) => { const timer = { callback, cleared: false }; timers.push(timer); return timer; },
      clearInterval: (timer: Timer) => { timer.cleared = true; clears += 1; },
    };
    const setup = Function(...Object.keys(environment), setupCode)(...Object.values(environment)) as () => (() => void) | undefined;
    const cleanup = setup();
    assert.equal(timers.length, 1);
    await Promise.resolve();
    timers[0].callback();
    await Promise.resolve();
    const result = { outputs, ids, timer: timers[0], clears };
    cleanup?.();
    return result;
  };

  const exited = await exercise([{ task: task("running"), output: "still running" }, { task: task("exited"), output: "final output" }]);
  assert.deepEqual(exited.ids, ["bg1", "bg1"]);
  assert.deepEqual(exited.outputs, ["still running", "final output"]);
  assert.equal(exited.timer.cleared, true);
  assert.equal(exited.clears, 1);

  const missing = await exercise([{ task: task("running"), output: "still running" }, null]);
  assert.deepEqual(missing.outputs, ["still running", ""]);
  assert.equal(missing.timer.cleared, true);
  assert.equal(missing.clears, 1);
});
