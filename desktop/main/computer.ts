import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { desktopCapturer, nativeImage, screen, systemPreferences, type Display } from "electron";
import { BoundedLines } from "./ndjson";
import { MAX_SCREEN_CONTEXT_CHARS, validJpegDataUrl } from "./ipc";

/// Ceilings apply to every run, whatever the thread's permission mode cleared.
export const MAX_RUN_STEPS = 20;
const MAX_RUN_ACTIONS = 400;
const MIN_ACTION_INTERVAL_MS = 40;
const MAX_RUN_MS = 10 * 60_000;
const MAX_TYPED_CHARACTERS = 4096;
const MAX_HELPER_LINE_BYTES = 8 * 1024;
const HELPER_TIMEOUT_MS = 5_000;

const MAX_WAIT_SECONDS = 300;
const MAX_KEY_REPEAT = 32;

/* The `computer_toolset_20260801` vocabulary, so a model that already knows the
   Anthropic tool needs no retraining. Emma's older names (move/click/right_click)
   are kept as aliases because saved skills and traces still spell them that way. */
const actionKinds = [
  "screenshot", "zoom", "cursor_position", "wait",
  "mouse_move", "left_click", "right_click", "middle_click", "double_click", "triple_click",
  "left_mouse_down", "left_mouse_up", "left_click_drag", "scroll", "type", "key", "hold_key",
  "move", "click",
] as const;
type ActionKind = (typeof actionKinds)[number];

const scrollDirections = ["up", "down", "left", "right"] as const;
type Point = [number, number];

export type ComputerAction = {
  action: ActionKind;
  coordinate?: Point;
  start_coordinate?: Point;
  region?: [number, number, number, number];
  text?: string;
  scroll_direction?: (typeof scrollDirections)[number];
  scroll_amount?: number;
  duration?: number;
  repeat?: number;
};

/** Actions that point somewhere, and so need a prior screenshot to map from. */
const pointing = new Set<ActionKind>(["mouse_move", "move", "left_click", "click", "right_click", "middle_click", "double_click", "triple_click", "left_click_drag", "scroll"]);

/** `text` on a click or scroll is modifiers; on `key` it is a whole combo. */
function splitCombo(combo: string) {
  const parts = combo.split("+").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) throw new Error("Key combination is invalid");
  return { modifiers: parts.slice(0, -1), key: parts[parts.length - 1] };
}

export type ScreenFrame = { image: string; width: number; height: number };

/* What core mints: lowercase alphanumerics and hyphens, 16 to 96 characters — see
   `ThreadId::parse` in crates/core/src/thread.rs. There is no `thread-` prefix. */
const THREAD_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;

/// The two tools a granted run advertises. `computer` drives the screen; `write_skill`
/// is how a run records what it learned so the next one starts smarter.
export const computerTools = [
  {
    name: "computer",
    description:
      "Take over this Mac's real pointer and keyboard. Only for work that has no other route: driving a GUI app, or looking at the screen. Never for files or code — use read_file, write_file and terminal. The user must have asked for it, or you must ask them first and get a yes in the conversation; a granted permission dialog is not that ask. Call with action \"screenshot\" first, then use the returned pixel coordinates. Coordinates are [x, y] in screenshot pixels, top-left origin. Use \"zoom\" on a region when small text is hard to read.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...actionKinds] },
        coordinate: { type: "array", items: { type: "number" }, description: "[x, y] in screenshot pixels. Required for mouse_move, the clicks, scroll, and the end of left_click_drag." },
        start_coordinate: { type: "array", items: { type: "number" }, description: "[x, y] the drag starts from, for left_click_drag." },
        region: { type: "array", items: { type: "number" }, description: "[x0, y0, x1, y1] in screenshot pixels, for zoom. The next screenshot shows only this box, magnified." },
        text: { type: "string", description: "For \"type\", the text to type. For \"key\" and \"hold_key\", a combo such as cmd+s, ctrl+shift+tab, Return. On a click or scroll, the modifiers to hold, such as shift or cmd+alt." },
        scroll_direction: { type: "string", enum: [...scrollDirections], description: "Which way to scroll." },
        scroll_amount: { type: "number", description: "Wheel lines to scroll, 1 to 50." },
        duration: { type: "number", description: "Seconds, for wait and hold_key. At most 300." },
        repeat: { type: "number", description: "Press the key this many times, for \"key\". At most 32." },
      },
      required: ["action"],
    },
  },
  {
    name: "write_skill",
    description:
      "Record a durable lesson as a skill so future runs avoid a mistake or reuse a better route. Rewrite an existing name to correct an earlier lesson.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Lowercase hyphenated slug, for example safari-download-pdf" },
        instructions: { type: "string", description: "Markdown starting with a one-line summary, then the concrete steps that worked" },
      },
      required: ["name", "instructions"],
    },
  },
] as const;

export async function captureDisplay(display: Display): Promise<ScreenFrame> {
  if (process.platform === "darwin" && ["denied", "restricted"].includes(systemPreferences.getMediaAccessStatus("screen"))) {
    throw new Error("Screen Recording permission is required. Enable Emma in System Settings → Privacy & Security → Screen Recording.");
  }
  const width = Math.min(2560, Math.round(display.bounds.width * display.scaleFactor));
  const height = Math.min(1600, Math.round(display.bounds.height * display.scaleFactor));
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height }, fetchWindowIcons: false });
  const source = sources.find((item) => item.display_id === String(display.id));
  if (!source || source.thumbnail.isEmpty()) throw new Error("Emma could not capture this display. Check Screen Recording permission and try again.");
  const size = source.thumbnail.getSize();
  const image = `data:image/jpeg;base64,${source.thumbnail.toJPEG(82).toString("base64")}`;
  if (!validJpegDataUrl(image)) throw new Error("Emma captured an invalid screen frame");
  return { image, width: size.width, height: size.height };
}

/// Squeezes a frame under the host's screen-context ceiling, coarsening quality
/// before resolution so coordinates stay usable for as long as possible.
export function compressScreenFrame(image: Electron.NativeImage) {
  if (image.isEmpty()) throw new Error("Screen frame could not be composited");
  const size = image.getSize();
  for (const width of [Math.min(size.width, 1440), 1200, 960, 720]) {
    // Resized once per width, not once per attempt: the bitmap does not depend on the
    // JPEG quality, and re-decoding it four times was four multi-megabyte allocations
    // to throw away.
    const resized = image.resize({ width, quality: "good" });
    for (const quality of [68, 54, 42, 32]) {
      const dataUrl = `data:image/jpeg;base64,${resized.toJPEG(quality).toString("base64")}`;
      if (validJpegDataUrl(dataUrl, MAX_SCREEN_CONTEXT_CHARS)) return { image: dataUrl, ...resized.getSize() };
    }
  }
  throw new Error("Screen frame could not be compressed safely");
}

function finiteNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is invalid`);
  return value;
}

function point(value: unknown, label: string): Point {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label} must be [x, y]`);
  return [finiteNumber(value[0], `${label} x`), finiteNumber(value[1], `${label} y`)];
}

function validateAction(value: unknown): ComputerAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Computer action is invalid");
  const raw = value as Record<string, unknown>;
  if (typeof raw.action !== "string" || !(actionKinds as readonly string[]).includes(raw.action)) throw new Error("Computer action is invalid");
  const action = raw.action as ActionKind;
  const result: ComputerAction = { action };
  if (pointing.has(action)) result.coordinate = point(raw.coordinate, "coordinate");
  if (action === "left_click_drag") result.start_coordinate = point(raw.start_coordinate, "start_coordinate");
  if (action === "zoom") {
    const box = raw.region;
    if (!Array.isArray(box) || box.length !== 4) throw new Error("region must be [x0, y0, x1, y1]");
    const region = box.map((item, index) => finiteNumber(item, `region[${index}]`)) as [number, number, number, number];
    if (region[2] - region[0] < 8 || region[3] - region[1] < 8) throw new Error("Zoom region must be at least 8 pixels on each side");
    result.region = region;
  }
  if (action === "scroll") {
    if (typeof raw.scroll_direction !== "string" || !(scrollDirections as readonly string[]).includes(raw.scroll_direction)) throw new Error("scroll_direction must be up, down, left or right");
    result.scroll_direction = raw.scroll_direction as ComputerAction["scroll_direction"];
    // Mirrors the 50-line ceiling the native helper enforces, so the model gets the
    // error before an event is ever posted.
    const amount = Math.trunc(finiteNumber(raw.scroll_amount ?? 3, "scroll_amount"));
    if (amount < 1 || amount > 50) throw new Error("scroll_amount must be between 1 and 50");
    result.scroll_amount = amount;
  }
  if (action === "type" || action === "key" || action === "hold_key") {
    if (typeof raw.text !== "string" || raw.text.length === 0 || raw.text.length > MAX_TYPED_CHARACTERS) throw new Error("Typed text is invalid");
    result.text = raw.text;
  } else if (raw.text !== undefined) {
    // Everywhere else `text` is the modifiers held during the action.
    if (typeof raw.text !== "string" || raw.text.length > 64) throw new Error("Key modifiers are invalid");
    result.text = raw.text;
  }
  if (action === "wait" || action === "hold_key") {
    const seconds = finiteNumber(raw.duration, "duration");
    if (seconds < 0 || seconds > MAX_WAIT_SECONDS) throw new Error(`duration must be between 0 and ${MAX_WAIT_SECONDS} seconds`);
    result.duration = seconds;
  }
  if (action === "key" && raw.repeat !== undefined) {
    const times = Math.trunc(finiteNumber(raw.repeat, "repeat"));
    if (times < 1 || times > MAX_KEY_REPEAT) throw new Error(`repeat must be between 1 and ${MAX_KEY_REPEAT}`);
    result.repeat = times;
  }
  return result;
}

/// One line in, one line out, over the already-packaged `emma-option-tap` helper.
class InputHelper {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines = new BoundedLines(MAX_HELPER_LINE_BYTES);
  private readonly waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  private failure: Error | undefined;

  constructor(helperPath: string) {
    this.child = spawn(helperPath, ["--input"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (data: Buffer) => {
      try { for (const line of this.lines.push(data)) this.waiters.shift()?.resolve(line); }
      catch (error) { this.fail(error instanceof Error ? error : new Error("Computer input helper failed")); }
    });
    this.child.stderr.on("data", (data) => console.error(String(data).trim()));
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", () => this.fail(new Error("Computer input helper stopped")));
  }

  private fail(error: Error) {
    this.failure ??= error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure);
    if (!this.child.killed) this.child.kill();
  }

  /** `holdMs` buys back the time a `hold_key` deliberately spends not answering. */
  async send(payload: Record<string, unknown>, holdMs = 0) {
    if (this.failure) throw this.failure;
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("Computer action timed out");
        this.fail(error);
        reject(error);
      }, HELPER_TIMEOUT_MS + holdMs);
      this.waiters.push({ resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => { if (error) this.fail(error); });
    });
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Computer input helper returned an invalid result");
    const result = value as Record<string, unknown>;
    if (result.ok !== true) throw new Error(typeof result.error === "string" ? result.error.slice(0, 256) : "Computer action failed");
  }

  close() {
    this.fail(new Error("Computer run ended"));
    if (!this.child.stdin.destroyed) this.child.stdin.end();
  }
}

/// `width`/`height` are the image the model saw; `region` is the box of the full
/// capture it covers, and `full` that capture's size. A plain screenshot is the
/// whole thing, a zoom a sub-box, and the mapping back is the same either way.
type CapturedFrame = {
  displayId: number;
  width: number;
  height: number;
  region: [number, number, number, number];
  full: [number, number];
};

type ActiveRun = {
  threadId: string;
  startedAt: number;
  steps: number;
  actions: number;
  lastActionAt: number;
  helper: InputHelper | undefined;
  frame: CapturedFrame | undefined;
  shot: string | undefined;
  zoom: [number, number, number, number] | undefined;
};

export class ComputerUseRuntime {
  private run: ActiveRun | undefined;

  constructor(private readonly helperPath: string, private readonly log: (line: string) => void = (line) => console.log(line)) {}

  get active() {
    return this.run !== undefined;
  }

  get threadId() {
    return this.run?.threadId;
  }

  /// The agent loop's own gate is what approves a run: `computer` is `ask` in every
  /// mode but `full`, so by the time a call reaches here the user has already said yes.
  start(threadId: string) {
    if (process.platform !== "darwin") throw new Error("Computer use is macOS only in this build");
    if (!THREAD_ID.test(threadId)) throw new Error("Computer run thread is invalid");
    if (this.run) throw new Error("A computer run is already active");
    this.run = { threadId, startedAt: Date.now(), steps: 0, actions: 0, lastActionAt: 0, helper: undefined, frame: undefined, shot: undefined, zoom: undefined };
    this.log(`Emma computer run started for ${threadId}`);
    return { threadId, maxSteps: MAX_RUN_STEPS };
  }

  /// Counts one model step. Returns false when the run has used its budget, which
  /// ends the turn with an ordinary message rather than a silent stop.
  step() {
    const run = this.require();
    if (Date.now() - run.startedAt > MAX_RUN_MS) return false;
    run.steps += 1;
    return run.steps <= MAX_RUN_STEPS;
  }

  get steps() {
    return this.run?.steps ?? 0;
  }

  get actions() {
    return this.run?.actions ?? 0;
  }

  get shot() {
    return this.run?.shot;
  }

  async execute(value: unknown): Promise<string> {
    const run = this.require();
    const action = validateAction(value);
    if (run.actions >= MAX_RUN_ACTIONS) throw new Error("This computer run reached its action limit");
    const wait = MIN_ACTION_INTERVAL_MS - (Date.now() - run.lastActionAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    run.actions += 1;
    run.lastActionAt = Date.now();
    this.log(`Emma computer action ${run.actions}/${MAX_RUN_ACTIONS}: ${action.action}`);
    if (action.action === "screenshot") {
      run.zoom = undefined;
      const frame = await this.screenshot();
      return `Captured this display at ${frame.width}x${frame.height} pixels.`;
    }
    if (action.action === "zoom") {
      // The zoom is not a capture of its own: it arms the next screenshot, which
      // this run takes after every action anyway. One capture, not two.
      run.zoom = action.region;
      return `Zoomed to ${action.region!.join(", ")}. The next screenshot shows only that region, and its coordinates are the ones to use until you take a full screenshot again.`;
    }
    if (action.action === "cursor_position") {
      const at = this.cursorPixel();
      return `The pointer is at [${at[0]}, ${at[1]}] in the last screenshot's pixels.`;
    }
    if (action.action === "wait") {
      await new Promise((resolve) => setTimeout(resolve, (action.duration ?? 0) * 1000));
      return `Waited ${action.duration} seconds.`;
    }
    const payload = helperPayload(run.frame, action);
    run.helper ??= new InputHelper(this.helperPath);
    // A key with `repeat` is that many presses: the helper does one per line.
    for (let press = 0; press < (action.repeat ?? 1); press += 1) {
      await run.helper.send(payload, (action.duration ?? 0) * 1000);
    }
    // Give the target app a moment to react before the model looks again.
    await new Promise((resolve) => setTimeout(resolve, 120));
    return `Performed ${action.action}.`;
  }

  /// Captures the display the run is driving and remembers what box of it the model
  /// was shown, so screenshot coordinates map back to real screen points.
  async screenshot(): Promise<ScreenFrame> {
    const run = this.require();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const captured = await captureDisplay(display);
    let image = nativeImage.createFromDataURL(captured.image);
    let region: [number, number, number, number] = [0, 0, captured.width, captured.height];
    if (run.zoom) {
      const [x0, y0, x1, y1] = run.zoom;
      const previous = run.frame ?? { width: captured.width, height: captured.height, region, full: [captured.width, captured.height] as [number, number] };
      // The region is in the pixels of whatever the model last saw, which may itself
      // have been a zoom, so it is lifted back to full-capture pixels first.
      const lift = (value: number, axis: 0 | 1) =>
        previous.region[axis] + (value / (axis === 0 ? previous.width : previous.height)) * previous.region[axis + 2];
      region = [lift(x0, 0), lift(y0, 1), lift(x1, 0) - lift(x0, 0), lift(y1, 1) - lift(y0, 1)];
      const crop = { x: Math.round(region[0]), y: Math.round(region[1]), width: Math.round(region[2]), height: Math.round(region[3]) };
      if (crop.x < 0 || crop.y < 0 || crop.width < 8 || crop.height < 8 || crop.x + crop.width > captured.width || crop.y + crop.height > captured.height) {
        run.zoom = undefined;
        throw new Error("The zoom region is outside the captured screen. Take a screenshot and pick a region inside it.");
      }
      image = image.crop(crop);
    }
    run.zoom = undefined;
    const frame = compressScreenFrame(image);
    run.frame = { displayId: display.id, width: frame.width, height: frame.height, region: region as [number, number, number, number], full: [captured.width, captured.height] };
    run.shot = frame.image;
    return frame;
  }

  /// The inverse of `helperPayload`'s mapping: real screen point back to the pixels
  /// of whatever the model was last shown.
  private cursorPixel(): [number, number] {
    const run = this.require();
    if (!run.frame) throw new Error("Take a screenshot before asking where the pointer is");
    const display = screen.getAllDisplays().find((candidate) => candidate.id === run.frame!.displayId);
    if (!display) throw new Error("The captured display is no longer available");
    const at = screen.getCursorScreenPoint();
    const full = [
      ((at.x - display.bounds.x) / display.bounds.width) * run.frame.full[0],
      ((at.y - display.bounds.y) / display.bounds.height) * run.frame.full[1],
    ];
    return [
      Math.round(((full[0] - run.frame.region[0]) / run.frame.region[2]) * run.frame.width),
      Math.round(((full[1] - run.frame.region[1]) / run.frame.region[3]) * run.frame.height),
    ];
  }

  abort(reason = "stopped") {
    const run = this.run;
    this.run = undefined;
    if (!run) return;
    run.helper?.close();
    this.log(`Emma computer run ${reason} after ${run.actions} actions`);
  }

  private require() {
    if (!this.run) throw new Error("Emma has no approved computer run");
    return this.run;
  }

}

/// How each member reaches the native helper: its wire action and, where the helper
/// distinguishes them by argument rather than by name, its button.
const wire: Partial<Record<ActionKind, { action: string; button?: string }>> = {
  mouse_move: { action: "move" }, move: { action: "move" },
  left_click: { action: "click", button: "left" }, click: { action: "click", button: "left" },
  right_click: { action: "click", button: "right" },
  middle_click: { action: "click", button: "middle" },
  double_click: { action: "double_click", button: "left" },
  triple_click: { action: "triple_click", button: "left" },
  left_mouse_down: { action: "mouse_down", button: "left" },
  left_mouse_up: { action: "mouse_up", button: "left" },
  left_click_drag: { action: "drag" },
  scroll: { action: "scroll" }, type: { action: "type" }, key: { action: "key" }, hold_key: { action: "hold_key" },
};

/// Maps screenshot pixels onto the captured display's screen points, in the exact wire
/// shape `parse_action` in native/quick_ask.m accepts. Without a prior screenshot there
/// is nothing to map from, so pointer actions are refused.
export function helperPayload(frame: CapturedFrame | undefined, action: ComputerAction) {
  const shape = wire[action.action];
  if (!shape) throw new Error(`${action.action} is handled by Emma, not by the input helper`);
  const payload: Record<string, unknown> = { action: shape.action };
  if (shape.button) payload.button = shape.button;

  // The screenshot the model saw may have been a zoom, so pixels are relative to
  // that crop; `screenPoint` undoes the crop before it undoes the capture scale.
  const at = (value: Point, label: string) => {
    if (!frame) throw new Error("Take a screenshot before pointing at the screen");
    if (value[0] < 0 || value[1] < 0 || value[0] > frame.width || value[1] > frame.height) throw new Error(`${label} is outside the captured screen`);
    const display = screen.getAllDisplays().find((candidate) => candidate.id === frame.displayId);
    if (!display) throw new Error("The captured display is no longer available");
    const full = [frame.region[0] + (value[0] / frame.width) * frame.region[2], frame.region[1] + (value[1] / frame.height) * frame.region[3]];
    return [display.bounds.x + (full[0] / frame.full[0]) * display.bounds.width, display.bounds.y + (full[1] / frame.full[1]) * display.bounds.height];
  };

  if (action.coordinate) [payload.x, payload.y] = at(action.coordinate, "coordinate");
  if (action.start_coordinate) [payload.fromX, payload.fromY] = at(action.start_coordinate, "start_coordinate");
  if (action.action === "scroll") {
    const amount = action.scroll_amount ?? 3;
    payload.dx = action.scroll_direction === "right" ? amount : action.scroll_direction === "left" ? -amount : 0;
    payload.dy = action.scroll_direction === "up" ? amount : action.scroll_direction === "down" ? -amount : 0;
  }
  if (action.action === "type") payload.text = action.text;
  else if (action.action === "key" || action.action === "hold_key") {
    const { modifiers, key } = splitCombo(action.text ?? "");
    payload.key = key;
    if (modifiers.length) payload.modifiers = modifiers;
    if (action.action === "hold_key") payload.duration = action.duration;
  } else if (action.text) payload.modifiers = splitCombo(`${action.text}+_`).modifiers;
  return payload;
}
