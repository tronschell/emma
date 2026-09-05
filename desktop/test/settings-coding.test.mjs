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
  const bindings = {
    useSemanticGrepStatus: () => ({ available: true, folders: [] }),
    useZvecGrepStatus: () => ({ phase: "ready", version: "0.2.1", bytes: 0, total: 0, detail: "" }),
    ZvecGrepCard: "zvec-card",
    EmbeddingAdvice: "embedding-advice",
    EmbeddingKeyRow: "embedding-key",
    hostedEmbeddingModel: () => ({ credentialEnv: "HOSTED_KEY", id: "hosted", label: "Hosted" }),
    LOCAL_EMBEDDING_MODELS: [],
    HOSTED_EMBEDDING_MODELS: [],
  };
  const props = { settings: { harnessExperiments: { semanticGrep: false, embeddingModel: "hosted" } }, onChange: async () => {}, busy: false };
  const inactive = nodes(draw("SemanticGrepPanel", bindings, props));
  assert.ok(!inactive.some((node) => node.type === "select"));
  assert.ok(!inactive.some((node) => node.type === "zvec-card"));
  assert.doesNotMatch(JSON.stringify(inactive), /HOSTED_KEY/);
  const active = nodes(draw("SemanticGrepPanel", bindings, { ...props, settings: { harnessExperiments: { semanticGrep: true, embeddingModel: "hosted" } } }));
  assert.equal(active.find((node) => node.type === "select").props.value, "hosted");
  assert.ok(active.some((node) => node.type === "zvec-card"));
  assert.equal(active.find((node) => node.type === "embedding-key").props.model.credentialEnv, "HOSTED_KEY");
});

test("the zvec-grep card offers a download and the recommendation applies a model in one click", () => {
  const card = {
    LOCAL_DEVICE: "PC",
    RUNTIME_PLATFORM: "win32",
    sizeLabel: () => "440 MB",
    zvecGrepDownloadBytes: () => 1,
    zvecGrepPercent: () => 42,
    zvecGrepPhaseLabel: { missing: "Not downloaded", downloading: "Downloading", verifying: "Checking", extracting: "Unpacking", ready: "Installed", failed: "Failed" },
    zvecGrepProgressLabel: () => "42 MB of 440 MB",
  };
  const missing = nodes(draw("ZvecGrepCard", card, { tool: { phase: "missing", version: "0.2.1", bytes: 0, total: 0, detail: "" }, busy: false }));
  assert.equal(missing.filter((node) => node.type === "button").length, 1);
  assert.match(JSON.stringify(missing), /Download/);
  const busy = nodes(draw("ZvecGrepCard", card, { tool: { phase: "downloading", version: "0.2.1", bytes: 1, total: 2, detail: "" }, busy: false }));
  assert.match(JSON.stringify(busy), /Cancel/);
  assert.match(JSON.stringify(busy), /42 MB of 440 MB/);
  const failed = nodes(draw("ZvecGrepCard", card, { tool: { phase: "failed", version: "0.2.1", bytes: 0, total: 0, detail: "checksum did not match" }, busy: false }));
  assert.match(JSON.stringify(failed), /Retry/);
  assert.match(JSON.stringify(failed), /checksum did not match/);
  const ready = nodes(draw("ZvecGrepCard", card, { tool: { phase: "ready", version: "0.2.1", bytes: 0, total: 0, detail: "" }, busy: false }));
  assert.equal(ready.filter((node) => node.type === "button").length, 0);
  assert.match(JSON.stringify(ready), /Installed · v/);
  let used = "";
  const advice = nodes(draw("EmbeddingAdvice", {
    LOCAL_DEVICE: "PC",
    gigabytes: (bytes) => bytes,
    embeddingModelLabel: (id) => id,
    recommendEmbeddingModel: () => ({ id: "local/embeddinggemma-300m", reason: "plenty of video memory" }),
  }, { facts: { gpu: "NVIDIA GeForce RTX 5080", vramBytes: 16, memoryBytes: 64, cores: 24 }, chosen: "local/potion-code-16m-v2", busy: false, onUse: (id) => used = id }));
  assert.match(JSON.stringify(advice), /Recommended for this /);
  assert.match(JSON.stringify(advice), /NVIDIA GeForce RTX 5080/);
  advice.find((node) => node.type === "button").props.onClick();
  assert.equal(used, "local/embeddinggemma-300m");
});
