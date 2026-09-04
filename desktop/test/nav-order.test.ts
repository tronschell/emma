import test from "node:test";
import assert from "node:assert/strict";
import { NAV_VIEWS, ordered, validatePaneLayout } from "../src/layout";

test("a saved order arranges what it names and keeps what it does not", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(ordered(items, ["c", "a", "b"]).map((item) => item.id), ["c", "a", "b"]);
  assert.deepEqual(ordered(items, ["c"]).map((item) => item.id), ["c", "a", "b"]);
  assert.deepEqual(ordered(items, ["gone", "b"]).map((item) => item.id), ["b", "a", "c"]);
  assert.deepEqual(ordered(items, []).map((item) => item.id), ["a", "b", "c"]);
});

test("localStorage is not trusted to hold section ids", () => {
  const layout = validatePaneLayout({ navOrder: ["research", "plugins", "plugins", "nope", 7, "knowledge"], projectOrder: ["f1", "", "f2"] });
  assert.deepEqual(layout.navOrder, ["plugins", "knowledge"]);
  assert.deepEqual(layout.projectOrder, ["f1", "f2"]);
  assert.deepEqual(validatePaneLayout({ navOrder: "knowledge" }).navOrder, []);
  assert.deepEqual(validatePaneLayout(null).navOrder, []);
  assert.equal(validatePaneLayout({ projectSort: "priority" }).projectSort, "priority");
  assert.equal(validatePaneLayout({ projectSort: "nope" }).projectSort, "project");
  assert.ok(NAV_VIEWS.every((view) => validatePaneLayout({ navOrder: [...NAV_VIEWS] }).navOrder.includes(view)));
});
