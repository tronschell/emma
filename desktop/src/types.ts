import type { BackgroundTask, FileChange, LiveAgent, PermissionAsk, ThreadStep } from "../shared/agents";
import type { Artifact, ArtifactMeta } from "../shared/artifacts";
import type { CliRun } from "../shared/cli";
import type { EditorApp, FolderFile, FolderGrant } from "../shared/folders";
import type { GitSnapshot } from "../shared/git";
import type { Improvements } from "../shared/improvement";
import type { PermissionMode } from "../shared/permissions";
import type { Plan } from "../shared/plan";
import type { FrontApplication } from "../shared/screen-context";
import type { LinkedPermission, SetupStatus } from "../shared/setup";
import type { TraceSpan } from "../shared/trace";
import type { VoiceStatus } from "../shared/voice";
import type { HarnessExperiments, TaggerSettings, ToolSettings, UserSettings, VerifierSettings } from "../shared/settings";

/** One file attached to a message, as main hands it back. `path` is what the vision tool names. */
export type HeldAttachment = { id: string; name: string; path: string; thumbnail?: string };

/** What main needs of the user's settings to reach the two local voice servers. */
export type VoiceSettings = Pick<UserSettings, "transcriptionEngine" | "transcriptionEndpoint" | "transcriptionModel" | "voiceCleanup" | "voiceCleanupEndpoint" | "voiceCleanupModel">;

export type ThreadRole = "user" | "assistant" | "system";

export interface Message {
  role: ThreadRole;
  content: string;
  timestamp: string;
  /** `model` is what the picker was on when this turn ran, empty on a thread written before it was recorded. */
  generation?: { outputTokens: number; durationMilliseconds: number; inputTokens: number; model: string } | null;
}

export interface Thread {
  id: string;
  title: string;
  /** The thread that owns this one: a sub thread's parent, or a subagent's spawner. */
  parentThreadId?: string | null;
  /** `subagent` is one `task` call's transcript, and stays out of the project list. */
  kind?: "main" | "subagent";
  /** Set when a scheduled job's due run opened this thread; it is listed under Scheduled tasks. */
  scheduledJobId?: string | null;
  knowledgeBaseId: string;
  sourceKnowledgeBaseIds: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  messages: Message[];
}

export interface KnowledgeBase {
  id: string;
  name: string;
  createdAt: string;
  categories: string[];
}

export interface ArtifactBlock {
  id: string;
  type: string;
  version: number;
  source: { sourceThreadId?: string; sourceUrl?: string };
  payload: unknown;
  fallback: string;
}

export interface PageVersion {
  name: string;
  savedAt: string;
  title: string;
}

export interface KnowledgePage {
  id: string;
  knowledgeBaseId: string;
  title: string;
  category: string;
  context: { text: string; sourceApplication?: string; sourceUrl?: string };
  analysis: { summary: string; body: string };
  sources: { title: string; url: string }[];
  addedAt: string;
  analyzedAt: string;
  telemetry: { model: string; inputTokens: number; outputTokens: number; subagentCount: number };
  sourceThreadId?: string;
  conversationThreadId?: string;
  artifacts?: ArtifactBlock[];
}

export interface ScheduledJob {
  id: string;
  title: string;
  /** Cron, `manual`, `after <job-id>`, or `on <event>`. Only cron has a next run. */
  schedule: string;
  prompt: string;
  /** The node graph as JSON. Empty means one agent step on `prompt`. */
  nodes: string;
  /** What the last finished run left behind, as a JSON object of variables. */
  outputs: string;
  sourceDomains: string[];
  enabled: boolean;
  createdAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastThreadId?: string;
  permissionMode: PermissionMode;
}

/** One turn of an autoresearch loop: propose a change, measure, keep or revert. */
export interface ResearchIteration {
  index: number;
  at: string;
  /** Null when the run crashed, so a crash is never plotted as a zero. */
  value: number | null;
  /** Best-so-far after this iteration — the line on the graph. */
  best: number | null;
  outcome: "keep" | "discard" | "crash";
  /** What was tried, as the annotation on the graph. */
  note: string;
  commit: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  microDollars: number;
}

export interface ResearchJob {
  id: string;
  title: string;
  projectDir: string;
  /** The metric is immutable: name, kind, direction and folder are fixed at creation. */
  metricName: string;
  metricKind: "grep" | "judge";
  /** The judge rubric; empty for a grep metric. */
  metricPrompt: string;
  direction: "lower" | "higher";
  evalCommand: string;
  /** The user's brief for the proposer, in the composer's "/" and "@" grammar. */
  prompt: string;
  proposerModel: string;
  permissionMode: PermissionMode;
  /** Each budget is checked before every iteration; `0` means unlimited. $1 = 1000000 micro-dollars. */
  maxSeconds: number;
  maxTokens: number;
  maxMicroDollars: number;
  spentSeconds: number;
  spentTokens: number;
  spentMicroDollars: number;
  status: "running" | "paused" | "finished" | "failed";
  /** Which budget stopped it, or why it failed. */
  statusNote: string;
  threadId?: string | null;
  createdAt: string;
  iterations: ResearchIteration[];
}

export interface Snapshot {
  threads: Thread[];
  knowledgeBases: KnowledgeBase[];
  pages: KnowledgePage[];
  scheduledJobs: ScheduledJob[];
  researchJobs: ResearchJob[];
  warnings: string[];
}

export type ModelModality = "image" | "file" | "audio";

export interface OpenRouterCatalog {
  selectedModel?: string;
  /** `inputModalities` lists what the model takes beyond text: "image", "file", "audio". */
  models: { id: string; name: string; contextLength: number; inputModalities: ModelModality[]; reasoningEfforts?: string[]; reasoningMandatory?: boolean; free: boolean }[];
  /** Model IDs gained and lost since the last fetch, so a reload can show what it did. */
  added?: string[];
  removed?: string[];
  fetchedAt?: string;
  /** The fetch failed and these models came from Emma's on-disk cache. */
  stale?: boolean;
  error?: string;
}

export interface AgentImportSource {
  id: string;
  label: string;
  mark: string;
  skills: number;
  mcpConfigs: number;
  locations: string[];
}

/** A third-party CLI from main's connection catalog; `binary` is "" when it is not installed. */
export interface Connection {
  id: string;
  label: string;
  detail: string;
  formula: string;
  binary: string;
}

export interface ImportedSkill {
  id: string;
  source: string;
  name: string;
  threadId?: string;
  /** Characters of SKILL.md. Only on a selected skill; search results carry metadata only. */
  chars?: number;
}

/** One row in Settings → Tools: `id` is what the disabled list stores, `source` the sub-line. */
export interface ToolTarget {
  id: string;
  name: string;
  source: string;
}

export interface ImportedMcpServer {
  id: string;
  source: string;
  name: string;
  command: string;
  args: string[];
  argCount: number;
  environmentKeys: string[];
}

export interface ImportedMcpPermissionReview extends ImportedMcpServer {
  token: string;
  warning: string;
  capabilities: string[];
}

export interface ImportedMcpTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface ImportedMcpCallResult {
  content?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

/** A stored provider key, seen from the renderer: the env name and a masked preview, never the key. */
export interface CredentialSummary {
  env: string;
  masked: string;
}

/** The front browser page, read for capture: its text plus its favicon and lead pictures. */
export interface PageClip {
  application: string;
  url: string;
  title: string;
  text: string;
  images: string[];
}

export interface UiPlugin {
  id: string;
  name: string;
  version: string;
  css: string;
}

/** Quick Ask has three shapes: around the camera housing, the status chip, and the island hung off that chip. */
export type OverlaySurface = "notch" | "pill" | "popout";

declare global {
  interface Window {
    emma: {
      request<T>(method: string, params?: Record<string, string>): Promise<T>;
      setOverlayPreferences(value: unknown): void;
      setOverlayBusy(value: boolean): void;
      setKeybinds(value: unknown): Promise<string[]>;
      openOverlay(): void;
      setOverlayHeight(value: number): void;
      /** Where Quick Ask went: "pill" is the status chip it collapses into, "popout" the island hung off it. */
      onOverlaySurface(listener: (value: OverlaySurface) => void): () => void;
      movePill(value: { x: number; y: number }): void;
      expandPill(): void;
      dismissOverlay(): void;
      openWorkspace(settingsPage?: string): void;
      voiceStatus(settings: VoiceSettings): Promise<VoiceStatus>;
      /** Speech in, written text out. `raw` is what was heard before S1-mini cleaned it. */
      transcribe(value: { audio: ArrayBuffer; mimeType: string; settings: VoiceSettings }): Promise<{ text: string; raw: string }>;
      onOpenSettings(listener: (page: string) => void): () => void;
      sendQuickCommand(value: string): void;
      onQuickCommand(listener: (value: string) => void): () => void;
      /** The shortcut was pressed on a busy island and Settings → Notch wants a task of its own. */
      onNewQuickSession(listener: () => void): () => void;
      onNotchHover(listener: (value: boolean) => void): () => void;
      onDelta(listener: (value: { threadId: string; delta: string; thinking?: boolean }) => void): () => void;
      onStep(listener: (value: ThreadStep) => void): () => void;
      onContextExperiment(listener: (value: { threadId: string; prunedResults: number; reinjected: boolean; savedTokens: number; addedTokens: number }) => void): () => void;
      startScreenAnnotation(): Promise<void>;
      captureScreenContext(): Promise<{ id: string; image: string; source?: FrontApplication }>;
      getScreenAnnotationFrame(): Promise<{ image: string; width: number; height: number }>;
      finishScreenAnnotation(annotated: string): Promise<void>;
      cancelScreenAnnotation(): Promise<void>;
      screenAnnotationStatus(): Promise<{ id: string; image: string; source?: FrontApplication } | null>;
      onScreenContext(listener: (value: { id: string; image: string; source?: FrontApplication } | null) => void): () => void;
      clearScreenAnnotation(id: string): Promise<void>;
      /** What a request carries before the prompt: the tool schemas and the standing instructions. */
      contextParts(threadId: string): Promise<{ toolChars: number; tools: number; promptChars: number }>;
      /** Shows a file the model named in Finder. False when nothing is there. */
      revealPath(path: string): Promise<boolean>;
      /** The file behind a path, for the in-app preview. Null when nothing is there; null text when it is outside every grant. */
      previewPath(path: string): Promise<{ path: string; text: string | null } | null>;
      /** Everything on the Artifacts page, newest-updated first. Metadata only — a card reads its own content. */
      listArtifacts(): Promise<ArtifactMeta[]>;
      readArtifact(id: string): Promise<Artifact>;
      /** Create when `id` is absent, rewrite when it is present. Returns what landed on disk. */
      saveArtifact(value: { id?: string; title: string; kind: string; language?: string; content: string }): Promise<Artifact>;
      deleteArtifact(id: string): Promise<void>;
      revealArtifact(id: string): Promise<boolean>;
      /** One statement against one `app` artifact's own SQLite file, on behalf of its frame. */
      artifactSql(id: string, sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
      /** A turn, a scheduled task or the page itself wrote one: the list is stale. */
      onArtifactsChanged(listener: () => void): () => void;
      /** Every plan whole, newest first: the section draws the graph and the tasks off these. */
      listPlans(): Promise<Plan[]>;
      /** A wave started, a step finished, or a subagent ticked one of its own tasks off. */
      onPlansChanged(listener: () => void): () => void;
      setupStatus(): Promise<SetupStatus>;
      openPrivacySettings(permission: LinkedPermission): Promise<void>;
      /** Points the knowledge mirror at the default Documents folder, or one the user picks. */
      setKnowledgeDir(mode: "pick" | "default"): Promise<SetupStatus>;
      /** Deletes everything Emma stores on this Mac and restarts her empty. Never resolves — the app is gone. */
      resetData(): Promise<void>;
      listFolders(): Promise<FolderGrant[]>;
      onFolderAttached(listener: (value: { threadId: string; folderId: string }) => void): () => void;
      pickFolder(): Promise<FolderGrant[]>;
      forgetFolder(id: string): Promise<FolderGrant[]>;
      listFolderFiles(id: string): Promise<FolderFile[]>;
      /** The folder's branch and uncommitted diff, or null when it is not a repo. */
      gitStatus(id: string): Promise<GitSnapshot | null>;
      /** Code editors installed on this Mac, each with its own app icon as a data URL. */
      listEditors(): Promise<EditorApp[]>;
      openInEditor(value: { folderId: string; path: string; editorId: string }): Promise<void>;
      /** Puts the thread's folder on a worktree of its repo, or back on the main checkout. */
      setWorktree(value: { folderId: string; name: string; on: boolean }): Promise<{ folders: FolderGrant[]; folderId: string }>;
      /** Checks out a branch in the thread's folder, creating it from HEAD when asked. */
      setBranch(value: { folderId: string; branch: string; create: boolean }): Promise<void>;
      readFolderFile(value: { folderId: string; path: string }): Promise<{ path: string; text: string }>;
      /** Files attached to the next message, chosen in the native dialog. Empty when it is cancelled. */
      attachFiles(): Promise<HeldAttachment[]>;
      /** One dropped or pasted file: the renderer has its bytes and not its path, so the bytes cross. */
      attachData(value: { name: string; data: ArrayBuffer }): Promise<HeldAttachment>;
      /** What the turn carries: a text file's contents, or a picture's path for the vision tool. */
      readAttachment(id: string): Promise<HeldAttachment & { text?: string }>;
      discoverAgentImports(): Promise<AgentImportSource[]>;
      detectConnections(): Promise<Connection[]>;
      /** Ids Homebrew has a newer build for; slower than detection, so it is asked for separately. */
      outdatedConnections(): Promise<string[]>;
      setUpConnection(value: { id: string; action: "install" | "upgrade" }): Promise<{ ok: boolean; message: string }>;
      importAgentSources(ids: string[]): Promise<string[]>;
      searchImportedSkills(value: { query: string; limit?: number }): Promise<ImportedSkill[]>;
      selectImportedSkill(value: { id: string; threadId: string }): Promise<ImportedSkill>;
      importedSkillStatus(): Promise<(ImportedSkill & { threadId: string }) | null>;
      clearImportedSkill(id: string): Promise<void>;
      listImportedMcpServers(): Promise<ImportedMcpServer[]>;
      reviewImportedMcpServer(id: string): Promise<ImportedMcpPermissionReview>;
      connectImportedMcpServer(value: { serverId: string; token: string }): Promise<{ server: ImportedMcpServer; tools: number }>;
      searchMcpTools(value: { query: string; limit?: number }): Promise<ImportedMcpTool[]>;
      selectMcpTool(name: string): Promise<ImportedMcpTool>;
      callMcpTool(argsJson: string): Promise<ImportedMcpCallResult>;
      closeImportedMcpServer(): Promise<void>;
      stopComputerRun(): void;
      onComputerRunProgress(listener: (value: { step: number; action: string; actions: number }) => void): () => void;
      /** Auto mode's verifier model, as main will use it. Rejects what it will not accept. */
      setVerifier(value: VerifierSettings): Promise<VerifierSettings>;
      /** Which tools, skills and servers are on, and how the two configurable tools are set up. */
      setToolSettings(value: ToolSettings): Promise<ToolSettings>;
      /** One thread past the categorizer. Answers with one of `tags`, or "" when none of them fits. */
      tagThread(value: { tagger: TaggerSettings; text: string; tags: string[]; examples: { tag: string; text: string }[] }): Promise<{ tag: string; error?: string }>;
      /** Settings → Harness: the experimental per-step context hooks. */
      setHarnessExperiments(value: HarnessExperiments): Promise<HarnessExperiments>;
      /** The Agent page's record: what Emma kept about itself, and the change it is trialling. */
      setImprovements(value: Improvements): Promise<Improvements>;
      /** Everything switchable that is not a built-in, including the switched-off ones. */
      listToolTargets(): Promise<{ written: ToolTarget[]; skills: ImportedSkill[]; servers: ImportedMcpServer[] }>;
      onToolsChanged(listener: () => void): () => void;
      setThreadContext(value: { threadId: string; folderIds: string[]; mode: PermissionMode; model: string; subagentModel?: string; subagentEffort?: string }): Promise<PermissionMode>;
      runCommand(value: { command: string; folderId?: string }): Promise<BackgroundTask>;
      listBackground(): Promise<BackgroundTask[]>;
      readBackground(id: string): Promise<{ task: BackgroundTask; output: string } | null>;
      stopBackground(id: string): Promise<boolean>;
      onBackground(listener: () => void): () => void;
      listCliRuns(): Promise<CliRun[]>;
      readCliRun(id: string): Promise<{ run: CliRun; output: string } | null>;
      stopCliRun(id: string): Promise<boolean>;
      installedClis(): Promise<{ id: string; label: string; bin: string; path: string }[]>;
      sendCliRun(value: { id: string; prompt: string }): Promise<CliRun | null>;
      onCliRuns(listener: () => void): () => void;
      listAgents(): Promise<LiveAgent[]>;
      /** Every live turn's spans, keyed by the thread the turn is on. */
      listSpans(): Promise<Record<string, TraceSpan[]>>;
      /** The turns already recorded on this thread, newest last. */
      threadTraces(threadId: string): Promise<{ timestamp: string; text: string }[]>;
      steerAgent(value: { threadId: string; text: string }): Promise<void>;
      stopAgent(threadId?: string): void;
      answerPermission(value: { id: string; allowed: boolean }): void;
      threadChanges(threadId: string): Promise<FileChange[]>;
      revertChange(value: { folderId: string; path: string; before: string }): Promise<void>;
      onAgents(listener: (value: LiveAgent[]) => void): () => void;
      onSpans(listener: (value: Record<string, TraceSpan[]>) => void): () => void;
      onPermissionAsk(listener: (value: PermissionAsk) => void): () => void;
      setZeroRetention(value: boolean): Promise<void>;
      listCredentials(): Promise<CredentialSummary[]>;
      saveCredential(value: { env: string; secret?: string }): Promise<CredentialSummary[]>;
      fetchUrl(url: string): Promise<{ title: string; text: string }>;
      clipPage(): Promise<PageClip>;
      loadUiPlugins(): Promise<UiPlugin[]>;
      onChanged(listener: () => void): number;
      offChanged(id: number): void;
    };
  }
}
