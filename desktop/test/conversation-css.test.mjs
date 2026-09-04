import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("transcript containment is disabled for print", () => {
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles/conversation.css"), "utf8");
  assert.match(css, /\.message\s*\{\s*content-visibility:\s*auto;\s*contain-intrinsic-size:\s*auto\s+180px;\s*\}/);
  assert.match(css, /@media\s+print\s*\{\s*\.message\s*\{\s*content-visibility:\s*visible;\s*\}\s*\}/);
});
