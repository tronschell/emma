import type { Plan } from "./plan";
import type { SlashCommand } from "./slash";

export const PROTOCOL_VERSION = 1;

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
  v: 1;
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
  labelPrompt?: string;
  messages: Message[];
};

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
};

export type Folder = { id: string; path: string; name: string };

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

export type ModelEntry = {
  id: string;
  key: string;
  name: string;
  contextLength: number;
  free: boolean;
  efforts: string[];
};

export type ThreadTrace = { timestamp: string; text: string };

export type CommandMenu = { slash: SlashCommand[]; at: SlashCommand[] };

export type DesktopIdentity = { id: string; name: string; version: string; protocol: number };

export type LiveState = {
  agents: LiveAgent[];
  spans: Record<string, TraceSpan[]>;
  asks: PermissionAsk[];
  partial: Record<string, { text: string; thinking: string }>;
  desktop: DesktopIdentity;
};

export type BridgeMethods = {
  unlock: { params: { pin: string }; result: { unlocked: true } };
  snapshot: { params: Record<string, never>; result: Snapshot };
  live: { params: Record<string, never>; result: LiveState };
  threadMessages: { params: { threadId: string; before?: number; limit?: number }; result: MessagePage };
  createThread: { params: { parentThreadId?: string }; result: ThreadSummary };
  renameThread: { params: { threadId: string; title: string }; result: ThreadSummary };
  setThreadArchived: { params: { threadId: string; archived: boolean }; result: ThreadSummary };
  sendMessage: { params: { threadId: string; content: string }; result: ThreadSummary };
  stopAgent: { params: { threadId?: string }; result: { stopped: true } };
  steerAgent: { params: { threadId: string; text: string }; result: { steered: boolean } };
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
  | "notes"
  | "tools"
  | "components"
  | "cliRuns"
  | "background";

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
  "gitReady",
  "gitStatus",
  "gitFileDiff",
  "gitHistory",
  "gitMessage",
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
};
