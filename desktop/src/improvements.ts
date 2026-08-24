/* Where the Agent page's record lives: on this Mac, beside the settings, in the
   renderer that owns it.

   Main is told the same record on every save and at launch, because it is main
   that puts a kept lesson in front of the model and flips the coin for the one
   on trial. Nothing here goes anywhere else. */

import { validateImprovements, type Improvements } from "../shared/improvement";

const KEY = "emma.improvements.v1";

export function readImprovements(): Improvements {
  try { return validateImprovements(JSON.parse(localStorage.getItem(KEY) ?? "null")); }
  catch { return { items: [] }; }
}

/** Saved, then pushed: a lesson that is not in main is a lesson that changes nothing. */
export function saveImprovements(next: Improvements): Improvements {
  const valid = validateImprovements(next);
  localStorage.setItem(KEY, JSON.stringify(valid));
  syncImprovements(valid);
  return valid;
}

/** Also called at launch: main starts with none of these until something says otherwise. */
export function syncImprovements(store: Improvements = readImprovements()) {
  void window.emma.setImprovements(store).catch(() => undefined);
}
