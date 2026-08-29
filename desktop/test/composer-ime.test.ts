import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

for (const [file, owner, name] of [["App.tsx", "ThreadView", "composerKeys"], ["App.tsx", "Overlay", "composerKeys"], ["schedule.tsx", "PromptField", "keys"]]) {
  test(`${owner} leaves composition keys to the IME and preserves ordinary shortcuts`, () => {
    const filename = path.resolve(__dirname, "../../src", file);
    const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const component = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === owner);
    assert.ok(component);
    let handler: ts.Expression | undefined;
    let wired = false;
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) handler = node.initializer;
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "textarea") {
        wired ||= node.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "onKeyDown" && attribute.initializer?.getText(source) === `{${name}}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(component);
    assert.ok(handler);
    assert.ok(wired);
    const effects: unknown[] = [];
    const record = (value: unknown) => effects.push(value);
    const context = {
      slashOpen: true, slash: {}, slashMatches: ["first", "second"], matches: ["first", "second"], slashActive: 0, active: 0,
      sending: true, confirmStop: false, history: -1, past: ["previous"], input: { current: null },
      pickCommand: record, choose: record, setSlashDismissed: record, setDismissed: record,
      setConfirmStop: record, interrupt: record, setHistory: record, setMessage: record, setCaret: record,
      setSlashPick: (update: (current: number) => number) => record(update(0)),
      setPick: (update: (current: number) => number) => record(update(0)),
    };
    const compiled = ts.transpileModule(`const handler = ${handler.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const keys = (slashOpen: boolean) => new Function(...Object.keys(context), `${compiled}\nreturn handler;`)(...Object.values({ ...context, slashOpen, slash: slashOpen ? {} : null }));
    function press(key: string, isComposing: boolean, slashOpen = true, shiftKey = false) {
      effects.length = 0;
      keys(slashOpen)({
        key, shiftKey, nativeEvent: { isComposing }, preventDefault: () => record("prevented"),
        currentTarget: { value: "未完", selectionStart: 0, selectionEnd: 0, form: { requestSubmit: () => record("submitted") } },
      });
      return [...effects];
    }
    for (const slashOpen of [true, false]) {
      for (const key of ["Enter", "Tab", "ArrowUp", "ArrowDown", "Escape"]) assert.deepEqual(press(key, true, slashOpen), [], `${key}, slash=${slashOpen}`);
    }
    assert.deepEqual(press("Enter", false), ["prevented", "first"]);
    assert.deepEqual(press("Tab", false), ["prevented", "first"]);
    assert.deepEqual(press("ArrowDown", false), ["prevented", 1]);
    assert.deepEqual(press("ArrowUp", false), ["prevented", 1]);
    assert.deepEqual(press("Escape", false), ["prevented", true]);
    assert.deepEqual(press("Enter", false, false), owner === "PromptField" ? [] : ["prevented", "submitted"]);
    assert.deepEqual(press("Enter", false, false, true), []);
  });
}
