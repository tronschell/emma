import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { canRemoveProvider, CODEX_PREFIX, codexSlug, defaultSettings, forgetProvider, SETTINGS_KEY, validateSettings, type ProviderProfile, type UserSettings } from "../shared/settings";

const source = ts.createSourceFile("App.tsx", readFileSync(path.join(__dirname, "../../src/App.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const main = ts.createSourceFile("main.ts", readFileSync(path.join(__dirname, "../../main/main.ts"), "utf8"), ts.ScriptTarget.Latest, true);
function named(source: ts.SourceFile, name: string) {
  const node = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node?.body);
  return node;
}
function handler(owner: string, name: string) {
  const declarations = named(source, owner).body!.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []);
  const node = declarations.find((node) => node.name.getText(source) === name)?.initializer;
  assert.ok(node);
  return node.getText(source);
}
function compile(code: string, scope: Record<string, unknown>) {
  return Function(...Object.keys(scope), ts.transpile(`return (${code});`, { target: ts.ScriptTarget.ES2022 }))(...Object.values(scope));
}

test("privacy copy distinguishes agent routing from secondary models and background requests", () => {
  const parts: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) parts.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(named(source, "SettingsBody"));
  visit(named(source, "PrivacySettings"));
  const copy = parts.join(" ").replace(/\s+/g, " ");
  assert.match(copy, /main agent loop on OpenRouter/);
  assert.match(copy, /does not cover secondary models, tools or account logging/);
  assert.match(copy, /separate opt-ins/);
  assert.match(copy, /ordinary request metadata/);
  assert.doesNotMatch(copy, /every free model|no free endpoint qualifies|Nothing is reported about you|No telemetry, no analytics/i);
});

function setup() {
  let settings = structuredClone(defaultSettings);
  let saved = settings;
  const providers: ProviderProfile[] = [];
  const state = { error: "", status: "", saving: false, registrations: 0, failure: false, persistFailure: false, release: () => {}, pause: false, failRegistration: 0 };
  const selectMain = compile(named(main, "selectModel").getText(main), { providers, selectedModel: "", selectedEffort: "", thinkingLevel: (value: string) => value });
  const act = async (method: string, params: Record<string, string>) => selectMain(method, params);
  const save = (next: UserSettings): void | Promise<void> => compile(handler("SettingsBody", "saveModelSettings"), {
    settings, validateSettings, reasonText: (reason: Error) => reason.message,
    persistSettings: (next: UserSettings) => { if (state.persistFailure) throw new Error("Storage full"); saved = validateSettings(next); return saved; },
    setSettings: (next: UserSettings) => { settings = next; },
    onModelChanged: (next: UserSettings) => { assert.deepEqual(providers, next.providers); },
    window: { emma: { setProviders: async (next: ProviderProfile[]) => {
      state.registrations++;
      if (state.pause) await new Promise<void>((resolve) => { state.release = resolve; });
      if (state.failure || state.registrations === state.failRegistration) throw new Error("Registration failed");
      providers.splice(0, providers.length, ...next);
      return next;
    } } },
  })(next);
  const invoke = (name: string, arg: unknown) => compile(handler("ProviderSettings", name), {
    settings, validateSettings, canRemoveProvider, forgetProvider, act, onChange: save,
    draft: { name: "Local", modelId: "test-model", baseUrl: "http://127.0.0.1:1234/v1", credentialEnv: "", contextWindow: "0", insecure: false },
    emptyDraft: {}, setDraft() {}, setProbe() {},
    setError: (value: string) => { state.error = value; }, setStatus: (value: string) => { state.status = value; },
    setSaving: (value: boolean) => { state.saving = value; }, reasonText: (reason: Error) => reason.message,
  })(arg);
  return { state, providers, save, invoke, act, settings: () => settings, saved: () => saved, add: () => invoke("add", { preventDefault() {} }) };
}

test("adding registers before publishing; immediate Use and shared picker work without reload", async () => {
  const view = setup();
  view.state.pause = true;
  const adding = view.add();
  assert.equal(view.state.saving, true);
  assert.equal(view.settings().providers.length, 0);
  assert.equal(view.saved().providers.length, 0);
  assert.equal(view.state.status, "");
  view.state.release();
  await adding;
  const profile = view.settings().providers[0];
  await view.invoke("select", profile);
  assert.equal(view.settings().selectedModel, `provider:${profile.id}`);
  const select = compile(named(source, "selectModelKey").getText(source), { CODEX_PREFIX, codexSlug, routerFor: () => undefined });
  assert.equal((await select(view.settings(), `provider:${profile.id}`, view.act)).selectedModel, `provider:${profile.id}`);
  assert.equal(view.state.registrations, 1);
  assert.equal(view.state.error, "");
  assert.equal(view.state.saving, false);
});

test("updates and removal synchronize while unrelated saves leave the registry alone", async () => {
  const view = setup();
  await view.add();
  await view.save({ ...view.settings(), providers: view.settings().providers.map((profile) => ({ ...profile, modelId: "updated-model" })) });
  assert.equal(view.providers[0].modelId, "updated-model");
  await view.save({ ...view.settings(), providers: structuredClone(view.settings().providers), transcriptionEnabled: true });
  assert.equal(view.state.registrations, 2);
  await view.invoke("remove", view.providers[0]);
  assert.equal(view.providers.length, 0);
  assert.equal(view.saved().providers.length, 0);
  assert.equal(view.state.registrations, 3);
});

test("registration failures keep the provider unpublished and show errors for add and remove", async () => {
  const view = setup();
  view.state.failure = true;
  await view.add();
  assert.equal(view.state.error, "Registration failed");
  assert.equal(view.state.status, "");
  assert.equal(view.state.saving, false);
  assert.equal(view.saved().providers.length, 0);
  assert.equal(view.settings().providers.length, 0);
  view.state.failure = false;
  await view.add();
  view.state.failure = true;
  await view.invoke("remove", view.providers[0]);
  assert.equal(view.state.error, "Registration failed");
  assert.equal(view.saved().providers.length, 1);
  assert.equal(view.settings().providers.length, 1);
});

test("persistence failures do not publish success", async () => {
  const view = setup();
  view.state.persistFailure = true;
  await view.add();
  assert.equal(view.state.error, "Storage full");
  assert.equal(view.state.status, "");
  assert.equal(view.settings().providers.length, 0);
  assert.equal(view.providers.length, 0);
  assert.equal(view.state.saving, false);
});

test("failed persistence restores removed and updated providers so immediate Use still works", async () => {
  const view = setup();
  await view.add();
  const profile = view.providers[0];
  view.state.persistFailure = true;
  await view.invoke("remove", profile);
  assert.equal(view.state.error, "Storage full");
  assert.deepEqual(view.providers, [profile]);
  assert.deepEqual(view.saved().providers, [profile]);
  assert.deepEqual(view.settings().providers, [profile]);
  assert.deepEqual(await view.act("selectProviderModel", { providerId: profile.id }), { model: profile.modelId });
  await assert.rejects(async () => view.save({ ...view.settings(), providers: [{ ...profile, modelId: "changed" }] }), /Storage full/);
  assert.deepEqual(view.providers, [profile]);
  assert.deepEqual(view.saved().providers, [profile]);
  assert.deepEqual(view.settings().providers, [profile]);
  assert.deepEqual(await view.act("selectProviderModel", { providerId: profile.id }), { model: profile.modelId });
});

test("rollback failure surfaces both storage and registration errors", async () => {
  const view = setup();
  await view.add();
  view.state.persistFailure = true;
  view.state.failRegistration = 3;
  await view.invoke("remove", view.providers[0]);
  assert.equal(view.state.error, "Storage full Could not restore providers: Registration failed");
  assert.equal(view.state.status, "");
  assert.equal(view.state.saving, false);
});

test("a provider whose named key is missing says so, while a keyless local endpoint still runs", () => {
  const source = readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
  const route = source.match(/function providerRoute\(key\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(route);
  const providerRoute = runInNewContext(`${route}\nproviderRoute`, {
    providerFor: () => ({ id: "plan-zai", name: "GLM Coding Plan", credentialEnv: "ZAI_API_KEY", baseUrl: "https://api.z.ai/api/coding/paas/v4" }),
    settings_1: { providerChatUrl: (profile: { baseUrl: string }) => `${profile.baseUrl}/chat/completions` },
    process: { env: {} as Record<string, string> },
  }) as (key: string) => { apiKey: string };
  assert.throws(() => providerRoute("provider:plan-zai"), /no key saved under ZAI_API_KEY/);

  const keyed = runInNewContext(`${route}\nproviderRoute`, {
    providerFor: () => ({ id: "plan-zai", name: "GLM Coding Plan", credentialEnv: "ZAI_API_KEY", baseUrl: "https://api.z.ai/api/coding/paas/v4" }),
    settings_1: { providerChatUrl: (profile: { baseUrl: string }) => `${profile.baseUrl}/chat/completions` },
    process: { env: { ZAI_API_KEY: "  real-key  " } as Record<string, string> },
  }) as (key: string) => { apiKey: string };
  assert.equal(keyed("provider:plan-zai").apiKey, "real-key");

  const local = runInNewContext(`${route}\nproviderRoute`, {
    providerFor: () => ({ id: "local", name: "Mac Studio", credentialEnv: "", baseUrl: "http://127.0.0.1:1234/v1" }),
    settings_1: { providerChatUrl: (profile: { baseUrl: string }) => `${profile.baseUrl}/chat/completions` },
    process: { env: {} as Record<string, string> },
  }) as (key: string) => { apiKey: string };
  assert.equal(local("provider:local").apiKey, "no-key");
});

test("a saved ChatGPT model is restored on boot instead of being reset to fallback", async () => {
  let effect = "";
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.getText(source).includes("The saved model selection is invalid")) effect = node.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(effect);
  const settings: UserSettings = { ...structuredClone(defaultSettings), selectedModel: "codex:gpt-5.6-luna", thinkingLevel: "max" };
  const calls: { method: string; params: Record<string, string> }[] = [];
  let error = "";
  let persisted: UserSettings | undefined;
  compile(effect, {
    restoredModel: { current: false }, settings, SETTINGS_KEY, CODEX_PREFIX, codexSlug,
    routerIdFor: () => undefined, selectModelKey: () => assert.fail("routers do not own Codex keys"),
    reasonText: (reason: Error) => reason.message,
    setError: (value: string) => { error = value; },
    setSettings() {}, persistSettings: (next: UserSettings) => { persisted = next; return next; },
    window: { emma: {
      setZeroRetention: async () => undefined,
      setProviders: async () => [],
      request: async (method: string, params: Record<string, string> = {}) => { calls.push({ method, params }); return undefined; },
    } },
  })();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [{ method: "selectCodexModel", params: { modelId: "gpt-5.6-luna", effort: "max" } }]);
  assert.equal(error, "");
  assert.equal(persisted, undefined);
});
