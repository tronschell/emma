import { Buffer } from "node:buffer";

const MAX_HOST_REQUEST_BYTES = 128 * 1024;
export const MAX_ANNOTATION_INPUT_CHARS = 16 * 1024 * 1024;
// Keep the encoded image below the host's 128 KiB NDJSON request ceiling.
export const MAX_SCREEN_CONTEXT_CHARS = 96 * 1024;

export const methods = [
  "snapshot",
  "createThread",
  "createKnowledgeBase",
  "selectThreadKnowledgeBase",
  "selectThreadSources",
  "addKnowledgeBaseCategory",
  "removeKnowledgeBaseCategory",
  "updatePage",
  "sendMessage",
  "saveToKnowledge",
  "createScheduledJob",
  "setScheduledJobEnabled",
  "listOpenRouterModels",
  "selectOpenRouterModel",
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
  addKnowledgeBaseCategory: ["knowledgeBaseId", "category"],
  removeKnowledgeBaseCategory: ["knowledgeBaseId", "category"],
  updatePage: ["pageId", "title", "category", "summary", "body"],
  sendMessage: ["threadId", "content"],
  saveToKnowledge: ["threadId"],
  createScheduledJob: ["title", "schedule", "prompt", "sourceDomains"],
  setScheduledJobEnabled: ["jobId", "enabled"],
  listOpenRouterModels: [],
  selectOpenRouterModel: ["modelId"],
  selectLocalModel: ["baseUrl", "modelId", "credentialEnv"],
  selectFallbackModel: [],
};

const optionalFields: Partial<Record<Method, readonly string[]>> = {
  sendMessage: ["screenContextId"],
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
    const optionalCredential = method === "selectLocalModel" && key === "credentialEnv";
    if (text.length > (key === "screenContextId" ? 128 : 65_536) || (!["body", "content"].includes(key) && !optionalCredential && !text.trim())) throw new Error("Invalid parameters");
  }
  if (Buffer.byteLength(JSON.stringify({ id: "x".repeat(128), method, params })) > MAX_HOST_REQUEST_BYTES) {
    throw new Error("Request is too large");
  }
  return { method, params: params as Record<string, string> };
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

export function trustedSender(value: string, appRoot: string, devServer?: string): boolean {
  try {
    const url = new URL(value);
    if (devServer && url.origin === new URL(devServer).origin) return true;
    return url.protocol === "file:" && decodeURIComponent(url.pathname) === `${appRoot}/dist-renderer/index.html`;
  } catch {
    return false;
  }
}
