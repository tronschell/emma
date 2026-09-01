import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../../..", file), "utf8");
const styles = () => {
  const directory = path.resolve(__dirname, "../../../desktop/src/styles");
  return readdirSync(directory).filter((name) => name.endsWith(".css")).map((name) => ({ name, css: readFileSync(path.join(directory, name), "utf8") }));
};

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

test("the thread header field is keyed and seeded on the label the rest of the app shows", () => {
  const app = read("desktop/src/App.tsx");
  assert.match(app, /const threadName = \(thread: Thread\) => threadLabel\(thread, THREAD_NAME_MAX\);/);
  assert.match(app, /className="thread-name"\s*\n\s*key=\{`\$\{thread\.id\}:\$\{threadName\(thread\)\}`\}\s*\n\s*defaultValue=\{threadName\(thread\)\}/);
  assert.ok(!/defaultValue=\{threadLabel\(thread\)\}/.test(app), "the header no longer seeds from the truncated display label");
});

test("a long composer value stops mirroring and stops content-sizing, and the cap is said out loud", () => {
  const app = read("desktop/src/App.tsx");
  const css = read("desktop/src/styles/conversation.css");
  assert.match(app, /data-long=\{message\.length > COMPOSER_MIRROR_MAX \? "" : undefined\}/);
  assert.match(app, /\{message\.length > COMPOSER_MIRROR_MAX \? null : <div className="composer-highlight"/);
  assert.match(app, /maxLength=\{COMPOSER_MAX\}/);
  assert.match(app, /message\.length >= COMPOSER_MAX && <div className="composer-attachment">/);
  assert.match(css, /\.composer-input\[data-long\] textarea \{[^}]*field-sizing: fixed/);
});

test("the composer chip row wraps and every chip keeps a floor instead of overlapping", () => {
  const css = read("desktop/src/styles/conversation.css");
  assert.match(css, /\.composer-row \{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.composer-tools \{[^}]*min-width: min-content/);
  assert.match(css, /\.composer-row \.model-button \{[^}]*min-width: 88px/);
});

test("collapsing the rail takes focus out of the sidebar so the peek does not stick open", () => {
  const app = read("desktop/src/App.tsx");
  assert.match(app, /aria-expanded=\{!layout\.sidebarCollapsed\} onClick=\{\(event\) => \{ event\.currentTarget\.focus\(\); pane\(\{ sidebarCollapsed: !layout\.sidebarCollapsed \}\); \}\}/);
});

test("no rule asks for a radius or a warning colour the token file never defines", () => {
  const asked = styles().flatMap((sheet) => [...sheet.css.matchAll(/var\(\s*(--r-1|--r-2|--warn)\b/g)].map(([, name]) => `${sheet.name}: ${name}`));
  assert.deepEqual(asked, []);
});

test("a settings failure is painted as a failure, not as body ink", () => {
  const css = read("desktop/src/styles/settings.css");
  assert.match(css, /\.keybind-problem \{ color: var\(--danger\);/);
  assert.ok(!/--warn/.test(css));
});

test("every figure meant to read as a quantity follows the chosen accent", () => {
  for (const rule of [
    /\.agent-metrics b \{[^}]*color: var\(--accent\)/,
    /\.evidence-table summary b \{ color: var\(--accent\)/,
    /\.rate-curve i \{[^}]*background: var\(--accent\)/,
    /\.agent-arm i \{[^}]*background: var\(--accent\)/,
  ]) assert.match(read("desktop/src/styles/panels.css"), rule);
  assert.match(read("desktop/src/styles/conversation.css"), /\.generation-rate \{ color: var\(--accent\)/);
  assert.match(read("desktop/src/styles/conversation.css"), /\.model-cut b \{ color: var\(--accent\)/);
  assert.match(read("desktop/src/styles/research.css"), /\.research-tip b \{ color: var\(--accent\)/);
});

test("the cursor ring's labels sit on a ground of their own", () => {
  assert.match(read("desktop/src/App.tsx"), /<span className="orb-label">\{label\}<\/span>/);
  assert.match(read("desktop/src/styles/overlay.css"), /\.radial \.orb-label \{[^}]*background: var\(--bg\)/);
});

test("a mermaid diagram is given the width it asks for", () => {
  assert.match(read("desktop/src/styles/artifacts.css"), /\.artifact-mermaid \{[^}]*justify-items: stretch/);
});
