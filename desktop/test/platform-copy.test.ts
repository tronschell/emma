import test from "node:test";
import assert from "node:assert/strict";
import { localDevice, overlayLabel } from "../shared/platform-copy";

test("platform copy names the local machine and the overlay", () => {
  assert.equal(localDevice("darwin"), "Mac");
  assert.equal(localDevice("win32"), "PC");
  assert.equal(overlayLabel("darwin"), "the island");
  assert.equal(overlayLabel("win32"), "Quick Ask");
});
