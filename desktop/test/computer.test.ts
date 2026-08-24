import test from "node:test";
import assert from "node:assert/strict";

// The runtime reaches for Electron's screen and capture APIs; stub them before the
// module is loaded so the ceilings can be exercised outside a real Electron process.
const display = { id: 1, size: { width: 1440, height: 900 }, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 };
const jpeg = Buffer.from([255, 216, 255, 217]);
const crops: unknown[] = [];
const fakeImage = { isEmpty: () => false, getSize: () => ({ width: 1440, height: 900 }), toJPEG: () => jpeg, resize: () => fakeImage, crop: (box: unknown) => { crops.push(box); return fakeImage; } };
const electron = {
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => display, getAllDisplays: () => [display] },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  desktopCapturer: { getSources: async () => [{ display_id: "1", thumbnail: fakeImage }] },
  nativeImage: { createFromDataURL: () => fakeImage },
};
const electronPath = require.resolve("electron");
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron } as unknown as NodeModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ComputerUseRuntime, MAX_RUN_STEPS, helperPayload }: typeof import("../main/computer") = require("../main/computer");

const darwinOnly = { skip: process.platform !== "darwin" && "computer use is macOS only in this build" };
// Exactly what `ThreadId::generate` mints, so the validation this once failed stays covered.
const thread = "1755000000-1a2b-3c4d5e6f-0";
const runtime = (log: string[] = []) => new ComputerUseRuntime("/nonexistent/emma-option-tap", (line) => log.push(line));

test("actions are validated before anything reaches the screen", darwinOnly, async () => {
  const computer = runtime();
  computer.start(thread);
  await assert.rejects(computer.execute({ action: "left_click", coordinate: [10, 10] }), /screenshot before pointing/);
  await computer.execute({ action: "screenshot" });
  await assert.rejects(computer.execute({ action: "left_click", coordinate: [5000, 10] }), /outside the captured screen/);
  await assert.rejects(computer.execute({ action: "left_click", coordinate: [10, -1] }), /outside the captured screen/);
  await assert.rejects(computer.execute({ action: "left_click", coordinate: [10] }), /must be \[x, y\]/);
  await assert.rejects(computer.execute({ action: "type", text: "x".repeat(4097) }), /Typed text is invalid/);
  await assert.rejects(computer.execute({ action: "type", text: "" }), /Typed text is invalid/);
  await assert.rejects(computer.execute({ action: "scroll", coordinate: [10, 10], scroll_direction: "sideways" }), /scroll_direction must be/);
  await assert.rejects(computer.execute({ action: "scroll", coordinate: [10, 10], scroll_direction: "down", scroll_amount: 9999 }), /scroll_amount must be/);
  await assert.rejects(computer.execute({ action: "left_click_drag", coordinate: [1, 1] }), /start_coordinate must be/);
  await assert.rejects(computer.execute({ action: "hold_key", text: "shift", duration: 999 }), /duration must be between/);
  await assert.rejects(computer.execute({ action: "key", text: "a", repeat: 99 }), /repeat must be between/);
  await assert.rejects(computer.execute({ action: "zoom", region: [0, 0, 4, 4] }), /at least 8 pixels/);
  await assert.rejects(computer.execute({ action: "launch_missiles" }), /Computer action is invalid/);
  computer.abort("test");
});

test("the helper payload matches what quick_ask.m parses", () => {
  const frame = { displayId: 1, width: 1440, height: 900, region: [0, 0, 1440, 900] as [number, number, number, number], full: [1440, 900] as [number, number] };
  assert.deepEqual(helperPayload(frame, { action: "right_click", coordinate: [720, 450] }), { action: "click", button: "right", x: 720, y: 450 });
  assert.deepEqual(helperPayload(frame, { action: "middle_click", coordinate: [0, 0] }), { action: "click", button: "middle", x: 0, y: 0 });
  assert.deepEqual(helperPayload(frame, { action: "scroll", coordinate: [0, 0], scroll_direction: "down", scroll_amount: 4 }), { action: "scroll", x: 0, y: 0, dx: 0, dy: -4 });
  assert.deepEqual(helperPayload(frame, { action: "scroll", coordinate: [0, 0], scroll_direction: "right", scroll_amount: 2, text: "shift" }), { action: "scroll", x: 0, y: 0, dx: 2, dy: 0, modifiers: ["shift"] });
  // A combo is split at the last `+`: everything before it is held down.
  assert.deepEqual(helperPayload(frame, { action: "key", text: "cmd+shift+Return" }), { action: "key", key: "return", modifiers: ["cmd", "shift"] });
  assert.deepEqual(helperPayload(frame, { action: "hold_key", text: "shift", duration: 2 }), { action: "hold_key", key: "shift", duration: 2 });
  assert.deepEqual(helperPayload(frame, { action: "left_click_drag", start_coordinate: [0, 0], coordinate: [720, 450] }), { action: "drag", x: 720, y: 450, fromX: 0, fromY: 0 });
  assert.deepEqual(helperPayload(frame, { action: "left_mouse_down" }), { action: "mouse_down", button: "left" });
  assert.deepEqual(helperPayload(undefined, { action: "type", text: "hi" }), { action: "type", text: "hi" });
  // Screenshot pixels scale onto the display's own points.
  assert.deepEqual(helperPayload({ ...frame, width: 2880, height: 1800, full: [2880, 1800], region: [0, 0, 2880, 1800] }, { action: "left_click", coordinate: [1440, 900] }), { action: "click", button: "left", x: 720, y: 450 });
  // After a zoom, the model's pixels are the crop's, and land where the crop was.
  assert.deepEqual(helperPayload({ ...frame, region: [100, 100, 200, 200] }, { action: "left_click", coordinate: [720, 450] }), { action: "click", button: "left", x: 200, y: 200 });
  assert.throws(() => helperPayload(undefined, { action: "left_click", coordinate: [1, 1] }), /screenshot before pointing/);
  assert.throws(() => helperPayload({ ...frame, displayId: 99 }, { action: "left_click", coordinate: [1, 1] }), /no longer available/);
  assert.throws(() => helperPayload(frame, { action: "wait", duration: 1 }), /handled by Emma/);
});

test("zoom crops the next screenshot, and cursor_position reads back through the crop", darwinOnly, async () => {
  const computer = runtime();
  computer.start(thread);
  await computer.execute({ action: "screenshot" });
  crops.length = 0;
  assert.match(await computer.execute({ action: "zoom", region: [100, 100, 300, 300] }), /next screenshot shows only that region/);
  await computer.screenshot();
  assert.deepEqual(crops, [{ x: 100, y: 100, width: 200, height: 200 }]);
  // The cursor is at 0,0 on the display, which is 100,100 outside the crop: the
  // read-back is the inverse of the click mapping, negative and all.
  assert.match(await computer.execute({ action: "cursor_position" }), /\[-720, -450\]/);

  // A plain screenshot forgets the zoom.
  await computer.execute({ action: "screenshot" });
  assert.equal(crops.length, 1);
  await computer.execute({ action: "zoom", region: [1400, 880, 1600, 1080] });
  await assert.rejects(computer.screenshot(), /outside the captured screen/);
  computer.abort("test");
});

test("a thread ID is core's, not a \"thread-\" prefix", darwinOnly, () => {
  const computer = runtime();
  computer.start(thread);
  computer.abort("test");
  assert.throws(() => computer.start("Thread-Upper"), /thread is invalid/);
  assert.throws(() => computer.start("a/../b"), /thread is invalid/);
});

test("abort fails every later action", darwinOnly, async () => {
  const computer = runtime();
  computer.start(thread);
  await computer.execute({ action: "screenshot" });
  computer.abort("stopped by the user");
  assert.equal(computer.active, false);
  await assert.rejects(computer.execute({ action: "screenshot" }), /no approved computer run/);
  assert.throws(() => computer.step(), /no approved computer run/);
});

test("steps, rate, and the log apply to every run", darwinOnly, async () => {
  const log: string[] = [];
  const computer = runtime(log);
  computer.start(thread);
  assert.ok(log[0].includes("run started"));
  for (let index = 0; index < MAX_RUN_STEPS; index += 1) assert.equal(computer.step(), true);
  assert.equal(computer.step(), false, "the step after the ceiling ends the turn");
  const started = Date.now();
  await computer.execute({ action: "screenshot" });
  await computer.execute({ action: "screenshot" });
  assert.ok(Date.now() - started >= 38, "consecutive actions stay rate-limited");
  assert.equal(computer.actions, 2);
  assert.ok(log.some((line) => line.includes("action 2/")), "every action is logged");
  computer.abort("test");
  assert.ok(log.at(-1)?.includes("after 2 actions"));
});

test("only one run is live at a time", darwinOnly, () => {
  const computer = runtime();
  computer.start(thread);
  assert.throws(() => computer.start("thread-second"), /already active/);
  computer.abort("test");
});
