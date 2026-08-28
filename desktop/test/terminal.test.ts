import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MAX_TERMINAL_SELECTION_CHARS, MAX_TERMINAL_SELECTION_LINES, terminalSelection, terminalTitle } from "../shared/terminal";
import { defaultPaneLayout, validatePaneLayout } from "../src/layout";

test("a shell is named after the folder it was opened in", () => {
  assert.equal(terminalTitle("/Users/someone/Documents/emma"), "emma");
  assert.equal(terminalTitle("/Users/someone/Documents/emma/"), "emma");
  assert.equal(terminalTitle("/"), "shell");
  assert.equal(terminalTitle(`/tmp/${"a".repeat(41)}`), "shell");
});

test("a selection arrives as the lines that were drawn over, without the blank ones around them", () => {
  const picked = terminalSelection("\n\n  npm test   \r\n   \nok 334\n\n");
  assert.deepEqual(picked, { text: "  npm test\n\nok 334", lines: 3 });
});

test("selecting nothing but whitespace attaches nothing", () => {
  assert.equal(terminalSelection(""), null);
  assert.equal(terminalSelection("\n  \n\t\n"), null);
});

test("a runaway selection is cut off and says so, and still reports what was there", () => {
  const picked = terminalSelection(Array.from({ length: MAX_TERMINAL_SELECTION_LINES + 12 }, (_, index) => `line ${index}`).join("\n"));
  assert.ok(picked);
  assert.equal(picked.lines, MAX_TERMINAL_SELECTION_LINES + 12);
  assert.match(picked.text, /\n\[12 more lines not attached\]$/);
  assert.equal(picked.text.split("\n").length, MAX_TERMINAL_SELECTION_LINES + 1);
});

test("one very long line is cut to the character budget", () => {
  const picked = terminalSelection("x".repeat(MAX_TERMINAL_SELECTION_CHARS + 500));
  assert.ok(picked);
  assert.equal(picked.text.length, MAX_TERMINAL_SELECTION_CHARS);
});

test("the terminal opens shut, and a stored height outside the pane's range is pulled back into it", () => {
  assert.equal(defaultPaneLayout.terminalOpen, false);
  assert.equal(validatePaneLayout({}).terminalHeight, defaultPaneLayout.terminalHeight);
  assert.equal(validatePaneLayout({ terminalHeight: 5 }).terminalHeight, 120);
  assert.equal(validatePaneLayout({ terminalHeight: 9999 }).terminalHeight, 720);
  assert.equal(validatePaneLayout({ terminalOpen: "yes" }).terminalOpen, false);
  assert.equal(validatePaneLayout({ terminalOpen: true, terminalHeight: 300 }).terminalHeight, 300);
});

test("the terminal is a full-width row under the thread, not a fourth column", () => {
  const css = readFileSync(path.join(__dirname, "..", "..", "src", "styles", "conversation.css"), "utf8").split("\n");
  const layout = css.find((line) => line.startsWith(".thread-layout {"));
  const row = css.find((line) => line.startsWith(".terminal-row {"));
  assert.ok(layout && row);
  assert.match(layout, /grid-template-rows:\s*minmax\(0, 1fr\) min\(var\(--terminal-height, 0px\), 60%\)/);
  assert.match(row, /grid-column: 1 \/ -1/);
});

test("output that arrived during a failed replay is still written to the pane", () => {
  const source = readFileSync(path.join(__dirname, "..", "..", "src", "terminal.tsx"), "utf8");
  const replay = source.slice(source.indexOf("readTerminal(tab.id)"), source.indexOf("term.onData"));
  const failed = replay.slice(replay.indexOf(".catch("));
  assert.match(failed, /for \(const chunk of queued\) term\.write\(chunk\.data\)/);
  assert.match(failed, /queued\.length = 0/);
});
