import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { CLI_PLANS, MODEL_PLANS, type KeyBalance } from "../shared/settings";

const source = (file: string) => ts.createSourceFile(file, readFileSync(path.join(__dirname, "../../src", file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const providers = source("model-plans.tsx");
const app = source("App.tsx");
function binding(file: ts.SourceFile, owner: string | null, name: string) {
  const fn = file.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === owner);
  const statements = owner ? fn?.body?.statements : file.statements;
  const node = statements?.flatMap((statement) => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []).find((node) => node.name.getText(file) === name || (ts.isArrayBindingPattern(node.name) && node.name.elements.some((item) => ts.isBindingElement(item) && item.name.getText(file) === name)))?.initializer;
  assert.ok(node, `${owner ?? file.fileName}.${name}`);
  return ts.transpile(`(${node.getText(file)})`, { target: ts.ScriptTarget.ES2022 });
}

test("onboarding requires a verified OpenRouter key even when subscriptions are connected", async () => {
  const key: KeyBalance = { keyed: true, freeTier: true, remaining: 0, usage: 0, error: "" };
  const state = createContext({
    balance: null as KeyBalance | null, checking: false, saving: false, error: "", stored: [], drafts: { OPENROUTER_API_KEY: "invalid" }, OPENROUTER_ENV: "OPENROUTER_API_KEY",
    reasonText: (reason: Error) => reason.message,
    window: { emma: {
      saveCredential: async () => [{ env: "OPENROUTER_API_KEY", masked: "key" }],
      openRouterBalance: async () => ({ ...key, error: "OpenRouter rejected that key." }),
    } },
  });
  state.setBalance = (value: KeyBalance | null) => { state.balance = value; };
  state.setSaving = (value: boolean) => { state.saving = value; };
  state.setChecking = (value: boolean) => { state.checking = value; };
  state.setError = (value: string) => { state.error = value; };
  state.setStored = (value: unknown) => { state.stored = value; };
  state.setDrafts = (update: (value: object) => object) => { state.drafts = update(state.drafts); };
  state.saveKey = runInContext(binding(providers, "ProviderGrid", "saveKey"), state);
  const verify = runInContext(binding(providers, "ProviderGrid", "verify"), state);
  const ready = () => runInContext(binding(providers, "ProviderGrid", "ready"), state);
  assert.equal(ready(), false);
  await state.saveKey("KIMI_CODE_API_KEY", "subscription");
  assert.equal(ready(), false);
  await verify();
  assert.equal(ready(), false);
  assert.equal(state.balance.error, "OpenRouter rejected that key.");
  state.window.emma.openRouterBalance = async () => key;
  await verify();
  assert.equal(ready(), true);
  state.checking = true;
  assert.equal(ready(), false);
  state.checking = false;
  state.window.emma.openRouterBalance = async () => { throw new Error("Offline"); };
  await verify();
  assert.equal(ready(), false);
  assert.equal(state.error, "Offline");
  state.window.emma.saveCredential = async () => { throw new Error("Credential store locked"); };
  await state.saveKey("OPENROUTER_API_KEY", "replacement");
  assert.equal(ready(), false);
  assert.equal(state.saving, false);
  assert.equal(state.error, "Credential store locked");
});

test("onboarding offers every subscription with no preselected provider", () => {
  const tiles = runInContext(binding(providers, null, "SUBSCRIPTION_TILES"), createContext({ CLI_PLANS, MODEL_PLANS })) as { id: string; brand: string }[];
  const expected = [...CLI_PLANS.map((plan) => `cli:${plan.id}`), ...MODEL_PLANS.filter((plan) => plan.billing === "subscription" || plan.id === "mistral").map((plan) => plan.id)];
  assert.deepEqual([...tiles.map((tile) => tile.id)].sort(), expected.sort());
  assert.notEqual(tiles[0].id, "cli:codex");
  assert.ok(tiles.every((tile) => tile.brand));
  assert.equal(runInContext(binding(providers, "ProviderGrid", "picked"), createContext({ useState: (value: string) => value })), "");
});

test("onboarding cannot advance or finish before verification and saves its resume step", () => {
  const values = new Map<string, string>();
  let finished = false;
  let page = 0;
  const state = createContext({ ready: false, busy: false, SETUP_STEP_KEY: "step", localStorage: { setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }, setPage: (value: number) => { page = value; }, setError() {}, close: () => { finished = true; } });
  const move = runInContext(binding(app, "SetupDialog", "move"), state);
  const finish = runInContext(binding(app, "SetupDialog", "finish"), state);
  move(1);
  finish();
  assert.equal(page, 0);
  assert.equal(finished, false);
  state.ready = true;
  move(1);
  assert.equal(page, 1);
  assert.equal(values.get("step"), "1");
  state.busy = true;
  finish();
  assert.equal(finished, false);
  state.busy = false;
  finish();
  assert.equal(finished, true);
  assert.equal(values.has("step"), false);
});

test("Quick Ask opens the native interface and recovers from a failed demo", async () => {
  let fail = true;
  const state = createContext({
    busy: false, tapped: false, error: "",
    reasonText: (reason: Error) => reason.message,
    window: { emma: { demoQuickAsk: async () => { if (fail) throw new Error("Unavailable"); } } },
  });
  state.setBusy = (value: boolean) => { state.busy = value; };
  state.setError = (value: string) => { state.error = value; };
  state.setTapped = (value: boolean) => { state.tapped = value; };
  const showQuickAsk = runInContext(binding(app, "SetupDialog", "showQuickAsk"), state);
  await showQuickAsk();
  assert.equal(state.tapped, false);
  assert.equal(state.error, "Unavailable");
  assert.equal(state.busy, false);
  fail = false;
  await showQuickAsk();
  assert.equal(state.tapped, true);
  assert.equal(state.error, "");
  assert.equal(state.busy, false);
});
