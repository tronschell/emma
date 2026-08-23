import test from "node:test";
import assert from "node:assert/strict";
import { NAV_VIEWS, ordered, validatePaneLayout } from "../src/layout";

/// A stored order is a preference over a list that moves under it: sections ship in
/// releases, folders are granted and forgotten. Anything the order does not name
/// still has to be drawn, or dragging one row hides every row minted after it.
test("a saved order arranges what it names and keeps what it does not", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(ordered(items, ["c", "a", "b"]).map((item) => item.id), ["c", "a", "b"]);
  assert.deepEqual(ordered(items, ["c"]).map((item) => item.id), ["c", "a", "b"]);
  assert.deepEqual(ordered(items, ["gone", "b"]).map((item) => item.id), ["b", "a", "c"]);
  assert.deepEqual(ordered(items, []).map((item) => item.id), ["a", "b", "c"]);
});

test("localStorage is not trusted to hold section ids", () => {
  const layout = validatePaneLayout({ navOrder: ["research", "research", "nope", 7, "threads"], projectOrder: ["f1", "", "f2"] });
  assert.deepEqual(layout.navOrder, ["research", "threads"]);
  assert.deepEqual(layout.projectOrder, ["f1", "f2"]);
  assert.deepEqual(validatePaneLayout({ navOrder: "threads" }).navOrder, []);
  assert.deepEqual(validatePaneLayout(null).navOrder, []);
  assert.ok(NAV_VIEWS.every((view) => validatePaneLayout({ navOrder: [...NAV_VIEWS] }).navOrder.includes(view)));
});
