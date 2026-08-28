import test from "node:test";
import assert from "node:assert/strict";
import { modelSwitches, recordModelSwitch } from "../src/context";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

test("a thread nobody switched on has no marks", () => {
  store.clear();
  assert.deepEqual(modelSwitches("t1"), []);
});

test("each switch marks the turn it takes effect from, per thread", () => {
  store.clear();
  recordModelSwitch("t1", { at: 2, label: "opus", brand: "anthropic" });
  recordModelSwitch("t1", { at: 6, label: "gpt", brand: "openai" });
  recordModelSwitch("t2", { at: 1, label: "qwen", brand: "" });
  assert.deepEqual(modelSwitches("t1").map((mark) => mark.at), [2, 6]);
  assert.deepEqual(modelSwitches("t2").map((mark) => mark.label), ["qwen"]);
});

test("switching again before sending leaves only the model that answers", () => {
  store.clear();
  recordModelSwitch("t1", { at: 4, label: "opus", brand: "anthropic" });
  recordModelSwitch("t1", { at: 4, label: "gpt", brand: "openai" });
  assert.deepEqual(modelSwitches("t1"), [{ at: 4, label: "gpt", brand: "openai" }]);
});

test("a corrupt store reads as no switches rather than throwing", () => {
  store.clear();
  store.set("emma.threadModelSwitches.v1", "{ not json");
  assert.deepEqual(modelSwitches("t1"), []);
  store.set("emma.threadModelSwitches.v1", JSON.stringify({
    t1: "nope",
    t2: [{ at: -1, label: "a" }, { at: 1.5, label: "b" }, { at: 3, label: 7 }, { at: 3, label: "ok", brand: "x" }],
  }));
  assert.deepEqual(modelSwitches("t1"), []);
  assert.deepEqual(modelSwitches("t2"), [{ at: 3, label: "ok", brand: "x" }]);
});
