import assert from "node:assert/strict";
import test from "node:test";

import { namePrompt, readNameReply, nameThread, MAX_NAME_TEXT_CHARS } from "../main/thread-namer";
import type { VerifierSettings } from "../shared/settings";

const settings: VerifierSettings = {
  model: "z-ai/glm-5.2:free",
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  credentialEnv: "",
  system: "",
};

test("a reply with one JSON object yields its title, trimmed and clamped", () => {
  assert.equal(readNameReply('{"title":"Fix the flaky auth test"}'), "Fix the flaky auth test");
  assert.equal(readNameReply('{"title":"  spaced   out  "}'), "spaced out");
  assert.equal(readNameReply("no json here"), null);
  assert.equal(readNameReply('{"title":""}'), null);
  assert.equal(readNameReply('{"title":42}'), null);
  assert.equal(readNameReply('{"title":"' + "x".repeat(200) + '"}'), "x".repeat(120));
  assert.equal(readNameReply('Let me think. {"title":"Named"} done'), "Named");
});

test("a reply whose JSON never closes yields nothing", () => {
  assert.equal(readNameReply('wound {"title":"wrong"'), null);
});

test("a reasoning block ahead of the object is stripped first", () => {
  assert.equal(readNameReply('<reasoning>hmm {"title":"wrong"}</reasoning>{"title":"right"}'), "right");
});

test("the namer quotes the conversation and nothing else", () => {
  assert.match(namePrompt("hello"), /<<<THREAD\nhello\nTHREAD>>>/);
  assert.ok(namePrompt("x".repeat(MAX_NAME_TEXT_CHARS + 500)).length < MAX_NAME_TEXT_CHARS + 200);
});

test("the namer asks its model once and returns what it said", async () => {
  const calls: { messages: unknown }[] = [];
  const name = await nameThread("what is in this folder", settings, async (used, messages) => {
    calls.push({ messages });
    return '{"title":"Folder contents"}';
  });
  assert.equal(name, "Folder contents");
  assert.equal(calls.length, 1);
});

test("a failed or empty naming pass just leaves the thread unnamed", async () => {
  assert.equal(await nameThread("hello", settings, async () => "garbage"), null);
  assert.equal(await nameThread("hello", { ...settings, model: "" }, async () => '{"title":"x"}'), null);
  assert.equal(await nameThread("hello", { ...settings, endpoint: "" }, async () => '{"title":"x"}'), null);
  assert.equal(await nameThread("hello", settings, async () => { throw new Error("down"); }), null);
});