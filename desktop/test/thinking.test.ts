import test from "node:test";
import assert from "node:assert/strict";
import { splitThinking } from "../shared/thinking";
import { thinkingStops } from "../shared/settings";

test("a leading scratchpad splits off the answer", () => {
  assert.deepEqual(splitThinking("<think>weigh it up</think>\n\nHere is the answer."), { thinking: "weigh it up", answer: "Here is the answer." });
  assert.deepEqual(splitThinking("  <Thinking>\n a \n</Thinking >rest"), { thinking: "a", answer: "rest" });
  assert.deepEqual(splitThinking("<reasoning>step</reasoning>done"), { thinking: "step", answer: "done" });
});

test("plain replies are left alone, and an unclosed block is all scratchpad", () => {
  assert.deepEqual(splitThinking("Just an answer."), { thinking: "", answer: "Just an answer." });
  assert.deepEqual(splitThinking("mid-text <think>x</think>"), { thinking: "", answer: "mid-text <think>x</think>" });
  assert.deepEqual(splitThinking("<think>still going"), { thinking: "still going", answer: "" });
});

test("a model's thinking stops are its own, and every model starts on its own default", () => {
  // Stop zero is "" — the model's default — so a fresh pick asks for no effort at all.
  const three = { reasoningEfforts: ["max", "high", "low"], reasoningMandatory: false };
  assert.deepEqual(thinkingStops(three), ["", "off", "low", "high", "max"]);
  assert.equal(thinkingStops(three)[0], "");

  // A mandatory reasoner offers no "off"; one that lists "none" already has its own.
  assert.deepEqual(thinkingStops({ reasoningEfforts: ["high", "medium", "low"], reasoningMandatory: true }), ["", "low", "medium", "high"]);
  assert.deepEqual(thinkingStops({ reasoningEfforts: ["none", "high"] }), ["", "none", "high"]);

  // No published efforts means no slider at all.
  assert.deepEqual(thinkingStops({}), []);
});
