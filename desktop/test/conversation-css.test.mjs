import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("transcript containment is disabled for print", () => {
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles/conversation.css"), "utf8");
  assert.match(css, /\.message \{ content-visibility: auto; contain-intrinsic-size: auto 180px; \}/);
  assert.match(css, /@media print \{\s*\.message \{ content-visibility: visible; \}\s*\}/);
});
