export type ComputerCursor = {
  windowId: number;
  bounds: { x: number; y: number; width: number; height: number };
  x: number;
  y: number;
};

export type ComputerRunProgress = { step: number; action: string; actions: number; app?: string; cursor?: ComputerCursor | null };

export const COMPUTER_CURSOR_MS = 1400;

export const computerActionLabels: Record<string, string> = {
  list_apps: "Finding apps",
  launch_app: "Opening an app",
  get_app_state: "Reading",
  click: "Clicking",
  set_value: "Editing",
  type_text: "Typing",
  key: "Pressing a key",
  scroll: "Scrolling",
};

const coordinate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 100_000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function validComputerCursor(value: unknown): value is ComputerCursor {
  if (!record(value) || !record(value.bounds)) return false;
  const { x, y, windowId, bounds } = value;
  if (Object.keys(value).some((key) => !["x", "y", "windowId", "bounds"].includes(key)) || Object.keys(bounds).some((key) => !["x", "y", "width", "height"].includes(key))) return false;
  return Number.isSafeInteger(windowId) && (windowId as number) > 0 && (windowId as number) <= 0xffff_ffff
    && coordinate(x) && coordinate(y) && coordinate(bounds.x) && coordinate(bounds.y)
    && coordinate(bounds.width) && bounds.width > 0 && bounds.width <= 16_384
    && coordinate(bounds.height) && bounds.height > 0 && bounds.height <= 16_384
    && x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height;
}

export function validComputerProgress(value: unknown): value is ComputerRunProgress {
  if (!record(value)) return false;
  return Number.isInteger(value.step) && (value.step as number) >= 0 && (value.step as number) <= 20
    && Number.isInteger(value.actions) && (value.actions as number) >= 0 && (value.actions as number) <= 20
    && typeof value.action === "string" && value.action.length <= 80
    && (value.app === undefined || (typeof value.app === "string" && value.app.length <= 256))
    && (value.cursor === undefined || value.cursor === null || validComputerCursor(value.cursor));
}

export function roundComputerCursor(cursor: ComputerCursor): ComputerCursor | null {
  const x = Math.floor(cursor.bounds.x);
  const y = Math.floor(cursor.bounds.y);
  const width = Math.ceil(cursor.bounds.x + cursor.bounds.width) - x;
  const height = Math.ceil(cursor.bounds.y + cursor.bounds.height) - y;
  const rounded = { ...cursor, bounds: { x, y, width, height } };
  return validComputerCursor(rounded) ? rounded : null;
}
