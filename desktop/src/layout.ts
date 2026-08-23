/** What one graph's boxes measure, and the room left around and between them. */
export type GraphBox = { width: number; height: number; gapX: number; gapY: number; lane: number };

/**
 * Boxes on a grid: one row per level, every row centred on the widest one, plus the
 * canvas that holds them. Pure geometry — which row an id is in is decided by
 * whoever owns the graph, which is `workflowRows` for a scheduled task and
 * `planRows` for a plan.
 */
export function placeRows(rows: string[][], box: GraphBox): { placed: { id: string; x: number; y: number }[]; width: number; height: number } {
  const widest = Math.max(1, ...rows.map((row) => row.length));
  const span = widest * box.width + (widest - 1) * box.gapX;
  const placed = rows.flatMap((row, level) => row.map((id, column) => {
    const rowSpan = row.length * box.width + (row.length - 1) * box.gapX;
    return { id, x: box.lane + (span - rowSpan) / 2 + column * (box.width + box.gapX), y: level * (box.height + box.gapY) };
  }));
  return { placed, width: span + box.lane * 2, height: Math.max(box.height, rows.length * (box.height + box.gapY) - box.gapY) };
}

/**
 * The line from one box to another, and where its label sits.
 *
 * Into the row below is a straight drop. Anything else — an edge that skips a row,
 * one that points back up — runs out to a side lane instead of cutting through the
 * boxes in between: past the row below it, a straight line would end up pointing at
 * the wrong box.
 */
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

export interface PaneLayout {
  sidebarWidth: number;
  inspectorWidth: number;
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  /* Section nav as one horizontal row of glyph tiles, Arc's pinned strip. */
  navIcons: boolean;
}

export const defaultPaneLayout: PaneLayout = {
  sidebarWidth: 260,
  inspectorWidth: 288,
  sidebarCollapsed: false,
  inspectorCollapsed: false,
  navIcons: false,
};

const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

export function validatePaneLayout(value: unknown, viewportWidth = Number.POSITIVE_INFINITY): PaneLayout {
  const input = value && typeof value === "object" ? value as Partial<PaneLayout> : {};
  const layout = {
    sidebarWidth: number(input.sidebarWidth, defaultPaneLayout.sidebarWidth, 200, 340),
    inspectorWidth: number(input.inspectorWidth, defaultPaneLayout.inspectorWidth, 260, 360),
    sidebarCollapsed: typeof input.sidebarCollapsed === "boolean" ? input.sidebarCollapsed : false,
    inspectorCollapsed: typeof input.inspectorCollapsed === "boolean" ? input.inspectorCollapsed : false,
    navIcons: typeof input.navIcons === "boolean" ? input.navIcons : false,
  };
  const fixedWidth = 320 + (layout.sidebarCollapsed ? 46 : 200) + (layout.inspectorCollapsed ? 30 : 260);
  const requestedSlack = (layout.sidebarCollapsed ? 0 : layout.sidebarWidth - 200) + (layout.inspectorCollapsed ? 0 : layout.inspectorWidth - 260);
  // A window that has not been laid out yet reports innerWidth 0. Treating that as
  // a real viewport shrinks both panes to their minimums and the caller persists it,
  // so an unmeasured window is no constraint at all.
  const width = viewportWidth > 0 ? viewportWidth : Number.POSITIVE_INFINITY;
  const ratio = requestedSlack ? Math.min(1, Math.max(0, (Math.floor(width) - fixedWidth) / requestedSlack)) : 1;
  if (!layout.sidebarCollapsed) layout.sidebarWidth = 200 + Math.floor((layout.sidebarWidth - 200) * ratio);
  if (!layout.inspectorCollapsed) layout.inspectorWidth = 260 + Math.floor((layout.inspectorWidth - 260) * ratio);
  return layout;
}
