import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { roundComputerCursor, COMPUTER_CURSOR_MS, validComputerCursor, validComputerProgress, type ComputerRunProgress } from "../shared/computer";

const cursor = { windowId: 73, bounds: { x: -1700.25, y: -950.5, width: 1800, height: 1000 }, x: -800.25, y: -450.5 };
const display = { x: -1600, y: -900, width: 1600, height: 900 };
const progress: ComputerRunProgress = { step: 1, actions: 1, action: "click", app: "Target", cursor };
const main = readFileSync(path.join(__dirname, "../main/main.js"), "utf8");
const macOnlyWindowCalls = [
  "setHiddenInMissionControl", "setWindowButtonVisibility", "setTrafficLightPosition", "setSheetOffset",
  "setVibrancy", "setAutoHideCursor", "setRepresentedFilename", "setDocumentEdited", "setSimpleFullScreen",
  "mergeAllWindows", "addTabbedWindow", "previewFile", "selectPreviousTab", "selectNextTab", "toggleTabBar",
];

function extract(pattern: RegExp) {
  const result = main.match(pattern)?.[0];
  assert.ok(result, String(pattern));
  return result;
}

test("cursor and progress validation rejects malformed or unbounded metadata", () => {
  assert.ok(validComputerCursor(cursor));
  for (const value of [
    null, [], {}, { ...cursor, extra: true }, { ...cursor, windowId: 0 }, { ...cursor, windowId: 1.5 },
    { ...cursor, windowId: 0x1_0000_0000 }, { ...cursor, x: NaN }, { ...cursor, y: Infinity },
    { ...cursor, x: -100_001 }, { ...cursor, x: cursor.bounds.x - 1 },
    { ...cursor, x: cursor.bounds.x + cursor.bounds.width }, { ...cursor, y: cursor.bounds.y + cursor.bounds.height },
    { ...cursor, bounds: { ...cursor.bounds, width: 0 } }, { ...cursor, bounds: { ...cursor.bounds, height: 16_385 } },
    { ...cursor, bounds: { ...cursor.bounds, scaleFactor: 2 } },
  ]) assert.equal(validComputerCursor(value), false, JSON.stringify(value));
  for (const value of [progress, { ...progress, cursor: null }, { ...progress, cursor: undefined }]) assert.ok(validComputerProgress(value));
  for (const value of [
    null, [], {}, { ...progress, step: -1 }, { ...progress, step: 21 }, { ...progress, actions: 1.5 },
    { ...progress, actions: 21 }, { ...progress, action: 1 }, { ...progress, action: "x".repeat(81) },
    { ...progress, app: "x".repeat(257) }, { ...progress, cursor: {} },
  ]) assert.equal(validComputerProgress(value), false, JSON.stringify(value));
});

test("rounding preserves full window bounds and global point coordinates", () => {
  assert.deepEqual(roundComputerCursor(cursor), {
    ...cursor, bounds: { x: -1701, y: -951, width: 1801, height: 1001 },
  });
  assert.equal(roundComputerCursor({ ...cursor, bounds: { ...cursor.bounds, width: 16_384 } }), null);
});

test("Windows window handles and physical-pixel geometry pass the cursor contract", () => {
  const notepad = { windowId: 222_626_004, bounds: { x: 236, y: 367, width: 1918, height: 1030 }, x: 1264.5, y: 942 };
  const secondDisplay = { windowId: 1_902_246, bounds: { x: -1928, y: -86, width: 1936, height: 1048 }, x: -1040.5, y: -15 };
  for (const value of [notepad, secondDisplay]) {
    assert.ok(validComputerCursor(value), JSON.stringify(value));
    assert.deepEqual(roundComputerCursor(value), value);
  }
  assert.equal(validComputerCursor({ ...notepad, windowId: 0xffff_ffff + 1 }), false);
  assert.equal(validComputerCursor({ ...secondDisplay, x: secondDisplay.bounds.x - 1 }), false);
});

test("crossing a display boundary does not shift the animation origin", () => {
  const bounds = { x: 1000, y: 50, width: 1000, height: 700 };
  const first = roundComputerCursor({ windowId: 42, bounds, x: 1200, y: 150 });
  const second = roundComputerCursor({ windowId: 42, bounds, x: 1600, y: 150 });
  assert.ok(first && second);
  assert.deepEqual(first.bounds, bounds);
  assert.deepEqual(second.bounds, bounds);
  assert.equal(second.bounds.x + (first.x - first.bounds.x), first.x);
  assert.equal(second.x - second.bounds.x, 600);
});

test("cursor motion stays window-keyed and respects reduced motion", () => {
  const css = readFileSync(path.join(__dirname, "../../src/styles/overlay.css"), "utf8");
  const component = readFileSync(path.join(__dirname, "../../src/App.tsx"), "utf8");
  assert.ok(/\.computer-cursor\s*\{[^}]*transition:\s*transform\s+\d+ms/.test(css)
    && /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.computer-cursor\s*\{\s*transition:\s*none/.test(css)
    && /<div\s+key=\{cursor\.windowId\}\s+className="computer-cursor"/.test(component));
});

test("overlay waits for readiness, stays target-relative and cannot reshow after expiry or abort", () => {
  let now = 1000;
  let timeout: { callback: () => void; milliseconds: number } | undefined;
  const windows: ReturnType<typeof makeWindow>[] = [];
  const loads: string[] = [];
  const nearestPoints: unknown[] = [];
  const simulated = { isMac: false };
  function makeWindow(options: Record<string, unknown>) {
    let destroyed = false;
    const calls: string[] = [];
    const bounds: unknown[] = [];
    const messages: ComputerRunProgress[] = [];
    return {
      ...Object.fromEntries(macOnlyWindowCalls.map((name) => [name, () => {
        if (!simulated.isMac) throw new TypeError(`${name} is not a function`);
        calls.push(name);
      }])),
      options, calls, bounds, messages,
      isDestroyed: () => destroyed,
      destroy: () => { destroyed = true; calls.push("destroy"); },
      on: () => {},
      hide: () => calls.push("hide"),
      setBounds: (value: unknown) => bounds.push(value),
      showInactive: () => calls.push("showInactive"),
      moveAbove: (target: string) => calls.push(`moveAbove:${target}`),
      setAlwaysOnTop: () => calls.push("alwaysOnTop"),
      setVisibleOnAllWorkspaces: (_value: boolean, workspace?: object) => {
        if (workspace && !simulated.isMac) throw new TypeError("setVisibleOnAllWorkspaces options are macOS-only");
      },
      setIgnoreMouseEvents: (value: boolean) => calls.push(`ignoreMouse:${value}`),
      getMediaSourceId: () => "window:900:0",
      isVisible: () => true,
      isMinimized: () => false,
      webContents: { mainFrame: {}, send: (_channel: string, value: ComputerRunProgress) => messages.push(value) },
    };
  }
  type ReadyEvent = { sender: ReturnType<typeof makeWindow>["webContents"]; senderFrame: object };
  let ready: (event: ReadyEvent) => void = () => assert.fail("Missing readiness listener");
  const context = {
    isMac: simulated.isMac,
    mainWindow: makeWindow({}),
    computerCursorOwner: "computer",
    computerCursorHeld: false,
    computerCursorIdle: undefined,
    CURSOR_IDLE_MS: 60_000,
    platform_1: simulated,
    computerCursorWindow: null,
    computerCursorReady: false,
    computerCursorTimer: undefined,
    computerProgress: undefined,
    computerCursorProgress: undefined,
    computerCursorAt: 0,
    computerRuntime: { active: true },
    runBanner: null,
    computer_1: { roundComputerCursor, COMPUTER_CURSOR_MS },
    computer_2: { MAX_RUN_STEPS: 20 },
    Date: { now: () => now },
    setTimeout: (callback: () => void, milliseconds: number) => (timeout = { callback, milliseconds }),
    clearTimeout: () => { timeout = undefined; },
    secureWindow: (options: Record<string, unknown>) => { const window = makeWindow(options); windows.push(window); return window; },
    load: (_window: unknown, mode: string) => loads.push(mode),
    electron_1: {
      globalShortcut: { register: () => true, unregister: () => {} },
      screen: {
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: (point: unknown) => { nearestPoints.push(point); return { bounds: display, workArea: display, scaleFactor: 2 }; },
      },
      ipcMain: { on: (_channel: string, listener: (event: ReadyEvent) => void) => { ready = listener; } },
    },
  };
  const functions = [
    extract(/function reportRunProgress\(progress\) \{[\s\S]*?(?=\nconst BRIDGE_EVENTS)/),
    extract(/function pinWindow\(window\) \{[\s\S]*?(?=\nconst floating)/),
    extract(/function openRunBanner\(threadId, task\) \{[\s\S]*?(?=\nfunction startAnnotation\()/),
    extract(/electron_1\.ipcMain\.on\("emma:computer-run-ready",[\s\S]*?(?=\n\s*electron_1\.ipcMain\.handle)/),
  ].join("\n");
  const api = runInNewContext(`${functions}\n({ openRunBanner, closeRunBanner, reportRunProgress, reportBrowserCursor })`, context) as {
    openRunBanner: (threadId: string, task: string) => void;
    closeRunBanner: () => void;
    reportRunProgress: (value: ComputerRunProgress) => void;
    reportBrowserCursor: (value: ComputerRunProgress | null) => void;
  };
  api.openRunBanner("thread", "task");
  const [banner, overlay] = windows;
  assert.deepEqual(loads, ["run", "computerCursor"]);
  assert.equal(overlay.options.focusable, false);
  assert.notEqual(overlay.options.alwaysOnTop, true);
  assert.deepEqual(overlay.calls, ["ignoreMouse:true"]);
  api.reportRunProgress(progress);
  assert.deepEqual(banner.messages, [progress]);
  assert.equal(overlay.calls.at(-1), "hide");
  assert.equal(timeout, undefined);
  const reading = { step: 2, actions: 1, action: "Reading", app: "Target" };
  const pendingCalls = overlay.calls.slice();
  now += 50;
  api.reportRunProgress(reading);
  assert.deepEqual(overlay.calls, pendingCalls);
  assert.equal(context.computerCursorProgress, progress);
  assert.equal(context.computerCursorAt, 1000);
  ready({ sender: overlay.webContents, senderFrame: {} });
  assert.equal(context.computerCursorReady, false);
  const sender = overlay.webContents;
  now += 50;
  ready({ sender, senderFrame: sender.mainFrame });
  assert.deepEqual(overlay.calls.slice(-2), ["showInactive", "moveAbove:window:73:0"]);
  assert.deepEqual(overlay.bounds.map((value) => ({ ...(value as object) })), [roundComputerCursor(cursor)!.bounds]);
  assert.equal(nearestPoints.length, 1);
  assert.equal(overlay.messages.at(-1)?.cursor?.x, cursor.x);
  assert.equal(overlay.messages.at(-1)?.cursor?.y, cursor.y);
  assert.equal(overlay.messages.at(-1)?.action, progress.action);
  const scheduled = timeout as { callback: () => void; milliseconds: number } | undefined;
  assert.ok(scheduled);
  assert.equal(scheduled.milliseconds, COMPUTER_CURSOR_MS - 100);
  const visibleCalls = overlay.calls.slice();
  const visibleMessages = overlay.messages.slice();
  now += 1;
  api.reportRunProgress({ ...reading, step: 3 });
  assert.deepEqual(overlay.calls, visibleCalls);
  assert.deepEqual(overlay.messages, visibleMessages);
  assert.equal(banner.messages.at(-1)?.step, 3);
  assert.equal(timeout, scheduled);
  assert.equal(context.computerCursorAt, 1000);
  now = 1000 + COMPUTER_CURSOR_MS;
  scheduled.callback();
  assert.equal(overlay.calls.at(-1), "hide");
  api.reportRunProgress({ ...reading, step: 4 });
  ready({ sender, senderFrame: sender.mainFrame });
  assert.equal(overlay.calls.filter((call) => call === "showInactive").length, 1);
  assert.equal(timeout, undefined);
  context.computerRuntime.active = false;
  api.reportRunProgress(progress);
  assert.equal(overlay.calls.at(-1), "hide");
  assert.equal(timeout, undefined);
  context.computerRuntime.active = true;
  api.reportRunProgress(progress);
  assert.equal(overlay.calls.filter((call) => call === "showInactive").length, 2);
  api.reportRunProgress({ ...progress, cursor: null });
  assert.equal(overlay.calls.at(-1), "hide");
  api.reportRunProgress(reading);
  assert.equal(overlay.calls.filter((call) => call === "showInactive").length, 2);
  assert.equal(timeout, undefined);
  now += 1;
  api.reportBrowserCursor({ step: 0, actions: 2, action: "clicking @e1", cursor });
  assert.deepEqual(overlay.calls.slice(-2), ["showInactive", "moveAbove:window:900:0"]);
  assert.equal(overlay.messages.at(-1)?.action, "clicking @e1");
  assert.equal(timeout, undefined);
  now += COMPUTER_CURSOR_MS * 3;
  api.reportBrowserCursor(null);
  assert.equal(overlay.calls.at(-1), "moveAbove:window:900:0");
  assert.equal((timeout as { milliseconds: number } | undefined)?.milliseconds, COMPUTER_CURSOR_MS);
  api.reportBrowserCursor(null);
  assert.equal((timeout as { milliseconds: number } | undefined)?.milliseconds, COMPUTER_CURSOR_MS);
  context.computerRuntime.active = false;
  now += 1;
  api.reportBrowserCursor({ step: 0, actions: 3, action: "typing", cursor });
  assert.equal(overlay.calls.filter((call) => call === "showInactive").length, 5);
  context.computerRuntime.active = true;
  api.closeRunBanner();
  assert.equal(overlay.isDestroyed(), true);
  assert.equal(banner.isDestroyed(), true);
  assert.equal(context.computerProgress, undefined);
  assert.equal(context.computerCursorProgress, undefined);
  assert.equal(context.computerCursorAt, 0);
  assert.equal(context.computerCursorReady, false);
  assert.equal(timeout, undefined);
  ready({ sender, senderFrame: sender.mainFrame });
  scheduled.callback();
  assert.equal(overlay.calls.at(-1), "destroy");
  assert.equal(overlay.calls.includes("alwaysOnTop"), false);
});

test("finishing cursor renderer loading never shows the window implicitly", async () => {
  const calls: string[] = [];
  let painted: () => void = () => assert.fail("Missing paint listener");
  const load = runInNewContext(`${extract(/async function load\(window,[\s\S]*?(?=\nfunction openMain\()/)}\nload`, {
    process: { env: {} }, renderer: "/renderer.html", URLSearchParams,
    setTimeout: () => ({ unref: () => {} }),
    console: { error: (error: unknown) => assert.fail(String(error)) },
  }) as (window: unknown, mode: string) => Promise<void>;
  const loading = load({
    once: (_event: string, listener: () => void) => { painted = listener; },
    loadFile: async () => {},
    isDestroyed: () => false,
    show: () => calls.push("show"),
    showInactive: () => calls.push("showInactive"),
    focus: () => calls.push("focus"),
  }, "computerCursor");
  painted();
  await loading;
  assert.deepEqual(calls, []);
});

test("sandboxed preload loads with only Electron and registers progress before readiness", () => {
  type Bridge = { onComputerRunProgress: (listener: (value: unknown) => void) => () => void };
  let bridge: Bridge | undefined;
  let listener: ((_event: unknown, value: unknown) => void) | undefined;
  const calls: string[] = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, value: Bridge) => { assert.equal(name, "emma"); bridge = value; } },
    ipcRenderer: {
      on: (channel: string, callback: typeof listener) => { calls.push(`on:${channel}`); listener = callback; },
      send: (channel: string) => calls.push(`send:${channel}`),
      removeListener: (channel: string, callback: typeof listener) => { assert.equal(callback, listener); calls.push(`remove:${channel}`); },
    },
  };
  runInNewContext(readFileSync(path.join(__dirname, "../main/preload.js"), "utf8"), {
    exports: {},
    require: (id: string) => { assert.equal(id, "electron"); return electron; },
  });
  assert.ok(bridge);
  const received: unknown[] = [];
  const unsubscribe = bridge.onComputerRunProgress((value) => received.push(value));
  assert.deepEqual(calls, ["on:emma:computer-run-progress", "send:emma:computer-run-ready"]);
  assert.ok(listener);
  listener({}, progress);
  assert.deepEqual(received, [progress]);
  unsubscribe();
  assert.equal(calls.at(-1), "remove:emma:computer-run-progress");
});
