/* What counts as "the same page", and what counts as a page that is still a raw clip.
   One rule for both, because the notch's ⌘-page button and the save_page tool must not
   disagree about whether the base already keeps what the user is looking at. */

export type SavedPage = {
  id: string;
  title: string;
  category: string;
  knowledgeBaseId: string;
  telemetry?: { model?: string };
  context?: { sourceUrl?: string };
};

/** ponytail: scheme, host, path, query. A #fragment or a trailing slash is the same
    page; the query stays, because on plenty of sites the query is the page. */
export function comparableUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}${url.search}`.toLowerCase();
  } catch { return ""; }
}

/** The page this base already keeps for a URL, if it keeps one. */
export function pageForUrl<T extends SavedPage>(pages: readonly T[], knowledgeBaseId: string, url: string): T | undefined {
  const wanted = comparableUrl(url);
  if (!wanted) return undefined;
  return pages.find((page) => page.knowledgeBaseId === knowledgeBaseId && comparableUrl(page.context?.sourceUrl ?? "") === wanted);
}

/** A capture whose document was never built: the clip is all there is to show. The
    telemetry model core writes for a capture, before any analysis has run over it. */
export const CAPTURE_MODEL = "capture";

export const isRawClip = (page: { telemetry?: { model?: string } }) => page.telemetry?.model === CAPTURE_MODEL;
