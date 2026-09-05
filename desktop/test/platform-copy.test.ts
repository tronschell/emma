import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { localDevice, overlayLabel } from "../shared/platform-copy";

const mainSource = () => readFileSync(path.join(__dirname, "../../main/main.ts"), "utf8");

test("platform copy names the local machine and the overlay", () => {
  assert.equal(localDevice("darwin"), "Mac");
  assert.equal(localDevice("win32"), "PC");
  assert.equal(overlayLabel("darwin"), "the island");
  assert.equal(overlayLabel("win32"), "Quick Ask");
});

test("the phone approval copy reads on a Mac and hard-codes one nowhere", () => {
  const device = localDevice("darwin");
  assert.equal(`Approve on this ${device}`, "Approve on this Mac");
  assert.equal(`Emma will run this on your ${device} now, in /tmp:`, "Emma will run this on your Mac now, in /tmp:");
  assert.equal(`Nobody at your ${device} approved that command.`, "Nobody at your Mac approved that command.");
  assert.deepEqual(mainSource().match(/(?:this|your) Macs?\b/g), null);
});

test("the keybind and orb copy reads on a Mac", () => {
  const overlay = overlayLabel("darwin");
  assert.equal(`⌘1 while ${overlay} is open`, "⌘1 while the island is open");
  assert.equal(`Reveal commands under ${overlay} on a swipe`, "Reveal commands under the island on a swipe");
});

test("the macOS Look Up service is offered on macOS only", () => {
  assert.match(mainSource(), /selected && isMac \? \[\{ label: `Look Up/);
});
