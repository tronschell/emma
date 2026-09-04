import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { cliHarness, type CliRun } from "../shared/cli";

type Element = { type: string; props: Record<string, unknown>; children: unknown[] };
const source = ts.createSourceFile("cli.tsx", readFileSync(path.resolve(__dirname, "../../src/cli.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const view = source.statements.find((item): item is ts.FunctionDeclaration => ts.isFunctionDeclaration(item) && item.name?.text === "CliHandoff");
assert.ok(view);
const code = ts.transpileModule(`${view.getText(source)}\nreturn CliHandoff;`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
const elements = (value: unknown): Element[] => Array.isArray(value) ? value.flatMap(elements) : value && typeof value === "object" && "children" in value ? [value as Element, ...(value as Element).children.flatMap(elements)] : [];

test("harness cards preserve destination scope, selection, and source navigation", async () => {
  const run: CliRun = { id: "cli2", cli: "codex", threadId: "t1", title: "Review", cwd: "/tmp", folder: "fixture", status: "idle", exitCode: 0, turns: 1, startedAt: 0, turnStartedAt: 0, unattended: false, inputs: [{ id: "cli1", cli: "claude", turn: 1 }] };
  const original = { ...run, id: "cli1", cli: "claude", unattended: true };
  const runs = [run, original, { ...run, id: "cli3", threadId: "other" }, { ...run, id: "cli4", status: "running" }];
  const opened: string[] = [];
  const requests: unknown[] = [];
  const draw = (target: string) => {
    const state = [[{ id: "pi", label: "Pi" }], true, target, "Review this", false, "", undefined, { target: "cli:pi", options: { model: "anthropic/claude-sonnet-5", effort: "high" } }];
    const render = Function("React", "useState", "useEffect", "useRef", "useCliRuns", "cliHarness", "cliLabel", "cliBrand", "brandForImporter", "BrandIcon", "CloseIcon", "CliOptionFields", "window", code)(
      { createElement: (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: props ?? {}, children }) },
      () => [state.shift(), () => undefined], () => undefined, () => ({ current: null }), () => runs, cliHarness, (item: CliRun) => cliHarness(item.cli)?.label, () => undefined, () => undefined, "brand", "close", "options", { emma: { handoffCliRun: async (request: unknown) => { requests.push(request); return run; } } },
    );
    return elements(render({ run, onOpenRun: (id: string) => opened.push(id) }));
  };
  const tree = draw("cli:pi");
  assert.deepEqual(tree.filter((item) => item.type === "input").map((item) => item.props.value), ["cli:pi", "run:cli1"]);
  assert.equal(tree.find((item) => item.props.value === "cli:pi")?.props.checked, true);
  assert.ok(JSON.stringify(tree).includes("Approvals skipped"));
  const sourceLink = tree.find((item) => item.props.title === "Open cli1, source turn 1");
  assert.ok(sourceLink && !sourceLink.props.disabled);
  (sourceLink.props.onClick as () => void)();
  assert.deepEqual(opened, ["cli1"]);
  assert.equal(tree.find((item) => item.props.className === "dialog-primary")?.props.disabled, false);
  (tree.find((item) => item.type === "form")!.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => undefined });
  await Promise.resolve();
  assert.deepEqual(requests, [{ sourceId: "cli2", prompt: "Review this", cli: "pi", model: "anthropic/claude-sonnet-5", effort: "high" }]);
  assert.equal(draw("run:cli1").find((item) => item.type === "options")?.props.options && (draw("run:cli1").find((item) => item.type === "options")!.props.options as { model: string }).model, "");
  assert.equal(draw("run:cli4").find((item) => item.props.className === "dialog-primary")?.props.disabled, true);
});
