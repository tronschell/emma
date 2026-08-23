
export interface DisplayGeometry {
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
}

/** Camera-housing bounds reported by AppKit, in screen points. */
export interface NotchGeometry {
  id: number;
  x: number;
  width: number;
  height: number;
}

/** Window width; .island is inset 20px each side in index.css so its shadow is not clipped. */
const ISLAND_WIDTH = 620;
/** Opaque surface under the housing, and the transparent band the orbs drop into. Both are mirrored by .island / .command-orbs in styles/overlay.css. */
const ISLAND_HEIGHT = 97;
const ORB_BAND = 126;
/** Hover margin around the housing that reveals the idle glow and opens Quick Ask. */
const HOTSPOT_PAD = 14;
const HOTSPOT_DROP = 44;
/** How far the island may extend as the quick thread grows before it scrolls instead. */
export const MAX_TRANSCRIPT = 260;
/** The chip Quick Ask collapses into when it leaves the housing, and its rest from the corner. */
export const PILL_SIZE = 44;
const PILL_MARGIN = 16;
/** Header height once the island is off the housing: there is no camera to wrap. Mirrors POPOUT_BAR in App.tsx. */
export const POPOUT_BAR = 28;
/** Mirrors --island-inset in styles/overlay.css: the island is inset inside its window so its shadow is not clipped. */
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

/**
 * The island spans the menu bar around the housing and hangs below it. Displays without a
 * camera housing fall back to a centred virtual notch of the configured gap.
 */
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

/**
 * The status chip, parked where the user last dragged it and otherwise in the top
 * right. Always whole and inside the work area: a chip half off the screen, or
 * under the menu bar, is one the user cannot get back.
 */
export function pillLayout(display: DisplayGeometry, spot?: { x: number; y: number }) {
  const area = display.workArea;
  return {
    x: clamp(spot?.x ?? area.x + area.width - PILL_SIZE - PILL_MARGIN, area.x, area.x + area.width - PILL_SIZE),
    y: clamp(spot?.y ?? area.y + PILL_MARGIN, area.y, area.y + area.height - PILL_SIZE),
    width: PILL_SIZE,
    height: PILL_SIZE,
  };
}

/**
 * The island hung off the chip rather than off the housing: the same surface, opened
 * where the user clicked. The window overhangs the chip on the left by the island's
 * own inset so their edges line up, and is pulled back on when the chip is parked
 * too near an edge for the island to fit beside it.
 */
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

/**
 * Whether the cursor is in a rectangle, optionally grown by `pad`.
 *
 * Used at two radii: `pad` 0 is the hover itself, and a wide `pad` is the warning that
 * builds the hotspot window before the cursor gets there.
 */
export function nearBounds(bounds: DisplayGeometry["bounds"], point: { x: number; y: number }, pad = 0) {
  return point.x >= bounds.x - pad && point.x <= bounds.x + bounds.width + pad
    && point.y >= bounds.y - pad && point.y <= bounds.y + bounds.height + pad;
}

/** Idle hover target: the housing plus a small margin, so a swipe into the notch reveals Emma. */
export function hotspotLayout(display: DisplayGeometry, notch: NotchGeometry) {
  const menuBar = Math.max(0, Math.round(display.workArea.y - display.bounds.y));
  const height = Math.max(menuBar, notch.height);
  return {
    bounds: { x: notch.x - HOTSPOT_PAD, y: display.bounds.y, width: notch.width + HOTSPOT_PAD * 2, height: height + HOTSPOT_DROP },
    notch: { left: HOTSPOT_PAD, width: notch.width, height },
  };
}
