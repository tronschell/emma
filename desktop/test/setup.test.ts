import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { knowledgeDirWritable, readKnowledgeDir, saveKnowledgeDir } from "../main/setup";
import { privacySettingsUrl, SETUP_PERMISSIONS } from "../shared/setup";

const workspace = () => mkdtempSync(path.join(tmpdir(), "emma-setup-"));

test("only the permissions Emma asks for open a settings pane", () => {
  for (const permission of SETUP_PERMISSIONS) {
    assert.equal(privacySettingsUrl(permission.id), `x-apple.systempreferences:com.apple.preference.security?${permission.pane}`);
  }
  assert.throws(() => privacySettingsUrl("Privacy_AllFiles"), /not a permission/);
  assert.throws(() => privacySettingsUrl(undefined), /not a permission/);
});

test("the chosen knowledge folder survives a restart, and a relative one is refused", () => {
  const userData = workspace();
  const chosen = path.join(workspace(), "Second Brain");
  assert.equal(readKnowledgeDir(userData), process.env.EMMA_KNOWLEDGE_DIR ?? path.join(process.env.HOME ?? "", "Documents", "Emma Knowledge"));
  assert.equal(saveKnowledgeDir(userData, chosen), chosen);
  assert.equal(readKnowledgeDir(userData), chosen);
  assert.ok(readdirSync(chosen).length === 0, "the folder is created, empty");
  assert.throws(() => saveKnowledgeDir(userData, "Documents/Emma"), /full path/);
});

test("writability is answered by writing, so a folder Emma cannot write reads as denied", { skip: process.getuid?.() === 0 && "root writes anywhere" }, () => {
  const root = workspace();
  const locked = path.join(root, "locked");
  assert.equal(knowledgeDirWritable(locked), true);
  chmodSync(locked, 0o500);
  assert.equal(knowledgeDirWritable(locked), false);
  assert.equal(readdirSync(locked).length, 0, "the probe file is taken away again");
  // An empty path is the mirror switched off, which nothing can deny.
  assert.equal(knowledgeDirWritable(""), true);
});
