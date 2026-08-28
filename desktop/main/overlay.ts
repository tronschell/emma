
export interface DisplayGeometry {
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
}

export interface NotchGeometry {
  id: number;
  x: number;
  width: number;
  height: number;
}

const ISLAND_WIDTH = 620;
const ISLAND_HEIGHT = 97;
const ORB_BAND = 126;
const HOTSPOT_PAD = 14;
const HOTSPOT_DROP = 44;
export const MAX_TRANSCRIPT = 260;
export const PILL_SIZE = 44;
const PILL_MARGIN = 16;
export const POPOUT_BAR = 28;
const ISLAND_INSET = 20;

const clamp = (value: number, low: number, high: number) => Math.round(Math.min(Math.max(value, low), Math.max(low, high)));

export function overlayGrowth(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_TRANSCRIPT, Math.max(0, Math.round(value))) : 0;
}

export function parseNotchGeometry(line: string): NotchGeometry[] {
  const value: unknown = JSON.parse(line);
  if (!Array.isArray(value) || value.length > 16) throw new Error("Display geometry is invalid");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Display geometry is invalid");
    const { id, x, width, height } = entry as Record<string, unknown>;
    if ([id, x, width, height].some((item) => typeof item !== "number" || !Number.isFinite(item))) throw new Error("Display geometry is invalid");
    const notch = { id: id as number, x: Math.round(x as number), width: Math.round(width as number), height: Math.round(height as number) };
    if (notch.width < 40 || notch.width > 600 || notch.height < 8 || notch.height > 120) throw new Error("Display geometry is invalid");
    return notch;
  });
}

export function overlayLayout(display: DisplayGeometry, preferences: { notchGap: number }, notch?: NotchGeometry) {
  const menuBar = Math.max(0, Math.round(display.workArea.y - display.bounds.y));
  const height = Math.max(24, menuBar, notch?.height ?? 0);
  const width = notch?.width ?? preferences.notchGap;
  const x = notch ? notch.x : Math.round(display.bounds.x + (display.bounds.width - width) / 2);
  const islandWidth = Math.min(ISLAND_WIDTH, display.bounds.width - 16);
  const limit = display.bounds.x + display.bounds.width - islandWidth;
  const left = Math.round(Math.min(Math.max(display.bounds.x, x + width / 2 - islandWidth / 2), limit));
  return {
    bounds: { x: left, y: display.bounds.y, width: islandWidth, height: height + ISLAND_HEIGHT + ORB_BAND },
    notch: { left: x - left, width, height },
  };
}

export function pillLayout(display: DisplayGeometry, spot?: { x: number; y: number }) {
  const area = display.workArea;
  return {
    x: clamp(spot?.x ?? area.x + area.width - PILL_SIZE - PILL_MARGIN, area.x, area.x + area.width - PILL_SIZE),
    y: clamp(spot?.y ?? area.y + PILL_MARGIN, area.y, area.y + area.height - PILL_SIZE),
    width: PILL_SIZE,
    height: PILL_SIZE,
  };
}

export function popoutLayout(display: DisplayGeometry, pill: { x: number; y: number }, grow: unknown = 0) {
  const area = display.workArea;
  const width = Math.min(ISLAND_WIDTH, area.width);
  const base = POPOUT_BAR + ISLAND_HEIGHT;
  const height = Math.min(base + overlayGrowth(grow), area.height);
  return {
    bounds: {
      x: clamp(pill.x - ISLAND_INSET, area.x, area.x + area.width - width),
      y: clamp(pill.y, area.y, area.y + area.height - height),
      width,
      height,
    },
    base,
  };
}

export function nearBounds(bounds: DisplayGeometry["bounds"], point: { x: number; y: number }, pad = 0) {
  return point.x >= bounds.x - pad && point.x <= bounds.x + bounds.width + pad
    && point.y >= bounds.y - pad && point.y <= bounds.y + bounds.height + pad;
}

export const hotspotPollDelay = (warm: boolean) => warm ? 120 : 250;

export function hotspotLayout(display: DisplayGeometry, notch: NotchGeometry) {
  const menuBar = Math.max(0, Math.round(display.workArea.y - display.bounds.y));
  const height = Math.max(menuBar, notch.height);
  return {
    bounds: { x: notch.x - HOTSPOT_PAD, y: display.bounds.y, width: notch.width + HOTSPOT_PAD * 2, height: height + HOTSPOT_DROP },
    notch: { left: HOTSPOT_PAD, width: notch.width, height },
  };
}
