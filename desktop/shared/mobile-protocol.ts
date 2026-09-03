import type { Plan } from "./plan";
import type { SlashCommand } from "./slash";

export const PROTOCOL_VERSION = 2;

export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const HANDSHAKE_BYTES = 16;
export const TAG_BYTES = 16;

export const LABEL_MAC_TO_PHONE = "mac->phone";
export const LABEL_PHONE_TO_MAC = "phone->mac";
export const LABEL_BRIDGE_AUTH = "emma-bridge-auth";

export const MAX_ADDR_CHARS = 200;

export const BRIDGE_PORT = 47823;

export function bridgeAddress(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed.length > MAX_ADDR_CHARS) return "";
  return /^wss?:\/\/[a-z0-9.-]+:\d{1,5}$/i.test(trimmed) ? trimmed : "";
}

export function splitAddress(addr: string): { host: string; port: number } | undefined {
  const match = /^wss?:\/\/([a-z0-9.-]+):(\d{1,5})$/i.exec(addr);
  if (!match) return undefined;
  const port = Number(match[2]);
  return port > 0 && port <= 65535 ? { host: match[1], port } : undefined;
}

export const PIN_MIN_DIGITS = 4;
export const PIN_MAX_DIGITS = 12;

export function isPin(value: unknown): value is string {
  return typeof value === "string" && new RegExp(`^\\d{${PIN_MIN_DIGITS},${PIN_MAX_DIGITS}}$`).test(value);
}

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_RPC_BYTES = 128 * 1024;
export const HEARTBEAT_MS = 30_000;
export const PAIRING_TTL_MS = 120_000;
export const MAX_ASK_MS = 600_000;

export type PairingPayload = {
  /** Tied to the constant: a bumped version that left this literal behind would not compile. */
  v: typeof PROTOCOL_VERSION;
  addr: string;
  key: string;
  name: string;
  exp: number;
};

export type ThreadRole = "user" | "assistant" | "system";
export type ThreadKind = "main" | "subagent";

export type GenerationTelemetry = {
  outputTokens: number;
  durationMilliseconds: number;
  inputTokens: number;
  cacheInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costMicroUsd?: number;
  model: string;
};

export type Message = {
  role: ThreadRole;
  content: string;
  timestamp: string;
  generation?: GenerationTelemetry;
};

export type GoalStatus = "active" | "paused" | "complete" | "blocked" | "budgetLimited" | "usageLimited";

export type Goal = {
  objective: string;
  status: GoalStatus;
  evidence: string;
  blockedReason: string;
  blockedStreak: number;
  blockedAtTurn: number;
  tokenBudget: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  turns: number;
  createdAt: string;
  updatedAt: string;
};

/** Mirrors TaskList in shared/task-list.ts; the phone does not carry that file. */
export type TaskListStatus = "pending" | "in_progress" | "completed" | "blocked";

export type TaskListTask = { id: string; title: string; status: TaskListStatus; subtasks: TaskListTask[] };

export type TaskList = { id: string; title: string; goal: string; tasks: TaskListTask[]; updatedAt: string; threadId?: string };

export type Thread = {
  id: string;
  title: string;
  parentThreadId?: string;
  kind?: ThreadKind;
  scheduledJobId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  goal?: Goal;
  /**
   * The opening prompt, so a thread the namer has not reached yet can be labelled by what it is
   * about rather than by the placeholder title. Carried on a summary because the phone is sent
   * message counts, not messages, and so has nothing else to fall back to.
   */
  labelPrompt?: string;
  messages: Message[];
};

/** Enough for a label four times over; the rest of a pasted first message is not worth the frame. */
export const MAX_LABEL_PROMPT_CHARS = 200;

export type ThreadSummary = Omit<Thread, "messages"> & { messages: number; folderIds?: string[]; messageDates?: string[]; userMessageCount?: number; displayTitle?: string; subagentBrief?: string };

export type MessagePage = { messages: Message[]; total: number; from: number };

export type Snapshot = {
  threads: ThreadSummary[];
  warnings: string[];
};

export type StepKind = "read" | "edit" | "execute" | "search" | "fetch" | "other" | "verifier";
export type StepStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export type ThreadStep = {
  threadId: string;
  toolCallId: string;
  title: string;
  kind: StepKind;
  status: StepStatus;
  input?: string;
  output?: string;
  at: number;
  edit?: { path: string; added: number; removed: number };
};

/** One file the agent rewrote. `before` is null when the tool created the file, and such a change
    cannot be reverted at all: only a file that had a previous body can be put back to one. The body
    itself is clipped and the rewritten one is not sent at all — a thread that rewrote a few large
    files is otherwise a frame the codec refuses to seal — so what is here is a preview, and a
    revert names the file and lets the Mac write the body off its own record. */
export type FileChange = {
  folderId: string;
  path: string;
  before: string | null;
  at: number;
  /** Set when `before` was clipped to fit the frame. */
  truncated?: boolean;
};

export type AgentStatus = "running" | "waiting" | "done" | "failed" | "stopped";

export type PermissionMode = "ask" | "acceptEdits" | "auto" | "full";

export type LiveAgent = {
  threadId: string;
  parentThreadId?: string;
  title: string;
  color: string;
  status: AgentStatus;
  mode: PermissionMode;
  model: string;
  activity: string;
  tool: boolean;
  startedAt: number;
  endedAt?: number;
  steps: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  generationMs: number;
  error?: string;
};

export type TraceSpan = {
  id: string;
  parentId?: string;
  name: string;
  kind: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "ok" | "failed" | "cancelled";
  input?: string;
  output?: string;
  tokens?: number;
  /** Set when `input` or `output` was clipped to fit the frame. Every open span rides one frame
      together, so a live span carries a preview of its result and the Mac keeps the whole one. */
  truncated?: boolean;
};

export type PermissionAsk = {
  id: string;
  threadId: string;
  tool: string;
  summary: string;
  detail: string;
  askedAt: number;
  expiresAt: number;
};

export type ThreadContext = {
  threadId: string;
  folderIds: string[];
  mode: PermissionMode;
  model: string;
  effort?: string;
};

export type Folder = { id: string; path: string; name: string };

/** Mirrors BackgroundTask in shared/agents.ts; the phone does not carry that file. */
export type BackgroundTask = {
  id: string;
  command: string;
  folder: string;
  status: "running" | "exited";
  /** Null while running, and for a command that never started. */
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
};

/** Mirrors CliRun in shared/cli.ts; the phone does not carry that file. */
export type CliRun = {
  id: string;
  cli: string;
  threadId: string;
  title: string;
  cwd: string;
  folder: string;
  status: "running" | "idle" | "failed";
  exitCode: number | null;
  turns: number;
  startedAt: number;
  turnStartedAt: number;
  endedAt?: number;
  unattended: boolean;
  model?: string;
};

/** Mirrors MemoryNote in main/memory.ts; the phone does not carry that file. */
export type MemoryNote = { path: string; bytes: number; updatedAt: number; text: string; truncated?: boolean };

/** Mirrors KeptNote and NoteFolder in shared/vault.ts; the phone does not carry that file. */
export type KeepKind = "screenshot" | "selection" | "page" | "note";

export type KeptNote = {
  path: string;
  relative: string;
  title: string;
  tags: readonly string[];
  savedAt: string;
  kind: KeepKind;
  folder?: string;
  excerpt?: string;
  image?: string;
  sourceUrl?: string;
  sourceApplication?: string;
};

export type NoteFolder = { name: string; changedAt: string };

export type ArtifactKind = "markdown" | "code" | "html" | "app" | "svg" | "mermaid" | "react";

export type ArtifactMeta = {
  id: string;
  title: string;
  kind: ArtifactKind;
  language: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  surface?: string;
  sourceThreadId?: string;
};

export type ArtifactBody = ArtifactMeta & { content: string; files: string[] };

export type GitFileEntry = { path: string; index: string; work: string; from?: string };

export type GitSnapshot = {
  branch: string;
  head: string;
  upstream: string;
  ahead: number;
  behind: number;
  worktree: boolean;
  branches: string[];
  remotes: string[];
  files: GitFileEntry[];
  diff: string;
  truncated: boolean;
};

export type GitCommit = {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  when: number;
  refs: string[];
};

export type GitHistory = { commits: GitCommit[]; more: boolean };
export type GitReady = "ready" | "no-git" | "no-repo";
export type GitSyncResult = { ok: boolean; output: string; ahead: number; behind: number };

export type ModelSource = "openrouter" | "provider" | "router";

export type ModelEntry = {
  id: string;
  key: string;
  name: string;
  contextLength: number;
  free: boolean;
  efforts: string[];
  /** Absent means openrouter, so an older Mac still reads as a catalogue listing. */
  source?: ModelSource;
  /** What a million tokens costs, in micro-dollars ($1 = 1_000_000). 0 is free, or unpublished. */
  promptMicroUsdPerMtok?: number;
  completionMicroUsdPerMtok?: number;
  inputModalities?: string[];
  reasoningMandatory?: boolean;
};

/** Mirrors KeyBalance in shared/settings.ts; the phone does not carry that file. */
export type KeyBalance = { keyed: boolean; freeTier: boolean; remaining: number | null; usage: number; error: string; currency?: string };

export type KeyStatus = {
  env: string;
  /** "" when this Mac holds no key under that name. Never the secret itself. */
  masked: string;
  balance: KeyBalance | null;
  zeroRetention: boolean;
  selectedModel: string;
};

/** A key the Mac could hold, masked. A slot with an empty mask is one nothing is saved under yet. */
export type CredentialSlot = { env: string; masked: string; label: string; detail: string; hint: string };

export type MacSettings = {
  defaultPermissionMode: PermissionMode;
  selectedModel: string;
  thinkingLevel: string;
  review: { enabled: boolean; model: string };
};

export type ToolCatalogEntry = { name: string; label: string; blurb: string; group: string; gate: string };
export type SkillEntry = { id: string; name: string; source: string };
export type SkillBody = SkillEntry & { instructions: string };
/** `type` and `url` are set for a server the Mac reaches over the network rather than by running
    a command; `url` is the endpoint's origin only, because a hosted MCP token rides in the rest
    of the address as often as in a header. `command` holds that same origin so a row still names
    something, which is why a screen has to read `url` to tell the two kinds apart. */
export type McpServerEntry = { id: string; source: string; name: string; command: string; args: string[]; argCount: number; environmentKeys: string[]; type?: "http" | "sse"; url?: string };
/** An agent whose skills and MCP config sit in its own default place in the home folder, as the
    Mac's scan found it. `registered` is whether Emma already reads that source: the manifest is
    replaced rather than added to, so a phone that flips one switch sends back every source it
    wants kept, and a source it leaves out is one it is deregistering. */
export type ImportSourceEntry = { id: string; label: string; mark: string; skills: number; mcpConfigs: number; locations: string[]; registered: boolean };

/** Mirrors PluginHookState in shared/plugins.ts; the phone does not carry that file. The command
    rides whole rather than as a name, because it is the whole of what a hook is: a shell line the
    Mac runs on every turn its event fires. `runs` is hookRuns(event) resolved on the Mac — Emma
    only ever reaches four of the eleven declared moments, and a hook shown as merely untrusted
    when nothing could run it is an alarm about nothing. The hash is not here: trust is stored and
    cleared per plugin, every hook at once, so there is nothing a phone could do with one. */
export type PluginHookEntry = { event: string; command: string; trusted: boolean; runs: boolean };

/** One installed plugin, as the phone audits it. `skills` and `servers` say whether the plugin
    carries a skills folder and an MCP config at all — not how many are in them, which is a number
    the Mac holds nowhere: each is one root, and what it enumerates to already arrives as its own
    switched row under listToolTargets, stamped `plugin:<id>` as its source. Marketplaces, the
    catalogue and its screenshots are absent on purpose: nothing on the phone browses or installs,
    and an untrusted hook never runs, so reviewing the hooks is the whole of the job. */
export type PluginEntry = {
  id: string;
  displayName: string;
  marketplace: string;
  version: string;
  skills: boolean;
  servers: boolean;
  hooks: PluginHookEntry[];
};

export type ToolSwitches = { tools: string[]; skills: string[]; servers: string[] };

export type ToolTargets = {
  catalog: ToolCatalogEntry[];
  written: { id: string; name: string; source: string }[];
  skills: PhoneList<SkillEntry>;
  servers: PhoneList<McpServerEntry>;
  disabled: ToolSwitches;
};

/**
 * Mirrors the scheduled task main.ts stores, without its node graph and its last run's outputs:
 * the phone reads a task, it does not edit or replay one, and either field is unbounded enough
 * that a Mac full of tasks would not fit in a frame. `prompt` and `title` are clipped for the
 * same reason, and `truncated` says so.
 */
export type ScheduledJob = {
  id: string;
  title: string;
  schedule: string;
  prompt: string;
  sourceDomains: string[];
  enabled: boolean;
  permissionMode: string;
  model: string;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  /** Set when `prompt` or `title` was clipped to fit the frame. */
  truncated?: boolean;
};

/** One finished turn's spans. `truncated` says the Mac holds more of this thread's record than
    was sent — this turn's own text was clipped, or older turns were dropped to fit the frame —
    so a timeline drawn from these can say so instead of showing a short run as a whole one. */
export type ThreadTrace = { timestamp: string; text: string; truncated?: boolean };

export type CommandMenu = { slash: SlashCommand[]; at: SlashCommand[] };

export type DesktopIdentity = { id: string; name: string; version: string; protocol: number };

export type LiveState = {
  agents: LiveAgent[];
  spans: Record<string, TraceSpan[]>;
  asks: PermissionAsk[];
  partial: Record<string, { text: string; thinking: string }>;
  desktop: DesktopIdentity;
};

/** A list the Mac clipped to fit one frame. `capped` says rows were dropped, so a screen that
    filters or searches these can say the Mac holds more instead of answering for a list it does
    not have — a partial list drawn as a whole one is a confident wrong answer. */
export type PhoneList<T> = { rows: T[]; capped: boolean };

export type BridgeMethods = {
  unlock: { params: { pin: string }; result: { unlocked: true } };
  snapshot: { params: Record<string, never>; result: Snapshot };
  live: { params: Record<string, never>; result: LiveState };
  threadMessages: { params: { threadId: string; before?: number; limit?: number }; result: MessagePage };
  createThread: { params: { parentThreadId?: string }; result: ThreadSummary };
  renameThread: { params: { threadId: string; title: string }; result: ThreadSummary };
  setThreadArchived: { params: { threadId: string; archived: boolean }; result: ThreadSummary };
  sendMessage: { params: { threadId: string; content: string; attachedContext?: string; attachedImages?: { name: string; base64: string }[]; clientId?: string }; result: ThreadSummary };
  stopAgent: { params: { threadId?: string }; result: { stopped: true } };
  steerAgent: { params: { threadId: string; text: string; clientId?: string }; result: { steered: boolean } };
  answerPermission: { params: { id: string; allowed: boolean }; result: { answered: true } };
  getThreadContext: { params: { threadId: string }; result: ThreadContext };
  setThreadContext: {
    params: { threadId: string; folderIds: string[]; mode: PermissionMode; model: string };
    result: ThreadContext;
  };
  threadTraces: { params: { threadId: string }; result: ThreadTrace[] };
  listModels: { params: { force?: boolean }; result: ModelEntry[] };
  setThreadModel: { params: { threadId: string; modelId: string; effort?: string }; result: { set: true } };
  listFolders: { params: Record<string, never>; result: Folder[] };
  listCommands: { params: { threadId?: string }; result: CommandMenu };
  listPlans: { params: Record<string, never>; result: Plan[] };
  listArtifacts: { params: Record<string, never>; result: ArtifactMeta[] };
  readArtifact: { params: { id: string }; result: ArtifactBody };
  deleteArtifact: { params: { id: string }; result: { deleted: true } };
  readBlob: { params: { id: string; file?: string }; result: { mime: string; base64: string } };
  readImage: { params: { path: string }; result: { mime: "image/jpeg"; base64: string } };
  readVisual: { params: { id: string }; result: { title: string; html: string } };
  keepVisual: { params: { id: string }; result: ArtifactMeta };
  gitReady: { params: { folderId: string }; result: GitReady };
  gitStatus: { params: { folderId: string; diff?: boolean }; result: GitSnapshot | null };
  gitFileDiff: { params: { folderId: string; path: string }; result: { diff: string } };
  gitHistory: { params: { folderId: string; skip?: number; limit?: number }; result: GitHistory };
  gitStage: { params: { folderId: string; paths: string[] }; result: { staged: true } };
  gitUnstage: { params: { folderId: string; paths: string[] }; result: { unstaged: true } };
  gitCommit: {
    params: { folderId: string; message: string; paths: string[]; amend?: boolean };
    result: { hash: string };
  };
  gitDiscard: { params: { folderId: string; paths: string[] }; result: { discarded: true } };
  gitMessage: { params: { folderId: string }; result: { message: string } };
  gitPush: { params: { folderId: string; setUpstream?: boolean }; result: GitSyncResult };
  gitPull: { params: { folderId: string; rebase?: boolean }; result: GitSyncResult };
  setBranch: {
    params: { folderId: string; branch: string; create: boolean; from?: string };
    result: { branch: string };
  };
  keyStatus: { params: Record<string, never>; result: KeyStatus };
  listCredentials: { params: Record<string, never>; result: CredentialSlot[] };
  saveCredential: { params: { env: string; secret?: string }; result: CredentialSlot[] };
  setZeroRetention: { params: { on: boolean }; result: { zeroRetention: boolean } };
  getSettings: { params: Record<string, never>; result: MacSettings };
  listToolTargets: { params: Record<string, never>; result: ToolTargets };
  setToolSettings: {
    params: { disabledTools?: string[]; disabledSkills?: string[]; disabledServers?: string[] };
    result: ToolSwitches;
  };
  installMcpServer: {
    params: { name: string; command: string; args: string[]; env: Record<string, string> };
    result: { id: string };
  };
  listPlugins: { params: Record<string, never>; result: PhoneList<PluginEntry> };
  /** Every hook the plugin declares, trusted or none of them — the Mac stores trust per plugin id
      and rewrites the whole hash set, so there is no per-hook setter to offer. The answer is the
      list the Mac ended up holding. */
  trustPluginHooks: { params: { id: string; trusted: boolean }; result: PhoneList<PluginEntry> };
  listImportSources: { params: Record<string, never>; result: ImportSourceEntry[] };
  /** The ids to read from now on, whole. The result is what the Mac ended up registered to, which
      drops any source whose files have gone since the scan. */
  setImportSources: { params: { ids: string[] }; result: string[] };
  readSkill: { params: { id: string }; result: SkillBody };
  writeSkill: { params: { name: string; instructions: string }; result: SkillEntry };
  setGoal: { params: { threadId: string; objective: string; tokenBudget?: number }; result: ThreadSummary };
  updateGoal: {
    params: { threadId: string; status?: GoalStatus; evidence?: string; reason?: string; extraTokens?: number };
    result: ThreadSummary;
  };
  clearGoal: { params: { threadId: string }; result: ThreadSummary };
  /** One thread's lists, plus the ones the Mac never stamped with a thread. Without a threadId
      every list on the Mac rides to the phone to render one thread's rail. */
  listTaskLists: { params: { threadId?: string }; result: PhoneList<TaskList> };
  threadChanges: { params: { threadId: string }; result: PhoneList<FileChange> };
  revertChange: { params: { folderId: string; path: string }; result: { reverted: true } };
  listBackground: { params: Record<string, never>; result: BackgroundTask[] };
  readBackground: { params: { id: string }; result: { task: BackgroundTask; output: string } | null };
  /** False when the task had already exited, so the phone can leave the row alone. */
  stopBackground: { params: { id: string }; result: { stopped: boolean } };
  listMemories: { params: Record<string, never>; result: PhoneList<MemoryNote> };
  deleteMemory: { params: { path: string }; result: PhoneList<MemoryNote> };
  /** A row carries only the first MAX_PHONE_TEXT_CHARS of a memory; this is the rest of it. */
  readMemory: { params: { path: string }; result: { text: string; truncated: boolean } };
  listNotes: { params: Record<string, never>; result: PhoneList<KeptNote> };
  readNote: { params: { path: string }; result: { text: string; truncated: boolean } };
  keep: {
    params: { kind: KeepKind; title?: string; text?: string; sourceUrl?: string; sourceApplication?: string; image?: string };
    result: KeptNote;
  };
  listNoteFolders: { params: Record<string, never>; result: NoteFolder[] };
  addFolder: { params: { path: string }; result: Folder[] };
  forgetFolder: { params: { id: string }; result: Folder[] };
  listCliRuns: { params: Record<string, never>; result: CliRun[] };
  readCliRun: { params: { id: string }; result: { run: CliRun; output: string; truncated: boolean } | null };
  stopCliRun: { params: { id: string }; result: { stopped: boolean } };
  sendCliRun: { params: { id: string; prompt: string }; result: CliRun | null };
  /** What this Mac found in that CLI's installed binary, not the chat catalogue: a CLI resumes on
      the ids its own harness knows, and `setCliRunModel` only takes one of these back. */
  listCliModels: { params: { cli: string }; result: PhoneList<string> };
  setCliRunModel: { params: { id: string; model: string }; result: CliRun };
  listScheduledJobs: { params: Record<string, never>; result: PhoneList<ScheduledJob> };
  saveScheduledJob: {
    params: { jobId?: string; title: string; schedule: string; prompt: string; nodes?: string; sourceDomains: string; permissionMode: string; model?: string };
    result: PhoneList<ScheduledJob>;
  };
  deleteScheduledJob: { params: { jobId: string }; result: PhoneList<ScheduledJob> };
  runScheduledJob: { params: { jobId: string }; result: { started: true } };
  setScheduledJobEnabled: { params: { jobId: string; enabled: boolean }; result: PhoneList<ScheduledJob> };
  artifactSql: { params: { id: string; sql: string; params?: (string | number | boolean | null)[] }; result: Record<string, unknown>[] };
};

export type BridgeMethod = keyof BridgeMethods;

export type BridgeRequest<M extends BridgeMethod = BridgeMethod> = {
  k: "req";
  id: string;
  method: M;
  params: BridgeMethods[M]["params"];
};

export type BridgeResponse<M extends BridgeMethod = BridgeMethod> =
  | { k: "res"; id: string; ok: true; result: BridgeMethods[M]["result"] }
  | { k: "res"; id: string; ok: false; error: string };

export type InvalidateTarget =
  | "snapshot"
  | "artifacts"
  | "folders"
  | "plans"
  | "taskLists"
  | "notes"
  | "tools"
  | "components"
  | "cliRuns"
  | "background"
  | "scheduledJobs";

export type BridgeEvent = { k: "evt" } & (
  | { t: "live"; state: LiveState }
  | { t: "delta"; threadId: string; delta: string; thinking?: boolean }
  | { t: "step"; step: ThreadStep }
  | { t: "agents"; agents: LiveAgent[] }
  | { t: "spans"; spans: Record<string, TraceSpan[]> }
  | { t: "invalidate"; what: InvalidateTarget }
  | { t: "permission-ask"; ask: PermissionAsk }
  | { t: "permission-resolved"; id: string; allowed: boolean }
  | {
      t: "context-experiment";
      threadId: string;
      prunedResults: number;
      reinjected: boolean;
      savedTokens: number;
      addedTokens: number;
    }
  | {
      t: "context-breakdown";
      threadId: string;
      systemPromptBytes: number;
      systemToolsBytes: number;
      mcpToolsBytes: number;
      skillsBytes: number;
      memoryBytes: number;
    }
  | { t: "folder-attached"; threadId: string; folderId: string }
  | { t: "bye"; reason: "revoked" | "shutdown" }
);

export type BridgeFrame = BridgeRequest | BridgeResponse | BridgeEvent;

export type SealedEnvelope = { n: number; m: BridgeFrame };

export const READ_ONLY_METHODS: readonly BridgeMethod[] = [
  "snapshot",
  "live",
  "threadMessages",
  "getThreadContext",
  "threadTraces",
  "listModels",
  "listFolders",
  "listCommands",
  "listPlans",
  "listArtifacts",
  "readArtifact",
  "readBlob",
  "readImage",
  "readVisual",
  "gitReady",
  "gitStatus",
  "gitFileDiff",
  "gitHistory",
  "gitMessage",
  "keyStatus",
  "listCredentials",
  "getSettings",
  "listToolTargets",
  "listPlugins",
  "listImportSources",
  "readSkill",
  "listTaskLists",
  "threadChanges",
  "listBackground",
  "readBackground",
  "listMemories",
  "readMemory",
  "listNotes",
  "readNote",
  "listNoteFolders",
  "listCliRuns",
  "readCliRun",
  "listCliModels",
  "listScheduledJobs",
];

export function isBridgeMethod(value: unknown): value is BridgeMethod {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BRIDGE_METHOD_SET, value);
}

const BRIDGE_METHOD_SET: Record<BridgeMethod, true> = {
  unlock: true,
  snapshot: true,
  live: true,
  threadMessages: true,
  createThread: true,
  renameThread: true,
  setThreadArchived: true,
  sendMessage: true,
  stopAgent: true,
  steerAgent: true,
  answerPermission: true,
  getThreadContext: true,
  setThreadContext: true,
  threadTraces: true,
  listModels: true,
  setThreadModel: true,
  listFolders: true,
  listCommands: true,
  listPlans: true,
  listArtifacts: true,
  readArtifact: true,
  deleteArtifact: true,
  readBlob: true,
  readImage: true,
  readVisual: true,
  keepVisual: true,
  gitReady: true,
  gitStatus: true,
  gitFileDiff: true,
  gitHistory: true,
  gitStage: true,
  gitUnstage: true,
  gitCommit: true,
  gitDiscard: true,
  gitMessage: true,
  gitPush: true,
  gitPull: true,
  setBranch: true,
  keyStatus: true,
  listCredentials: true,
  saveCredential: true,
  setZeroRetention: true,
  getSettings: true,
  listToolTargets: true,
  setToolSettings: true,
  installMcpServer: true,
  listPlugins: true,
  trustPluginHooks: true,
  listImportSources: true,
  setImportSources: true,
  readSkill: true,
  writeSkill: true,
  setGoal: true,
  updateGoal: true,
  clearGoal: true,
  listTaskLists: true,
  threadChanges: true,
  revertChange: true,
  listBackground: true,
  readBackground: true,
  stopBackground: true,
  listMemories: true,
  readMemory: true,
  deleteMemory: true,
  listNotes: true,
  readNote: true,
  keep: true,
  listNoteFolders: true,
  addFolder: true,
  forgetFolder: true,
  listCliRuns: true,
  readCliRun: true,
  stopCliRun: true,
  sendCliRun: true,
  listCliModels: true,
  setCliRunModel: true,
  listScheduledJobs: true,
  saveScheduledJob: true,
  deleteScheduledJob: true,
  runScheduledJob: true,
  setScheduledJobEnabled: true,
  artifactSql: true,
};
