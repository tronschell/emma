export type StreamMessage = { kind: "frame"; data: string; seq?: number } | { kind: "page"; url: string };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_MESSAGE_CHARS = 8_000_000;

function page(value: unknown): StreamMessage | null {
  return typeof value === "string" && /^https?:\/\//i.test(value) ? { kind: "page", url: value } : null;
}

export function parseStreamMessage(payload: unknown): StreamMessage | null {
  if (typeof payload !== "string" || payload.length > MAX_MESSAGE_CHARS) return null;
  let message: unknown;
  try {
    message = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const sent = message as { type?: unknown; seq?: unknown; data?: unknown; tabs?: unknown; url?: unknown };
  if (sent.type === "frame" && typeof sent.data === "string" && BASE64.test(sent.data)) {
    return { kind: "frame", data: sent.data, ...(typeof sent.seq === "number" ? { seq: sent.seq } : {}) };
  }
  if (sent.type === "url") return page(sent.url);
  if (sent.type !== "tabs" || !Array.isArray(sent.tabs)) return null;
  const active = sent.tabs.find((tab): tab is { active?: unknown; url?: unknown } => typeof tab === "object" && tab !== null && (tab as { active?: unknown }).active === true);
  return page(active?.url);
}
