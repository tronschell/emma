import { Buffer } from "node:buffer";
import { MAX_ATTACHED_CONTEXT_CHARS } from "../shared/folders";
import { isKeepKind, validVaultFolder, MAX_ATTACHMENT_BYTES, MAX_NOTE_BYTES, MAX_TITLE_BYTES, type KeepRequest, type VaultKind } from "../shared/vault";

const MAX_HOST_REQUEST_BYTES = 128 * 1024;
export const MAX_ANNOTATION_INPUT_CHARS = 16 * 1024 * 1024;
export const MAX_SCREEN_CONTEXT_CHARS = 96 * 1024;

export const methods = [
  "snapshot",
  "createThread",
  "setThreadArchived",
  "renameThread",
  "sendMessage",
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
  "selectProviderModel",
  "selectFallbackModel",
  "setRouters",
] as const;

export type Method = (typeof methods)[number];
export type Request = { method: Method; params: Record<string, string> };

const fields: Record<Method, readonly string[]> = {
  snapshot: [],
  createThread: [],
  setThreadArchived: ["threadId", "archived"],
  renameThread: ["threadId", "title"],
  sendMessage: ["threadId", "content"],
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
  setThreadModel: ["threadId", "modelId"],
  selectProviderModel: ["providerId"],
  selectFallbackModel: [],
  setRouters: ["routers"],
};

const optionalFields: Partial<Record<Method, readonly string[]>> = {
  sendMessage: ["screenContextId", "skillAttachmentId", "attachedContext", "attachedImages"],
  listOpenRouterModels: ["force"],
  selectOpenRouterModel: ["effort"],
  selectProviderModel: ["effort"],
  setThreadModel: ["effort"],
  saveScheduledJob: ["jobId", "nodes"],
  runScheduledJob: ["variables"],
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
    const optionalCredential = key === "effort" || (method === "setThreadModel" && key === "modelId");
    const maxLength = ["screenContextId", "skillAttachmentId"].includes(key) ? 256 : key === "attachedContext" ? MAX_ATTACHED_CONTEXT_CHARS : 65_536;
    if (text.length > maxLength || (key !== "content" && !optionalCredential && !text.trim())) throw new Error("Invalid parameters");
  }
  if (Buffer.byteLength(JSON.stringify({ id: "x".repeat(128), method, params })) > MAX_HOST_REQUEST_BYTES) {
    throw new Error("Request is too large");
  }
  return { method, params: params as Record<string, string> };
}

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

function bounded(value: unknown, bytes: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > bytes) throw new Error(label);
  return value.trim() ? value : undefined;
}

export function vaultRequest(value: unknown): { kind: VaultKind; name: string; folder?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Vault choice is invalid");
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "obsidian" && candidate.kind !== "folder") throw new Error("Vault choice is invalid");
  const name = candidate.name === undefined ? "" : bounded(candidate.name, 256, "Vault choice is invalid") ?? "";
  if (candidate.kind === "obsidian" && !name) throw new Error("Vault choice is invalid");
  if (candidate.folder !== undefined && !validVaultFolder(candidate.folder)) throw new Error("Vault folder is invalid");
  return { kind: candidate.kind, name, ...(candidate.folder === undefined ? {} : { folder: candidate.folder as string }) };
}

export function keepRequest(value: unknown): KeepRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Keep request is invalid");
  const candidate = value as Record<string, unknown>;
  if (!isKeepKind(candidate.kind)) throw new Error("Keep request is invalid");
  const sourceUrl = bounded(candidate.sourceUrl, 2048, "Keep source is invalid");
  if (sourceUrl && !externalUrl(sourceUrl)) throw new Error("Keep source is invalid");
  if (candidate.image !== undefined && !validImageDataUrl(candidate.image, MAX_ATTACHMENT_BYTES)) throw new Error("Keep image is invalid");
  const request: KeepRequest = { kind: candidate.kind };
  const title = bounded(candidate.title, MAX_TITLE_BYTES, "Keep title is invalid");
  const text = bounded(candidate.text, MAX_NOTE_BYTES, "Keep text is invalid");
  const sourceApplication = bounded(candidate.sourceApplication, 256, "Keep source is invalid");
  if (title) request.title = title;
  if (text) request.text = text;
  if (sourceUrl) request.sourceUrl = sourceUrl;
  if (sourceApplication) request.sourceApplication = sourceApplication;
  if (candidate.image !== undefined) request.image = candidate.image as string;
  if (request.kind !== "page" && !request.text && !request.image) throw new Error("Keep request is empty");
  return request;
}

function dataUrl(value: unknown, maxChars: number, types: RegExp): boolean {
  if (typeof value !== "string" || value.length > maxChars) return false;
  const prefix = types.exec(value);
  if (!prefix) return false;
  const encoded = value.slice(prefix[0].length);
  return encoded.length > 0 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded);
}

export function validJpegDataUrl(value: unknown, maxChars = MAX_ANNOTATION_INPUT_CHARS): value is string {
  return dataUrl(value, maxChars, /^data:image\/jpeg;base64,/);
}

export function validImageDataUrl(value: unknown, maxChars: number): value is string {
  return dataUrl(value, maxChars, /^data:image\/(?:jpeg|png);base64,/);
}

export function externalUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

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

export function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? match[1] ?? match[2] ?? match[3] : undefined;
}

export function metaContent(html: string, name: string): string {
  const tag = new RegExp(`<meta\\b[^>]*\\b(?:property|name)\\s*=\\s*["']?${name}(?=["'\\s>])[^>]*>`, "i").exec(html)?.[0];
  return (tag && attribute(tag, "content")) || "";
}

function articleHtml(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const article = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(body)?.[1]
    ?? [...body.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((match) => match[1]).sort((left, right) => right.length - left.length)[0];
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
    .replace(/<[a-z!/][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/gi, " ")
    .split("\n")
    .map((line) => decodeEntities(line).replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const description = decodeEntities(metaContent(html, "og:description") || metaContent(html, "description")).trim();
  const body = text.length >= 400 || !description ? text : `${description}\n\n${text}`.trim();
  return { title: decodeEntities(title).replace(/\s+/g, " ").trim().slice(0, 256), text: body.slice(0, MAX_FETCHED_TEXT_CHARS) };
}

export const MAX_STATS_SHEETS = 24;
export const MAX_STATS_BYTES = 64 * 1024 * 1024;

export function statsExportRequest(value: unknown): { folder: string; files: { name: string; text: string }[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stats export is invalid");
  const candidate = value as { folder?: unknown; files?: unknown };
  const folder = typeof candidate.folder === "string" ? candidate.folder.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(folder)) throw new Error("Stats folder name is invalid");
  if (!Array.isArray(candidate.files) || !candidate.files.length || candidate.files.length > MAX_STATS_SHEETS) throw new Error("Stats export is invalid");
  const names = new Set<string>();
  let bytes = 0;
  const files = candidate.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Stats sheet is invalid");
    const sheet = entry as { name?: unknown; text?: unknown };
    if (typeof sheet.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}\.csv$/.test(sheet.name)) throw new Error("Stats sheet name is invalid");
    if (names.has(sheet.name)) throw new Error("Stats sheet name is repeated");
    names.add(sheet.name);
    if (typeof sheet.text !== "string") throw new Error("Stats sheet is invalid");
    bytes += Buffer.byteLength(sheet.text, "utf8");
    if (bytes > MAX_STATS_BYTES) throw new Error("Stats export is too large");
    return { name: sheet.name, text: sheet.text };
  });
  return { folder, files };
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
