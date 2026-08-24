import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { defaultVaultRoot, vaultReady } from "../main/setup";
import { privacySettingsUrl, SETUP_PERMISSIONS } from "../shared/setup";
import { DEFAULT_VAULT_FOLDER, type VaultChoice } from "../shared/vault";

const workspace = () => mkdtempSync(path.join(tmpdir(), "emma-setup-"));

test("only the permissions Emma asks for open a settings pane", () => {
  for (const permission of SETUP_PERMISSIONS) {
    assert.equal(privacySettingsUrl(permission.id), `x-apple.systempreferences:${permission.pane}`);
    assert.match(permission.pane, /^com\.apple\.preference\.[a-z]+(\?[A-Za-z_]+)?$/);
  }
  assert.throws(() => privacySettingsUrl("Privacy_AllFiles"), /not a permission/);
  assert.throws(() => privacySettingsUrl(undefined), /not a permission/);
});

test("the vault picker opens where a person keeps documents", () => {
  assert.equal(defaultVaultRoot(), path.join(homedir(), "Documents"));
});

test("readiness is answered by writing, so a vault Emma cannot write reads as denied", { skip: process.getuid?.() === 0 && "root writes anywhere" }, () => {
  const root = path.join(workspace(), "Second Brain");
  mkdirSync(root, { mode: 0o500 });
  const vault: VaultChoice = { root, folder: DEFAULT_VAULT_FOLDER, kind: "folder", name: "Second Brain" };
  assert.equal(vaultReady(vault), false);
  chmodSync(root, 0o700);
  assert.equal(vaultReady(vault), true);
  assert.deepEqual(readdirSync(path.join(root, DEFAULT_VAULT_FOLDER)), [], "the probe leaves nothing behind");
  assert.equal(vaultReady(null), true, "nothing is denied before a vault is chosen");
});
