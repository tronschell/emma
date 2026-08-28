import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const asked: string[] = [];
const resizes: { width?: number; height?: number }[] = [];
let broken = false;
const jpeg = Buffer.from("jpeg bytes");
const shrunk = { toJPEG: () => jpeg };
const shot = {
  isEmpty: () => false,
  getSize: () => ({ width: 3000, height: 2000 }),
  resize: (options: { width?: number; height?: number }) => { resizes.push(options); return shrunk; },
  toJPEG: () => jpeg,
};
const electron = {
  nativeImage: {
    createFromPath: (file: string) => {
      asked.push(file);
      if (broken) throw new Error("unsupported format");
      return shot;
    },
  },
};
const electronPath = require.resolve("electron");
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron } as unknown as NodeModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AttachmentStore, MAX_MODEL_IMAGE_BYTES, MAX_MODEL_IMAGE_EDGE }: typeof import("../main/attachments") = require("../main/attachments");

const userData = () => mkdtempSync(path.join(tmpdir(), "emma-attachment-image-"));
const big = () => new Uint8Array(MAX_MODEL_IMAGE_BYTES + 1024);

test("an image too big for the model is downscaled once, and the original is left alone", () => {
  asked.length = 0;
  resizes.length = 0;
  const root = userData();
  const store = new AttachmentStore(root);
  const held = store.save("retina.png", big());

  const sent = store.forModel(held);
  assert.notEqual(sent, held.path);
  assert.equal(path.basename(sent), `${held.id}-model.jpg`);
  assert.deepEqual(readFileSync(sent), jpeg);
  assert.deepEqual(resizes, [{ width: MAX_MODEL_IMAGE_EDGE, height: Math.round(MAX_MODEL_IMAGE_EDGE * 2 / 3), quality: "good" }]);
  assert.equal(readFileSync(held.path).byteLength, MAX_MODEL_IMAGE_BYTES + 1024);

  assert.equal(store.forModel(held), sent);
  assert.equal(asked.length, 1);
});

test("an image already under the ceiling travels as it is, and a file nothing can decode falls back to it", () => {
  asked.length = 0;
  const root = userData();
  const store = new AttachmentStore(root);
  const small = store.save("thumb.png", new Uint8Array(2048));
  assert.equal(store.forModel(small), small.path);
  assert.equal(asked.length, 0);

  broken = true;
  const corrupt = store.save("corrupt.png", big());
  assert.equal(store.forModel(corrupt), corrupt.path);
  broken = false;

  const notes = path.join(root, "notes.md");
  writeFileSync(notes, "# not an image");
  const held = store.hold(notes);
  assert.equal(store.forModel(held), held.path);
});
