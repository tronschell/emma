import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverImports, registeredImportIds, saveImportManifest } from "../main/imports";
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

test("a folder is only connected from a phone once someone at the Mac has said so", () => {
  // folders.add is the grant, and a grant is the Mac's only boundary on file I/O. What the path
  // resolves to is a fact about the string; the answer from this Mac's own window is the consent.
  const body = caseBody("addFolder");
  const grant = body.indexOf("folders!.add(");
  assert.ok(grant > 0, "addFolder no longer grants anything");
  for (const guard of ["path.isAbsolute(asked)", "realpathSync(asked)", "isDirectory()", "pathInside(homedir(), directory)", "await confirmOnMac(", "if (!granted) throw new Error("]) {
    const at = body.indexOf(guard);
    assert.ok(at > 0 && at < grant, `addFolder grants the folder without ${guard} deciding first`);
  }
  // Held folders skip the question because they carry an earlier grant; nothing else may.
  assert.match(body, /const granted = held \|\| await confirmOnMac\(/);
});

test("a phone cannot bury the Mac under its own approval dialogs", () => {
  // Both questions quote strings the phone chose, and a modal is the one window nobody can click
  // past: unbounded text pushes the buttons off screen, and a frame per millisecond stacks modals
  // until the Mac cannot be used at all. A second question is refused, never queued.
  const body = source.slice(source.indexOf("async function confirmOnMac("), source.indexOf("function goalIpc("));
  assert.match(body, /if \(!mainWindow \|\| mainWindow\.isDestroyed\(\) \|\| confirming\) return false;/, "a dialog opens while another is still up");
  assert.match(body, /confirming = true;[\s\S]*finally \{\s*confirming = false;/, "a cancelled or thrown dialog leaves the Mac unable to ask again");
  assert.match(body, /message: clip\(message\)/, "the dialog's message is whatever length the phone sent");
  assert.match(body, /detail: clip\(detail\)/, "the dialog's detail is whatever length the phone sent");
  // A clip with no marker reads as the whole question, so padded argv hides the payload past 600.
  assert.match(body, /text\.length > MAX_DIALOG_CHARS[\s\S]*clipped\. Cancel unless this is exactly what you asked for/, "a clipped dialog says it was clipped");
});

test("a server a phone installs is approved at the Mac and holds no loader variable", () => {
  // installMcpServer is a command the Mac spawns on the next turn, so a well-formed definition is
  // still code execution. mcpServerRequest is the shared shape check; the ask is the consent.
  const body = caseBody("installMcpServer");
  const install = body.indexOf("capabilities!.installMcpServer(");
  assert.ok(install > 0, "installMcpServer no longer installs anything");
  for (const guard of ["mcpServerRequest(params)", "await confirmOnMac(", "if (!approved) throw new Error("]) {
    const at = body.indexOf(guard);
    assert.ok(at > 0 && at < install, `installMcpServer runs the server without ${guard} deciding first`);
  }
  const request = source.slice(source.indexOf("function mcpServerRequest("), source.indexOf("function bridgeVisual("));
  assert.match(request, /!isEnvName\(key\)/, "a server env key need not be an environment variable name");
  assert.match(request, /if \(LOADER_ENV\.test\(key\)\) throw new Error\(/, "a server env may still steer how programs are loaded");
  assert.ok(request.indexOf("LOADER_ENV.test(key)") < request.indexOf("return { name, command,"), "mcpServerRequest returns the definition before checking its env");
});

test("a scheduled task written from a phone cannot pick how much it may do", () => {
  // asPermissionMode makes any string a member of PERMISSION_MODES, which is the shape of a mode
  // and never a grant of one. The forced fields have to be in the object runRequest is handed.
  const body = caseBody("saveScheduledJob");
  const forwarded = body.indexOf("await runRequest(validateRequest(");
  assert.ok(forwarded > 0, "saveScheduledJob no longer reaches the host");
  assert.ok(body.indexOf("(await scheduledJobs()).find((job) => job.id === jobId)") < forwarded, "the task's own record is read after the write is forwarded");
  for (const forced of [
    /permissionMode: asPermissionMode\(existing\?\.permissionMode\)/,
    /sourceDomains: JSON\.stringify\(existing\?\.sourceDomains \?\? \[\]\)/,
    /model: existing\?\.model \?\? ""/,
  ]) assert.match(body.slice(0, forwarded + body.slice(forwarded).indexOf("}))")), forced, "a phone still chooses part of what a scheduled task may do");
});

test("a CLI turn from a phone cannot become a harness flag", () => {
  // shared/cli.ts appends the prompt as the last positional token with no "--" before it, so the
  // check has to stand in cliSendRequest, which is the one door both callers pass through.
  const request = source.slice(source.indexOf("function cliSendRequest("), source.indexOf("function recordedRevert("));
  assert.match(request, /if \(\/\^\\s\*-\/\.test\(candidate\.prompt\)\) throw new Error\(/);
  assert.ok(request.indexOf("test(candidate.prompt)") < request.indexOf("return { id, prompt"), "cliSendRequest hands the prompt back before checking it is one");
  for (const flag of ["--dangerously-skip-permissions", " --approval-mode=yolo", "-p"]) assert.match(flag, /^\s*-/);
  for (const prompt of ["carry on", "pass --force to the build"]) assert.doesNotMatch(prompt, /^\s*-/);
});

test("the phone's file reads and writes stay inside what this Mac granted", () => {
  const revert = caseBody("revertChange");
  const contained = revert.indexOf("escapesRoot(folders!.directory(folderId), file)");
  assert.ok(contained > 0 && contained < revert.indexOf("folders!.write("), "revertChange writes before it checks the path is in the folder");
  // Containment alone lets a phone choose the bytes of .git/hooks/pre-commit. The body written has
  // to be the one Emma recorded, resolved before the write and never read off params.
  const recorded = revert.indexOf("const before = recordedRevert(folderId, file);");
  assert.ok(recorded > 0 && recorded < revert.indexOf("folders!.write("), "revertChange writes before it looks up the change it is reverting");
  assert.match(revert, /folders!\.write\(folderId, file, before\)/);
  assert.doesNotMatch(revert, /params\.before/, "revertChange still writes a body off the wire");
  const lookup = source.slice(source.indexOf("function recordedRevert("), source.indexOf("async function confirmOnMac("));
  assert.match(lookup, /recorded\.before === null/, "a file Emma created can be reverted to a body it never had");
  assert.match(lookup, /agents!\.changes\(agent\.threadId\)/);

  const note = caseBody("readNote");
  const inVault = note.indexOf("noteInVault(vault, params.path)");
  assert.ok(inVault > 0 && inVault < note.indexOf("readFileSync("), "readNote opens a path it has not confined to the vault");
  // A note past the vault's own limit comes back cut rather than as an error the phone cannot act on.
  assert.match(note, /truncated: stats\.size > MAX_NOTE_BYTES/);
});

test("a phone can audit installed plugins, and trusting their hooks asks the Mac", () => {
  for (const method of ["listPlugins", "trustPluginHooks"]) {
    assert.ok(isBridgeMethod(method), `${method} is not a bridge method, so the bridge rejects it at the door`);
    assert.ok(source.includes(`    case "${method}"`), `bridgeDispatch has no ${method} case`);
  }
  const readOnly = new Set<string>(READ_ONLY_METHODS);
  assert.ok(readOnly.has("listPlugins"), "the audit list is a read, and a read-only phone must reach it");
  assert.ok(!readOnly.has("trustPluginHooks"), "trusting hooks writes and must not be listed read-only");

  const body = caseBody("trustPluginHooks");
  // A trusted hook is a shell line on every turn — the same reach installMcpServer buys, and it
  // asks the same way. Only the widening direction asks: a phone must always be able to withdraw.
  assert.match(body, /if \(trusted\) \{/, "the confirmation is not limited to the widening direction");
  assert.ok(body.indexOf("confirmOnMac(") < body.indexOf("await setHookTrust("), "trust is written before anyone at the Mac approves it");
  assert.match(body, /throw new Error\(`Nobody at your \$\{DEVICE\} approved those hooks\.`\)/);
  // The dialog has to quote this Mac's own copy: what the phone drew is a claim about the Mac.
  assert.match(body, /installedHooks\(userData\)/, "the dialog quotes the phone's hooks rather than the Mac's");
  // And it has to quote every declared hook, because the write hashes every declared hook. One
  // that Emma has no moment for is marked, not hidden — it is one RUNNABLE_HOOK_EVENTS entry away.
  assert.ok(body.includes('plugin.hooks.map((hook) => `${hook.event}${hookRuns(hook.event) ? "" : " (Emma has no such moment)"}: ${hook.command}`)'), "the dialog hides hooks the write still trusts");
  assert.match(body, /if \(!running\.length\) throw new Error\(/, "a plugin with nothing Emma would ever run still asks to be trusted");
  // Trust is stored per plugin id, every hash at once (marketplace.ts setHookTrust), so there
  // is no per-hook setter to offer and the params must not pretend otherwise.
  assert.doesNotMatch(body, /params\.hash|params\.hooks|params\.event/, "trustPluginHooks takes a per-hook selection the Mac cannot store");
});

test("the phone's import switchboard reads the manifest and registers, and authors nothing", () => {
  // Every string in a selection is an id from the table in imports.ts, and every path behind it was
  // already in the user's home — so the bound is the whole check, and it has to come first.
  const list = caseBody("listImportSources");
  assert.match(list, /registeredImportIds\(userData\)/, "the phone cannot see which sources are already registered");
  const body = caseBody("setImportSources");
  assert.match(body, /length > MAX_IMPORT_SOURCES/, "a selection may name any number of sources");
  assert.match(body, /some\(\(id\) => typeof id !== "string"\)/);
  assert.ok(body.indexOf("throw new Error") < body.indexOf("saveImportManifest("), "setImportSources writes the manifest before checking the selection");
  // Without this the skills and servers just registered stay invisible to listToolTargets.
  assert.ok(body.indexOf("await toolsChanged();") > body.indexOf("saveImportManifest("), "setImportSources leaves the tool lists stale");
  // Registering a source makes the harness spawn every command its config names, so a source
  // arriving for the first time asks the Mac — and only that direction does, or switching one off
  // from the couch would need somebody standing at the keyboard to say yes.
  assert.match(body, /const adding = \(ids as string\[\]\)\.filter\(\(id\) => !known\.includes\(id\)\)/, "setImportSources cannot tell a source being added from one being kept");
  assert.match(body, /if \(adding\.length\) \{/, "the confirmation is not limited to the widening direction");
  assert.ok(body.indexOf("confirmOnMac(") < body.indexOf("saveImportManifest("), "setImportSources registers a new source before anyone at the Mac approves it");
  const readOnly = new Set<string>(READ_ONLY_METHODS);
  assert.ok(readOnly.has("listImportSources"), "discovery is a read");
  assert.ok(!readOnly.has("setImportSources"), "registering sources writes and must not be listed read-only");
});

test("a manifest written from a phone is the whole selection, and a source it omits is dropped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "emma-imports-"));
  try {
    const userData = path.join(root, "user-data");
    await mkdir(path.join(root, ".cursor", "skills", "review"), { recursive: true });
    await writeFile(path.join(root, ".cursor", "skills", "review", "SKILL.md"), "---\nname: review\n---\nRead it twice.");
    await writeFile(path.join(root, ".claude.json"), "{}\n");

    const found = await discoverImports(root);
    assert.equal(found.find((source) => source.id === "cursor")?.skills, 1);
    assert.equal(found.find((source) => source.id === "claude")?.mcpConfigs, 1);
    assert.equal(found.find((source) => source.id === "devin")?.locations.length, 0, "a source with nothing to import still reports itself, with nowhere to read");

    // What the phone's switches render against: nothing is registered until someone asks for it.
    assert.deepEqual(await registeredImportIds(userData), []);
    // The manifest keeps the table's order, not the selection's, so the phone compares sets.
    assert.deepEqual(await saveImportManifest(userData, root, ["cursor", "claude"]), ["claude", "cursor"]);
    assert.deepEqual(await registeredImportIds(userData), ["claude", "cursor"]);
    // The manifest is replaced, never merged — which is why the phone sends every source it keeps.
    assert.deepEqual(await saveImportManifest(userData, root, ["claude"]), ["claude"]);
    assert.deepEqual(await registeredImportIds(userData), ["claude"]);
    await assert.rejects(saveImportManifest(userData, root, ["evil"]), /invalid/, "an id outside the table was accepted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the default-mode mirror is wired end to end in main, and still has nobody writing to it", () => {
  // The picker lives in the renderer and persists to localStorage, so main can only answer with a
  // mirror. The channel and the preload line exist, but no renderer calls setDefaultMode yet —
  // desktop/src is another owner's — so `defaultMode` is still the constant on every Mac. Until a
  // renderer seeds it, getSettings answers "ask" no matter what the picker says, which is why no
  // phone screen names this value. Delete the last assertion here when that caller lands.
  assert.match(source, /ipcMain\.handle\("emma:set-default-mode", \(event, value: unknown\) => \{\s*panelSender\(event\);\s*defaultMode = asPermissionMode\(value\);/);
  assert.match(source, /defaultPermissionMode: defaultMode,/);
  assert.match(source, /gate: toolGate\(defaultMode, tool\.name\)/, "the phone's tool catalog is still gated against the constant");
  assert.doesNotMatch(source, /defaultPermissionMode: DEFAULT_PERMISSION_MODE,/);
  assert.match(readFileSync(path.join(__dirname, "../../main/preload.ts"), "utf8"), /setDefaultMode: \(value: unknown\) => ipcRenderer\.invoke\("emma:set-default-mode", value\)/);
  assert.doesNotMatch(readFileSync(path.join(__dirname, "../../src/App.tsx"), "utf8"), /setDefaultMode\(/, "a renderer now seeds the mirror — retitle this test and let the phone name the value again");
});
