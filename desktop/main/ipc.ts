import { Buffer } from "node:buffer";
import { MAX_ATTACHED_CONTEXT_CHARS } from "../shared/folders";

const MAX_HOST_REQUEST_BYTES = 128 * 1024;
export const MAX_ANNOTATION_INPUT_CHARS = 16 * 1024 * 1024;
// Keep the encoded image below the host's 128 KiB NDJSON request ceiling.
export const MAX_SCREEN_CONTEXT_CHARS = 96 * 1024;
export const MAX_ARTIFACT_EDIT_CHARS = 96 * 1024;
// A clipped page carries several pictures in one request, alongside its text.
export const MAX_CAPTURE_IMAGES_CHARS = 72 * 1024;

export const methods = [
  "snapshot",
  "createThread",
  "createKnowledgeBase",
  "selectThreadKnowledgeBase",
  "selectThreadSources",
  "setThreadArchived",
  "renameThread",
  "addKnowledgeBaseCategory",
  "removeKnowledgeBaseCategory",
  "updatePage",
  "updatePageDocument",
  "captureToKnowledge",
  "analyzePage",
  "listPageVersions",
  "restorePageVersion",
  "chatAboutPage",
  "revisePageDocument",
  "readPageAsset",
  "sendMessage",
  "saveToKnowledge",
  "saveScheduledJob",
  "deleteScheduledJob",
  "runScheduledJob",
  "setScheduledJobEnabled",
  "saveResearchJob",
  "deleteResearchJob",
  "setResearchJobStatus",
  "setResearchJobThread",
  "recordResearchIteration",
  "listOpenRouterModels",
  "selectOpenRouterModel",
  "setThreadModel",
  "selectLocalModel",
  "selectFallbackModel",
] as const;

export type Method = (typeof methods)[number];
export type Request = { method: Method; params: Record<string, string> };

const fields: Record<Method, readonly string[]> = {
  snapshot: [],
  createThread: [],
  createKnowledgeBase: ["name"],
  selectThreadKnowledgeBase: ["threadId", "knowledgeBaseId"],
  selectThreadSources: ["threadId", "knowledgeBaseIds"],
  setThreadArchived: ["threadId", "archived"],
  renameThread: ["threadId", "title"],
  addKnowledgeBaseCategory: ["knowledgeBaseId", "category"],
  removeKnowledgeBaseCategory: ["knowledgeBaseId", "category"],
  updatePage: ["pageId", "title", "category", "summary", "body"],
  updatePageDocument: ["pageId", "title", "category", "summary", "body", "artifacts"],
  captureToKnowledge: ["knowledgeBaseId", "category", "title", "text"],
  analyzePage: ["pageId"],
  listPageVersions: ["pageId"],
  restorePageVersion: ["pageId", "name"],
  chatAboutPage: ["pageId", "content"],
  revisePageDocument: ["pageId", "instruction"],
  readPageAsset: ["name"],
  sendMessage: ["threadId", "content"],
  saveToKnowledge: ["threadId"],
  saveScheduledJob: ["title", "schedule", "prompt", "sourceDomains", "permissionMode"],
  deleteScheduledJob: ["jobId"],
  runScheduledJob: ["jobId"],
  setScheduledJobEnabled: ["jobId", "enabled"],
  saveResearchJob: ["title", "projectDir", "metricName", "metricKind", "direction", "evalCommand", "proposerModel", "permissionMode", "maxSeconds", "maxTokens", "maxMicroDollars"],
  deleteResearchJob: ["jobId"],
  setResearchJobStatus: ["jobId", "status"],
  setResearchJobThread: ["jobId", "threadId"],
  recordResearchIteration: ["jobId", "outcome", "durationMilliseconds", "inputTokens", "outputTokens", "microDollars"],
  listOpenRouterModels: [],
  selectOpenRouterModel: ["modelId"],
  // Quick Ask pins its own thread here when Settings → Notch decouples it from the picker.
  setThreadModel: ["threadId", "modelId"],
  selectLocalModel: ["baseUrl", "modelId", "credentialEnv"],
  selectFallbackModel: [],
};

const optionalFields: Partial<Record<Method, readonly string[]>> = {
  sendMessage: ["screenContextId", "skillAttachmentId", "attachedContext", "attachedImages"],
  selectOpenRouterModel: ["effort"],
  setThreadModel: ["effort"],
  // `pageId` re-reads a page the base already keeps instead of shelving a second copy.
  captureToKnowledge: ["sourceUrl", "sourceApplication", "image", "images", "pageId"],
  analyzePage: ["keepCategory"],
  // Absent creates rather than rewrites, and absent nodes means the task is one
  // step on its prompt. Neither may be sent blank: blank is not a value here.
  saveScheduledJob: ["jobId", "nodes"],
  runScheduledJob: ["variables"],
  // Absent creates rather than rewrites, and a grep job has no rubric. A crashed
  // iteration has no value and a turn that changed nothing has no commit, so both
  // are omitted rather than sent blank.
  saveResearchJob: ["jobId", "metricPrompt", "prompt"],
  setResearchJobStatus: ["note"],
  recordResearchIteration: ["value", "note", "commit"],
};

export function validateRequest(value: unknown): Request {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  const request = value as Record<string, unknown>;
  if (typeof request.method !== "string" || !methods.includes(request.method as Method)) {
    throw new Error("Method is not allowed");
  }
  if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
    throw new Error("Invalid parameters");
  }
  const method = request.method as Method;
  const params = request.params as Record<string, unknown>;
  const expected = fields[method];
  const optional = optionalFields[method] ?? [];
  const keys = Object.keys(params);
  if (keys.length < expected.length || keys.length > expected.length + optional.length || expected.some((key) => typeof params[key] !== "string") || keys.some((key) => !expected.includes(key) && !optional.includes(key) || typeof params[key] !== "string")) {
    throw new Error("Invalid parameters");
  }
  for (const key of [...expected, ...optional.filter((key) => key in params)]) {
    const text = params[key] as string;
    // Blank is a value, not an omission: no credential, no effort override, and — on a
    // thread pin — the app's own model instead of one of the thread's.
    const optionalCredential = (method === "selectLocalModel" && key === "credentialEnv") || key === "effort" || (method === "setThreadModel" && key === "modelId");
    const maxLength = ["screenContextId", "skillAttachmentId"].includes(key) ? 256 : key === "artifacts" ? MAX_ARTIFACT_EDIT_CHARS : key === "image" ? MAX_SCREEN_CONTEXT_CHARS : key === "images" ? MAX_CAPTURE_IMAGES_CHARS : key === "attachedContext" ? MAX_ATTACHED_CONTEXT_CHARS : 65_536;
    if (text.length > maxLength || (!["body", "content"].includes(key) && !optionalCredential && !text.trim())) throw new Error("Invalid parameters");
  }
  if (Buffer.byteLength(JSON.stringify({ id: "x".repeat(128), method, params })) > MAX_HOST_REQUEST_BYTES) {
    throw new Error("Request is too large");
  }
  return { method, params: params as Record<string, string> };
}

/* A command the user pressed play on, next to a fence Emma printed. The click is
   the permission — the same rule Stop follows — so this only bounds what crosses
   the bridge: one command, bounded in length, and at most one connected folder
   to run it in. */
export function runCommandRequest(value: unknown): { command: string; folderId?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Command is invalid");
  const candidate = value as { command?: unknown; folderId?: unknown };
  const command = typeof candidate.command === "string" ? candidate.command.trim() : "";
  if (!command || command.length > 4096) throw new Error("Command is invalid");
  const folderId = candidate.folderId;
  if (folderId === undefined) return { command };
  if (typeof folderId !== "string" || !folderId || folderId.length > 256) throw new Error("Command folder is invalid");
  return { command, folderId };
}

export function validJpegDataUrl(value: unknown, maxChars = MAX_ANNOTATION_INPUT_CHARS): value is string {
  if (typeof value !== "string" || value.length > maxChars || !value.startsWith("data:image/jpeg;base64,")) return false;
  const encoded = value.slice("data:image/jpeg;base64,".length);
  return encoded.length > 0 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded);
}

export function externalUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The addresses a page on the public web never has: loopback, the link-local
 * metadata range, and the private LAN blocks. A person pasting a link may well
 * mean `localhost:3000`, so `externalUrl` still allows it — this is the stricter
 * check for URLs the *model* chose, where "fetch this page" must not reach the
 * user's own router, Ollama, or dev server.
 */
export function publicUrl(value: string): URL | null {
  const url = externalUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host.replace(/^::ffff:/, ""));
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 0 || a === 10 || a === 127 || a === 255) return null;
    if (a === 169 && b === 254) return null;
    if (a === 172 && b >= 16 && b <= 31) return null;
    if (a === 192 && b === 168) return null;
    if (a === 100 && b >= 64 && b <= 127) return null;
    if (a > 255 || b > 255) return null;
  } else if (host.includes(":")) {
    // IPv6 literal: loopback, unique-local (fc00::/7) and link-local (fe80::/10).
    if (host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return null;
  }
  return url;
}

export const MAX_FETCHED_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_FETCHED_TEXT_CHARS = 50 * 1024;

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith("#")) {
      const point = Number.parseInt(code.slice(1).replace(/^x/i, ""), code[1] === "x" || code[1] === "X" ? 16 : 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return entities[code.toLowerCase()] ?? match;
  });
}

/** One attribute off one tag, in whichever of the three HTML quotings the page used. */
export function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? match[1] ?? match[2] ?? match[3] : undefined;
}

/** `og:image` must not answer with `og:image:width`, so the name has to end where it ends. */
export function metaContent(html: string, name: string): string {
  const tag = new RegExp(`<meta\\b[^>]*\\b(?:property|name)\\s*=\\s*["']?${name}(?=["'\\s>])[^>]*>`, "i").exec(html)?.[0];
  return (tag && attribute(tag, "content")) || "";
}

/**
 * The page's own content, not the site's furniture. A mega-menu is markup like any
 * other, so stripping tags alone files forty lines of link text — "Solutions BY
 * COMPANY SIZE Enterprises" — as the thing the user wanted to remember.
 *
 * ponytail: `<main>` plus a boilerplate blacklist, not a readability score. Nested
 * same-name elements end their match early; what survives is still tag-stripped.
 * Swap in a real extractor if the wrong half keeps coming through.
 */
function articleHtml(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const article = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(body)?.[1]
    ?? [...body.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((match) => match[1]).sort((left, right) => right.length - left.length)[0];
  // An article carries its own header and footer — the headline and the byline live
  // there. Only the whole-page fallback is boilerplate all the way down.
  return article && article.length > 500
    ? article.replace(/<(nav|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    : body.replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
}

export function readablePage(html: string): { title: string; text: string } {
  const title = metaContent(html, "og:title") || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "";
  const text = articleHtml(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|table|blockquote|pre)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // A tag ends at the first `>` outside its attribute values. Hydration markup
    // parks a whole JSON blob in `data-props="…"`, and `>` is legal unescaped in
    // there — stopping at it spills the blob into the page text.
    .replace(/<[a-z!/][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/gi, " ")
    .split("\n")
    .map((line) => decodeEntities(line).replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // A page whose body is written by script — a video, a feed — leaves nothing to
  // strip. Its own description is what it would have shown, so that is what a
  // YouTube link saves instead of an empty page.
  const description = decodeEntities(metaContent(html, "og:description") || metaContent(html, "description")).trim();
  const body = text.length >= 400 || !description ? text : `${description}\n\n${text}`.trim();
  return { title: decodeEntities(title).replace(/\s+/g, " ").trim().slice(0, 256), text: body.slice(0, MAX_FETCHED_TEXT_CHARS) };
}

export function trustedSender(value: string, appRoot: string, devServer?: string): boolean {
  try {
    const url = new URL(value);
    if (devServer && url.origin === new URL(devServer).origin) return true;
    return url.protocol === "file:" && decodeURIComponent(url.pathname) === `${appRoot}/dist-renderer/index.html`;
  } catch {
    return false;
  }
}
