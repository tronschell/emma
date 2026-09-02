import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isEnvName } from "../shared/settings";
import { isBridgeMethod, READ_ONLY_METHODS } from "../shared/mobile-protocol";

// bridgeDispatch lives inside main.ts, which cannot be imported without booting Electron, so the
// two things a phone must never be able to do are read off the source the way mobile.test.ts does.
const source = readFileSync(path.join(__dirname, "../../main/main.ts"), "utf8");
const caseBody = (method: string) => {
  const start = source.indexOf(`    case "${method}": {`);
  assert.ok(start > 0, `bridgeDispatch has no ${method} case`);
  return source.slice(start, source.indexOf("\n    case ", start + 1));
};

test("the phone's tool switches reach only the three disabled lists", () => {
  const body = caseBody("setToolSettings");
  for (const setting of ["advisor", "vision", "secret", "webSearch"]) {
    assert.doesNotMatch(body, new RegExp(`params\\.${setting}`), `setToolSettings lets a phone set ${setting}`);
    assert.doesNotMatch(body, new RegExp(`\\b${setting}:`), `setToolSettings writes ${setting}`);
  }
  for (const list of ["disabledTools", "disabledSkills", "disabledServers"]) {
    assert.match(body, new RegExp(`params\\.${list} \\?\\? toolSettings\\.${list}`), `setToolSettings drops ${list}`);
  }
  // The spread is what keeps the rest of the settings where the Mac put them.
  assert.match(body, /validateToolSettings\(\{\s*\.\.\.toolSettings,/);
});

test("a credential slot is refused unless it names an environment variable", () => {
  const slot = source.slice(source.indexOf("function credentialSlot("), source.indexOf("function mainWindowSender("));
  assert.match(slot, /if \(!isEnvName\(candidate\.env\)\) throw new Error\(/);
  assert.ok(isEnvName("OPENROUTER_API_KEY"));
  assert.ok(!isEnvName("MY KEY") && !isEnvName("9KEY") && !isEnvName("") && !isEnvName("PATH=x"));
});

test("a phone can only fill a slot this Mac already offers", () => {
  // isEnvName alone admits PATH and NODE_OPTIONS, and credentials.applyToEnv writes into this
  // process's own env, so the slot must be one credentialSlotsHeld() published.
  const body = caseBody("saveCredential");
  assert.match(body, /credentialSlotsHeld\(\)\.some\(\(held\) => held\.env === slot\.env\)/);
  assert.match(body, /throw new Error\(/);
  // The guard has to run before anything is written or the environment is touched.
  const guard = body.indexOf("credentialSlotsHeld()");
  for (const after of ["credentials!.set(", "credentials!.remove(", "startHost()", "recycleHarnesses()"]) {
    assert.ok(guard < body.indexOf(after), `saveCredential reaches ${after} before checking the slot`);
  }
});

test("every wave-2 bridge method is dispatchable, and only the read-only ones are read-only", () => {
  const added = ["keyStatus", "listCredentials", "saveCredential", "setZeroRetention", "getSettings", "listToolTargets", "setToolSettings", "installMcpServer", "readSkill", "writeSkill"];
  for (const method of added) {
    assert.ok(isBridgeMethod(method), `${method} is not a bridge method`);
    assert.ok(source.includes(`    case "${method}":`), `bridgeDispatch has no ${method} case`);
  }
  const readOnly = new Set<string>(READ_ONLY_METHODS);
  for (const method of ["keyStatus", "listCredentials", "getSettings", "listToolTargets", "readSkill"]) {
    assert.ok(readOnly.has(method), `${method} should be read-only`);
  }
  for (const method of ["saveCredential", "setZeroRetention", "setToolSettings", "installMcpServer", "writeSkill"]) {
    assert.ok(!readOnly.has(method), `${method} writes and must not be listed read-only`);
  }
});

test("no credential slot can steer how programs are loaded", () => {
  // credentialSlotsHeld() publishes every env already in the store, so a custom key named PATH
  // would make itself a valid slot. The name check has to stand on its own, for both callers.
  assert.match(source, /if \(LOADER_ENV\.test\(candidate\.env\)\) throw new Error\(/);
  const literal = /const LOADER_ENV = (\/.+\/i);/.exec(source);
  assert.ok(literal, "LOADER_ENV is not a regex literal any more");
  const loader = new RegExp(literal[1].slice(1, -2), "i");
  for (const env of ["PATH", "path", "NODE_OPTIONS", "NODE_PATH", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "ELECTRON_RUN_AS_NODE", "npm_config_node_gyp", "SHELL", "IFS"]) {
    assert.ok(loader.test(env), `${env} is accepted as a credential slot`);
  }
  for (const env of ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "BRAVE_API_KEY", "PATHOLOGY_KEY", "MY_LD_KEY"]) {
    assert.ok(!loader.test(env), `${env} is refused as a credential slot`);
  }
});

test("a folder is only connected from a phone once the path itself has been checked", () => {
  // folders.add is the grant. Everything that decides whether this path may be granted has to
  // have run by then, and it has to look at what the path resolves to, not at how it reads.
  const body = caseBody("addFolder");
  const grant = body.indexOf("folders!.add(");
  assert.ok(grant > 0, "addFolder no longer grants anything");
  for (const guard of ["path.isAbsolute(asked)", "realpathSync(asked)", "isDirectory()", "pathInside(homedir(), directory)"]) {
    const at = body.indexOf(guard);
    assert.ok(at > 0 && at < grant, `addFolder grants the folder without ${guard} deciding first`);
  }
});

test("the phone's file reads and writes stay inside what this Mac granted", () => {
  const revert = caseBody("revertChange");
  const contained = revert.indexOf("escapesRoot(folders!.directory(folderId), file)");
  assert.ok(contained > 0 && contained < revert.indexOf("folders!.write("), "revertChange writes before it checks the path is in the folder");

  const note = caseBody("readNote");
  const inVault = note.indexOf("noteInVault(vault, params.path)");
  assert.ok(inVault > 0 && inVault < note.indexOf("readFileSync("), "readNote opens a path it has not confined to the vault");
  // A note past the vault's own limit comes back cut rather than as an error the phone cannot act on.
  assert.match(note, /truncated: stats\.size > MAX_NOTE_BYTES/);
});
