/* How an authored page reads: Markdown parsed into real elements instead of
   printed with its syntax showing, and consecutive pictures gathered into one
   carousel instead of stacked full width down the column. */

import type { ArtifactBlock } from "./types";

export interface Inline {
  text: string;
  bold?: true;
  italic?: true;
  code?: true;
  href?: string;
}

export type MarkdownNode =
  | { kind: "heading"; level: number; spans: Inline[] }
  | { kind: "paragraph"; spans: Inline[] }
  | { kind: "quote"; spans: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; text: string };

// ponytail: the Markdown a knowledge page actually uses. No tables, no nested
// lists, no reference links — the agent is told to author within this subset.
// `_` only emphasises at word boundaries, or `cls_token` reads as *cls*token.
const INLINE = /\*\*([^*]+)\*\*|(?<!\w)__([^_]+)__(?!\w)|\*([^*]+)\*|(?<!\w)_([^_]+)_(?!\w)|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Model text is not trusted to carry a scheme: only real web links become links. */
function safeHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch { return undefined; }
}

export function inlineSpans(text: string): Inline[] {
  const spans: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) spans.push({ text: text.slice(last, at) });
    last = at + match[0].length;
    const strong = match[1] ?? match[2];
    const emphasis = match[3] ?? match[4];
    if (strong) spans.push({ text: strong, bold: true });
    else if (emphasis) spans.push({ text: emphasis, italic: true });
    else if (match[5]) spans.push({ text: match[5], code: true });
    else {
      const href = safeHref(match[7]);
      spans.push(href ? { text: match[6], href } : { text: match[6] });
    }
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.length ? spans : [{ text }];
}

export function parseMarkdown(markdown: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let paragraph: string[] = [];
  let fence: string[] | null = null;
  const flush = () => {
    if (paragraph.length) nodes.push({ kind: "paragraph", spans: inlineSpans(paragraph.join(" ")) });
    paragraph = [];
  };
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (line.trimStart().startsWith("```")) {
      if (fence) { nodes.push({ kind: "code", text: fence.join("\n") }); fence = null; } else { flush(); fence = []; }
      continue;
    }
    if (fence) { fence.push(raw); continue; }
    if (!line.trim() || /^\s*([-*_])\1{2,}\s*$/.test(line)) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) { flush(); nodes.push({ kind: "heading", level: heading[1].length, spans: inlineSpans(heading[2]) }); continue; }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const previous = nodes[nodes.length - 1];
      if (previous?.kind === "list" && previous.ordered === ordered) previous.items.push(inlineSpans(bullet[1]));
      else nodes.push({ kind: "list", ordered, items: [inlineSpans(bullet[1])] });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) { flush(); nodes.push({ kind: "quote", spans: inlineSpans(quote[1]) }); continue; }
    paragraph.push(line.trim());
  }
  if (fence) nodes.push({ kind: "code", text: fence.join("\n") });
  flush();
  return nodes;
}

export type DocumentGroup = { kind: "images"; blocks: ArtifactBlock[] } | { kind: "block"; block: ArtifactBlock };

/**
 * The reading order of a page: its summary is already the lede above the document,
 * so it is not repeated here, and neighbouring pictures become one carousel.
 */
export function documentGroups(blocks: ArtifactBlock[], leadId = "summary"): DocumentGroup[] {
  const groups: DocumentGroup[] = [];
  for (const block of blocks) {
    if (block.id === leadId) continue;
    const previous = groups[groups.length - 1];
    if (block.type !== "image") { groups.push({ kind: "block", block }); continue; }
    if (previous?.kind === "images") previous.blocks.push(block);
    else groups.push({ kind: "images", blocks: [block] });
  }
  return groups;
}
