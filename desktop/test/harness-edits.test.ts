import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

test("ACP edits retain complete paths for review and revert", () => {
  execFileSync(process.execPath, [path.join(process.cwd(), "test/harness-edits.mjs")], { stdio: "pipe" });
});
