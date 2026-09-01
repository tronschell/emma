import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FolderStore } from "../main/folders";
import { contextBlock, MAX_FOLDER_FILES, mergeSkillContext, slashName } from "../shared/folders";

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "emma-folders-"));
  const project = path.join(root, "project");
  mkdirSync(path.join(project, "notes"), { recursive: true });
  mkdirSync(path.join(project, "node_modules"), { recursive: true });
  writeFileSync(path.join(project, "readme.md"), "# hello");
  writeFileSync(path.join(project, "notes", "plan.txt"), "plan");
  writeFileSync(path.join(project, "photo.heic"), "binary");
  writeFileSync(path.join(project, "node_modules", "dep.js"), "skip me");
  writeFileSync(path.join(root, "secret.md"), "outside the grant");
  return { root, project, store: new FolderStore(root) };
}

test("a grant lists its text files and skips vendored and non-text ones", () => {
  const { project, store } = workspace();
  const [grant] = store.add(project);
  assert.deepEqual(store.files(grant.id).files.map((file) => file.path), ["notes/plan.txt", "readme.md"]);
  assert.equal(store.files(grant.id).total, 2);
  assert.equal(store.read(grant.id, "readme.md").text, "# hello");
});

test("a capped listing still counts every file it walked past", () => {
  const { project, store } = workspace();
  const many = path.join(project, "many");
  mkdirSync(many, { recursive: true });
  for (let index = 0; index < MAX_FOLDER_FILES + 20; index += 1) writeFileSync(path.join(many, `mod${index}.ts`), "export const v = 1;");
  const [grant] = store.add(project);
  const listing = store.files(grant.id);
  assert.equal(listing.files.length, MAX_FOLDER_FILES);
  assert.equal(listing.total, MAX_FOLDER_FILES + 22);
});

test("a missing optional file reads as empty rather than throwing", () => {
  const { project, store } = workspace();
  const [grant] = store.add(project);
  assert.deepEqual(store.read(grant.id, "AGENTS.md"), { path: "AGENTS.md", text: "", missing: true });
});

test("a read cannot escape the granted folder, and an unknown grant is refused", () => {
  const { project, store } = workspace();
  const [grant] = store.add(project);
  assert.throws(() => store.read(grant.id, "../secret.md"));
  assert.throws(() => store.read("not-a-grant", "readme.md"));
});

/* What the "Open in" row on the thread bar sends when it names no file: the editor
   is handed the project, and the same walk still refuses anything above it. */
test("the folder itself is a path inside the grant, and cannot be climbed out of", () => {
  const { project, store } = workspace();
  const [grant] = store.add(project);
  assert.equal(store.within(grant.id, "."), ".");
  assert.equal(path.join(store.directory(grant.id), store.within(grant.id, ".")), store.directory(grant.id));
  assert.throws(() => store.within(grant.id, "../secret.md"));
});

test("adding the same folder twice keeps one grant, and forgetting drops it", () => {
  const { project, store } = workspace();
  const [grant] = store.add(project);
  assert.equal(store.add(project).length, 1);
  assert.deepEqual(store.remove(grant.id), []);
});

test("the context block drops whole sections once its budget is gone", () => {
  const block = contextBlock([{ heading: "One", body: "a".repeat(50) }, { heading: "Two", body: "b".repeat(500) }], 200);
  assert.match(block, /## One/);
  assert.doesNotMatch(block, /## Two/);
  assert.match(block, /1 more attachment omitted/);
  assert.equal(contextBlock([]), "");
});

test("merged context stays inside the host's skill-context ceiling", () => {
  assert.equal(mergeSkillContext("files", "skill"), "files\n\nskill");
  assert.ok(new TextEncoder().encode(mergeSkillContext("x".repeat(90_000), "y".repeat(90_000))).length <= 64 * 1024);
});

test("a slash name is one word in the command alphabet", () => {
  assert.equal(slashName("notes/my plan (final).md"), "my-plan-final-.md");
  assert.equal(slashName("///"), "file");
});
