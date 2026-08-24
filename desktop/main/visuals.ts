import { BrowserWindow } from "electron";
import { VISUAL_BG, VISUAL_HEIGHT_JS, visualFrameUrl, type Visual } from "../shared/visualize";

const KEPT = 64;
const MIN_CAPTURE_WIDTH = 320;
const MAX_CAPTURE_WIDTH = 2000;
const MIN_CAPTURE_HEIGHT = 120;
const MAX_CAPTURE_HEIGHT = 8000;
const PAINT_MS = 150;

const visuals = new Map<string, Visual>();
let minted = 0;

export function keepVisual(visual: Visual): string {
  minted += 1;
  const id = `v${minted.toString(36)}-${Date.now().toString(36)}`;
  visuals.set(id, visual);
  for (const stale of [...visuals.keys()].slice(0, Math.max(0, visuals.size - KEPT))) visuals.delete(stale);
  return id;
}

export const readVisual = (id: string) => visuals.get(id);

const clamp = (value: unknown, low: number, high: number, fallback: number) =>
  Math.min(high, Math.max(low, Math.round(typeof value === "number" && Number.isFinite(value) ? value : fallback)));

export async function captureVisual(id: string, width: unknown): Promise<Buffer> {
  if (!visuals.has(id)) throw new Error("That visual is no longer in this conversation.");
  const frameWidth = clamp(width, MIN_CAPTURE_WIDTH, MAX_CAPTURE_WIDTH, 720);
  const window = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    width: frameWidth,
    height: 600,
    backgroundColor: VISUAL_BG,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await window.loadURL(visualFrameUrl(id));
    const measured: unknown = await window.webContents.executeJavaScript(VISUAL_HEIGHT_JS);
    window.setContentSize(frameWidth, clamp(measured, MIN_CAPTURE_HEIGHT, MAX_CAPTURE_HEIGHT, 600));
    await new Promise((resolve) => setTimeout(resolve, PAINT_MS));
    return (await window.webContents.capturePage()).toPNG();
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}
