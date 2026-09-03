import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { asPermissionMode, DEFAULT_PERMISSION_MODE } from "../shared/permissions";
import { isThinkingLevel } from "../shared/settings";

/* main.ts boots Electron and cannot be imported, so the persistence pair is lifted out of it the
   way runtime-cancellation.test.ts lifts its own helpers. What is under test is the round trip: a
   thread's folder and permission mode used to live only in memory, so every restart reset it. */
const source = ts.createSourceFile("main.ts", readFileSync(path.join(process.cwd(), "main/main.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const lift = (name: string) => source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(source);
const liftConst = (name: string) => source.statements.find((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((one) => one.name.getText(source) === name))!.getText(source);

const persistence = ts.transpileModule([
  liftConst("threadContextsFile"), lift("loadThreadContexts"), lift("rememberThreadContext"),
  "({ loadThreadContexts, rememberThreadContext });",
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const on = (dir: string, threadContexts: Map<string, unknown>) => runInNewContext(persistence, {
  app: { getPath: () => dir }, path, readFileSync, writeFileSync,
  threadContexts, asPermissionMode, isThinkingLevel,
}) as { loadThreadContexts(): void; rememberThreadContext(id: string, record: unknown): void };

/* A record restored inside runInNewContext carries that realm's Object.prototype, so a strict
   deepEqual against a literal here fails on identity alone. The bytes are the subject. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

test("a thread's folder and permission mode survive a restart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "emma-thread-context-"));
  on(dir, new Map()).rememberThreadContext("t1", { folderIds: ["f-emma"], mode: "acceptEdits", model: "openrouter:x" });
  // The restart: a brand new Map, which is all main.ts ever had.
  const after = new Map();
  on(dir, after).loadThreadContexts();
  assert.deepEqual(plain(after.get("t1")), { folderIds: ["f-emma"], mode: "acceptEdits", model: "openrouter:x" });
});

test("a thread-contexts file that will not read leaves the map empty rather than failing the boot", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "emma-thread-context-"));
  writeFileSync(path.join(dir, "thread-contexts.json"), "{ not json");
  const held = new Map();
  assert.doesNotThrow(() => on(dir, held).loadThreadContexts());
  assert.equal(held.size, 0);
});

test("a tampered record falls back per field rather than installing a mode nothing can gate on", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "emma-thread-context-"));
  writeFileSync(path.join(dir, "thread-contexts.json"),
    JSON.stringify({ t1: { folderIds: ["a", "b"], mode: "yolo", model: 7 }, "": { folderIds: [] }, t2: null }));
  const held = new Map();
  on(dir, held).loadThreadContexts();
  assert.deepEqual(plain(held.get("t1")), { folderIds: ["a"], mode: DEFAULT_PERMISSION_MODE, model: "" });
  assert.equal(held.size, 1, "a keyless or null record is a thread not restored, never a crash");
});
