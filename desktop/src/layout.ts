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

export function validatePaneLayout(value: unknown, viewportWidth = Number.POSITIVE_INFINITY): PaneLayout {
  const input = value && typeof value === "object" ? value as Partial<PaneLayout> : {};
  const layout = {
    navWidth: number(input.navWidth, defaultPaneLayout.navWidth, 156, 260),
    listWidth: number(input.listWidth, defaultPaneLayout.listWidth, 190, 380),
    inspectorWidth: number(input.inspectorWidth, defaultPaneLayout.inspectorWidth, 210, 360),
    navCollapsed: typeof input.navCollapsed === "boolean" ? input.navCollapsed : false,
    listCollapsed: typeof input.listCollapsed === "boolean" ? input.listCollapsed : false,
    inspectorCollapsed: typeof input.inspectorCollapsed === "boolean" ? input.inspectorCollapsed : false,
  };
  const fixedWidth = 320 + (layout.navCollapsed ? 46 : 156) + (layout.listCollapsed ? 30 : 190) + (layout.inspectorCollapsed ? 30 : 210);
  const requestedSlack = (layout.navCollapsed ? 0 : layout.navWidth - 156) + (layout.listCollapsed ? 0 : layout.listWidth - 190) + (layout.inspectorCollapsed ? 0 : layout.inspectorWidth - 210);
  const ratio = requestedSlack ? Math.min(1, Math.max(0, (Math.floor(viewportWidth) - fixedWidth) / requestedSlack)) : 1;
  if (!layout.navCollapsed) layout.navWidth = 156 + Math.floor((layout.navWidth - 156) * ratio);
  if (!layout.listCollapsed) layout.listWidth = 190 + Math.floor((layout.listWidth - 190) * ratio);
  if (!layout.inspectorCollapsed) layout.inspectorWidth = 210 + Math.floor((layout.inspectorWidth - 210) * ratio);
  return layout;
}
