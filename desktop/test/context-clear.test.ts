import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { clearedAt, markCleared, overlayMode, recordUses, setOverlayMode, threadUses } from "../src/context";
import { DEFAULT_PERMISSION_MODE } from "../shared/permissions";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

test("a thread nobody cleared carries its whole transcript", () => {
  store.clear();
  assert.equal(clearedAt("t1"), 0);
});

test("clearing cuts the transcript at the message it was asked on, per thread", () => {
  store.clear();
  markCleared("t1", 6);
  assert.equal(clearedAt("t1"), 6);
  assert.equal(clearedAt("t2"), 0);
  markCleared("t1", 9);
  assert.equal(clearedAt("t1"), 9);
});

test("clearing drops the segments the cleared turns had attached", () => {
  store.clear();
  recordUses("t1", [{ kind: "messages", label: "shot.png", chars: 4_000 }]);
  assert.equal(threadUses("t1").length, 1);
  markCleared("t1", 2);
  assert.deepEqual(threadUses("t1"), []);
});

test("a corrupt store reads as never cleared rather than throwing", () => {
  store.clear();
  store.set("emma.threadCleared.v1", "{ not json");
  assert.equal(clearedAt("t1"), 0);
  store.set("emma.threadCleared.v1", JSON.stringify({ t1: -3, t2: "six", t3: 1.5, t4: 4 }));
  assert.equal(clearedAt("t1"), 0);
  assert.equal(clearedAt("t2"), 0);
  assert.equal(clearedAt("t3"), 0);
  assert.equal(clearedAt("t4"), 4);
});

test("Quick Ask opens on the configured default and only remembers a mode once one is picked", () => {
  store.clear();
  assert.equal(overlayMode(), DEFAULT_PERMISSION_MODE);
  assert.equal(overlayMode("acceptEdits"), "acceptEdits");
  assert.equal(store.size, 0);

  setOverlayMode("full");
  assert.equal(overlayMode("acceptEdits"), "full");
  store.set("emma.overlayMode.v1", "nonsense");
  assert.equal(overlayMode("acceptEdits"), "acceptEdits");

  const island = readFileSync(path.join(__dirname, "../../src/App.tsx"), "utf8");
  assert.match(island, /overlayMode\(settings\.defaultPermissionMode\)/);
  assert.doesNotMatch(island, /setOverlayMode\(mode\)/);
});
