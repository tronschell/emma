/* What a turn actually carried, kept as a ledger so the thread inspector can
   draw it. Pure helpers: the renderer owns the storage and the pixels. */

export type UsageKind = "messages" | "system" | "tools" | "mcp" | "skills" | "memory";

export interface ContextUse {
  kind: UsageKind;
  label: string;
  /** Characters this segment put in the request the last time it rode a turn. */
  chars: number;
  /** How many turns it has ridden. */
  turns: number;
}

/** A thread's ledger is bounded; the least recently used entries fall off. */
export const MAX_USES = 32;

/* ponytail: ~4 characters a token. Everything on this side is counted in
   characters, so a provider's token count is scaled rather than the other way
   round. Swap in a tokenizer if the estimate ever misleads. */
export const CHARS_PER_TOKEN = 4;

/**
 * The mass of a turn that the renderer never wrote and cannot measure: the
 * system prompt, the tool schemas, skills injected by the harness, knowledge the
 * host retrieved, an attached screen capture.
 *
 * It is a residual, not an estimate — the provider's own input count for the
 * turn, minus the segments this side did measure. Zero when no usage was
 * reported, or when the measured segments already account for the whole input.
 */
export function systemChars(inputTokens: number, measuredChars: number): number {
  return Math.max(0, inputTokens * CHARS_PER_TOKEN - measuredChars);
}

export function usageKey(use: { kind: UsageKind; label: string }): string {
  return `${use.kind}:${use.label}`;
}

/** Fold this turn's segments into the ledger, most recent first. */
export function mergeUses(current: ContextUse[], added: Omit<ContextUse, "turns">[]): ContextUse[] {
  const kept = new Map(current.map((use) => [usageKey(use), use]));
  const touched = added.map((use) => {
    const previous = kept.get(usageKey(use));
    kept.delete(usageKey(use));
    return { ...use, turns: (previous?.turns ?? 0) + 1 };
  });
  return [...touched, ...kept.values()].slice(0, MAX_USES);
}

/** Lay the segments out over a fixed cell count, largest first, every segment
    worth at least one cell. Largest-remainder, so the grid is always full. */
export function allocateCells(items: { key: string; chars: number }[], cells: number): string[] {
  const ranked = items.filter((item) => item.chars > 0).sort((left, right) => right.chars - left.chars).slice(0, cells);
  const total = ranked.reduce((sum, item) => sum + item.chars, 0);
  if (!total) return [];
  const shares = ranked.map((item) => {
    const exact = item.chars / total * cells;
    return { key: item.key, count: Math.max(1, Math.floor(exact)), remainder: exact - Math.floor(exact) };
  });
  let spare = cells - shares.reduce((sum, share) => sum + share.count, 0);
  for (const share of [...shares].sort((left, right) => right.remainder - left.remainder)) {
    if (spare <= 0) break;
    share.count += 1;
    spare -= 1;
  }
  // The min-one floor can overshoot when one segment dwarfs the rest; take the
  // cells back off the biggest blocks, never off a segment's last cell.
  while (spare < 0) {
    const biggest = shares.reduce((left, right) => (right.count > left.count ? right : left));
    if (biggest.count <= 1) break;
    biggest.count -= 1;
    spare += 1;
  }
  return shares.flatMap((share) => Array.from({ length: share.count }, () => share.key));
}

/* Where the speed curve starts. Every bucket after it is a doubling — 4K, 8K,
   16K … — so a model that slows as the request grows shows it as a slope. */
const RATE_FLOOR = 4096;

/**
 * Output tokens a second against how full the request was, pooled per doubling
 * of context. Turns below the floor land in the first bucket; a turn with no
 * measured time is not a rate and is dropped.
 */
export function rateByContext(turns: { inputTokens: number; outputTokens: number; durationMilliseconds: number }[]): { context: number; rate: number; turns: number }[] {
  const buckets = new Map<number, { tokens: number; ms: number; turns: number }>();
  for (const turn of turns) {
    if (turn.durationMilliseconds <= 0) continue;
    const context = RATE_FLOOR * 2 ** Math.floor(Math.log2(Math.max(turn.inputTokens, RATE_FLOOR) / RATE_FLOOR));
    const at = buckets.get(context) ?? { tokens: 0, ms: 0, turns: 0 };
    buckets.set(context, { tokens: at.tokens + turn.outputTokens, ms: at.ms + turn.durationMilliseconds, turns: at.turns + 1 });
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([context, at]) => ({ context, rate: at.tokens / at.ms * 1000, turns: at.turns }));
}

/** "4.2k" — a segment's weight, at a glance, in the width the inspector has. */
export function charLabel(chars: number): string {
  return chars < 1000 ? `${chars}` : `${(chars / 1000).toFixed(chars < 10_000 ? 1 : 0)}k`;
}

/** "4.0%" — a segment's share of the window, one decimal so a 0.1% segment is not "0%". */
export function shareLabel(part: number, whole: number): string {
  return whole > 0 ? `${(part / whole * 100).toFixed(1)}%` : "—";
}
