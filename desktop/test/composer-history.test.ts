import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const source = ts.createSourceFile("App.tsx", readFileSync(path.join(__dirname, "../../src/App.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const threadView = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "ThreadView");
assert.ok(threadView?.body);
const handlers = Object.fromEntries(threadView.body.statements.flatMap((node) => ts.isVariableStatement(node) ? node.declarationList.declarations.flatMap((declaration) => declaration.initializer && ["composerKeys", "typing"].includes(declaration.name.getText(source)) ? [[declaration.name.getText(source), ts.transpile(`return ${declaration.initializer.getText(source)}`, { target: ts.ScriptTarget.ES2022 })]] : []) : []));

function composer(message: string, past: string[]) {
  const state = {
    message, past, history: -1, historyDraft: { current: "" },
    slashOpen: false, slashMatches: [], sending: false, confirmStop: false,
    input: { current: null }, setCaret() {}, setSlashDismissed() {}, setSlashPick() {},
    setMessage(text: string) { state.message = text; },
    setHistory(index: number) { state.history = index; },
  };
  const invoke = (name: string, event: unknown) => Function(...Object.keys(state), handlers[name])(...Object.values(state))(event);
  return {
    state,
    press(key: string, at = state.message.length, end = at, shiftKey = false) {
      const event = { key, shiftKey, nativeEvent: { isComposing: false }, prevented: false, preventDefault() { this.prevented = true; }, currentTarget: { value: state.message, selectionStart: at, selectionEnd: end } };
      invoke("composerKeys", event);
      return event.prevented;
    },
    type(value: string) { invoke("typing", { value, selectionStart: value.length }); },
  };
}

test("history restores the unsent draft and stops at both boundaries", () => {
  const view = composer("valuable draft", ["newer", "older"]);
  assert.equal(view.press("ArrowDown"), false);
  assert.equal(view.press("ArrowUp", 0), true);
  assert.equal(view.state.message, "newer");
  view.press("ArrowUp", 0);
  assert.equal(view.state.message, "older");
  assert.equal(view.press("ArrowUp", 0), false);
  assert.equal(view.state.message, "older");
  view.press("ArrowDown");
  assert.equal(view.state.message, "newer");
  view.press("ArrowDown");
  assert.equal(view.state.message, "valuable draft");
  assert.equal(view.state.history, -1);
  assert.equal(view.press("ArrowDown"), false);
});

test("empty history and text navigation leave drafts untouched", () => {
  const empty = composer("valuable draft", []);
  assert.equal(empty.press("ArrowUp", 0), false);
  assert.equal(empty.press("ArrowDown"), false);
  assert.equal(empty.state.message, "valuable draft");
  const view = composer("two\nlines", ["previous"]);
  for (const [at, end, shift] of [[2, 2, false], [0, 3, false], [0, 0, true]] as const) {
    assert.equal(view.press("ArrowUp", at, end, shift), false);
    assert.equal(view.state.message, "two\nlines");
  }
  view.press("ArrowUp", 0);
  assert.equal(view.press("ArrowDown", 2), false);
  assert.equal(view.press("ArrowDown", 0, view.state.message.length), false);
  assert.equal(view.state.message, "previous");
});

test("editing recalled text starts a new draft for the next history visit", () => {
  const view = composer("original draft", ["previous"]);
  view.press("ArrowUp", 0);
  view.type("edited previous");
  assert.equal(view.state.history, -1);
  view.press("ArrowUp", 0);
  assert.equal(view.state.message, "previous");
  view.press("ArrowDown");
  assert.equal(view.state.message, "edited previous");
  view.type("");
  view.press("ArrowUp", 0);
  view.press("ArrowDown");
  assert.equal(view.state.message, "");
});
