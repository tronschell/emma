
import { contextBlock, pickKey, slashName, type ContextPick, type FolderFile, type FolderGrant } from "../shared/folders";
import { pathName, type SlashCommand } from "../shared/slash";
import { ARTIFACT_LABELS, type ArtifactMeta } from "../shared/artifacts";
import { DEFAULT_PERMISSION_MODE, isPermissionMode, TOOL_CATALOG, type PermissionMode } from "../shared/permissions";
import { CHARS_PER_TOKEN, mergeUses, rateByContext, usageKey, type ContextUse } from "../shared/usage";
import { SETTINGS_KEY, validateSettings } from "../shared/settings";
import { keepKindLabel, tagName, type KeptNote } from "../shared/vault";
import { COMPONENT_ZONE_LABEL } from "../shared/components";
import type { LiveAgent } from "../shared/agents";
import type { Message, Thread } from "./types";
import type { Block } from "./runs";
import { plural } from "./plural";
import { reasonText } from "./errors";

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

export function threadFolders(threadId: string): string[] {
  return (threadFolderMap()[threadId] ?? []).slice(0, 1);
}

export function setThreadFolders(threadId: string, ids: string[]): void {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify({ ...threadFolderMap(), [threadId]: ids.slice(0, 1) }));
  dispatchEvent(new Event("emma-thread-folders-changed"));
}

function storeEvicting(prefix: string, threadId: string, text: string): void {
  const write = () => { try { localStorage.setItem(prefix + threadId, text); return true; } catch { return false; } };
  if (write()) return;
  for (const key of Object.keys(localStorage)) if (key.startsWith(prefix) && key !== prefix + threadId) localStorage.removeItem(key);
  write();
}

const BLOCKS_KEY = "emma.threadBlocks.v1.";
const KEPT_TURNS = 40;
const KEPT_TEXT = 8 * 1024;
const KEPT_BYTES = 512 * 1024;

function isBlock(value: unknown): value is Block {
  const block = value as Block;
  if (!block || typeof block !== "object") return false;
  if (block.kind === "step") return !!block.step && typeof block.step.toolCallId === "string" && typeof block.step.title === "string" && typeof block.step.kind === "string";
  return (block.kind === "text" || block.kind === "thinking" || block.kind === "notice") && typeof block.text === "string";
}

export function cachedBlocks(threadId: string): Record<string, Block[]> {
  try {
    const stored = JSON.parse(localStorage.getItem(BLOCKS_KEY + threadId) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(stored).filter(([, turn]) => Array.isArray(turn) && turn.length > 0 && turn.every(isBlock))) as Record<string, Block[]>;
  } catch { return {}; }
}

const clamp = (value?: string) => value !== undefined && value.length > KEPT_TEXT ? `${value.slice(0, KEPT_TEXT)}…` : value;

export function rememberBlocks(threadId: string, turns: Record<string, Block[]>): void {
  const known = cachedBlocks(threadId);
  if (Object.keys(turns).every((at) => at in known)) return;
  let kept = Object.entries({ ...known, ...turns })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(-KEPT_TURNS)
    .map(([at, turn]) => [at, turn.map((block) => block.kind === "step"
      ? { ...block, step: { ...block.step, input: clamp(block.step.input), output: clamp(block.step.output) } }
      : block)] as [string, Block[]]);
  let text = JSON.stringify(Object.fromEntries(kept));
  while (text.length > KEPT_BYTES && kept.length > 1) {
    kept = kept.slice(1);
    text = JSON.stringify(Object.fromEntries(kept));
  }
  storeEvicting(BLOCKS_KEY, threadId, text);
}

const PICK_KINDS = new Set(["file", "note", "artifact", "attachment", "terminal", "diff", "visual", "component"]);

const ATTACHED_KEY = "emma.threadAttachments.v1.";
const KEPT_ATTACHED_TURNS = 60;
const KEPT_ATTACHED_BYTES = 1024 * 1024;

export type TurnAttachment = { kind?: ContextPick["kind"]; name: string; path?: string; thumbnail?: string };

type AttachedTurn = { after: number; content: string; items: TurnAttachment[] };

function isAttachedTurn(value: unknown): value is AttachedTurn {
  const turn = value as AttachedTurn;
  if (!turn || typeof turn !== "object" || typeof turn.after !== "number" || typeof turn.content !== "string") return false;
  return Array.isArray(turn.items) && turn.items.length > 0
    && turn.items.every((item) => !!item && typeof item.name === "string"
      && (item.path === undefined || typeof item.path === "string")
      && (item.kind === undefined || PICK_KINDS.has(item.kind)));
}

function storedAttachments(threadId: string): AttachedTurn[] {
  try {
    const stored = JSON.parse(localStorage.getItem(ATTACHED_KEY + threadId) ?? "[]") as unknown;
    return Array.isArray(stored) ? stored.filter(isAttachedTurn) : [];
  } catch { return []; }
}

export function rememberTurnAttachments(threadId: string, after: number, content: string, items: TurnAttachment[]): void {
  if (!items.length) return;
  let kept = [...storedAttachments(threadId), { after, content, items }].slice(-KEPT_ATTACHED_TURNS);
  let text = JSON.stringify(kept);
  if (text.length > KEPT_ATTACHED_BYTES) {
    kept = kept.map((turn) => ({ ...turn, items: turn.items.map(({ thumbnail: _picture, ...rest }) => rest) }));
    text = JSON.stringify(kept);
  }
  while (text.length > KEPT_ATTACHED_BYTES && kept.length > 1) {
    kept = kept.slice(1);
    text = JSON.stringify(kept);
  }
  storeEvicting(ATTACHED_KEY, threadId, text);
}

export function pendingAttachments(threadId: string, after: number, content: string): TurnAttachment[] {
  return storedAttachments(threadId).find((turn) => turn.after === after && turn.content === content)?.items ?? [];
}

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

const DRAFT_KEY = "emma.threadDraft.v1.";

/** What the composer is holding but has not sent: the typed prompt and its picks.
    A thread's view is torn down every time you switch thread or leave for another
    page, so without this an unsent prompt dies with the unmount. */
export type ComposerDraft = { text: string; picks: ContextPick[] };

export function threadDraft(threadId: string): ComposerDraft {
  try {
    const stored = JSON.parse(localStorage.getItem(DRAFT_KEY + threadId) ?? "{}") as Partial<ComposerDraft>;
    const picks = Array.isArray(stored.picks) ? stored.picks.filter((pick) => !!pick && PICK_KINDS.has((pick as ContextPick).kind)) : [];
    return { text: typeof stored.text === "string" ? stored.text : "", picks };
  } catch { return { text: "", picks: [] }; }
}

export function setThreadDraft(threadId: string, draft: ComposerDraft): void {
  if (!threadId) return;
  if (!draft.text && !draft.picks.length) { localStorage.removeItem(DRAFT_KEY + threadId); return; }
  storeEvicting(DRAFT_KEY, threadId, JSON.stringify(draft));
}

function allModes(): Record<string, string> {
  try {
    const stored = JSON.parse(localStorage.getItem(MODES_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(stored).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  } catch { return {}; }
}

export function threadMode(threadId: string, fallback: PermissionMode = DEFAULT_PERMISSION_MODE): PermissionMode {
  const saved = allModes()[threadId];
  return isPermissionMode(saved) ? saved : fallback;
}

export function setThreadMode(threadId: string, mode: PermissionMode): void {
  localStorage.setItem(MODES_KEY, JSON.stringify({ ...allModes(), [threadId]: mode }));
}

const REVIEWS_KEY = "emma.threadReview.v1";

function allReviews(): Record<string, boolean> {
  try {
    const stored = JSON.parse(localStorage.getItem(REVIEWS_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(stored).filter(([, value]) => typeof value === "boolean")) as Record<string, boolean>;
  } catch { return {}; }
}

export function threadReview(threadId: string, fallback = true): boolean {
  return allReviews()[threadId] ?? fallback;
}

export function setThreadReview(threadId: string, review: boolean): void {
  localStorage.setItem(REVIEWS_KEY, JSON.stringify({ ...allReviews(), [threadId]: review }));
}

const OVERLAY_MODE_KEY = "emma.overlayMode.v2";
const POISONED_OVERLAY_MODE_KEY = "emma.overlayMode.v1";

function carriedOverlayMode(): string | null {
  const legacy = localStorage.getItem(POISONED_OVERLAY_MODE_KEY);
  localStorage.removeItem(POISONED_OVERLAY_MODE_KEY);
  if (legacy === null || legacy === "auto" || !isPermissionMode(legacy)) return null;
  localStorage.setItem(OVERLAY_MODE_KEY, legacy);
  return legacy;
}

export function overlayMode(fallback: PermissionMode = DEFAULT_PERMISSION_MODE): PermissionMode {
  const saved = localStorage.getItem(OVERLAY_MODE_KEY) ?? carriedOverlayMode();
  return isPermissionMode(saved) ? saved : fallback;
}

export function setOverlayMode(mode: PermissionMode): void {
  localStorage.setItem(OVERLAY_MODE_KEY, mode);
}

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

const CLEARED_KEY = "emma.threadCleared.v1";

function allCleared(): Record<string, number> {
  try {
    const stored = JSON.parse(localStorage.getItem(CLEARED_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(stored).filter(([, value]) => typeof value === "number" && Number.isInteger(value) && value >= 0)) as Record<string, number>;
  } catch { return {}; }
}

export function clearedAt(threadId: string): number {
  return allCleared()[threadId] ?? 0;
}

export function markCleared(threadId: string, at: number): void {
  localStorage.setItem(CLEARED_KEY, JSON.stringify({ ...allCleared(), [threadId]: at }));
  localStorage.setItem(USES_KEY, JSON.stringify({ ...allUses(), [threadId]: [] }));
}

const EXPERIMENTS_KEY = "emma.threadExperiments.v1";

export interface ExperimentTally {
  savedTokens: number;
  addedTokens: number;
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

const PREFIX_ROWS:{ kind: ContextUse["kind"]; label: string; of: keyof ContextBreakdown; source: SegmentSource }[] = [
  { kind: "system", label: "System prompt", of: "systemPromptBytes", source: "prompt" },
  { kind: "tools", label: "System tools", of: "systemToolsBytes", source: "tools" },
  { kind: "mcp", label: "MCP tools", of: "mcpToolsBytes", source: "mcp" },
  { kind: "skills", label: "Skills", of: "skillsBytes", source: "skills" },
  { kind: "memory", label: "Memory files", of: "memoryBytes", source: "memory" },
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

export function prefixUses(breakdown: ContextBreakdown, turns: number): LedgerRow[] {
  return PREFIX_ROWS.filter((row) => breakdown[row.of] > 0).map((row) => ({ kind: row.kind, label: row.label, chars: breakdown[row.of], turns, source: row.source }));
}

function inputTokens(message: Thread["messages"][number]): number {
  return (message.generation as { inputTokens?: number } | null | undefined)?.inputTokens ?? 0;
}

export function lastInputTokens(thread: Thread): number {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const tokens = inputTokens(thread.messages[index]);
    if (tokens > 0) return tokens;
  }
  return 0;
}

export type SegmentSource = "messages" | "turn" | "attachment" | "residual" | "prompt" | "tools" | "mcp" | "skills" | "memory";

export interface LedgerRow extends ContextUse {
  source: SegmentSource;
}

export interface SegmentItem {
  name: string;
  detail?: string;
  chars?: number;
}

export const SEGMENT_NOTES: Record<SegmentSource, string> = {
  messages: "Every message this thread still carries, oldest first.",
  turn: "The turn in flight, span by span: each model request and tool call, sized by what it left in the window.",
  attachment: "One attached item. This row is the whole of it.",
  residual: "What the provider billed for this turn minus everything measured above — tool results, retries and whatever the harness added mid-turn. Not itemised.",
  prompt: "The harness instructions and Emma's tool guidance, sent as one blob rather than a list.",
  tools: "Emma's tools, as switched on in Settings → Tools. The harness adds its own file and terminal tools to this row without naming them.",
  mcp: "MCP servers whose tool catalogue rides every request.",
  skills: "Skills mirrored to the harness. A skill is loaded in full only when it fires; the row is what its description costs every turn.",
  memory: "Memory files read into every request.",
};

const MAX_SEGMENT_ITEMS = 200;
const PREVIEW_CHARS = 120;

function toolItems(): SegmentItem[] {
  let disabled: readonly string[] = [];
  try { disabled = validateSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null")).tools.disabledTools; } catch { disabled = []; }
  return TOOL_CATALOG.filter((tool) => !disabled.includes(tool.name)).map((tool) => ({ name: tool.label, detail: tool.blurb }));
}

export async function segmentItems(source: SegmentSource, messages: Message[], threadId: string): Promise<SegmentItem[]> {
  if (source === "messages") {
    return messages.slice(-MAX_SEGMENT_ITEMS).map((message, index) => ({
      name: `${index + 1}. ${message.role === "user" ? "You" : message.role === "system" ? "Notice" : "Emma"}`,
      detail: message.content.replace(/\s+/g, " ").slice(0, PREVIEW_CHARS).trim(),
      chars: message.content.length,
    }));
  }
  if (source === "turn") {
    const spans = (await window.emma.listSpans())[threadId] ?? [];
    return spans
      .filter((span) => span.kind !== "agent")
      .map((span) => ({ name: span.name, detail: span.kind, chars: span.tokens === undefined ? undefined : Math.round(span.tokens * CHARS_PER_TOKEN) }));
  }
  if (source === "skills") {
    const skills = await window.emma.searchImportedSkills({ query: "", limit: 64 });
    return skills.map((skill) => ({ name: skill.name, detail: `from ${skill.source}` }));
  }
  if (source === "mcp") {
    const servers = await window.emma.listImportedMcpServers();
    return servers.map((server) => ({ name: server.name, detail: `${server.command}${server.argCount ? ` · ${server.argCount} ${plural(server.argCount, "argument")}` : ""}` }));
  }
  if (source === "tools") {
    const written = await window.emma.listToolTargets().then((targets) => targets.written).catch(() => []);
    return [...toolItems(), ...written.map((tool) => ({ name: tool.name, detail: tool.source }))];
  }
  if (source === "memory") {
    const notes = await window.emma.listMemories();
    return notes.map((note) => ({ name: note.path, chars: note.bytes }));
  }
  return [];
}

export interface Ledger {
  rows: LedgerRow[];
  total: number;
  capacity: number;
  free: number;
  whole: number;
  cells: { key: string; chars: number }[];
  kinds: Map<string, string>;
  messages: number;
  replies: number;
  attachments: number;
  calls: number;
  tokens: number;
  elapsed: number;
  curve: { context: number; rate: number; turns: number }[];
  largest?: LedgerRow;
  carriedTokens: number;
  experiments: ExperimentTally;
}

export function buildLedger(thread: Thread | undefined, uses: ContextUse[], contextTokens: number, inFlight: LiveAgent[], experiments: ExperimentTally, landedCalls = 0, breakdown: ContextBreakdown = NO_BREAKDOWN): Ledger {
  const messages: Message[] = thread?.messages ?? [];
  const replies = messages.filter((message) => message.role === "assistant").length;
  /* Only this thread's own agent. A subagent is delegated work that never lands
     in the manager's window — its tokens and calls belong to its own ledger. */
  const liveTurns = inFlight.filter((agent) => agent.threadId === thread?.id);
  const liveCalls = liveTurns.reduce((sum, agent) => sum + agent.toolCalls, 0);
  /* The one number here that is not an estimate: what the provider says it read
     for the most recent request. A turn in flight has already sent the whole
     window, so its count replaces the last landed one rather than adding to it —
     summing the two counted the history twice and doubled the bar for as long as
     a run lasted. */
  const anchor = thread ? Math.max(lastInputTokens(thread), ...liveTurns.map((agent) => agent.inputTokens)) : 0;
  const anchorChars = anchor * CHARS_PER_TOKEN;
  const measured: LedgerRow[] = thread ? [
    { ...historyUse(thread), turns: messages.filter((message) => message.role === "user").length, source: "messages" },
    ...uses.map((use) => ({ ...use, source: "attachment" as const })),
  ] : [];
  const prefix = thread ? prefixUses(breakdown, replies) : [];
  const counted = [...measured, ...prefix];
  const named = counted.reduce((sum, row) => sum + row.chars, 0);
  /* Characters over-count what a request actually carried once history is pruned
     or compacted — this side still holds every message the harness dropped. Scale
     the rows onto the provider's count rather than claiming the model was sent
     more than it was. */
  const scale = anchorChars && named > anchorChars ? anchorChars / named : 1;
  const scaled = scale === 1 ? counted : counted.map((row) => ({ ...row, chars: Math.round(row.chars * scale) }));
  const residual = anchorChars - scaled.reduce((sum, row) => sum + row.chars, 0);
  const system: LedgerRow[] = residual > 0
    ? [liveTurns.length
      ? { kind: "messages", label: `This turn · ${liveCalls} tool ${plural(liveCalls, "call")}`, chars: residual, turns: 1, source: "turn" }
      : { kind: "messages", label: "Tool results & retries", chars: residual, turns: replies, source: "residual" }]
    : [];
  const rows: LedgerRow[] = [...scaled, ...system].sort((a, b) => b.chars - a.chars);
  const total = rows.reduce((sum, row) => sum + row.chars, 0);
  const capacity = contextTokens * CHARS_PER_TOKEN;
  const free = Math.max(0, capacity - total);
  const tokens = messages.reduce((sum, message) => sum + (message.generation?.outputTokens ?? 0), 0)
    + liveTurns.reduce((sum, agent) => sum + agent.outputTokens, 0);
  return {
    rows,
    total,
    capacity,
    free,
    whole: capacity || total,
    cells: [...rows.map((row) => ({ key: usageKey(row), chars: row.chars })), { key: "free", chars: free }].filter((cell) => cell.chars > 0),
    kinds: new Map<string, string>([...rows.map((row) => [usageKey(row), row.kind] as const), ["free", "free"]]),
    messages: messages.length + liveTurns.length * 2,
    replies: replies + liveTurns.length,
    attachments: uses.length,
    calls: landedCalls + liveCalls,
    tokens,
    elapsed: messages.reduce((sum, message) => sum + (message.generation?.durationMilliseconds ?? 0), 0) + liveTurns.reduce((sum, agent) => sum + agent.generationMs, 0),
    curve: rateByContext(messages.flatMap((message) => message.generation ? [message.generation] : [])),
    largest: rows.reduce<LedgerRow | undefined>((top, row) => !top || row.chars > top.chars ? row : top, undefined),
    carriedTokens: Math.round(total / CHARS_PER_TOKEN),
    experiments,
  };
}

const TAGS_KEY = "emma.threadTags.v1";

export interface ThreadTag { tag: string; auto: boolean }

export function threadTags(): Record<string, ThreadTag> {
  try {
    const stored = JSON.parse(localStorage.getItem(TAGS_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(stored)
      .map(([id, value]) => [id, value as Partial<ThreadTag>])
      .filter(([, value]) => typeof (value as Partial<ThreadTag>).tag === "string" && (value as Partial<ThreadTag>).tag)
      .map(([id, value]) => [id, { tag: (value as ThreadTag).tag, auto: (value as Partial<ThreadTag>).auto === true }])) as Record<string, ThreadTag>;
  } catch { return {}; }
}

export function setThreadTag(threadId: string, tag: string, auto = false): void {
  const tags = threadTags();
  if (auto && tags[threadId] && !tags[threadId].auto) return;
  const clean = tagName(tag);
  if (clean) tags[threadId] = { tag: clean, auto };
  else delete tags[threadId];
  localStorage.setItem(TAGS_KEY, JSON.stringify(tags));
  dispatchEvent(new Event("emma-thread-tags-changed"));
}

const PINS_KEY = "emma.threadPins.v1";

function storedThreadIds(key: string): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

export function pinnedThreads(): string[] {
  return storedThreadIds(PINS_KEY);
}

export function setThreadPinned(threadId: string, pinned: boolean): void {
  const kept = pinnedThreads().filter((id) => id !== threadId);
  localStorage.setItem(PINS_KEY, JSON.stringify(pinned ? [threadId, ...kept] : kept));
  dispatchEvent(new Event("emma-thread-pins-changed"));
}

const UNREAD_KEY = "emma.threadUnread.v1";

export function unreadThreads(): string[] {
  return storedThreadIds(UNREAD_KEY);
}

export function setThreadUnread(threadId: string, unread: boolean): void {
  const kept = unreadThreads().filter((id) => id !== threadId);
  localStorage.setItem(UNREAD_KEY, JSON.stringify(unread ? [threadId, ...kept] : kept));
  dispatchEvent(new Event("emma-thread-unread-changed"));
}

const SEEN_RUNS_KEY = "emma.threadSeenRuns.v1";

export function seenRuns(): Record<string, string> {
  try {
    const stored = JSON.parse(localStorage.getItem(SEEN_RUNS_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(stored).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  } catch { return {}; }
}

export function setSeenRuns(stamps: Record<string, string>): void {
  localStorage.setItem(SEEN_RUNS_KEY, JSON.stringify(stamps));
}

export function handTags(): string[] {
  const counts = new Map<string, number>();
  for (const entry of Object.values(threadTags())) if (!entry.auto) counts.set(entry.tag, (counts.get(entry.tag) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
}

export function fileCommands(folders: FolderGrant[], folderIds: string[], files: Record<string, FolderFile[]>, name = pathName): SlashCommand[] {
  return folderIds.flatMap((folderId) => {
    const folder = folders.find((item) => item.id === folderId);
    return folder ? (files[folderId] ?? []).map((file) => ({ id: pickKey({ kind: "file", folderId, path: file.path }), name: name(file.path), kind: "file" as const, detail: `${folder.name}/${file.path}`, pick: { kind: "file" as const, folderId, path: file.path } })) : [];
  });
}

export function toolCommands(disabled: readonly string[] = []): SlashCommand[] {
  return TOOL_CATALOG
    .filter((tool) => !disabled.includes(tool.name))
    .map((tool) => ({ id: `tool:${tool.name}`, name: tool.name, kind: "tool" as const, detail: tool.blurb }));
}

export function artifactCommands(artifacts: ArtifactMeta[]): SlashCommand[] {
  return artifacts.map((artifact) => ({
    id: pickKey({ kind: "artifact", id: artifact.id, title: artifact.title }),
    name: pathName(artifact.title),
    kind: "artifact" as const,
    detail: `${ARTIFACT_LABELS[artifact.kind]} · artifact`,
    pick: { kind: "artifact" as const, id: artifact.id, title: artifact.title },
  }));
}

export function noteCommands(notes: readonly KeptNote[] = []): SlashCommand[] {
  return notes.map((note) => ({
    id: pickKey({ kind: "note", path: note.path, title: note.title }),
    name: pathName(note.title),
    kind: "page" as const,
    detail: [keepKindLabel(note.kind), ...note.tags].join(" · "),
    pick: { kind: "note" as const, path: note.path, title: note.title },
  }));
}

export function atCommands(artifacts: ArtifactMeta[], notes: readonly KeptNote[] | undefined, folders: FolderGrant[], folderIds: string[], files: Record<string, FolderFile[]>): SlashCommand[] {
  return [...artifactCommands(artifacts), ...noteCommands(notes), ...fileCommands(folders, folderIds, files)];
}

export function contextCommands(folders: FolderGrant[], folderIds: string[], files: Record<string, FolderFile[]>): SlashCommand[] {
  return fileCommands(folders, folderIds, files, slashName);
}

export function pickLabel(pick: ContextPick, folders: FolderGrant[]): string {
  if (pick.kind === "file") return `${folders.find((item) => item.id === pick.folderId)?.name ?? "folder"}/${pick.path}`;
  if (pick.kind === "attachment") return pick.name;
  if (pick.kind === "artifact") return pick.title;
  if (pick.kind === "component") return pick.title;
  if (pick.kind === "note") return pick.title;
  if (pick.kind === "terminal") return `${pick.lines} ${plural(pick.lines, "line")} of output`;
  if (pick.kind === "diff") return `${pick.path} · ${pick.lines} ${plural(pick.lines, "line")}`;
  return `${pick.title} · ${pick.label}`;
}

export async function buildAttachedContext(folders: FolderGrant[], folderIds: string[], picks: ContextPick[], files: Record<string, FolderFile[]>): Promise<{ text: string; uses: Omit<ContextUse, "turns">[]; images: string[] }> {
  const sections: { heading: string; body: string; label: string }[] = [];
  const images: string[] = [];
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
        sections.push({ heading: `File ${folder?.name ?? ""}/${file.path}`, body: file.missing ? "That file is no longer on disk." : file.text, label });
      } catch (reason) {
        sections.push({ heading: `File ${label}`, body: `Could not be read: ${reasonText(reason)}`, label });
      }
      continue;
    }
    if (pick.kind === "attachment") {
      try {
        const file = await window.emma.readAttachment(pick.id);
        if (file.text === undefined) images.push(pick.id);
        sections.push(file.text === undefined
          ? { heading: `Image ${file.name}`, body: "The user attached this image to this message.", label: pick.name }
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
    if (pick.kind === "terminal") {
      const label = pickLabel(pick, folders);
      sections.push({ heading: `Terminal selection (${label})`, body: pick.text, label });
      continue;
    }
    if (pick.kind === "diff") {
      sections.push({ heading: `Uncommitted diff of ${pick.path}, the part the user highlighted`, body: pick.text, label: pickLabel(pick, folders) });
      continue;
    }
    if (pick.kind === "component") {
      try {
        const built = await window.emma.readComponent(pick.id);
        sections.push({ heading: `The component "${built.title}" (${built.id}), which you built into ${COMPONENT_ZONE_LABEL}${built.expands ? " and which opens full screen" : ""}${built.variables?.length ? `, reading ${built.variables.join(", ")}` : ""}`, body: built.code, label: pick.title });
      } catch (reason) {
        sections.push({ heading: `Component ${pick.title}`, body: `Could not be read: ${reasonText(reason)}`, label: pick.title });
      }
      continue;
    }
    if (pick.kind === "visual") {
      const label = pickLabel(pick, folders);
      sections.push({ heading: `Part of the picture "${pick.title}", the element ${pick.label}`, body: pick.html, label });
      continue;
    }
    try {
      const text = await window.emma.readNote(pick.path);
      sections.push({ heading: `Note ${pick.title}`, body: text, label: pick.title });
    } catch (reason) {
      sections.push({ heading: `Note ${pick.title}`, body: `Could not be read: ${reasonText(reason)}`, label: pick.title });
    }
  }
  return {
    text: contextBlock(sections),
    uses: sections.map((section) => ({ kind: "messages" as const, label: section.label, chars: section.heading.length + section.body.length })),
    images,
  };
}

/* Anything that can be picked outside the composer — a diff excerpt, a bit of a
   picture — reaches it on this event rather than through a prop threaded down
   every panel that draws one. */
export const PICK_CONTEXT_EVENT = "emma:pick-context";
export const pickIntoComposer = (pick: ContextPick) => dispatchEvent(new CustomEvent(PICK_CONTEXT_EVENT, { detail: pick }));

const MODEL_SWITCH_KEY = "emma.threadModelSwitches.v1";

/** A model the user picked mid-thread, marked at the turn it takes effect from. */
export interface ModelSwitch {
  at: number;
  label: string;
  brand: string;
  after?: string;
}

function allModelSwitches(): Record<string, ModelSwitch[]> {
  try {
    const stored = JSON.parse(localStorage.getItem(MODEL_SWITCH_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(stored)
      .map(([id, value]) => [id, Array.isArray(value)
        ? (value as ModelSwitch[]).filter((mark) => Number.isInteger(mark?.at) && mark.at >= 0 && typeof mark.label === "string")
        : []])
      .filter(([, marks]) => (marks as ModelSwitch[]).length)) as Record<string, ModelSwitch[]>;
  } catch { return {}; }
}

export function modelSwitches(threadId: string): ModelSwitch[] {
  return allModelSwitches()[threadId] ?? [];
}

/** Switching twice before sending leaves one mark: the model that actually answers. */
export function recordModelSwitch(threadId: string, mark: ModelSwitch): void {
  const kept = modelSwitches(threadId).filter((item) => item.at !== mark.at);
  localStorage.setItem(MODEL_SWITCH_KEY, JSON.stringify({ ...allModelSwitches(), [threadId]: [...kept, mark] }));
}
