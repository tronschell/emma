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
});

test("the mount wraps the whole app in the root boundary", () => {
  assert.match(read("desktop/src/main.tsx"), /<RootBoundary>\s*<App \/>\s*<\/RootBoundary>/);
});

test("the thread header field is keyed and seeded on the label the rest of the app shows", () => {
  const app = read("desktop/src/App.tsx");
  assert.match(app, /const threadName = \(thread: Thread\) => threadLabel\(thread, THREAD_NAME_MAX\);/);
  assert.match(app, /className="thread-name"\s*\n\s*key=\{`\$\{thread\.id\}:\$\{threadName\(thread\)\}`\}\s*\n\s*defaultValue=\{threadName\(thread\)\}/);
  assert.ok(!/defaultValue=\{threadLabel\(thread\)\}/.test(app), "the header no longer seeds from the truncated display label");
});

test("the composer says when a paste has hit the length it holds", () => {
  const app = read("desktop/src/App.tsx");
  assert.match(app, /maxLength=\{COMPOSER_MAX\}/);
  assert.match(app, /message\.length >= COMPOSER_MAX && <div className="composer-attachment">/);
});

test("collapsing the rail takes focus out of the sidebar so the peek does not stick open", () => {
  const app = read("desktop/src/App.tsx");
  assert.match(app, /aria-expanded=\{!layout\.sidebarCollapsed\} onClick=\{\(event\) => \{ event\.currentTarget\.focus\(\); pane\(\{ sidebarCollapsed: !layout\.sidebarCollapsed \}\); \}\}/);
});

test("a task item is drawn as a box", () => {
  assert.match(read("desktop/src/markdown.tsx"), /item\.checked !== undefined && <input type="checkbox" checked=\{item\.checked\} disabled/);
});

test("the island folds a reasoning model's scratchpad away instead of printing it", () => {
  const app = read("desktop/src/App.tsx");
  assert.match(app, /turn\.role === "assistant" \? splitThinking\(turn\.content\)\.answer : turn\.content/);
  assert.match(app, /\{splitThinking\(stream\.text\)\.answer \|\| "···"\}/);
});

test("an overlay surface does not call the IPC the main process reserves for the workspace window", () => {
  assert.match(read("desktop/src/App.tsx"), /if \(isWorkspaceWindow\) void window\.emma\.listImportedMcpServers\(\)/);
  const hook = read("desktop/src/schedule.tsx");
  assert.match(hook, /if \(isWorkspaceWindow\) void window\.emma\.searchImportedSkills\(/);
  assert.match(hook, /if \(isWorkspaceWindow\) void window\.emma\.listFolders\(\)/);
});

test("an armed two-press delete is filled, not just relabelled", () => {
  const base = path.join(__dirname, "..", "..");
  assert.match(readFileSync(path.join(base, "src/index.css"), "utf8"), /button\[data-armed="true"\][^\n]*background: var\(--danger\)/);
  for (const [file, marker] of [["src/App.tsx", "task-danger"], ["src/mobile.tsx", "reset-data"]] as const) {
    const line = readFileSync(path.join(base, file), "utf8").split("\n").find((row) => row.includes(`className="${marker}"`));
    assert.ok(line, `${file} no longer has a ${marker} button`);
    assert.match(line, /data-armed=\{/);
  }
});
