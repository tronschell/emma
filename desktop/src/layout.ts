import { DEFAULT_TERMINAL_HEIGHT, MAX_TERMINAL_HEIGHT, MIN_TERMINAL_HEIGHT } from "../shared/terminal";

export type GraphBox = { width: number; height: number; gapX: number; gapY: number; lane: number };

export function placeRows(rows: string[][], box: GraphBox): { placed: { id: string; x: number; y: number }[]; width: number; height: number } {
  const widest = Math.max(1, ...rows.map((row) => row.length));
  const span = widest * box.width + (widest - 1) * box.gapX;
  const placed = rows.flatMap((row, level) => row.map((id, column) => {
    const rowSpan = row.length * box.width + (row.length - 1) * box.gapX;
    return { id, x: box.lane + (span - rowSpan) / 2 + column * (box.width + box.gapX), y: level * (box.height + box.gapY) };
  }));
  return { placed, width: span + box.lane * 2, height: Math.max(box.height, rows.length * (box.height + box.gapY) - box.gapY) };
}

export function edgePath(from: { x: number; y: number }, to: { x: number; y: number }, box: GraphBox, canvasWidth: number) {
  const x1 = from.x + box.width / 2;
  const y1 = from.y + box.height;
  const x2 = to.x + box.width / 2;
  const y2 = to.y - 2;
  const straight = to.y - from.y === box.height + box.gapY;
  const lane = to.y <= from.y ? box.lane / 2 : canvasWidth - box.lane / 2;
  return {
    d: straight
      ? `M${x1} ${y1} C${x1} ${y1 + box.gapY / 2}, ${x2} ${to.y - box.gapY / 2}, ${x2} ${y2}`
      : `M${x1} ${y1} C${x1} ${y1 + 24}, ${lane} ${y1}, ${lane} ${y1 + 28} L${lane} ${y2 - 28} C${lane} ${y2}, ${x2} ${y2 - 28}, ${x2} ${y2}`,
    labelX: straight ? x1 + 8 : (x1 + lane) / 2,
    labelY: y1 + 18,
  };
}

export const NAV_VIEWS = ["knowledge", "artifacts", "scheduled", "agent", "plugins"] as const;

export interface PaneLayout {
  sidebarWidth: number;
  inspectorWidth: number;
  browserWidth: number;
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  browserOpen: boolean;
  terminalOpen: boolean;
  terminalHeight: number;
  navIcons: boolean;
  navOrder: string[];
  projectOrder: string[];
  projectSort: "project" | "priority";
}

export const defaultPaneLayout: PaneLayout = {
  sidebarWidth: 260,
  inspectorWidth: 288,
  browserWidth: 420,
  sidebarCollapsed: false,
  inspectorCollapsed: false,
  browserOpen: false,
  terminalOpen: false,
  terminalHeight: DEFAULT_TERMINAL_HEIGHT,
  navIcons: false,
  navOrder: [],
  projectOrder: [],
  projectSort: "project",
};

export function ordered<T extends { id: string }>(items: T[], order: string[]): T[] {
  const dragged = order.map((id) => items.find((item) => item.id === id)).filter((item) => item !== undefined);
  return [...dragged, ...items.filter((item) => !order.includes(item.id))];
}

const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

const idList = (value: unknown, allowed?: readonly string[]) => {
  const list = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 64) : [];
  return [...new Set(list)].filter((id) => !allowed || allowed.includes(id)).slice(0, 64);
};

export const MIN_BROWSER_WIDTH = 260;
export const WIDE_BROWSER_WIDTH = 720;

export function validatePaneLayout(value: unknown): PaneLayout {
  const input = value && typeof value === "object" ? value as Partial<PaneLayout> : {};
  return {
    sidebarWidth: number(input.sidebarWidth, defaultPaneLayout.sidebarWidth, 200, 340),
    inspectorWidth: number(input.inspectorWidth, defaultPaneLayout.inspectorWidth, 260, 360),
    browserWidth: number(input.browserWidth, defaultPaneLayout.browserWidth, MIN_BROWSER_WIDTH, 720),
    sidebarCollapsed: typeof input.sidebarCollapsed === "boolean" ? input.sidebarCollapsed : false,
    inspectorCollapsed: typeof input.inspectorCollapsed === "boolean" ? input.inspectorCollapsed : false,
    browserOpen: typeof input.browserOpen === "boolean" ? input.browserOpen : false,
    terminalOpen: typeof input.terminalOpen === "boolean" ? input.terminalOpen : false,
    terminalHeight: number(input.terminalHeight, DEFAULT_TERMINAL_HEIGHT, MIN_TERMINAL_HEIGHT, MAX_TERMINAL_HEIGHT),
    navIcons: typeof input.navIcons === "boolean" ? input.navIcons : false,
    navOrder: idList(input.navOrder, NAV_VIEWS),
    projectOrder: idList(input.projectOrder),
    projectSort: input.projectSort === "priority" ? "priority" as const : "project" as const,
  };
}

export function fitPaneLayout(layout: PaneLayout, viewportWidth = Number.POSITIVE_INFINITY): PaneLayout {
  const fixedWidth = 320 + (layout.sidebarCollapsed ? 46 : 200) + (layout.inspectorCollapsed ? 0 : 260) + (layout.browserOpen ? MIN_BROWSER_WIDTH : 0);
  const requestedSlack = (layout.sidebarCollapsed ? 0 : layout.sidebarWidth - 200)
    + (layout.inspectorCollapsed ? 0 : layout.inspectorWidth - 260)
    + (layout.browserOpen ? layout.browserWidth - MIN_BROWSER_WIDTH : 0);
  const width = viewportWidth > 0 ? viewportWidth : Number.POSITIVE_INFINITY;
  const ratio = requestedSlack ? Math.min(1, Math.max(0, (Math.floor(width) - fixedWidth) / requestedSlack)) : 1;
  if (ratio === 1) return layout;
  return {
    ...layout,
    sidebarWidth: layout.sidebarCollapsed ? layout.sidebarWidth : 200 + Math.floor((layout.sidebarWidth - 200) * ratio),
    inspectorWidth: layout.inspectorCollapsed ? layout.inspectorWidth : 260 + Math.floor((layout.inspectorWidth - 260) * ratio),
    browserWidth: layout.browserOpen ? MIN_BROWSER_WIDTH + Math.floor((layout.browserWidth - MIN_BROWSER_WIDTH) * ratio) : layout.browserWidth,
  };
}
