import test from "node:test";
import assert from "node:assert/strict";

const electron = { app: { getPath: () => "/tmp" }, WebContentsView: class {} };
const electronPath = require.resolve("electron");
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron } as unknown as NodeModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { attached }: typeof import("../main/browser") = require("../main/browser");

test("a browser the agent never attached to is a failure, not a page it can talk about", () => {
  assert.equal(attached({ text: "connected", code: 0, signal: null }, "connect"), undefined);
  assert.throws(() => attached({ text: "All CDP discovery methods failed", code: 1, signal: null }, "connect to Emma's browser"), /nothing was driven/);
  assert.throws(() => attached({ text: "All CDP discovery methods failed", code: 1, signal: null }, "connect to Emma's browser"), /All CDP discovery methods failed/);
  assert.throws(() => attached({ text: "", code: null, signal: "SIGKILL" }, "connect to Emma's browser"), /nothing was driven/);
});
