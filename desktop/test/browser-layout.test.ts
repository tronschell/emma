import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const source = readFileSync(path.join(__dirname, "../../src/browser.tsx"), "utf8");
const tree = ts.createSourceFile("browser.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "createBrowserPlacementScheduler");
assert.ok(declaration);
const createBrowserPlacementScheduler = Function(`${ts.transpile(declaration.getText(tree).replace(/^export /, ""), { target: ts.ScriptTarget.ES2022 })}; return createBrowserPlacementScheduler;`)() as (
  place: () => void,
  requestFrame: (callback: () => void) => number,
  cancelFrame: (id: number) => void,
) => { schedule: () => void; stop: () => void };

test("browser placement coalesces signals and cancels pending work on cleanup", () => {
  let frame: (() => void) | undefined;
  const canceled: number[] = [];
  let calls = 0;
  const scheduler = createBrowserPlacementScheduler(() => { calls++; }, (callback) => { frame = callback; return 7; }, (id) => canceled.push(id));

  scheduler.schedule();
  scheduler.schedule();
  assert.equal(calls, 0);
  assert.ok(frame);
  frame!();
  assert.equal(calls, 1);

  scheduler.schedule();
  scheduler.stop();
  scheduler.schedule();
  assert.deepEqual(canceled, [7]);
  assert.ok(frame);
  frame!();
  assert.equal(calls, 1);
  scheduler.stop();
  assert.deepEqual(canceled, [7]);
});

test("browser placement has no perpetual timer and watches layout signals", () => {
  assert.doesNotMatch(source, /setInterval/);
  assert.match(source, /new ResizeObserver\(schedule\)/);
  assert.match(source, /new MutationObserver\(schedule\)/);
  assert.match(source, /visualViewport/);
  assert.match(source, /observer\.disconnect\(\)/);
  assert.match(source, /dialogs\.disconnect\(\)/);
  assert.match(source, /shellChanges\?\.disconnect\(\)/);
  assert.match(source, /sidebarChanges\?\.disconnect\(\)/);
  assert.match(source, /pipChanges\?\.disconnect\(\)/);
  assert.match(source, /removeEventListener\("scroll", schedule, true\)/);
  assert.match(source, /scheduler\.stop\(\)/);
});
