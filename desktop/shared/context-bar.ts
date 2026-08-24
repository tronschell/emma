/* What the thread inspector shows, and in what order.

   The bar used to be a fixed stack — stats, ledger, timeline, subagents — which
   is the right default and the wrong ceiling: reading a long research thread and
   watching a coding run want different panels, and the column is only ~288px
   wide, so anything you are not reading is pushing what you are below the fold.

   So the stack is data. Settings reorders it, drops what a given kind of work
   never looks at, and keeps up to four arrangements; the bar itself switches
   between them. The components are unchanged — this file only says which ones,
   in what order, and laid out which way. */

/** Every component the bar can hold. `orientable` ones lay out two ways; the rest have one shape. */
export const CONTEXT_WIDGETS = [
  { type: "stats", label: "Thread stats", glyph: "▦", blurb: "Messages, replies, attachments, tool calls, speed, and output tokens.", orientable: true },
  { type: "context", label: "Context window", glyph: "▤", blurb: "What the last turn carried, by kind, against the model's stated window.", orientable: true },
  { type: "timeline", label: "Timeline", glyph: "⌇", blurb: "Every turn as a waterfall — model requests, tool calls, subagents.", orientable: false },
  { type: "plan", label: "Plan", glyph: "◰", blurb: "The plan this thread is working through, drawn as a graph of subagents. Press a node to light its wave.", orientable: false },
  { type: "subagents", label: "Subagents", glyph: "⌸", blurb: "One row per subagent, into the transcript it is writing.", orientable: true },
  { type: "subthreads", label: "Sub threads", glyph: "⑃", blurb: "Threads this one started, working or idle. They outlive their runs, so the rows stay.", orientable: true },
  { type: "git", label: "Git", glyph: "⑂", blurb: "Branch, working tree, and the diff behind it. Empty outside a repo.", orientable: false },
] as const;

export type ContextWidgetType = (typeof CONTEXT_WIDGETS)[number]["type"];

/**
 * How a widget lays its own contents out.
 *
 * `vertical` is one item per line — the shape that survives a narrow column.
 * `horizontal` flows across and wraps, which fits more in less height at the
 * cost of the labels going small. Neither is a rotation of the other; they are
 * the two readings each component already had.
 */
export type WidgetOrientation = "vertical" | "horizontal";

export interface ContextWidget {
  type: ContextWidgetType;
  orientation: WidgetOrientation;
}

export interface ContextPage {
  id: string;
  name: string;
  widgets: ContextWidget[];
}

/* Four is the ceiling because the switcher is a row of tabs in a 288px column:
   a fifth tab either truncates every name to three characters or wraps the row. */
export const MAX_CONTEXT_PAGES = 4;
export const MAX_PAGE_NAME = 20;

export const widgetDefinition = (type: ContextWidgetType) => CONTEXT_WIDGETS.find((item) => item.type === type)!;
const isWidgetType = (value: unknown): value is ContextWidgetType => CONTEXT_WIDGETS.some((item) => item.type === value);

/** Page 1 is the bar exactly as it was before it was configurable; page 2 is a run being watched. */
export const defaultContextPages: ContextPage[] = [
  {
    id: "p1",
    name: "Context",
    widgets: [
      { type: "stats", orientation: "horizontal" },
      { type: "context", orientation: "vertical" },
      { type: "timeline", orientation: "vertical" },
      { type: "plan", orientation: "vertical" },
      { type: "subagents", orientation: "vertical" },
      { type: "subthreads", orientation: "vertical" },
    ],
  },
  {
    id: "p2",
    name: "Run",
    widgets: [
      { type: "timeline", orientation: "vertical" },
      { type: "plan", orientation: "vertical" },
      { type: "subagents", orientation: "vertical" },
      { type: "subthreads", orientation: "vertical" },
      { type: "git", orientation: "vertical" },
    ],
  },
];

/** The lowest `p<n>` no page is using, so a new page's id never collides with a removed one's. */
export function nextPageId(pages: readonly ContextPage[]): string {
  for (let index = 1; index <= MAX_CONTEXT_PAGES; index += 1) {
    const id = `p${index}`;
    if (!pages.some((page) => page.id === id)) return id;
  }
  return `p${MAX_CONTEXT_PAGES}`;
}

/* A page holds each component at most once. Two copies of one ledger in a column
   this narrow is noise, and the constraint is what lets the type be the key the
   drag-and-drop sorts by — no instance ids to mint, none to keep unique. */
export function validateContextPages(value: unknown): ContextPage[] {
  if (value === undefined || value === null) return structuredClone(defaultContextPages);
  if (!Array.isArray(value) || !value.length || value.length > MAX_CONTEXT_PAGES) throw new Error(`Keep 1 to ${MAX_CONTEXT_PAGES} context bar pages`);
  const pages = value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("A context bar page is invalid");
    const page = item as Partial<ContextPage>;
    if (typeof page.id !== "string" || !/^p[1-9]$/.test(page.id)) throw new Error("A context bar page is invalid");
    if (typeof page.name !== "string" || !page.name.trim() || page.name.length > MAX_PAGE_NAME) throw new Error(`Name every context bar page, in ${MAX_PAGE_NAME} characters or fewer`);
    if (!Array.isArray(page.widgets) || page.widgets.length > CONTEXT_WIDGETS.length) throw new Error("A context bar page is invalid");
    const widgets = page.widgets.map((entry) => {
      const widget = entry as Partial<ContextWidget>;
      if (!widget || !isWidgetType(widget.type)) throw new Error("A context bar component is invalid");
      const orientation = widget.orientation === "horizontal" ? "horizontal" : "vertical";
      return { type: widget.type, orientation: widgetDefinition(widget.type).orientable ? orientation : "vertical" } as ContextWidget;
    });
    if (new Set(widgets.map((widget) => widget.type)).size !== widgets.length) throw new Error("A component can only appear once on a page");
    return { id: page.id, name: page.name.trim(), widgets };
  });
  if (new Set(pages.map((page) => page.id)).size !== pages.length) throw new Error("Context bar pages must have distinct ids");
  return pages;
}
