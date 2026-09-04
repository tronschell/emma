import { Buffer } from "node:buffer";
import { BlockList, isIP } from "node:net";
import { MAX_ATTACHED_CONTEXT_CHARS } from "../shared/folders";
import { clampBytes, isKeepKind, validVaultFolder, MAX_ATTACHMENT_BYTES, MAX_NOTE_BYTES, MAX_TITLE_BYTES, type KeepRequest, type VaultKind } from "../shared/vault";
import { MAX_JUDGE_ANSWER_CHARS, MAX_JUDGE_PROMPT_CHARS, MAX_JUDGE_RUBRIC_CHARS } from "./bench-judge";
import { validateJudge, type VerifierSettings } from "../shared/settings";

const MAX_HOST_REQUEST_BYTES = 128 * 1024;
export const MAX_ANNOTATION_INPUT_CHARS = 16 * 1024 * 1024;
export const MAX_SCREEN_CONTEXT_CHARS = 96 * 1024;

export const methods = [
  "snapshot",
  "threadSummaries",
  "thread",
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
  "selectCodexModel",
  "selectFallbackModel",
  "setRouters",
] as const;

export type Method = (typeof methods)[number];
export type Request = { method: Method; params: Record<string, string> };

const fields: Record<Method, readonly string[]> = {
  snapshot: [],
  threadSummaries: [],
  thread: ["threadId"],
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
  selectCodexModel: ["modelId"],
  selectFallbackModel: [],
  setRouters: ["routers"],
};

const optionalFields: Partial<Record<Method, readonly string[]>> = {
  sendMessage: ["screenContextId", "skillAttachmentId", "attachedContext", "attachedImages", "skillContext"],
  listOpenRouterModels: ["force"],
  selectOpenRouterModel: ["effort"],
  selectProviderModel: ["effort"],
  selectCodexModel: ["effort"],
  setThreadModel: ["effort"],
  saveScheduledJob: ["jobId", "nodes", "model"],
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
    const optionalCredential = key === "effort" || (method === "setThreadModel" && key === "modelId") || (method === "saveScheduledJob" && key === "model");
    const maxLength = ["screenContextId", "skillAttachmentId"].includes(key) ? 256 : key === "attachedContext" ? MAX_ATTACHED_CONTEXT_CHARS : 65_536;
    if (key === "content" && text.length > maxLength) {
      throw new Error(`This message is ${text.length.toLocaleString("en-US")} characters; Emma sends at most ${maxLength.toLocaleString("en-US")}. Trim it, or attach the text as a file.`);
    }
    if (text.length > maxLength || (key !== "content" && !optionalCredential && !text.trim())) throw new Error("Invalid parameters");
  }
  if (Buffer.byteLength(JSON.stringify({ id: "x".repeat(128), method, params })) > MAX_HOST_REQUEST_BYTES) {
    throw new Error("Request is too large: send less attached context or a shorter message");
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
  const title = bounded(candidate.title, MAX_NOTE_BYTES, "Keep title is invalid");
  const text = bounded(candidate.text, MAX_NOTE_BYTES, "Keep text is invalid");
  const sourceApplication = bounded(candidate.sourceApplication, 256, "Keep source is invalid");
  if (title) request.title = clampBytes(title, MAX_TITLE_BYTES);
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

const nonPublicAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) nonPublicAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  nonPublicAddresses.addSubnet(address, prefix, "ipv6");
}
const globalIpv6Addresses = new BlockList();
globalIpv6Addresses.addSubnet("2000::", 3, "ipv6");

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !nonPublicAddresses.check(address, "ipv4")
    : family === 6 && globalIpv6Addresses.check(address, "ipv6") && !nonPublicAddresses.check(address, "ipv6");
}

export function publicUrl(value: string): URL | null {
  const url = externalUrl(value);
  if (!url || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (isIP(host) && !publicAddress(host)) return null;
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

export const MAX_BENCH_SHEETS = 8;
export const MAX_BENCH_ROWS = 4096;
export const MAX_BENCH_COLUMNS = 32;
export const MAX_BENCH_CELL_CHARS = 8192;
export const MAX_BENCH_EXPORT_BYTES = 32 * 1024 * 1024;

export function benchJudgeRequest(value: unknown): { prompt: string; rubric: string; answer: string; judge?: VerifierSettings } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Judge request is invalid");
  const candidate = value as { prompt?: unknown; rubric?: unknown; answer?: unknown; judge?: unknown };
  const read = (field: unknown, max: number) => {
    if (field !== undefined && typeof field !== "string") throw new Error("Judge request is invalid");
    return (typeof field === "string" ? field : "").slice(0, max);
  };
  const prompt = read(candidate.prompt, MAX_JUDGE_PROMPT_CHARS).trim();
  if (!prompt) throw new Error("Judge request has no prompt");
  const judge = candidate.judge === undefined || candidate.judge === null ? undefined : validateJudge(candidate.judge);
  return { prompt, rubric: read(candidate.rubric, MAX_JUDGE_RUBRIC_CHARS).trim(), answer: read(candidate.answer, MAX_JUDGE_ANSWER_CHARS), ...(judge?.model ? { judge } : {}) };
}

export function benchExportRequest(value: unknown): { name: string; sheets: { name: string; rows: (string | number)[][] }[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Bench export is invalid");
  const candidate = value as { name?: unknown; sheets?: unknown };
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(name)) throw new Error("Bench export name is invalid");
  if (!Array.isArray(candidate.sheets) || !candidate.sheets.length || candidate.sheets.length > MAX_BENCH_SHEETS) throw new Error("Bench export is invalid");
  let bytes = 0;
  const sheets = candidate.sheets.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Bench sheet is invalid");
    const sheet = entry as { name?: unknown; rows?: unknown };
    if (typeof sheet.name !== "string" || !/^[A-Za-z0-9 _-]{1,31}$/.test(sheet.name)) throw new Error("Bench sheet name is invalid");
    if (!Array.isArray(sheet.rows) || sheet.rows.length > MAX_BENCH_ROWS) throw new Error("Bench sheet is invalid");
    const rows = sheet.rows.map((line) => {
      if (!Array.isArray(line) || line.length > MAX_BENCH_COLUMNS) throw new Error("Bench sheet row is invalid");
      return line.map((cell) => {
        if (typeof cell === "number") {
          if (!Number.isFinite(cell)) throw new Error("Bench sheet cell is invalid");
          bytes += 8;
          return cell;
        }
        if (typeof cell !== "string") throw new Error("Bench sheet cell is invalid");
        const cut = cell.slice(0, MAX_BENCH_CELL_CHARS);
        bytes += Buffer.byteLength(cut, "utf8");
        if (bytes > MAX_BENCH_EXPORT_BYTES) throw new Error("Bench export is too large");
        return cut;
      });
    });
    return { name: sheet.name, rows };
  });
  return { name, sheets };
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
