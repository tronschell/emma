import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { buildAttachedContext } from "../src/context";
import { canSteer, queuedTurns, runOf, sendTurn, steerQueued, steerRunning, stopTurn, takeDraft } from "../src/runs";

const source = ts.createSourceFile("App.tsx", readFileSync(path.join(__dirname, "../../src/App.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const view = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "ThreadView");
assert.ok(view);
let handler = "";
let steerHandler = "";
let steerDisabled = "";
let keysHandler = "";
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "send") handler = node.initializer!.getText(source);
  else if (ts.isVariableDeclaration(node) && node.name.getText(source) === "steerNow") steerHandler = node.initializer!.getText(source);
  else if (ts.isVariableDeclaration(node) && node.name.getText(source) === "composerKeys") keysHandler = node.initializer!.getText(source);
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
function composer(threadId: string, build = buildAttachedContext, folderIds: string[] = []) {
  const state = { message: "first", picks: [attachment("first")], skill: { id: "first-skill", source: "local", name: "first" } as { id: string; source: string; name: string } | null };
  const remembered: unknown[][] = [];
  const environment = {
    locked: false, folderIds, folders: [], folderFiles: {}, thread: { id: threadId, messages: [] },
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


test("queued context cannot be steered before preparation but plain text cuts into the running turn", async () => {
  assert.ok(steerHandler);
  assert.ok(steerDisabled);
  let release!: () => void;
  const sent: Record<string, string>[] = [];
  const stopped: string[] = [];
  const reads: string[] = [];
  const steered: { threadId: string; text: string }[] = [];
  let refuse = false;
  Object.assign(globalThis, { window: { emma: {
    request: async (_method: string, params: Record<string, string>) => {
      sent.push(params);
      if (params.content === "active") await new Promise<void>((resolve) => { release = resolve; });
    },
    steerAgent: async (value: { threadId: string; text: string }) => {
      steered.push(value);
      if (refuse) throw new Error("nothing is running there");
    },
    stopAgent: (threadId: string) => { stopped.push(threadId); },
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
  const environment = { queued, canSteer, steerQueued, thread: { id: "steering" }, setRunError() {} };
  const code = ts.transpile(`const steerNow = ${steerHandler}`, { target: ts.ScriptTarget.ES2022 });
  const steer = Function(...Object.keys(environment), `${code}; return steerNow;`)(...Object.values(environment));
  steer(0);
  steer(1);
  assert.deepEqual(steered, []);
  assert.equal(queuedTurns(runOf("steering")).length, 3);
  assert.equal(reads.length, 0);
  steer(2);
  await settle();
  assert.deepEqual(steered, [{ threadId: "steering", text: "plain" }]);
  assert.deepEqual(stopped, []);
  assert.deepEqual(queuedTurns(runOf("steering")).map((turn) => turn.content), ["attachment", "skill"]);
  assert.equal(reads.length, 0);
  release();
  await settle();
  assert.deepEqual(sent.map((turn) => turn.content), ["active", "attachment", "skill"]);
  assert.match(sent[1].attachedContext, /content of first/);
  assert.equal(sent[2].skillAttachmentId, "queued-skill");
  assert.deepEqual(reads, ["first"]);
  assert.equal(runOf("steering").sending, false);

  refuse = true;
  sendTurn("refused-steer", { content: "active", after: 0, params: {} }, () => undefined);
  sendTurn("refused-steer", { content: "cut in", after: 0, params: {} }, () => undefined);
  steerQueued("refused-steer", 0);
  await settle();
  assert.deepEqual(steered.at(-1), { threadId: "refused-steer", text: "cut in" });
  assert.deepEqual(stopped, ["refused-steer"]);
  assert.deepEqual(queuedTurns(runOf("refused-steer")).map((turn) => turn.content), ["cut in"]);
});

test("cmd+enter with an empty composer steers the queue oldest first", async () => {
  const steered: { threadId: string; text: string }[] = [];
  let release!: () => void;
  const holding = new Promise<void>((resolve) => { release = resolve; });
  Object.assign(globalThis, { window: { emma: {
    request: async () => { await holding; },
    steerAgent: async (value: { threadId: string; text: string }) => { steered.push(value); },
    stopAgent: () => undefined,
  } } });

  const id = "fifo-steer";
  for (const content of ["active", "one", "two", "three"]) sendTurn(id, { content, after: 0, params: {} }, () => undefined);
  assert.deepEqual(queuedTurns(runOf(id)).map((turn) => turn.content), ["one", "two", "three"]);

  const steerCode = ts.transpile(`const steerNow = ${steerHandler}`, { target: ts.ScriptTarget.ES2022 });
  const keysCode = ts.transpile(`const composerKeys = ${keysHandler}`, { target: ts.ScriptTarget.ES2022 });
  const press = () => {
    const queued = queuedTurns(runOf(id));
    const base = { queued, canSteer, steerQueued, thread: { id }, setRunError() {} };
    const steerNow = Function(...Object.keys(base), `${steerCode}; return steerNow;`)(...Object.values(base));
    const scope = {
      ...base, steerNow, steerRunning, reasonText: (reason: unknown) => String(reason),
      slashOpen: false, slashMatches: [], slashActive: 0, setSlashPick() {}, setSlashDismissed() {}, pickCommand() {},
      sending: true, confirmStop: false, interrupt() {}, setConfirmStop() {},
      history: -1, past: [], historyDraft: { current: "" }, message: "", setHistory() {}, setMessage() {},
      input: { current: null }, setCaret() {},
    };
    const keys = Function(...Object.keys(scope), `${keysCode}; return composerKeys;`)(...Object.values(scope));
    keys({
      key: "Enter", metaKey: true, ctrlKey: false, shiftKey: false,
      nativeEvent: { isComposing: false }, preventDefault() {},
      currentTarget: { value: "", selectionStart: 0, selectionEnd: 0, form: { requestSubmit() { throw new Error("cmd+enter must not submit"); } } },
    });
  };

  press();
  await settle();
  assert.deepEqual(steered.map((turn) => turn.text), ["one"]);
  assert.deepEqual(queuedTurns(runOf(id)).map((turn) => turn.content), ["two", "three"]);

  press();
  await settle();
  assert.deepEqual(steered.map((turn) => turn.text), ["one", "two"]);
  assert.deepEqual(queuedTurns(runOf(id)).map((turn) => turn.content), ["three"]);
  release();
});

test("a plain message on a thread with a connected folder is still steerable", async () => {
  Object.assign(globalThis, { window: { emma: { request: async () => new Promise(() => undefined) } } });
  const current = composer("folder-steer", buildAttachedContext, ["emma-folder"]);
  Object.assign(current.state, { message: "active", picks: [], skill: null });
  current.send();
  Object.assign(current.state, { message: "cut in while a folder is attached", picks: [], skill: null });
  current.send();

  const queued = queuedTurns(runOf("folder-steer"));
  assert.deepEqual(queued.map((turn) => turn.content), ["cut in while a folder is attached"]);
  assert.ok(queued[0].prepare, "a connected folder still builds attached context on delivery");
  assert.equal(canSteer(queued[0]), true);

  const disabled = Function("turn", "canSteer", `return ${steerDisabled};`);
  assert.equal(disabled(queued[0], canSteer), false);
});
