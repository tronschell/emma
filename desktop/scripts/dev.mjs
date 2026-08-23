import { spawn } from "node:child_process";
import process from "node:process";

const run = (command, args, env = process.env) => spawn(command, args, { stdio: "inherit", env });
const native = run("npm", ["run", "build:host"]);
native.on("exit", (code) => {
  if (code) process.exit(code);
  const helpers = run("npm", ["run", "build:native"]);
  helpers.on("exit", (helperCode) => {
    if (helperCode) process.exit(helperCode);
    const main = run("npm", ["run", "build:main"]);
    main.on("exit", (mainCode) => {
      if (mainCode) process.exit(mainCode);
      const vite = run("npm", ["exec", "vite", "--", "--host", "127.0.0.1"]);
      globalThis.setTimeout(() => {
        const electron = run("npm", ["exec", "electron", "."], { ...process.env, EMMA_DEV_SERVER_URL: "http://127.0.0.1:5173" });
        electron.on("exit", (electronCode) => {
          vite.kill("SIGTERM");
          process.exit(electronCode ?? 0);
        });
      }, 800);
    });
  });
});
