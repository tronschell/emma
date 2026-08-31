import { spawn } from "node:child_process";
import process from "node:process";
import { commandShimArguments, windowsSystemExecutable } from "./windows-command.mjs";

const run = (command, args, env = process.env) => {
  if (process.platform === "win32" && /\.cmd$/i.test(command)) {
    return spawn(process.env.ComSpec ?? "cmd.exe", commandShimArguments(command, args), { stdio: "inherit", env, windowsHide: true, windowsVerbatimArguments: true });
  }
  return spawn(command, args, { stdio: "inherit", env });
};
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const stopTree = (child) => {
  if (process.platform !== "win32" || child.pid === undefined) {
    child.kill("SIGTERM");
    return Promise.resolve();
  }
  const taskkill = windowsSystemExecutable("taskkill.exe");
  return new Promise((resolve) => {
    const killer = spawn(taskkill, ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    const finish = () => resolve();
    killer.once("close", finish);
    killer.once("error", () => {
      try { child.kill("SIGTERM"); } catch { resolve(); return; }
      resolve();
    });
  });
};
const native = run(npm, ["run", "build:host"]);
native.on("exit", (code) => {
  if (code) process.exit(code);
  const helpers = run(npm, ["run", "build:native"]);
  helpers.on("exit", (helperCode) => {
    if (helperCode) process.exit(helperCode);
    const main = run(npm, ["run", "build:main"]);
    main.on("exit", (mainCode) => {
      if (mainCode) process.exit(mainCode);
      const vite = run(npm, ["exec", "vite", "--", "--host", "127.0.0.1"]);
      globalThis.setTimeout(() => {
        const electron = run(npm, ["exec", "electron", "."], { ...process.env, EMMA_DEV_SERVER_URL: "http://127.0.0.1:5173" });
        electron.on("exit", (electronCode) => {
          void stopTree(vite).finally(() => process.exit(electronCode ?? 0));
        });
      }, 800);
    });
  });
});
