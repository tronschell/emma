import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../../..", file), "utf8");

type Node = { type: string; props: Record<string, unknown>; children: unknown[] };

function flatten(node: unknown, into: Node[] = []): Node[] {
  if (!node || typeof node !== "object") return into;
  const element = node as Node;
  if (typeof element.type === "string") into.push(element);
  for (const child of element.children ?? []) flatten(child, into);
  return into;
}

function bootBoundary() {
  const source = read("desktop/src/main.tsx");
  const start = source.indexOf("export class RootBoundary");
  const end = source.indexOf("createRoot(");
  assert.ok(start >= 0 && end > start, "main.tsx still declares RootBoundary above the mount");
  const emitted = ts.transpileModule(source.slice(start, end).replace("export class", "class"), {
    compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: "h", target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  class Component {
    props: { children?: unknown };
    state: { failed: string } = { failed: "" };
    constructor(props: { children?: unknown }) { this.props = props; }
  }
  const h = (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: props ?? {}, children });
  const exported: { RootBoundary?: typeof Component & { getDerivedStateFromError(error: unknown): { failed: string } } } = {};
  new Function("Component", "h", "out", `${emitted}\nout.RootBoundary = RootBoundary;`)(Component, h, exported);
  return exported.RootBoundary!;
}

test("a render error is caught at the root and offers a way back instead of a blank window", () => {
  const RootBoundary = bootBoundary();
  const caught = RootBoundary.getDerivedStateFromError(new Error("boom"));
  assert.match(caught.failed, /boom/);
  assert.ok(RootBoundary.getDerivedStateFromError(new Error("")).failed.length > 0, "an error with no message still says something");

  const healthy = new RootBoundary({ children: "the app" }) as unknown as { state: { failed: string }; render(): unknown };
  assert.equal(healthy.render(), "the app");

  const failed = new RootBoundary({ children: "the app" }) as unknown as { state: { failed: string }; render(): unknown };
  failed.state = caught;
  const painted = flatten(failed.render());
  assert.equal(painted[0].props.role, "alert");
  const button = painted.find((node) => node.type === "button");
  assert.ok(button && typeof button.props.onClick === "function", "the failure state carries a reload control");
  assert.ok(painted.some((node) => node.type === "pre" && node.children.flat().includes(caught.failed)), "the reason is shown, not swallowed");
  assert.match(read("desktop/src/index.css"), /\.root-failure \{/);
});

test("the mount wraps the whole app in the root boundary", () => {
  assert.match(read("desktop/src/main.tsx"), /<RootBoundary>\s*<App \/>\s*<\/RootBoundary>/);
});
