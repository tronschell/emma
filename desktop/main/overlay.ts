import type { OverlayPreferences } from "../shared/settings";

export interface DisplayGeometry {
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
}

export function overlayBounds(display: DisplayGeometry, preferences: OverlayPreferences) {
  const preferredWidth = preferences.overlayPlacement === "rails" ? 820 : 540;
  const width = Math.min(preferredWidth, display.workArea.width - 16);
  const workAreaRight = display.workArea.x + display.workArea.width;
  const displayCenteredX = Math.round(display.bounds.x + (display.bounds.width - width) / 2);
  const x = preferences.overlayPlacement === "rails"
    ? Math.min(workAreaRight - width, Math.max(display.workArea.x, displayCenteredX))
    : Math.round(display.workArea.x + (display.workArea.width - width) / 2);
  return {
    x,
    y: preferences.overlayPlacement === "rails" ? display.bounds.y : display.workArea.y + 8,
    width,
    height: preferences.overlayPlacement === "rails" ? 170 : 228,
  };
}
