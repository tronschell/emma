import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import React, { type ReactElement, type ReactNode } from "react";
import ts from "typescript";
import * as workflow from "../shared/workflow";
import { zoned } from "../src/dates";

type Element = ReactElement<Record<string, unknown>>;
const source = readFileSync(path.resolve(__dirname, "../../src/schedule.tsx"), "utf8");
const prefix = source.slice(source.indexOf("const KIND_LABELS"), source.indexOf("export function useTaskCommands"));
const code = ts.transpileModule(prefix.replace("export function TriggerPicker", "function TriggerPicker"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;

function mount(value: string, disabled = false) {
  const state: unknown[] = [];
  let cursor = 0;
  let changes = 0;
  const env = {
    React, ...workflow, zoned,
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (next: unknown) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
    },
    useRef: () => ({ current: null }),
    useEffect: () => undefined,
  };
  const { TriggerPicker, Picker } = Function(...Object.keys(env), `${code}\nreturn { TriggerPicker, Picker };`)(...Object.values(env));
  const render = () => {
    cursor = 0;
    return elements(TriggerPicker({ value, disabled, onChange: (next: string) => { value = next; changes++; } }));
  };
  return { render, Picker, value: () => value, changes: () => changes };
}

function elements(node: ReactNode): Element[] {
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...React.Children.toArray(node.props.children as ReactNode).flatMap(elements)];
}

function change(node: Element, value: unknown) {
  (node.props.onChange as (value: unknown) => void)(value);
}

function raw(nodes: Element[]) {
  return nodes.find((node) => node.type === "input" && node.props.placeholder === "0 9 * * 1");
}

test("cron mode preserves the schedule and stays open while recognizable expressions are edited", () => {
  const editor = mount("0 9 * * 1");
  const repeats = () => editor.render().find((node) => node.props.label === "Repeats")!;
  assert.equal(repeats().props.value, "weekly");
  change(repeats(), "cron");
  assert.equal(editor.value(), "0 9 * * 1");
  assert.equal(editor.changes(), 0);
  assert.equal(repeats().props.value, "cron");
  for (const value of ["0 10 * * *", "*/5 * * * *", "0 9 * * 1", ""]) {
    change(raw(editor.render())!, { target: { value } });
    assert.equal(raw(editor.render())?.props.value, value);
    assert.equal(repeats().props.value, "cron");
  }
  change(repeats(), "daily");
  assert.equal(raw(editor.render()), undefined);
  assert.equal(repeats().props.value, "daily");
  assert.equal(workflow.parseTrigger(editor.value()).kind, "daily");
});

test("existing custom cron starts raw and disabled controls stay disabled", () => {
  for (const value of ["0 9 * * 1", "0 9,17 * * 1-5"]) {
    const editor = mount(value, true);
    const nodes = editor.render();
    assert.equal(Boolean(raw(nodes)), value.includes(","));
    for (const node of nodes.filter((node) => node.type === "input" || node.type === "button")) assert.equal(node.props.disabled, true);
    const picker = nodes.find((node) => node.props.label === "Repeats")!;
    const button = elements(editor.Picker(picker.props)).find((node) => node.type === "button")!;
    assert.equal(button.props.disabled, true);
  }
  const editor = mount("0 9,17 * * 1-5");
  change(raw(editor.render())!, { target: { value: "0 9 * * 1" } });
  assert.ok(raw(editor.render()));
  assert.equal(raw(mount("0 9 * * 1").render()), undefined);
});

test("the scheduled parent keys each task editor by job so raw mode resets on navigation", () => {
  const app = ts.createSourceFile("App.tsx", readFileSync(path.resolve(__dirname, "../../src/App.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let key: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(app) === "TaskEditor") {
      const attribute = node.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText(app) === "key");
      if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)) key = attribute.initializer.expression;
    }
    ts.forEachChild(node, visit);
  }
  visit(app);
  assert.ok(key);
  const editorKey = Function("creating", "job", `return ${key.getText(app)}`);
  assert.notEqual(editorKey(false, { id: "first" }), editorKey(false, { id: "second" }));
  assert.notEqual(editorKey(true, { id: "first" }), editorKey(false, { id: "first" }));
});
