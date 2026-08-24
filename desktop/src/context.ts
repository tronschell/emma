/* What a turn carries besides the prompt: the folders this thread works out of,
   plus the files and knowledge categories picked in the composer. */

import { contextBlock, pickKey, slashName, type ContextPick, type FolderFile, type FolderGrant } from "../shared/folders";
import { pathName, type SlashCommand } from "../shared/slash";
import { ARTIFACT_LABELS, type ArtifactMeta } from "../shared/artifacts";
import { asPermissionMode, DEFAULT_PERMISSION_MODE, isPermissionMode, TOOL_CATALOG, type PermissionMode } from "../shared/permissions";
import { allocateCells, CHARS_PER_TOKEN, mergeUses, rateByContext, systemChars, usageKey, type ContextUse } from "../shared/usage";
import { tagName } from "../shared/settings";
import type { LiveAgent } from "../shared/agents";
import type { KnowledgePage, Message, Snapshot, Thread } from "./types";
import type { Block } from "./runs";
import { plural } from "./plural";
import { reasonText } from "./errors";

// ponytail: thread → folder lives in localStorage, not in the durable thread file.
// Move it into the host store if these need to survive a machine change.
const FOLDERS_KEY = "emma.threadFolders.v1";
const MODES_KEY = "emma.threadModes.v1";
const USES_KEY = "emma.threadContextUses.v2";
const BREAKDOWN_KEY = "emma.threadContextBreakdown.v1";

export function threadFolderMap(): Record<string, string[]> {
  try {
    const stored = JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(stored).filter(([, value]) => Array.isArray(value) && value.every((item) => typeof item === "string"))) as Record<string, string[]>;
  } catch { return {}; }
}

/// One thread, one directory — the folder `emma-cli` is spawned in. Sliced on the
/// way out as well as in, so a thread stored back when several could be attached
/// collapses onto its project rather than carrying folders no tool can reach.
export function threadFolders(threadId: string): string[] {
  return (threadFolderMap()[threadId] ?? []).slice(0, 1);
}

export function setThreadFolders(threadId: string, ids: string[]): void {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify({ ...threadFolderMap(), [threadId]: ids.slice(0, 1) }));
  // The sidebar files threads by their folder, so it has to hear about a change
  // made down in the composer.
  dispatchEvent(new Event("emma-thread-folders-changed"));
}

/* What a landed turn looked like, kept against the message it produced.

   The host stores a turn as one string, so its boundaries — where the narration
   broke for a tool call, which stretch was reasoning — only ever lived in the run
   store, and a restart replayed every old turn as a wall of text with its tool
   calls gone. Keyed by the message's own timestamp rather than by position, so a
   turn this window never heard (the notch answering while the workspace was
   closed) cannot shift the rest of them onto the wrong replies.

   ponytail: localStorage, capped per thread — past the caps the oldest turns read
   flat again, as they did before. Move it into the host store if that matters. */
const BLOCKS_KEY = "emma.threadBlocks.v1.";
/** Turns kept per thread, how much of one call's text goes with them, and the thread's ceiling. */
const KEPT_TURNS = 40;
const KEPT_TEXT = 8 * 1024;
const KEPT_BYTES = 512 * 1024;

/// Only what this wrote reads back: a half-written or hand-edited entry is a cache
/// miss, not a broken transcript.
function isBlock(value: unknown): value is Block {
  const block = value as Block;
  if (!block || typeof block !== "object") return false;
  if (block.kind === "step") return !!block.step && typeof block.step.toolCallId === "string" && typeof block.step.title === "string" && typeof block.step.kind === "string";
  return (block.kind === "text" || block.kind === "thinking" || block.kind === "notice") && typeof block.text === "string";
}

/** The blocks of this thread's past turns, by the timestamp of the message each wrote. */
export function cachedBlocks(threadId: string): Record<string, Block[]> {
  try {
    const stored = JSON.parse(localStorage.getItem(BLOCKS_KEY + threadId) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(stored).filter(([, turn]) => Array.isArray(turn) && turn.length > 0 && turn.every(isBlock))) as Record<string, Block[]>;
  } catch { return {}; }
}

/// A call's arguments and its result, cut to what a transcript row shows. The live
/// copy keeps everything; this is the one that has to fit in a quota.
const clamp = (value?: string) => value !== undefined && value.length > KEPT_TEXT ? `${value.slice(0, KEPT_TEXT)}…` : value;

/** Adds the turns not already known. Timestamps are fixed-width ISO-8601, so
    sorting them is oldest-first and pruning is a slice. */
export function rememberBlocks(threadId: string, turns: Record<string, Block[]>): void {
  const known = cachedBlocks(threadId);
  if (Object.keys(turns).every((at) => at in known)) return;
  let kept = Object.entries({ ...known, ...turns })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(-KEPT_TURNS)
    .map(([at, turn]) => [at, turn.map((block) => block.kind === "step"
      ? { ...block, step: { ...block.step, input: clamp(block.step.input), output: clamp(block.step.output) } }
      : block)] as [string, Block[]]);
  // Oldest first, so a long thread keeps the turns still worth scrolling back to.
  let text = JSON.stringify(Object.fromEntries(kept));
  while (text.length > KEPT_BYTES && kept.length > 1) {
    kept = kept.slice(1);
    text = JSON.stringify(Object.fromEntries(kept));
  }
  try { localStorage.setItem(BLOCKS_KEY + threadId, text); }
  catch {
    // Out of room. Every other thread's cache goes rather than the turn that just
    // happened — they rebuild themselves as those threads run again.
    for (const key of Object.keys(localStorage)) if (key.startsWith(BLOCKS_KEY) && key !== BLOCKS_KEY + threadId) localStorage.removeItem(key);
    try { localStorage.setItem(BLOCKS_KEY + threadId, text); } catch { /* one turn too big for storage: it reads flat, as it did before. */ }
  }
}

/* Files handed to one turn, kept so the turn still shows them. The host stores a
   turn as its text, so what rode along with it only ever lived in the composer:
   scrolling back — or relaunching — showed the question without the screenshot it
   was asking about.

   Written when the turn is sent, which is before its message exists, so a turn is
   named the way a pending prompt is: by where the thread stood when it was typed
   and by what was typed. Resolving that to a message is `turnAttachments` below.

   ponytail: localStorage, capped per thread. The thumbnails are what take the
   room, so they go first and the tiles stay — a tile without its picture still
   names its file and still opens it. */
const ATTACHED_KEY = "emma.threadAttachments.v1.";
const KEPT_ATTACHED_TURNS = 60;
const KEPT_ATTACHED_BYTES = 1024 * 1024;

/** One attached file as a landed turn draws it: enough to show it and to open it. */
export type TurnAttachment = { name: string; path: string; thumbnail?: string };

/** One sent turn's files, against the prompt that carried them. */
type AttachedTurn = { after: number; content: string; items: TurnAttachment[] };

/// Same rule as the blocks above: only what this wrote reads back.
function isAttachedTurn(value: unknown): value is AttachedTurn {
  const turn = value as AttachedTurn;
  if (!turn || typeof turn !== "object" || typeof turn.after !== "number" || typeof turn.content !== "string") return false;
  return Array.isArray(turn.items) && turn.items.length > 0
    && turn.items.every((item) => !!item && typeof item.name === "string" && typeof item.path === "string");
}

function storedAttachments(threadId: string): AttachedTurn[] {
  try {
    const stored = JSON.parse(localStorage.getItem(ATTACHED_KEY + threadId) ?? "[]") as unknown;
    return Array.isArray(stored) ? stored.filter(isAttachedTurn) : [];
  } catch { return []; }
}

/** Called as a turn is sent, with where the thread stood when it was typed. */
export function rememberTurnAttachments(threadId: string, after: number, content: string, items: TurnAttachment[]): void {
  if (!items.length) return;
  let kept = [...storedAttachments(threadId), { after, content, items }].slice(-KEPT_ATTACHED_TURNS);
  let text = JSON.stringify(kept);
  // Pictures before turns: a thread of screenshots would otherwise drop whole
  // turns to keep a handful of thumbnails nobody is looking at.
  if (text.length > KEPT_ATTACHED_BYTES) {
    kept = kept.map((turn) => ({ ...turn, items: turn.items.map(({ thumbnail: _picture, ...rest }) => rest) }));
    text = JSON.stringify(kept);
  }
  while (text.length > KEPT_ATTACHED_BYTES && kept.length > 1) {
    kept = kept.slice(1);
    text = JSON.stringify(kept);
  }
  try { localStorage.setItem(ATTACHED_KEY + threadId, text); }
  catch {
    // As the blocks store does: every other thread's copy goes before this one's.
    for (const key of Object.keys(localStorage)) if (key.startsWith(ATTACHED_KEY) && key !== ATTACHED_KEY + threadId) localStorage.removeItem(key);
    try { localStorage.setItem(ATTACHED_KEY + threadId, text); } catch { /* no room: the turn reads without its tiles, as it did before. */ }
  }
}

/** What each turn of this thread carried, by the position of its message. A turn
    matches the first message at or after where the thread stood that says what was
    typed — and never one an earlier turn already claimed, so the same prompt sent
    twice keeps its two sets of files apart rather than showing one twice. */
export function turnAttachments(threadId: string, messages: Message[]): Record<number, TurnAttachment[]> {
  const byIndex: Record<number, TurnAttachment[]> = {};
  const claimed = new Set<number>();
  for (const turn of storedAttachments(threadId)) {
    const at = messages.findIndex((message, index) =>
      index >= turn.after && !claimed.has(index) && message.role === "user" && message.content === turn.content);
    if (at < 0) continue;
    claimed.add(at);
    byIndex[at] = turn.items;
  }
  return byIndex;
}

/* The composer's permission picker, remembered per thread. Main keeps its own copy
   and only ever trusts that one — this is what the picker opens on, nothing more. */

function allModes(): Record<string, string> {
  try {
    const stored = JSON.parse(localStorage.getItem(MODES_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(stored).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  } catch { return {}; }
}

/** A thread's own rung, or the default from Settings → Tools until it has one. */
export function threadMode(threadId: string, fallback: PermissionMode = DEFAULT_PERMISSION_MODE): PermissionMode {
  const saved = allModes()[threadId];
  return isPermissionMode(saved) ? saved : fallback;
}

export function setThreadMode(threadId: string, mode: PermissionMode): void {
  localStorage.setItem(MODES_KEY, JSON.stringify({ ...allModes(), [threadId]: mode }));
}

/* The island's own rung, remembered across the windows it opens and closes. Its
   threads are one-off, so a per-thread memory would forget it every time; and it
   opens on Auto rather than Ask because there is nobody watching a surface that
   closes the moment it loses focus — the verifier answers, or the call comes back
   to the user next time they look. */

const OVERLAY_MODE_KEY = "emma.overlayMode.v1";

export function overlayMode(): PermissionMode {
  return asPermissionMode(localStorage.getItem(OVERLAY_MODE_KEY) ?? "auto");
}

export function setOverlayMode(mode: PermissionMode): void {
  localStorage.setItem(OVERLAY_MODE_KEY, mode);
}

/* The context ledger: every segment the renderer put in a request, so the
   inspector can show what a turn literally carried instead of describing it.
   ponytail: same localStorage store as the folders above. The host never
   reports per-turn input tokens, so sizes are the characters this side sent. */

function allUses(): Record<string, ContextUse[]> {
  try {
    const stored = JSON.parse(localStorage.getItem(USES_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(stored).filter(([, value]) => Array.isArray(value))) as Record<string, ContextUse[]>;
  } catch { return {}; }
}

export function threadUses(threadId: string): ContextUse[] {
  return allUses()[threadId] ?? [];
}

export function recordUses(threadId: string, uses: Omit<ContextUse, "turns">[]): void {
  if (!uses.length) return;
  localStorage.setItem(USES_KEY, JSON.stringify({ ...allUses(), [threadId]: mergeUses(threadUses(threadId), uses) }));
}

/* What the Harness experiments did to this thread's window, totalled over its
   turns. Both levers act on one step's request and leave nothing behind in the
   transcript, so a running total is the only way their effect is countable:
   pruning takes tokens out of what is resent, the repeated prompt puts tokens
   back in. Per thread, because that is the unit the levers are worth judging on
   — one long tool-heavy turn is where they either pay or cost.
   ponytail: same localStorage store as the ledger above, in the harness's own
   ~4-chars-a-token estimate. */
const EXPERIMENTS_KEY = "emma.threadExperiments.v1";

export interface ExperimentTally {
  /** Tokens pruning took out of this thread's requests. */
  savedTokens: number;
  /** Tokens the repeated prompt put back in. */
  addedTokens: number;
  /** Tool results blanked, and steps that repeated the prompt. */
  prunedResults: number;
  reinjections: number;
}

export const NO_EXPERIMENTS: ExperimentTally = { savedTokens: 0, addedTokens: 0, prunedResults: 0, reinjections: 0 };

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

function allExperiments(): Record<string, ExperimentTally> {
  try {
    const stored = JSON.parse(localStorage.getItem(EXPERIMENTS_KEY) ?? "{}") as Record<string, Partial<ExperimentTally>>;
    return Object.fromEntries(Object.entries(stored).map(([threadId, tally]) => [threadId, {
      savedTokens: number(tally?.savedTokens),
      addedTokens: number(tally?.addedTokens),
      prunedResults: number(tally?.prunedResults),
      reinjections: number(tally?.reinjections),
    }]));
  } catch { return {}; }
}

export function threadExperiments(threadId: string): ExperimentTally {
  return allExperiments()[threadId] ?? NO_EXPERIMENTS;
}

/** Folds one step's rewrite into the thread's running total. */
export function recordExperiment(threadId: string, fired: { prunedResults: number; reinjected: boolean; savedTokens: number; addedTokens: number }): void {
  const at = threadExperiments(threadId);
  const total: ExperimentTally = {
    savedTokens: at.savedTokens + number(fired.savedTokens),
    addedTokens: at.addedTokens + number(fired.addedTokens),
    prunedResults: at.prunedResults + number(fired.prunedResults),
    reinjections: at.reinjections + (fired.reinjected ? 1 : 0),
  };
  localStorage.setItem(EXPERIMENTS_KEY, JSON.stringify({ ...allExperiments(), [threadId]: total }));
}

export function historyUse(thread: Thread): Omit<ContextUse, "turns"> {
  const chars = thread.messages.reduce((sum, message) => sum + message.content.length, 0);
  return { kind: "messages", label: `${thread.messages.length} ${thread.messages.length === 1 ? "message" : "messages"}`, chars };
}

export interface ContextBreakdown {
  systemPromptBytes: number;
  systemToolsBytes: number;
  mcpToolsBytes: number;
  skillsBytes: number;
  memoryBytes: number;
}

export const NO_BREAKDOWN: ContextBreakdown = { systemPromptBytes: 0, systemToolsBytes: 0, mcpToolsBytes: 0, skillsBytes: 0, memoryBytes: 0 };

const PREFIX_ROWS:{ kind: ContextUse["kind"]; label: string; of: keyof ContextBreakdown }[] = [
  { kind: "system", label: "System prompt", of: "systemPromptBytes" },
  { kind: "tools", label: "System tools", of: "systemToolsBytes" },
  { kind: "mcp", label: "MCP tools", of: "mcpToolsBytes" },
  { kind: "skills", label: "Skills", of: "skillsBytes" },
  { kind: "memory", label: "Memory files", of: "memoryBytes" },
];

function allBreakdowns(): Record<string, ContextBreakdown> {
  try {
    const stored = JSON.parse(localStorage.getItem(BREAKDOWN_KEY) ?? "{}") as Record<string, Partial<ContextBreakdown> | undefined>;
    return Object.fromEntries(Object.entries(stored).map(([threadId, parts]) => [threadId, {
      systemPromptBytes: number(parts?.systemPromptBytes),
      systemToolsBytes: number(parts?.systemToolsBytes),
      mcpToolsBytes: number(parts?.mcpToolsBytes),
      skillsBytes: number(parts?.skillsBytes),
      memoryBytes: number(parts?.memoryBytes),
    }]));
  } catch { return {}; }
}

export function threadBreakdown(threadId: string): ContextBreakdown {
  return allBreakdowns()[threadId] ?? NO_BREAKDOWN;
}

export function recordBreakdown(threadId: string, parts: ContextBreakdown): void {
  localStorage.setItem(BREAKDOWN_KEY, JSON.stringify({ ...allBreakdowns(), [threadId]: parts }));
}

export function prefixUses(breakdown: ContextBreakdown, turns: number): ContextUse[] {
  return PREFIX_ROWS.filter((row) => breakdown[row.of] > 0).map((row) => ({ kind: row.kind, label: row.label, chars: breakdown[row.of], turns }));
}


/** ponytail: `generation.inputTokens` is read through a cast until `types.ts`
    declares it. Drop the cast once it does — the host already sends it. */
function inputTokens(message: Thread["messages"][number]): number {
  return (message.generation as { inputTokens?: number } | null | undefined)?.inputTokens ?? 0;
}

/** What the provider billed as input on the most recent turn that reported any.
    Zero for an older thread, or a route that sends no usage. */
export function lastInputTokens(thread: Thread): number {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const tokens = inputTokens(thread.messages[index]);
    if (tokens > 0) return tokens;
  }
  return 0;
}

export function systemUse(thread: Thread, measuredChars: number): Omit<ContextUse, "turns"> | undefined {
  const chars = systemChars(lastInputTokens(thread), measuredChars);
  return chars > 0 ? { kind: "messages", label: "Tool results & retries", chars } : undefined;
}

/* The ledger itself: what this thread's turns literally carried, measured once
   and read by every widget that draws a piece of it, so two of them cannot
   disagree about the same number.

   One cell per 1/48th of the model's context window, hued by kind and laid out
   as one bar, so a folder listing that has quietly grown to half the request is
   visible before it costs a turn. Whatever the turns have not claimed is the
   free tail. */
const USAGE_CELLS = 48;

export interface Ledger {
  rows: ContextUse[];
  total: number;
  capacity: number;
  free: number;
  whole: number;
  cells: string[];
  kinds: Map<string, string>;
  messages: number;
  replies: number;
  attachments: number;
  calls: number;
  tokens: number;
  elapsed: number;
  curve: { context: number; rate: number; turns: number }[];
  largest?: ContextUse;
  /** What the timeline's context axis weighs its spans against. */
  carriedTokens: number;
  /** What the Harness experiments took out of this thread's requests and put back
      in. Not a row: neither lever is a segment the turn carries, they are what was
      done to the segments above — and a saving is negative mass a grid cannot draw. */
  experiments: ExperimentTally;
}

/**
 * `landedCalls` is what the turns already on the thread did, counted off the
 * traces the host kept; `inFlight` is what the turn still running has done so
 * far. A trace is written when its turn ends, so the two never overlap and the
 * tile does not step as one becomes the other.
 */
export function buildLedger(thread: Thread | undefined, uses: ContextUse[], contextTokens: number, inFlight: LiveAgent[], experiments: ExperimentTally, landedCalls = 0, breakdown: ContextBreakdown = NO_BREAKDOWN): Ledger {
  const messages: Message[] = thread?.messages ?? [];
  const replies = messages.filter((message) => message.role === "assistant").length;
  // A turn is one durable message however many steps it took, so a ledger read
  // off `thread.messages` alone sits still through exactly the part that fills
  // the window — a hundred tool results, resent every step — and then jumps when
  // the turn lands. The loop counts what it hands over, so the running total is
  // shown as its own row until the message it becomes replaces it.
  const running = inFlight.reduce((sum, agent) => sum + agent.inputTokens, 0) * CHARS_PER_TOKEN;
  const liveCalls = inFlight.reduce((sum, agent) => sum + agent.toolCalls, 0);
  const liveTurns = inFlight.filter((agent) => agent.threadId === thread?.id);
  const measured: ContextUse[] = thread ? [
    { ...historyUse(thread), turns: messages.filter((message) => message.role === "user").length },
    ...(running > 0 ? [{ kind: "messages" as const, label: `This turn · ${liveCalls} tool ${plural(liveCalls, "call")}`, chars: running, turns: 1 }] : []),
    ...uses,
  ] : [];
  const prefix = thread ? prefixUses(breakdown, replies) : [];
  const named = measured.reduce((sum, row) => sum + row.chars, 0) - running + prefix.reduce((sum, row) => sum + row.chars, 0);
  const system = thread ? systemUse(thread, named) : undefined;
  const rows: ContextUse[] = [...measured, ...(system ? [{ ...system, turns: replies }] : []), ...prefix];
  const total = rows.reduce((sum, row) => sum + row.chars, 0);
  // Only the OpenRouter catalog states a window; on the fallback and local routes the
  // shares are of what this thread has sent, and there is no free tail to draw.
  const capacity = contextTokens * CHARS_PER_TOKEN;
  const free = Math.max(0, capacity - total);
  const packed = allocateCells([...rows.map((row) => ({ key: usageKey(row), chars: row.chars })), { key: "free", chars: free }], USAGE_CELLS);
  // Every provider-backed reply carries its own tokens and milliseconds, so the
  // thread's rate is the pooled one, not the average of the per-message rates.
  const tokens = messages.reduce((sum, message) => sum + (message.generation?.outputTokens ?? 0), 0)
    + liveTurns.reduce((sum, agent) => sum + agent.outputTokens, 0);
  return {
    rows,
    total,
    capacity,
    free,
    whole: capacity || total,
    cells: [...packed.filter((key) => key !== "free"), ...packed.filter((key) => key === "free")],
    kinds: new Map<string, string>([...rows.map((row) => [usageKey(row), row.kind] as const), ["free", "free"]]),
    messages: messages.length + liveTurns.length * 2,
    replies: replies + liveTurns.length,
    attachments: uses.length,
    calls: landedCalls + liveCalls,
    tokens,
    elapsed: messages.reduce((sum, message) => sum + (message.generation?.durationMilliseconds ?? 0), 0) + liveTurns.reduce((sum, agent) => sum + agent.generationMs, 0),
    curve: rateByContext(messages.flatMap((message) => message.generation ? [message.generation] : [])),
    largest: rows.reduce<ContextUse | undefined>((top, row) => !top || row.chars > top.chars ? row : top, undefined),
    carriedTokens: Math.round(total / CHARS_PER_TOKEN),
    experiments,
  };
}

/** Pages the host may retrieve into a system message. Which ones, and how many
    characters, is scored per prompt host-side — the renderer only knows the pool. */
export function knowledgePool(thread: Thread, snapshot: Snapshot): number {
  return snapshot.pages.filter((page) => thread.sourceKnowledgeBaseIds.includes(page.knowledgeBaseId)).length;
}

/** Examples one category needs before Emma files new items into it by itself. */
export const AUTO_FILE_EXAMPLES = 5;
export const UNFILED_CATEGORY = "unfiled";

/**
 * The one rule both auto-filers obey: Emma only files on its own once the user's own
 * filing has taught it what a category looks like — five items in one of them. Until
 * then the thing lands unfiled, and the count is what the user is told.
 *
 * Labels Emma applied itself are never passed in. Counting its own guesses would let
 * one wrong answer become the examples that argue for more of the same.
 */
export function learnedFrom(labels: string[]) {
  const counts = new Map<string, number>();
  for (const label of labels) {
    if (!label || label === UNFILED_CATEGORY) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const [category = "", examples = 0] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  return { ready: examples >= AUTO_FILE_EXAMPLES, category, examples };
}

/** Where one knowledge base stands: how close its best category is to teaching Emma the filing. */
export function autoFileStatus(pages: KnowledgePage[], baseId: string) {
  return learnedFrom(pages.filter((page) => page.knowledgeBaseId === baseId).map((page) => page.category));
}

/* A thread's tag: the second axis beside its folder, and deliberately not the same
   field. A folder is where `emma-cli` is spawned — a capability, one per thread —
   while a tag is what the thread is about, so one thread carries both and the
   sidebar can group by the folder while the row still says "billing".

   Same store shape and the same ponytail caveat as the folders above: localStorage,
   so a tag survives a relaunch but not a change of Mac. Move it into the thread
   record in `crates/core/src/thread.rs` if it has to travel. */
const TAGS_KEY = "emma.threadTags.v1";

/** `auto` is Emma's own guess: drawn differently, counted for nothing, and always overwritable. */
export interface ThreadTag { tag: string; auto: boolean }

/** One tag per thread, as `page.category` is one per page: a thread is filed, not labelled. */
export function threadTags(): Record<string, ThreadTag> {
  try {
    const stored = JSON.parse(localStorage.getItem(TAGS_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(stored)
      .map(([id, value]) => [id, value as Partial<ThreadTag>])
      .filter(([, value]) => typeof (value as Partial<ThreadTag>).tag === "string" && (value as Partial<ThreadTag>).tag)
      .map(([id, value]) => [id, { tag: (value as ThreadTag).tag, auto: (value as Partial<ThreadTag>).auto === true }])) as Record<string, ThreadTag>;
  } catch { return {}; }
}

/**
 * Files one thread. `auto` marks Emma's own guess.
 *
 * The guard is here rather than at the call sites because both the picker and the
 * sweep come through this one door: a tag the user applied by hand is never
 * overwritten by a guess. An empty tag clears the row, which is how a wrong guess
 * is undone.
 */
export function setThreadTag(threadId: string, tag: string, auto = false): void {
  const tags = threadTags();
  if (auto && tags[threadId] && !tags[threadId].auto) return;
  const clean = tagName(tag);
  if (clean) tags[threadId] = { tag: clean, auto };
  else delete tags[threadId];
  localStorage.setItem(TAGS_KEY, JSON.stringify(tags));
  dispatchEvent(new Event("emma-thread-tags-changed"));
}

/** The categories the user made, most-used first: the only ones Emma may file into. */
export function handTags(): string[] {
  const counts = new Map<string, number>();
  for (const entry of Object.values(threadTags())) if (!entry.auto) counts.set(entry.tag, (counts.get(entry.tag) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
}

/** How close the thread side is to filing by itself — hand tags only, same threshold as the pages. */
export function autoTagStatus(tags: Record<string, ThreadTag> = threadTags()) {
  return learnedFrom(Object.values(tags).filter((entry) => !entry.auto).map((entry) => entry.tag));
}

/**
 * The files of every folder this thread works out of, as menu entries.
 * `name` is what the token will read: the folder-relative path for the "@" menu,
 * so typing any word of the path matches, and the bare basename for "/".
 * ponytail: matching is over the path only — searching file *contents* would
 * mean reading every granted file on each keystroke, so it is not done.
 */
export function fileCommands(folders: FolderGrant[], folderIds: string[], files: Record<string, FolderFile[]>, name = pathName): SlashCommand[] {
  return folderIds.flatMap((folderId) => {
    const folder = folders.find((item) => item.id === folderId);
    return folder ? (files[folderId] ?? []).map((file) => ({ id: pickKey({ kind: "file", folderId, path: file.path }), name: name(file.path), kind: "file" as const, detail: `${folder.name}/${file.path}`, pick: { kind: "file" as const, folderId, path: file.path } })) : [];
  });
}

/**
 * Every built-in tool as a "/" entry, minus whatever Settings → Tools switched
 * off. Picking one only writes the token: the turn already advertises the tool,
 * so naming it tells the agent which one to reach for rather than calling it.
 * ponytail: the mode gate is not applied, so a tool hidden in `plan` still lists
 * — switching rungs is the fix. Pass the mode through if that reads wrong.
 */
export function toolCommands(disabled: readonly string[] = []): SlashCommand[] {
  return TOOL_CATALOG
    .filter((tool) => !disabled.includes(tool.name))
    .map((tool) => ({ id: `tool:${tool.name}`, name: tool.name, kind: "tool" as const, detail: tool.blurb }));
}

/** The "@" entries for what Emma made: one per artifact on the Artifacts page. */
export function artifactCommands(artifacts: ArtifactMeta[]): SlashCommand[] {
  return artifacts.map((artifact) => ({
    id: pickKey({ kind: "artifact", id: artifact.id, title: artifact.title }),
    name: pathName(artifact.title),
    kind: "artifact" as const,
    detail: `${ARTIFACT_LABELS[artifact.kind]} · artifact`,
    pick: { kind: "artifact" as const, id: artifact.id, title: artifact.title },
  }));
}

/** The "@" entries for what Emma saved: one per knowledge page. */
export function pageCommands(snapshot?: Snapshot): SlashCommand[] {
  return (snapshot?.pages ?? []).map((page) => ({
    id: pickKey({ kind: "page", id: page.id }),
    name: pathName(page.title),
    kind: "page" as const,
    detail: `${snapshot?.knowledgeBases.find((base) => base.id === page.knowledgeBaseId)?.name ?? "knowledge"} · ${page.category}`,
    pick: { kind: "page" as const, id: page.id },
  }));
}

/** Everything "@" can name, in the order the menu lists it: what Emma made, what
    it saved, then the files of the folders the thread works out of. */
export function atCommands(artifacts: ArtifactMeta[], snapshot: Snapshot | undefined, folders: FolderGrant[], folderIds: string[], files: Record<string, FolderFile[]>): SlashCommand[] {
  return [...artifactCommands(artifacts), ...pageCommands(snapshot), ...fileCommands(folders, folderIds, files)];
}

/** The "/" menu entries the local context contributes: every listed file, every knowledge category. */
export function contextCommands(folders: FolderGrant[], folderIds: string[], files: Record<string, FolderFile[]>, snapshot: Snapshot): SlashCommand[] {
  const categoryCommands = snapshot.knowledgeBases.flatMap((base) => {
    const categories = [...new Set([...base.categories, ...snapshot.pages.filter((page) => page.knowledgeBaseId === base.id).map((page) => page.category)])];
    return categories.map((category) => ({ id: pickKey({ kind: "category", baseId: base.id, category }), name: slashName(category), kind: "category" as const, detail: `${base.name} · knowledge category`, pick: { kind: "category" as const, baseId: base.id, category } }));
  });
  return [...fileCommands(folders, folderIds, files, slashName), ...categoryCommands];
}

export function pickLabel(pick: ContextPick, folders: FolderGrant[], snapshot: Snapshot): string {
  if (pick.kind === "file") return `${folders.find((item) => item.id === pick.folderId)?.name ?? "folder"}/${pick.path}`;
  if (pick.kind === "attachment") return pick.name;
  if (pick.kind === "artifact") return pick.title;
  if (pick.kind === "page") return snapshot.pages.find((item) => item.id === pick.id)?.title ?? "page";
  return `${snapshot.knowledgeBases.find((item) => item.id === pick.baseId)?.name ?? "base"} · ${pick.category}`;
}

/** Read everything attached to this thread into the bounded block the turn
    carries, and report what each attachment weighed for the context ledger. */
export async function buildAttachedContext(folders: FolderGrant[], folderIds: string[], picks: ContextPick[], files: Record<string, FolderFile[]>, snapshot: Snapshot): Promise<{ text: string; uses: Omit<ContextUse, "turns">[] }> {
  const sections: { heading: string; body: string; label: string }[] = [];
  for (const folderId of folderIds) {
    const folder = folders.find((item) => item.id === folderId);
    if (!folder) continue;
    const listing = (files[folderId] ?? []).map((file) => file.path);
    sections.push({ heading: `Folder ${folder.name} (${folder.path})`, body: listing.length ? `Files:\n${listing.join("\n")}` : "No readable text files.", label: `${folder.name}/ · file list` });
  }
  for (const pick of picks) {
    if (pick.kind === "file") {
      const folder = folders.find((item) => item.id === pick.folderId);
      const label = `${folder?.name ?? ""}/${pick.path}`;
      try {
        const file = await window.emma.readFolderFile({ folderId: pick.folderId, path: pick.path });
        sections.push({ heading: `File ${folder?.name ?? ""}/${file.path}`, body: file.text, label });
      } catch (reason) {
        sections.push({ heading: `File ${label}`, body: `Could not be read: ${reasonText(reason)}`, label });
      }
      continue;
    }
    /* A file the user handed this message. Text comes in whole; a picture comes in
       as the path to look at, because most of the catalogue cannot see one and the
       vision tool is the route to it either way — Emma's own loop reads the path
       here, and the harness resolves the same path on its side. */
    if (pick.kind === "attachment") {
      try {
        const file = await window.emma.readAttachment(pick.id);
        sections.push(file.text === undefined
          ? { heading: `Image ${file.name}`, body: `The user attached this image. It is at ${file.path} on this Mac — give the vision tool exactly that path to look at it.`, label: pick.name }
          : { heading: `File ${file.name} (${file.path})`, body: file.text, label: pick.name });
      } catch (reason) {
        sections.push({ heading: `File ${pick.name}`, body: `Could not be read: ${reasonText(reason)}`, label: pick.name });
      }
      continue;
    }
    if (pick.kind === "artifact") {
      try {
        const artifact = await window.emma.readArtifact(pick.id);
        sections.push({ heading: `Artifact ${artifact.title}`, body: artifact.content, label: pick.title });
      } catch (reason) {
        sections.push({ heading: `Artifact ${pick.title}`, body: `Could not be read: ${reasonText(reason)}`, label: pick.title });
      }
      continue;
    }
    if (pick.kind === "page") {
      const page = snapshot.pages.find((item) => item.id === pick.id);
      const label = page?.title ?? "page";
      sections.push({ heading: `Knowledge page ${label}`, body: page ? `${page.analysis.summary}\n${page.analysis.body}` : "This page is no longer in the knowledge base.", label });
      continue;
    }
    const pages = snapshot.pages.filter((page) => page.knowledgeBaseId === pick.baseId && page.category === pick.category);
    sections.push({ heading: `Knowledge category ${pickLabel(pick, folders, snapshot)}`, body: pages.map((page) => `### ${page.title}\n${page.analysis.summary}\n${page.analysis.body}`).join("\n\n") || "This category has no pages yet.", label: pickLabel(pick, folders, snapshot) });
  }
  return {
    text: contextBlock(sections),
    uses: sections.map((section) => ({ kind: "messages" as const, label: section.label, chars: section.heading.length + section.body.length })),
  };
}
