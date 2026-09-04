import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { isPin, PIN_MAX_DIGITS } from "../shared/mobile-protocol";

const source = ts.createSourceFile("App.tsx", readFileSync(path.resolve(__dirname, "../../src/App.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = ["VoiceSettings", "SettingsSection"].map((name) => {
  const node = source.statements.find((item): item is ts.FunctionDeclaration => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, name);
  return node.getText(source);
}).join("\n");

type Element = { type: string; props: Record<string, unknown>; children: unknown[] };
const createElement = (type: string | ((props: Record<string, unknown>) => unknown), props: Record<string, unknown> | null, ...children: unknown[]): unknown => typeof type === "function" ? type({ ...props, children }) : { type, props: props ?? {}, children };
const render = Function("React", "useState", "useDictation", "OVERLAY_LABEL", "LOCAL_DEVICE", "PLATFORM_NAME", "IS_WINDOWS", "microphoneCopy", "HOLD_TO_TALK_MS", "LLAMA_SITE_URL", "SPEECH_MODEL_URL", "SPEECH_MODEL", "LLAMA_INSTALL", "SPEECH_INSTALL", "VOICE_MODEL_URL", "VOICE_MODEL", "CLEANUP_INSTALL", ts.transpileModule(`${functions}\nreturn VoiceSettings;`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText)(
  { createElement, Fragment: "fragment" },
  (initial: unknown) => [initial, () => undefined],
  () => ({ status: { microphone: "granted", speech: true, models: [] } }),
  "Quick Ask", "Mac", "macOS", false, { granted: "Granted" }, [300, 500],
  "llama", "speech", "speech model", "install llama", "install speech", "cleanup", "cleanup model", "install cleanup",
) as (props: Record<string, unknown>) => Element;

test("voice settings show only the configuration needed by the enabled engines", () => {
  const draw = (patch: Record<string, unknown>) => JSON.stringify(render({ settings: { transcriptionEnabled: true, transcriptionEngine: "apple", voiceCleanup: false, voiceHoldMs: 500, ...patch }, busy: false, onChange: () => undefined }));
  const builtIn = draw({});
  assert.match(builtIn, /Speech to text/);
  assert.doesNotMatch(builtIn, /Local speech endpoint|Local cleanup endpoint|install speech|install cleanup/);
  const server = draw({ transcriptionEngine: "server" });
  assert.match(server, /Local speech endpoint/);
  assert.match(server, /install speech/);
  assert.doesNotMatch(server, /Local cleanup endpoint/);
  const cleanup = draw({ voiceCleanup: true });
  assert.match(cleanup, /Local cleanup endpoint/);
  assert.doesNotMatch(cleanup, /Local speech endpoint/);
  const off = draw({ transcriptionEnabled: false, transcriptionEngine: "server", voiceCleanup: true });
  assert.doesNotMatch(off, /Local speech endpoint|Local cleanup endpoint|Speech to text|Try dictation/);
});

test("saving Quick Ask behavior preserves unfinished action edits and saving actions preserves behavior", () => {
  const body = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "SettingsBody");
  assert.ok(body);
  const initializers = new Map<string, string>();
  for (const statement of body.body!.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const node of statement.declarationList.declarations) {
      if (ts.isIdentifier(node.name) && ["save", "saveNotch"].includes(node.name.text) && node.initializer) initializers.set(node.name.text, node.initializer.getText(source));
    }
  }
  assert.equal(initializers.size, 2);
  const code = ts.transpileModule(`
    let stored = { quickActions: ["Saved action"], notchConcurrency: "separate", notchModel: "", providers: [], selectedModel: "workspace" };
    let settings = { ...stored, quickActions: ["Unfinished action"], cursorOrbs: ["0"], cursorOrbsEnabled: true, notchCommandsEnabled: false, notchGap: 180 };
    const readSettings = () => stored;
    const persistSettings = value => stored = value;
    const setSettings = value => settings = typeof value === "function" ? value(settings) : value;
    const setSaved = () => {};
    const setSaveError = () => {};
    const syncMainPreferences = () => {};
    const onModelChanged = () => {};
    const reasonText = String;
    const saveNotch = ${initializers.get("saveNotch")};
    const save = ${initializers.get("save")};
    saveNotch({ ...stored, notchConcurrency: "continue" });
    const before = { stored, draft: settings.quickActions };
    save({ preventDefault() {} });
    return { before, stored };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const result = Function(code)();
  assert.deepEqual(result.before.stored.quickActions, ["Saved action"]);
  assert.deepEqual(result.before.draft, ["Unfinished action"]);
  assert.deepEqual(result.stored.quickActions, ["Unfinished action"]);
  assert.equal(result.stored.notchConcurrency, "continue");
  assert.equal(result.stored.selectedModel, "workspace");
});

test("orb configuration exposes selectable buttons without claiming to be an application menu", () => {
  const node = source.statements.find((item): item is ts.FunctionDeclaration => ts.isFunctionDeclaration(item) && item.name?.text === "OrbRing");
  assert.ok(node);
  const code = ts.transpileModule(`${node.getText(source)}\nreturn OrbRing;`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  const ring = Function("React", "orbLabel", "MODIFIER_LABEL", "cursorCommandGlyphs", code)({ createElement }, () => "Summarize", "⌘", {});
  const preview = ring({ commands: ["0"], settings: {}, selected: 0, onPick: () => undefined }) as Element;
  assert.equal(preview.props.role, "group");
  const [button] = preview.children[0] as Element[];
  assert.equal(button.props.role, undefined);
  assert.equal(button.props["aria-pressed"], true);
  const commands = ring({ commands: ["0"], settings: {}, onPick: () => undefined }) as Element;
  assert.equal(commands.props.role, "menu");
});

test("mobile pairing guards submission and replaces the PIN form during pairing or at the device limit", () => {
  const mobile = ts.createSourceFile("mobile.tsx", readFileSync(path.resolve(__dirname, "../../src/mobile.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = mobile.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "MobileSettings");
  assert.ok(component);
  const empty = { devices: [], full: false, reason: "" };
  const calls: string[] = [];
  const renderMobile = (pin: string, status = empty, pairing: object | null = null, busy = false) => {
    let index = 0;
    const state = [status, pairing, 120, null, false, "", pin];
    const draw = Function("React", "useState", "useEffect", "useRef", "EMPTY", "bridge", "isPin", "PIN_MAX_DIGITS", "remaining", "day", "seen", ts.transpileModule(`${component.getText(mobile).replace(/^export /, "")}\nreturn MobileSettings;`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText)(
      { createElement }, () => [state[index++], () => undefined], () => undefined, (current: unknown) => ({ current }), empty,
      { mobilePair: (value: string) => { calls.push(value); return Promise.resolve({}); } }, isPin, PIN_MAX_DIGITS, () => 120, String, String,
    );
    return draw({ busy }) as Element;
  };
  const collect = (value: unknown): Element[] => Array.isArray(value) ? value.flatMap(collect) : value && typeof value === "object" && "children" in value ? [value as Element, ...collect((value as Element).children)] : [];
  for (const [pin, busy, allowed] of [["123", false, false], ["1234", true, false], ["1234", false, true]] as const) {
    const nodes = collect(renderMobile(pin, empty, null, busy));
    const form = nodes.find((node) => node.type === "form")!;
    const button = nodes.find((node) => node.props.className === "save-settings")!;
    assert.equal(button.props.disabled, !allowed);
    (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} });
  }
  assert.deepEqual(calls, ["1234"]);
  const scanning = collect(renderMobile("1234", empty, {}));
  assert.ok(scanning.some((node) => node.type === "canvas" && node.props["aria-label"] === "Pairing code for Emma Mobile"));
  assert.ok(!scanning.some((node) => node.type === "input" || node.type === "form"));
  const full = collect(renderMobile("1234", { ...empty, full: true }));
  assert.ok(!full.some((node) => node.type === "form" || node.type === "canvas"));
});
