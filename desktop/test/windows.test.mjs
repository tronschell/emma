import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalResetPath, commandShimArguments, pathInside, processTreeCommand, resetDataRoots, samePath, spawnCommand, squirrelEvent, terminateProcessTree, WINDOWS_APP_USER_MODEL_ID } from "../dist-main/main/platform.js";
import { commandShimArguments as packageCommandShimArguments, windowsSystemExecutable } from "../scripts/windows-command.mjs";
import { gitReady } from "../dist-main/main/git.js";
import { parseWindowsFrontContext } from "../dist-main/main/windows-front.js";
import { keybindLabel, validateKeybinds } from "../dist-main/shared/settings.js";

test("Squirrel lifecycle ignores firstrun and handles install events", () => {
  assert.equal(squirrelEvent(["Emma.exe", "--squirrel-firstrun"]), null);
  assert.equal(squirrelEvent(["Emma.exe", "--squirrel-install"]), "install");
  assert.equal(squirrelEvent(["Emma.exe", "--squirrel-updated"]), "updated");
  assert.equal(squirrelEvent(["Emma.exe", "--squirrel-uninstall"]), "uninstall");
  assert.equal(squirrelEvent(["Emma.exe", "--squirrel-obsolete"]), "obsolete");
});

test("Squirrel shortcut and Electron use the same app identity", () => {
  assert.equal(WINDOWS_APP_USER_MODEL_ID, "com.squirrel.Emma.Emma");
});

test("Windows command shims preserve metacharacters as argv", () => {
  const args = commandShimArguments("C:\\Program Files\\npm.cmd", ["a&b", "%PATH%", "x|y", "quote\"value"]);
  assert.deepEqual(args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(args[3], /\^+&/);
  assert.match(args[3], /\^+%/);
  assert.match(args[3], /\^+\|/);
  assert.throws(() => commandShimArguments("tool.cmd", ["line\nbreak"]), TypeError);
});

test("Windows dev tree-stop resolves only an absolute System32 taskkill", () => {
  assert.equal(windowsSystemExecutable("taskkill.exe", { SystemRoot: "D:\\Windows" }), "D:\\Windows\\System32\\taskkill.exe");
  assert.equal(windowsSystemExecutable("taskkill.exe", { SystemRoot: "..\\Windows", WINDIR: "E:\\Windows" }), "E:\\Windows\\System32\\taskkill.exe");
  assert.equal(windowsSystemExecutable("taskkill.exe", { SystemRoot: "..\\Windows", WINDIR: "relative" }), "C:\\Windows\\System32\\taskkill.exe");
});

test("Windows process-tree termination uses absolute taskkill and reports helper failures", async () => {
  assert.deepEqual(processTreeCommand(421, "SIGKILL", "win32", { SystemRoot: "D:\\Windows" }), {
    executable: "D:\\Windows\\System32\\taskkill.exe",
    args: ["/pid", "421", "/t", "/f"],
  });
  const listeners = new Map();
  const taskkill = {
    killed: false,
    once(event, listener) {
      listeners.set(event, listener);
      return this;
    },
    kill() {
      this.killed = true;
    },
  };
  let invoked;
  const failed = await terminateProcessTree(421, "SIGKILL", true, "win32", (executable, args) => {
    invoked = { executable, args };
    queueMicrotask(() => listeners.get("error")?.(new Error("taskkill unavailable")));
    return taskkill;
  });
  assert.deepEqual(invoked.args, ["/pid", "421", "/t", "/f"]);
  assert.equal(failed, false);
  assert.equal(taskkill.killed, false);
  assert.equal(processTreeCommand(421, "SIGTERM", "darwin"), undefined);
});

test("Windows packaging command shims preserve spaces and metacharacters", () => {
  const args = packageCommandShimArguments("C:\\Program Files\\npm.cmd", ["run", "build", "a&b", "%PATH%", "quote\"value"]);
  assert.deepEqual(args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(args[3], /Program\^ Files/);
  assert.match(args[3], /\^+&/);
  assert.match(args[3], /\^+%/);
  assert.match(args[3], /quote\\\^+"/);
  assert.throws(() => packageCommandShimArguments("npm.cmd", ["line\nbreak"]), TypeError);
});

test("Windows command shims round-trip hostile argv without executing it", async () => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "emma-shim-"));
  const shim = path.join(root, "fixture.cmd");
  const marker = path.join(root, "injected.txt");
  const values = ["spaces here", "a&b", "x|y", "%PATH%", "!bang!", "^caret^", "(paren)", "quote\"value", "trailing\\", `& echo injected > ${marker}`];
  await writeFile(shim, `@echo off\r\n"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" %*\r\n`, "utf8");
  try {
    const settle = (child) => {
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      return once(child, "close").then(([code]) => ({ code, stdout, stderr }));
    };
    const runs = [
      settle(spawnCommand(shim, values, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })),
      settle(spawn(process.env.ComSpec ?? "cmd.exe", packageCommandShimArguments(shim, values), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false, windowsVerbatimArguments: true })),
    ];
    for (const run of runs) {
      const { code, stdout, stderr } = await run;
      assert.equal(code, 0, stderr);
      assert.deepEqual(JSON.parse(stdout), values);
    }
    await assert.rejects(readFile(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows front-window context accepts only bounded browser metadata", () => {
  const page = { application: "Microsoft Edge", window: "Emma docs", url: "https://example.com", title: "Emma docs" };
  assert.deepEqual(parseWindowsFrontContext(JSON.stringify({ front: page, browsers: [page] })), { front: page, browsers: [page] });
  assert.throws(() => parseWindowsFrontContext("not json"));
  assert.throws(() => parseWindowsFrontContext(JSON.stringify({ front: page, browsers: Array.from({ length: 65 }, () => page) })));
  assert.throws(() => parseWindowsFrontContext(JSON.stringify({ front: { ...page, title: "x".repeat(2049) }, browsers: [] })));
});

test("Windows keybinds normalize legacy Command and Control collisions", () => {
  const command = { accelerator: "Command+Alt+E", hold: "", ms: 0 };
  const control = { accelerator: "Control+Alt+E", hold: "", ms: 0 };
  assert.equal(keybindLabel(command, "win32"), "Ctrl+Alt+E");
  assert.throws(() => validateKeybinds({ toggle: command, voice: control }, "win32"), /bound twice/);
  assert.throws(() => validateKeybinds({ toggle: { accelerator: "Control+S", hold: "", ms: 0 } }, "win32"), /Ctrl with a single key/);
  assert.throws(() => validateKeybinds({ toggle: { accelerator: "Command+S", hold: "", ms: 0 } }, "win32"), /Ctrl with a single key/);
});

test("Windows path containment handles drive roots, UNC shares, and case", () => {
  assert.equal(pathInside("C:\\", "c:\\Users\\Emma\\notes", "win32"), true);
  assert.equal(pathInside("C:\\Users\\Emma", "c:\\users\\emma\\notes", "win32"), true);
  assert.equal(pathInside("C:\\Users\\Emma", "C:\\Users\\Emma2", "win32"), false);
  assert.equal(pathInside("C:\\Users\\Emma", "D:\\Users\\Emma", "win32"), false);
  assert.equal(pathInside("\\\\server\\share", "\\\\SERVER\\SHARE\\folder", "win32"), true);
  assert.equal(pathInside("\\\\server\\share", "\\\\server\\other\\folder", "win32"), false);
  assert.equal(samePath("C:\\Users\\Emma", "c:\\users\\emma", "win32"), true);
});

test("Windows native helpers embed the long-path manifest", () => {
  const build = readFileSync(new URL("../scripts/build-native.mjs", import.meta.url), "utf8");
  const manifest = readFileSync(new URL("../native/windows-helper.manifest", import.meta.url), "utf8");
  const paths = readFileSync(new URL("../native/windows_path.hpp", import.meta.url), "utf8");
  assert.match(build, /rc\.exe/);
  assert.match(build, /native\/windows-helper\.rc/);
  assert.equal((build.match(/resource,/g) ?? []).length, 5);
  assert.match(manifest, /<longPathAware [^>]+>true<\/longPathAware>/);
  assert.match(manifest, /<supportedOS Id="\{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a\}"\/>/);
  assert.match(manifest, /<dpiAwareness [^>]+>PerMonitorV2<\/dpiAwareness>/);
  assert.match(paths, /extended_length/);
  assert.match(paths, /without_extended_length/);
});

test("Reset data roots reject Windows protected locations and retain app descendants", () => {
  const environment = {
    USERPROFILE: "C:\\Users\\Emma",
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    ProgramW6432: "C:\\Program Files",
    ProgramData: "C:\\ProgramData",
    APPDATA: "C:\\Users\\Emma\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\Emma\\AppData\\Local",
    TEMP: "C:\\Users\\Emma\\AppData\\Local\\Temp",
    TMP: "C:\\Users\\Emma\\AppData\\Local\\Temp",
  };
  const userData = "C:\\Users\\Emma\\AppData\\Roaming\\Emma";
  for (const candidate of [
    "C:\\",
    "C:\\Users\\Emma",
    "C:\\Windows\\System32",
    environment.APPDATA,
    "C:\\Users\\Emma\\AppData",
    environment.LOCALAPPDATA,
    environment.TEMP,
    environment.ProgramFiles,
    "C:\\Program Files\\Emma",
    environment["ProgramFiles(x86)"],
    "C:\\Program Files (x86)\\Emma",
    "C:\\Windows\\Emma",
    environment.ProgramData,
    "C:\\ProgramData\\Emma",
  ]) assert.throws(() => resetDataRoots(userData, candidate, "win32", environment.USERPROFILE, environment), /Reset blocked/);
  assert.deepEqual(resetDataRoots(userData, undefined, "win32", environment.USERPROFILE, environment), [userData]);
  assert.deepEqual(resetDataRoots(userData, "C:\\Users\\Emma\\AppData\\Roaming\\Emma\\Extra", "win32", environment.USERPROFILE, environment), ["C:\\Users\\Emma\\AppData\\Roaming\\Emma\\Extra", userData]);
  assert.deepEqual(resetDataRoots(userData, "C:\\Users\\Emma\\AppData\\Local\\Temp\\Emma", "win32", environment.USERPROFILE, environment), ["C:\\Users\\Emma\\AppData\\Local\\Temp\\Emma", userData]);
  assert.deepEqual(resetDataRoots(userData, "c:\\users\\emma\\appdata\\roaming\\emma", "win32", environment.USERPROFILE, environment), ["c:\\users\\emma\\appdata\\roaming\\emma"]);
});

test("Reset canonical paths expose symlink targets before deletion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "emma-reset-canonical-"));
  const target = path.join(root, "target");
  const link = path.join(root, "link");
  await mkdir(target, { recursive: true });
  try {
    try {
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }
    const requested = path.join(link, "Emma");
    const canonical = canonicalResetPath(requested);
    assert.equal(canonical, canonicalResetPath(path.join(target, "Emma")));
    assert.equal(samePath(canonical, requested, process.platform), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows git execution does not use a repo-local shim", async () => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "emma-git-shadow-"));
  const previous = process.cwd();
  const marker = path.join(root, "executed.txt");
  await writeFile(path.join(root, "git.cmd"), "@echo off\r\n>\"%~dp0executed.txt\" echo ran\r\nexit /b 0\r\n", "utf8");
  try {
    process.chdir(root);
    assert.ok(["no-git", "no-repo", "ready"].includes(await gitReady(root)));
  } finally {
    process.chdir(previous);
  }
  await assert.rejects(readFile(marker));
  await rm(root, { recursive: true, force: true });
});
