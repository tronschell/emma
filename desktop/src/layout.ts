export interface PaneLayout {
  navWidth: number;
  listWidth: number;
  inspectorWidth: number;
  navCollapsed: boolean;
  listCollapsed: boolean;
  inspectorCollapsed: boolean;
}

export const defaultPaneLayout: PaneLayout = {
  navWidth: 188,
  listWidth: 246,
  inspectorWidth: 232,
  navCollapsed: false,
  listCollapsed: false,
  inspectorCollapsed: false,
};

const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

export function validatePaneLayout(value: unknown): PaneLayout {
  const input = value && typeof value === "object" ? value as Partial<PaneLayout> : {};
  return {
    navWidth: number(input.navWidth, defaultPaneLayout.navWidth, 156, 260),
    listWidth: number(input.listWidth, defaultPaneLayout.listWidth, 190, 380),
    inspectorWidth: number(input.inspectorWidth, defaultPaneLayout.inspectorWidth, 210, 360),
    navCollapsed: typeof input.navCollapsed === "boolean" ? input.navCollapsed : false,
    listCollapsed: typeof input.listCollapsed === "boolean" ? input.listCollapsed : false,
    inspectorCollapsed: typeof input.inspectorCollapsed === "boolean" ? input.inspectorCollapsed : false,
  };
}
