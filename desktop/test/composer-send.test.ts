import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { buildAttachedContext } from "../src/context";
import { canSteer, dropQueued, queuedTurns, runOf, sendTurn, stopTurn, takeDraft } from "../src/runs";

const source = ts.createSourceFile("App.tsx", readFileSync(path.join(__dirname, "../../src/App.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const view = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "ThreadView");
assert.ok(view);
let handler = "";
let steerHandler = "";
let steerDisabled = "";
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "send") handler = node.initializer!.getText(source);
  else if (ts.isVariableDeclaration(node) && node.name.getText(source) === "steerQueued") steerHandler = node.initializer!.getText(source);
  else if (ts.isJsxOpeningElement(node) && node.attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.getText(source) === "className" && property.initializer?.getText(source) === '"steering"')) {
    const disabled = node.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText(source) === "disabled") as ts.JsxAttribute;
    steerDisabled = (disabled.initializer as ts.JsxExpression).expression!.getText(source);
  }
  else ts.forEachChild(node, visit);
}
visit(view);
assert.ok(handler);
const code = ts.transpile(`const send = ${handler}`, { target: ts.ScriptTarget.ES2022 });
const stored = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
  dispatchEvent: () => true,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const attachment = (id: string) => ({ kind: "attachment", id, name: `${id}.txt`, path: `/tmp/${id}.txt` });
function composer(threadId: string, build = buildAttachedContext) {
  const state = { message: "first", picks: [attachment("first")], skill: { id: "first-skill", source: "local", name: "first" } as { id: string; source: string; name: string } | null };
  const remembered: unknown[][] = [];
  const environment = {
    locked: false, folderIds: [], folders: [], folderFiles: {}, thread: { id: threadId, messages: [] },
    setMessage: (value: string) => { state.message = value; },
    setPicks: (value: typeof state.picks) => { state.picks = value; },
    setSkill: (value: typeof state.skill) => { state.skill = value; },
    setRunError() {}, setHistory() {}, reload() {}, noteUses() {},
    rememberTurnAttachments: (...args: unknown[]) => remembered.push(args),
    pickBrief: (pick: { name: string }) => pick.name,
    buildAttachedContext: build, sendTurn,
  };
  return {
    state, remembered,
    send: () => {
      const scope = { ...environment, ...state };
      return Function(...Object.keys(scope), `${code}; return send;`)(...Object.values(scope))();
    },
  };
}

test("composer consumes context at submit and keeps FIFO across new composer instances", async () => {
  let finish!: (value: Awaited<ReturnType<typeof buildAttachedContext>>) => void;
  const pending = new Promise<Awaited<ReturnType<typeof buildAttachedContext>>>((resolve) => { finish = resolve; });
  const captured: unknown[] = [];
  const sent: Record<string, string>[] = [];
  Object.assign(globalThis, { window: { emma: { request: async (_method: string, params: Record<string, string>) => { sent.push(params); } } } });
  const first = composer("fifo", async (_folders, _ids, picks) => { captured.push(picks); return pending; });
  first.send();
  assert.equal(first.state.message, "");
  assert.deepEqual(first.state.picks, []);
  assert.equal(Boolean(first.state.skill), false);
  assert.equal(sent.length, 0);
  Object.assign(first.state, { message: "next draft", picks: [attachment("next")], skill: { id: "next-skill", source: "local", name: "next" } });
  const remounted = composer("fifo");
  Object.assign(remounted.state, { message: "second", picks: [], skill: null });
  remounted.send();
  Object.assign(remounted.state, { message: "next draft", picks: [attachment("next")], skill: { id: "next-skill", source: "local", name: "next" } });
  assert.equal(sent.length, 0);
  finish({ text: "first attachment", uses: [], images: ["image-first"] });
  await settle();
  assert.deepEqual(sent.map((item) => item.content), ["first", "second"]);
  assert.equal(sent[0].attachedContext, "first attachment");
  assert.equal(sent[0].attachedImages, '["image-first"]');
  assert.equal(sent[0].skillAttachmentId, "first-skill");
  assert.equal(sent[1].attachedContext, undefined);
  assert.equal(sent[1].skillAttachmentId, undefined);
  assert.deepEqual(captured, [[attachment("first")]]);
  assert.equal(first.state.message, "next draft");
  assert.deepEqual(first.state.picks, [attachment("next")]);
  assert.equal(first.state.skill?.id, "next-skill");
  assert.equal(remounted.state.message, "next draft");
  assert.deepEqual(remounted.state.picks, [attachment("next")]);
  assert.equal(remounted.state.skill?.id, "next-skill");
  assert.deepEqual(first.remembered[0], ["fifo", 0, "first", [{ kind: "attachment", name: "first.txt", path: "/tmp/first.txt" }]]);
});

test("an attachment read failure does not block the following prompt", async () => {
  const sent: Record<string, string>[] = [];
  Object.assign(globalThis, { window: { emma: {
    readAttachment: async () => { throw new Error("attachment missing"); },
    request: async (_method: string, params: Record<string, string>) => { sent.push(params); },
  } } });
  const current = composer("read-failure");
  current.send();
  Object.assign(current.state, { message: "second", picks: [], skill: null });
  current.send();
  await settle();
  assert.deepEqual(sent.map((item) => item.content), ["first", "second"]);
  assert.match(sent[0].attachedContext, /Could not be read: attachment missing/);
  assert.equal(runOf("read-failure").sending, false);
});

test("preparation failure preserves the next draft and lets later sends drain", async () => {
  let fail!: (reason: Error) => void;
  const pending = new Promise<Awaited<ReturnType<typeof buildAttachedContext>>>((_resolve, reject) => { fail = reject; });
  const sent: string[] = [];
  Object.assign(globalThis, { window: { emma: { request: async (_method: string, params: { content: string }) => { sent.push(params.content); } } } });
  const current = composer("prepare-failure", () => pending);
  current.send();
  const next = composer("prepare-failure");
  Object.assign(next.state, { message: "second", picks: [], skill: null });
  next.send();
  Object.assign(next.state, { message: "next draft", picks: [attachment("next")], skill: { id: "next-skill", source: "local", name: "next" } });
  fail(new Error("preparation failed"));
  await settle();
  assert.deepEqual(sent, ["second"]);
  assert.equal(takeDraft("prepare-failure"), "first");
  assert.equal(next.state.message, "next draft");
  assert.deepEqual(next.state.picks, [attachment("next")]);
  assert.equal(next.state.skill?.id, "next-skill");
  assert.equal(runOf("prepare-failure").sending, false);
});

test("stopping during preparation never sends the canceled prompt", async () => {
  let finish!: (value: Awaited<ReturnType<typeof buildAttachedContext>>) => void;
  const pending = new Promise<Awaited<ReturnType<typeof buildAttachedContext>>>((resolve) => { finish = resolve; });
  const sent: string[] = [];
  Object.assign(globalThis, { window: { emma: {
    stopAgent() {}, request: async (_method: string, params: { content: string }) => { sent.push(params.content); },
  } } });
  composer("stop-preparing", () => pending).send();
  stopTurn("stop-preparing");
  sendTurn("stop-preparing", { content: "replacement", after: 0, params: {} }, () => undefined);
  finish({ text: "old attachment", uses: [], images: [] });
  await settle();
  assert.deepEqual(sent, ["replacement"]);
  assert.equal(takeDraft("stop-preparing"), "first");
});


test("queued context cannot be steered before preparation but plain text can", async () => {
  assert.ok(steerHandler);
  assert.ok(steerDisabled);
  let release!: () => void;
  const sent: Record<string, string>[] = [];
  const steered: string[] = [];
  const reads: string[] = [];
  Object.assign(globalThis, { window: { emma: {
    request: async (_method: string, params: Record<string, string>) => {
      sent.push(params);
      if (params.content === "active") await new Promise<void>((resolve) => { release = resolve; });
    },
    steerAgent: async (params: { text: string }) => { steered.push(params.text); },
    readAttachment: async (id: string) => { reads.push(id); return { name: `${id}.txt`, path: `/tmp/${id}.txt`, text: `content of ${id}` }; },
  } } });
  sendTurn("steering", { content: "active", after: 0, params: {} }, () => undefined);
  const current = composer("steering");
  Object.assign(current.state, { message: "attachment", skill: null });
  current.send();
  Object.assign(current.state, { message: "skill", picks: [], skill: { id: "queued-skill", source: "local", name: "queued" } });
  current.send();
  Object.assign(current.state, { message: "plain", picks: [], skill: null });
  current.send();
  const queued = queuedTurns(runOf("steering"));
  const disabled = Function("turn", "canSteer", `return ${steerDisabled};`);
  assert.deepEqual(queued.map((turn) => disabled(turn, canSteer)), [true, true, false]);
  const environment = { queued, canSteer, dropQueued, sendTurn, thread: { id: "steering" }, setRunError() {}, setSteered() {}, reload() {} };
  const code = ts.transpile(`const steerQueued = ${steerHandler}`, { target: ts.ScriptTarget.ES2022 });
  const steer = Function(...Object.keys(environment), `${code}; return steerQueued;`)(...Object.values(environment));
  steer(0);
  steer(1);
  assert.equal(steered.length, 0);
  assert.equal(queuedTurns(runOf("steering")).length, 3);
  assert.equal(reads.length, 0);
  steer(2);
  assert.deepEqual(steered, ["plain"]);
  assert.equal(queuedTurns(runOf("steering")).length, 2);
  release();
  await settle();
  assert.deepEqual(sent.map((turn) => turn.content), ["active", "attachment", "skill"]);
  assert.match(sent[1].attachedContext, /content of first/);
  assert.equal(sent[2].skillAttachmentId, "queued-skill");
  assert.deepEqual(reads, ["first"]);
  assert.equal(runOf("steering").sending, false);
});
