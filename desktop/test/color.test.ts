import test from "node:test";
import assert from "node:assert/strict";
import { hexHsv, hsvHex } from "../shared/color";

test("hex and HSV round-trip through the colour well", () => {
  for (const hex of ["#ff6a3d", "#ed7a9b", "#3fd8c0", "#000000", "#ffffff", "#808080"]) {
    assert.equal(hsvHex(...hexHsv(hex)), hex);
  }
  assert.deepEqual(hexHsv("#f00"), [0, 1, 1]);
  assert.deepEqual(hexHsv("nonsense"), [0, 0, 0]);
  assert.equal(hsvHex(360, 1, 1), "#ff0000");
});
