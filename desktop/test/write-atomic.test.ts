import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeAtomic } from "../main/write-atomic";

test("a failed atomic replacement preserves the original and removes its temporary file", async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "emma-write-atomic-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "record.md");
  await fs.writeFile(file, "original");
  const failure = new Error("rename failed");
  t.mock.method(fs, "rename", async () => { throw failure; });
  await assert.rejects(writeAtomic(file, "replacement"), (error) => error === failure);
  assert.equal(await fs.readFile(file, "utf8"), "original");
  assert.deepEqual(await fs.readdir(directory), ["record.md"]);
});
