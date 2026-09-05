import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const icon = readFileSync(path.join(__dirname, "../../assets/emma.ico"));
const entries = Array.from({ length: icon.readUInt16LE(4) }, (_unused, index) => {
  const at = 6 + 16 * index;
  return {
    width: icon[at] || 256,
    height: icon[at + 1] || 256,
    planes: icon.readUInt16LE(at + 4),
    depth: icon.readUInt16LE(at + 6),
    image: icon.subarray(icon.readUInt32LE(at + 12), icon.readUInt32LE(at + 12) + icon.readUInt32LE(at + 8)),
  };
});

test("the Windows icon carries every size the taskbar and Explorer ask for", () => {
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.deepEqual(entries.map((entry) => entry.width), [16, 24, 32, 48, 64, 128, 256]);
  assert.deepEqual(entries.map((entry) => entry.height), entries.map((entry) => entry.width));
  for (const entry of entries) {
    assert.equal(entry.planes, 1);
    assert.equal(entry.depth, 32);
  }
});

test("the small entries are bitmaps with an AND mask and the largest is PNG", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const entry of entries.slice(0, -1)) {
    assert.equal(entry.image.readUInt32LE(0), 40, `${entry.width}px is not a BITMAPINFOHEADER`);
    assert.equal(entry.image.readInt32LE(4), entry.width);
    assert.equal(entry.image.readInt32LE(8), entry.height * 2, `${entry.width}px is missing its AND mask height`);
    assert.equal(entry.image.readUInt16LE(14), 32);
    assert.equal(entry.image.length, 40 + entry.width * entry.height * 4 + Math.ceil(entry.width / 32) * 4 * entry.height);
  }
  const largest = entries[entries.length - 1]!;
  assert.deepEqual(largest.image.subarray(0, 8), png);
  assert.equal(largest.image.readUInt32BE(16), 256);
  assert.equal(largest.image.readUInt32BE(20), 256);
});

test("the icon draws the pink bow rather than the macOS tile", () => {
  const smallest = entries[0]!;
  const pixels = smallest.image.subarray(40, 40 + smallest.width * smallest.height * 4);
  const drawn = new Set<string>();
  let opaque = 0;
  for (let at = 0; at < pixels.length; at += 4) {
    if (pixels[at + 3] === 0) continue;
    opaque += 1;
    drawn.add(`${pixels[at + 2]},${pixels[at + 1]},${pixels[at]}`);
  }
  assert.deepEqual([...drawn], ["244,21,107"]);
  assert.ok(opaque > 0 && opaque < smallest.width * smallest.height, "a tile fills the square; the bow does not");
});
