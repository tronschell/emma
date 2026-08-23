import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The module reaches for Electron's image decoder at call time; stub it before the module
// loads so the bundle walk and the icns parse can be exercised outside Electron.
const electron = { nativeImage: { createFromBuffer: () => ({}) } };
const electronPath = require.resolve("electron");
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron } as unknown as NodeModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { embeddedPng, iconFile }: typeof import("../main/editors") = require("../main/editors");

/** A PNG only as far as the parser reads it: signature, then IHDR's width and height. */
function png(side: number): Buffer {
  const bytes = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(side, 16);
  bytes.writeUInt32BE(side, 20);
  return bytes;
}

function icns(chunks: [string, Buffer][]): Buffer {
  const body = Buffer.concat(chunks.map(([type, payload]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(8 + payload.length, 4);
    return Buffer.concat([head, payload]);
  }));
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

function bundle(files: Record<string, Buffer | string>, plist?: string): string {
  const at = path.join(mkdtempSync(path.join(tmpdir(), "emma-editors-")), "Thing.app");
  mkdirSync(path.join(at, "Contents/Resources"), { recursive: true });
  if (plist !== undefined) writeFileSync(path.join(at, "Contents/Info.plist"), plist);
  for (const [name, data] of Object.entries(files)) writeFileSync(path.join(at, "Contents/Resources", name), data);
  return at;
}

/* The whole point of reading the icns ourselves: `app.getFileIcon` hands back one generic
   placeholder for every third-party bundle, so every mark in the row came out identical. */
test("the smallest PNG chunk at or above the mark size wins, and raw chunks are skipped", () => {
  const at = bundle({ "Thing.icns": icns([
    ["ic11", png(32)],                    // below the mark: upscaling it would blur
    ["ic04", Buffer.alloc(32, 0xff)],     // raw ARGB, not a PNG payload
    ["ic10", png(1024)],                  // what some apps lead with
    ["ic12", png(64)],                    // the one we want
  ]) }, "<key>CFBundleIconFile</key>\n<string>Thing</string>");
  const chosen = embeddedPng(iconFile(at)!);
  assert.equal(chosen?.readUInt32BE(16), 64);
});

test("with nothing at the mark size the largest chunk still beats no icon at all", () => {
  const at = bundle({ "Thing.icns": icns([["ic11", png(32)], ["is32", Buffer.alloc(16)]]) });
  assert.equal(embeddedPng(iconFile(at)!)?.readUInt32BE(16), 32);
});

test("the plist names the icns, and a bundle that names none still yields the one it ships", () => {
  const named = bundle({ "other.icns": icns([["ic12", png(64)]]), "icon.icns": icns([["ic12", png(64)]]) },
    "<key>CFBundleIconFile</key>\n<string>other.icns</string>");
  assert.equal(path.basename(iconFile(named)!), "other.icns");
  assert.equal(path.basename(iconFile(bundle({ "icon.icns": icns([["ic12", png(64)]]) }))!), "icon.icns");
  assert.equal(iconFile(bundle({})), undefined);
});
