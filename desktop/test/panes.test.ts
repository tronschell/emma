import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const rule = (file: string, selector: string) => readFileSync(path.join(__dirname, "..", "..", "src", "styles", file), "utf8")
  .split("\n").find((line) => line.startsWith(`${selector} {`));

/// Every band in the thread pane centres itself on `(100% - --content-column) / 2`,
/// so the pane's own column has to be pinned rather than `auto`: an auto track
/// sizes to its widest child, and one nowrap band — a failed turn's
/// "Not sent · <the whole prompt>" — grew the track wide enough to carry the
/// title, the transcript and the composer off under the inspector.
test("the thread panes pin their single column, so no child can widen them", () => {
  for (const [file, selector] of [["conversation.css", ".conversation"], ["agents.css", ".thread-column"]]) {
    const declared = rule(file, selector);
    assert.ok(declared, `${selector} not found in ${file}`);
    assert.match(declared, /grid-template-columns:\s*minmax\(0, 1fr\)/, `${selector} must pin its column`);
  }
});
