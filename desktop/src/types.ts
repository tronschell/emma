import type { SemanticGrepStatus } from "../shared/semantic-grep";
import type { BackgroundTask, FileChange, LiveAgent, PermissionAsk, ThreadStep } from "../shared/agents";
import type { Artifact, ArtifactMeta } from "../shared/artifacts";
import type { BuiltComponent, ComponentMeta, ComponentRequest } from "../shared/components";
import type { CliModels, CliRun } from "../shared/cli";
import type { CouncilStart, CouncilState } from "../shared/council";
import type { EditorApp, FolderGrant, FolderListing } from "../shared/folders";
import type { GitCommandResult, GitHistory, GitReady, GitSnapshot, WorktreeEntry } from "../shared/git";
import type { MachineSample } from "../shared/machine";
import type { HarnessLogLine, HarnessReport } from "../shared/harness-log";
import type { Goal, GoalStatus } from "../shared/goal";
import type { Visual } from "../shared/visualize";
import type { Arm, Improvements, Lever } from "../shared/improvement";
import type { Bench, BenchMetric } from "../shared/bench";
import type { PermissionMode } from "../shared/permissions";
import type { Plan } from "../shared/plan";
import type { TaskList } from "../shared/task-list";
import type { PluginCatalog, PluginDetail } from "../shared/plugins";
import type { UsageRow } from "../shared/invocations";
import type { NextStep, WorkState } from "../shared/next-steps";
import type { FrontApplication } from "../shared/screen-context";
import type { LinkedPermission, SetupStatus } from "../shared/setup";
import type { TerminalTab } from "../shared/terminal";
import type { TraceSpan } from "../shared/trace";
import type { VoiceStatus } from "../shared/voice";
import type { HarnessExperiments, KeyBalance, ProviderProfile, ReviewSettings, ShortcutRequest, ToolSettings, UserSettings, VerifierSettings } from "../shared/settings";
import type { KeepRequest, KeptNote, NoteFolder, VaultChoice } from "../shared/vault";

export interface MemoryNote {
  path: string;
  bytes: number;
  updatedAt: number;
  text: string;
}

export type HeldAttachment = { id: string; name: string; path: string; thumbnail?: string };

export type VoiceSettings = Pick<UserSettings, "transcriptionEngine" | "transcriptionEndpoint" | "transcriptionModel" | "voiceCleanup" | "voiceCleanupEndpoint" | "voiceCleanupModel">;

export type ThreadRole = "user" | "assistant" | "system";

export interface Message {
  role: ThreadRole;
  content: string;
  timestamp: string;
  generation?: { outputTokens: number; durationMilliseconds: number; inputTokens: number; cacheInputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costMicroUsd?: number; model: string } | null;
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
  messageCount?: number;
  messageDates?: string[];
  userMessageCount?: number;
  displayTitle?: string;
  labelPrompt?: string;
  subagentBrief?: string;
  goal?: Goal | null;
}

export type ThreadSummary = Omit<Thread, "messages" | "messageCount"> & { messages: number; messageDates?: string[]; userMessageCount?: number };

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
  model: string;
}

export interface Snapshot {
  threads: Thread[];
  scheduledJobs: ScheduledJob[];
  warnings: string[];
}

export interface CompactSnapshot {
  threads: ThreadSummary[];
  scheduledJobs: ScheduledJob[];
  warnings: string[];
}

export const threadMessageCount = (thread: Thread) => thread.messageCount ?? thread.messages.length;
export const threadUserMessageCount = (thread: Thread) => thread.userMessageCount ?? thread.messages.filter((message) => message.role === "user").length;
export const threadMessageDates = (thread: Thread) => thread.messageDates ?? thread.messages.map((message) => message.timestamp);
export const isCurrentThreadLoad = (requestedFor: string, selectedId: string, requestedId = selectedId, currentRequestId = requestedId) => requestedFor === selectedId && requestedId === currentRequestId;

export type ModelModality = "image" | "file" | "audio";

export interface RouteModelMetadata {
  source: "openrouter" | "models.dev" | "codex" | "manual";
  name?: string;
  description?: string;
  family?: string;
  contextWindow?: number;
  advertisedContextWindow?: number;
  maximumContextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  reasoning?: boolean;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  toolCall?: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  knowledgeCutoff?: string;
  releaseDate?: string;
  updatedAt?: string;
  fetchedAt?: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cacheReadUsdPerMillion?: number;
}

export interface OpenRouterCatalog {
  selectedModel?: string;
  models: { id: string; name: string; contextLength: number; inputModalities: ModelModality[]; reasoningEfforts?: string[]; reasoningMandatory?: boolean; free: boolean }[];
  routes?: Record<string, RouteModelMetadata>;
  added?: string[];
  removed?: string[];
  fetchedAt?: string;
  stale?: boolean;
  error?: string;
  metadataFetchedAt?: string;
  metadataStale?: boolean;
  metadataError?: string;
}

export interface AgentImportSource {
  id: string;
  label: string;
  mark: string;
  skills: number;
  mcpConfigs: number;
  locations: string[];
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
  readable: boolean;
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
      platform: string;
      request<T>(method: string, params?: Record<string, string>): Promise<T>;
      setOverlayPreferences(value: unknown): void;
      setOverlayBusy(value: boolean): void;
      setKeybinds(value: unknown): Promise<string[]>;
      onShortcutRequest(listener: (value: ShortcutRequest & { id: string }) => void): () => void;
      completeShortcutRequest(value: { id: string; keybinds?: unknown; message?: string; error?: string }): Promise<string[]>;
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
      updateReady(): Promise<string>;
      installUpdate(): Promise<void>;
      onUpdateReady(listener: (value: string) => void): () => void;
      onDelta(listener: (value: { threadId: string; delta: string; thinking?: boolean; recovery?: boolean }) => void): () => void;
      onStep(listener: (value: ThreadStep) => void): () => void;
      onCompacted(listener: (value: { threadId: string; removedTurns: number; summaryChars: number; modelWritten: boolean }) => void): () => void;
      onContextExperiment(listener: (value: { threadId: string; prunedResults: number; reinjected: boolean; savedTokens: number; addedTokens: number }) => void): () => void;
      onRoutedModel(listener: (value: { threadId: string; model: string; fellBack: boolean }) => void): () => void;
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
      listComponents(): Promise<ComponentMeta[]>;
      readComponent(id: string): Promise<BuiltComponent>;
      deleteComponent(id: string): Promise<ComponentMeta>;
      enableComponent(id: string, enabled: boolean): Promise<ComponentMeta>;
      expandComponent(value: { id: string; expands: boolean }): Promise<ComponentMeta>;
      componentFetch(value: { id: string; request: ComponentRequest }): Promise<{ status: number; ok: boolean; body: string }>;
      shootComponent(value: { id: string; x: number; y: number; width: number; height: number }): Promise<boolean>;
      onComponentsChanged(listener: () => void): () => void;
      readVisual(id: string): Promise<Visual>;
      exportVisual(id: string, width: number): Promise<string>;
      onArtifactsChanged(listener: () => void): () => void;
      listPlans(): Promise<Plan[]>;
      onPlansChanged(listener: () => void): () => void;
      listTaskLists(): Promise<TaskList[]>;
      onTaskListsChanged(listener: () => void): () => void;
      setGoal(value: { threadId: string; objective: string; tokenBudget?: number }): Promise<Thread>;
      updateGoal(value: { threadId: string; status?: GoalStatus; evidence?: string; reason?: string; extraTokens?: number }): Promise<Thread>;
      clearGoal(threadId: string): Promise<Thread>;
      setupStatus(): Promise<SetupStatus>;
      openPrivacySettings(permission: LinkedPermission): Promise<void>;
      demoQuickAsk(): Promise<void>;
      detectVaults(): Promise<VaultChoice[]>;
      pickVaultFolder(): Promise<VaultChoice | null>;
      setVault(vault: VaultChoice): Promise<SetupStatus>;
      vaultStatus(): Promise<VaultChoice | null>;
      installObsidian(): Promise<{ installed: boolean; command: string }>;
      keep(request: KeepRequest): Promise<KeptNote>;
      keepScreen(id: string): Promise<KeptNote>;
      listNotes(): Promise<KeptNote[]>;
      readNote(path: string): Promise<string>;
      listNoteFolders(): Promise<NoteFolder[]>;
      createNoteFolder(name: string): Promise<NoteFolder>;
      renameNoteFolder(value: { folder: string; name: string }): Promise<NoteFolder>;
      moveNote(value: { path: string; folder: string }): Promise<string>;
      openInObsidian(path: string): Promise<void>;
      onNotesChanged(listener: () => void): () => void;
      resetData(): Promise<void>;
      benchJudge(value: { prompt: string; rubric: string; answer: string; judge?: VerifierSettings }): Promise<{ score: number; note: string }>;
      exportBench(value: { name: string; sheets: { name: string; rows: (string | number)[][] }[] }): Promise<string>;
      exportThreadStats(value: { folder: string; files: { name: string; text: string }[] }): Promise<string>;
      listFolders(): Promise<FolderGrant[]>;
      pluginCatalog(): Promise<PluginCatalog>;
      addMarketplace(value: { source: string; ref: string; sparse: string }): Promise<PluginCatalog>;
      removeMarketplace(id: string): Promise<PluginCatalog>;
      refreshMarketplace(id: string): Promise<PluginCatalog>;
      installPlugin(value: { marketplace: string; plugin: string }): Promise<PluginCatalog>;
      uninstallPlugin(id: string): Promise<PluginCatalog>;
      pluginDetail(value: { marketplace: string; plugin: string }): Promise<PluginDetail>;
      trustPluginHooks(value: { id: string; trusted: boolean }): Promise<PluginCatalog>;
      pickFolder(): Promise<FolderGrant[]>;
      forgetFolder(id: string): Promise<FolderGrant[]>;
      listFolderFiles(id: string): Promise<FolderListing>;
      gitStatus(id: string): Promise<GitSnapshot | null>;
      gitReady(id: string): Promise<GitReady>;
      gitInit(id: string): Promise<void>;
      gitHistory(value: { folderId: string; skip?: number; limit?: number }): Promise<GitHistory>;
      gitCommit(value: { folderId: string; message: string; paths: string[]; amend?: boolean }): Promise<string>;
      gitDiscard(value: { folderId: string; paths: string[] }): Promise<void>;
      gitRun(value: { folderId: string; args: string[] }): Promise<GitCommandResult>;
      gitMessage(value: { folderId: string }): Promise<string>;
      machineSample(): Promise<MachineSample>;
      listEditors(): Promise<EditorApp[]>;
      openInEditor(value: { folderId?: string; path: string; editorId: string }): Promise<void>;
      setWorktree(value: { folderId: string; name: string; on: boolean }): Promise<{ folders: FolderGrant[]; folderId: string }>;
      worktreeList(folderId: string): Promise<WorktreeEntry[]>;
      worktreeAdd(value: { folderId: string; prefix: string; name: string }): Promise<{ folders: FolderGrant[]; folderId: string }>;
      worktreeRemove(value: { folderId: string; paths: string[] }): Promise<void>;
      setBranch(value: { folderId: string; branch: string; create: boolean; from?: string }): Promise<void>;
      readFolderFile(value: { folderId: string; path: string }): Promise<{ path: string; text: string; missing?: boolean }>;
      attachFiles(): Promise<HeldAttachment[]>;
      attachData(value: { name: string; data: ArrayBuffer }): Promise<HeldAttachment>;
      readAttachment(id: string): Promise<HeldAttachment & { text?: string }>;
      clearThreadContext(threadId: string): Promise<void>;
      discoverAgentImports(): Promise<AgentImportSource[]>;
      importAgentSources(ids: string[]): Promise<string[]>;
      searchImportedSkills(value: { query: string; limit?: number }): Promise<ImportedSkill[]>;
      selectImportedSkill(value: { id: string; threadId: string }): Promise<ImportedSkill>;
      importedSkillStatus(): Promise<(ImportedSkill & { threadId: string }) | null>;
      clearImportedSkill(id: string): Promise<void>;
      listImportedMcpServers(): Promise<ImportedMcpServer[]>;
      stopComputerRun(): void;
      onComputerRunProgress(listener: (value: unknown) => void): () => void;
      setProviders(value: ProviderProfile[]): Promise<ProviderProfile[]>;
      testProvider(value: { baseUrl: string; credentialEnv: string; modelId: string; insecure: boolean }): Promise<{ models: string[]; tools: boolean; error: string }>;
      setVerifier(value: VerifierSettings): Promise<VerifierSettings>;
      setTagger(value: VerifierSettings): Promise<VerifierSettings>;
      setToolSettings(value: ToolSettings): Promise<ToolSettings>;
      setZoom(value: number): Promise<number>;
      setHarnessExperiments(value: HarnessExperiments): Promise<HarnessExperiments>;
      setReview(value: ReviewSettings): Promise<ReviewSettings>;
      setImprovements(value: Improvements): Promise<Improvements>;
      forceArm(value: { threadId: string; arm: Arm }): Promise<Arm>;
      listToolTargets(): Promise<{ written: ToolTarget[]; skills: ImportedSkill[]; servers: ImportedMcpServer[] }>;
      capabilityUsage(): Promise<{ skills: UsageRow[]; servers: UsageRow[]; models: UsageRow[] }>;
      nextSteps(value: WorkState): Promise<NextStep[]>;
      onToolsChanged(listener: () => void): () => void;
      startCouncil(value: CouncilStart): Promise<CouncilState>;
      stopCouncil(threadId: string): Promise<void>;
      adoptCouncil(value: { threadId: string; seatId: string }): Promise<CouncilState>;
      closeCouncil(threadId: string): Promise<void>;
      councilState(threadId: string): Promise<CouncilState | null>;
      onCouncil(listener: (state: CouncilState) => void): () => void;
      setThreadContext(value: { threadId: string; folderIds: string[]; mode: PermissionMode; model: string; effort?: string; subagentModel?: string; subagentEffort?: string; review?: boolean; stepLimit?: number }): Promise<PermissionMode>;
      runCommand(value: { command: string; folderId?: string }): Promise<BackgroundTask>;
      listBackground(): Promise<BackgroundTask[]>;
      readBackground(id: string): Promise<{ task: BackgroundTask; output: string } | null>;
      stopBackground(id: string): Promise<boolean>;
      onBackground(listener: () => void): () => void;
      listCliRuns(): Promise<CliRun[]>;
      readCliRun(id: string): Promise<{ run: CliRun; output: string; result?: string; resultTruncated?: boolean } | null>;
      stopCliRun(id: string): Promise<boolean>;
      installedClis(): Promise<{ id: string; label: string; bin: string; path: string; signedIn?: boolean }[]>;
      semanticGrepStatus(): Promise<SemanticGrepStatus>;
      onSemanticGrep(listener: () => void): () => void;
      signInCli(value: { signIn: string; columns: number; rows: number }): Promise<TerminalTab>;
      cliModels(value: { cli: string; refresh?: boolean }): Promise<CliModels>;
      setCliRunModel(value: { id: string; model?: string; effort?: string }): Promise<CliRun>;
      handoffCliRun(value: import("../shared/cli").CliHandoffRequest): Promise<CliRun>;
      sendCliRun(value: { id: string; prompt: string }): Promise<CliRun | null>;
      onCliRuns(listener: () => void): () => void;
      browserStatus(threadId: string): Promise<BrowserStatus>;
      browserOpen(value: { threadId: string; url: string }): Promise<BrowserStatus>;
      browserNav(value: { threadId: string; action: "back" | "forward" | "reload" | "close" }): Promise<BrowserStatus>;
      browserPlace(value: { threadId: string; bounds: { x: number; y: number; width: number; height: number } | null }): Promise<void>;
      browserClips(): Promise<string[]>;
      browserClipUse(value: { threadId: string; index: number }): Promise<void>;
      browserNewTab(value: { threadId: string; url?: string }): Promise<BrowserStatus>;
      browserSelectTab(value: { threadId: string; tabId: string }): Promise<BrowserStatus>;
      browserCloseTab(value: { threadId: string; tabId: string }): Promise<BrowserStatus>;
      onBrowser(listener: () => void): () => void;
      onBrowserShow(listener: (value: { threadId: string }) => void): () => void;
      openTerminal(value: { threadId: string; columns: number; rows: number; cli?: string }): Promise<TerminalTab>;
      writeTerminal(value: { id: string; data: string }): Promise<void>;
      resizeTerminal(value: { id: string; columns: number; rows: number }): Promise<void>;
      closeTerminal(id: string): Promise<void>;
      listTerminals(threadId: string): Promise<TerminalTab[]>;
      readTerminal(id: string): Promise<{ data: Uint8Array; at: number }>;
      onTerminalData(listener: (value: { id: string; data: Uint8Array; at: number }) => void): () => void;
      onTerminals(listener: () => void): () => void;
      harnessReport(): Promise<HarnessReport>;
      restartHarness(): Promise<HarnessReport>;
      onHarnessLog(listener: (line: HarnessLogLine) => void): () => void;
      openLink(url: string): Promise<void>;
      listMemories(): Promise<MemoryNote[]>;
      deleteMemory(path: string): Promise<MemoryNote[]>;
      listAgents(): Promise<LiveAgent[]>;
      listSpans(): Promise<Record<string, TraceSpan[]>>;
      livePartial(): Promise<Record<string, { text: string; thinking: string }>>;
      listAsks(): Promise<PermissionAsk[]>;
      threadTraces(threadId: string): Promise<{ timestamp: string; text: string }[]>;
      steerAgent(value: { threadId: string; text: string }): Promise<void>;
      stopAgent(threadId?: string): void;
      answerPermission(value: { id: string; allowed: boolean }): void;
      threadChanges(threadId: string): Promise<FileChange[]>;
      revertChange(value: { folderId: string; path: string; before: string }): Promise<void>;
      onAgents(listener: (value: LiveAgent[]) => void): () => void;
      onSpans(listener: (value: Record<string, TraceSpan[]>) => void): () => void;
      onPermissionAsk(listener: (value: PermissionAsk) => void): () => void;
      onPermissionResolved(listener: (value: { id: string; allowed: boolean }) => void): () => void;
      setZeroRetention(value: boolean): Promise<void>;
      listCredentials(): Promise<CredentialSummary[]>;
      openRouterBalance(): Promise<KeyBalance>;
      deepseekBalance(): Promise<KeyBalance>;
      saveCredential(value: { env: string; secret?: string }): Promise<CredentialSummary[]>;
      fetchUrl(url: string): Promise<{ title: string; text: string }>;
      loadUiPlugins(): Promise<UiPlugin[]>;
      onChanged(listener: () => void): number;
      offChanged(id: number): void;
    };
    emmaBench: {
      importCases(cases: { title: string; prompt: string; folderId: string; rubric?: string; setup?: string; check?: string }[]): string[];
      start(options: { metric?: BenchMetric; arms?: "a" | "ab"; model?: string; effort?: string; mode?: string; stepLimit?: number; caseMinutes?: number; caseIds?: string[] }): string;
      read(): Bench;
      trial(items: { lever: Lever; addition: string; scope?: string }[]): string[];
      revert(): void;
    };
  }
}
