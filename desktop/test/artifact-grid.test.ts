import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const source = ts.createSourceFile("artifacts.tsx", readFileSync(path.join(__dirname, "../../src/artifacts.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

test("grid preview gating releases every distant frame and keeps fallback eager", () => {
  const view = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "ArtifactsView");
  assert.ok(view);
  const card = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "GridCard");
  assert.ok(card);
  assert.match(view.getText(source), /shown\.map\(\(meta\) => <GridCard/);
  assert.match(card.getText(source), /const \[target, nearViewport\] = useNearViewport\(\);/);
  assert.match(card.getText(source), /nearViewport \? <GridPreview meta=\{meta\} \/> : <div className="artifact-clip artifact-clip-lazy" inert \/>/);
  const hook = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "useNearViewport");
  assert.ok(hook);
  const fallbackScope = {
    useState: (initial: boolean | (() => boolean)) => [typeof initial === "function" ? initial() : initial, () => undefined] as const,
    useRef: () => ({ current: null }),
    useEffect: (effect: () => unknown) => { effect(); },
    IntersectionObserver: undefined,
    GRID_PREVIEW_MARGIN: "400px",
  };
  const useNearViewport = Function(...Object.keys(fallbackScope), `${ts.transpile(hook.getText(source), { target: ts.ScriptTarget.ES2022 })}; return useNearViewport;`)(...Object.values(fallbackScope)) as () => [unknown, boolean];
  assert.equal(useNearViewport()[1], true);
  const text = source.getFullText();
  assert.match(text, /new IntersectionObserver/);
  assert.match(text, /loading="lazy"/);
  assert.ok(text.includes('<div className="artifact-clip artifact-clip-lazy" inert />'));
  assert.ok(text.includes('return <div className="artifact-clip" inert>'));
  assert.doesNotMatch(text, /return <div className="artifact-clip artifact-clip-lazy"/);
  assert.ok(text.includes('{error && <p className="dialog-error">{error}</p>}'));
  assert.match(text, /onEditError=\{\(\) => setError\("That artifact could not be opened for editing\."\)\}/);
  assert.match(text, /\.catch\(onEditError\)/);
});
