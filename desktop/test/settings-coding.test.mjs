import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = ts.createSourceFile("App.tsx", readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const createElement = (type, props, ...children) => ({ type: typeof type === "function" ? type.name : type, props: props ?? {}, children });
const draw = (name, bindings, props) => {
  const component = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(component, name);
  const scope = { React: { createElement, Fragment: "fragment" }, useState: (initial) => [initial, () => {}], useEffect: () => {}, InfoDot: "info", reasonText: String, ...bindings };
  const code = ts.transpileModule(`${component.getText(source)}\nreturn ${name};`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  return Function(...Object.keys(scope), code)(...Object.values(scope))(props);
};
const nodes = (value) => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === "object" && "children" in value ? [value, ...nodes(value.children)] : [];

test("context rule thresholds are only shown while enabled and the toggle keeps its defaults", () => {
  let saved;
  const props = { label: "Repeat prompt", blurb: "Repeat", steps: 0, percent: 0, suggested: 15, busy: false, onChange: (next) => saved = next };
  const off = nodes(draw("ExperimentRow", { MAX_EXPERIMENT_STEPS: 1000 }, props));
  assert.equal(off.filter((node) => node.type === "input" && node.props.type === "number").length, 0);
  off.find((node) => node.type === "input").props.onChange({ target: { checked: true } });
  assert.deepEqual(saved, { steps: 15, percent: 0 });
  const on = nodes(draw("ExperimentRow", { MAX_EXPERIMENT_STEPS: 1000 }, { ...props, ...saved }));
  assert.equal(on.filter((node) => node.type === "input" && node.props.type === "number").length, 2);
  on.find((node) => node.type === "input").props.onChange({ target: { checked: false } });
  assert.deepEqual(saved, { steps: 0, percent: 0 });
});

test("review and semantic search hide inactive configuration without clearing saved choices", () => {
  const reviewBindings = { MAX_REVIEW_ROUNDS: 3, TaskModelPicker: "model-picker", ReviewIcon: "icon", modelKeyLabel: (_, key) => key };
  const reviewProps = { settings: { review: { enabled: false, model: "saved-model" } }, onSave: async () => {}, busy: false };
  const off = nodes(draw("ReviewPanel", reviewBindings, reviewProps));
  assert.ok(!off.some((node) => node.type === "model-picker"));
  const on = nodes(draw("ReviewPanel", reviewBindings, { ...reviewProps, settings: { review: { enabled: true, model: "saved-model" } } }));
  assert.equal(on.find((node) => node.type === "model-picker").props.model, "saved-model");
  const bindings = { useSemanticGrepStatus: () => ({ available: true, folders: [] }), hostedEmbeddingModel: () => ({ credentialEnv: "HOSTED_KEY" }), LOCAL_EMBEDDING_MODELS: [], HOSTED_EMBEDDING_MODELS: [] };
  const props = { settings: { harnessExperiments: { semanticGrep: false, embeddingModel: "hosted" } }, onChange: async () => {}, busy: false };
  const inactive = nodes(draw("SemanticGrepPanel", bindings, props));
  assert.ok(!inactive.some((node) => node.type === "select"));
  assert.doesNotMatch(JSON.stringify(inactive), /HOSTED_KEY/);
  const active = nodes(draw("SemanticGrepPanel", bindings, { ...props, settings: { harnessExperiments: { semanticGrep: true, embeddingModel: "hosted" } } }));
  assert.equal(active.find((node) => node.type === "select").props.value, "hosted");
  assert.match(JSON.stringify(active), /Indexed file contents and search queries are sent/);
});
