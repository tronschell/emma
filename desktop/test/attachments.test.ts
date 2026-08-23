import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AttachmentStore } from "../main/attachments";

const userData = () => mkdtempSync(path.join(tmpdir(), "emma-attachments-"));

test("a picked text file comes back whole, and only what was attached is readable", () => {
  const root = userData();
  const file = path.join(root, "rows.csv");
  writeFileSync(file, "name,count\nzig,2\n");
  const store = new AttachmentStore(root);
  const held = store.hold(file);
  assert.equal(store.read(held.id).text, "name,count\nzig,2\n");
  // The vision tool is given `held.path` and nothing else opens: `hold` keeps the
  // real path, so the spelling the model was handed is the spelling that passes.
  assert.equal(store.holds(held.path), true);
  assert.equal(store.holds(path.join(root, "elsewhere.csv")), false);
  assert.throws(() => store.read("not-an-attachment"));
});

test("a dropped file is written under userData and named by its own basename", () => {
  const root = userData();
  const store = new AttachmentStore(root);
  const held = store.save("../../escape.md", new TextEncoder().encode("# notes"));
  assert.equal(held.name, "escape.md");
  assert.equal(path.dirname(held.path), path.join(root, "attachments"));
  assert.deepEqual(readdirSync(path.join(root, "attachments")), [`${held.id}-escape.md`]);
  assert.equal(store.read(held.id).text, "# notes");
});

test("a picture carries its path instead of its bytes, and a binary file is refused", () => {
  const root = userData();
  const store = new AttachmentStore(root);
  const image = store.save("shot.png", new Uint8Array([137, 80, 78, 71, 0, 13]));
  assert.equal(store.read(image.id).text, undefined);
  assert.equal(store.read(image.id).path, image.path);
  const binary = store.save("blob.bin", new Uint8Array([1, 0, 2]));
  assert.throws(() => store.read(binary.id), /not a text file/);
});
