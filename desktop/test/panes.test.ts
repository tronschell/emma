import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const rule = (file: string, selector: string) => readFileSync(path.join(__dirname, "..", "..", "src", "styles", file), "utf8")
  .match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`))?.[1];

test("the thread panes pin their single column, so no child can widen them", () => {
  for (const [file, selector] of [["conversation.css", ".conversation"], ["agents.css", ".thread-column"]]) {
    const declared = rule(file, selector);
    assert.ok(declared, `${selector} not found in ${file}`);
    assert.match(declared, /grid-template-columns:\s*minmax\(\s*0\s*,\s*1fr\s*\)/, `${selector} must pin its column`);
  }
});
