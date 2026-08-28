/* Markdown as a model actually emits it — headings, fences, pipe tables, lists —
   turned into data. Nothing here knows about React or the DOM.

   The split from markdown.tsx is not taste: `npm test` compiles
   tsconfig.main.json, which does not take JSX, so anything a node --test file
   imports has to be a plain .ts module. Parsing lives here, element mapping
   lives there.

   ponytail: src/document.ts carries a smaller parser of the same shape for
   knowledge pages (no tables, no fence language, no soft breaks). Collapse the
   two onto this one when document.ts next needs a feature. */

export interface Span {
  text: string;
  bold?: true;
  italic?: true;
  strike?: true;
  code?: true;
  href?: string;
  /** A file on disk, cleaned of any `:line` suffix — clicking it reveals it in Finder. */
  path?: string;
  image?: true;
}

export interface Item { spans: Span[]; sub?: List }
export interface List { ordered: boolean; items: Item[] }
export type Row = Span[][];

export type Block =
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "quote"; spans: Span[] }
  | { kind: "code"; language: string; text: string }
  | ({ kind: "list" } & List)
  | { kind: "table"; head: Row; rows: Row[] }
  | { kind: "rule" };

/* Code first, so a `**` inside backticks stays literal. Emphasis is flat: a
   span carries one mark, never a mark inside a mark. */
/* Bare URLs autolink last, so a `[text](url)` above still wins the address.
   The tail excludes closing punctuation: a link at the end of a sentence
   must not swallow the period. */
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*]+)\*|_([^_]+)_|(!?)\[([^\]]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"])/g;
const FENCE = /^\s{0,3}(?:```|~~~)\s*([\w+#.-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)(?:[-*+]|(\d+)[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const DELIMITER = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*(?::?-+:?\s*)?$/;

/** Model text is not trusted to carry a scheme: only real web links become links. */
function safeHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch { return undefined; }
}

/**
 * A code span or link target that reads like a file on disk rather than prose.
 * Absolute, `~`-rooted and `./`-rooted paths count; so does any slashed path
 * whose last segment carries an extension. A `:line[:column]` suffix is dropped
 * — the span still shows it, only the reveal drops it.
 */
export function filePath(value: string): string | undefined {
  const candidate = value.trim().replace(/:\d+(?::\d+)?$/, "");
  if (!candidate || /\s/.test(candidate) || candidate.includes("://")) return undefined;
  const rooted = /^(?:~\/|\/|\.{1,2}\/|[A-Za-z]:[\\/])/.test(candidate);
  const slashed = candidate.includes("/") && /\.[A-Za-z0-9]{1,8}$/.test(candidate);
  return rooted || slashed ? candidate : undefined;
}

export function inlineSpans(text: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) spans.push({ text: text.slice(last, at) });
    last = at + match[0].length;
    const strong = match[2] ?? match[3];
    const emphasis = match[5] ?? match[6];
    const bare = match[10] ? safeHref(match[10]) : undefined;
    if (match[10]) spans.push(bare ? { text: match[10], href: bare } : { text: match[10] });
    else if (match[1]) spans.push({ text: match[1], code: true, path: filePath(match[1]) });
    else if (strong) spans.push({ text: strong, bold: true });
    else if (match[4]) spans.push({ text: match[4], strike: true });
    else if (emphasis) spans.push({ text: emphasis, italic: true });
    else {
      // A link that is not a web link is usually a file reference, which the
      // renderer opens in Finder instead of dropping on the floor.
      const href = safeHref(match[9]);
      const file = href ? undefined : filePath(match[9]);
      if (match[7] && file) spans.push({ text: match[8], path: file, image: true });
      else spans.push(href ? { text: match[8], href } : file ? { text: match[8], path: file } : { text: match[8] });
    }
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.length ? spans : [{ text }];
}

/** One table row's cells, with the pipes that fence the row dropped. */
function cells(line: string): Span[][] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => inlineSpans(cell.trim()));
}

export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  /* Wrapped lines keep their breaks — a model writes one sentence per line and
     joining them would reflow shell output and addresses into a run-on. */
  const flush = () => {
    if (paragraph.length) {
      // Markup a model forgot to fence is still markup: it reads as code, so it
      // is shown as code rather than as a paragraph of angle brackets.
      // ponytail: tags only. Widen the test when a model ships an unfenced
      // function body often enough to be worth the false positives on prose.
      const body = paragraph.join("\n");
      if (/^<[A-Za-z!/]/.test(body) && body.includes(">")) blocks.push({ kind: "code", language: "html", text: body });
      else blocks.push({ kind: "paragraph", spans: inlineSpans(body) });
    }
    if (quote.length) blocks.push({ kind: "quote", spans: inlineSpans(quote.join("\n")) });
    paragraph = [];
    quote = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (index += 1; index < lines.length && !FENCE.test(lines[index]); index += 1) body.push(lines[index]);
      blocks.push({ kind: "code", language: fence[1], text: body.join("\n") });
      continue;
    }

    if (!line.trim()) { flush(); continue; }

    if (RULE.test(line)) { flush(); blocks.push({ kind: "rule" }); continue; }

    const heading = HEADING.exec(line);
    if (heading) { flush(); blocks.push({ kind: "heading", level: heading[1].length, spans: inlineSpans(heading[2]) }); continue; }

    // A header row is only a table when the row under it is the dashed one.
    const next = lines[index + 1] ?? "";
    if (line.includes("|") && next.includes("|") && DELIMITER.test(next)) {
      flush();
      const head = cells(line);
      const rows: Row[] = [];
      for (index += 2; index < lines.length && lines[index].includes("|") && lines[index].trim(); index += 1) rows.push(cells(lines[index]));
      index -= 1;
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    const quoted = QUOTE.exec(line);
    if (quoted) {
      if (paragraph.length) flush();
      quote.push(quoted[1]);
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flush();
      const ordered = bullet[2] !== undefined;
      const spans = inlineSpans(bullet[3]);
      const previous = blocks[blocks.length - 1];
      if (previous?.kind === "list") {
        const item = previous.items[previous.items.length - 1];
        // ponytail: one level of nesting, by indent alone. Deeper indents fold
        // into that level; give each item a depth if a model ever needs three.
        if (bullet[1].length >= 2) {
          if (item.sub?.ordered === ordered) item.sub.items.push({ spans });
          else item.sub = { ordered, items: [{ spans }] };
          continue;
        }
        if (previous.ordered === ordered) { previous.items.push({ spans }); continue; }
      }
      blocks.push({ kind: "list", ordered, items: [{ spans }] });
      continue;
    }

    if (quote.length) flush();
    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}
