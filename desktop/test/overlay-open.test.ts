import test from "node:test";
import assert from "node:assert/strict";
import { PILL_SIZE, pillLayout, popoutLayout } from "../main/overlay";

const display = { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1392 } };

test("Windows Quick Ask opens the island beside the parked chip, not the bare chip", () => {
  const parked = pillLayout(display);
  assert.deepEqual(parked, { x: 2500, y: 16, width: PILL_SIZE, height: PILL_SIZE });
  const opened = popoutLayout(display, parked);
  assert.deepEqual(opened.bounds, { x: 1940, y: 16, width: 620, height: 125 });
  assert.equal(opened.bounds.height, opened.base);
  assert.notDeepEqual(opened.bounds, parked);
});

test("Windows Quick Ask follows the chip once it has been dragged", () => {
  assert.deepEqual(popoutLayout(display, pillLayout(display, { x: 40, y: 900 })).bounds, { x: 20, y: 900, width: 620, height: 125 });
  assert.deepEqual(popoutLayout(display, pillLayout(display, { x: 9000, y: 9000 })).bounds, { x: 1940, y: 1267, width: 620, height: 125 });
});
