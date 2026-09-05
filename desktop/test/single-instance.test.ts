import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { newerVersion } from "../shared/update";

const source = readFileSync(path.join(process.cwd(), "main/main.ts"), "utf8");
const startup = ts.transpileModule(source.slice(source.indexOf("const squirrelHandled ="), source.indexOf("if (primaryInstance) app.whenReady()")), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("a packaged duplicate explains its own version and path without touching the profile", () => {
  const calls: string[] = [];
  runInNewContext(startup, {
    handleSquirrelEvent: () => false,
    app: {
      isPackaged: true,
      requestSingleInstanceLock: (data: { version: string }) => { assert.equal(data.version, "0.5.0"); return false; },
      getVersion: () => "0.5.0",
      quit: () => calls.push("quit"),
    },
    isMac: true,
    path: path.posix,
    process: { execPath: "/Volumes/Emma/Emma.app/Contents/MacOS/Emma" },
    dialog: { showErrorBox: (title: string, detail: string) => {
      assert.equal(title, "Another copy of Emma is running");
      assert.match(detail, /Emma 0\.5\.0 at \/Volumes\/Emma\/Emma\.app could not start/);
      assert.match(detail, /Command-Q/);
      assert.match(detail, /Replacing the app keeps your settings and conversations/);
      calls.push("warning");
    } },
  });
  assert.deepEqual(calls, ["warning", "quit"]);
});

test("primary activation and development or non-Mac duplicate exits are unchanged", async () => {
  let opened = 0;
  let second: ((event?: unknown, argv?: unknown, cwd?: unknown, data?: unknown) => void) | undefined;
  runInNewContext(startup, {
    handleSquirrelEvent: () => false,
    app: {
      requestSingleInstanceLock: () => true,
      getVersion: () => "0.4.2",
      isPackaged: true,
      on: (event: string, listener: typeof second) => { assert.equal(event, "second-instance"); second = listener; },
      whenReady: () => Promise.resolve(),
    },
    openMain: () => { opened++; },
    isMac: true,
    newerVersion,
  });
  second!();
  await Promise.resolve();
  assert.equal(opened, 1);
  second!(undefined, undefined, undefined, { version: "0.5.0" });
  await Promise.resolve();
  assert.equal(opened, 1, "opening a newer copy must not focus the older primary");
  for (const data of [null, {}, { version: 5 }, { version: "0.4.2" }, { version: "0.3.1" }]) second!(undefined, undefined, undefined, data);
  await Promise.resolve();
  assert.equal(opened, 6);
  for (const [isMac, isPackaged] of [[true, false], [false, true]]) {
    let quit = false;
    runInNewContext(startup, {
      handleSquirrelEvent: () => false,
      app: { isPackaged, getVersion: () => "0.4.2", requestSingleInstanceLock: () => false, quit: () => { quit = true; } },
      isMac,
    });
    assert.equal(quit, true);
  }
});
