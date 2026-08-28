import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { componentRoot, deleteComponent, listComponents, readComponent, setComponentAnchor, setComponentEnabled, writeComponent } from "../main/components";
import { parseAnchor } from "../shared/components";
import { parseToolArgs } from "../main/tools";

const userData = () => mkdtemp(path.join(tmpdir(), "emma-components-"));
const anchor = { selector: ".composer > div.composer-tray", label: "composer-tray" };

test("a component round-trips, and a rewrite keeps its place and counts up", async () => {
  const directory = await userData();
  try {
    const made = await writeComponent(directory, { title: "Token burn", code: "export default ({ h }) => () => h('b', null, 'hi')", anchor, sourceThreadId: "thread-1" });
    assert.equal(made.id, "token-burn");
    assert.equal(made.version, 1);
    assert.deepEqual(made.anchor, anchor);
    assert.equal(await readFile(path.join(componentRoot(directory), "token-burn", "module.js"), "utf8"), made.code);

    const again = await writeComponent(directory, { id: "token-burn", title: "Token burn", code: "export default ({ h }) => () => h('b', null, 'bye')" });
    assert.equal(again.version, 2);
    assert.deepEqual(again.anchor, anchor, "a rewrite leaves it where the user put it");
    assert.equal(again.createdAt, made.createdAt);
    assert.equal(again.sourceThreadId, "thread-1");
    assert.equal((await readComponent(directory, "token-burn")).code, again.code);

    const off = await setComponentEnabled(directory, "token-burn", false);
    assert.equal(off.disabled, true);
    assert.equal(off.version, 2, "switching one off is not a new version of it");
    assert.equal((await writeComponent(directory, { id: "token-burn", title: "Token burn", code: "export default () => () => null" })).disabled, true);

    await deleteComponent(directory, "token-burn");
    assert.deepEqual(await listComponents(directory), []);
    await assert.rejects(readComponent(directory, "token-burn"), /no component/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a component without a place, or with a made-up one, is refused", async () => {
  const directory = await userData();
  try {
    await assert.rejects(writeComponent(directory, { title: "Nowhere", code: "export default () => () => null" }), /place/);
    await assert.rejects(writeComponent(directory, { title: "Nowhere", code: "export default () => () => null", anchor: { selector: "", label: "" } }), /not a place/);
    assert.throws(() => parseAnchor({ selector: "<script>", label: "x" }), /not a place/);
    assert.equal(parseAnchor({ selector: ".composer" }).label, ".composer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("create and rewrite have to carry what they need", () => {
  assert.deepEqual(parseToolArgs("component", JSON.stringify({ action: "place", title: "Token burn" })), { name: "component", action: "place", id: undefined, title: "Token burn", code: undefined });
  assert.throws(() => parseToolArgs("component", JSON.stringify({ action: "create", code: "x" })), /title/);
  assert.throws(() => parseToolArgs("component", JSON.stringify({ action: "create", title: "x" })), /code/);
  assert.throws(() => parseToolArgs("component", JSON.stringify({ action: "rewrite", code: "x" })), /id/);
});

test("moving a component re-anchors it without making a new version", async () => {
  const directory = await userData();
  try {
    const made = await writeComponent(directory, { title: "Token burn", code: "export default () => () => null", anchor: { selector: "form.composer", label: "the composer" } });
    const moved = await setComponentAnchor(directory, made.id, { selector: "aside.inspector", label: "the context bar" });
    assert.deepEqual(moved.anchor, { selector: "aside.inspector", label: "the context bar" });
    assert.equal(moved.version, made.version, "a move is not a rewrite");
    assert.deepEqual((await readComponent(directory, made.id)).anchor, moved.anchor, "the move is on disk");
    await assert.rejects(setComponentAnchor(directory, made.id, { selector: "" }), /not a place/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
