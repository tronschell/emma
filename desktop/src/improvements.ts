import { validateImprovements, MAX_ADDITION_CHARS, type Draft, type Improvements } from "../shared/improvement";

const KEY = "emma.improvements.v1";

export function readImprovements(): Improvements {
  try { return validateImprovements(JSON.parse(localStorage.getItem(KEY) ?? "null")); }
  catch { return { items: [] }; }
}

export function saveImprovements(next: Improvements): Improvements {
  const valid = validateImprovements(next);
  localStorage.setItem(KEY, JSON.stringify(valid));
  syncImprovements(valid);
  return valid;
}

export function syncImprovements(store: Improvements = readImprovements()) {
  void window.emma.setImprovements(store).catch(() => undefined);
}

const QUEUE_KEY = "emma.repair-queue.v1";
const MAX_QUEUE = 8;

export function readQueue(): Draft[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "null");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry): Draft[] => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const addition = (typeof item.addition === "string" ? item.addition : "").slice(0, MAX_ADDITION_CHARS).trim();
      if (!addition) return [];
      return [{
        title: (typeof item.title === "string" ? item.title : "").slice(0, 200) || "Untitled change",
        lever: item.lever === "verifier" ? "verifier" : "instructions",
        metric: item.metric === "blocks" ? "blocks" : item.metric === "steps" ? "steps" : "failures",
        addition,
        look: Math.max(1, Math.round(Number(item.look)) || 1),
      }];
    }).slice(0, MAX_QUEUE);
  } catch { return []; }
}

export function saveQueue(next: readonly Draft[]): Draft[] {
  const valid = next.slice(0, MAX_QUEUE);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(valid));
  return valid;
}
