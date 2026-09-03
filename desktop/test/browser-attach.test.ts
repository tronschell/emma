import test from "node:test";
import assert from "node:assert/strict";

const electron = { app: { getPath: () => "/tmp" }, WebContentsView: class {} };
const electronPath = require.resolve("electron");
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron } as unknown as NodeModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { attached, browserCursorProgress }: typeof import("../main/browser") = require("../main/browser");

test("a browser the agent never attached to is a failure, not a page it can talk about", () => {
  assert.equal(attached({ text: "connected", code: 0, signal: null }, "connect"), undefined);
  assert.throws(() => attached({ text: "All CDP discovery methods failed", code: 1, signal: null }, "connect to Emma's browser"), /nothing was driven/);
  assert.throws(() => attached({ text: "All CDP discovery methods failed", code: 1, signal: null }, "connect to Emma's browser"), /All CDP discovery methods failed/);
  assert.throws(() => attached({ text: "", code: null, signal: "SIGKILL" }, "connect to Emma's browser"), /nothing was driven/);
});

test("the activity cursor lands where the agent clicked in the pane, or nowhere at all", () => {
  const pane = { x: 400, y: 300, width: 800, height: 600 };
  const progress = browserCursorProgress(pane, { x: 120.4, y: 60.6 }, "clicking @e1", 3, 7);
  assert.deepEqual(progress, { step: 0, actions: 3, action: "clicking @e1", cursor: { windowId: 7, bounds: pane, x: 520, y: 361 } });
  assert.equal(browserCursorProgress(pane, { x: 800, y: 10 }, "clicking", 1, 7), null);
  assert.equal(browserCursorProgress(pane, { x: 10, y: -1 }, "clicking", 1, 7), null);
  assert.equal(browserCursorProgress({ ...pane, width: 0 }, { x: 0, y: 0 }, "clicking", 1, 7), null);
  assert.equal(browserCursorProgress(pane, { x: 1, y: 1 }, "x".repeat(200), 1, 7)?.action.length, 80);
});
