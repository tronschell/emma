import type { BackgroundTask, FileChange, LiveAgent, PermissionAsk, ThreadStep } from "../shared/agents";
import type { Artifact, ArtifactMeta } from "../shared/artifacts";
import type { CliRun } from "../shared/cli";
import type { EditorApp, FolderFile, FolderGrant } from "../shared/folders";
import type { GitSnapshot } from "../shared/git";
import type { Visual } from "../shared/visualize";
import type { Improvements } from "../shared/improvement";
import type { PermissionMode } from "../shared/permissions";
import type { Plan } from "../shared/plan";
import type { PluginCatalog, PluginDetail } from "../shared/plugins";
import type { FrontApplication } from "../shared/screen-context";
import type { LinkedPermission, SetupStatus } from "../shared/setup";
import type { TerminalTab } from "../shared/terminal";
import type { TraceSpan } from "../shared/trace";
import type { VoiceStatus } from "../shared/voice";
import type { HarnessExperiments, ToolSettings, UserSettings, VerifierSettings } from "../shared/settings";
import type { KeepRequest, KeptNote, VaultChoice } from "../shared/vault";

export type HeldAttachment = { id: string; name: string; path: string; thumbnail?: string };

export type VoiceSettings = Pick<UserSettings, "transcriptionEngine" | "transcriptionEndpoint" | "transcriptionModel" | "voiceCleanup" | "voiceCleanupEndpoint" | "voiceCleanupModel">;

export type ThreadRole = "user" | "assistant" | "system";

export interface Message {
  role: ThreadRole;
  content: string;
  timestamp: string;
  generation?: { outputTokens: number; durationMilliseconds: number; inputTokens: number; model: string } | null;
}

export interface Thread {
  id: string;
  title: string;
  parentThreadId?: string | null;
  kind?: "main" | "subagent";
  scheduledJobId?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  messages: Message[];
}

export interface ScheduledJob {
  id: string;
  title: string;
  schedule: string;
  prompt: string;
  nodes: string;
  outputs: string;
  sourceDomains: string[];
  enabled: boolean;
  createdAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastThreadId?: string;
  permissionMode: PermissionMode;
}

export interface ResearchIteration {
  index: number;
  at: string;
  value: number | null;
  best: number | null;
  outcome: "keep" | "discard" | "crash";
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
  metricName: string;
  metricKind: "grep" | "judge";
  metricPrompt: string;
  direction: "lower" | "higher";
  evalCommand: string;
  prompt: string;
  proposerModel: string;
  permissionMode: PermissionMode;
  maxSeconds: number;
  maxTokens: number;
  maxMicroDollars: number;
  spentSeconds: number;
  spentTokens: number;
  spentMicroDollars: number;
  status: "running" | "paused" | "finished" | "failed";
  statusNote: string;
  threadId?: string | null;
  createdAt: string;
  iterations: ResearchIteration[];
}

export interface Snapshot {
  threads: Thread[];
  scheduledJobs: ScheduledJob[];
  researchJobs: ResearchJob[];
  warnings: string[];
}

export type ModelModality = "image" | "file" | "audio";

export interface OpenRouterCatalog {
  selectedModel?: string;
  models: { id: string; name: string; contextLength: number; inputModalities: ModelModality[]; reasoningEfforts?: string[]; reasoningMandatory?: boolean; free: boolean }[];
  added?: string[];
  removed?: string[];
  fetchedAt?: string;
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
  chars?: number;
}

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

export interface CredentialSummary {
  env: string;
  masked: string;
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  loading: boolean;
}

export interface BrowserStatus {
  running: boolean;
  url?: string;
  title?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  activeTab?: string;
  tabs: BrowserTab[];
}

export interface UiPlugin {
  id: string;
  name: string;
  version: string;
  css: string;
}

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
      onOverlaySurface(listener: (value: OverlaySurface) => void): () => void;
      movePill(value: { x: number; y: number }): void;
      expandPill(): void;
      dismissOverlay(): void;
      openWorkspace(settingsPage?: string): void;
      resyncWindow(): void;
      voiceStatus(settings: VoiceSettings): Promise<VoiceStatus>;
      transcribe(value: { audio: ArrayBuffer; mimeType: string; settings: VoiceSettings }): Promise<{ text: string; raw: string }>;
      onOpenSettings(listener: (page: string) => void): () => void;
      sendQuickCommand(value: string): void;
      onQuickCommand(listener: (value: string) => void): () => void;
      onNewQuickSession(listener: () => void): () => void;
      onNotchHover(listener: (value: boolean) => void): () => void;
      onDelta(listener: (value: { threadId: string; delta: string; thinking?: boolean }) => void): () => void;
      onStep(listener: (value: ThreadStep) => void): () => void;
      onContextExperiment(listener: (value: { threadId: string; prunedResults: number; reinjected: boolean; savedTokens: number; addedTokens: number }) => void): () => void;
      onContextBreakdown(listener: (value: { threadId: string; systemPromptBytes: number; systemToolsBytes: number; mcpToolsBytes: number; skillsBytes: number; memoryBytes: number }) => void): () => void;
      startScreenAnnotation(): Promise<void>;
      captureScreenContext(): Promise<{ id: string; image: string; source?: FrontApplication }>;
      getScreenAnnotationFrame(): Promise<{ image: string; width: number; height: number }>;
      finishScreenAnnotation(annotated: string): Promise<void>;
      cancelScreenAnnotation(): Promise<void>;
      screenAnnotationStatus(): Promise<{ id: string; image: string; source?: FrontApplication } | null>;
      onScreenContext(listener: (value: { id: string; image: string; source?: FrontApplication } | null) => void): () => void;
      clearScreenAnnotation(id: string): Promise<void>;
      revealPath(path: string): Promise<boolean>;
      previewPath(path: string): Promise<{ path: string; text: string | null; image?: string | null } | null>;
      listArtifacts(): Promise<ArtifactMeta[]>;
      readArtifact(id: string): Promise<Artifact>;
      saveArtifact(value: { id?: string; title: string; kind: string; language?: string; content: string }): Promise<Artifact>;
      deleteArtifact(id: string): Promise<void>;
      revealArtifact(id: string): Promise<boolean>;
      artifactSql(id: string, sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
      readVisual(id: string): Promise<Visual>;
      exportVisual(id: string, width: number): Promise<string>;
      onArtifactsChanged(listener: () => void): () => void;
      listPlans(): Promise<Plan[]>;
      onPlansChanged(listener: () => void): () => void;
      setupStatus(): Promise<SetupStatus>;
      openPrivacySettings(permission: LinkedPermission): Promise<void>;
      demoQuickAsk(): Promise<void>;
      detectVaults(): Promise<VaultChoice[]>;
      pickVaultFolder(): Promise<VaultChoice | null>;
      setVault(vault: VaultChoice): Promise<SetupStatus>;
      vaultStatus(): Promise<VaultChoice | null>;
      installObsidian(): Promise<{ installed: boolean; command: string }>;
      keep(request: KeepRequest): Promise<KeptNote>;
      listNotes(): Promise<KeptNote[]>;
      readNote(path: string): Promise<string>;
      openInObsidian(path: string): Promise<void>;
      onNotesChanged(listener: () => void): () => void;
      resetData(): Promise<void>;
      listFolders(): Promise<FolderGrant[]>;
      pluginCatalog(): Promise<PluginCatalog>;
      addMarketplace(value: { source: string; ref: string; sparse: string }): Promise<PluginCatalog>;
      removeMarketplace(id: string): Promise<PluginCatalog>;
      refreshMarketplace(id: string): Promise<PluginCatalog>;
      installPlugin(value: { marketplace: string; plugin: string }): Promise<PluginCatalog>;
      uninstallPlugin(id: string): Promise<PluginCatalog>;
      pluginDetail(value: { marketplace: string; plugin: string }): Promise<PluginDetail>;
      trustPluginHooks(value: { id: string; trusted: boolean }): Promise<PluginCatalog>;
      onFolderAttached(listener: (value: { threadId: string; folderId: string }) => void): () => void;
      pickFolder(): Promise<FolderGrant[]>;
      forgetFolder(id: string): Promise<FolderGrant[]>;
      listFolderFiles(id: string): Promise<FolderFile[]>;
      gitStatus(id: string): Promise<GitSnapshot | null>;
      listEditors(): Promise<EditorApp[]>;
      openInEditor(value: { folderId?: string; path: string; editorId: string }): Promise<void>;
      setWorktree(value: { folderId: string; name: string; on: boolean }): Promise<{ folders: FolderGrant[]; folderId: string }>;
      setBranch(value: { folderId: string; branch: string; create: boolean }): Promise<void>;
      readFolderFile(value: { folderId: string; path: string }): Promise<{ path: string; text: string }>;
      attachFiles(): Promise<HeldAttachment[]>;
      attachData(value: { name: string; data: ArrayBuffer }): Promise<HeldAttachment>;
      readAttachment(id: string): Promise<HeldAttachment & { text?: string }>;
      clearThreadContext(threadId: string): Promise<void>;
      discoverAgentImports(): Promise<AgentImportSource[]>;
      detectConnections(): Promise<Connection[]>;
      outdatedConnections(): Promise<string[]>;
      setUpConnection(value: { id: string; action: "install" | "upgrade" }): Promise<{ ok: boolean; message: string }>;
      importAgentSources(ids: string[]): Promise<string[]>;
      searchImportedSkills(value: { query: string; limit?: number }): Promise<ImportedSkill[]>;
      selectImportedSkill(value: { id: string; threadId: string }): Promise<ImportedSkill>;
      importedSkillStatus(): Promise<(ImportedSkill & { threadId: string }) | null>;
      clearImportedSkill(id: string): Promise<void>;
      listImportedMcpServers(): Promise<ImportedMcpServer[]>;
      stopComputerRun(): void;
      onComputerRunProgress(listener: (value: { step: number; action: string; actions: number }) => void): () => void;
      setVerifier(value: VerifierSettings): Promise<VerifierSettings>;
      setToolSettings(value: ToolSettings): Promise<ToolSettings>;
      setZoom(value: number): Promise<number>;
      setHarnessExperiments(value: HarnessExperiments): Promise<HarnessExperiments>;
      setImprovements(value: Improvements): Promise<Improvements>;
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
      browserStatus(threadId: string): Promise<BrowserStatus>;
      browserOpen(value: { threadId: string; url: string }): Promise<BrowserStatus>;
      browserNav(value: { threadId: string; action: "back" | "forward" | "reload" | "close" }): Promise<BrowserStatus>;
      browserPlace(value: { threadId: string; bounds: { x: number; y: number; width: number; height: number } | null }): Promise<void>;
      browserNewTab(value: { threadId: string; url?: string }): Promise<BrowserStatus>;
      browserSelectTab(value: { threadId: string; tabId: string }): Promise<BrowserStatus>;
      browserCloseTab(value: { threadId: string; tabId: string }): Promise<BrowserStatus>;
      onBrowser(listener: () => void): () => void;
      openTerminal(value: { threadId: string; columns: number; rows: number }): Promise<TerminalTab>;
      writeTerminal(value: { id: string; data: string }): Promise<void>;
      resizeTerminal(value: { id: string; columns: number; rows: number }): Promise<void>;
      closeTerminal(id: string): Promise<void>;
      listTerminals(threadId: string): Promise<TerminalTab[]>;
      readTerminal(id: string): Promise<{ data: Uint8Array; at: number }>;
      onTerminalData(listener: (value: { id: string; data: Uint8Array; at: number }) => void): () => void;
      onTerminals(listener: () => void): () => void;
      openLink(url: string): Promise<void>;
      listAgents(): Promise<LiveAgent[]>;
      listSpans(): Promise<Record<string, TraceSpan[]>>;
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
      loadUiPlugins(): Promise<UiPlugin[]>;
      onChanged(listener: () => void): number;
      offChanged(id: number): void;
    };
  }
}
