import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { grepArgv, ripgrepArgv, runSearch } from "../main/search";
import { FolderStore } from "../main/folders";
import { describeToolCall, parseToolArgs } from "../main/tools";

const vendored = path.join(__dirname, "..", "..", "vendor", "rg");

function tree() {
  const root = mkdtempSync(path.join(tmpdir(), "emma-search-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "a.ts"), "const needle = 1;\nconst other = 2;\n");
  writeFileSync(path.join(root, "src", "b.rs"), "// NEEDLE lives here too\n");
  writeFileSync(path.join(root, "notes.md"), "no match in here\n");
  return root;
}

test("a search finds the same lines through ripgrep and through the grep fallback", async () => {
  const root = tree();
  const query = { pattern: "needle", literal: false, ignoreCase: false };
  const found = await runSearch(root, query, vendored);
  assert.match(found, /src\/a\.ts:1:const needle/);
  // The rust file only has NEEDLE, so case matters until it is told not to.
  assert.ok(!found.includes("b.rs"));
  assert.match(await runSearch(root, { ...query, ignoreCase: true }, vendored), /b\.rs/);
  // A binary that is not there is an ENOENT, which is the fallback's whole trigger.
  const fallback = await runSearch(root, query, path.join(root, "no-such-rg"));
  assert.match(fallback, /src\/a\.ts:1:const needle/);
  // Both engines answer "nothing found" rather than failing.
  assert.match(await runSearch(root, { ...query, pattern: "haystack" }, vendored), /No matches/);
  assert.match(await runSearch(root, { ...query, pattern: "haystack" }, "definitely-not-a-binary"), /No matches/);
});

test("path and glob narrow the search, in both engines' spelling", async () => {
  const root = tree();
  const query = { pattern: "needle", literal: false, ignoreCase: true };
  assert.ok(!(await runSearch(root, { ...query, glob: "*.rs" }, vendored)).includes("a.ts"));
  assert.match(await runSearch(root, { ...query, path: "src/b.rs" }, vendored), /b\.rs/);
  assert.ok(ripgrepArgv({ ...query, glob: "*.rs" }).includes("--glob"));
  assert.ok(grepArgv({ ...query, glob: "*.rs" }).includes("--include=*.rs"));
  // The pattern never reaches a shell, but it must never be read as a flag either.
  assert.deepEqual(ripgrepArgv({ pattern: "-v", literal: false, ignoreCase: false }).slice(-4), ["--regexp", "-v", "--", "."]);
  assert.deepEqual(grepArgv({ pattern: "-v", literal: false, ignoreCase: false }).slice(-4), ["-e", "-v", "--", "."]);
});

test("a search path cannot climb out of the granted folder", () => {
  const root = tree();
  const folders = new FolderStore(mkdtempSync(path.join(tmpdir(), "emma-store-")));
  const grant = folders.add(root)[0].id;
  assert.equal(folders.within(grant, "src"), "src");
  assert.equal(folders.within(grant, "."), ".");
  assert.throws(() => folders.within(grant, "../.."), /outside/);
  assert.throws(() => folders.within(grant, "/etc"), /relative/);
});

test("the ripgrep tool's arguments are checked before anything spawns", () => {
  const parse = (args: unknown) => parseToolArgs("ripgrep", JSON.stringify(args));
  assert.deepEqual(parse({ pattern: "fn main" }), { name: "ripgrep", folder: undefined, pattern: "fn main", path: undefined, glob: undefined, literal: false, ignoreCase: false });
  assert.throws(() => parse({}), /pattern/);
  assert.throws(() => parse({ pattern: "x", literal: "yes" }), /true or false/);
  assert.equal(describeToolCall(parse({ pattern: "fn main" })), "searching for fn main");
});
