/**
 * Authoring and editing knowledge pages.
 *
 * The Zig sidecar used to do this: one non-streaming provider call that returns a whole
 * JSON page, plus a deterministic local scaffold for when no model is configured. It is
 * here now because the sidecar is going and the harness has no verb for it — ACP prompts a
 * session, it does not author a document. Emma's durable store still validates and files
 * whatever comes back, so this side is best-effort by design: a malformed block loses its
 * block, not the page.
 */

/** A page block as the model returns it and the store takes it. */
export interface PageBlock {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  fallback: string;
}

export interface AuthoredPage {
  category: string;
  title: string;
  summary: string;
  interesting_points: string[];
  counterarguments: string[];
  blocks: PageBlock[];
  model: string;
  input_tokens: number;
  output_tokens: number;
}

/** Where a page is authored: the thread's own route, or nothing for the local scaffold. */
export interface AuthorRoute {
  endpoint: string;
  model: string;
  key: string;
}

const MAX_BLOCKS = 64;
const MAX_POINTS = 12;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_CATEGORY_BYTES = 64;

const BLOCK_TYPES_HELP = `Each block needs a unique kebab-case id and a "fallback" holding the same content as plain Markdown. Use exactly these types and payload keys:
- "rich-text": {"markdown": string} — a written section. Headings (##), bold, links and lists render; keep to that subset.
- "stats": {"items": [{"label": string, "value": string, "detail": string}]} — at most 4 figures lifted from the material, never invented.
- "list": {"items": [string], "ordered": boolean}
- "table": {"headers": [string], "rows": [[string]]}
- "chart": {"kind": "bar" | "line" | "area", "labels": [string], "values": [number], "caption": string} — at most 8 points, and only when the material carries real numbers. Bars compare things, lines and areas show a series over time. Never invent data.
- "citations": {"items": [{"title": string, "url": string}]}`;

const DOCUMENT_SHAPE_HELP = `Decide the best way to present this particular material, then author as many blocks as it deserves, in reading order:
1. A "rich-text" block with the id "summary": two or three sentences on what this is and why it is worth keeping. Always first.
2. A "stats" block when the material pins down figures, and a "chart" whenever it carries numbers that can be compared or tracked.
3. The supporting detail, in sections: "rich-text" blocks that each open with a "## heading", plus "list" and "table" blocks wherever they read better than prose.
4. A "citations" block when the material names sources it draws on.
5. A closing block with the id "how-to-apply": what the reader should do with this.`;

/** The first sentence, which is the best title available without asking a model. */
export function titleFrom(text: string): string {
  const trimmed = text.trim();
  const stop = trimmed.search(/[.\n]/);
  const title = trimmed.slice(0, Math.min(stop === -1 ? trimmed.length : stop, 120)).trim();
  return title || "Untitled page";
}

// ponytail: keyword fallback is context-blind; the provider path does the real thing.
function classify(text: string): string {
  const has = (...words: string[]) => words.some((word) => text.toLowerCase().includes(word));
  if (has("arxiv", "paper", "research", "study")) return "research";
  if (has("bug", "code", "software")) return "technology";
  if (has("money", "market", "finance")) return "finance";
  if (has("health", "medical")) return "health";
  return "general";
}

/**
 * The base's own taxonomy wins over the built-in keyword rules: a base the user curated
 * should not gain a category it has never used just because no provider was configured.
 */
export function chooseCategory(categories: string[], text: string): string {
  if (!categories.length) return classify(text);
  const guess = classify(text);
  const named = categories.find((category) => category.toLowerCase() === guess);
  if (named) return named;
  const mentioned = categories.find((category) => text.toLowerCase().includes(category.toLowerCase()));
  return mentioned ?? categories[0];
}

/**
 * Model output is best effort: a missing, wrong-typed or oversized field falls back to
 * `fallback` rather than costing the user the whole page.
 */
function modelString(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length && trimmed.length <= max ? trimmed : fallback;
}

const stringArray = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value.map((item) => modelString(item, "", 2048)).filter(Boolean).slice(0, max)
    : [];

/** Keeps every block that validates and drops the rest, so one bad block is not a lost page. */
export function readBlocks(value: unknown): PageBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: PageBlock[] = [];
  for (const block of value) {
    if (blocks.length === MAX_BLOCKS) break;
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const candidate = block as Record<string, unknown>;
    const id = modelString(candidate.id, "", 96);
    const type = modelString(candidate.type, "", 64);
    const fallback = modelString(candidate.fallback, "", MAX_TEXT_BYTES);
    const payload = candidate.payload;
    if (!id || !type || !fallback) continue;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    blocks.push({ id, type, payload: payload as Record<string, unknown>, fallback });
  }
  return blocks;
}

/**
 * Models wrap JSON in prose or a code fence often enough that trusting the whole body is
 * not worth it; take the outermost braces and let the parser reject the rest.
 */
function jsonSpan(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start !== -1 && end > start ? text.slice(start, end + 1) : undefined;
}

interface JsonReply { document: Record<string, unknown>; inputTokens: number; outputTokens: number }

/** One shot at the provider with no thread history, expecting a bare JSON object back. */
async function askForJson(route: AuthorRoute, prompt: string, timeoutMs: number): Promise<JsonReply> {
  const response = await fetch(route.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...(route.key ? { authorization: `Bearer ${route.key}` } : {}) },
    body: JSON.stringify({ model: route.model, messages: [{ role: "user", content: prompt }], stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`The authoring endpoint answered ${response.status}.`);
  const body = await response.json() as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const content = body.choices?.[0]?.message?.content;
  const span = typeof content === "string" ? jsonSpan(content) : undefined;
  if (!span) throw new Error("The model did not return a JSON page.");
  let document: unknown;
  try { document = JSON.parse(span); } catch { throw new Error("The model did not return a JSON page."); }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("The model did not return a JSON page.");
  const count = (value: unknown, text: string) => typeof value === "number" && value >= 0 ? value : Math.ceil(text.length / 4);
  return {
    document: document as Record<string, unknown>,
    inputTokens: count(body.usage?.prompt_tokens, prompt),
    outputTokens: count(body.usage?.completion_tokens, typeof content === "string" ? content : ""),
  };
}

/** The fixed scaffold for a page authored with no provider configured. */
function localPage(text: string, categories: string[]): AuthoredPage {
  return {
    category: chooseCategory(categories, text),
    title: titleFrom(text),
    summary: "Deterministic local analysis generated without provider credentials.",
    interesting_points: [
      "The input was classified using explicit local keyword rules.",
      "No network or model call was required.",
    ],
    counterarguments: ["Keyword classification can miss context and nuance."],
    blocks: [],
    model: "local-fallback",
    input_tokens: Math.ceil(text.length / 4),
    output_tokens: Math.ceil((titleFrom(text).length + 95) / 4),
  };
}

/**
 * Asks the model to author the whole page — prose, tables, charts — instead of filling a
 * fixed scaffold. Without a route it returns the deterministic local scaffold instead.
 */
export async function authorPage(
  text: string,
  categories: string[],
  route?: AuthorRoute,
  timeoutMs = 120_000,
): Promise<AuthoredPage> {
  if (!route?.model) return localPage(text, categories);
  let prompt = `You are building one page for the user's personal knowledge base. Reply with a single JSON object and nothing else — no prose around it, no code fence.

{"title": string, "category": string, "summary": string, "interesting_points": [string], "counterarguments": [string], "blocks": [{"id": string, "type": string, "payload": object, "fallback": string}]}

"blocks" is the page itself. Pictures from the source are added around your blocks, so never describe images.

${DOCUMENT_SHAPE_HELP}

${BLOCK_TYPES_HELP}
`;
  if (categories.length) {
    prompt += `\nFile this under one of the categories the user already keeps: ${categories.map((category) => JSON.stringify(category)).join(", ")}. Propose a new category only when none of them fit.\n`;
  }
  prompt += `\nMaterial to turn into the page:\n${text}\n`;
  const { document, inputTokens, outputTokens } = await askForJson(route, prompt, timeoutMs);
  return {
    category: modelString(document.category, chooseCategory(categories, text), MAX_CATEGORY_BYTES),
    title: modelString(document.title, titleFrom(text), 256),
    summary: modelString(document.summary, "The model returned no summary for this page.", 4 * 1024),
    interesting_points: stringArray(document.interesting_points, MAX_POINTS),
    counterarguments: stringArray(document.counterarguments, MAX_POINTS),
    blocks: readBlocks(document.blocks),
    model: route.model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

/**
 * Rewrites an existing page from a chat instruction. The whole page comes back so the
 * caller can show one diff and apply it in one durable write. There is no local rewriter,
 * so this needs a route.
 */
export async function revisePage(
  instruction: string,
  document: PageBlock[],
  route: AuthorRoute,
  timeoutMs = 120_000,
): Promise<PageBlock[]> {
  if (!route?.model) throw new Error("Editing a page needs a model. Pick one in Settings.");
  const prompt = `You are editing one page in the user's knowledge base. Reply with a single JSON object and nothing else — no prose around it, no code fence.

{"blocks": [{"id": string, "type": string, "payload": object, "fallback": string}]}

Return the complete page after the edit, not only the blocks you changed, and keep the id of every block you leave alone.

${BLOCK_TYPES_HELP}

Current page:
${JSON.stringify(document)}

Requested change:
${instruction}
`;
  const reply = await askForJson(route, prompt, timeoutMs);
  return readBlocks(reply.document.blocks);
}
