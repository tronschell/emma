import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { plural } from "../src/plural";
import { threadMessageCount, type Thread } from "../src/types";

process.env.TZ = "America/New_York";
const now = "2026-03-09T04:30:00Z";
const source = ts.createSourceFile("App.tsx", readFileSync(path.resolve(__dirname, "../../src/App.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const view = source.statements.find((item): item is ts.FunctionDeclaration => ts.isFunctionDeclaration(item) && item.name?.text === "ArchiveView");
assert.ok(view);
type Element = { type: string; props: Record<string, unknown>; children: unknown[] };
const createElement = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children });
const render = Function("React", "Date", "date", "time", "plural", "threadLabel", "threadMessageCount", "Mark", "ARCHIVE_RETENTION_DAYS", ts.transpileModule(`${view.getText(source)}\nreturn ArchiveView;`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText)(
  { createElement },
  class extends Date { constructor(value: string | number | Date = now) { super(value instanceof Date ? value.getTime() : value); } },
  (value: string) => new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }),
  (value: string) => new Date(value).toLocaleTimeString("en-US"),
  plural, (thread: Thread) => thread.title, threadMessageCount, "mark", 30,
) as (props: { threads: Thread[]; busy: boolean; restore: (id: string) => void; projectName: () => string }) => Element;

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("children" in value)) return [];
  const element = value as Element;
  return [element, ...element.children.flatMap(elements)];
}

test("archive timeline groups local days across DST, orders threads, shows expiry, and restores the selected thread", () => {
  const thread = (id: string, archivedAt: string): Thread => ({ id, title: id, archivedAt, createdAt: archivedAt, updatedAt: now, messages: [], messageCount: 12 });
  const threads = [thread("yesterday", "2026-03-08T05:30:00Z"), thread("earlier", "2026-03-09T04:10:00Z"), thread("newest", "2026-03-09T04:20:00Z"), thread("expiring", new Date(Date.parse(now) - 29.5 * 86_400_000).toISOString())];
  const restored: string[] = [];
  const props = { threads, busy: false, restore: (id: string) => restored.push(id), projectName: () => "Emma" };
  const tree = elements(render(props));
  assert.deepEqual(tree.filter(item => item.type === "h3").map(item => item.children[0]), ["Today", "Yesterday", "Feb 7, 2026"]);
  assert.deepEqual(tree.filter(item => item.type === "h4").map(item => item.children[0]), ["newest", "earlier", "yesterday", "expiring"]);
  assert.deepEqual(threads.map(item => item.id), ["yesterday", "earlier", "newest", "expiring"]);
  assert.deepEqual(tree.find(item => item.props.className === "archive-expiry expiring")?.children, ["1 day left"]);
  assert.match(JSON.stringify(tree), /12/);
  const button = tree.find(item => item.props["aria-label"] === "Restore earlier");
  assert.ok(button);
  (button.props.onClick as () => void)();
  assert.deepEqual(restored, ["earlier"]);
  assert.ok(elements(render({ ...props, busy: true })).filter(item => item.type === "button").every(item => item.props.disabled));
  const empty = elements(render({ ...props, threads: [] }));
  assert.ok(empty.some(item => item.children.includes("Nothing archived")));
  assert.ok(!empty.some(item => item.type === "button"));
});
