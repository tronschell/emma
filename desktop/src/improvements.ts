import { validateImprovements, type Improvements } from "../shared/improvement";

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
