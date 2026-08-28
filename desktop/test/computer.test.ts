import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import type { ComputerApp } from "../main/computer";
import type { ComputerCursor, ComputerRunProgress } from "../shared/computer";

const target: ComputerApp = { id: "com.test.Editor", name: "Test Editor", pid: 12345, path: "/Applications/Test Editor.app", launchedAt: 1_700_000_000_000 };
const other: ComputerApp = { ...target, id: "com.test.Other", name: "Other App", pid: 12346, path: "/Applications/Other.app" };
let apps = [target, other];
let enumerate = async () => apps;
const sent: { app: ComputerApp; action: Record<string, unknown> }[] = [];
const spawned: { args: string[]; child: EventEmitter & { killed: boolean } }[] = [];
let captures = 0;
let snapshots = 0;
let cursorEvents: () => unknown[] = () => [];

// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcess: typeof import("node:child_process") = require("node:child_process");
const fakeExec = Object.assign(() => {}, {
  [promisify.custom]: async () => ({ stdout: JSON.stringify({ ok: true, apps: await enumerate() }), stderr: "" }),
});
childProcess.execFile = fakeExec as unknown as typeof childProcess.execFile;
mock.method(childProcess, "spawn", (_helper: string, args: string[]) => {
  const app = JSON.parse(args[1]) as ComputerApp;
  const child = Object.assign(new EventEmitter(), { killed: false });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const action = JSON.parse(String(chunk)) as Record<string, unknown>;
      sent.push({ app, action });
      callback();
      queueMicrotask(() => {
        if (child.killed) return;
        if (!apps.some((candidate) => JSON.stringify(candidate) === JSON.stringify(app))) {
          stdout.write(`${JSON.stringify({ ok: false, error: "The approved app instance changed" })}\n`);
          return;
        }
        for (const event of cursorEvents()) stdout.write(`${JSON.stringify(event)}\n`);
        stdout.write(`${JSON.stringify(action.action === "get_app_state"
          ? { ok: true, snapshot: `snapshot-${++snapshots}`, text: '[0] AXTextField "Test field"' }
          : { ok: true, text: "Performed the app action" })}\n`);
      });
    },
  });
  spawned.push({ args, child });
  return Object.assign(child, { stdout, stderr, stdin, kill: () => { child.killed = true; child.emit("exit"); return true; } });
});

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { desktopCapturer: { getSources: () => { captures++; throw new Error("Whole-display capture is forbidden here"); } } },
} as unknown as NodeModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ComputerUseRuntime, computerAction, computerTools, MAX_RUN_STEPS }: typeof import("../main/computer") = require("../main/computer");

const darwinOnly = { skip: process.platform !== "darwin" && "computer use is macOS only" };
const thread = "1755000000-1a2b-3c4d5e6f-0";
const runtimes: InstanceType<typeof ComputerUseRuntime>[] = [];
const runtime = (progress?: (value: ComputerRunProgress) => void) => {
  const computer = new ComputerUseRuntime("/fake/emma-computer", () => {}, () => {}, progress);
  runtimes.push(computer);
  computer.start(thread);
  return computer;
};
const allow = async () => true;
const state = (app = target) => ({ action: "get_app_state", app: app.id });
const token = (text: string) => /Snapshot: ([A-Za-z0-9-]+)/.exec(text)![1];
const click = (snapshot: string, app = target) => ({ action: "click", app: app.id, snapshot, element_index: 0 });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  for (const computer of runtimes.splice(0)) computer.end(thread);
  apps = [target, other];
  enumerate = async () => apps;
  sent.length = 0;
  spawned.length = 0;
  captures = 0;
  cursorEvents = () => [];
});

const cursor: ComputerCursor = { windowId: 42, bounds: { x: -100, y: 20, width: 500, height: 400 }, x: 120, y: 80 };

test("cursor events describe approved mutations without becoming tool results", darwinOnly, async () => {
  const progress: ComputerRunProgress[] = [];
  let settled = false;
  const computer = runtime((value) => {
    if (value.cursor) assert.equal(settled, false);
    progress.push(value);
  });
  const snapshot = token(await computer.execute(thread, state(), allow));
  assert.ok(progress.every((value) => !("cursor" in value)));
  cursorEvents = () => [{ event: "cursor", cursor }];
  const result = await computer.execute(thread, click(snapshot), allow);
  settled = true;
  assert.match(result, /Performed the app action/);
  assert.doesNotMatch(result, /windowId|bounds|cursor/);
  assert.deepEqual(progress.filter((value) => value.cursor), [{ step: 2, actions: 2, action: "Clicking", app: target.name, cursor }]);
  cursorEvents = () => [];
  const beforeRead = progress.length;
  await computer.execute(thread, state(), allow);
  assert.ok(progress.slice(beforeRead).every((value) => !("cursor" in value)));
  await assert.rejects(computer.execute(thread, state(other), async () => false), /did not allow/);
  assert.equal(progress.filter((value) => value.cursor).length, 1);
});

test("native invalidation hides the cue without settling or replacing the action result", darwinOnly, async () => {
  const progress: ComputerRunProgress[] = [];
  let settled = false;
  const computer = runtime((value) => {
    if ("cursor" in value) assert.equal(settled, false);
    progress.push(value);
  });
  const snapshot = token(await computer.execute(thread, state(), allow));
  cursorEvents = () => [{ event: "cursor", cursor }, { event: "cursor-invalidated" }];
  const result = await computer.execute(thread, click(snapshot), allow);
  settled = true;
  assert.deepEqual(progress.filter((value) => "cursor" in value).map((value) => value.cursor), [cursor, null]);
  assert.match(result, /Performed the app action/);
  assert.doesNotMatch(result, /windowId|bounds|cursor/);
  assert.equal(spawned.at(-1)!.child.killed, false);
});

test("malformed, duplicate and read-only cursor events close the helper", darwinOnly, async () => {
  for (const events of [
    [{ event: "cursor", cursor: { ...cursor, x: NaN } }],
    [{ event: "cursor", cursor, extra: true }],
    [{ event: "other", cursor }],
    [{ event: "cursor", cursor }, { event: "cursor", cursor }],
    [{ event: "cursor-invalidated" }],
    [{ event: "cursor", cursor }, { event: "cursor-invalidated", extra: true }],
    [{ event: "cursor", cursor }, { event: "cursor-invalidated" }, { event: "cursor-invalidated" }],
  ]) {
    const computer = runtime();
    const snapshot = token(await computer.execute(thread, state(), allow));
    cursorEvents = () => events;
    await assert.rejects(computer.execute(thread, click(snapshot), allow), /Invalid computer cursor event/);
    assert.equal(spawned.at(-1)!.child.killed, true);
    computer.end(thread);
    cursorEvents = () => [];
  }
  for (const event of [{ event: "cursor", cursor }, { event: "cursor-invalidated" }]) {
    const computer = runtime();
    cursorEvents = () => [event];
    await assert.rejects(computer.execute(thread, state(), allow), /Invalid computer cursor event/);
    assert.equal(spawned.at(-1)!.child.killed, true);
  }
});

test("stopping at a cursor event discards the action reply and kills its helper", darwinOnly, async () => {
  const computer = runtime((value) => { if (value.cursor) computer.abort(); });
  const snapshot = token(await computer.execute(thread, state(), allow));
  cursorEvents = () => [{ event: "cursor", cursor }];
  await assert.rejects(computer.execute(thread, click(snapshot), allow), /Computer run ended/);
  assert.equal(computer.active, false);
  assert.equal(spawned.at(-1)!.child.killed, true);
});

test("computer accepts only bounded app-scoped commands", () => {
  assert.deepEqual(computerAction({ action: "list_apps" }), { action: "list_apps" });
  assert.deepEqual(computerAction({ ...click("s"), action: "set_value", value: "" }), { ...click("s"), action: "set_value", value: "" });
  for (const args of [
    { action: "screenshot" }, { action: "get_app_state" }, { action: "get_app_state", app: "/Applications/Editor.app" },
    { ...state(), pid: 1.5 }, { ...state(), coordinate: [0, 0] }, { action: "list_apps", app: target.id },
    { ...click("s"), element_index: -1 }, { ...click("s"), element_index: 0.5 }, { ...click("s"), element_index: 400 },
    { ...click("s"), snapshot: "../bad" }, { ...click("s"), snapshot: "s".repeat(65) },
    { ...click("s"), action: "key", key: "cmd+tab" }, { ...click("s"), action: "type_text", text: "x".repeat(4097) },
    { ...click("s"), action: "scroll", direction: "down", amount: 11 }, { ...click("s"), action: "scroll", direction: "sideways" },
  ]) assert.throws(() => computerAction(args));
  assert.deepEqual(computerTools[0].inputSchema.properties.action.enum, ["list_apps", "get_app_state", "click", "set_value", "type_text", "key", "scroll"]);
});

test("discovery exposes app metadata without reading UI or asking", darwinOnly, async () => {
  apps.push({ ...target, id: "com.test.Emma", pid: process.pid });
  const computer = runtime();
  const listed = await computer.execute(thread, { action: "list_apps" }, async () => { throw new Error("No approval needed to list metadata"); });
  assert.match(listed, /com.test.Editor/);
  assert.doesNotMatch(listed, /com.test.Emma/);
  assert.equal(spawned.length, 0);
  assert.equal(sent.length, 0);
  assert.equal(captures, 0);
});

test("the user approves each exact app once, with no global input", darwinOnly, async () => {
  const computer = runtime();
  const asks: ComputerApp[] = [];
  const approve = async (app: ComputerApp) => { assert.equal(sent.filter((item) => item.app.id === app.id).length, 0); asks.push(app); return true; };
  const first = token(await computer.execute(thread, state(), approve));
  await computer.execute(thread, click(first), approve);
  await computer.execute(thread, state(), approve);
  await computer.execute(thread, state(other), approve);
  assert.deepEqual(asks, [target, other]);
  assert.equal(spawned.length, 2);
  assert.deepEqual(spawned[0].args, ["--app", JSON.stringify(target), "--blocked-pid", String(process.pid)]);
  assert.deepEqual(sent[1].action, { action: "click", snapshot: first, element_index: 0 });
  assert.equal(captures, 0);
});

test("denial stays denied for this turn, including concurrent retries", darwinOnly, async () => {
  const computer = runtime();
  let asks = 0;
  const deny = async () => { asks++; return false; };
  const attempts = await Promise.allSettled([computer.execute(thread, state(), deny), computer.execute(thread, state(), deny)]);
  assert.ok(attempts.every((attempt) => attempt.status === "rejected"));
  await assert.rejects(computer.execute(thread, state(), allow), /did not allow/);
  assert.equal(asks, 1);
  assert.equal(spawned.length, 0);
  await computer.execute(thread, state(other), allow);
  assert.equal(spawned.length, 1);
  assert.ok(sent.every((item) => item.app.id === other.id));
});

test("snapshots are single-use and bound to their approved app", darwinOnly, async () => {
  const computer = runtime();
  const first = token(await computer.execute(thread, state(), allow));
  await computer.execute(thread, click(first), allow);
  await assert.rejects(computer.execute(thread, click(first), allow), /snapshot is stale/);
  const newer = token(await computer.execute(thread, state(), allow));
  await computer.execute(thread, state(other), allow);
  await assert.rejects(computer.execute(thread, click(newer, other), allow), /snapshot is stale/);
  assert.equal(sent.filter((item) => item.action.action === "click").length, 1);
});

test("an unrelated thread cannot borrow or end a granted run", darwinOnly, async () => {
  const computer = runtime();
  await computer.execute(thread, state(), allow);
  computer.end("another-thread");
  await assert.rejects(computer.execute("another-thread", state(), allow), /does not own/);
  assert.equal(computer.active, true);
  assert.throws(() => computer.start("another-thread"), /cannot restart or be borrowed/);
});

test("stopping during approval cannot create a helper or restart the run", darwinOnly, async () => {
  const computer = runtime();
  let answer!: (allowed: boolean) => void;
  let signal!: AbortSignal;
  const result = computer.execute(thread, state(), (_app, abort) => { signal = abort; return new Promise((resolve) => { answer = resolve; }); });
  await tick();
  computer.abort();
  assert.equal(signal.aborted, true);
  answer(true);
  await assert.rejects(result, /stopped/);
  assert.equal(spawned.length, 0);
  assert.throws(() => computer.start(thread), /cannot restart/);
  computer.end(thread);
  computer.start(thread);
  await computer.execute(thread, state(), allow);
  assert.equal(spawned.length, 1);
});

test("ending during discovery rejects late results", darwinOnly, async () => {
  const computer = runtime();
  let deliver!: (value: ComputerApp[]) => void;
  enumerate = () => new Promise((resolve) => { deliver = resolve; });
  const result = computer.execute(thread, state(), allow);
  await tick();
  computer.end(thread);
  deliver(apps);
  await assert.rejects(result, /finished/);
  assert.equal(spawned.length, 0);
});

test("abort during throttling prevents the queued input", darwinOnly, async () => {
  const computer = runtime();
  const first = token(await computer.execute(thread, state(), allow));
  const result = computer.execute(thread, click(first), allow);
  await tick();
  computer.abort();
  await assert.rejects(result, /stopped/);
  assert.equal(sent.length, 1);
  assert.ok(spawned.every((item) => item.child.killed));
});

test("relaunches and app changes during approval do not inherit a grant", darwinOnly, async () => {
  const computer = runtime();
  await computer.execute(thread, state(), allow);
  apps = [{ ...target, launchedAt: target.launchedAt + 1000 }, other];
  await assert.rejects(computer.execute(thread, state(), allow), /instance changed/);
  computer.end(thread);
  computer.start(thread);
  apps = [target, other];
  await assert.rejects(computer.execute(thread, state(), async () => {
    apps = [{ ...target, pid: target.pid + 10 }, other];
    return true;
  }), /instance changed/);
});

test("ambiguous app names need an exact PID and self control is refused", darwinOnly, async () => {
  const computer = runtime();
  apps.push({ ...target, pid: 23456 });
  await assert.rejects(computer.execute(thread, state(), allow), /Several instances/);
  await computer.execute(thread, { ...state(), pid: target.pid }, allow);
  apps = [{ ...target, pid: process.pid }];
  await assert.rejects(computer.execute(thread, { ...state(), pid: process.pid }, allow), /Emma itself/);
});

test("the step ceiling revokes access and the next turn asks again", darwinOnly, async () => {
  const computer = runtime();
  for (let step = 0; step < MAX_RUN_STEPS; step++) await computer.execute(thread, { action: "list_apps" }, allow);
  await assert.rejects(computer.execute(thread, state(), allow), /step limit/);
  assert.equal(computer.active, false);
  assert.equal(spawned.length, 0);
  computer.end(thread);
  computer.start(thread);
  let asked = false;
  await computer.execute(thread, state(), async () => { asked = true; return true; });
  assert.equal(asked, true);
});
