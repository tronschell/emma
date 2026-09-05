import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const gif = readFileSync(path.join(__dirname, "../../assets/installer/emma-setup.gif"));
const packager = readFileSync(path.join(__dirname, "../../scripts/package-windows.mjs"), "utf8");

function readFrames() {
  const bits = (gif[10] & 7) + 1;
  let at = 13 + 3 * (1 << bits);
  const frames = [];
  while (at < gif.length && gif[at] !== 0x3b) {
    if (gif[at] === 0x21) {
      const label = gif[at + 1];
      at += 2;
      while (gif[at] !== 0) at += gif[at] + 1;
      at += 1;
      if (label === 0xf9) frames.push({ delay: gif.readUInt16LE(at - 4) });
      continue;
    }
    assert.equal(gif[at], 0x2c, `Unexpected GIF block 0x${gif[at].toString(16)} at ${at}`);
    assert.equal(gif.readUInt16LE(at + 5), 420);
    assert.equal(gif.readUInt16LE(at + 7), 260);
    assert.equal(gif[at + 9] & 0x80, 0, "Frames must reuse the global colour table.");
    at += 11;
    while (gif[at] !== 0) at += gif[at] + 1;
    at += 1;
  }
  return { bits, frames };
}

test("the installer splash is a looping GIF Squirrel can show", () => {
  assert.equal(gif.subarray(0, 6).toString("latin1"), "GIF89a");
  assert.equal(gif.readUInt16LE(6), 420);
  assert.equal(gif.readUInt16LE(8), 260);
  assert.equal(gif[10] & 0x80, 0x80, "The splash needs a global colour table.");
  const afterTable = 13 + 3 * (1 << ((gif[10] & 7) + 1));
  assert.equal(gif.subarray(afterTable, afterTable + 3).toString("hex"), "21ff0b");
  assert.equal(gif.subarray(afterTable + 3, afterTable + 14).toString("latin1"), "NETSCAPE2.0");

  const { bits, frames } = readFrames();
  assert.equal(bits, 4, "The ported palette fits a 16-entry colour table.");
  assert.equal(frames.length, 4);
  for (const frame of frames) assert.equal(frame.delay, 40);
  assert.equal(gif[gif.length - 1], 0x3b);
});

test("the splash palette is the disk image's ink and paper", () => {
  const colours = new Set();
  for (let entry = 0; entry < 1 << ((gif[10] & 7) + 1); entry += 1) {
    colours.add(gif.subarray(13 + entry * 3, 16 + entry * 3).toString("hex"));
  }
  for (const ink of ["1c1b1e", "e481ad", "f3eef0", "aaa1a8", "f4156b"]) assert.ok(colours.has(ink), ink);
});

test("packaging hands the splash to Squirrel", () => {
  assert.match(packager, /const loadingGif = path\.join\(desktop, "assets\/installer\/emma-setup\.gif"\);/);
  assert.match(packager, /^\s*loadingGif,$/m);
});
