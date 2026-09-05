import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, MenuItem, nativeImage, Notification, powerMonitor, protocol, screen, session, shell, systemPreferences } from "electron";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { benchExportRequest, benchJudgeRequest, externalUrl, keepRequest, publicUrl, runCommandRequest, statsExportRequest, trustedSender, validJpegDataUrl, validateRequest, vaultRequest, type Request } from "./ipc";
import { judgeCase } from "./bench-judge";
import { workbook } from "./bench-export";
import { roundComputerCursor, COMPUTER_CURSOR_MS, type ComputerRunProgress } from "../shared/computer";
import { renderResults, webSearch } from "./web-search";
import { clipPage, fetchReadablePage, frontmostApplication, frontmostPage, frontmostTab } from "./clip";
import { discoverImports, importSources, MAX_IMPORT_SOURCES, registeredImportIds, saveImportManifest } from "./imports";
import { loadUiPlugins } from "./plugins";
import { hotspotLayout, hotspotPollDelay, nearBounds, overlayGrowth, overlayLayout, parseNotchGeometry, pillLayout, popoutLayout, type NotchGeometry } from "./overlay";
import { BoundedLines, HostResponses, parseHostLine, recordedTurn, type HostDueJob, type RecordedTurn } from "./ndjson";
import { describeRun, packVariables, parseVariables, parseWorkflow, runWorkflow, type WorkflowNode } from "../shared/workflow";
import { runWorkflowScript, workflowScriptPath } from "./workflow-script";
import { ImportedCapabilityRuntime, MAX_SKILL_RESULTS, SkillAttachmentStore, type McpServerDefinition, harnessMcpServers as readHarnessMcpServers, listEmmaTools, listImportedMcpServers, mirrorSkillsToHarness, searchImportedSkills, seedBuiltinSkills, writeEmmaTool, writeLearnedSkill } from "./capabilities";
import { daysUnder, mcpServerPrefix, mcpToolKey, modelKey, readUsage, recordUse, skillKey } from "./invocations";
import { addMarketplace, ensureDefaultMarketplace, installedHooks, installPlugin, pluginDetail, refreshMarketplace, removeMarketplace, runPluginHooks, setHookTrust, trustPluginHooks, uninstallPlugin, writePlugin } from "./marketplace";
import { hookRuns } from "../shared/plugins";
import { artifactFiles, deleteArtifact, listArtifacts, queryArtifact, readArtifact, readArtifactFile, updateArtifact, updateArtifactFile, writeArtifact, writeArtifactFile } from "./artifacts";
import { ARTIFACT_LABELS, ARTIFACT_SCHEME, artifactFileType, artifactMarker, artifactSlug, MODULE_PATH } from "../shared/artifacts";
import { ComponentRequests, deleteComponent, listComponents, readComponent, readComponentShot, setComponentEnabled, setComponentExpands, writeComponent, writeComponentShot } from "./components";
import { COMPONENT_MODULE_PATH, COMPONENT_SCHEME, COMPONENT_SHOT_PATH, COMPONENT_ZONE_LABEL } from "../shared/components";
import { deletePlan, editPlan, listPlans, readPlan, writePlan } from "./plans";
import { deleteTaskList, editTaskList, listTaskLists, readTaskList, writeTaskList } from "./task-lists";
import { DEFAULT_GOAL_TOKEN_BUDGET, goalDrivesAgain, goalPursuing, goalResult, goalTitle, goalTokensLeft, isGoalStatus, MAX_GOAL_EVIDENCE_CHARS, MAX_GOAL_OBJECTIVE_CHARS, MAX_GOAL_REASON_CHARS, MAX_GOAL_TOKEN_BUDGET, usageLimitedFailure, type Goal } from "../shared/goal";
import { mergePlan, parsePlanSteps, planProblems, planProgress, readySteps, renderPlan, stepBrief, type Plan } from "../shared/plan";
import { flattenTaskListTasks, mergeTaskList, parseTaskListTasks, renderTaskList, taskListProgress, taskListState, updateTaskListStatus, type TaskList } from "../shared/task-list";
import { VISUAL_CSP, VISUAL_SCHEME, visualMarker, visualPage, type Visual } from "../shared/visualize";
import { captureVisual, keepVisual, readVisual } from "./visuals";
import { CredentialStore } from "./credentials";
import { FolderStore } from "./folders";
import { AttachmentStore, isImageAttachment, type Attachment } from "./attachments";
import { defaultVaultRoot, vaultReady } from "./setup";
import { applyNoteTags, createNoteFolder, detectObsidianVaults, keepNote, listNoteFolders, listNotes, moveNote, noteInVault, notesRoot, obsidianInstallCommand, obsidianInstalled, readVault, renameNoteFolder, saveVault } from "./vault";
import { tagNote } from "./vault-tags";
import { DEFAULT_VAULT_FOLDER, keepKindLabel, MAX_NOTE_BYTES, obsidianOpenUrl, type KeepRequest, type KeptNote, type VaultChoice } from "../shared/vault";
import { privacySettingsUrl, type SetupStatus } from "../shared/setup";
import { modelRates, CatalogCache, fetchDeepSeekBalance, fetchOpenRouterBalance, fetchOpenRouterCatalog, probeProvider, type CatalogModel } from "./catalog";
import { ModelMetadataCatalog, type RouteModelMetadata } from "./model-metadata";
import { branchPrefixName, validateGitArgs } from "../shared/git";
import { checkForUpdates, installUpdate, readyUpdate, startUpdates } from "./update";
import { newerVersion } from "../shared/update";
import { addWorktree, commit, commitPaths, discard, gitHistory, gitReady, gitSnapshot, initRepo, listWorktrees, mainCheckout, MAX_COMMIT_MESSAGE_BYTES, MAX_HISTORY, removeWorktrees, runGit, switchBranch, writeCommitMessage } from "./git";
import { installedEditors, openInEditor } from "./editors";
import { machineSample } from "./machine";
import { transcribe, validateUtterance, validateVoiceSettings, voiceStatus } from "./voice";
import { contextBlock, MAX_FILE_BYTES, MAX_TURN_IMAGES, mergeSkillContext } from "../shared/folders";
import { BUILTIN_COMMANDS, mentions, pathName } from "../shared/slash";
import { captureDisplay, compressScreenFrame, ComputerUseRuntime, MAX_RUN_STEPS } from "./computer";
import { CODEX_MODEL_ID, CODEX_PREFIX, cliPlan, codexSlug, isEnvName, MODEL_PLANS, providerCredentials, routerKey, webSearchProvider, FREE_ROUTER_ID, planForModel, planForProfile, MIN_UI_SCALE, MAX_UI_SCALE, defaultHarnessExperiments, defaultReview, defaultSettings, defaultTagger, defaultToolSettings, defaultVerifier, routerChain, routerIdFor, validateRouters, holdBindings, isCursorCommand, isThinkingLevel, isKeybindAction, keybindCommands, normalizeAccelerator, providerChatUrl, validateProviders, validateKeybinds, validateOverlayPreferences, validateHarnessExperiments, validateReview, validateTagger, validateToolSettings, validateVerifier, FREE_ROUTER_MODELS, OPENROUTER_CHAT_ENDPOINT, type Keybind, type KeybindAction, type Keybinds, type HarnessExperiments, type OverlayPreferences, type ModelRouter, type ProviderProfile, type ReviewSettings, type TaggerSettings, type ThinkingLevel, type ToolSettings, type VerifierSettings } from "../shared/settings";
import { nameThread } from "./thread-namer";
import { suggestNextSteps } from "./next-steps";
import { validateWorkState } from "../shared/next-steps";
import { validateImprovements, type Arm } from "../shared/improvement";
import { frontApplicationNote, ScreenContextStore, validScreenContextId, type FrontApplication } from "../shared/screen-context";
import { AgentRuntime, benchReplay, benchThread, haltBench, inheritBench, lastAssistantMessage, ownBench, OWN_TOOLS, refuseBenchTurn, towardGoal, type TurnRequest } from "./agent-loop";
import { adoptCouncil, closeCouncil, configureCouncil, councilAnswer, councilState, startCouncil, stopCouncil, type CouncilRoute } from "./council";
import { validateCouncilStart } from "../shared/council";
import { BackgroundCommands } from "./background";
import { CliRuns } from "./cli";
import { proxyPort, SemanticGrep, ZG_ENTRY } from "./semantic-grep";
import { chatgptAuth, chatgptRoute } from "./chatgpt";
import { CliModelCatalog } from "./cli-models";
import { CLI_IDS, cliHarness, describeRuns, cliOptions } from "../shared/cli";
import { forceArm, harnessPromptFile, resolveHarnessPrompt, setImprovements, setPrompts, setSystemPrompt, withGoal, withTrialArm, writeHarnessPrompt } from "./system-prompt";
import { Harness, RESTARTED_BY_YOU, escapesRoot, explainFailure, failedTurn, harnessKey, recoveredSessionTraces, type HarnessMcpServer, type HarnessToolCall, type StoredThreadTrace, type ThinkingRoute, type TurnUsage } from "./harness";
import { MAX_LOG_LINES, type HarnessLogLine, type HarnessReport } from "../shared/harness-log";
import { review } from "./verifier";
import { MAX_REVIEW_ROUNDS, REVIEWABLE_KINDS, reviewPrompt, reviewTitle, reviewVerdict, revisionPrompt } from "./review";
import { advise } from "./advisor";
import { describeScreen, look } from "./vision";
import { readSecret } from "./secret";
import { listMemories, MAX_MEMORY_FILE_BYTES, resolveMemoryPath, runMemoryCommand } from "./memory";
import { browserArgv, BROWSER_NAVIGATIONS, describeToolCall, MAX_CLI_PROMPT_CHARS, parseToolArgs, shellQuoted, toolNeeds, type ToolArgs } from "./tools";
import { Browsers, type BrowserStatus } from "./browser";
import { Terminals } from "./terminal";
import { MAX_TERMINAL_COLUMNS, MAX_TERMINAL_INPUT } from "../shared/terminal";

const SIGN_IN_THREAD = "sign-in";
import { asPermissionMode, DEFAULT_PERMISSION_MODE, TOOL_CATALOG, toolGate, type PermissionMode } from "../shared/permissions";
import { agentName, editStat, sentByThread, MAX_LIVE_SUBAGENTS, type FileChange, type PermissionAsk, type SubagentRoute } from "../shared/agents";
import { createBridge, type Bridge } from "./bridge";
import { clampTrace, compactionNotice } from "../shared/trace";
import { isPin, MAX_ASK_MS, MAX_LABEL_PROMPT_CHARS, PROTOCOL_VERSION, type BridgeEvent, type BridgeMethod, type CommandMenu, type DesktopIdentity, type GitSyncResult, type LiveAgent, type LiveState, type CredentialSlot, type KeyStatus, type MacSettings, type MemoryNote, type ModelEntry, type PhoneList, type PluginEntry, type ScheduledJob, type ToolSwitches, type ToolTargets, type Message, type ThreadStep as RemoteStep, type ThreadSummary, type ThreadTrace, type TraceSpan as PhoneTraceSpan } from "../shared/mobile-protocol";
import type { TraceSpan } from "../shared/trace";
import { localDevice } from "../shared/platform-copy";
import { canonicalResetPath, findExecutable, isMac, isWindows, pathInside, realPath, realPathInside, resetDataRoots, samePath, shellArguments, shellBinary, spawnCommand, squirrelEvent as readSquirrelEvent, terminateProcessTree, WINDOWS_APP_USER_MODEL_ID } from "./platform";

const MAX_HOST_RESPONSE_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_CACHE_MS = 5000;
const MAX_HOST_CALL_MS = 60 * 1000;
const WINDOWS_SHUTDOWN_TIMEOUT_MS = 8000;

const DEVICE = localDevice(process.platform);
if (isWindows) app.setName("Emma");

class Host {
  private child!: ChildProcessWithoutNullStreams;
  private lines = new BoundedLines(MAX_HOST_RESPONSE_BYTES);
  private responses = new HostResponses();
  private nextId = 1;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private failure: Error | null = null;
  private closed = false;
  private writes = 0;
  private snapshots = new Map<string, { writes: number; at: number; value: Promise<unknown> }>();

  constructor(private readonly binaryPath: string) {
    this.spawn();
  }

  private spawn() {
    const child = spawn(this.binaryPath, [], { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.stdout.on("data", (data: Buffer) => {
      if (this.child !== child) return;
      try { for (const line of this.lines.push(data)) { if (this.failure) break; this.receive(line); } }
      catch (error) { this.abort(error instanceof Error ? error : new Error("Emma host protocol error")); }
    });
    child.stdout.on("end", () => { if (this.child !== child) return; try { this.lines.end(); this.responses.end(); } catch (error) { this.abort(error as Error); } });
    child.stderr.on("data", (data) => console.error(String(data).trim()));
    child.once("error", (error) => { if (this.child === child) this.fail(error); });
    child.stdin.on("error", (error) => { if (this.child === child) this.fail(error); });
    child.once("exit", () => { if (this.child === child) this.fail(new Error("Emma host stopped")); });
  }

  private restart() {
    this.failure = null;
    this.lines = new BoundedLines(MAX_HOST_RESPONSE_BYTES);
    this.responses = new HostResponses();
    this.snapshots.clear();
    this.spawn();
  }

  request(request: { method: string; params: Record<string, string> }): Promise<unknown> {
    if (this.failure && this.closed) return Promise.reject(this.failure);
    if (this.failure) this.restart();
    if (request.method === "thread" || request.method === "readTrace") return this.send(request);
    if (request.method !== "snapshot" && request.method !== "threadSummaries") {
      this.storeChanged();
      const written = this.send(request);
      void written.then(() => changed(), () => undefined);
      return written;
    }
    const cached = this.snapshots.get(request.method);
    if (cached && cached.writes === this.writes && Date.now() - cached.at < SNAPSHOT_CACHE_MS) return cached.value;
    const value = this.send(request);
    const entry = { writes: this.writes, at: Date.now(), value };
    this.snapshots.set(request.method, entry);
    const { at } = entry;
    setTimeout(() => { if (this.snapshots.get(request.method)?.at === at) this.snapshots.delete(request.method); }, SNAPSHOT_CACHE_MS).unref();
    value.catch(() => { if (this.snapshots.get(request.method) === entry) this.snapshots.delete(request.method); });
    return value;
  }

  private storeChanged() {
    this.writes++;
    this.snapshots.clear();
  }

  private send(request: { method: string; params: Record<string, string> }): Promise<unknown> {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) this.abort(new Error(`Emma host stopped answering ${request.method}`));
      }, MAX_HOST_CALL_MS);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ id, ...request })}\n`, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  close() {
    this.closed = true;
    this.fail(new Error("Emma host closed"));
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (!this.child.killed) this.child.kill();
  }

  private receive(line: string) {
    try {
      const frame = parseHostLine(line);
      if (!("dueJob" in frame) && !this.pending.has(frame.id)) throw new Error("Unexpected host response ID");
      const response = this.responses.push(frame);
      if (!response) return;
      if ("dueJob" in response) {
        const job = response.dueJob;
        this.storeChanged();

        scheduledJobsChanged();
        void runScheduledWorkflow(job)
          .finally(scheduledJobsChanged)
          .catch((error: unknown) => console.error(`Scheduled job ${job.jobId} failed:`, error));
        return;
      }
      const request = this.pending.get(response.id);
      if (!request) throw new Error("Unexpected host response ID");
      this.pending.delete(response.id);
      if (response.ok) request.resolve(response.result);
      else request.reject(new Error(response.error));
    } catch (error) {
      this.abort(error instanceof Error ? error : new Error("Emma host protocol error"));
    }
  }

  private abort(error: Error) {
    this.fail(error);
    if (!this.child.killed) this.child.kill();
  }

  private fail(error: Error) {
    this.failure ??= error;
    this.snapshots.clear();
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
    this.responses.clear();
  }
}

let host: Host | undefined;
let credentials: CredentialStore | undefined;
let folders: FolderStore | undefined;
let attachments: AttachmentStore | undefined;
let modelCatalog: CatalogCache | undefined;
let modelMetadata: ModelMetadataCatalog | undefined;
let capabilities: ImportedCapabilityRuntime | undefined;
let computerRuntime: ComputerUseRuntime | undefined;
let agents: AgentRuntime | undefined;
let bridge: Bridge | undefined;
const background = new BackgroundCommands(() => broadcast("emma:background"));
const clis = new CliRuns(() => broadcast("emma:cli-runs"));
const zgEntry = app.isPackaged ? path.join(process.resourcesPath, "zvec-grep", ZG_ENTRY) : path.join(app.getAppPath(), "vendor/zvec-grep", ZG_ENTRY);
const semanticGrep = new SemanticGrep(process.execPath, zgEntry, existsSync(zgEntry), proxyPort(app.getPath("userData")), () => broadcast("emma:semantic-grep"));
let cliModels: CliModelCatalog;
const browsers = new Browsers(() => broadcast("emma:browser"), reportBrowserCursor);
const terminals = new Terminals(
  () => nativeHelper("emma-pty"),
  (id, data, at) => broadcast("emma:terminal-data", { id, data, at }),
  () => broadcast("emma:terminals"),
);
let runBanner: BrowserWindow | null = null;
let computerCursorWindow: BrowserWindow | null = null;
let computerCursorReady = false;
let computerCursorTimer: ReturnType<typeof setTimeout> | undefined;
let computerProgress: ComputerRunProgress | undefined;
let computerCursorProgress: ComputerRunProgress | undefined;
let computerCursorOwner: "computer" | "browser" = "computer";
let computerCursorHeld = false;
let computerCursorIdle: ReturnType<typeof setTimeout> | undefined;
const CURSOR_IDLE_MS = 60_000;
let computerCursorAt = 0;
type ThreadContextRecord = { folderIds: string[]; mode: PermissionMode; model: string; effort?: ThinkingLevel; subagent?: SubagentRoute; review?: boolean; stepLimit?: number };

const threadContexts = new Map<string, ThreadContextRecord>();

const DEFAULT_THREAD_TITLE = "New thread";

type ThreadRecord = { id: string; title?: string; kind?: string; archivedAt?: string | null; goal?: Goal | null };

const goals = new Map<string, Goal>();
const goalDriving = new Set<string>();
const goalStopped = new Set<string>();
const turnSpend = new Map<string, { output: number; total: number }>();

function noteTurnSpend(threadId: string, usage: { inputTokens: number; outputTokens: number }) {
  const seen = turnSpend.get(threadId) ?? { output: 0, total: 0 };
  const step = usage.inputTokens + Math.max(0, usage.outputTokens - seen.output);
  const spent = { output: Math.max(seen.output, usage.outputTokens), total: seen.total + step };
  turnSpend.set(threadId, spent);
  return spent.total;
}

function noteThread(value: unknown): ThreadRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const thread = value as ThreadRecord;
  if (typeof thread.id !== "string") return undefined;
  if (thread.goal && typeof thread.goal === "object") goals.set(thread.id, thread.goal);
  else goals.delete(thread.id);
  return thread;
}

function primeGoals(snapshot: unknown) {
  const threads = (snapshot as { threads?: unknown[] } | null)?.threads;
  if (Array.isArray(threads)) for (const thread of threads) noteThread(thread);
}

const GOAL_CONTINUATION = "Continue working toward this thread's goal.";
const GOAL_OVERSPENT = "The token allowance ran out part-way through a turn, so Emma stopped it there. Each agent step re-sends the conversation, so a long turn spends more than the turn ledger records. Continue grants more.";

const threadFolderIds = (threadId: string) => threadContexts.get(threadId)?.folderIds ?? [];

const phoneThreads = new Set<string>();
const phoneThreadsFile = () => path.join(app.getPath("userData"), "phone-threads.json");
function loadPhoneThreads() {
  try {
    const ids = JSON.parse(readFileSync(phoneThreadsFile(), "utf8")) as unknown;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") phoneThreads.add(id);
  } catch { return; }
}

const threadContextsFile = () => path.join(app.getPath("userData"), "thread-contexts.json");
function loadThreadContexts() {
  try {
    const stored = JSON.parse(readFileSync(threadContextsFile(), "utf8")) as unknown;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
    for (const [threadId, held] of Object.entries(stored as Record<string, unknown>)) {
      if (!threadId || !held || typeof held !== "object" || Array.isArray(held)) continue;
      const { folderIds, mode, model, effort, subagent, review } = held as Record<string, unknown>;
      threadContexts.set(threadId, {
        folderIds: Array.isArray(folderIds) ? folderIds.filter((id): id is string => typeof id === "string").slice(0, 1) : [],
        mode: asPermissionMode(mode),
        model: typeof model === "string" ? model.slice(0, 128) : "",
        ...(isThinkingLevel(effort) ? { effort } : {}),
        ...(subagent && typeof subagent === "object" && !Array.isArray(subagent) ? { subagent: subagent as SubagentRoute } : {}),
        ...(typeof review === "boolean" ? { review } : {}),
      });
    }
  } catch { return; }
}

function rememberThreadContext(threadId: string, record: ThreadContextRecord) {
  threadContexts.set(threadId, record);
  try {
    writeFileSync(threadContextsFile(), JSON.stringify(Object.fromEntries(threadContexts)));
  } catch { return; }
}
const mobileStatus = (activeAt?: number) => ({ ...bridge!.status(), threads: [...phoneThreads], ...(activeAt ? { activeAt } : {}) });
function namedPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 1024) throw new Error("That path is invalid");
  const raw = value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
  const candidates = path.isAbsolute(raw) ? [raw] : folders!.list().map((grant) => path.join(grant.path, raw));
  return candidates.find((candidate) => existsSync(candidate));
}

function pathGrant(file: string) {
  const real = realPath(file);
  const grant = real ? folders!.list().find((folder) => realPathInside(folder.path, real)) : undefined;
  return { grant, attached: !grant && attachments!.holds(file) };
}

const skillAttachment = new SkillAttachmentStore();
const harnesses = new Map<string, Harness>();
const harnessLog: HarnessLogLine[] = [];
let windowsQuitShutdown: Promise<void> | undefined;

function noteHarnessLog(line: HarnessLogLine) {
  harnessLog.push(line);
  if (harnessLog.length > MAX_LOG_LINES) harnessLog.splice(0, harnessLog.length - MAX_LOG_LINES);
  broadcast("emma:harness-log", line);
}

const readHarnessReport = (): HarnessReport => ({
  processes: [...harnesses.values()].map((client) => client.state),
  lines: harnessLog,
});

function restartHarnesses() {
  const stopped = harnesses.size;
  stopEveryThread();
  for (const client of harnesses.values()) client.close(RESTARTED_BY_YOU);
  harnesses.clear();
  noteHarnessLog({ at: Date.now(), flow: "err", label: "restart", body: `Emma stopped ${stopped} emma-cli ${stopped === 1 ? "process" : "processes"}. The next turn starts a fresh one.` });
  return readHarnessReport();
}
const harnessText = new Map<string, string>();
const harnessThought = new Map<string, string>();
const harnessRouted = new Map<string, string>();
const harnessUsage = new Map<string, TurnUsage>();
const harnessChildren = new Map<string, { childId: string; title: string; startedAt: number; client: Harness }>();
const stopThread = (threadId: string) => {
  goalStopped.add(threadId);
  if (computerRuntime?.threadId === threadId) computerRuntime.abort();
  agents?.stop(threadId);
  const child = harnessChildren.get(threadId);
  if (child) void child.client.cancelChild(child.childId).catch(() => undefined);
  else for (const harness of harnesses.values()) void harness.cancel(threadId);
  if (!benchThread(threadId)) return;
  void answerRequest("setThreadArchived", { threadId, archived: "true" }).then(() => changed()).catch(() => undefined);
  for (const id of haltBench(threadId)) if (id !== threadId) stopThread(id);
};
function stopEveryThread() {
  agents!.stopAll();
  for (const threadId of goalDriving) goalStopped.add(threadId);
  for (const threadId of harnessText.keys()) stopThread(threadId);
  for (const threadId of harnessChildren.keys()) stopThread(threadId);
}
async function steerThread(threadId: string, text: string) {
  const child = harnessChildren.get(threadId);
  if (child) {
    if (!child.client.running) throw new Error("That subagent's harness is no longer running.");
    await child.client.steerChild(child.childId, text);
    agents!.noteNotice(threadId, "steer", text);
    return;
  }
  for (const harness of harnesses.values()) {
    if (await harness.steer(threadId, text)) {
      agents!.dropAsks(threadId);
      agents!.noteNotice(threadId, "steer", text);
      return;
    }
  }
  agents!.steer(threadId, text);
}
let hotkeyHelper: ChildProcess | undefined;
let mainWindow: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let annotation: BrowserWindow | null = null;
let annotationFrame: { image: string; width: number; height: number } | null = null;
let annotationSource: FrontApplication | undefined;
let annotationDisplay: Electron.Display | null = null;
const annotationAttachment = new ScreenContextStore();
let annotating = false;
let capturing = false;
let overlayPreferences: OverlayPreferences = { notchGap: defaultSettings.notchGap, cursorOrbsEnabled: defaultSettings.cursorOrbsEnabled, notchConcurrency: defaultSettings.notchConcurrency };

let defaultMode: PermissionMode = DEFAULT_PERMISSION_MODE;
let verifier: VerifierSettings = defaultVerifier;
let toolSettings: ToolSettings = defaultToolSettings;
let harnessExperiments: HarnessExperiments = defaultHarnessExperiments;
let reviewSettings: ReviewSettings = defaultReview;
const reviewThreads = new Set<string>();
const reviewing = new Set<string>();
const turnTouched = new Set<string>();

const toolsChanged = async () => {
  broadcast("emma:tools-changed");
  for (const client of harnesses.values()) client.rebindServers();
  recycleHarnesses();
  await syncHarnessSkills();
};
const artifactsChanged = () => broadcast("emma:artifacts-changed");
const componentsChanged = () => broadcast("emma:components-changed");
const componentRequests = new ComponentRequests();

const plansChanged = () => broadcast("emma:plans-changed");
const taskListsChanged = () => broadcast("emma:task-lists-changed");
let overlayPreferencesReady = false;
let queuedOverlayToggle: { command?: string } | null = null;
let overlayBusy = false;
let overlayFront: Promise<string> = Promise.resolve("");
let closeOverlayWhenIdle = false;
let notches: NotchGeometry[] = [];
let hotspot: BrowserWindow | null = null;
let hotspotKey = "";
let hotspotTimer: ReturnType<typeof setTimeout> | undefined;
const HOTSPOT_WARM = 220;
let radial: BrowserWindow | null = null;
let overlayBaseHeight = 0;
const RADIAL_SIZE = 260;
let overlaySurface: "notch" | "pill" | "popout" = "notch";
let pillSpot: { x: number; y: number } | undefined;
let overlayGrow = 0;

const preload = path.join(__dirname, "preload.js");
const renderer = path.join(app.getAppPath(), "dist-renderer/index.html");

const DEV_BINARIES: Record<string, string> = {
  "emma-host": "target/debug/emma-host",
  "emma-cli": "harness/zig-out/bin/emma-cli",
  rg: "desktop/vendor/rg",
};

function binary(name: string) {
  const file = isWindows && !path.extname(name) ? `${name}.exe` : name;
  return app.isPackaged
    ? path.join(process.resourcesPath, file)
    : path.join(app.getAppPath(), "..", DEV_BINARIES[name] ? `${DEV_BINARIES[name]}${isWindows ? ".exe" : ""}` : file);
}

function nativeHelper(name = "emma-option-tap") {
  const file = isWindows && !path.extname(name) ? `${name}.exe` : name;
  return app.isPackaged
    ? path.join(process.resourcesPath, file)
    : path.join(app.getAppPath(), `dist-native/${file}`);
}

function builtinSkills() {
  return app.isPackaged ? path.join(process.resourcesPath, "skills") : path.join(app.getAppPath(), "skills");
}

function readNotchGeometry() {
  if (process.platform !== "darwin") return;
  const child = spawn(nativeHelper(), ["--screens"], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = new BoundedLines(4096);
  const fail = (error: unknown) => console.error("Emma: display geometry unavailable; using the configured notch gap", error);
  child.stdout.on("data", (data: Buffer) => { try { for (const line of lines.push(data)) { notches = parseNotchGeometry(line); openHotspot(); } } catch (error) { fail(error); child.kill(); } });
  child.stdout.on("end", () => { try { lines.end(); } catch (error) { fail(error); } });
  child.stderr.on("data", (data) => console.error(String(data).trim()));
  child.once("error", fail);
}

function startQuickAskHotkey() {
  if (!isMac && !isWindows) return;
  const child = spawn(nativeHelper(), [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = new BoundedLines(64);
  hotkeyHelper = child;
  sendHoldKeybinds();
  child.stdout?.on("data", (data: Buffer) => {
    try {
      for (const line of lines.push(data)) {
        if (line === "toggle") toggleOverlay();
        else if (line.startsWith("hold ")) runKeybindAction(line.slice(5));
        else throw new Error("invalid Quick Ask hotkey event");
      }
    } catch (error) {
      console.error("Emma: Quick Ask hotkey listener failed", error);
      child.kill();
    }
  });
  child.stdout?.on("end", () => { try { lines.end(); } catch (error) { console.error("Emma: Quick Ask hotkey listener failed", error); } });
  child.stderr?.on("data", (data) => console.error(String(data).trim()));
  child.once("error", (error) => console.error("Emma: Quick Ask hotkey listener failed", error));
  child.once("exit", () => { if (hotkeyHelper === child) hotkeyHelper = undefined; });
}

const registeredKeybinds = new Set<string>();
let keybinds: Keybinds = {};
const pendingShortcuts = new Map<string, { senderId: number; accelerator: string; timeout: ReturnType<typeof setTimeout>; resolve: (result: string) => void; reject: (error: Error) => void }>();

function runKeybindAction(action: string) {
  if (!isKeybindAction(action)) return;
  if (action === "toggle") toggleOverlay();
  else runOverlayCommand(keybindCommands[action]);
}

function applyKeybinds(next: Keybinds): KeybindAction[] {
  for (const accelerator of registeredKeybinds) globalShortcut.unregister(accelerator);
  registeredKeybinds.clear();
  keybinds = next;
  sendHoldKeybinds();
  const refused: KeybindAction[] = [];
  for (const [action, keybind] of Object.entries(next) as [KeybindAction, Keybind][]) {
    if (!keybind.accelerator) continue;
    const accelerator = isWindows ? keybind.accelerator.replace(/\bCommand\b/g, "Control") : keybind.accelerator;
    try {
      const taken = globalShortcut.register(accelerator, () => runKeybindAction(action));
      if (!taken) throw new Error("already registered");
      registeredKeybinds.add(accelerator);
    } catch (error) {
      console.error(`Emma: ${accelerator} is unavailable`, error);
      refused.push(action);
    }
  }
  return refused;
}

function saveShortcutFromTool(args: Extract<ToolArgs, { name: "shortcut" }>): Promise<string> {
  const window = [mainWindow, overlay].find((candidate) => candidate && !candidate.isDestroyed() && !candidate.webContents.isLoading());
  if (!window) throw new Error("Open Emma's workspace or Quick Ask before creating a shortcut.");
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!pendingShortcuts.delete(id)) return;
      reject(new Error("Emma's settings page did not answer the shortcut request."));
    }, 10_000);
    pendingShortcuts.set(id, { senderId: window.webContents.id, accelerator: args.accelerator, timeout, resolve, reject });
    try {
      window.webContents.send("emma:shortcut-request", { id, accelerator: args.accelerator, label: args.label, prompt: args.prompt });
    } catch (error) {
      clearTimeout(timeout);
      pendingShortcuts.delete(id);
      reject(error instanceof Error ? error : new Error("Emma could not open shortcut settings."));
    }
  });
}

function sendHoldKeybinds() {
  try { hotkeyHelper?.stdin?.write(`${JSON.stringify({ holds: holdBindings(keybinds, process.platform) })}\n`); }
  catch (error) { console.error("Emma: could not send the hold shortcuts to the listener", error); }
}

function runOverlayCommand(command: string) {
  if (overlay && !overlay.isDestroyed()) {
    closeRadial();
    overlay.webContents.send("emma:quick-command", command);
    overlay.focus();
    return;
  }
  toggleOverlay(command);
}

function pinWindow(window: BrowserWindow) {
  if (isMac) {
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  } else {
    window.setAlwaysOnTop(true);
  }
}

const floating: Electron.BrowserWindowConstructorOptions = process.platform === "darwin" ? { type: "panel" } : {};

function secureWindow(options: Electron.BrowserWindowConstructorOptions) {
  const window = new BrowserWindow({
    backgroundColor: "#0a0a0c",
    show: false,
    ...options,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const safe = externalUrl(url);
    if (safe) void shell.openExternal(safe.toString());
    return { action: "deny" };
  });
  window.webContents.on("context-menu", (event, params) => {
    if (!params.isEditable && !params.selectionText) return;
    event.preventDefault();
    const selected = params.selectionText.trim();
    const menu = Menu.buildFromTemplate([
      ...(params.misspelledWord ? params.dictionarySuggestions.map((suggestion) => ({ label: suggestion, click: () => window.webContents.replaceMisspelling(suggestion) })) : []),
      ...(selected ? [
        { label: `Look Up “${selected}”`, click: () => Menu.sendActionToFirstResponder("lookUp:") },
        { label: "Search with Google", click: () => void shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(selected)}`) },
      ] : []),
      ...((params.misspelledWord && params.dictionarySuggestions.length) || selected ? [{ type: "separator" as const }] : []),
      ...(params.isEditable ? [
        { role: "cut" as const, enabled: params.editFlags.canCut },
        { role: "copy" as const, enabled: params.editFlags.canCopy },
        { role: "paste" as const, enabled: params.editFlags.canPaste },
        { role: "selectAll" as const, enabled: params.editFlags.canSelectAll },
      ] : [{ role: "copy" as const, enabled: params.editFlags.canCopy }]),
    ]);
    menu.popup({ window, frame: params.frame ?? undefined, x: params.x, y: params.y, sourceType: params.menuSourceType });
  });
  window.webContents.on("will-navigate", (event, url) => {
    const current = window.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
  return window;
}

async function load(window: BrowserWindow, mode: "main" | "overlay" | "annotation" | "hotspot" | "run" | "radial" | "computerCursor" = "main", extra: Record<string, string> = {}) {
  const painted = new Promise<void>((resolve) => {
    window.once("ready-to-show", () => resolve());
    setTimeout(resolve, 2000).unref();
  });
  try {
    const dev = process.env.EMMA_DEV_SERVER_URL;
    const parameters = mode === "main" ? {} : { [mode]: "1", ...extra };
    const query = mode === "main" ? "" : `?${new URLSearchParams(parameters).toString()}`;
    if (dev) await window.loadURL(`${dev}${query}`);
    else await window.loadFile(renderer, mode === "main" ? undefined : { query: parameters });
    if (window.isDestroyed()) return;
    await painted;
    if (window.isDestroyed()) return;
    if (mode === "main") window.show();
    else if (mode === "overlay" || mode === "annotation") { window.showInactive(); window.focus(); }
    else if (mode !== "computerCursor") window.showInactive();
  } catch (error) {
    if (!window.isDestroyed()) console.error("Emma window failed to load", error);
  }
}

function openMain() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = secureWindow({
    width: 1380,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    ...(isMac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 17 } } : {}),
    ...(isWindows ? { titleBarStyle: "hidden" as const, titleBarOverlay: { color: "#131316", symbolColor: "#e8e6df", height: 32 } } : {}),
    ...(process.platform === "darwin" ? { vibrancy: "sidebar" as const, visualEffectState: "active" as const, backgroundColor: "#00000000" } : {}),
  });
  mainWindow.on("closed", () => (mainWindow = null));
  browsers.attach(mainWindow);
  void load(mainWindow);
}

function needsYou(title: string, body: string) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const watching = mainWindow.isFocused();
  if (!mainWindow.isVisible()) mainWindow.show();
  if (watching || !Notification.isSupported()) return;
  const note = new Notification({ title, body });
  note.on("click", () => {
    if (process.platform === "darwin") app.focus({ steal: true });
    openMain();
  });
  note.on("failed", () => app.dock?.bounce("critical"));
  note.show();
}

function openSettingsPage(page: string) {
  const fresh = !mainWindow;
  openMain();
  const window = mainWindow!;
  if (fresh) window.webContents.once("did-finish-load", () => { if (!window.isDestroyed()) window.webContents.send("emma:open-settings", page); });
  else window.webContents.send("emma:open-settings", page);
}

function trustedFrame(event: Electron.IpcMainInvokeEvent) {
  if (event.senderFrame !== event.sender.mainFrame || !trustedSender(event.senderFrame.url, app.getAppPath(), process.env.EMMA_DEV_SERVER_URL)) {
    throw new Error("IPC sender is not allowed");
  }
}

function closeOverlay(window: BrowserWindow) {
  if (annotating) {
    window.hide();
    return;
  }
  if (overlayBusy) {
    closeOverlayWhenIdle = true;
    window.hide();
  } else if (!window.isDestroyed()) {
    window.destroy();
  }
}

function collapseToPill(window: BrowserWindow) {
  if (window.isDestroyed()) return;
  const bounds = pillLayout(screen.getDisplayMatching(window.getBounds()), pillSpot);
  pillSpot = { x: bounds.x, y: bounds.y };
  overlaySurface = "pill";
  window.setBounds(bounds);
  window.webContents.send("emma:overlay-surface", "pill");
  closeRadial();
}

function expandPill(window: BrowserWindow) {
  if (window.isDestroyed()) return;
  const layout = popoutLayout(screen.getDisplayMatching(window.getBounds()), window.getBounds(), overlayGrow);
  overlaySurface = "popout";
  overlayBaseHeight = layout.base;
  window.setBounds(layout.bounds);
  window.webContents.send("emma:overlay-surface", "popout");
  window.focus();
}

function leaveOverlay(window: BrowserWindow) {
  if (overlaySurface === "notch" && !overlayBusy) closeOverlay(window);
  else collapseToPill(window);
}

function newQuickSession(window: BrowserWindow) {
  if (overlayBusy && overlayPreferences.notchConcurrency !== "continue") window.webContents.send("emma:new-quick-session");
}

function toggleOverlay(command?: string) {
  if (annotating) {
    closeAnnotation();
    return;
  }
  if (!overlayPreferencesReady) {
    queuedOverlayToggle = { command };
    return;
  }
  if (overlay) {
    if (overlaySurface === "pill") { newQuickSession(overlay); expandPill(overlay); return; }
    if (overlaySurface === "popout") { collapseToPill(overlay); return; }
    if (!overlay.isVisible() && !capturing) {
      closeOverlayWhenIdle = false;
      newQuickSession(overlay);
      overlay.show();
      overlay.focus();
      if (command) overlay.webContents.send("emma:quick-command", command);
      return;
    }
    closeOverlay(overlay);
    return;
  }
  overlayBusy = false;
  closeOverlayWhenIdle = false;
  overlaySurface = isWindows ? "popout" : "notch";
  overlayGrow = 0;
  overlayFront = frontContextNote().catch(() => "");
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const pill = isWindows ? pillLayout(display, pillSpot) : undefined;
  if (pill) pillSpot = { x: pill.x, y: pill.y };
  const layout = pill ? { bounds: popoutLayout(display, pill).bounds, notch: { left: 0, width: 0, height: 0 } } : overlayLayout(display, overlayPreferences, notches.find((item) => item.id === display.id));
  const window = secureWindow({
    ...layout.bounds,
    ...floating,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    roundedCorners: false,
  });
  overlay = window;
  overlayBaseHeight = layout.bounds.height;
  pinWindow(window);
  window.on("blur", () => { if (!annotating && !capturing) leaveOverlay(window); });
  window.on("closed", () => {
    if (overlay === window) overlay = null;
    closeRadial();
    annotationAttachment.clearAll();
    overlayBusy = false;
    overlayFront = Promise.resolve("");
    closeOverlayWhenIdle = false;
    overlaySurface = isWindows ? "pill" : "notch";
    overlayGrow = 0;
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (input.key === "Escape") {
      event.preventDefault();
      leaveOverlay(window);
    }
  });
  closeHotspot();
  void load(window, "overlay", { surface: overlaySurface, notchLeft: String(layout.notch.left), notchWidth: String(layout.notch.width), notchHeight: String(layout.notch.height), ...(command ? { command } : {}) });
  if (overlayPreferences.cursorOrbsEnabled && !command) openRadial(display);
}

function openRadial(display: Electron.Display) {
  const cursor = screen.getCursorScreenPoint();
  const x = Math.round(Math.min(Math.max(display.bounds.x, cursor.x - RADIAL_SIZE / 2), display.bounds.x + display.bounds.width - RADIAL_SIZE));
  const y = Math.round(Math.min(Math.max(display.bounds.y, cursor.y - RADIAL_SIZE / 2), display.bounds.y + display.bounds.height - RADIAL_SIZE));
  const window = secureWindow({
    x, y, width: RADIAL_SIZE, height: RADIAL_SIZE,
    ...floating,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    roundedCorners: false,
  });
  radial = window;
  pinWindow(window);
  window.on("closed", () => { if (radial === window) radial = null; });
  void load(window, "radial");
}

function closeRadial() {
  if (radial && !radial.isDestroyed()) radial.destroy();
  radial = null;
}

function closeHotspot() {
  if (hotspot && !hotspot.isDestroyed()) hotspot.destroy();
  hotspot = null;
}

function openHotspot() {
  const display = screen.getPrimaryDisplay();
  const notch = notches.find((item) => item.id === display.id);
  const key = notch ? [display.id, display.bounds.y, notch.x, notch.width, notch.height].join(":") : "";
  if (key === hotspotKey) return;
  hotspotKey = key;
  clearTimeout(hotspotTimer);
  closeHotspot();
  if (!notch) return;
  const layout = hotspotLayout(display, notch);
  const near = (point: Electron.Point, pad: number) => nearBounds(layout.bounds, point, pad);
  let hovering = false;
  const build = () => {
    const window = secureWindow({
      ...layout.bounds,
      ...floating,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      roundedCorners: false,
    });
    hotspot = window;
    pinWindow(window);
    window.setIgnoreMouseEvents(true, { forward: true });
    window.on("closed", () => { if (hotspot === window) hotspot = null; });
    window.webContents.once("did-finish-load", () => {
      if (window.isDestroyed()) return;
      window.setIgnoreMouseEvents(!hovering, { forward: true });
      window.webContents.send("emma:notch-hover", hovering);
    });
    void load(window, "hotspot", { notchLeft: String(layout.notch.left), notchWidth: String(layout.notch.width), notchHeight: String(layout.notch.height) });
  };
  const poll = () => {
    const point = screen.getCursorScreenPoint();
    const warm = !(overlay && !overlay.isDestroyed()) && near(point, HOTSPOT_WARM);
    if (!warm) {
      hovering = false;
      closeHotspot();
    } else {
      if (!hotspot) build();
      const inside = nearBounds(layout.hot, point);
      if (inside !== hovering) {
        hovering = inside;
        if (hotspot && !hotspot.isDestroyed()) {
          hotspot.setIgnoreMouseEvents(!inside, { forward: true });
          hotspot.webContents.send("emma:notch-hover", inside);
        }
      }
    }
    hotspotTimer = setTimeout(poll, hotspotPollDelay(warm));
  };
  poll();
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function composeScreenContext(annotated: unknown) {
  if (!annotationFrame) throw new Error("Annotated screen frame is unavailable");
  if (!validJpegDataUrl(annotated)) throw new Error("Annotated screen is invalid");
  return compressScreenFrame(nativeImage.createFromDataURL(annotated)).image;
}

function restoreOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  overlay.focus();
  sendScreenContext();
}

function sendScreenContext() {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send("emma:screen-context", annotationAttachment.status());
}

async function frontApplication(): Promise<FrontApplication | undefined> {
  if (!isMac && !isWindows) return undefined;
  const source = await frontmostApplication().catch(() => undefined);
  return source?.application && ![app.getName(), "Electron"].includes(source.application) ? source : undefined;
}

async function frontContextNote(): Promise<string> {
  const front = await frontApplication();
  if (!front) return "";
  const tab = await frontmostTab(front.application).catch(() => undefined);
  const window = tab || !front.window || front.window === front.application ? "" : `, window “${front.window}”`;
  const page = tab ? ` The page open in it is “${tab.title || tab.url}” — ${tab.url}.` : "";
  return `The user opened Emma from “${front.application}”${window}.${page} When they say “this”, “this page”, “this video” or “what I'm looking at”, that is what they mean.`;
}

function closeAnnotation() {
  annotating = false;
  annotationFrame = null;
  if (annotation && !annotation.isDestroyed()) annotation.destroy();
  else restoreOverlay();
}

function startHost() {
  host?.close();
  credentials!.applyToEnv(process.env);
  host = new Host(binary("emma-host"));
}

function ownWindow(contents: Electron.WebContents | null): boolean {
  return !!contents && trustedSender(contents.getURL(), app.getAppPath(), process.env.EMMA_DEV_SERVER_URL);
}

function pageMayAsk(contents: Electron.WebContents | null, permission: string, kinds: string[]): boolean {
  if (!ownWindow(contents)) return false;
  if (permission === "clipboard-sanitized-write") return true;
  return permission === "media" && kinds.length > 0 && kinds.every((kind) => kind === "audio");
}

const memoryRoot = () => path.join(app.getPath("userData"), "memories");

function setupStatus(): SetupStatus {
  const mac = isMac;
  const mediaGranted = (type: "microphone" | "screen") => {
    try {
      const status = systemPreferences.getMediaAccessStatus(type);
      return status === "granted" ? true : status === "denied" || status === "restricted" ? false : null;
    }
    catch { return null; }
  };
  const vault = readVault(app.getPath("userData"));
  return {
    accessibility: mac ? systemPreferences.isTrustedAccessibilityClient(false) : isWindows ? null : true,
    screen: mac ? mediaGranted("screen") : isWindows ? mediaGranted("screen") : null,
    microphone: mac ? mediaGranted("microphone") : isWindows ? mediaGranted("microphone") : null,
    speech: isWindows || mac ? null : true,
    automation: isWindows || mac ? null : true,
    notifications: Notification.isSupported() ? (mac ? null : true) : false,
    files: vaultReady(vault),
    vault,
  };
}

const LOADER_ENV = /^(PATH|NODE_OPTIONS|NODE_PATH|npm_config_\w+|(DYLD|LD)_\w+|ELECTRON_RUN_AS_NODE|SHELL|IFS)$/i;

function credentialSlot(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider key request is invalid");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.env !== "string" || (candidate.secret !== undefined && typeof candidate.secret !== "string")) throw new Error("Provider key request is invalid");

  if (!isEnvName(candidate.env)) throw new Error("An environment variable name must start with a letter or underscore and hold only letters, digits, and underscores.");

  if (LOADER_ENV.test(candidate.env)) throw new Error("That environment variable controls how programs are loaded, so Emma will not hold it.");
  return { env: candidate.env, secret: candidate.secret as string | undefined };
}

function mainWindowSender(event: Electron.IpcMainInvokeEvent) {
  if (event.senderFrame !== event.sender.mainFrame || event.sender !== mainWindow?.webContents) throw new Error("Capability sender is not allowed");
}

function panelSender(event: Electron.IpcMainInvokeEvent) {
  if (event.senderFrame !== event.sender.mainFrame || event.sender !== overlay?.webContents) mainWindowSender(event);
}

function boundedCapabilityQuery(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.query !== "string" || candidate.query.length > 256) throw new Error(`${label} is invalid`);
  const rawLimit = candidate.limit;
  const limit = rawLimit === undefined ? 16 : rawLimit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SKILL_RESULTS) throw new Error(`${label} is invalid`);
  return { query: candidate.query, limit };
}

function boundedCapabilityId(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new Error(`${label} is invalid`);
  return value;
}

function gitRequest(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} request is invalid`);
  return value as Record<string, unknown>;
}

function gitCount(value: unknown, label: string) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_HISTORY * 10_000) throw new Error(`${label} is invalid`);
  return value;
}

function browserRequest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser request is invalid");
  const candidate = value as Record<string, unknown>;
  return { candidate, threadId: boundedCapabilityId(candidate.threadId, "Browser thread") };
}

function browserOpenRequest(value: unknown) {
  const { candidate, threadId } = browserRequest(value);
  if (typeof candidate.url !== "string" || !candidate.url.trim() || candidate.url.length > 2048) throw new Error("Browser address is invalid");
  return { threadId, url: candidate.url };
}

function browserTabRequest(value: unknown) {
  const { candidate, threadId } = browserRequest(value);
  if (typeof candidate.tabId !== "string" || !/^t[0-9]{1,6}$/.test(candidate.tabId)) throw new Error("Browser tab is invalid");
  return { threadId, tabId: candidate.tabId };
}

function browserPlaceRequest(value: unknown) {
  const { candidate, threadId } = browserRequest(value);
  const box = candidate.bounds;
  if (box === null || box === undefined) return { threadId, bounds: null };
  if (typeof box !== "object" || Array.isArray(box)) throw new Error("Browser bounds are invalid");
  const side = (key: "x" | "y" | "width" | "height") => {
    const found = (box as Record<string, unknown>)[key];
    if (typeof found !== "number" || !Number.isFinite(found) || Math.abs(found) > 100_000) throw new Error("Browser bounds are invalid");
    return Math.round(found);
  };
  return { threadId, bounds: { x: side("x"), y: side("y"), width: Math.max(0, side("width")), height: Math.max(0, side("height")) } };
}

function browserClipRequest(value: unknown) {
  const { candidate, threadId } = browserRequest(value);
  const index = candidate.index;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > 64) throw new Error("Clipboard item is invalid");
  return { threadId, index };
}

function browserNavRequest(value: unknown) {
  const { candidate, threadId } = browserRequest(value);
  const action = BROWSER_NAVIGATIONS.find((known) => known === candidate.action);
  if (!action) throw new Error("Browser navigation is invalid");
  return { threadId, action };
}

function terminalRequest(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Terminal request is invalid");
  return value as Record<string, unknown>;
}

function terminalSize(candidate: Record<string, unknown>) {
  const { columns, rows } = candidate;
  const valid = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_TERMINAL_COLUMNS;
  if (!valid(columns) || !valid(rows)) throw new Error("Terminal size is invalid");
  return { columns: columns as number, rows: rows as number };
}

function cliSendRequest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CLI send request is invalid");
  const candidate = value as Record<string, unknown>;
  const id = boundedCapabilityId(candidate.id, "CLI run");
  if (typeof candidate.prompt !== "string" || !candidate.prompt.trim() || candidate.prompt.length > MAX_CLI_PROMPT_CHARS) throw new Error("CLI send request is invalid");

  if (/^\s*-/.test(candidate.prompt)) throw new Error("A CLI turn is a prompt, not a flag.");
  return { id, prompt: candidate.prompt };
}

function recordedRevert(folderId: string, file: string): string {
  const recorded = agents!.list()
    .flatMap((agent) => agents!.changes(agent.threadId))
    .find((change) => change.folderId === folderId && change.path === file);
  if (!recorded || recorded.before === null) throw new Error("Only a file Emma rewrote can be reverted here.");
  return recorded.before;
}

const MAX_DIALOG_CHARS = 600;
let confirming = false;

async function confirmOnMac(message: string, detail: string, accept: string): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed() || confirming) return false;
  confirming = true;

  const clip = (text: string) => text.length > MAX_DIALOG_CHARS
    ? `${text.slice(0, MAX_DIALOG_CHARS)}\n\n… clipped. Cancel unless this is exactly what you asked for from your phone just now.`
    : text;
  try {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: `Approve on this ${DEVICE}`,
      message: clip(message),
      detail: clip(detail),
      buttons: ["Cancel", accept],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return choice.response === 1;
  } finally {
    confirming = false;
  }
}

function goalIpc(value: unknown): Record<string, unknown> & { threadId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Goal request is invalid");
  const request = value as Record<string, unknown>;
  return { ...request, threadId: boundedCapabilityId(request.threadId, "Goal thread") };
}

function boundedGoalText(value: unknown, label: string, max: number, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required`);
    return "";
  }
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const text = value.trim();
  if (required && !text) throw new Error(`${label} is required`);
  if (text.length > max) throw new Error(`${label} is longer than ${max} characters`);
  return text;
}

function wholeGoalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_GOAL_TOKEN_BUDGET) throw new Error(`${label} is invalid`);
  return value;
}

function threadMode(threadId: string): PermissionMode {
  return threadContexts.get(threadId)?.mode ?? DEFAULT_PERMISSION_MODE;
}

const threadModel = (threadId: string) => threadContexts.get(threadId)?.model ?? "";
const threadEffort = (threadId: string) => threadContexts.get(threadId)?.effort ?? "";
const MAX_AGENT_STEP_LIMIT = 10_000;
const threadStepLimit = (threadId: string) => threadContexts.get(threadId)?.stepLimit;
const threadContext = (threadId: string) => threadContexts.get(threadId) ?? { folderIds: [], mode: DEFAULT_PERMISSION_MODE, model: "" };

function keepThreadContext(threadId: string, next: { folderIds: string[]; mode: PermissionMode; model: string; effort?: ThinkingLevel; subagent?: SubagentRoute; review?: boolean; stepLimit?: number }) {
  const held = threadContexts.get(threadId);
  rememberThreadContext(threadId, { ...next, effort: next.effort ?? (held?.model === next.model ? held.effort : ""), review: next.review ?? held?.review, stepLimit: next.stepLimit ?? held?.stepLimit });
}
const threadSubagent = (threadId: string) => threadContexts.get(threadId)?.subagent;

function subagentRoute(candidate: Record<string, unknown>): SubagentRoute | undefined {
  const key = typeof candidate.subagentModel === "string" ? candidate.subagentModel : "";
  const model = key.startsWith("openrouter:") ? key.slice("openrouter:".length).slice(0, 128) : "";
  if (!model) return undefined;
  const effort = candidate.subagentEffort;
  return { model, effort: isThinkingLevel(effort) && effort !== "" ? effort : "" };
}

function threadContextRequest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Thread context request is invalid");
  const candidate = value as Record<string, unknown>;
  const threadId = boundedCapabilityId(candidate.threadId, "Thread context thread");
  const raw = Array.isArray(candidate.folderIds) ? candidate.folderIds.slice(0, 1) : [];
  const model = typeof candidate.model === "string" ? candidate.model.slice(0, 128) : "";
  if (candidate.effort !== undefined && !isThinkingLevel(candidate.effort)) throw new Error("Thread context request is invalid");
  const stepLimit = Math.round(Number(candidate.stepLimit) || 0);
  return { threadId, folderIds: raw.map((id) => boundedCapabilityId(id, "Thread folder")), mode: asPermissionMode(candidate.mode), model, effort: candidate.effort, subagent: subagentRoute(candidate), review: typeof candidate.review === "boolean" ? candidate.review : undefined, stepLimit: stepLimit > 0 ? Math.min(stepLimit, MAX_AGENT_STEP_LIMIT) : undefined };
}

function agentMessage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Agent message is invalid");
  const candidate = value as Record<string, unknown>;
  const threadId = boundedCapabilityId(candidate.threadId, "Agent message thread");
  if (typeof candidate.text !== "string" || !candidate.text.trim() || candidate.text.length > 4096) throw new Error("Agent message is invalid");
  return { threadId, text: candidate.text };
}

function forceArmRequest(value: unknown): { threadId: string; arm: Arm } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Arm request is invalid");
  const candidate = value as Record<string, unknown>;
  const threadId = boundedCapabilityId(candidate.threadId, "Arm thread");
  if (candidate.arm !== "a" && candidate.arm !== "b") throw new Error("Arm request is invalid");
  return { threadId, arm: candidate.arm };
}

function reportRunProgress(progress: ComputerRunProgress) {
  computerProgress = progress;
  if (runBanner && !runBanner.isDestroyed()) runBanner.webContents.send("emma:computer-run-progress", progress);
  if (progress.cursor === undefined) return;
  computerCursorOwner = "computer";
  computerCursorHeld = false;
  computerCursorProgress = progress;
  computerCursorAt = Date.now();
  showComputerCursor();
}

function reportBrowserCursor(progress: ComputerRunProgress | null) {
  if (!progress) {
    if (computerCursorOwner !== "browser" || !computerCursorHeld) return;
    computerCursorHeld = false;
    computerCursorAt = Date.now();
    showComputerCursor();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) return;
  openComputerCursor();
  computerCursorOwner = "browser";
  computerCursorHeld = true;
  computerCursorProgress = progress;
  computerCursorAt = Date.now();
  showComputerCursor();
}

function showComputerCursor() {
  clearTimeout(computerCursorTimer);
  const window = computerCursorWindow;
  if (!window || window.isDestroyed()) return;
  const progress = computerCursorProgress;
  const remaining = computerCursorHeld ? COMPUTER_CURSOR_MS : COMPUTER_CURSOR_MS - (Date.now() - computerCursorAt);
  const cursor = progress?.cursor && roundComputerCursor(progress.cursor);
  const browsing = computerCursorOwner === "browser";
  const above = browsing ? mainWindow?.getMediaSourceId() : cursor && `window:${cursor.windowId}:0`;
  if ((!browsing && !computerRuntime?.active) || !computerCursorReady || !cursor || !above || remaining <= 0) {
    window.hide();
    return;
  }
  try {
    const bounds = isWindows ? screen.screenToDipRect(null, cursor.bounds) : cursor.bounds;
    window.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
    window.webContents.send("emma:computer-run-progress", { ...progress, cursor });
    window.showInactive();
    window.moveAbove(above);
    if (!computerCursorHeld) computerCursorTimer = setTimeout(() => { if (!window.isDestroyed()) window.hide(); }, remaining);
  } catch {
    window.hide();
  }
}

const BRIDGE_EVENTS: Record<string, (payload: unknown) => BridgeEvent> = {
  "emma:changed": () => ({ k: "evt", t: "invalidate", what: "snapshot" }),
  "emma:artifacts-changed": () => ({ k: "evt", t: "invalidate", what: "artifacts" }),
  "emma:plans-changed": () => ({ k: "evt", t: "invalidate", what: "plans" }),
  "emma:task-lists-changed": () => ({ k: "evt", t: "invalidate", what: "taskLists" }),
  "emma:notes-changed": () => ({ k: "evt", t: "invalidate", what: "notes" }),
  "emma:components-changed": () => ({ k: "evt", t: "invalidate", what: "components" }),
  "emma:tools-changed": () => ({ k: "evt", t: "invalidate", what: "tools" }),
  "emma:cli-runs": () => ({ k: "evt", t: "invalidate", what: "cliRuns" }),
  "emma:background": () => ({ k: "evt", t: "invalidate", what: "background" }),
  "emma:scheduled-jobs": () => ({ k: "evt", t: "invalidate", what: "scheduledJobs" }),
  "emma:delta": (payload) => ({ k: "evt", ...(payload as { threadId: string; delta: string; thinking?: boolean }), t: "delta" }),
  "emma:step": (payload) => ({ k: "evt", t: "step", step: phoneStep(payload as RemoteStep) }),
  "emma:agents": (payload) => ({ k: "evt", t: "agents", agents: payload as LiveAgent[] }),
  "emma:spans": (payload) => ({ k: "evt", t: "spans", spans: phoneSpans(payload as Record<string, TraceSpan[]>) }),
  "emma:context-experiment": (payload) => ({ k: "evt", ...(payload as { threadId: string; prunedResults: number; reinjected: boolean; savedTokens: number; addedTokens: number }), t: "context-experiment" }),
  "emma:context-breakdown": (payload) => ({ k: "evt", ...(payload as { threadId: string; systemPromptBytes: number; systemToolsBytes: number; mcpToolsBytes: number; skillsBytes: number; memoryBytes: number }), t: "context-breakdown" }),
};

function broadcast(channel: string, payload?: unknown) {
  if (bridge?.sending() && Object.hasOwn(BRIDGE_EVENTS, channel)) bridge.event(BRIDGE_EVENTS[channel](payload));
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

const CHANGED_COALESCE_MS = 150;
const READ_ONLY_METHODS = new Set(["snapshot", "threadSummaries", "thread", "listOpenRouterModels"]);

const SCHEDULED_JOB_WRITES = new Set(["saveScheduledJob", "deleteScheduledJob", "runScheduledJob", "setScheduledJobEnabled"]);
const scheduledJobsChanged = () => broadcast("emma:scheduled-jobs");
let changedAt = 0;
let changedQueued: ReturnType<typeof setTimeout> | undefined;

function changed() {
  const since = Date.now() - changedAt;
  if (since >= CHANGED_COALESCE_MS) {
    changedAt = Date.now();
    broadcast("emma:changed");
    return;
  }
  if (changedQueued) return;
  changedQueued = setTimeout(() => {
    changedQueued = undefined;
    changedAt = Date.now();
    broadcast("emma:changed");
  }, CHANGED_COALESCE_MS - since);
  changedQueued.unref();
}

function threadFolder(threadId: string): string | undefined {
  const [id] = threadFolderIds(threadId);
  return id && folders!.list().some((grant) => grant.id === id) ? id : undefined;
}

function grantFor(threadId: string, named: string | undefined): string {
  const vault = named ? folders!.list().find((grant) => grant.id === vaultFolderId) : undefined;
  if (vault && (named === vault.name || named === vault.id)) return vault.id;
  const id = threadFolder(threadId);
  if (!id) throw new Error("No folder is connected to this thread. Connect one from the ＋ menu.");
  const grant = folders!.list().find((folder) => folder.id === id)!;
  if (named && named !== grant.name && named !== grant.id) {
    throw new Error(`This thread works in "${grant.name}", and nothing outside it is reachable from here. Drop the folder argument, or ask the user to open "${named}" in a thread of its own.`);
  }
  return id;
}

function folderNames(ids: string[]): string[] {
  return folders!.list().filter((grant) => ids.includes(grant.id)).map((grant) => grant.name);
}

let vaultFolderId: string | undefined;
let tagger: TaggerSettings = defaultTagger;
let pickedVaultRoot: string | undefined;

function connectVault(vault: VaultChoice) {
  try {
    const root = realpathSync(vault.root);
    vaultFolderId = folders!.add(root).find((grant) => samePath(grant.path, root))?.id;
  } catch (error) {
    console.error("Emma: could not connect the vault folder", error);
  }
}

function visibleFolders() {
  return folders!.list().filter((grant) => grant.id !== vaultFolderId);
}

const obsidianVaults = (): VaultChoice[] =>
  detectObsidianVaults().map((found) => ({ root: found.path, folder: DEFAULT_VAULT_FOLDER, kind: "obsidian", name: found.name }));

const notesChanged = () => broadcast("emma:notes-changed");

function notesOrNone(vault: VaultChoice | null): KeptNote[] {
  try {
    return vault ? listNotes(vault) : [];
  } catch {
    return [];
  }
}

async function clipForKeep(url: string | undefined, hideOverlay: boolean) {
  if (url) return await clipPage({ application: "", url });
  if (!hideOverlay || !overlay || overlay.isDestroyed()) return await clipPage(await frontmostPage());
  closeRadial();
  capturing = true;
  overlay.hide();
  let front;
  try {
    await pause(150);
    front = await frontmostPage();
  } finally {
    if (!overlay.isDestroyed()) overlay.show();
    capturing = false;
  }
  return await clipPage(front);
}

async function keep(request: KeepRequest, hideOverlay: boolean): Promise<KeptNote> {
  const vault = readVault(app.getPath("userData"));
  if (!vault) throw new Error("Emma has nowhere to keep this yet. Choose an Obsidian vault or a folder on the Knowledge base page, then keep it again.");
  let filled = request;
  if (request.kind === "page" && !request.text) {
    const clip = await clipForKeep(request.sourceUrl, hideOverlay);
    filled = {
      kind: "page",
      title: request.title || clip.title,
      text: clip.text,
      sourceUrl: clip.url,
      ...(clip.application ? { sourceApplication: clip.application } : {}),
    };
  }
  const note = await keepNote(vault, filled);
  notesChanged();
  void tagKeptNote(note, filled.text ?? "");
  return note;
}

async function keepScreen(id: string): Promise<KeptNote> {
  const vault = readVault(app.getPath("userData"));
  if (!vault) throw new Error("Emma has nowhere to keep this yet. Choose an Obsidian vault or a folder on the Knowledge base page, then keep it again.");
  const shot = annotationAttachment.claim(id);
  let kept = false;
  try {
    const application = shot.source?.application ?? "";
    const tab = application ? await frontmostTab(application).catch(() => undefined) : undefined;
    const text = await describeScreen(toolSettings.vision, shot.image, { application, window: shot.source?.window ?? "", ...(tab ? { url: tab.url, title: tab.title } : {}) });
    const note = await keepNote(vault, {
      kind: "screenshot",
      title: tab?.title || shot.source?.window || application || "Screen",
      text,
      image: shot.image,
      ...(tab?.url ? { sourceUrl: tab.url } : {}),
      ...(application ? { sourceApplication: application } : {}),
    });
    kept = true;
    notesChanged();
    void tagKeptNote(note, text);
    return note;
  } finally {
    annotationAttachment.finish(id, kept);
    sendScreenContext();
  }
}

async function keepTool(args: Extract<ToolArgs, { name: "keep" }>): Promise<string> {
  const note = await keep({
    kind: args.kind,
    ...(args.title ? { title: args.title } : {}),
    ...(args.text ? { text: args.text } : {}),
    ...(args.url ? { sourceUrl: args.url } : {}),
  }, false);
  return `Kept “${note.title}” as ${note.relative}. Its title and tags are being written now, in the background, so do not keep this again. Say what it covers rather than repeating the steps.`;
}

async function tagKeptNote(note: KeptNote, body: string) {
  try {
    const tagged = await tagNote(note, body, tagger);
    if (tagged) applyNoteTags(note.path, tagged.title, tagged.tags);
    else console.warn(`The tagger returned no title or tags for ${note.relative}, so it keeps the title it was saved under.`);
    fireEvent("note-kept", { title: tagged?.title ?? note.title, tags: (tagged?.tags ?? note.tags).join(", ") });
  } catch (error) {
    console.error(`Could not tag ${note.relative}:`, error);
  } finally {
    notesChanged();
  }
}

function held(attachment: Attachment): Attachment & { thumbnail?: string } {
  if (!isImageAttachment(attachment.name)) return attachment;
  const frame = nativeImage.createFromPath(attachment.path);
  return frame.isEmpty() ? attachment : { ...attachment, thumbnail: frame.resize({ height: 112 }).toDataURL() };
}

const PREVIEW_IMAGE_WIDTH = 1600;

function previewImage(file: string): string | null {
  const frame = nativeImage.createFromPath(file);
  if (frame.isEmpty()) return null;
  return (frame.getSize().width > PREVIEW_IMAGE_WIDTH ? frame.resize({ width: PREVIEW_IMAGE_WIDTH }) : frame).toDataURL();
}

function grantedImage(threadId: string, named: string | undefined, given: string): string {
  if (attachments!.holds(given)) return given;
  return folders!.fileWithin(grantFor(threadId, named), given);
}

function folderImage(threadId: string, named: string | undefined, relative: string): string {
  const frame = nativeImage.createFromPath(grantedImage(threadId, named, relative));
  if (frame.isEmpty()) throw new Error(`Emma could not read ${relative} as an image. PNG, JPEG, GIF and BMP work; a PDF, an SVG or a missing file does not.`);
  try {
    return compressScreenFrame(frame).image;
  } catch {
    throw new Error(`${relative} could not be shrunk small enough to send. Save a smaller copy and look at that.`);
  }
}

const shotFile = (extension: string) => path.join(app.getPath("temp"), `emma-shot-${randomUUID()}.${extension}`);

function shownToUser(file: string, said: string): string {
  if (!existsSync(file)) throw new Error("Emma could not save that screenshot.");
  const held = attachments!.hold(file);
  return `${said} It is saved at ${held.path}. Show it to the user by writing ![a short description](${held.path}) on its own line in your answer — that draws the picture in the conversation. You cannot see it yourself; look_at_image reads it if you need to know what is in it.`;
}

function ensureComputerRun(threadId: string) {
  if (!computerRuntime!.threadId) computerRuntime!.start(threadId);
  if (computerRuntime!.threadId !== threadId) throw new Error("Another thread owns the computer run. Wait for it to finish.");
}

async function reportContext(turn: TurnRequest, compact: boolean): Promise<string> {
  const window = contextWindowFor(turn.model) ?? 0;
  const live = agents!.list().find((agent) => agent.threadId === turn.threadId)?.inputTokens ?? 0;
  const thread = await host!.request({ method: "thread", params: { threadId: turn.threadId } }).catch(() => undefined) as {
    messages?: { generation?: { inputTokens?: number } | null }[];
  } | undefined;
  const messages = thread?.messages ?? [];
  const landed = messages.reduce((last, message) => message.generation?.inputTokens || last, 0);
  const used = live || landed;
  const carried = `${used.toLocaleString()} tokens went into ${live ? "this turn so far" : "the last turn"}`;
  const head = !used
    ? `Nothing has been sent on this thread yet${window ? `. The window is ${window.toLocaleString()} tokens.` : ", and this route does not report its context window."}`
    : window
      ? `${carried}, of a ${window.toLocaleString()}-token window — ${Math.round((used / window) * 100)}% of it.`
      : `${carried}. This route does not report its context window, so there is no share to give.`;
  if (!compact) return head;
  compactNext.add(turn.threadId);
  return `${head}\n\nCompaction is set for your next turn: everything before the most recent turn becomes one summary. This turn keeps the history it started with, so finish here — say in one line what you compacted, and stop.`;
}

const browserPage = (status: BrowserStatus) => `${status.url ?? "about:blank"}${status.title ? ` — ${status.title}` : ""}`;

async function executeTool(args: ToolArgs, turn: TurnRequest): Promise<string> {
  switch (args.name) {
    case "cli": {
      if (args.action === "send" && clis.get(args.id!)?.threadId !== turn.threadId) throw new Error("Choose a CLI run in this thread.");
      const run = args.action === "run"
        ? await clis.start({
          threadId: turn.threadId,
          cli: args.cli!,
          prompt: args.prompt!,
          fromRuns: args.fromRuns,
          ...cliOptions(args),
          cwd: folders!.directory(grantFor(turn.threadId, args.folder)),
          folder: folderNames([grantFor(turn.threadId, args.folder)])[0] ?? "",
          unattended: args.unattended,
        })
        : await clis.send(args.id!, args.prompt!, args.fromRuns, cliOptions(args));
      const read = clis.output(run.id, MAX_COMMAND_OUTPUT);
      const harness = cliHarness(run.cli);
      const caveat = harness && !harness.ownsSession && args.action === "run"
        ? ` ${harness.label} resumes by "most recent session in this folder" rather than by id, so keep one ${run.cli} run going at a time here.`
        : "";
      return `${run.cli} run ${run.id} finished turn ${run.turns} (${run.status === "failed" ? `failed, exit ${run.exitCode ?? "unknown"}` : `exit ${run.exitCode ?? "?"}`}). Send it more with cli {"action":"send","id":"${run.id}","prompt":"…"}.${caveat}\n\n${(run.status === "failed" ? read?.output : read?.result)?.trim() || "(no output)"}`;
    }
    case "cli_runs": {
      if (args.cli) {
        const harness = cliHarness(args.cli)!;
        const catalog = await cliModels.read(args.cli, (id) => clis.where(id), args.refresh);
        return JSON.stringify({ ...catalog, efforts: harness.efforts, effortLabel: harness.effortLabel ?? "Thinking", note: "Model support depends on the installed harness and account. Use exact ids; never silently substitute a model or effort. OpenCode also accepts configured variant names. Empty model or effort uses the harness default." });
      }
      if (!args.id) {
        const installed = await clis.installed();
        const available = installed.length
          ? installed.map((item) => `${item.id} — ${item.label} at ${item.path}`).join("\n")
          : "None of the CLIs Emma knows are installed on this computer.";
        return `Installed CLIs:\n${available}\n\nRuns:\n${describeRuns(clis.list())}`;
      }
      if (args.stop) {
        return clis.stop(args.id)
          ? `Stopped the turn ${args.id} was working on.`
          : `${args.id} is not working on a turn right now. ${describeRuns(clis.list())}`;
      }
      const read = clis.output(args.id, MAX_COMMAND_OUTPUT);
      if (!read) return `There is no CLI run called ${args.id}. ${describeRuns(clis.list())}`;
      const state = read.run.status === "running" ? `still working on turn ${read.run.turns}` : `${read.run.status} after ${read.run.turns} ${read.run.turns === 1 ? "turn" : "turns"} (exit ${read.run.exitCode ?? "?"})`;
      return `${args.id} is ${state}.\n\n${read.output.trim() || "(no output yet)"}`;
    }
    case "computer": {
      ensureComputerRun(turn.threadId);
      const said = await computerRuntime!.execute(turn.threadId, args.args, async (target, signal) => {
        const allowed = await agents!.question({
          threadId: turn.threadId,
          tool: "computer",
          summary: `Allow Emma to use ${target.name}?`,
          detail: `${target.id}\n${target.path}\nProcess ${target.pid}\n\nAllow Emma to read and control this app in the background for this turn. Delegated agents cannot use this grant. Other apps require their own approval. Access ends when this turn ends or you press Stop. Application text is sent to this turn's model; screenshots and the clipboard are not used.`,
        }, { humanOnly: true, signal });
        if (allowed && !signal.aborted) openRunBanner(turn.threadId, `${target.name} · background app control`);
        return allowed;
      });
      return said;
    }
    case "shortcut":
      return await saveShortcutFromTool(args);
    case "browser": {
      if (args.action !== "close") {
        broadcast("emma:browser-show", { threadId: turn.threadId });
        openComputerCursor();
      }
      if (args.action === "open") return `Opened ${browserPage(await browsers.open(turn.threadId, args.url!))}. Snapshot it to see what is on it.`;
      const doing = describeToolCall(args);
      if (args.action === "screenshot") {
        const file = shotFile("png");
        await browsers.run(turn.threadId, ["screenshot", ...(args.selector ? [args.selector] : []), file], doing);
        return shownToUser(file, "Took a screenshot of the page.");
      }
      const navigation = BROWSER_NAVIGATIONS.find((candidate) => candidate === args.action);
      if (!navigation) return await browsers.run(turn.threadId, browserArgv(args), doing);
      const status = await browsers.navigate(turn.threadId, navigation);
      return navigation === "close" ? "Closed this thread's browser." : `Now on ${browserPage(status)}.`;
    }
    case "write_skill": {
      const skill = await writeLearnedSkill(app.getPath("userData"), args.skill, args.instructions);
      await toolsChanged();
      return `Saved the skill "${skill.name}". Future runs can find it by name.`;
    }
    case "write_tool": {
      const tool = await writeEmmaTool(app.getPath("userData"), args.tool, args.description, args.code);
      await toolsChanged();
      return `Saved the tool "${tool.name}". Run it with run_tool {"name":"${tool.name}","input":"…"}, in this thread or any later one.`;
    }
    case "write_plugin": {
      const { plugin } = await writePlugin(app.getPath("userData"), args.plugin);
      await toolsChanged();
      const names = plugin.skills.map((skill) => skill.name).join(", ");
      return `Packaged and installed the plugin "${plugin.name}" at ${plugin.root}. It carries ${plugin.skills.length} ${plugin.skills.length === 1 ? "skill" : "skills"} (${names}), usable by name from the next turn. It is listed on the Plugins page under "Written by Emma".`;
    }
    case "run_tool": {
      const disabled = toolSettings.disabledTools;
      const tools = (await listEmmaTools(app.getPath("userData"))).filter((tool) => !disabled.includes(`run_tool:${tool.name}`));
      const listing = tools.length
        ? `Your tools:\n${tools.map((tool) => `${tool.name} — ${tool.description}`).join("\n")}`
        : "You have not written any tools yet. write_tool makes one.";
      if (!args.tool) return listing;
      const match = tools.find((tool) => tool.name === args.tool);
      if (!match) throw new Error(`There is no tool called "${args.tool}". ${listing}`);
      const attached = threadFolder(turn.threadId);
      const cwd = attached ? folders!.directory(attached) : path.dirname(match.run);
      return await runWrittenTool(cwd, match.run, args.input ?? "");
    }
    case "memory":
      return await runMemoryCommand(memoryRoot(), args.command);
    case "vision": {
      const image = args.url ? publicUrl(args.url)?.href : folderImage(turn.threadId, args.folder, args.path!);
      if (!image) throw new Error("That is not a public image URL. Use a path in a connected folder for a file on this computer.");
      return await look(toolSettings.vision, image, args.question);
    }
    case "secret": {
      const attached = threadFolder(turn.threadId);
      const output = await runCommand(attached ? folders!.directory(attached) : homedir(), args.command);
      return await readSecret(toolSettings.secret, args.command, output, args.question);
    }
    case "task_list":
      return await taskListTool(args, turn);
    case "plan":
      return await planTool(args, turn);
    case "goal":
      return await goalTool(args, turn);
    case "context":
      return await reportContext(turn, args.compact);
    case "keep":
      return await keepTool(args);
    case "web_search": {
      const response = await webSearch(toolSettings.webSearch, args.query, args.limit, (credentialEnv) => process.env[credentialEnv] || "");
      return renderResults(args.query, response);
    }
    case "install_mcp": {
      const { id } = await capabilities!.installMcpServer({ name: args.server, command: args.command, args: args.argv, env: args.env });
      await toolsChanged();
      return `Installed "${args.server}" (${id}) into Emma's configuration — the harness connects it when the next turn starts, and its tools are found from then on with mcp_search_tools.`;
    }
    case "workflow":
      return await workflowTool(args);
    case "artifact":
      return await artifactTool(args, turn.threadId);
    case "component":
      return await componentTool(args, turn.threadId);
    case "visualize":
      return `${visualMarker(keepVisual({ title: args.title, html: args.html }))} Drawn in the conversation, under the answer you are writing. Do not repeat in prose what it already shows.`;
  }
}

function goalRequest(method: string, params: Record<string, string>): Promise<ThreadRecord | undefined> {
  return host!.request({ method, params }).then((thread) => {
    const noted = noteThread(thread);
    changed();
    return noted;
  });
}

async function setGoal(request: Record<string, unknown> & { threadId: string }): Promise<ThreadRecord | undefined> {
  const objective = boundedGoalText(request.objective, "Goal objective", MAX_GOAL_OBJECTIVE_CHARS, true);
  const budget = wholeGoalNumber(request.tokenBudget, "Goal token budget");
  const thread = await goalRequest("setGoal", { threadId: request.threadId, objective, tokenBudget: String(budget ?? DEFAULT_GOAL_TOKEN_BUDGET) });
  if (thread?.title === DEFAULT_THREAD_TITLE) {
    await host!.request({ method: "renameThread", params: { threadId: request.threadId, title: goalTitle(objective) } }).catch(() => undefined);
    changed();
  }
  return thread;
}

async function updateGoal(request: Record<string, unknown> & { threadId: string }): Promise<ThreadRecord | undefined> {
  if (request.status !== undefined && !isGoalStatus(request.status)) throw new Error("Goal status is invalid");
  const extra = wholeGoalNumber(request.extraTokens, "Goal extra tokens");
  if (request.status === undefined && extra === undefined) throw new Error("A goal update needs a status or extra tokens");
  const updated = await goalRequest("updateGoal", {
    threadId: request.threadId,
    ...(request.status === undefined ? {} : { status: request.status }),
    evidence: boundedGoalText(request.evidence, "Goal evidence", MAX_GOAL_EVIDENCE_CHARS, false),
    reason: boundedGoalText(request.reason, "Goal blocker", MAX_GOAL_REASON_CHARS, false),
    ...(extra === undefined ? {} : { extraTokens: String(extra) }),
  });
  goalStopped.delete(request.threadId);
  agents?.forget(request.threadId);
  if (goalPursuing(goals.get(request.threadId)) && !goalHalted(request.threadId)) {
    void driveTurn({
      threadId: request.threadId,
      content: GOAL_CONTINUATION,
      mode: threadMode(request.threadId),
      title: updated?.title || "This thread",
      model: threadModel(request.threadId),
    }).catch((error: unknown) => console.error("Emma: a resumed goal could not start", error));
  }
  return updated;
}

async function goalTool(args: Extract<ToolArgs, { name: "goal" }>, turn: TurnRequest): Promise<string> {
  const threadId = turn.parentThreadId ?? turn.threadId;
  switch (args.action) {
    case "get":
      return goalResult("get", threadId, goals.get(threadId));
    case "set": {
      const thread = await goalRequest("setGoal", { threadId, objective: args.objective!, tokenBudget: String(args.tokenBudget ?? DEFAULT_GOAL_TOKEN_BUDGET) });
      if (thread?.title === DEFAULT_THREAD_TITLE) {
        await host!.request({ method: "renameThread", params: { threadId, title: goalTitle(args.objective!) } }).catch(() => undefined);
        changed();
      }
      return goalResult("set", threadId, goals.get(threadId));
    }
    case "update": {
      await goalRequest("updateGoal", { threadId, status: args.status!, evidence: args.evidence ?? "", reason: args.reason ?? "" });
      return goalResult("update", threadId, goals.get(threadId));
    }
    case "extend": {
      await goalRequest("updateGoal", { threadId, extraTokens: String(args.extraTokens) });
      return goalResult("extend", threadId, goals.get(threadId));
    }
    case "clear": {
      await goalRequest("clearGoal", { threadId });
      return goalResult("clear", threadId, undefined);
    }
  }
}

function describeTaskList(list: TaskList): string {
  const { completed, total } = taskListProgress(list);
  return `${list.id} — ${list.title} — ${completed}/${total} tasks — ${taskListState(list).replace("_", " ")}`;
}

async function taskListTool(args: Extract<ToolArgs, { name: "task_list" }>, turn: TurnRequest): Promise<string> {
  const userData = app.getPath("userData");
  switch (args.action) {
    case "read": {
      if (!args.id) {
        const lists = await listTaskLists(userData);
        if (!lists.length) return 'There are no task lists yet. Start complex work with task_list {"action":"write","title":"…","tasks":"[…]"}.';
        return `Task lists:\n${lists.map(describeTaskList).join("\n")}`;
      }
      const list = await readTaskList(userData, args.id);
      return `${describeTaskList(list)}\n\n${renderTaskList(list)}`;
    }
    case "write": {
      const { tasks, errors } = parseTaskListTasks(args.tasks!);
      if (errors.length) throw new Error(`Nothing was written. Fix these and send it again:\n${errors.join("\n")}`);
      const previous = args.id ? await readTaskList(userData, args.id).catch(() => undefined) : undefined;
      const owner = turn.parentThreadId ?? turn.threadId;
      const merged = mergeTaskList(previous, { id: args.id ?? "", title: args.title!, goal: args.goal ?? previous?.goal ?? "", tasks, updatedAt: "", threadId: owner });
      const saved = await writeTaskList(userData, { ...merged, id: previous?.id });
      taskListsChanged();
      return `${previous ? "Rewrote" : "Wrote"} the task list "${saved.title}" (${saved.id}) with ${flattenTaskListTasks(saved.tasks).length} tasks. Keep it current with task_list update; the user can watch it in this thread's Tasks widget.`;
    }
    case "update": {
      const list = await editTaskList(userData, args.id!, (current) => {
        const updated = updateTaskListStatus(current.tasks, args.task!, args.status!);
        if (!updated.found) throw new Error(`There is no task called "${args.task}" in "${current.title}".`);
        return { ...current, tasks: updated.tasks };
      });
      taskListsChanged();
      const progress = taskListProgress(list);
      return `${args.task} in "${list.title}" is ${args.status}; ${progress.completed}/${progress.total} tasks completed.`;
    }
    case "delete": {
      const list = await readTaskList(userData, args.id!);
      await deleteTaskList(userData, list.id);
      taskListsChanged();
      return `Deleted the task list "${list.title}".`;
    }
  }
}

function describePlan(plan: Plan): string {
  const { done, steps, doneTasks, tasks } = planProgress(plan);
  const running = plan.steps.filter((step) => step.status === "running").map((step) => step.id);
  const failed = plan.steps.filter((step) => step.status === "failed").map((step) => step.id);
  return `${plan.id} — ${plan.title} — ${done}/${steps} steps, ${doneTasks}/${tasks} tasks`
    + (running.length ? ` — running: ${running.join(", ")}` : "")
    + (failed.length ? ` — failed: ${failed.join(", ")}` : "");
}

async function planTool(args: Extract<ToolArgs, { name: "plan" }>, turn: TurnRequest): Promise<string> {
  const userData = app.getPath("userData");
  switch (args.action) {
    case "read": {
      if (!args.id) {
        const plans = await listPlans(userData);
        if (!plans.length) return 'There are no plans yet. Write one with plan {"action":"write","title":"…","steps":"[…]"} when a job is worth more than one subagent.';
        return `Plans:\n${plans.map(describePlan).join("\n")}`;
      }
      const plan = await readPlan(userData, args.id);
      const problems = planProblems(plan);
      return `${describePlan(plan)}\n\n${renderPlan(plan)}${problems.length ? `\nProblems with it:\n${problems.join("\n")}` : ""}`;
    }
    case "write": {
      const { steps, errors } = parsePlanSteps(args.steps!);
      if (errors.length) throw new Error(`Nothing was written. Fix these and send it again:\n${errors.join("\n")}`);
      const previous = args.id ? await readPlan(userData, args.id).catch(() => undefined) : undefined;
      const owner = turn.parentThreadId ?? turn.threadId;
      const merged = mergePlan(previous, { id: args.id ?? "", title: args.title!, goal: args.goal ?? previous?.goal ?? "", steps, updatedAt: "", threadId: owner });
      const saved = await writePlan(userData, { ...merged, id: previous?.id });
      plansChanged();
      const problems = planProblems(saved);
      const wave = readySteps(saved);
      return `${previous ? "Rewrote" : "Wrote"} the plan "${saved.title}" (${saved.id}) — ${saved.steps.length} ${saved.steps.length === 1 ? "step" : "steps"}, and the user can watch it in this thread's inspector.\n`
        + (problems.length ? `Problems with it:\n${problems.join("\n")}\n` : "")
        + (wave.length
          ? `Ready to go now, in parallel: ${wave.map((step) => step.id).join(", ")}. Start them with plan {"action":"run","id":"${saved.id}"}.`
          : "Nothing is ready to run — every step waits on another one.");
    }
    case "run": {
      const plan = await readPlan(userData, args.id!);
      const ready = readySteps(plan);
      const live = plan.steps.filter((step) => step.status === "running").length;
      const wave = ready.slice(0, Math.max(0, MAX_LIVE_SUBAGENTS - live));
      if (!wave.length) {
        const left = plan.steps.filter((step) => step.status !== "done");
        if (!left.length) return `Every step of "${plan.title}" is done. Tell the user what it added up to.`;
        const running = left.filter((step) => step.status === "running");
        if (running.length) return `${running.map((step) => step.id).join(", ")} ${running.length === 1 ? "is" : "are"} still marked running in "${plan.title}". Wait for each with subagent {"command":{"inspect":{"id":"<the id create gave you>","sections":["status","messages"],"wait":{"until":"settled","timeout_ms":60000}}}} rather than re-reading the plan, or set one failed with plan update if it will not finish.`;
        return `Nothing in "${plan.title}" can start: ${left.map((step) => `${step.id} waits on ${step.needs.join(", ") || "nothing, yet is not todo"}`).join("; ")}.\n${planProblems(plan).join("\n")}`;
      }
      await editPlan(userData, plan.id, (current) => ({
        ...current,
        steps: current.steps.map((step) => wave.some((item) => item.id === step.id) ? { ...step, status: "running" as const } : step),
      }));
      plansChanged();
      return `${wave.length} ${wave.length === 1 ? "step" : "steps"} of "${plan.title}" ${wave.length === 1 ? "is" : "are"} marked running. `
        + `Spawn one subagent per brief below, all in one message, with subagent {"command":{"create":{"name":"<step id>","mode":"one_off","prompt":"<that step's whole brief>"}}}. `
        + `Then wait for each with subagent {"command":{"inspect":{"id":"<the id create gave you>","sections":["status","messages"],"wait":{"until":"settled","timeout_ms":60000}}}} — 60000 is the ceiling, so inspect again when one comes back wait_timed_out — `
        + `and write what it answered back with plan {"action":"update","id":"${plan.id}","step":"<step id>","status":"done","result":"<its answer in one line>"} — status "failed" for one that did not finish.\n\n`
        + wave.map((step) => `### ${step.id}\n${towardGoal(turn, stepBrief(plan, step))}`).join("\n\n")
        + (ready.length > wave.length ? `\n\n${ready.length - wave.length} more were ready but held back — at most ${MAX_LIVE_SUBAGENTS} steps run at once.` : "")
        + `\n\nRecord each one as it lands and ask plan {"action":"run","id":"${plan.id}"} again straight away: whatever its result released starts then, without waiting for the rest of these.`;
    }
    case "update": {
      const plan = await editPlan(userData, args.id!, (current) => {
        const step = current.steps.find((item) => item.id === args.step);
        if (!step) throw new Error(`There is no step called "${args.step}" in "${current.title}". Its steps are ${current.steps.map((item) => item.id).join(", ") || "none"}.`);
        const tasks = [...step.tasks];
        if (args.check !== undefined) {
          const at = Math.abs(args.check) - 1;
          if (!tasks[at]) throw new Error(`Step "${step.id}" has ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}, so there is no task ${Math.abs(args.check)}.`);
          tasks[at] = { ...tasks[at], done: args.check > 0 };
        }
        return {
          ...current,
          steps: current.steps.map((item) => item.id !== step.id ? item : {
            ...item,
            tasks,
            status: args.status ?? item.status,
            result: args.result ?? item.result,
          }),
        };
      });
      plansChanged();
      const step = plan.steps.find((item) => item.id === args.step)!;
      const ticked = step.tasks.filter((task) => task.done).length;
      const blocked = plan.steps.filter((item) => item.status !== "done" && item.needs.includes(step.id));
      return `${step.id} in "${plan.title}" is ${step.status}, ${ticked}/${step.tasks.length} tasks ticked.`
        + (step.status === "failed" && blocked.length
          ? ` ${blocked.map((item) => item.id).join(", ")} waited on it and can never start now, nor can anything after them. Rewrite the plan with plan {"action":"write","id":"${plan.id}",…} around what went wrong — drop those steps, replace them, or route past them. The result line you just wrote is the only record of why.`
          : "");
    }
    case "delete": {
      const plan = await readPlan(userData, args.id!);
      await deletePlan(userData, plan.id);
      plansChanged();
      return `Deleted the plan "${plan.title}".`;
    }
  }
}

async function artifactTool(args: Extract<ToolArgs, { name: "artifact" }>, threadId: string): Promise<string> {
  const userData = app.getPath("userData");
  switch (args.action) {
    case "list": {
      const artifacts = await listArtifacts(userData);
      if (!artifacts.length) return 'There are no artifacts yet. Make one with artifact {"action":"create","title":"…","kind":"markdown","content":"…"} — but only when it is worth keeping outside this conversation.';
      return `Artifacts:\n${artifacts.map((artifact) => `${artifact.id} — ${artifact.title} — ${artifact.kind} — updated ${artifact.updatedAt}${artifact.surface ? ` — mounted in the ${artifact.surface}` : ""}`).join("\n")}`;
    }
    case "get": {
      const artifact = await readArtifact(userData, args.id!);
      if (args.file) return `${args.file} in ${artifact.id}\n\n${await readArtifactFile(userData, artifact.id, args.file)}`;
      const held = artifact.kind === "app" ? await artifactFiles(userData, artifact.id) : [];
      return `${artifact.title} (${artifact.id}) — ${artifact.kind}, version ${artifact.version}, updated ${artifact.updatedAt}`
        + (held.length ? `\nFiles beside it: ${held.join(", ")}` : "")
        + `\n\n${artifact.content}`;
    }
    case "create":
    case "rewrite": {
      if (args.file) {
        const saved = await writeArtifactFile(userData, args.id!, args.file, args.content!);
        artifactsChanged();
        return `${artifactMarker(saved.id)} Wrote ${args.file} in "${saved.title}" — now v${saved.version}`;
      }
      const existing = args.action === "rewrite" ? await readArtifact(userData, args.id!) : undefined;
      const saved = await writeArtifact(userData, {
        id: existing?.id,
        title: args.title ?? existing?.title ?? "",
        kind: args.kind ?? existing?.kind ?? "",
        language: args.language ?? existing?.language,
        surface: args.surface,
        content: args.content!,
        sourceThreadId: threadId,
      });
      artifactsChanged();
      const live = saved.surface ? `, live in the ${saved.surface}` : "";
      return existing
        ? `${artifactMarker(saved.id)} Rewrote "${saved.title}" — now v${saved.version}${live}`
        : `${artifactMarker(saved.id)} Created the artifact "${saved.title}"${live}\nIt is on the Artifacts page, and any later thread or scheduled task can reach it with artifact {"action":"get","id":"${saved.id}"}.`;
    }
    case "update": {
      const saved = args.file
        ? await updateArtifactFile(userData, args.id!, args.file, args.oldStr!, args.newStr!)
        : await updateArtifact(userData, args.id!, args.oldStr!, args.newStr!);
      artifactsChanged();
      return `${artifactMarker(saved.id)} Updated ${args.file ?? `"${saved.title}"`} — one replacement, now v${saved.version}`;
    }
  }
}

function variableNote(variables: string[] | undefined): string {
  if (!variables?.length) return "";
  const missing = variables.filter((name) => !process.env[name]);
  if (!missing.length) return ` It reads ${variables.join(", ")}, and every one of them is set.`;
  return ` It needs ${missing.join(", ")}: tell the user to open Settings \u2192 Built by Emma and fill ${missing.length > 1 ? "them" : "it"} in, or the component has nothing to fetch with.`;
}

async function componentTool(args: Extract<ToolArgs, { name: "component" }>, threadId: string): Promise<string> {
  const userData = app.getPath("userData");
  switch (args.action) {
    case "list": {
      const built = await listComponents(userData);
      if (!built.length) return 'Emma has built nothing into her interface yet. Build one with component {"action":"create","title":"\u2026","code":"\u2026"} and it appears in the context bar.';
      return `Components:\n${built.map((one) => `${one.id} \u2014 ${one.title} \u2014 v${one.version}${one.expands ? " \u2014 opens full screen" : ""}${one.variables?.length ? ` \u2014 needs ${one.variables.join(", ")}` : ""}${one.disabled ? " \u2014 switched off by the user" : ""}`).join("\n")}`;
    }
    case "get": {
      const one = await readComponent(userData, args.id!);
      return `${one.title} (${one.id}) \u2014 version ${one.version}${one.expands ? ", opens full screen" : ""}${one.variables?.length ? `, needs ${one.variables.join(", ")}` : ""}\n\n${one.code}`;
    }
    case "create": {
      const saved = await writeComponent(userData, { title: args.title!, code: args.code!, expands: args.expand, variables: args.variables, sourceThreadId: threadId });
      componentsChanged();
      return `Built "${saved.title}" (${saved.id}) into ${COMPONENT_ZONE_LABEL}, and it is on screen now.${variableNote(saved.variables)} Ask the user how it looks: component {"action":"rewrite","id":"${saved.id}","code":"\u2026"} reloads it in place while they watch. The \u22ef in its header is how they switch it off or delete it.`;
    }
    case "rewrite": {
      const existing = await readComponent(userData, args.id!);
      const saved = await writeComponent(userData, { id: existing.id, title: args.title ?? existing.title, code: args.code!, expands: args.expand, variables: args.variables, sourceThreadId: threadId });
      componentsChanged();
      return `Reworked "${saved.title}" \u2014 v${saved.version}, reloaded in place.${variableNote(saved.variables)} Ask whether that is what they meant.`;
    }
  }
}

function runCommand(cwd: string, command: string, timeoutMs = MAX_COMMAND_MS): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(shellBinary(), shellArguments(command, false), { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
    let output = "";
    const collect = (data: Buffer) => { if (output.length < MAX_COMMAND_OUTPUT) output += String(data); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => { if (child.pid !== undefined) terminateProcessTree(child.pid, "SIGKILL"); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); resolve(`That command could not start: ${error.message}`); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const body = output.slice(0, MAX_COMMAND_OUTPUT).trim() || "(no output)";
      if (signal) return resolve(`${body}\n[killed after ${timeoutMs / 1000}s]`);
      resolve(code === 0 ? body : `${body}\n[exit ${code}]`);
    });
  });
}

async function runWrittenTool(cwd: string, file: string, input: string): Promise<string> {
  if (!isWindows) return runCommand(cwd, `${shellQuoted(file)} ${shellQuoted(input)}`);
  const first = readFileSync(file, "utf8").split(/\r?\n/, 1)[0] ?? "";
  const interpreter = /^#!\s*(?:\/usr\/bin\/env\s+)?([^\s]+)/.exec(first)?.[1]?.toLowerCase().replace(/\.exe$/, "");
  if (!interpreter) throw new Error("That tool has no supported interpreter.");
  const choices = interpreter === "node" ? ["node.exe", "node"]
    : interpreter === "python" || interpreter === "python3" ? ["py.exe", "python.exe", "python"]
    : interpreter === "powershell" || interpreter === "pwsh" ? ["pwsh.exe", "powershell.exe"]
    : interpreter === "bash" || interpreter === "sh" ? ["bash.exe", "sh.exe"]
    : [];
  if (!choices.length) throw new Error(`Windows cannot run tools written for ${interpreter}. Use node, python, powershell, or bash.`);
  let binary: string | null = null;
  for (const choice of choices) {
    binary = await findExecutable(choice);
    if (binary) break;
  }
  if (!binary) throw new Error(`Windows cannot find the ${interpreter} interpreter for that tool.`);
  const args = interpreter === "python" || interpreter === "python3"
    ? [path.basename(binary).toLowerCase() === "py.exe" ? "-3" : "", file, input].filter(Boolean)
    : interpreter === "powershell" || interpreter === "pwsh"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, input]
      : [file, input];
  return runDirectCommand(cwd, binary, args);
}

function runDirectCommand(cwd: string, binary: string, args: string[], timeoutMs = MAX_COMMAND_MS, raw = false, commandEnv: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve) => {
    const child = spawnCommand(binary, args, { cwd, env: commandEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let stopped = false;
    const collect = (data: Buffer) => { if (output.length < MAX_COMMAND_OUTPUT) output += String(data); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      stopped = true;
      if (child.pid !== undefined) terminateProcessTree(child.pid, "SIGKILL", false);
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => { clearTimeout(timer); resolve(`That tool could not start: ${error.message}`); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const body = output.slice(0, MAX_COMMAND_OUTPUT).trim() || "(no output)";
      resolve(raw ? output.slice(0, MAX_COMMAND_OUTPUT).trim() : stopped ? `${body}\n[killed after ${timeoutMs / 1000}s]` : code === 0 ? body : `${body}\n[exit ${code}]`);
    });
  });
}

const MAX_COMMAND_OUTPUT = 16 * 1024;
const MAX_CLI_VIEW_CHARS = 128 * 1024;
const MAX_COMMAND_MS = 120_000;

function visionRoute() {
  const { model, endpoint, credentialEnv } = toolSettings.vision;
  const apiKey = (credentialEnv ? process.env[credentialEnv]?.trim() : "") ?? "";
  if (!model.trim() || !endpoint || (credentialEnv && !apiKey)) return undefined;
  return { model: model.trim(), chatUrl: endpoint, apiKey };
}

function harnessClient(cwd: string, key = cwd, route?: ProviderRoute): Harness {
  const running = harnesses.get(key);
  if (running?.running) {
    harnesses.delete(key);
    harnesses.set(key, running);
    return running;
  }
  if (running) harnesses.delete(key);
  const binaryPath = binary("emma-cli");
  if (!existsSync(binaryPath)) throw new Error(`Emma could not find its agent at ${binaryPath}. The install is incomplete — reinstall Emma, or run npm run build:harness from the repo.`);
  const home = path.join(app.getPath("userData"), "harness");
  const client = new Harness({
    binaryPath,
    cwd,
    home,
    apiKey: route ? route.apiKey : process.env.OPENROUTER_API_KEY,
    chatUrl: route?.chatUrl,
    vision: visionRoute(),
    promptFile: harnessPromptFile(home, key),
    onDelta: (threadId, delta) => {
      if (agents && !agents.noteDelta(threadId, delta)) return;
      harnessText.set(threadId, (harnessText.get(threadId) ?? "") + delta);
      broadcast("emma:delta", { threadId, delta });
    },
    onThought: (threadId, delta, recovery) => {
      if (agents && !agents.noteDelta(threadId, delta, true)) return;
      harnessThought.set(threadId, (harnessThought.get(threadId) ?? "") + delta);
      broadcast("emma:delta", { threadId, delta, thinking: true, recovery: recovery === true });
    },
    onToolCall: (call) => {
      agents?.noteTool(call.threadId, call.toolCallId, call.title || call.kind, call);
      if (REVIEWABLE_KINDS.has(call.kind) && call.status === "completed") turnTouched.add(call.threadId);
      void recordUse(app.getPath("userData"), mcpToolKey(call.toolName ?? call.title), `${call.threadId}:${call.toolCallId}`);
      const wrote = noteHarnessChange(cwd, call);
      broadcast("emma:step", wrote ? { ...call, edit: editStat(wrote) } : call);
    },
    onCompacted: (threadId, compacted) => {
      agents?.noteNotice(threadId, "compact", compactionNotice(compacted.removedTurns, compacted.modelWritten));
      broadcast("emma:compacted", { threadId, ...compacted });
    },
    onContextExperiment: (threadId, fired) => broadcast("emma:context-experiment", { threadId, ...fired }),
    onContextBreakdown: (threadId, parts) => broadcast("emma:context-breakdown", { threadId, ...parts }),
    onRoutedModel: (threadId, routed) => {
      harnessRouted.set(threadId, routed.model);
      agents?.noteModel(threadId, routed.model);
      broadcast("emma:routed-model", { threadId, ...routed });
    },
    onUsage: (threadId, usage) => {
      harnessUsage.set(threadId, usage);
      agents?.noteUsage(threadId, usage);
      const goal = goals.get(threadId);
      if (goalPursuing(goal) && noteTurnSpend(threadId, usage) >= goalTokensLeft(goal)) noteGoalOverspent(threadId);
    },
    onChildStart: async ({ parentThreadId, childId, title }) => {
      const name = agentName(childId, new Set(agents!.list().map((agent) => agent.title)));
      const created = await host!.request({ method: "createThread", params: { parentThreadId, title: name, kind: "subagent" } });
      const threadId = (created as { id?: unknown }).id;
      if (typeof threadId !== "string") throw new Error("Emma host returned an invalid thread");
      if (reviewThreads.has(parentThreadId)) reviewThreads.add(threadId);
      harnessText.set(threadId, "");
      harnessThought.set(threadId, "");
      harnessUsage.delete(threadId);
      harnessChildren.set(threadId, { childId, title, startedAt: Date.now(), client });
      const parent = harnessTurns.get(parentThreadId);
      agents!.adopt({
        threadId,
        content: title,
        title: name,
        parentThreadId,
        depth: (parent?.depth ?? 0) + 1,
        mode: agents!.mode(parentThreadId),
        model: modelName(parent?.model),
        traceContext: parent?.traceContext,
        effort: parent?.effort ?? "",
        parentSpanId: agents!.spanFor(parentThreadId),
      });
      return threadId;
    },
    onModelContext: (parentThreadId, threadId, model, skills) => {
      const parent = harnessTurns.get(parentThreadId);
      const turn = withTrialArm({ threadId, parentThreadId, title: "Subagent", content: "", mode: parent?.mode ?? agents!.mode(parentThreadId), model }, model);
      const systemPrompt = resolveHarnessPrompt({ model, addition: turn.promptAddition, workspace: cwd, mode: turn.mode, disabledTools: toolSettings.disabledTools });
      const experiments = { ...harnessExperiments, ...turn.knobs };
      agents!.noteModel(threadId, model);
      agents!.noteContext(threadId, {
        ...turn.traceContext,
        systemPrompt,
        skillContext: skills,
        configuration: JSON.stringify({ version: app.getVersion(), model, workspace: cwd, mode: turn.mode, toolHints: turn.toolHints ?? {}, preselect: turn.preselect ?? [], experiments }),
      });
      return {
        system_prompt: systemPrompt,
        tool_hints: Object.entries(turn.toolHints ?? {}).map(([name, description]) => ({ name, description })),
        preselect: turn.preselect ?? [],
        command_timeout_ms: experiments.commandTimeoutMinutes * 60_000,
        experiments: {
          auto_compact_percent: experiments.autoCompactPercent,
          reinject_prompt_steps: experiments.reinjectPromptSteps,
          reinject_prompt_percent: experiments.reinjectPromptPercent,
          prune_tools_steps: experiments.pruneToolsSteps,
          prune_tools_percent: experiments.pruneToolsPercent,
        },
      };
    },
    onChildEnd: (threadId, reason) => {
      const child = harnessChildren.get(threadId);
      if (!child) return;
      harnessChildren.delete(threadId);
      const spoken = (harnessText.get(threadId) ?? "").trim();
      const thinking = harnessThought.get(threadId);
      const usage = harnessUsage.get(threadId);
      harnessText.delete(threadId);
      harnessThought.delete(threadId);
      harnessUsage.delete(threadId);
      const spent = agents!.list().find((agent) => agent.threadId === threadId);
      agents!.finish(threadId, reason);
      void recordTurn({
        threadId,
        prompt: child.title,
        thinking,
        answer: spoken,
        notice: reason ? `This subagent stopped: ${reason}` : spoken ? "" : "This subagent finished without an answer.",
        durationMilliseconds: String(Date.now() - child.startedAt),
        outputTokens: String(spent?.outputTokens ?? 0),
        inputTokens: String(spent?.inputTokens ?? 0),
        ...recordedCacheUsage(usage),
        model: harnessRouted.get(threadId) ?? modelName(threadModel(threadId)),
      }).catch((error: unknown) => console.error("Emma: a subagent's transcript could not be recorded", error));
    },
    onPlan: () => {},
    onPhase: (threadId, phase) => agents?.noteActivity(threadId, phase),
    onLifecycle: async (event, threadId, input) => {
      if (event === "Stop") input.last_assistant_message = harnessText.get(threadId)?.trim() || null;
      const failures = await runPluginHooks(app.getPath("userData"), event, input);
      for (const failure of failures) {
        broadcast("emma:step", { threadId, toolCallId: `hook:${event}:${failure.slice(0, 40)}`, title: failure, kind: "other", status: "failed", at: Date.now() });
      }
    },
    onPermission: async (ask, options, context) => {
      const authorized = agents!.authorization(ask.threadId);
      if (!authorized()) return null;
      const pick = (...kinds: string[]) => {
        for (const kind of kinds) {
          const found = options.find((option) => option.kind === kind)?.optionId;
          if (found) return found;
        }
        return undefined;
      };
      const deny = () => pick("reject_once", "reject_always") ?? null;
      if (context.outsideWorkspace) {
        broadcast("emma:step", { threadId: ask.threadId, toolCallId: ask.id, title: `blocked: ${ask.tool} is outside the connected folder`, kind: "other", status: "failed", at: Date.now() });
        return deny();
      }
      if (reviewThreads.has(ask.threadId) && context.kind === "edit") {
        broadcast("emma:step", { threadId: ask.threadId, toolCallId: ask.id, title: `blocked: a review reads the work, it does not change it`, kind: "other", status: "failed", at: Date.now() });
        return deny();
      }
      if (agents!.mode(ask.threadId) === "full") return pick("allow_once", "allow_always") ?? options[0]?.optionId ?? null;
      if (agents!.mode(ask.threadId) === "acceptEdits" && context.kind === "edit") return pick("allow_once", "allow_always") ?? options[0]?.optionId ?? null;
      const allowed = await agents!.question({ threadId: ask.threadId, tool: ask.tool, summary: ask.summary, detail: ask.detail });
      return allowed && authorized() ? pick("allow_once", "allow_always") ?? options[0]?.optionId ?? null : deny();
    },
    onToolRequest: (threadId, name, args) => runEmmaTool(threadId, name, args),
    mcpServers: (threadId) => harnessMcpServers(threadId),
    onLog: noteHarnessLog,
  });
  harnesses.set(key, client);
  reapHarnesses();
  return client;
}

const MAX_HARNESSES = 8;

function reapHarnesses() {
  for (const [cwd, client] of [...harnesses]) {
    if (harnesses.size <= MAX_HARNESSES) return;
    if (client.busy) continue;
    client.close();
    harnesses.delete(cwd);
  }
}

function recycleHarnesses() {
  for (const [cwd, client] of [...harnesses]) {
    if (client.busy) continue;
    client.close();
    harnesses.delete(cwd);
  }
}

const harnessBefore = new Map<string, { threadId: string; text: string | null }>();

function noteHarnessChange(cwd: string, call: HarnessToolCall): FileChange | undefined {
  if (call.kind !== "edit") return;
  const relative = call.filePath;
  if (typeof relative !== "string" || !relative || relative.includes("\0") || escapesRoot(cwd, relative)) return;
  const grant = folders!.list().find((folder) => samePath(folder.path, cwd));
  if (!grant) return;
  const absolute = path.resolve(cwd, relative);
  if (!pathInside(cwd, absolute)) return;
  const read = () => { try { return readFileSync(absolute, "utf8"); } catch { return null; } };

  const key = `${call.threadId}:${call.toolCallId}`;
  if (call.status === "failed") {
    harnessBefore.delete(key);
    return;
  }
  if (call.status !== "completed") {
    if (!harnessBefore.has(key)) harnessBefore.set(key, { threadId: call.threadId, text: read() });
    return;
  }
  const opened = harnessBefore.get(key);
  if (!opened) return;
  const before = opened.text;
  harnessBefore.delete(key);
  const after = read();
  if (after === null || after === before) return;
  const change: FileChange = { folderId: grant.id, path: path.relative(cwd, absolute), before, after, at: Date.now() };
  agents!.noteChange(call.threadId, change);
  changed();
  return change;
}

async function syncHarnessSkills() {
  await mirrorSkillsToHarness(app.getPath("userData"), path.join(app.getPath("userData"), "harness"), toolSettings.disabledSkills)
    .catch((error) => console.warn("Emma could not mirror skills to the harness:", error instanceof Error ? error.message : error));
}

const harnessTurns = new Map<string, TurnRequest>();

const HARNESS_TOOL_NAMES: Record<string, string> = { look_at_image: "vision" };

async function runEmmaTool(threadId: string, wireName: string, args: Record<string, unknown>): Promise<string> {
  const name = HARNESS_TOOL_NAMES[wireName] ?? wireName;
  const turn = harnessTurns.get(threadId);
  const authorized = agents!.authorization(threadId);
  if (!turn || !authorized()) throw new Error("Emma's tools are only available while a turn is running.");
  const mode = agents!.mode(threadId);
  const gate = toolGate(mode, name, toolSettings.disabledTools);
  if (gate === "hidden") {
    throw new Error(`${wireName} is not available in ${mode} mode, or is switched off in Settings → Tools.`);
  }
  const unavailable = whyUnavailable(threadId, name, wireName);
  if (unavailable) throw new Error(unavailable);
  const parsed = parseToolArgs(name, JSON.stringify(args));
  if (gate === "ask" && name !== "computer") {
    const allowed = await agents!.question({
      threadId,
      tool: name,
      summary: describeToolCall(parsed),
      detail: JSON.stringify(args, null, 2).slice(0, 4096),
    });
    if (!allowed) throw new Error(`The user did not allow ${wireName} to run. Do not try it again this turn; say what you needed it for instead.`);
  }
  if (harnessTurns.get(threadId) !== turn || !authorized()) throw new Error("This turn is no longer running.");
  const current = { ...turn, mode: agents!.mode(threadId) };
  const call = () => OWN_TOOLS.has(name)
    ? agents!.runThreadTool(parsed, current)
    : executeTool(parsed as ToolArgs, current);
  return turn.bench ? await benchReplay.run(true, call) : await call();
}

function whyUnavailable(threadId: string, name: string, called = name): string | undefined {
  const needs = toolNeeds(name);
  if (needs === "folders" && threadFolderIds(threadId).length === 0) {
    return `${called} needs a connected folder. Ask the user to connect one — the folder button in Emma's sidebar opens the picker.`;
  }
  return undefined;
}

async function harnessMcpServers(_threadId: string): Promise<HarnessMcpServer[]> {
  try {
    return await readHarnessMcpServers(app.getPath("userData"), toolSettings.disabledServers);
  } catch {
    return [];
  }
}

let routers: ModelRouter[] = [];
let providers: ProviderProfile[] = [];

export type ProviderRoute = { id: string; chatUrl: string; apiKey: string };

function providerFor(key: string | undefined): ProviderProfile | undefined {
  return key?.startsWith("provider:") ? providers.find((item) => item.id === key.slice("provider:".length)) : undefined;
}

async function turnRoute(key: string | undefined): Promise<ProviderRoute | undefined> {
  return codexSlug(key) ? await chatgptRoute() : providerRoute(key);
}

function providerRoute(key: string | undefined): ProviderRoute | undefined {
  const profile = providerFor(key);
  if (!profile) return undefined;
  const apiKey = (profile.credentialEnv ? process.env[profile.credentialEnv]?.trim() : "") ?? "";
  if (profile.credentialEnv && !apiKey) {
    throw new Error(`${profile.name} has no key saved under ${profile.credentialEnv}. Paste one in Settings → Models, then send this again.`);
  }
  return { id: profile.id, chatUrl: providerChatUrl(profile), apiKey: apiKey || "no-key" };
}

function councilRoute(key: string): CouncilRoute {
  if (codexSlug(key)) throw new Error("A ChatGPT plan model cannot take a council seat \u2014 it does not answer on the chat endpoint. Pick an API model for this seat.");
  const profile = providerFor(key);
  if (profile) {
    const route = providerRoute(key)!;
    return {
      settings: { model: profile.modelId, endpoint: route.chatUrl, credentialEnv: profile.credentialEnv, system: "" },
      apiKey: route.apiKey === "no-key" ? "" : route.apiKey,
      modelId: profile.modelId,
      plan: planForProfile(profile)?.id ?? "",
    };
  }
  const model = harnessModel(key);
  if (!model) throw new Error("That seat has no model behind it yet. Pick one.");
  return {
    settings: { model, endpoint: OPENROUTER_CHAT_ENDPOINT, credentialEnv: "OPENROUTER_API_KEY", system: "" },
    apiKey: process.env.OPENROUTER_API_KEY?.trim() ?? "",
    modelId: model.split(",")[0],
    plan: planForModel(key)?.id ?? "",
  };
}

function harnessModel(key: string | undefined) {
  if (key?.startsWith(CODEX_PREFIX)) return codexSlug(key);
  const routerId = routerIdFor(key);
  if (routerId) return routerChain(modelCatalog?.ids(), routers.find((router) => router.id === routerId)?.models ?? []);
  if (key?.startsWith("openrouter:")) return key.slice("openrouter:".length);
  return providerFor(key)?.modelId;
}

function modelName(key: string | undefined) {
  if (key?.startsWith("openrouter:")) return key.slice("openrouter:".length);
  if (key?.startsWith(CODEX_PREFIX)) return codexSlug(key);
  return providerFor(key)?.modelId ?? key ?? "";
}

function metadataFor(key: string | undefined, routedModel?: string): RouteModelMetadata | undefined {
  const profile = providerFor(key);
  if (profile) return modelMetadata?.provider(profile);
  const slug = codexSlug(key);
  if (slug) return modelMetadata?.codex(slug);
  if (!key?.startsWith("openrouter:") && !routerIdFor(key)) return undefined;
  const model = (routedModel ?? harnessModel(key) ?? "").split(",")[0];
  if (!model) return undefined;
  return {
    source: "openrouter",
    contextWindow: modelCatalog?.contextLength(model),
    reasoningEfforts: modelCatalog?.reasoningEfforts(model),
  };
}

function contextWindowFor(key: string | undefined, routedModel?: string) {
  return metadataFor(key, routedModel)?.contextWindow;
}

function thinkingRoute(key: string | undefined, routedModel: string | undefined, level: string | undefined): ThinkingRoute | undefined {
  if (!routedModel) return undefined;
  const published = metadataFor(key, routedModel)?.reasoningEfforts ?? [];
  return { level: level && published.includes(level) ? level : "", published };
}

let selectedModel = "";
let selectedEffort: ThinkingLevel = "";
function catalogued(modelId: string): string {
  if (!modelCatalog!.ids().includes(modelId)) throw new Error("That model is no longer in OpenRouter's catalog. Reload the models page and pick again.");
  return modelId;
}

function routedModelKey(key: string): string {
  if (providerFor(key)) return key;
  const routerId = routerIdFor(key);
  if (routerId === FREE_ROUTER_ID || routers.some((router) => router.id === routerId)) return key;
  throw new Error(`That model is not set up on this ${DEVICE} any more. Pick another one.`);
}

const thinkingLevel = (value: unknown): ThinkingLevel => isThinkingLevel(value) ? value : "";

async function selectModel(method: string, params: Record<string, string>): Promise<unknown> {
  if (method === "setThreadModel") {

    const picked = params.modelId ?? "";
    rememberThreadContext(params.threadId, {
      ...threadContext(params.threadId),
      model: !picked ? "" : picked.startsWith("provider:") || picked.startsWith("router:") ? routedModelKey(picked) : `openrouter:${catalogued(picked)}`,
      effort: thinkingLevel(params.effort),
    });
    return { set: true };
  }
  if (method === "selectFallbackModel") {
    selectedModel = "";
    selectedEffort = "";
    return { model: "" };
  }
  if (method === "selectCodexModel") {
    const modelId = (params.modelId ?? "").trim();
    if (!CODEX_MODEL_ID.test(modelId)) throw new Error("That is not a Codex model.");
    await chatgptAuth();
    selectedModel = `${CODEX_PREFIX}${modelId}`;
    selectedEffort = thinkingLevel(params.effort);
    return { model: modelId };
  }
  if (method === "selectProviderModel") {
    const profile = providers.find((item) => item.id === params.providerId);
    if (!profile) throw new Error("That provider is not set up. Add it again in Settings → Models.");
    selectedModel = `provider:${profile.id}`;
    selectedEffort = thinkingLevel(params.effort);
    return { model: profile.modelId };
  }
  const modelId = catalogued(params.modelId);
  selectedModel = `openrouter:${modelId}`;
  selectedEffort = thinkingLevel(params.effort);
  return { model: modelId };
}

async function listModelCatalog(force: boolean) {
  const maxAge = force ? 0 : 24 * 60 * 60 * 1000;
  const [catalog, metadata] = await Promise.all([
    modelCatalog!.refresh(() => fetchOpenRouterCatalog(), maxAge),
    modelMetadata!.refresh(maxAge),
  ]);
  return {
    ...catalog,
    routes: modelMetadata!.routes(catalog.models, providers),
    metadataFetchedAt: metadata.fetchedAt,
    metadataStale: metadata.stale,
    metadataError: metadata.error,
  };
}

function answerRequest(method: string, params: Record<string, string> = {}): Promise<unknown> {
  switch (method) {
    case "listOpenRouterModels":
      return listModelCatalog(!!params.force);
    case "selectOpenRouterModel": case "selectProviderModel": case "selectCodexModel": case "selectFallbackModel": case "setThreadModel":
      return Promise.resolve().then(() => selectModel(method, params));
    case "createThread":
      return host!.request({ method, params }).then((created) => {
        const id = (created as { id?: unknown } | null)?.id;
        if (typeof id === "string" && params.parentThreadId && inheritBench(id, params.parentThreadId)) stopThread(id);
        return created;
      });
    case "saveScheduledJob":
      return Promise.resolve().then(async () => {
        const graph = parseWorkflow(params.nodes ?? "", params.prompt ?? "");
        if (graph.errors.length) throw new Error(graph.errors.join("\n"));
        await validateWorkflowScripts(graph.nodes);
        return await host!.request({ method, params });
      });
    case "setRouters":
      return Promise.resolve().then(() => {
        routers = validateRouters(JSON.parse(params.routers ?? "[]"));
        return { routers: routers.length };
      });
    default: return host!.request({ method, params });
  }
}

async function readThreadTraces(threadId: string): Promise<StoredThreadTrace[]> {
  const result = await host!.request({ method: "readTrace", params: { threadId } });
  const traces = Array.isArray(result) ? result.flatMap((trace): StoredThreadTrace[] => {
    const value = trace && typeof trace === "object" ? trace as Record<string, unknown> : undefined;
    return typeof value?.timestamp === "string" && typeof value.text === "string" ? [{ timestamp: value.timestamp, text: value.text }] : [];
  }) : [];
  return recoveredSessionTraces(path.join(app.getPath("userData"), "harness"), threadId, traces);
}

const compactNext = new Set<string>();

function harnessCwd(threadId: string) {
  const id = threadFolder(threadId);
  const grant = id ? folders!.list().find((folder) => folder.id === id) : undefined;
  if (grant) return grant.path;
  const scratch = path.join(app.getPath("userData"), "workspaces", threadId);
  mkdirSync(scratch, { recursive: true });
  return scratch;
}

const STOP_NOTICES: Record<string, string> = {
  cancelled: "You stopped this run",
  refused: "The run was refused",
  max_output_tokens: "The model hit its output limit",
  max_model_turns: "The run hit its step limit",
};

function turnNotice(stopReason: string, spoken: string): string {
  const ended = STOP_NOTICES[stopReason];
  if (!ended) return spoken ? "" : "This turn ended without an answer.";
  return spoken ? `${ended} — the answer above stops where it was cut off.` : `${ended}.`;
}

function recordTurn(turn: RecordedTurn): Promise<unknown> {
  return host!.request({ method: "recordTurn", params: recordedTurn(turn) });
}

const recordedCacheUsage = (usage: TurnUsage | undefined) =>
  usage === undefined
    ? {}
    : {
      ...(usage.cacheInputTokens === undefined || usage.cacheReadTokens === undefined ? {} : { cacheInputTokens: String(usage.cacheInputTokens), cacheReadTokens: String(usage.cacheReadTokens) }),
      ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: String(usage.cacheWriteTokens) }),
      ...(usage.costMicroUsd === undefined ? {} : { costMicroUsd: String(usage.costMicroUsd) }),
    };

function attachedImagePaths(value: unknown): string[] {
  if (typeof value !== "string") return [];
  let ids: unknown;
  try { ids = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(ids)) return [];
  return ids.flatMap((id) => {
    try {
      const file = attachments!.read(id);
      return file.text === undefined ? [attachments!.forModel(file)] : [];
    } catch { return []; }
  }).slice(0, MAX_TURN_IMAGES);
}

function bridgeImages(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TURN_IMAGES) throw new Error("That is more photos than one message can carry.");
  return value.map((entry) => {
    const photo = (entry ?? {}) as { name?: unknown; base64?: unknown };
    if (typeof photo.base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(photo.base64)) throw new Error("That photo could not be read.");
    return attachments!.save(photo.name, Buffer.from(photo.base64, "base64")).id;
  });
}

const WAKE_GRACE_MS = 45_000;
const harnessRuns = new Map<string, Harness>();
const sleepWedged = new Set<string>();
const SLEEP_CONTINUATION = "This computer went to sleep mid-turn and the connection to the model was lost. Carry on from the last step you finished.";
const pausedRecovery = new Set<string>();
const CRASH_CONTINUATION = "The harness process died mid-turn and has been restarted. Carry on from the last step you finished, and check what is already on disk before redoing any of it.";
const RESTART_NOTICE = "Emma restarted the agent mid-turn and asked it to carry on";

function noteRestart(threadId: string) {
  harnessThought.set(threadId, `${RESTART_NOTICE}\n`);
  broadcast("emma:delta", { threadId, delta: RESTART_NOTICE, thinking: true, recovery: true });
}

async function resumeAfterSleep() {
  if (harnessRuns.size === 0) return;
  await new Promise((resolve) => setTimeout(resolve, WAKE_GRACE_MS));
  const wedged = new Set<Harness>();
  for (const [threadId, client] of [...harnessRuns]) {
    if (client.silentFor < WAKE_GRACE_MS || harnessRuns.get(threadId) !== client) continue;
    sleepWedged.add(threadId);
    wedged.add(client);
  }
  for (const client of wedged) client.close();
}

async function runOnHarness(client: Harness, cwd: string, turn: TurnRequest, key = cwd, resume = "") {
  const home = path.join(app.getPath("userData"), "harness");
  const systemPrompt = writeHarnessPrompt(home, { model: modelName(turn.model), addition: turn.promptAddition, workspace: cwd, mode: turn.mode, disabledTools: toolSettings.disabledTools }, harnessPromptFile(home, key));
  turn = { ...turn, traceContext: {
    ...turn.traceContext,
    systemPrompt,
    skillContext: turn.params?.skillContext ?? "",
    configuration: JSON.stringify({ version: app.getVersion(), model: modelName(turn.model), effort: turn.effort ?? "", workspace: cwd, mode: turn.mode, disabledTools: toolSettings.disabledTools, toolHints: turn.toolHints ?? {}, preselect: turn.preselect ?? [], stepLimit: turn.stepLimit, experiments: { ...harnessExperiments, ...turn.knobs } }),
  } };
  computerRuntime?.end(turn.threadId);
  harnessText.set(turn.threadId, "");
  harnessThought.set(turn.threadId, "");
  if (resume || turn.continueRecovery) noteRestart(turn.threadId);
  turnTouched.delete(turn.threadId);
  harnessRouted.delete(turn.threadId);
  harnessUsage.delete(turn.threadId);
  harnessTurns.set(turn.threadId, turn);
  harnessRuns.set(turn.threadId, client);
  const startedAt = Date.now();
  agents!.adopt({ ...turn, model: modelName(turn.model) });
  const route = harnessModel(turn.model);
  try {
    const { stopReason, usage } = await client.prompt(turn.threadId, cwd, resume || turn.content, turn.mode, route, {
      skillContext: typeof turn.params?.skillContext === "string" ? turn.params.skillContext : undefined,
      images: attachedImagePaths(turn.params?.attachedImages),
      contextWindow: contextWindowFor(turn.model, route),
      effort: thinkingRoute(turn.model, route, turn.effort),
      toolHints: turn.toolHints,
      preselect: turn.preselect,
      stepLimit: turn.stepLimit,
      experiments: turn.knobs ? { ...harnessExperiments, ...turn.knobs } : harnessExperiments,
      semanticGrep: semanticGrep.option(harnessExperiments, threadFolder(turn.threadId) ? cwd : undefined),
      imageInput: metadataFor(turn.model, route)?.inputModalities?.includes("image"),
      compact: compactNext.delete(turn.threadId),
      continueRecovery: turn.continueRecovery,
    });
    agents!.noteUsage(turn.threadId, usage);
    const cacheUsage = harnessUsage.get(turn.threadId);
    const spoken = (harnessText.get(turn.threadId) ?? "").trim();
    if (failedTurn(stopReason)) {
      pausedRecovery.add(turn.threadId);
      throw new Error(client.paused.get(turn.threadId)?.message || "The run was refused.");
    }
    agents!.finish(turn.threadId, undefined, stopReason);
    return await recordTurn({
      threadId: turn.threadId,
      prompt: turn.content,
      thinking: harnessThought.get(turn.threadId),
      answer: spoken,
      notice: turnNotice(stopReason, spoken),
      durationMilliseconds: String(Math.max(1, Date.now() - startedAt - agents!.awaited(turn.threadId))),
      outputTokens: String(usage.outputTokens),
      inputTokens: String(usage.inputTokens),
      ...recordedCacheUsage(cacheUsage),
      model: harnessRouted.get(turn.threadId) ?? modelName(turn.model),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    turn = { ...turn, mode: agents!.mode(turn.threadId) };
    agents!.finish(turn.threadId, detail);
    if (sleepWedged.delete(turn.threadId) && agents!.list().find((agent) => agent.threadId === turn.threadId)?.status !== "stopped") {
      agents!.forget(turn.threadId);
      return await runOnHarness(harnessClient(cwd, key, await turnRoute(turn.model)), cwd, turn, key, SLEEP_CONTINUATION);
    }
    const pausedTurn = client.paused.get(turn.threadId);
    if (pausedRecovery.delete(turn.threadId) && pausedTurn?.cause !== "request_limit_reached" && pausedTurn?.cause !== "authentication" && pausedTurn?.requiredAction !== "change_request" && !turn.continueRecovery && agents!.list().find((agent) => agent.threadId === turn.threadId)?.status !== "stopped") {
      agents!.forget(turn.threadId);
      try {
        return await runOnHarness(harnessClient(cwd, key, await turnRoute(turn.model)), cwd, { ...turn, continueRecovery: true }, key, resume);
      } catch {
        throw error;
      }
    }
    if (!client.running && resume !== CRASH_CONTINUATION && agents!.list().find((agent) => agent.threadId === turn.threadId)?.status !== "stopped") {
      agents!.forget(turn.threadId);
      try {
        return await runOnHarness(harnessClient(cwd, key, await turnRoute(turn.model)), cwd, turn, key, CRASH_CONTINUATION);
      } catch {
        throw error;
      }
    }
    const spoken = (harnessText.get(turn.threadId) ?? "").trim();
    const thought = harnessThought.get(turn.threadId) ?? "";
    const stopped = agents!.list().find((agent) => agent.threadId === turn.threadId);
    const stoppedUsage = { inputTokens: stopped?.inputTokens ?? 0, outputTokens: stopped?.outputTokens ?? 0 };
    try {
      return await recordTurn({
        threadId: turn.threadId,
        prompt: turn.content,
        thinking: thought,
        answer: spoken,
        notice: `This run stopped: ${client.paused.get(turn.threadId)?.message ?? explainFailure(detail)}`,
        durationMilliseconds: String(Math.max(1, Date.now() - startedAt - agents!.awaited(turn.threadId))),
        outputTokens: String(stoppedUsage.outputTokens),
        inputTokens: String(stoppedUsage.inputTokens),
        ...recordedCacheUsage(harnessUsage.get(turn.threadId)),
        model: turn.model ?? "",
      });
    } catch {
      throw error;
    }
  } finally {
    computerRuntime?.end(turn.threadId);
    harnessText.delete(turn.threadId);
    harnessThought.delete(turn.threadId);
    harnessRouted.delete(turn.threadId);
    harnessUsage.delete(turn.threadId);
    harnessTurns.delete(turn.threadId);
    harnessRuns.delete(turn.threadId);
    turnSpend.delete(turn.threadId);
    for (const [id, opened] of harnessBefore) if (opened.threadId === turn.threadId) harnessBefore.delete(id);
  }
}

const activeGoal = (threadId: string) => {
  const goal = goals.get(threadId);
  return goalPursuing(goal) ? goal : undefined;
};

async function runTurn(turn: TurnRequest) {
  if (harnessRuns.has(turn.threadId)) throw new Error("This thread is still running or finishing its current turn. Wait for it to finish before starting another.");
  agents!.forget(turn.threadId);
  turn.subagent ??= threadSubagent(turn.threadId);
  turn.effort ??= threadEffort(turn.threadId) || (harnessModel(turn.model) === harnessModel(selectedModel) ? selectedEffort : "");
  turn.stepLimit ??= threadStepLimit(turn.threadId);
  void recordUse(app.getPath("userData"), modelKey(modelName(turn.model) || "auto"));
  turn.objective ??= activeGoal(turn.threadId)?.objective;
  const cwd = harnessCwd(turn.threadId);
  const nested = turn.nested ? turn.threadId : undefined;
  const route = await turnRoute(turn.model);
  const key = harnessKey(cwd, turn.threadId, route?.id);
  try {
    return await runOnHarness(harnessClient(cwd, key, route), cwd, withGoal(withTrialArm(turn, modelName(turn.model)), activeGoal(turn.threadId)), key);
  } finally {
    if (nested) {
      harnesses.get(key)?.close();
      harnesses.delete(key);
    }
    changed();
  }
}

async function runRequest(request: Request): Promise<unknown> {
  if (request.params.attachedContext) {
    const { attachedContext, skillContext, ...params } = request.params;
    request = { method: request.method, params: { ...params, skillContext: mergeSkillContext(attachedContext, skillContext) } };
  }
  const { threadId, content, ...extra } = request.params;
  if (request.method === "sendMessage") void autoNameThread(threadId, sentByThread(content).body);
  const result = request.method === "sendMessage"
    ? await driveTurn({ threadId, content, mode: threadMode(threadId), title: "This thread", model: threadModel(threadId), params: extra })
    : await answerRequest(request.method, request.params);
  if (!READ_ONLY_METHODS.has(request.method)) changed();
  if (SCHEDULED_JOB_WRITES.has(request.method)) scheduledJobsChanged();
  return result;
}

const desktopIdentity: DesktopIdentity = {
  id: createHash("sha256").update(app.getPath("userData")).digest("hex").slice(0, 32),
  name: hostname().replace(/\.local$/, ""),
  version: app.getVersion(),
  protocol: PROTOCOL_VERSION,
};

function livePartial(): LiveState["partial"] {
  const partial: LiveState["partial"] = {};
  for (const [threadId, text] of harnessText) partial[threadId] = { text, thinking: harnessThought.get(threadId) ?? "" };
  for (const [threadId, thinking] of harnessThought) partial[threadId] ??= { text: "", thinking };
  return partial;
}

const MESSAGE_PAGE = 40;

type StoredThreadSummaries = { threads: ThreadSummary[]; warnings: string[] };

const freeRouter: VerifierSettings = {
  model: routerChain(modelCatalog?.ids(), FREE_ROUTER_MODELS),
  endpoint: OPENROUTER_CHAT_ENDPOINT,
  credentialEnv: "OPENROUTER_API_KEY",
  system: "",
};

const namingThreads = new Set<string>();

const threadNames = new Map<string, string>();

function noteThreadName(threadId: string, title: string) {
  if (!title.trim() || title === DEFAULT_THREAD_TITLE) return;
  threadNames.set(threadId, title);
  agents?.noteTitle(threadId, title);
}

async function autoNameThread(threadId: string, asked: string) {
  if (!asked.trim() || namingThreads.has(threadId) || benchThread(threadId)) return;
  namingThreads.add(threadId);
  try {
    const snapshot = await host!.request({ method: "threadSummaries", params: {} }) as { threads?: { id: string; title?: string }[] };
    const thread = snapshot.threads?.find((entry) => entry.id === threadId);
    if (thread?.title !== DEFAULT_THREAD_TITLE) {
      noteThreadName(threadId, thread?.title ?? "");
      return;
    }
    const title = await nameThread(asked, freeRouter);
    if (!title || title === DEFAULT_THREAD_TITLE) return;
    await host!.request({ method: "renameThread", params: { threadId, title } });
    noteThreadName(threadId, title);
    changed();
  } catch (error) {
    console.error("Emma: this thread could not be named", error);
  } finally {
    namingThreads.delete(threadId);
  }
}

async function threadSummaryStore(): Promise<StoredThreadSummaries> {
  const stored = await runRequest(validateRequest({ method: "threadSummaries", params: {} })) as Partial<StoredThreadSummaries>;
  return { threads: stored.threads ?? [], warnings: stored.warnings ?? [] };
}

function threadSummary(thread: unknown): ThreadSummary {
  const { messages, ...rest } = thread as { messages?: { role?: string; content?: string }[]; labelPrompt?: string };

  const asked = rest.labelPrompt ?? (Array.isArray(messages) ? messages.find((item) => item.role === "user")?.content : undefined);
  return {
    ...rest,
    ...(asked ? { labelPrompt: asked.slice(0, MAX_LABEL_PROMPT_CHARS) } : {}),
    messages: Array.isArray(messages) ? messages.length : 0,
  } as ThreadSummary;
}

function bridgeLive(): LiveState {
  return { agents: agents!.list(), spans: phoneSpans(agents!.spans()), asks: [], partial: livePartial(), desktop: desktopIdentity };
}

async function namedGit(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (!result.ok) throw new Error(result.output || `git ${args[0]} failed`);
  return result.output;
}

async function gitSynced(cwd: string, result: { ok: boolean; output: string }): Promise<GitSyncResult> {
  const snapshot = await gitSnapshot(cwd);
  return { ok: result.ok, output: result.output, ahead: snapshot?.ahead ?? 0, behind: snapshot?.behind ?? 0 };
}

const OPENROUTER_ENV = providerCredentials[0].env;

const MAX_PHONE_SKILLS = MAX_SKILL_RESULTS - 1;

const toolSwitches = (): ToolSwitches => ({ tools: toolSettings.disabledTools, skills: toolSettings.disabledSkills, servers: toolSettings.disabledServers });

function credentialSlotsHeld(): CredentialSlot[] {
  const stored = credentials!.list();
  const slots = new Map<string, CredentialSlot>();
  const put = (env: string, label: string, detail: string, hint: string) => {
    if (!env || slots.has(env)) return;
    slots.set(env, { env, masked: stored.find((item) => item.env === env)?.masked ?? "", label, detail, hint });
  };
  for (const item of providerCredentials) put(item.env, item.label, item.detail, item.hint);
  for (const plan of MODEL_PLANS) put(plan.credentialEnv, plan.label, plan.detail, plan.hint);
  for (const profile of providers) put(profile.credentialEnv, profile.name, `${profile.modelId} · ${profile.baseUrl}`, "Provider key");
  for (const source of toolSettings.webSearch.providers) {
    const provider = webSearchProvider(source.provider);
    put(source.credentialEnv, provider.label, `Web search · ${provider.detail}`, "Search API key");
  }
  for (const item of stored) put(item.env, item.env, "Custom environment variable", "Key");
  return [...slots.values()];
}

function mcpServerRequest(params: Record<string, unknown>): McpServerDefinition {
  const name = boundedCapabilityId(params.name, "Server name");
  const command = boundedCapabilityId(params.command, "Server command");
  const args = params.args ?? [];
  const env = params.env ?? {};
  if (!Array.isArray(args) || args.length > 32 || args.some((arg) => typeof arg !== "string" || arg.length > 4096)) throw new Error("Server arguments are invalid");
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("Server environment is invalid");
  const entries = Object.entries(env as Record<string, unknown>);
  if (entries.length > 32 || entries.some(([key, value]) => typeof value !== "string" || !isEnvName(key))) throw new Error("Server environment is invalid");

  for (const [key] of entries) if (LOADER_ENV.test(key)) throw new Error("That environment variable controls how programs are loaded, so Emma will not pass it to a server.");
  return { name, command, args: args as string[], env: env as Record<string, string> };
}

function bridgeVisual(id: unknown): Visual {
  const visual = readVisual(boundedCapabilityId(id, "Visual"));
  if (!visual) throw new Error("That visual is no longer in this conversation.");
  return { title: visual.title, html: visual.html };
}

const bridgeReplies = new Map<string, Map<string, unknown>>();
const MAX_REPLIES_PER_THREAD = 32;
const MAX_REPLY_THREADS = 32;

async function onlyOnce(threadId: string, clientId: unknown, run: () => Promise<unknown>): Promise<unknown> {
  if (typeof clientId !== "string" || !clientId) return await run();
  let held = bridgeReplies.get(threadId);
  if (!held) bridgeReplies.set(threadId, (held = new Map()));
  if (held.has(clientId)) return held.get(clientId);
  const result = await run();
  held.set(clientId, result);
  for (const stale of [...held.keys()].slice(0, Math.max(0, held.size - MAX_REPLIES_PER_THREAD))) held.delete(stale);
  for (const stale of [...bridgeReplies.keys()].slice(0, Math.max(0, bridgeReplies.size - MAX_REPLY_THREADS))) bridgeReplies.delete(stale);
  return result;
}

async function bridgeDispatch(method: BridgeMethod, params: Record<string, unknown>): Promise<unknown> {
  const userData = app.getPath("userData");
  const flag = (value: unknown, label: string) => {
    if (typeof value !== "boolean") throw new Error(`${label} is invalid`);
    return value;
  };
  const cwd = () => folders!.directory(boundedCapabilityId(params.folderId, "Folder"));
  const paths = () => {
    const files = commitPaths(params.paths);
    if (!files.length) throw new Error("Pick at least one file.");
    return files;
  };
  switch (method) {
    case "snapshot": {
      const stored = await threadSummaryStore();
      return {
        threads: stored.threads.map((thread) => ({ ...thread, folderIds: threadFolderIds(thread.id) })),
        warnings: stored.warnings,
      };
    }
    case "threadMessages": {
      const threadId = boundedCapabilityId(params.threadId, "Thread");
      const thread = await runRequest(validateRequest({ method: "thread", params: { threadId } })).catch(() => undefined) as { messages?: Message[] } | undefined;
      if (!thread) throw new Error("That thread is gone.");
      const messages = thread.messages ?? [];
      const total = messages.length;
      const before = Math.min(gitCount(params.before, "Before") ?? total, total);
      const limit = Math.min(gitCount(params.limit, "Limit") || MESSAGE_PAGE, MESSAGE_PAGE);
      const from = Math.max(0, before - limit);
      return phonePage(messages.slice(from, before), total, from);
    }
    case "live":
      return bridgeLive();
    case "createThread": {
      const parentThreadId = params.parentThreadId === undefined ? undefined : boundedCapabilityId(params.parentThreadId, "Parent thread");
      const created = await answerRequest(method, parentThreadId ? { parentThreadId } : {});
      changed();
      return threadSummary(created);
    }
    case "renameThread":
      return threadSummary(await runRequest(validateRequest({ method, params: { threadId: params.threadId, title: params.title } })));
    case "setThreadArchived":
      return threadSummary(await runRequest(validateRequest({ method, params: { threadId: params.threadId, archived: flag(params.archived, "Archived") ? "true" : "false" } })));
    case "sendMessage":
      return await onlyOnce(String(params.threadId), params.clientId, async () => {
        const { content, skillContext } = await resolveMentions(typeof params.content === "string" ? params.content : "");
        const images = bridgeImages(params.attachedImages);
        return threadSummary(await runRequest(validateRequest({
          method,
          params: {
            threadId: params.threadId,
            content,
            ...(typeof params.attachedContext === "string" && params.attachedContext.trim() ? { attachedContext: params.attachedContext } : {}),
            ...(images.length ? { attachedImages: JSON.stringify(images) } : {}),
            ...(skillContext ? { skillContext } : {}),
          },
        })));
      });
    case "stopAgent":
      if (params.threadId === undefined) stopEveryThread();
      else stopThread(boundedCapabilityId(params.threadId, "Thread"));
      return { stopped: true };
    case "steerAgent":
      return await onlyOnce(String(params.threadId), params.clientId, async () => {
        const request = agentMessage(params);
        await steerThread(request.threadId, request.text);
        return { steered: true };
      });
    case "answerPermission":
      agents!.answer(boundedCapabilityId(params.id, "Permission"), flag(params.allowed, "Permission answer"));
      return { answered: true };
    case "getThreadContext": {
      const threadId = boundedCapabilityId(params.threadId, "Thread");
      const context = threadContexts.get(threadId);
      return { threadId, folderIds: context?.folderIds ?? [], mode: context?.mode ?? DEFAULT_PERMISSION_MODE, model: context?.model ?? "", effort: context?.effort ?? "" };
    }
    case "setThreadContext": {
      const { threadId, ...context } = threadContextRequest(params);
      keepThreadContext(threadId, context);
      agents!.setMode(threadId, context.mode);
      return { threadId, folderIds: context.folderIds, mode: context.mode, model: context.model };
    }
    case "clearThreadContext": {

      const threadId = boundedCapabilityId(params.threadId, "Clear context thread");
      compactNext.delete(threadId);
      for (const client of harnesses.values()) client.forgetSession(threadId);
      return { cleared: true };
    }
    case "threadTraces": {
      return phoneTraces(await readThreadTraces(boundedCapabilityId(params.threadId, "Thread")));
    }
    case "listModels": {
      const catalog = await runRequest(validateRequest({ method: "listOpenRouterModels", params: params.force === true ? { force: "true" } : {} }));
      const models = (catalog as { models?: CatalogModel[] }).models ?? [];

      return [
        ...models.map((model): ModelEntry => ({
          id: model.id,
          key: `openrouter:${model.id}`,
          name: model.name,
          contextLength: model.contextLength,
          free: model.free,
          efforts: model.reasoningEfforts ?? [],
          source: "openrouter",
          promptMicroUsdPerMtok: model.promptMicroUsdPerMtok,
          completionMicroUsdPerMtok: model.completionMicroUsdPerMtok,
          inputModalities: model.inputModalities,
          reasoningMandatory: model.reasoningMandatory,
        })),
        ...providers.map((profile): ModelEntry => {
          const metadata = modelMetadata?.provider(profile);
          return {
            id: profile.id,
            key: `provider:${profile.id}`,
            name: profile.name,
            contextLength: metadata?.contextWindow ?? profile.contextWindow ?? 0,
            free: true,
            efforts: metadata?.reasoningEfforts ?? [],
            source: "provider",
          };
        }),
        ...routers.map((router): ModelEntry => {
          const first = routerChain(modelCatalog?.ids(), router.models).split(",")[0] ?? "";
          return {
            id: router.id,
            key: routerKey(router.id),
            name: router.name,
            contextLength: modelCatalog?.contextLength(first) ?? 0,
            free: models.find((model) => model.id === first)?.free ?? false,
            efforts: modelCatalog?.reasoningEfforts(first) ?? [],
            source: "router",
          };
        }),
      ];
    }
    case "setThreadModel":
      await runRequest(validateRequest({ method, params: { threadId: params.threadId, modelId: params.modelId, ...(params.effort === undefined ? {} : { effort: params.effort }) } }));
      return { set: true };
    case "listFolders":
      return visibleFolders();
    case "listPlans":
      return await listPlans(userData);
    case "listCommands": {
      const threadId = params.threadId === undefined ? undefined : boundedCapabilityId(params.threadId, "Thread");
      const [skills, servers, artifacts] = await Promise.all([
        searchImportedSkills(userData, "", MAX_SKILL_RESULTS).catch(() => []),
        listImportedMcpServers(userData).catch(() => []),
        listArtifacts(userData).catch(() => []),
      ]);
      const vault = readVault(userData);
      const grants = visibleFolders();
      const attached = threadId === undefined ? [] : threadContexts.get(threadId)?.folderIds ?? [];
      return {
        slash: [
          ...BUILTIN_COMMANDS,
          ...skills.filter((skill) => !toolSettings.disabledSkills.includes(skill.id)).map((skill) => ({ id: skill.id, name: skill.name, kind: "skill" as const, detail: `${skill.source} · skill` })),
          ...servers.filter((server) => !toolSettings.disabledServers.includes(server.id)).map((server) => ({ id: server.id, name: server.name, kind: "mcp" as const, detail: `${server.source} · MCP server` })),
          ...TOOL_CATALOG
            .filter((tool) => !toolSettings.disabledTools.includes(tool.name))
            .map((tool) => ({ id: `tool:${tool.name}`, name: tool.name, kind: "tool" as const, detail: tool.blurb })),
        ],
        at: [
          ...artifacts.map((artifact) => ({ id: `artifact:${artifact.id}`, name: pathName(artifact.title), kind: "artifact" as const, detail: `${ARTIFACT_LABELS[artifact.kind]} · artifact` })),
          ...notesOrNone(vault).map((note) => ({ id: `note:${note.path}`, name: pathName(note.title), kind: "page" as const, detail: [keepKindLabel(note.kind), ...note.tags].join(" · ") })),
          ...attached.flatMap((folderId) => {
            const folder = grants.find((grant) => grant.id === folderId);
            return folder ? folders!.files(folderId).files.map((file) => ({ id: `file:${folderId}:${file.path}`, name: pathName(file.path), kind: "file" as const, detail: `${folder.name}/${file.path}` })) : [];
          }),
        ],
      } satisfies CommandMenu;
    }
    case "listArtifacts":
      return await listArtifacts(userData);
    case "readArtifact": {
      const id = boundedCapabilityId(params.id, "Artifact");
      const { path: _file, ...artifact } = await readArtifact(userData, id);
      return { ...artifact, files: artifact.kind === "app" ? await artifactFiles(userData, id) : [] };
    }
    case "deleteArtifact":
      await deleteArtifact(userData, boundedCapabilityId(params.id, "Artifact"));
      artifactsChanged();
      return { deleted: true };
    case "readBlob": {
      const id = boundedCapabilityId(params.id, "Artifact");
      if (params.file === undefined) {
        const artifact = await readArtifact(userData, id);
        return { mime: "text/plain; charset=utf-8", base64: Buffer.from(artifact.content, "utf8").toString("base64") };
      }
      const file = boundedCapabilityId(params.file, "Artifact file");
      return { mime: artifactFileType(file), base64: Buffer.from(await readArtifactFile(userData, id, file), "utf8").toString("base64") };
    }
    case "readImage": {
      const found = namedPath(params.path);
      const granted = found !== undefined && folders!.list().some((folder) => pathInside(folder.path, found));

      if (found === undefined || !(granted || attachments!.holds(found))) throw new Error("Not an image Emma can show");
      const frame = nativeImage.createFromPath(found);
      if (frame.isEmpty()) throw new Error("Not an image Emma can show");

      return { mime: "image/jpeg", base64: compressScreenFrame(frame).image.split(",")[1] };
    }
    case "readVisual":
      return bridgeVisual(params.id);
    case "keepVisual": {
      const visual = bridgeVisual(params.id);
      const { content: _content, path: _path, ...meta } = await writeArtifact(userData, { title: visual.title, kind: "html", content: visualPage(visual.html) });
      artifactsChanged();
      return meta;
    }
    case "gitReady":
      return await gitReady(cwd());
    case "gitStatus": {
      const snapshot = await gitSnapshot(cwd());
      if (!snapshot || params.diff === true) return snapshot;
      return { ...snapshot, diff: "", truncated: false };
    }
    case "gitFileDiff": {
      const [file] = commitPaths([params.path]);
      const directory = cwd();
      const tracked = await runGit(directory, ["diff", "--no-color", "HEAD", "--", file]);
      return { diff: (tracked.ok ? tracked : await runGit(directory, ["diff", "--no-color", "--", file])).output };
    }
    case "gitHistory":
      return await gitHistory(cwd(), { skip: gitCount(params.skip, "Skip"), limit: gitCount(params.limit, "Limit") });
    case "gitStage":
      await namedGit(cwd(), ["add", "--", ...paths()]);
      return { staged: true };
    case "gitUnstage":
      await namedGit(cwd(), ["restore", "--staged", "--", ...paths()]);
      return { unstaged: true };
    case "gitCommit": {
      const message = params.message === undefined ? "" : params.message;
      if (typeof message !== "string" || Buffer.byteLength(message) > MAX_COMMIT_MESSAGE_BYTES) throw new Error("That commit message is invalid");
      return { hash: await commit(cwd(), { message, paths: params.paths, amend: params.amend === true }) };
    }
    case "gitDiscard":
      await discard(cwd(), params.paths);
      return { discarded: true };
    case "gitMessage": {
      const snapshot = await gitSnapshot(cwd());
      if (!snapshot) throw new Error("That folder is not a git repository.");
      return { message: await writeCommitMessage(tagger, { diff: snapshot.diff, files: snapshot.files }) };
    }
    case "gitPush": {
      const directory = cwd();
      return await gitSynced(directory, await runGit(directory, ["push", ...(params.setUpstream === true ? ["--set-upstream", "origin", "HEAD"] : [])]));
    }
    case "gitPull": {
      const directory = cwd();
      return await gitSynced(directory, await runGit(directory, ["pull", ...(params.rebase === true ? ["--rebase"] : [])]));
    }
    case "setBranch": {
      const branch = boundedCapabilityId(params.branch, "Branch");
      await switchBranch(cwd(), branch, params.create === true, params.from === undefined ? undefined : boundedCapabilityId(params.from, "Branch"));
      return { branch };
    }
    case "keyStatus": {
      const key = process.env[OPENROUTER_ENV]?.trim() ?? "";
      return {
        env: OPENROUTER_ENV,
        masked: credentials!.list().find((item) => item.env === OPENROUTER_ENV)?.masked ?? "",
        balance: key ? await fetchOpenRouterBalance(key) : null,
        zeroRetention: process.env.EMMA_OPENROUTER_ZDR !== undefined,
        selectedModel,
      } satisfies KeyStatus;
    }
    case "listCredentials":
      return credentialSlotsHeld();
    case "saveCredential": {
      const slot = credentialSlot(params);

      if (!credentialSlotsHeld().some((held) => held.env === slot.env)) throw new Error(`That is not a key this ${DEVICE} holds a slot for.`);

      if (slot.secret === undefined) credentials!.remove(slot.env);
      else credentials!.set(slot.env, slot.secret);
      startHost();
      recycleHarnesses();
      return credentialSlotsHeld();
    }
    case "setZeroRetention": {
      const on = flag(params.on, "Zero retention");
      if ((process.env.EMMA_OPENROUTER_ZDR !== undefined) !== on) {
        if (on) process.env.EMMA_OPENROUTER_ZDR = "1";
        else delete process.env.EMMA_OPENROUTER_ZDR;
        recycleHarnesses();
        broadcast("emma:changed");
      }
      return { zeroRetention: on };
    }
    case "getSettings":
      return {
        defaultPermissionMode: defaultMode,
        selectedModel,
        thinkingLevel: selectedEffort,
        review: { enabled: reviewSettings.enabled, model: reviewSettings.model },
      } satisfies MacSettings;
    case "setSettings": {

      if (params.defaultPermissionMode !== undefined) defaultMode = asPermissionMode(params.defaultPermissionMode);
      if (params.selectedModel !== undefined) {
        const picked = params.selectedModel;
        if (typeof picked !== "string" || picked.length > 256) throw new Error("Model is invalid");
        selectedModel = !picked ? "" : picked.startsWith("provider:") || picked.startsWith("router:") ? routedModelKey(picked) : `openrouter:${catalogued(picked)}`;
        if (!picked) selectedEffort = "";
      }
      if (params.thinkingLevel !== undefined) selectedEffort = thinkingLevel(params.thinkingLevel);
      if (params.review !== undefined) {
        if (!params.review || typeof params.review !== "object" || Array.isArray(params.review)) throw new Error("Review settings are invalid");
        reviewSettings = validateReview({ ...reviewSettings, ...params.review });
      }
      return await bridgeDispatch("getSettings", {});
    }
    case "listToolTargets": {
      const [written, found, servers] = await Promise.all([
        listEmmaTools(userData),

        capabilities!.searchSkills("", MAX_PHONE_SKILLS + 1),
        capabilities!.listMcpServers(),
      ]);
      const imported = found.filter((skill) => skill.source !== "installed");
      const kept = phoneList(imported.slice(0, MAX_PHONE_SKILLS));
      return {
        catalog: TOOL_CATALOG.map((tool) => ({ ...tool, gate: toolGate(defaultMode, tool.name) })),
        written: written.map((tool) => ({ id: `run_tool:${tool.name}`, name: tool.name, source: tool.description })),
        skills: { rows: kept.rows, capped: kept.capped || imported.length > MAX_PHONE_SKILLS },
        servers: phoneList(servers),
        disabled: toolSwitches(),
      } satisfies ToolTargets;
    }
    case "setToolSettings": {

      toolSettings = validateToolSettings({
        ...toolSettings,
        disabledTools: params.disabledTools ?? toolSettings.disabledTools,
        disabledSkills: params.disabledSkills ?? toolSettings.disabledSkills,
        disabledServers: params.disabledServers ?? toolSettings.disabledServers,
      });
      await toolsChanged();
      return toolSwitches();
    }
    case "installMcpServer": {

      const definition = mcpServerRequest(params);
      const approved = await confirmOnMac(
        `Install the MCP server “${definition.name}” from your phone?`,
        `Emma will run this on your Mac, and again on every turn that uses it:\n\n${[definition.command, ...definition.args ?? []].join(" ")}`,
        "Install it",
      );
      if (!approved) throw new Error("Nobody at your Mac approved that server.");
      const { id } = await capabilities!.installMcpServer(definition);
      await toolsChanged();
      return { id };
    }
    case "listPlugins":
      return await phonePlugins(userData);
    case "trustPluginHooks": {

      const id = boundedCapabilityId(params.id, "Plugin");
      const trusted = flag(params.trusted, "Trust");
      let hashes: string[] | null = null;
      if (trusted) {
        const plugin = (await installedHooks(userData)).find((entry) => entry.id === id);
        if (!plugin) throw new Error(`No plugin called "${id}" is installed.`);

        const running = plugin.hooks.filter((hook) => hookRuns(hook.event));
        if (!running.length) throw new Error(`"${plugin.displayName || plugin.name}" has no hook Emma would ever run.`);
        const approved = await confirmOnMac(
          `Trust the hooks in “${plugin.displayName || plugin.name}” from your phone?`,
          `Emma will run these on your Mac, on every turn that reaches their moment:\n\n${plugin.hooks.map((hook) => `${hook.event}${hookRuns(hook.event) ? "" : " (Emma has no such moment)"}: ${hook.command}`).join("\n\n")}`,
          "Trust them",
        );
        if (!approved) throw new Error("Nobody at your Mac approved those hooks.");
        hashes = plugin.hooks.map((hook) => hook.hash);
      }
      await setHookTrust(userData, id, hashes);
      return await phonePlugins(userData);
    }
    case "listImportSources": {
      const registered = new Set(await registeredImportIds(userData));
      return (await discoverImports(homedir())).map((source) => ({ ...source, registered: registered.has(source.id) }));
    }
    case "setImportSources": {

      const ids = params.ids;
      if (!Array.isArray(ids) || ids.length > MAX_IMPORT_SOURCES || ids.some((id) => typeof id !== "string")) throw new Error("Import selection is invalid");
      const known = await registeredImportIds(userData);
      const adding = (ids as string[]).filter((id) => !known.includes(id));
      if (adding.length) {
        const labels = importSources(homedir()).filter((source) => adding.includes(source.id)).map((source) => source.label).join(", ");
        const approved = await confirmOnMac(
          "Read another agent's skills and MCP servers?",
          `Emma will read ${labels} on this ${DEVICE} and start the servers their config files name.`,
          "Import",
        );
        if (!approved) throw new Error("Nobody at your Mac approved that import.");
      }
      const saved = await saveImportManifest(userData, homedir(), ids as string[]);
      await toolsChanged();
      return saved;
    }
    case "readSkill": {
      const id = boundedCapabilityId(params.id, "Skill");
      if (toolSettings.disabledSkills.includes(id)) throw new Error("That skill is switched off in Settings \u2192 Tools.");
      return await capabilities!.selectSkill(id);
    }
    case "writeSkill": {
      const skill = await writeLearnedSkill(userData, params.name, params.instructions);
      await toolsChanged();
      return skill;
    }
    case "setGoal": {
      const thread = await setGoal(goalIpc(params));
      if (!thread) throw new Error("That thread is gone.");
      return threadSummary(thread);
    }
    case "updateGoal": {
      const thread = await updateGoal(goalIpc(params));
      if (!thread) throw new Error("That thread is gone.");
      return threadSummary(thread);
    }
    case "clearGoal": {
      const thread = await goalRequest("clearGoal", { threadId: boundedCapabilityId(params.threadId, "Goal thread") });
      if (!thread) throw new Error("That thread is gone.");
      return threadSummary(thread);
    }
    case "listTaskLists": {

      const threadId = typeof params.threadId === "string" ? params.threadId : "";
      const lists = await listTaskLists(userData);
      return phoneList(threadId ? lists.filter((list) => !list.threadId || list.threadId === threadId) : lists);
    }
    case "threadChanges": {

      const changes = agents!.changes(boundedCapabilityId(params.threadId, "Changes thread")).map(({ after: _after, ...change }) => ({
        ...change,
        before: change.before === null ? null : change.before.slice(0, MAX_PHONE_TEXT_CHARS),
        truncated: change.before !== null && change.before.length > MAX_PHONE_TEXT_CHARS,
      }));

      const { rows, capped } = phoneList(changes.reverse());
      return { rows: rows.reverse(), capped };
    }
    case "revertChange": {
      const folderId = boundedCapabilityId(params.folderId, "Revert folder");
      const file = params.path;
      if (typeof file !== "string" || !file || Buffer.byteLength(file, "utf8") > 4096 || file.includes("\0")) throw new Error("Revert path is invalid");

      const before = recordedRevert(folderId, file);
      if (escapesRoot(folders!.directory(folderId), file)) throw new Error("That file is outside the granted folder.");
      folders!.write(folderId, file, before);
      changed();
      return { reverted: true };
    }
    case "runCommand": {

      const { command, folderId } = runCommandRequest(params);
      const directory = folderId ? folders!.directory(folderId) : homedir();
      const approved = await confirmOnMac(
        "Run a command from your phone?",
        `Emma will run this on your Mac now, in ${directory}:\n\n${command}`,
        "Run it",
      );
      if (!approved) throw new Error("Nobody at your Mac approved that command.");
      return background.start(directory, command, folderId ? folderNames([folderId])[0] ?? "" : "");
    }
    case "listBackground":
      return background.list();
    case "readBackground":
      return background.output(boundedCapabilityId(params.id, "Background task"), MAX_COMMAND_OUTPUT) ?? null;
    case "stopBackground":
      return { stopped: background.stop(boundedCapabilityId(params.id, "Background task")) };
    case "listMemories":
      return await phoneMemories();
    case "readMemory": {

      const file = resolveMemoryPath(memoryRoot(), params.path);
      const stats = statSync(file);
      if (!stats.isFile()) throw new Error("That memory cannot be read.");
      return {
        text: readFileSync(file).subarray(0, MAX_MEMORY_FILE_BYTES).toString("utf8"),
        truncated: stats.size > MAX_MEMORY_FILE_BYTES,
      };
    }
    case "deleteMemory":
      await runMemoryCommand(memoryRoot(), { command: "delete", path: typeof params.path === "string" ? params.path : "" });
      return await phoneMemories();
    case "listNotes": {
      const vault = readVault(userData);

      return vault ? phoneList(listNotes(vault)) : { rows: [], capped: false };
    }
    case "readNote": {
      const vault = readVault(userData);
      if (!vault) throw new Error("No vault is connected.");
      const note = path.join(notesRoot(vault), noteInVault(vault, params.path));
      const stats = statSync(note);
      if (!stats.isFile()) throw new Error("That note cannot be read.");

      return { text: readFileSync(note).subarray(0, MAX_NOTE_BYTES).toString("utf8"), truncated: stats.size > MAX_NOTE_BYTES };
    }
    case "keep":
      return await keep(keepRequest(params), false);
    case "listNoteFolders": {
      const vault = readVault(userData);
      return vault ? listNoteFolders(vault) : [];
    }
    case "addFolder": {

      const asked = params.path;
      if (typeof asked !== "string" || !path.isAbsolute(asked) || asked.length > 1024) throw new Error("Name the folder by its full path.");
      const directory = realpathSync(asked);
      if (!statSync(directory).isDirectory()) throw new Error("That is not a folder.");
      const held = folders!.list().some((grant) => samePath(grant.path, directory));
      if (!held && !pathInside(homedir(), directory)) throw new Error("From a phone, Emma only connects folders inside your home folder.");
      const granted = held || await confirmOnMac(
        "Connect a folder from your phone?",
        `Emma will be able to read and write everything in ${directory}, and its agents will run against it. Only connect a folder you asked for from your phone just now.`,
        "Connect this folder",
      );
      if (!granted) throw new Error("Nobody at your Mac approved that folder.");
      folders!.add(directory);
      return visibleFolders();
    }
    case "forgetFolder": {
      const id = boundedCapabilityId(params.id, "Folder");
      if (id === vaultFolderId) throw new Error("Your vault stays connected; change it from Settings.");
      folders!.remove(id);
      return visibleFolders();
    }
    case "listCliRuns":
      return clis.list();
    case "readCliRun": {
      const view = clis.output(boundedCapabilityId(params.id, "CLI run"), MAX_CLI_VIEW_CHARS);
      return view ? { ...view, truncated: view.output.length >= MAX_CLI_VIEW_CHARS } : null;
    }
    case "stopCliRun":
      return { stopped: clis.stop(boundedCapabilityId(params.id, "CLI run")) };
    case "sendCliRun": {
      const { id, prompt } = cliSendRequest(params);
      await clis.send(id, prompt);
      return clis.get(id) ?? null;
    }
    case "listCliModels": {
      const cli = boundedCapabilityId(params.cli, "CLI");
      if (!CLI_IDS.includes(cli)) throw new Error("Emma does not know that CLI.");
      return phoneList((await cliModels.read(cli, (id) => clis.where(id))).models);
    }
    case "setCliRunModel": {
      const id = boundedCapabilityId(params.id, "CLI run");
      const run = clis.get(id);
      if (!run) throw new Error("There is no such CLI run.");
      const selected = cliOptions(params);
      const model = selected.model ?? run.model ?? "";

      const { models } = await cliModels.read(run.cli, (cli) => clis.where(cli));
      if (model && !models.includes(model)) throw new Error(`That is not a model this ${DEVICE} found for that CLI.`);
      return clis.setOptions(id, selected);
    }
    case "listScheduledJobs":
      return await phoneJobs();
    case "saveScheduledJob": {

      const jobId = typeof params.jobId === "string" ? params.jobId : "";
      const existing = jobId ? (await scheduledJobs()).find((job) => job.id === jobId) : undefined;
      await runRequest(validateRequest({ method, params: {
        ...params,
        permissionMode: asPermissionMode(existing?.permissionMode),
        sourceDomains: JSON.stringify(existing?.sourceDomains ?? []),
        model: existing?.model ?? "",
      } }));
      return await phoneJobs();
    }
    case "deleteScheduledJob":
      await runRequest(validateRequest({ method, params: { jobId: params.jobId } }));
      return await phoneJobs();
    case "runScheduledJob":

      await runRequest(validateRequest({ method, params: { jobId: params.jobId } }));
      return { started: true };
    case "setScheduledJobEnabled":
      await runRequest(validateRequest({ method, params: { jobId: params.jobId, enabled: flag(params.enabled, "Enabled") ? "true" : "false" } }));
      return await phoneJobs();
    case "artifactSql":
      return await queryArtifact(userData, boundedCapabilityId(params.id, "Artifact"), params.sql, params.params);
  }
}

async function driveTurn(turn: TurnRequest) {
  refuseBenchTurn(turn.threadId);
  turn.title = threadNames.get(turn.threadId) || turn.title;
  turn.bench = benchThread(turn.threadId);
  return await runDrivenTurn(turn);
}

async function runDrivenTurn(turn: TurnRequest) {
  if (!turn.goalTurn) goalStopped.delete(turn.threadId);
  let recorded: unknown;
  try {
    recorded = await runTurn(turn);
  } catch (error) {
    await noteGoalFailure(turn.threadId, error instanceof Error ? error.message : String(error));
    throw error;
  }
  const thread = noteThread(recorded);
  await noteGoalFailure(turn.threadId, agents!.list().find((agent) => agent.threadId === turn.threadId)?.error);
  if (!turn.goalTurn) void continueGoal(turn, thread).catch((error: unknown) => console.error("Emma: a goal's continuation failed", error));
  if (wantsReview(turn, thread)) void reviewWork(turn, recorded).catch((error: unknown) => console.error("Emma: a second-model review failed", error));
  return recorded;
}

function noteGoalOverspent(threadId: string) {
  stopThread(threadId);
  void goalRequest("updateGoal", { threadId, status: "budgetLimited", reason: GOAL_OVERSPENT }).catch(() => undefined);
}

function wantsReview(turn: TurnRequest, thread: ThreadRecord | undefined): boolean {
  const touched = turnTouched.delete(turn.threadId) || agents!.changes(turn.threadId).length > 0;
  if (!reviewSettings.enabled || !reviewSettings.model.trim()) return false;
  if (turn.reviewed || turn.goalTurn || turn.nested || turn.parentThreadId || turn.depth || turn.bench) return false;
  if (thread?.archivedAt || reviewing.has(turn.threadId) || goalStopped.has(turn.threadId)) return false;
  if (activeGoal(turn.threadId) || goalDriving.has(turn.threadId)) return false;
  if (!(threadContexts.get(turn.threadId)?.review ?? true)) return false;
  if (!threadFolderIds(turn.threadId).length) return false;
  if (agents!.list().find((agent) => agent.threadId === turn.threadId)?.status !== "done") return false;
  return touched;
}

const reviewHalted = (threadId: string) => goalStopped.has(threadId) || agents!.isLive(threadId);

async function reviewWork(turn: TurnRequest, recorded: unknown) {
  reviewing.add(turn.threadId);
  try {
    let answered = lastAssistantMessage(recorded) ?? "";
    for (let round = 0; round < MAX_REVIEW_ROUNDS; round += 1) {
      if (reviewHalted(turn.threadId)) return;
      const said = await runReview(turn, answered);
      if (reviewVerdict(said) === "ship" || reviewHalted(turn.threadId)) return;
      const redone = await driveTurn({
        threadId: turn.threadId,
        content: revisionPrompt(modelName(reviewSettings.model), said),
        mode: threadContexts.get(turn.threadId)?.mode ?? agents!.mode(turn.threadId),
        title: turn.title,
        model: turn.model,
        subagent: turn.subagent,
        reviewed: true,
      });
      if (noteThread(redone)?.archivedAt) return;
      answered = lastAssistantMessage(redone) ?? "";
    }
  } finally {
    reviewing.delete(turn.threadId);
  }
}

async function runReview(turn: TurnRequest, answered: string): Promise<string> {
  const title = reviewTitle(turn.title);
  const created = await host!.request({ method: "createThread", params: { parentThreadId: turn.threadId, title } });
  const threadId = (created as { id?: unknown }).id;
  if (typeof threadId !== "string") throw new Error("Emma host returned an invalid thread");
  const parent = threadContexts.get(turn.threadId);
  if (parent) rememberThreadContext(threadId, { ...parent, model: reviewSettings.model, effort: "", review: false });
  reviewThreads.add(threadId);
  changed();
  try {
    const recorded = await driveTurn({
      threadId,
      content: reviewPrompt(turn.content, answered),
      mode: threadMode(turn.threadId),
      title,
      model: reviewSettings.model,
      parentThreadId: turn.threadId,
      nested: true,
      reviewed: true,
    });
    return lastAssistantMessage(recorded) ?? "";
  } finally {
    reviewThreads.delete(threadId);
  }
}

async function noteGoalFailure(threadId: string, detail: string | undefined) {
  if (!usageLimitedFailure(detail) || !goals.get(threadId)) return;
  await goalRequest("updateGoal", { threadId, status: "usageLimited", reason: detail!.slice(0, MAX_GOAL_REASON_CHARS) }).catch(() => undefined);
}

const goalHalted = (threadId: string) =>
  goalStopped.has(threadId) || agents!.list().some((agent) => agent.threadId === threadId
    && (agent.status === "stopped" || agent.status === "running" || agent.status === "waiting"));

async function continueGoal(turn: TurnRequest, thread: ThreadRecord | undefined) {
  const threadId = turn.threadId;
  const subagent = !!turn.parentThreadId || !!turn.depth || thread?.kind === "subagent";
  if (subagent || thread?.archivedAt || goalDriving.has(threadId)) return;
  goalDriving.add(threadId);
  let archived = false;
  try {
    while (!archived && goalDrivesAgain({ goal: goals.get(threadId), subagent, halted: goalHalted(threadId) })) {
      archived = !!noteThread(await driveTurn({
        threadId,
        content: GOAL_CONTINUATION,
        mode: threadContexts.get(threadId)?.mode ?? agents!.mode(threadId),
        title: turn.title,
        model: turn.model,
        subagent: turn.subagent,
        goalTurn: true,
        objective: goals.get(threadId)?.objective,
      }))?.archivedAt;
    }
  } finally {
    goalDriving.delete(threadId);
    goalStopped.delete(threadId);
  }
}

type StoredJob = {
  id: string; title: string; schedule: string; prompt: string; nodes: string; outputs: string;
  sourceDomains: string[]; enabled: boolean; permissionMode: string; model: string;
  nextRunAt?: string | null; lastRunAt?: string | null;
};

async function scheduledJobs(): Promise<StoredJob[]> {
  const snapshot = await host!.request({ method: "threadSummaries", params: {} }) as { scheduledJobs?: StoredJob[] };
  return snapshot.scheduledJobs ?? [];
}

const MAX_PHONE_LIST_BYTES = 256 * 1024;

const MAX_PHONE_TEXT_CHARS = 2048;

function phoneList<T>(rows: readonly T[]): PhoneList<T> {
  const kept: T[] = [];
  let used = 0;
  for (const row of rows) {
    used += Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (used > MAX_PHONE_LIST_BYTES) break;
    kept.push(row);
  }

  return { rows: kept, capped: kept.length < rows.length };
}

function phoneSpans(spans: Record<string, TraceSpan[]>): Record<string, PhoneTraceSpan[]> {
  const out: Record<string, PhoneTraceSpan[]> = {};
  let used = 0;
  for (const [threadId, list] of Object.entries(spans)) {
    out[threadId] = list.map((span) => {

      const preview = clipped(span);
      const kept = used > MAX_PHONE_LIST_BYTES
        ? { ...preview, input: undefined, output: undefined, truncated: true }
        : preview;
      used += Buffer.byteLength(JSON.stringify(kept), "utf8") + 1;
      return kept;
    });
  }
  return out;
}

function clipped(span: TraceSpan): PhoneTraceSpan {
  const max = MAX_PHONE_TEXT_CHARS;
  const preview = { ...span };
  delete preview.context;
  if ((span.input?.length ?? 0) <= max && (span.output?.length ?? 0) <= max) return preview;
  return {
    ...preview,
    input: span.input === undefined ? undefined : span.input.slice(0, max),
    output: span.output === undefined ? undefined : span.output.slice(0, max),
    truncated: true,
  };
}

const MAX_PHONE_BODY_CHARS = 128 * 1024;

function phoneStep(step: RemoteStep): RemoteStep {
  const output = step.output;
  if (output === undefined || output.length <= MAX_PHONE_BODY_CHARS) return step;

  return { ...step, output: output.slice(0, MAX_PHONE_BODY_CHARS) };
}

const MIN_TRACE_CHARS = 8 * 1024;

function phoneTraces(traces: readonly StoredThreadTrace[]): ThreadTrace[] {
  const kept: ThreadTrace[] = [];
  let room = MAX_PHONE_LIST_BYTES;
  for (let index = traces.length - 1; index >= 0 && room >= MIN_TRACE_CHARS; index -= 1) {
    const trace = traces[index];
    const text = clampTrace(trace.text, room);
    room -= text.length + 64;
    kept.push(text.length < trace.text.length ? { ...trace, text, truncated: true } : trace);
  }

  if (kept.length && kept.length < traces.length) kept[kept.length - 1] = { ...kept[kept.length - 1], truncated: true };
  return kept.reverse();
}

function phonePage(messages: Message[], total: number, from: number): { messages: Message[]; total: number; from: number } {
  const page = messages.map((message) => message.content.length <= MAX_PHONE_BODY_CHARS ? message : {
    ...message,
    content: `${message.content.slice(0, MAX_PHONE_BODY_CHARS)}\n\n… clipped to reach your phone. The whole message is on your Mac.`,
  });
  const sizes = page.map((message) => Buffer.byteLength(JSON.stringify(message), "utf8") + 1);
  let used = sizes.reduce((sum, bytes) => sum + bytes, 0);
  let start = 0;
  while (start < page.length - 1 && used > MAX_PHONE_LIST_BYTES) {
    used -= sizes[start];
    start += 1;
  }
  return { messages: page.slice(start), total, from: from + start };
}

function phoneMemories(): Promise<PhoneList<MemoryNote>> {
  return listMemories(memoryRoot()).then((notes) => phoneList(notes.map((note) => ({
    ...note,
    text: note.text.slice(0, MAX_PHONE_TEXT_CHARS),
    truncated: note.text.length > MAX_PHONE_TEXT_CHARS,
  }))));
}

function phoneJobs(): Promise<PhoneList<ScheduledJob>> {
  return scheduledJobs().then((jobs) => phoneList(jobs.map(({ nodes: _nodes, outputs: _outputs, ...job }) => ({
    ...job,
    title: job.title.slice(0, MAX_PHONE_TEXT_CHARS),
    prompt: job.prompt.slice(0, MAX_PHONE_TEXT_CHARS),
    truncated: job.title.length > MAX_PHONE_TEXT_CHARS || job.prompt.length > MAX_PHONE_TEXT_CHARS,
  }))));
}

function phonePlugins(userData: string): Promise<PhoneList<PluginEntry>> {
  return installedHooks(userData).then((plugins) => phoneList(plugins.map((plugin) => ({
    id: plugin.id,
    displayName: plugin.displayName || plugin.name,
    marketplace: plugin.marketplace,
    version: plugin.version,
    skills: plugin.skills.length > 0,
    servers: plugin.mcpServers.length > 0,
    hooks: plugin.hooks.map((hook) => ({
      event: hook.event,
      command: hook.command.length > MAX_PHONE_TEXT_CHARS ? `${hook.command.slice(0, MAX_PHONE_TEXT_CHARS)}…` : hook.command,
      trusted: hook.trusted,
      runs: hookRuns(hook.event),
    })),
  }))));
}

function workflowScriptRoots(): string[] {
  const roots: string[] = [];
  for (const grant of folders!.list()) {
    try { roots.push(folders!.directory(grant.id)); } catch { continue; }
  }
  return roots;
}

async function validateWorkflowScripts(nodes: WorkflowNode[]): Promise<void> {
  const scripts = nodes.filter((node) => node.kind === "script");
  if (!scripts.length) return;
  const roots = workflowScriptRoots();
  await Promise.all(scripts.map((node) => workflowScriptPath(node.text, roots)));
}

async function resolveMentions(prompt: string): Promise<{ content: string; skillContext?: string }> {
  const named = mentions(prompt, "/");
  let skillContext: string | undefined;
  if (named.length) {
    const skills = await capabilities!.searchSkills("", 64);
    const skill = skills.find((item) => named.includes(item.name) && !toolSettings.disabledSkills.includes(item.id));
    if (skill) {
      skillContext = (await capabilities!.selectSkill(skill.id)).instructions;
      void recordUse(app.getPath("userData"), skillKey(skill.id));
    }
  }
  const sections: { heading: string; body: string }[] = [];
  const paths = mentions(prompt, "@");
  const userData = app.getPath("userData");
  const artifacts = paths.length ? await listArtifacts(userData).catch(() => []) : [];
  const vault = paths.length ? readVault(userData) : undefined;
  for (const mention of paths) {
    const artifact = artifacts.find((item) => pathName(item.title) === mention);
    if (artifact) {
      try {
        const read = await readArtifact(userData, artifact.id);
        sections.push({ heading: `Artifact ${read.title}`, body: read.content });
      } catch (error) {
        sections.push({ heading: `Artifact ${artifact.title}`, body: `Could not be read: ${error instanceof Error ? error.message : String(error)}` });
      }
      continue;
    }
    const note = vault ? listNotes(vault).find((item) => pathName(item.title) === mention) : undefined;
    if (note && vault) {
      const file = path.join(notesRoot(vault), noteInVault(vault, note.path));
      try {
        if (statSync(file).size > MAX_NOTE_BYTES) throw new Error("it is too large to attach");
        sections.push({ heading: `Note ${note.title}`, body: readFileSync(file, "utf8") });
      } catch (error) {
        sections.push({ heading: `Note ${note.title}`, body: `Could not be read: ${error instanceof Error ? error.message : String(error)}` });
      }
      continue;
    }
    for (const grant of folders!.list()) {
      const listed = folders!.files(grant.id).files.find((file) => pathName(file.path) === mention);
      if (!listed) continue;
      try {
        const file = folders!.read(grant.id, listed.path);
        sections.push({ heading: `File ${grant.name}/${file.path}`, body: file.text });
      } catch (error) {
        sections.push({ heading: `File ${grant.name}/${listed.path}`, body: `Could not be read: ${error instanceof Error ? error.message : String(error)}` });
      }
      break;
    }
  }
  return { content: sections.length ? `${prompt}\n\n${contextBlock(sections)}` : prompt, skillContext };
}

async function runScheduledWorkflow(job: HostDueJob["dueJob"]) {
  const { nodes, errors } = parseWorkflow(job.nodes, job.prompt);
  if (errors.length) {
    await host!.request({
      method: "recordTurn",
      params: { threadId: job.threadId, prompt: job.prompt, response: `This task did not run: its graph will not run as written.\n\n${errors.join("\n")}`, durationMilliseconds: "0", outputTokens: "0", inputTokens: "0" },
    });
    changed();
    return;
  }
  const mode = asPermissionMode(job.permissionMode);
  const run = await runWorkflow(nodes, parseVariables(job.variables), async (prompt, node, input) => {
    if (node.kind === "script") {
      try { return await runWorkflowScript(prompt, input, workflowScriptRoots()); }
      catch (error) { return `[script could not run: ${error instanceof Error ? error.message : String(error)}]`; }
    }
    const { content, skillContext } = await resolveMentions(prompt);
    const outcome = await driveTurn({ threadId: job.threadId, content, mode, title: job.title, model: job.model || selectedModel, ...(skillContext ? { params: { skillContext } } : {}) });
    return lastAssistantMessage(outcome) ?? "";
  });
  await host!.request({ method: "finishScheduledJob", params: { jobId: job.jobId, outputs: packVariables(run.variables), depth: String(job.depth) } });
  changed();
}

function fireEvent(event: string, variables: Record<string, string> = {}) {
  void host?.request({ method: "fireScheduledEvent", params: { event, variables: JSON.stringify(variables) } })
    .catch((error: unknown) => console.error(`Could not fire the "${event}" event:`, error));
}

function describeNode(node: WorkflowNode): string {
  const wiring = [node.saveAs ? `→ ${node.saveAs}` : "", node.next ? `next ${node.next}` : "", node.otherwise ? `otherwise ${node.otherwise}` : ""].filter(Boolean).join(" · ");
  return `  ${node.id} · ${node.kind} · ${node.text.replace(/\s+/g, " ").slice(0, 140)}${wiring ? `  [${wiring}]` : ""}`;
}

function describeJob(job: StoredJob): string {
  const { nodes, errors } = parseWorkflow(job.nodes, job.prompt);
  const state = [`trigger ${job.schedule}`, job.enabled ? "" : "paused", `mode ${job.permissionMode}`, job.model ? `model ${modelName(job.model)}` : "", job.nextRunAt ? `next ${job.nextRunAt}` : "", job.lastRunAt ? `last ran ${job.lastRunAt}` : ""].filter(Boolean).join(" · ");
  return [
    `${job.title} (${job.id})`,
    state,
    nodes.map(describeNode).join("\n"),
    errors.length ? `broken: ${errors.join(" ")}` : "",
    job.outputs.trim() ? `last outputs: ${job.outputs.slice(0, 400)}` : "",
  ].filter(Boolean).join("\n");
}

async function workflowTool(args: Extract<ToolArgs, { name: "workflow" }>): Promise<string> {
  const jobs = await scheduledJobs();
  const named = () => {
    const job = jobs.find((candidate) => candidate.id === args.jobId);
    if (!job) throw new Error(args.jobId ? `There is no scheduled task with the id ${args.jobId}. List them first.` : "Say which task with jobId.");
    return job;
  };
  switch (args.action) {
    case "list":
      return jobs.length ? jobs.map(describeJob).join("\n\n") : "There are no scheduled tasks yet.";
    case "get":
      return describeJob(named());
    case "delete": {
      const job = named();
      await host!.request({ method: "deleteScheduledJob", params: { jobId: job.id } });
      changed();
      scheduledJobsChanged();
      return `Deleted "${job.title}".`;
    }
    case "run": {
      const job = named();
      await host!.request({ method: "runScheduledJob", params: { jobId: job.id, variables: args.variables ?? "" } });

      changed();
      scheduledJobsChanged();
      return `Started "${job.title}". It runs as its own thread under Scheduled tasks; read it there when it finishes.`;
    }
    case "test": {
      const existing = args.jobId ? named() : undefined;
      const { nodes, errors } = parseWorkflow(args.nodes ?? existing?.nodes ?? "", args.prompt ?? existing?.prompt ?? "");
      if (errors.length) return `That graph will not run:\n${errors.join("\n")}`;
      await validateWorkflowScripts(nodes);
      const run = await runWorkflow(nodes, parseVariables(args.variables ?? existing?.outputs ?? ""), (text, node) => Promise.resolve(node.kind === "script" ? `(the script would run: ${text.slice(0, 200)})` : `(a turn would run: ${text.slice(0, 200)})`));
      return `Dry run — nothing was actually run:\n${describeRun(run.steps)}\n\nVariables afterwards: ${packVariables(run.variables)}`;
    }
    case "save": {
      const existing = args.jobId ? named() : undefined;
      const title = args.title ?? existing?.title;
      const trigger = args.trigger ?? existing?.schedule;
      const prompt = args.prompt ?? existing?.prompt;
      if (!title || !trigger || !prompt) throw new Error("A new task needs a title, a trigger and a prompt. Send all three the first time you save it.");
      const nodes = args.nodes ?? existing?.nodes ?? "";
      const graph = parseWorkflow(nodes, prompt);
      const errors = graph.errors;
      if (errors.length) return `Not saved — the graph will not run:\n${errors.join("\n")}`;
      await validateWorkflowScripts(graph.nodes);
      const saved = await host!.request({
        method: "saveScheduledJob",
        params: {
          jobId: existing?.id ?? "",
          title,
          schedule: trigger,
          prompt,
          nodes,
          sourceDomains: JSON.stringify(existing?.sourceDomains ?? []),
          permissionMode: asPermissionMode(args.permissionMode ?? existing?.permissionMode),
          model: args.model ?? existing?.model ?? "",
        },
      }) as { id?: string };
      changed();
      scheduledJobsChanged();
      return `${existing ? "Updated" : "Saved"} "${title}" (${saved.id ?? existing?.id}), triggered by ${trigger}. Nothing has run yet — test it, or run it once to see what it does.`;
    }
  }
}

function openRunBanner(threadId: string, task: string) {
  closeRunBanner();
  if (!globalShortcut.register("Escape", () => stopThread(threadId))) {
    stopThread(threadId);
    throw new Error("Emma could not register the computer-use Escape stop shortcut");
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = Math.min(520, display.workArea.width - 40);
  const window = secureWindow({
    x: display.workArea.x + Math.round((display.workArea.width - width) / 2),
    y: display.workArea.y + 16,
    width,
    height: 76,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
  });
  runBanner = window;
  pinWindow(window);
  window.on("closed", () => { if (runBanner === window) runBanner = null; });
  void load(window, "run", { threadId, task: task.slice(0, 200), maxSteps: String(MAX_RUN_STEPS) });
  openComputerCursor();
}

function openComputerCursor() {
  clearTimeout(computerCursorIdle);
  if (!runBanner) computerCursorIdle = setTimeout(closeComputerCursor, CURSOR_IDLE_MS);
  if (computerCursorWindow && !computerCursorWindow.isDestroyed()) return;
  const cursor = secureWindow({
    width: 1,
    height: 1,
    title: "Emma activity cursor",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
  });
  computerCursorWindow = cursor;
  cursor.setIgnoreMouseEvents(true);
  cursor.setHiddenInMissionControl(true);
  cursor.on("closed", () => { if (computerCursorWindow === cursor) computerCursorWindow = null; });
  void load(cursor, "computerCursor");
}

function closeComputerCursor() {
  clearTimeout(computerCursorTimer);
  clearTimeout(computerCursorIdle);
  computerCursorReady = false;
  computerCursorHeld = false;
  computerCursorProgress = undefined;
  computerCursorAt = 0;
  if (computerCursorWindow && !computerCursorWindow.isDestroyed()) computerCursorWindow.destroy();
  computerCursorWindow = null;
}

function closeRunBanner() {
  globalShortcut.unregister("Escape");
  computerProgress = undefined;
  closeComputerCursor();
  if (runBanner && !runBanner.isDestroyed()) runBanner.destroy();
  runBanner = null;
}

function startAnnotation() {
  if (!overlay || overlay.isDestroyed() || annotating) return;
  annotating = true;
  overlay.hide();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  annotationDisplay = display;
  annotationSource = undefined;
  const window = secureWindow({
    ...display.bounds,
    ...floating,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
  });
  annotation = window;
  pinWindow(window);
  window.on("closed", () => {
    if (annotation === window) annotation = null;
    annotating = false;
    annotationFrame = null;
    annotationDisplay = null;
    restoreOverlay();
  });
  void load(window, "annotation");
}

const APP_BRIDGE = '<script>(()=>{const w=new Map();let n=0;addEventListener("message",(e)=>{const a=w.get(e.data?.n);'
  + 'if(e.source!==parent||!a)return;w.delete(e.data.n);e.data.error?a[1](new Error(e.data.error)):a[0](e.data.rows)});'
  + 'window.emma={sql:(sql,...params)=>new Promise((ok,no)=>{w.set(++n,[ok,no]);parent.postMessage({emma:"sql",n,sql,params},"*")})}})()</script>';

function appPage(content: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(content);
  return doctype ? doctype[0] + APP_BRIDGE + content.slice(doctype[0].length) : APP_BRIDGE + content;
}

protocol.registerSchemesAsPrivileged([
  { scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: VISUAL_SCHEME, privileges: { standard: true, secure: true } },
  { scheme: COMPONENT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

app.commandLine.appendSwitch("remote-debugging-port", "0");

if (isWindows) {
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  Menu.setApplicationMenu(null);
}

function addUpdateMenuItem() {
  if (!isMac) return;
  const menu = Menu.getApplicationMenu();
  const submenu = menu?.items[0]?.submenu;
  if (!submenu) {
    console.warn("Emma: no application menu to add the update check to");
    return;
  }
  submenu.insert(1, new MenuItem({ label: "Check for Updates\u2026", click: () => checkForUpdates() }));
  Menu.setApplicationMenu(menu);
}

function handleSquirrelEvent(): boolean {
  if (!isWindows) return false;
  const event = readSquirrelEvent();
  if (!event) return false;
  const update = path.resolve(path.dirname(process.execPath), "..", "Update.exe");
  if (event === "install" || event === "updated") spawn(update, ["--createShortcut", "Emma.exe"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  if (event === "uninstall") spawn(update, ["--removeShortcut", "Emma.exe"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  app.quit();
  return true;
}

const squirrelHandled = handleSquirrelEvent();
const primaryInstance = squirrelHandled ? false : app.requestSingleInstanceLock({ version: app.getVersion() });
if (!primaryInstance && !squirrelHandled) {
  if (isMac && app.isPackaged) dialog.showErrorBox(
    "Another copy of Emma is running",
    `Emma ${app.getVersion()} at ${path.resolve(process.execPath, "../../..")} could not start because Emma is already running. Any Emma window shown belongs to that running copy.\n\nQuit the running Emma with Command-Q. Drag Emma.app from the disk image into Applications, choose Replace if asked, then open Emma from Applications. Replacing the app keeps your settings and conversations.`,
  );
  app.quit();
}
else app.on("second-instance", (_event, _argv, _cwd, data: unknown) => {
  if (isMac && app.isPackaged && data && typeof data === "object" && "version" in data && newerVersion(app.getVersion(), data.version)) return;
  void app.whenReady().then(openMain);
});

if (primaryInstance) app.whenReady().then(() => {
  if (!app.isPackaged) app.dock?.setIcon(path.join(app.getAppPath(), "assets", "emma-dock.png"));
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => pageMayAsk(contents, permission, details.mediaType ? [details.mediaType] : []));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(pageMayAsk(contents, permission, (details as { mediaTypes?: string[] }).mediaTypes ?? [])));
  protocol.handle(ARTIFACT_SCHEME, async (request) => {
    const notFound = (why: string, status = 404) => new Response(why, { status, headers: { "content-type": "text/plain" } });
    try {
      const userData = app.getPath("userData");
      const url = new URL(request.url);
      const id = boundedCapabilityId(url.hostname, "Artifact");
      const artifact = await readArtifact(userData, id);
      if (decodeURIComponent(url.pathname).replace(/^\/+/, "") === MODULE_PATH && artifact.surface) {
        if (artifact.kind !== "code") return notFound("Not a module.");
        return new Response(artifact.content, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      }
      if (artifact.kind !== "html" && artifact.kind !== "app") return notFound("Not a page.");
      const file = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (file) {
        if (artifact.kind !== "app") return notFound("Not a file.");
        return new Response(await readArtifactFile(userData, id, file), { headers: { "content-type": artifactFileType(file) } });
      }
      const own = `${ARTIFACT_SCHEME}://${id}`;
      return new Response(artifact.kind === "app" ? appPage(artifact.content) : artifact.content, { headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": artifact.kind === "app"
          ? `default-src 'none'; script-src 'unsafe-inline' ${own}; style-src 'unsafe-inline' ${own}; img-src data: ${own}; font-src data:`
          : "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:",
      } });
    } catch {
      return notFound("That artifact is no longer in the folder.");
    }
  });
  protocol.handle(COMPONENT_SCHEME, async (request) => {
    const notFound = (why: string) => new Response(why, { status: 404, headers: { "content-type": "text/plain" } });
    try {
      const url = new URL(request.url);
      const id = boundedCapabilityId(url.hostname, "Component");
      const file = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (file === COMPONENT_SHOT_PATH) return new Response(new Uint8Array(await readComponentShot(app.getPath("userData"), id)), { headers: { "content-type": "image/png" } });
      if (file !== COMPONENT_MODULE_PATH) return notFound("A component serves its module and its picture, nothing else.");
      return new Response((await readComponent(app.getPath("userData"), id)).code, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    } catch {
      return notFound("That component is no longer in the folder.");
    }
  });
  protocol.handle(VISUAL_SCHEME, (request) => {
    const visual = readVisual(new URL(request.url).hostname);
    if (!visual) return new Response("That visual is no longer in this conversation.", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(visualPage(visual.html), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": VISUAL_CSP } });
  });
  cliModels = new CliModelCatalog(app.getPath("userData"));
  credentials = new CredentialStore(app.getPath("userData"));
  folders = new FolderStore(app.getPath("userData"));
  const storedVault = readVault(app.getPath("userData"));
  if (storedVault) connectVault(storedVault);
  attachments = new AttachmentStore(app.getPath("userData"));
  modelCatalog = new CatalogCache(app.getPath("userData"));
  modelMetadata = new ModelMetadataCatalog(app.getPath("userData"));
  void modelMetadata.refresh(24 * 60 * 60 * 1000);
  startHost();
  fireEvent("launch");
  void host!.request({ method: "threadSummaries", params: {} }).then(primeGoals).catch(() => undefined);
  capabilities = new ImportedCapabilityRuntime(app.getPath("userData"));
  void seedBuiltinSkills(builtinSkills(), app.getPath("userData"), path.join(app.getPath("userData"), "harness"), ["artifact"]).then(syncHarnessSkills);
  computerRuntime = new ComputerUseRuntime(nativeHelper("emma-computer"), closeRunBanner, console.log, reportRunProgress);
  agents = new AgentRuntime({
    request: (method, params) => answerRequest(method, params),
    ask: (request: PermissionAsk) => {
      const askedAt = Date.now();

      const reached = bridge?.ask({ ...request, askedAt, expiresAt: askedAt + MAX_ASK_MS }) === true;
      if (!mainWindow || mainWindow.isDestroyed()) {

        if (!reached) agents!.answer(request.id, false);
        return;
      }
      needsYou("Emma needs your approval", request.summary);
      mainWindow.webContents.send("emma:permission-ask", request);
    },
    answered: (id, allowed) => {
      bridge?.resolved(id, allowed);
      mainWindow?.webContents.send("emma:permission-resolved", { id, allowed });
    },
    stopped: (threadId) => {
      if (computerRuntime?.threadId === threadId) computerRuntime.abort();
    },
    verify: (request) => review(request),
    advise: (transcript) => advise(toolSettings.advisor, transcript),
    spawnTurn: (turn, owner) => {
      const context = owner ? threadContexts.get(owner) : undefined;
      if (context && !threadContexts.has(turn.threadId)) rememberThreadContext(turn.threadId, { ...context });
      return driveTurn(turn);
    },
    changed: () => { broadcast("emma:agents", agents!.list()); broadcast("emma:spans", agents!.spans()); },
    step: (step) => broadcast("emma:step", step),
  });
  loadPhoneThreads();
  loadThreadContexts();
  bridge = createBridge({
    userData: app.getPath("userData"),
    identity: desktopIdentity,
    dispatch: async (method, params) => {
      if (method === "sendMessage" || method === "steerAgent" || method === "answerPermission") broadcast("emma:mobile-status", mobileStatus(Date.now()));
      const result = await bridgeDispatch(method, params);
      if (method === "createThread") {
        phoneThreads.add((result as ThreadSummary).id);
        writeFileSync(phoneThreadsFile(), JSON.stringify([...phoneThreads]));
        broadcast("emma:mobile-status", mobileStatus());
      }
      return result;
    },
    live: bridgeLive,
    onStatus: (status) => broadcast("emma:mobile-status", { ...status, threads: [...phoneThreads] }),
  });
  bridge.start();
  configureCouncil({
    route: councilRoute,
    rates: (modelId) => modelRates(path.join(app.getPath("userData"), "openrouter-catalog.json"), modelId),
    emit: (state) => broadcast("emma:council", state),
    land: async (state) => {
      const spent = state.voices.reduce((total, voice) => ({
        inputTokens: total.inputTokens + voice.inputTokens,
        outputTokens: total.outputTokens + voice.outputTokens,
        microDollars: total.microDollars + voice.microDollars,
      }), { inputTokens: 0, outputTokens: 0, microDollars: 0 });
      await recordTurn({
        threadId: state.threadId,
        prompt: state.question,
        answer: councilAnswer(state),
        durationMilliseconds: String(Date.now() - state.startedAt),
        inputTokens: String(spent.inputTokens),
        outputTokens: String(spent.outputTokens),
        ...(spent.microDollars > 0 ? { costMicroUsd: String(spent.microDollars) } : {}),
        model: `council of ${state.seats.length}`,
      });
      changed();
    },
    carried: async (threadId) => {
      const thread = await runRequest(validateRequest({ method: "thread", params: { threadId } })).catch(() => undefined) as { messages?: Message[] } | undefined;
      return (thread?.messages ?? []).slice(-6).map((message) => `${message.role}: ${message.content}`).join("\n\n");
    },
  });
  powerMonitor.on("resume", () => void resumeAfterSleep().catch((error: unknown) => console.error("Emma: could not pick a turn back up after sleep", error)));
  const stopComputerForLock = () => {
    if (computerRuntime?.threadId) stopThread(computerRuntime.threadId);
  };
  powerMonitor.on("suspend", stopComputerForLock);
  powerMonitor.on("lock-screen", stopComputerForLock);
  ipcMain.handle("emma:request", async (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !trustedSender(event.senderFrame.url, app.getAppPath(), process.env.EMMA_DEV_SERVER_URL)) {
      throw new Error("IPC sender is not allowed");
    }
    let request = validateRequest(value);
    if (request.method === "listOpenRouterModels") return answerRequest(request.method, request.params);
    let screenContextId: string | undefined;
    let skillAttachmentId: string | undefined;
    if (request.method === "sendMessage" && request.params.skillAttachmentId !== undefined) {
      mainWindowSender(event);
      skillAttachmentId = request.params.skillAttachmentId;
    }
    let delivered = false;
    let screenClaimed = false;
    let skillClaimed = false;
    try {
      if (request.method === "sendMessage" && request.params.screenContextId !== undefined) {
        if (event.sender !== overlay?.webContents) throw new Error("Screen context sender is not allowed");
        screenContextId = request.params.screenContextId;
        const attachment = annotationAttachment.claim(screenContextId);
        screenClaimed = true;
        const note = frontApplicationNote(attachment.source);
        request = {
          method: request.method,
          params: {
            threadId: request.params.threadId,
            content: request.params.content,
            screenContext: attachment.image,
            ...(note ? { attachedContext: mergeSkillContext(note, request.params.attachedContext ?? "") } : {}),
          },
        };
      }
      if (request.method === "sendMessage" && event.sender === overlay?.webContents) {
        const note = await overlayFront;
        if (note) request = { method: request.method, params: { ...request.params, attachedContext: mergeSkillContext(note, request.params.attachedContext ?? "") } };
      }
      if (skillAttachmentId) {
        const skill = skillAttachment.claim(skillAttachmentId, request.params.threadId);
        skillClaimed = true;
        request = {
          method: request.method,
          params: { threadId: request.params.threadId, content: request.params.content, ...(request.params.attachedContext ? { attachedContext: request.params.attachedContext } : {}), ...(request.params.attachedImages ? { attachedImages: request.params.attachedImages } : {}), ...(request.params.screenContext ? { screenContext: request.params.screenContext } : {}), skillContext: skill.instructions },
        };
      }
      const result = await runRequest(request);
      delivered = true;
      if (screenClaimed) annotationAttachment.finish(screenContextId!, true);
      if (skillClaimed) {
        skillAttachment.finish(skillAttachmentId!, true);
        void recordUse(app.getPath("userData"), skillKey(skillAttachmentId!));
      }
      return result;
    } finally {
      if (screenClaimed && !delivered) annotationAttachment.finish(screenContextId!, false);
      if (skillClaimed && !delivered) skillAttachment.finish(skillAttachmentId!, false);
    }
  });
  ipcMain.handle("emma:set-thread-context", (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== overlay?.webContents) mainWindowSender(event);
    const { threadId, ...context } = threadContextRequest(value);
    keepThreadContext(threadId, context);
    agents!.setMode(threadId, context.mode);
    return context.mode;
  });
  ipcMain.handle("emma:update-ready", (event) => {
    mainWindowSender(event);
    return readyUpdate();
  });
  ipcMain.handle("emma:install-update", (event) => {
    mainWindowSender(event);
    installUpdate();
  });
  ipcMain.handle("emma:harness-report", (event) => {
    mainWindowSender(event);
    return readHarnessReport();
  });
  ipcMain.handle("emma:restart-harness", (event) => {
    mainWindowSender(event);
    return restartHarnesses();
  });
  ipcMain.handle("emma:list-memories", (event) => {
    mainWindowSender(event);
    return listMemories(memoryRoot());
  });
  ipcMain.handle("emma:delete-memory", async (event, value: unknown) => {
    mainWindowSender(event);
    await runMemoryCommand(memoryRoot(), { command: "delete", path: typeof value === "string" ? value : "" });
    return listMemories(memoryRoot());
  });
  const councilThread = (value: unknown) => boundedCapabilityId((value as { threadId?: unknown } | null)?.threadId, "Thread");
  ipcMain.handle("emma:council-start", async (event, value: unknown) => {
    mainWindowSender(event);
    return await startCouncil(validateCouncilStart(value));
  });
  ipcMain.handle("emma:council-stop", (event, value: unknown) => {
    mainWindowSender(event);
    stopCouncil(councilThread(value));
    return null;
  });
  ipcMain.handle("emma:council-adopt", async (event, value: unknown) => {
    mainWindowSender(event);
    const seatId = (value as { seatId?: unknown } | null)?.seatId;
    return await adoptCouncil(councilThread(value), typeof seatId === "string" && seatId.length <= 64 ? seatId : "");
  });
  ipcMain.handle("emma:council-close", (event, value: unknown) => {
    mainWindowSender(event);
    closeCouncil(councilThread(value));
    return null;
  });
  ipcMain.handle("emma:council-state", (event, value: unknown) => {
    mainWindowSender(event);
    return councilState(councilThread(value)) ?? null;
  });
  ipcMain.handle("emma:list-agents", (event) => {
    mainWindowSender(event);
    return agents!.list();
  });
  ipcMain.handle("emma:list-background", (event) => {
    mainWindowSender(event);
    return background.list();
  });
  ipcMain.handle("emma:run-command", (event, value: unknown) => {
    mainWindowSender(event);
    const { command, folderId } = runCommandRequest(value);
    return background.start(
      folderId ? folders!.directory(folderId) : homedir(),
      command,
      folderId ? folderNames([folderId])[0] ?? "" : "",
    );
  });
  ipcMain.handle("emma:read-background", (event, value: unknown) => {
    mainWindowSender(event);
    return background.output(boundedCapabilityId(value, "Background task"), MAX_COMMAND_OUTPUT) ?? null;
  });
  ipcMain.handle("emma:stop-background", (event, value: unknown) => {
    mainWindowSender(event);
    return background.stop(boundedCapabilityId(value, "Background task"));
  });
  ipcMain.handle("emma:list-cli-runs", (event) => {
    mainWindowSender(event);
    return clis.list();
  });
  ipcMain.handle("emma:read-cli-run", (event, value: unknown) => {
    mainWindowSender(event);
    return clis.output(boundedCapabilityId(value, "CLI run"), MAX_CLI_VIEW_CHARS) ?? null;
  });
  ipcMain.handle("emma:stop-cli-run", (event, value: unknown) => {
    mainWindowSender(event);
    return clis.stop(boundedCapabilityId(value, "CLI run"));
  });
  ipcMain.handle("emma:cli-models", (event, value: unknown) => {
    mainWindowSender(event);
    const request = (value ?? {}) as { cli?: unknown; refresh?: unknown };
    const cli = boundedCapabilityId(request.cli, "CLI");
    if (!CLI_IDS.includes(cli)) throw new Error("Emma does not know that CLI.");
    return cliModels.read(cli, (id) => clis.where(id), request.refresh === true);
  });
  ipcMain.handle("emma:cli-run-model", (event, value: unknown) => {
    mainWindowSender(event);
    const selected = cliOptions(value);
    const request = value as { id?: unknown };
    return clis.setOptions(boundedCapabilityId(request.id, "CLI run"), selected);
  });
  ipcMain.handle("emma:installed-clis", (event) => {
    mainWindowSender(event);
    return clis.installed();
  });
  ipcMain.handle("emma:cli-sign-in", (event, value: unknown) => {
    mainWindowSender(event);
    const candidate = terminalRequest(value);
    const signIn = boundedCapabilityId(candidate.signIn, "Plan");
    if (!cliPlan(signIn)) throw new Error("Emma does not know that plan.");
    const { columns, rows } = terminalSize(candidate);
    return terminals.open({ threadId: SIGN_IN_THREAD, cwd: homedir(), columns, rows, signIn });
  });
  ipcMain.handle("emma:handoff-cli-run", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid handoff request.");
    const request = value as Record<string, unknown>;
    const { id: sourceId, prompt } = cliSendRequest({ id: request.sourceId, prompt: request.prompt });
    const source = clis.get(sourceId);
    if (!source) throw new Error("The source run is no longer available.");
    if (request.id !== undefined) {
      const id = boundedCapabilityId(request.id, "CLI run");
      if (clis.get(id)?.threadId !== source.threadId) throw new Error("Choose a destination in the same thread.");
      return clis.send(id, prompt, [sourceId], cliOptions(request));
    }
    const cli = boundedCapabilityId(request.cli, "CLI");
    const grant = grantFor(source.threadId, undefined);
    return clis.start({ threadId: source.threadId, cli, prompt, cwd: folders!.directory(grant), folder: folderNames([grant])[0] ?? "", unattended: false, fromRuns: [sourceId], ...cliOptions(request) });
  });
  ipcMain.handle("emma:send-cli-run", async (event, value: unknown) => {
    mainWindowSender(event);
    const { id, prompt } = cliSendRequest(value);
    await clis.send(id, prompt);
    return clis.get(id) ?? null;
  });
  ipcMain.handle("emma:browser-status", (event, value: unknown) => {
    mainWindowSender(event);
    return browsers.status(boundedCapabilityId(value, "Browser thread"));
  });
  ipcMain.handle("emma:browser-open", (event, value: unknown) => {
    mainWindowSender(event);
    const { threadId, url } = browserOpenRequest(value);
    return browsers.open(threadId, url);
  });
  ipcMain.handle("emma:browser-nav", (event, value: unknown) => {
    mainWindowSender(event);
    const { threadId, action } = browserNavRequest(value);
    return browsers.navigate(threadId, action);
  });
  ipcMain.handle("emma:browser-place", (event, value: unknown) => {
    mainWindowSender(event);
    const { threadId, bounds } = browserPlaceRequest(value);
    browsers.hideAllExcept(threadId);
    browsers.place(threadId, bounds);
  });
  ipcMain.handle("emma:browser-clips", (event) => {
    mainWindowSender(event);
    return browsers.clips();
  });
  ipcMain.handle("emma:browser-clip-use", (event, value: unknown) => {
    mainWindowSender(event);
    const { threadId, index } = browserClipRequest(value);
    browsers.reuseClip(threadId, index);
  });
  ipcMain.handle("emma:browser-tab-new", (event, value: unknown) => {
    mainWindowSender(event);
    const { candidate, threadId } = browserRequest(value);
    const url = candidate.url === undefined ? undefined : browserOpenRequest(value).url;
    return browsers.newTab(threadId, url);
  });
  ipcMain.handle("emma:browser-tab-select", (event, value: unknown) => {
    mainWindowSender(event);
    const { threadId, tabId } = browserTabRequest(value);
    return browsers.selectTab(threadId, tabId);
  });
  ipcMain.handle("emma:browser-tab-close", (event, value: unknown) => {
    mainWindowSender(event);
    const { threadId, tabId } = browserTabRequest(value);
    return browsers.closeTab(threadId, tabId);
  });
  ipcMain.handle("emma:terminal-open", (event, value: unknown) => {
    mainWindowSender(event);
    const candidate = terminalRequest(value);
    const threadId = boundedCapabilityId(candidate.threadId, "Terminal thread");
    const { columns, rows } = terminalSize(candidate);
    const cli = typeof candidate.cli === "string" ? candidate.cli : undefined;
    return terminals.open({ threadId, cwd: folders!.directory(grantFor(threadId, undefined)), columns, rows, cli });
  });
  ipcMain.handle("emma:terminal-write", (event, value: unknown) => {
    mainWindowSender(event);
    const candidate = terminalRequest(value);
    if (typeof candidate.data !== "string" || candidate.data.length > MAX_TERMINAL_INPUT) throw new Error("Terminal input is invalid");
    terminals.write(boundedCapabilityId(candidate.id, "Terminal"), candidate.data);
  });
  ipcMain.handle("emma:terminal-resize", (event, value: unknown) => {
    mainWindowSender(event);
    const candidate = terminalRequest(value);
    const { columns, rows } = terminalSize(candidate);
    terminals.resize(boundedCapabilityId(candidate.id, "Terminal"), columns, rows);
  });
  ipcMain.handle("emma:terminal-close", (event, value: unknown) => {
    mainWindowSender(event);
    terminals.close(boundedCapabilityId(value, "Terminal"));
  });
  ipcMain.handle("emma:terminal-list", (event, value: unknown) => {
    mainWindowSender(event);
    return terminals.list(boundedCapabilityId(value, "Terminal thread"));
  });
  ipcMain.handle("emma:terminal-buffer", (event, value: unknown) => {
    mainWindowSender(event);
    return terminals.buffer(boundedCapabilityId(value, "Terminal"));
  });
  ipcMain.handle("emma:open-link", (event, value: unknown) => {
    mainWindowSender(event);
    if (typeof value !== "string" || value.length > 2048) throw new Error("Link is invalid");
    const target = externalUrl(value);
    if (!target) throw new Error("Emma opens http and https addresses only.");
    void shell.openExternal(target.href);
  });
  ipcMain.handle("emma:list-spans", (event) => {
    mainWindowSender(event);
    return agents!.spans();
  });
  ipcMain.handle("emma:list-asks", (event) => {
    mainWindowSender(event);
    return agents!.outstandingAsks();
  });
  ipcMain.handle("emma:live-partial", (event) => {
    mainWindowSender(event);
    return livePartial();
  });
  ipcMain.handle("emma:thread-traces", async (event, value: unknown) => {
    mainWindowSender(event);
    const threadId = boundedCapabilityId(value, "Trace thread");
    return await readThreadTraces(threadId);
  });
  ipcMain.on("emma:answer-permission", (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== mainWindow?.webContents) return;
    if (!value || typeof value !== "object") return;
    const answer = value as Record<string, unknown>;
    if (typeof answer.id !== "string" || typeof answer.allowed !== "boolean") return;
    agents!.answer(answer.id, answer.allowed);
  });
  ipcMain.on("emma:computer-run-ready", (event) => {
    if (event.senderFrame !== event.sender.mainFrame) return;
    if (event.sender === computerCursorWindow?.webContents) {
      computerCursorReady = true;
      showComputerCursor();
    } else if (event.sender === runBanner?.webContents && computerProgress) {
      event.sender.send("emma:computer-run-progress", computerProgress);
    }
  });
  ipcMain.handle("emma:steer-agent", async (event, value: unknown) => {
    mainWindowSender(event);
    const request = agentMessage(value);
    await steerThread(request.threadId, request.text);
  });
  ipcMain.on("emma:stop-agent", (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || ![mainWindow?.webContents, runBanner?.webContents].includes(event.sender)) return;
    if (typeof value === "string") { stopThread(value); return; }
    stopEveryThread();
  });
  ipcMain.handle("emma:thread-changes", (event, value: unknown) => {
    mainWindowSender(event);
    return agents!.changes(boundedCapabilityId(value, "Changes thread"));
  });
  ipcMain.handle("emma:clear-thread-context", (event, value: unknown) => {
    mainWindowSender(event);
    const threadId = boundedCapabilityId(value, "Clear context thread");
    compactNext.delete(threadId);
    for (const client of harnesses.values()) client.forgetSession(threadId);
  });
  ipcMain.handle("emma:revert-change", (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object") throw new Error("Revert request is invalid");
    const request = value as Record<string, unknown>;
    const folderId = boundedCapabilityId(request.folderId, "Revert folder");
    const file = request.path;
    if (typeof file !== "string" || !file || Buffer.byteLength(file, "utf8") > 4096 || file.includes("\0")) throw new Error("Revert path is invalid");
    const before = recordedRevert(folderId, file);
    if (escapesRoot(folders!.directory(folderId), file)) throw new Error("That file is outside the granted folder.");
    folders!.write(folderId, file, before);
    changed();
    return true;
  });
  ipcMain.on("emma:stop-computer-run", (event) => {
    if (event.senderFrame !== event.sender.mainFrame || ![mainWindow?.webContents, runBanner?.webContents].includes(event.sender)) return;
    if (computerRuntime?.threadId) stopThread(computerRuntime.threadId);
  });
  ipcMain.handle("emma:set-providers", (event, value: unknown) => {
    mainWindowSender(event);
    providers = validateProviders(value);
    recycleHarnesses();
    return providers;
  });
  ipcMain.handle("emma:test-provider", async (event, value: unknown) => {
    mainWindowSender(event);
    const draft = (value ?? {}) as Partial<ProviderProfile>;
    const [profile] = validateProviders([{
      id: "test",
      name: "Test",
      contextWindow: 0,
      baseUrl: draft.baseUrl,
      credentialEnv: draft.credentialEnv ?? "",
      modelId: typeof draft.modelId === "string" && draft.modelId.trim() ? draft.modelId : "probe",
      insecure: draft.insecure === true,
    }]);
    const key = profile.credentialEnv ? process.env[profile.credentialEnv] ?? "" : "";
    return await probeProvider(profile.baseUrl, key, typeof draft.modelId === "string" ? draft.modelId.trim() : "");
  });
  ipcMain.handle("emma:set-default-mode", (event, value: unknown) => {
    panelSender(event);
    defaultMode = asPermissionMode(value);
    return defaultMode;
  });
  ipcMain.handle("emma:set-verifier", (event, value: unknown) => {
    panelSender(event);
    verifier = validateVerifier(value);
    return verifier;
  });
  ipcMain.handle("emma:set-tagger", (event, value: unknown) => {
    panelSender(event);
    tagger = validateTagger(value);
    return tagger;
  });
  ipcMain.handle("emma:set-zoom", (event, value: unknown) => {
    mainWindowSender(event);
    const zoom = typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_UI_SCALE / 100, Math.max(MIN_UI_SCALE / 100, value)) : 1;
    event.sender.setZoomFactor(zoom);
    return zoom;
  });
  ipcMain.handle("emma:set-tool-settings", async (event, value: unknown) => {
    panelSender(event);
    toolSettings = validateToolSettings(value);
    await toolsChanged();
    return toolSettings;
  });
  ipcMain.handle("emma:set-harness-experiments", (event, value: unknown) => {
    mainWindowSender(event);
    harnessExperiments = validateHarnessExperiments(value);
    semanticGrep.apply(harnessExperiments);
    return harnessExperiments;
  });
  ipcMain.handle("emma:semantic-grep-status", (event) => {
    mainWindowSender(event);
    return semanticGrep.status();
  });
  ipcMain.handle("emma:set-review", (event, value: unknown) => {
    mainWindowSender(event);
    reviewSettings = validateReview(value);
    return reviewSettings;
  });
  ipcMain.handle("emma:set-improvements", (event, value: unknown) => {
    mainWindowSender(event);
    const store = validateImprovements(value);
    setImprovements(store);
    return store;
  });
  ipcMain.handle("emma:force-arm", (event, value: unknown) => {
    mainWindowSender(event);
    const { threadId, arm } = forceArmRequest(value);
    ownBench(threadId);
    forceArm(threadId, arm);
    return arm;
  });
  ipcMain.handle("emma:reveal-path", (event, value: unknown) => {
    mainWindowSender(event);
    const found = namedPath(value);
    if (!found) return false;
    const { grant, attached } = pathGrant(found);
    if (!grant && !attached) return false;
    shell.showItemInFolder(found);
    return true;
  });
  ipcMain.handle("emma:preview-path", (event, value: unknown) => {
    mainWindowSender(event);
    const found = namedPath(value);
    if (!found) return null;
    const { grant, attached } = pathGrant(found);
    if (!grant && !attached) return { path: found, text: null };
    try {
      if (isImageAttachment(found)) return { path: found, text: null, image: previewImage(found) };
      if (attached && statSync(found).size > MAX_FILE_BYTES) return { path: found, text: null };
      return { path: found, text: attached ? readFileSync(found, "utf8") : folders!.read(grant!.id, path.relative(grant!.path, found)).text };
    } catch {
      return { path: found, text: null };
    }
  });
  ipcMain.handle("emma:set-goal", async (event, value: unknown) => {
    panelSender(event);
    return await setGoal(goalIpc(value));
  });
  ipcMain.handle("emma:update-goal", async (event, value: unknown) => {
    panelSender(event);
    return await updateGoal(goalIpc(value));
  });
  ipcMain.handle("emma:clear-goal", async (event, value: unknown) => {
    panelSender(event);
    return await goalRequest("clearGoal", { threadId: boundedCapabilityId(value, "Goal thread") });
  });
  ipcMain.handle("emma:list-plans", (event) => {
    panelSender(event);
    return listPlans(app.getPath("userData"));
  });
  ipcMain.handle("emma:list-task-lists", (event) => {
    panelSender(event);
    return listTaskLists(app.getPath("userData"));
  });
  ipcMain.handle("emma:list-artifacts", (event) => {
    panelSender(event);
    return listArtifacts(app.getPath("userData"));
  });
  ipcMain.handle("emma:read-artifact", (event, value: unknown) => {
    mainWindowSender(event);
    return readArtifact(app.getPath("userData"), boundedCapabilityId(value, "Artifact"));
  });
  ipcMain.handle("emma:save-artifact", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Artifact request is invalid");
    const request = value as Record<string, unknown>;
    if (typeof request.title !== "string" || typeof request.kind !== "string" || typeof request.content !== "string") throw new Error("Artifact request is invalid");
    if (request.language !== undefined && typeof request.language !== "string") throw new Error("Artifact request is invalid");
    const saved = await writeArtifact(app.getPath("userData"), {
      id: request.id === undefined ? undefined : boundedCapabilityId(request.id, "Artifact"),
      title: request.title,
      kind: request.kind,
      language: request.language,
      content: request.content,
    });
    artifactsChanged();
    return saved;
  });
  ipcMain.handle("emma:delete-artifact", async (event, value: unknown) => {
    mainWindowSender(event);
    await deleteArtifact(app.getPath("userData"), boundedCapabilityId(value, "Artifact"));
    artifactsChanged();
  });
  ipcMain.handle("emma:reveal-artifact", async (event, value: unknown) => {
    mainWindowSender(event);
    const artifact = await readArtifact(app.getPath("userData"), boundedCapabilityId(value, "Artifact"));
    shell.showItemInFolder(artifact.path);
    return true;
  });
  ipcMain.handle("emma:artifact-sql", (event, value: unknown) => {
    panelSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Artifact query is invalid");
    const request = value as Record<string, unknown>;
    return queryArtifact(app.getPath("userData"), boundedCapabilityId(request.id, "Artifact"), request.sql, request.params);
  });
  ipcMain.handle("emma:list-components", (event) => {
    panelSender(event);
    return listComponents(app.getPath("userData"));
  });
  ipcMain.handle("emma:delete-component", async (event, value: unknown) => {
    mainWindowSender(event);
    const gone = await deleteComponent(app.getPath("userData"), boundedCapabilityId(value, "Component"));
    componentsChanged();
    return gone;
  });
  ipcMain.handle("emma:enable-component", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Component request is invalid");
    const request = value as Record<string, unknown>;
    const meta = await setComponentEnabled(app.getPath("userData"), boundedCapabilityId(request.id, "Component"), request.enabled === true);
    componentsChanged();
    return meta;
  });
  ipcMain.handle("emma:expand-component", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Component request is invalid");
    const request = value as Record<string, unknown>;
    const meta = await setComponentExpands(app.getPath("userData"), boundedCapabilityId(request.id, "Component"), request.expands === true);
    componentsChanged();
    return meta;
  });
  ipcMain.handle("emma:component-fetch", async (event, value: unknown) => {
    panelSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Component request is invalid");
    const request = value as Record<string, unknown>;
    if (Object.keys(request).length !== 2 || !("request" in request)) throw new Error("Component request is invalid");
    return componentRequests.fetch(app.getPath("userData"), boundedCapabilityId(request.id, "Component"), request.request, process.env, async (meta, template) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      const choice = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Component API access",
        message: `Allow “${meta.title.replace(/\s+/g, " ")}” to use ${template.variables.join(", ")}?`,
        detail: `This approves only the exact request below until Emma quits. A changed request or component needs new approval. Components share Emma's interface and can repeat approved requests; this is not a separate account for each widget. Only approve an endpoint you trust with these credentials.\n\n${JSON.stringify(template, null, 2)}`,
        buttons: ["Cancel", "Allow this request"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return choice.response === 1;
    });
  });
  ipcMain.handle("emma:read-component", (event, value: unknown) => {
    mainWindowSender(event);
    return readComponent(app.getPath("userData"), boundedCapabilityId(value, "Component"));
  });
  ipcMain.handle("emma:shoot-component", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Component request is invalid");
    const request = value as Record<string, unknown>;
    const id = boundedCapabilityId(request.id, "Component");
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return false;
    const zoom = event.sender.getZoomFactor() || 1;
    const whole = window.getContentBounds();
    const round = (candidate: unknown, high: number) => Math.max(0, Math.min(high, Math.round(typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0)));
    const scaled = (candidate: unknown) => typeof candidate === "number" && Number.isFinite(candidate) ? candidate * zoom : 0;
    const rect = {
      x: round(scaled(request.x), whole.width),
      y: round(scaled(request.y), whole.height),
      width: round(scaled(request.width), whole.width),
      height: round(scaled(request.height), whole.height),
    };
    if (rect.width < 8 || rect.height < 8) return false;
    await writeComponentShot(app.getPath("userData"), id, (await window.webContents.capturePage(rect)).toPNG());
    componentsChanged();
    return true;
  });
  ipcMain.handle("emma:read-visual", (event, value: unknown) => {
    mainWindowSender(event);
    const visual = readVisual(boundedCapabilityId(value, "Visual"));
    if (!visual) throw new Error("That visual is no longer in this conversation.");
    return visual;
  });
  ipcMain.handle("emma:export-visual", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Visual request is invalid");
    const request = value as Record<string, unknown>;
    const id = boundedCapabilityId(request.id, "Visual");
    const visual = readVisual(id);
    if (!visual) throw new Error("That visual is no longer in this conversation.");
    const png = await captureVisual(id, request.width);
    const choice = await dialog.showSaveDialog(mainWindow!, {
      title: "Export this visual",
      defaultPath: path.join(app.getPath("pictures"), `${artifactSlug(visual.title)}.png`),
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (choice.canceled || !choice.filePath) return "";
    await writeFile(choice.filePath, png);
    return choice.filePath;
  });
  ipcMain.handle("emma:export-thread-stats", async (event, value: unknown) => {
    mainWindowSender(event);
    const request = statsExportRequest(value);
    const choice = await dialog.showSaveDialog(mainWindow!, {
      title: "Export thread stats",
      buttonLabel: "Export",
      defaultPath: path.join(app.getPath("documents"), request.folder),
    });
    if (choice.canceled || !choice.filePath) return "";
    await mkdir(choice.filePath, { recursive: true });
    for (const file of request.files) await writeFile(path.join(choice.filePath, file.name), file.text, "utf8");
    return choice.filePath;
  });
  ipcMain.handle("emma:bench-judge", async (event, value: unknown) => {
    mainWindowSender(event);
    const request = benchJudgeRequest(value);
    return await judgeCase(request, request.judge ?? tagger);
  });
  ipcMain.handle("emma:export-bench", async (event, value: unknown) => {
    mainWindowSender(event);
    const request = benchExportRequest(value);
    const choice = await dialog.showSaveDialog(mainWindow!, {
      title: "Export the bench",
      buttonLabel: "Export",
      defaultPath: path.join(app.getPath("documents"), `${request.name}.xlsx`),
      filters: [{ name: "Excel workbook", extensions: ["xlsx"] }],
    });
    if (choice.canceled || !choice.filePath) return "";
    await writeFile(choice.filePath, workbook(request.sheets));
    return choice.filePath;
  });
  ipcMain.handle("emma:list-folders", (event) => {
    mainWindowSender(event);
    return visibleFolders();
  });
  ipcMain.handle("emma:plugin-catalog", (event) => {
    mainWindowSender(event);
    return ensureDefaultMarketplace(app.getPath("userData"));
  });
  ipcMain.handle("emma:add-marketplace", async (event, value: unknown) => {
    mainWindowSender(event);
    const request = (value ?? {}) as Record<string, unknown>;
    return await addMarketplace(app.getPath("userData"), { source: request.source, ref: request.ref, sparse: request.sparse });
  });
  ipcMain.handle("emma:remove-marketplace", async (event, value: unknown) => {
    mainWindowSender(event);
    const catalog = await removeMarketplace(app.getPath("userData"), value);
    await toolsChanged();
    return catalog;
  });
  ipcMain.handle("emma:refresh-marketplace", async (event, value: unknown) => {
    mainWindowSender(event);
    return await refreshMarketplace(app.getPath("userData"), value);
  });
  ipcMain.handle("emma:install-plugin", async (event, value: unknown) => {
    mainWindowSender(event);
    const request = (value ?? {}) as Record<string, unknown>;
    const catalog = await installPlugin(app.getPath("userData"), request.marketplace, request.plugin);
    await toolsChanged();
    return catalog;
  });
  ipcMain.handle("emma:uninstall-plugin", async (event, value: unknown) => {
    mainWindowSender(event);
    const catalog = await uninstallPlugin(app.getPath("userData"), value);
    await toolsChanged();
    return catalog;
  });
  ipcMain.handle("emma:trust-plugin-hooks", async (event, value: unknown) => {
    mainWindowSender(event);
    const request = (value ?? {}) as Record<string, unknown>;
    return await trustPluginHooks(app.getPath("userData"), request.id, request.trusted);
  });
  ipcMain.handle("emma:plugin-detail", async (event, value: unknown) => {
    mainWindowSender(event);
    const request = (value ?? {}) as Record<string, unknown>;
    return await pluginDetail(app.getPath("userData"), request.marketplace, request.plugin);
  });
  ipcMain.handle("emma:setup-status", (event) => {
    mainWindowSender(event);
    return setupStatus();
  });
  ipcMain.handle("emma:reset-data", (event) => {
    mainWindowSender(event);
    const candidates = resetDataRoots(app.getPath("userData"), process.env.EMMA_DATA_DIR, process.platform, homedir(), process.env);
    const roots = candidates.map((root) => {
      const resolved = canonicalResetPath(root);
      if (!samePath(root, resolved)) throw new Error(`Reset blocked: refusing to delete unsafe Emma data path "${root}".`);
      try {
        if (!statSync(resolved).isDirectory()) throw new Error(`Reset blocked: refusing to delete unsafe Emma data path "${root}".`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return resolved;
    });
    host?.close();
    host = undefined;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle("emma:open-privacy-settings", async (event, value: unknown) => {
    mainWindowSender(event);
    const url = privacySettingsUrl(value, process.platform);
    const mac = isMac;
    if (value === "microphone" && mac && await systemPreferences.askForMediaAccess("microphone")) return;
    if (value === "accessibility" && mac) systemPreferences.isTrustedAccessibilityClient(true);
    void shell.openExternal(url);
  });
  ipcMain.handle("emma:pick-vault-folder", async (event): Promise<VaultChoice | null> => {
    mainWindowSender(event);
    const choice = await dialog.showOpenDialog(mainWindow!, { title: "Where should Emma keep your notes?", defaultPath: readVault(app.getPath("userData"))?.root ?? defaultVaultRoot(), buttonLabel: "Keep notes here", properties: ["openDirectory", "createDirectory"] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    pickedVaultRoot = choice.filePaths[0];
    return obsidianVaults().find((found) => found.root === pickedVaultRoot)
      ?? { root: pickedVaultRoot, folder: DEFAULT_VAULT_FOLDER, kind: "folder", name: path.basename(pickedVaultRoot) || pickedVaultRoot };
  });
  ipcMain.handle("emma:detect-vaults", (event) => {
    mainWindowSender(event);
    return obsidianVaults();
  });
  ipcMain.handle("emma:set-vault", (event, value: unknown) => {
    mainWindowSender(event);
    const chosen = vaultRequest(value);
    const root = chosen.kind === "obsidian"
      ? obsidianVaults().find((found) => found.name === chosen.name)?.root
      : pickedVaultRoot ?? readVault(app.getPath("userData"))?.root;
    if (!root) throw new Error("Choose the folder Emma should keep your notes in.");
    connectVault(saveVault(app.getPath("userData"), {
      root,
      folder: chosen.folder ?? DEFAULT_VAULT_FOLDER,
      kind: chosen.kind,
      name: chosen.kind === "obsidian" ? chosen.name : path.basename(root) || root,
    }));
    return setupStatus();
  });
  ipcMain.handle("emma:vault-status", (event) => {
    panelSender(event);
    return readVault(app.getPath("userData"));
  });
  ipcMain.handle("emma:keep", async (event, value: unknown) => {
    panelSender(event);
    return await keep(keepRequest(value), event.sender === overlay?.webContents);
  });
  ipcMain.handle("emma:list-notes", (event) => {
    panelSender(event);
    const vault = readVault(app.getPath("userData"));
    return vault ? listNotes(vault) : [];
  });
  ipcMain.handle("emma:list-note-folders", (event) => {
    panelSender(event);
    const vault = readVault(app.getPath("userData"));
    return vault ? listNoteFolders(vault) : [];
  });
  ipcMain.handle("emma:create-note-folder", (event, value: unknown) => {
    mainWindowSender(event);
    const vault = readVault(app.getPath("userData"));
    if (!vault) throw new Error("No vault is connected.");
    const folder = createNoteFolder(vault, value);
    notesChanged();
    return folder;
  });
  ipcMain.handle("emma:rename-note-folder", (event, value: unknown) => {
    mainWindowSender(event);
    const vault = readVault(app.getPath("userData"));
    if (!vault) throw new Error("No vault is connected.");
    const request = (value ?? {}) as Record<string, unknown>;
    const renamed = renameNoteFolder(vault, request.folder, request.name);
    notesChanged();
    return renamed;
  });
  ipcMain.handle("emma:move-note", (event, value: unknown) => {
    mainWindowSender(event);
    const vault = readVault(app.getPath("userData"));
    if (!vault) throw new Error("No vault is connected.");
    const request = (value ?? {}) as Record<string, unknown>;
    const moved = moveNote(vault, noteInVault(vault, request.path), request.folder);
    notesChanged();
    return moved;
  });
  ipcMain.handle("emma:read-note", (event, value: unknown) => {
    panelSender(event);
    const vault = readVault(app.getPath("userData"));
    if (!vault) throw new Error("No vault is connected.");
    const file = path.join(notesRoot(vault), noteInVault(vault, value));
    if (!statSync(file).isFile() || statSync(file).size > MAX_NOTE_BYTES) throw new Error("That note cannot be read.");
    return readFileSync(file, "utf8");
  });
  ipcMain.handle("emma:open-in-obsidian", (event, value: unknown) => {
    panelSender(event);
    const vault = readVault(app.getPath("userData"));
    if (!vault) throw new Error("No vault is connected.");
    const relative = noteInVault(vault, value);
    if (vault.kind === "obsidian") void shell.openExternal(obsidianOpenUrl(vault, relative));
    else shell.showItemInFolder(path.join(notesRoot(vault), relative));
  });
  ipcMain.handle("emma:install-obsidian", (event) => {
    mainWindowSender(event);
    return { installed: obsidianInstalled(), command: obsidianInstallCommand() };
  });
  ipcMain.handle("emma:pick-folder", async (event) => {
    mainWindowSender(event);
    const choice = await dialog.showOpenDialog(mainWindow!, { title: "Connect a folder", properties: ["openDirectory", "createDirectory"] });
    if (choice.canceled || !choice.filePaths[0]) return visibleFolders();
    folders!.add(choice.filePaths[0]);
    return visibleFolders();
  });
  ipcMain.handle("emma:forget-folder", (event, value: unknown) => {
    mainWindowSender(event);
    const id = boundedCapabilityId(value, "Folder");
    if (id === vaultFolderId) throw new Error("Your vault stays connected; change it from Settings.");
    folders!.remove(id);
    return visibleFolders();
  });
  ipcMain.handle("emma:git-status", async (event, value: unknown) => {
    mainWindowSender(event);
    return await gitSnapshot(folders!.directory(boundedCapabilityId(value, "Folder")), true);
  });
  ipcMain.handle("emma:git-ready", async (event, value: unknown) => {
    mainWindowSender(event);
    return await gitReady(folders!.directory(boundedCapabilityId(value, "Folder")));
  });
  ipcMain.handle("emma:git-init", async (event, value: unknown) => {
    mainWindowSender(event);
    await initRepo(folders!.directory(boundedCapabilityId(value, "Folder")));
    changed();
  });
  ipcMain.handle("emma:git-history", async (event, value: unknown) => {
    mainWindowSender(event);
    const request = gitRequest(value, "History");
    const cwd = folders!.directory(boundedCapabilityId(request.folderId, "Folder"));
    return await gitHistory(cwd, { skip: gitCount(request.skip, "Skip"), limit: gitCount(request.limit, "Limit") });
  });
  ipcMain.handle("emma:git-commit", async (event, value: unknown) => {
    mainWindowSender(event);
    const request = gitRequest(value, "Commit");
    const cwd = folders!.directory(boundedCapabilityId(request.folderId, "Folder"));
    const message = request.message === undefined ? "" : request.message;
    if (typeof message !== "string" || Buffer.byteLength(message) > MAX_COMMIT_MESSAGE_BYTES) throw new Error("That commit message is invalid");
    return await commit(cwd, { message, paths: request.paths, amend: request.amend === true });
  });
  ipcMain.handle("emma:git-discard", async (event, value: unknown) => {
    mainWindowSender(event);
    const request = gitRequest(value, "Discard");
    await discard(folders!.directory(boundedCapabilityId(request.folderId, "Folder")), request.paths);
  });
  ipcMain.handle("emma:git-run", async (event, value: unknown) => {
    mainWindowSender(event);
    const request = gitRequest(value, "Git command");
    const cwd = folders!.directory(boundedCapabilityId(request.folderId, "Folder"));
    return await runGit(cwd, validateGitArgs(request.args));
  });
  ipcMain.handle("emma:git-message", async (event, value: unknown) => {
    mainWindowSender(event);
    const request = gitRequest(value, "Commit message");
    const snapshot = await gitSnapshot(folders!.directory(boundedCapabilityId(request.folderId, "Folder")));
    if (!snapshot) throw new Error("That folder is not a git repository.");
    return await writeCommitMessage(tagger, { diff: snapshot.diff, files: snapshot.files });
  });
  ipcMain.handle("emma:mobile-status", (event) => {
    mainWindowSender(event);
    return mobileStatus();
  });
  ipcMain.handle("emma:mobile-pair", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!isPin(value)) throw new Error("Choose a PIN of 4 to 12 digits before pairing a phone.");
    return await bridge!.pair(value);
  });
  ipcMain.handle("emma:mobile-cancel-pair", (event) => {
    mainWindowSender(event);
    bridge!.cancelPair();
    return bridge!.status();
  });
  ipcMain.handle("emma:mobile-unpair", (event, value: unknown) => {
    mainWindowSender(event);
    bridge!.unpair(typeof value === "number" && Number.isFinite(value) ? value : undefined);
    return bridge!.status();
  });
  ipcMain.handle("emma:machine-sample", (event) => {
    mainWindowSender(event);
    return machineSample();
  });
  ipcMain.handle("emma:list-editors", (event) => {
    mainWindowSender(event);
    return installedEditors();
  });
  ipcMain.handle("emma:open-in-editor", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Editor request is invalid");
    const request = value as Record<string, unknown>;
    const editorId = boundedCapabilityId(request.editorId, "Editor");
    if (request.folderId === undefined) {
      const file = namedPath(request.path);
      const held = file ? pathGrant(file) : { grant: undefined, attached: false };
      if (!file || (!held.grant && !held.attached)) throw new Error("That file is not open to Emma.");
      await openInEditor(editorId, file);
      return;
    }
    const folderId = boundedCapabilityId(request.folderId, "Folder");
    await openInEditor(editorId, folders!.fileWithin(folderId, boundedCapabilityId(request.path, "File path")));
  });
  ipcMain.handle("emma:set-branch", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Branch request is invalid");
    const request = value as Record<string, unknown>;
    const cwd = folders!.directory(boundedCapabilityId(request.folderId, "Folder"));
    await switchBranch(cwd, boundedCapabilityId(request.branch, "Branch"), request.create === true, request.from === undefined ? undefined : boundedCapabilityId(request.from, "Branch"));
    changed();
  });
  ipcMain.handle("emma:set-worktree", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Worktree request is invalid");
    const request = value as Record<string, unknown>;
    const cwd = folders!.directory(boundedCapabilityId(request.folderId, "Folder"));
    const name = boundedCapabilityId(request.name, "Worktree name");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error("Worktree name is invalid");
    const target = realpathSync(request.on === true ? await addWorktree(cwd, name) : await mainCheckout(cwd));
    const list = folders!.add(target);
    const grant = list.find((folder) => samePath(folder.path, target));
    if (!grant) throw new Error("That folder could not be connected.");
    return { folders: list, folderId: grant.id };
  });
  ipcMain.handle("emma:worktree-list", async (event, value: unknown) => {
    mainWindowSender(event);
    return await listWorktrees(folders!.directory(boundedCapabilityId(value, "Folder")));
  });
  ipcMain.handle("emma:worktree-remove", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Worktree request is invalid");
    const request = value as Record<string, unknown>;
    const cwd = folders!.directory(boundedCapabilityId(request.folderId, "Folder"));
    if (!Array.isArray(request.paths) || request.paths.some((item) => typeof item !== "string" || !item || item.length > 1024 || item.includes("\0"))) {
      throw new Error("Worktree list is invalid");
    }
    await removeWorktrees(cwd, request.paths as string[]);
    changed();
  });
  ipcMain.handle("emma:worktree-add", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Worktree request is invalid");
    const request = value as Record<string, unknown>;
    const cwd = folders!.directory(boundedCapabilityId(request.folderId, "Folder"));
    const prefix = typeof request.prefix === "string" ? request.prefix.slice(0, 64) : "";
    const branch = branchPrefixName(prefix, boundedCapabilityId(request.name, "Branch name"));
    const target = realpathSync(await addWorktree(cwd, branch));
    const list = folders!.add(target);
    const grant = list.find((folder) => folder.path === target);
    if (!grant) throw new Error("That folder could not be connected.");
    return { folders: list, folderId: grant.id };
  });
  ipcMain.handle("emma:list-folder-files", (event, value: unknown) => {
    mainWindowSender(event);
    return folders!.files(boundedCapabilityId(value, "Folder"));
  });
  ipcMain.handle("emma:read-folder-file", (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("File request is invalid");
    const request = value as Record<string, unknown>;
    return folders!.read(boundedCapabilityId(request.folderId, "Folder"), boundedCapabilityId(request.path, "File path"));
  });
  ipcMain.handle("emma:attach-files", async (event) => {
    mainWindowSender(event);
    const choice = await dialog.showOpenDialog(mainWindow!, { title: "Attach files", properties: ["openFile", "multiSelections"] });
    if (choice.canceled) return [];
    return choice.filePaths.map((file) => held(attachments!.hold(file)));
  });
  ipcMain.handle("emma:attach-data", (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Attachment is invalid");
    const request = value as { name?: unknown; data?: unknown };
    if (!(request.data instanceof ArrayBuffer) && !ArrayBuffer.isView(request.data)) throw new Error("Attachment is invalid");
    return held(attachments!.save(request.name, new Uint8Array(request.data instanceof ArrayBuffer ? request.data : request.data.buffer)));
  });
  ipcMain.handle("emma:read-attachment", (event, value: unknown) => {
    mainWindowSender(event);
    return attachments!.read(value);
  });
  ipcMain.handle("emma:discover-agent-imports", (event) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== mainWindow?.webContents) throw new Error("Import discovery sender is not allowed");
    return discoverImports(homedir());
  });
  ipcMain.handle("emma:import-agent-sources", async (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== mainWindow?.webContents || !Array.isArray(value) || value.length > MAX_IMPORT_SOURCES || value.some((id) => typeof id !== "string")) throw new Error("Import selection is invalid");
    const saved = await saveImportManifest(app.getPath("userData"), homedir(), value);
    await toolsChanged();
    return saved;
  });
  ipcMain.handle("emma:search-imported-skills", async (event, value: unknown) => {
    mainWindowSender(event);
    const query = boundedCapabilityQuery(value, "Skill search");
    const found = await capabilities!.searchSkills(query.query, query.limit);
    return found.filter((skill) => !toolSettings.disabledSkills.includes(skill.id));
  });
  ipcMain.handle("emma:list-tool-targets", async (event) => {
    mainWindowSender(event);
    return {
      written: (await listEmmaTools(app.getPath("userData"))).map((tool) => ({ id: `run_tool:${tool.name}`, name: tool.name, source: tool.description })),
      skills: (await capabilities!.searchSkills("", 64)).filter((skill) => skill.source !== "installed"),
      servers: await capabilities!.listMcpServers(),
    };
  });
  ipcMain.handle("emma:next-steps", async (event, value: unknown) => {
    mainWindowSender(event);
    return await suggestNextSteps(validateWorkState(value), freeRouter);
  });
  ipcMain.handle("emma:capability-usage", async (event) => {
    mainWindowSender(event);
    const usage = await readUsage(app.getPath("userData"));
    const [skills, servers] = await Promise.all([capabilities!.searchSkills("", MAX_SKILL_RESULTS), capabilities!.listMcpServers()]);
    return {
      skills: skills.filter((skill) => skill.source !== "installed").map((skill) => ({ id: skill.id, name: skill.name, source: skill.source, days: usage[skillKey(skill.id)] ?? {} })),
      models: Object.entries(usage).filter(([key]) => key.startsWith("model/")).map(([key, days]) => {
        const name = key.slice("model/".length);
        return { id: key, name, source: name.includes("/") ? name.slice(0, name.indexOf("/")) : "", days };
      }),
      servers: servers.map((server) => ({ id: server.id, name: server.name, source: `${server.source} · ${server.command}`, days: daysUnder(usage, mcpServerPrefix(server.name)) })),
    };
  });
  ipcMain.handle("emma:select-imported-skill", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Skill selection is invalid");
    const candidate = value as Record<string, unknown>;
    const id = boundedCapabilityId(candidate.id, "Skill selection");
    const threadId = boundedCapabilityId(candidate.threadId, "Skill attachment thread");
    if (toolSettings.disabledSkills.includes(id)) throw new Error("That skill is switched off in Settings → Tools.");
    const skill = await capabilities!.selectSkill(id);
    skillAttachment.put(skill, threadId);
    return { id: skill.id, source: skill.source, name: skill.name, threadId, chars: skill.instructions.length };
  });
  ipcMain.handle("emma:imported-skill-status", (event) => {
    mainWindowSender(event);
    return skillAttachment.status();
  });
  ipcMain.handle("emma:clear-imported-skill", (event, value: unknown) => {
    mainWindowSender(event);
    skillAttachment.clear(boundedCapabilityId(value, "Skill attachment"));
  });
  ipcMain.handle("emma:list-imported-mcp-servers", async (event) => {
    mainWindowSender(event);
    const servers = await capabilities!.listMcpServers();
    return servers.filter((server) => !toolSettings.disabledServers.includes(server.id));
  });
  ipcMain.handle("emma:set-zero-retention", (event, value: unknown) => {
    mainWindowSender(event);
    if (typeof value !== "boolean") throw new Error("The zero-retention preference must be a boolean");
    if ((process.env.EMMA_OPENROUTER_ZDR !== undefined) === value) return;
    if (value) process.env.EMMA_OPENROUTER_ZDR = "1";
    else delete process.env.EMMA_OPENROUTER_ZDR;
    recycleHarnesses();
  });
  ipcMain.handle("emma:list-credentials", (event) => {
    mainWindowSender(event);
    return credentials!.list();
  });
  ipcMain.handle("emma:openrouter-balance", (event) => {
    mainWindowSender(event);
    return fetchOpenRouterBalance(process.env.OPENROUTER_API_KEY ?? "");
  });
  ipcMain.handle("emma:deepseek-balance", (event) => {
    mainWindowSender(event);
    return fetchDeepSeekBalance(process.env.DEEPSEEK_API_KEY ?? "");
  });
  ipcMain.handle("emma:save-credential", (event, value: unknown) => {
    mainWindowSender(event);
    const slot = credentialSlot(value);
    if (slot.secret === undefined) credentials!.remove(slot.env);
    else credentials!.set(slot.env, slot.secret);
    startHost();
    recycleHarnesses();
    return credentials!.list();
  });
  ipcMain.handle("emma:fetch-url", async (event, value: unknown) => {
    mainWindowSender(event);
    if (typeof value !== "string") throw new Error("Only http and https links can be read");
    const { title, text } = await fetchReadablePage(value);
    return { title, text };
  });
  ipcMain.handle("emma:clip-page", async (event) => {
    const window = overlay;
    if (!window || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents) throw new Error("Clipping the front page is available only from the quick overlay");
    closeRadial();
    capturing = true;
    window.hide();
    let front;
    try {
      await pause(150);
      front = await frontmostPage();
    } finally {
      if (!window.isDestroyed()) window.show();
      capturing = false;
    }
    return clipPage(front);
  });
  ipcMain.handle("emma:load-ui-plugins", (event) => {
    if (event.senderFrame !== event.sender.mainFrame || !trustedSender(event.senderFrame.url, app.getAppPath(), process.env.EMMA_DEV_SERVER_URL)) throw new Error("UI plugin sender is not allowed");
    return loadUiPlugins(app.getPath("userData"));
  });
  ipcMain.handle("emma:start-screen-annotation", (event) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== overlay?.webContents) throw new Error("Screen annotation is available only from the quick overlay");
    startAnnotation();
  });
  ipcMain.handle("emma:capture-screen-context", async (event) => {
    const window = overlay;
    if (!window || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents) throw new Error("Screen capture is available only from the quick overlay");
    closeRadial();
    capturing = true;
    window.hide();
    try {
      await pause(120);
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const [frame, source] = await Promise.all([captureDisplay(display), frontApplication()]);
      const compressed = compressScreenFrame(nativeImage.createFromDataURL(frame.image));
      const id = randomUUID();
      annotationAttachment.put({ id, image: compressed.image, source });
      return { id, image: compressed.image, source };
    } finally {
      if (!window.isDestroyed()) window.show();
      capturing = false;
    }
  });
  ipcMain.handle("emma:keep-screen", async (event, value: unknown) => {
    const window = overlay;
    if (!window || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents) throw new Error("Keeping the screen is available only from the quick overlay");
    if (!validScreenContextId(value)) throw new Error("Screen context is unavailable");
    return await keepScreen(value);
  });
  ipcMain.handle("emma:get-screen-annotation-frame", async (event) => {
    const window = annotation;
    if (!window || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents || !annotationDisplay) throw new Error("Screen annotation frame is unavailable");
    window.hide();
    try {
      await pause(120);
      const [frame, source] = await Promise.all([captureDisplay(annotationDisplay), frontApplication()]);
      annotationFrame = frame;
      annotationSource = source;
      return annotationFrame;
    } finally {
      if (!window.isDestroyed()) window.show();
    }
  });
  ipcMain.handle("emma:finish-screen-annotation", (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== annotation?.webContents) throw new Error("Screen annotation sender is not allowed");
    annotationAttachment.put({ id: randomUUID(), image: composeScreenContext(value), source: annotationSource });
    closeAnnotation();
  });
  ipcMain.handle("emma:cancel-screen-annotation", (event) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== annotation?.webContents) throw new Error("Screen annotation sender is not allowed");
    closeAnnotation();
  });
  ipcMain.handle("emma:screen-annotation-status", (event) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== overlay?.webContents) throw new Error("Screen annotation sender is not allowed");
    return annotationAttachment.status();
  });
  ipcMain.handle("emma:clear-screen-annotation", (event, id: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== overlay?.webContents || typeof id !== "string") throw new Error("Screen annotation sender is not allowed");
    annotationAttachment.clear(id);
  });
  ipcMain.on("emma:set-overlay-preferences", (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !trustedSender(event.senderFrame.url, app.getAppPath(), process.env.EMMA_DEV_SERVER_URL)) {
      return;
    }
    try {
      overlayPreferences = validateOverlayPreferences(value);
      overlayPreferencesReady = true;
      setSystemPrompt(overlayPreferences.systemPrompt ?? "");
      setPrompts(overlayPreferences.prompts ?? []);
      if (queuedOverlayToggle) {
        const queued = queuedOverlayToggle;
        queuedOverlayToggle = null;
        toggleOverlay(queued.command);
      }
    }
    catch { console.error("Emma: invalid overlay settings"); }
  });
  ipcMain.handle("emma:set-keybinds", (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !trustedSender(event.senderFrame.url, app.getAppPath(), process.env.EMMA_DEV_SERVER_URL)) throw new Error("Keybind sender is not allowed");
    return applyKeybinds(validateKeybinds(value, process.platform));
  });
  ipcMain.handle("emma:complete-shortcut-request", (event, value: unknown) => {
    trustedFrame(event);
    if (!value || typeof value !== "object") throw new Error("Shortcut result is invalid");
    const result = value as { id?: unknown; keybinds?: unknown; message?: unknown; error?: unknown };
    if (typeof result.id !== "string") throw new Error("Shortcut result is invalid");
    const pending = pendingShortcuts.get(result.id);
    if (!pending || pending.senderId !== event.sender.id) throw new Error("Shortcut request is no longer active");
    pendingShortcuts.delete(result.id);
    clearTimeout(pending.timeout);
    try {
      if (typeof result.error === "string" && result.error.trim()) throw new Error(result.error.slice(0, 512));
      if (typeof result.message !== "string" || !result.message.trim() || result.message.length > 512) throw new Error("Shortcut result is invalid");
      const next = validateKeybinds(result.keybinds);
      const refused = applyKeybinds(next);
      const accelerator = normalizeAccelerator(pending.accelerator);
      const action = (Object.entries(next) as [KeybindAction, Keybind][]).find(([, keybind]) => normalizeAccelerator(keybind.accelerator) === accelerator)?.[0];
      const message = action && refused.includes(action) ? `${result.message} Another app currently holds ${accelerator}, so it cannot fire until that combination is free.` : result.message;
      pending.resolve(message);
      return refused;
    } catch (error) {
      const reason = error instanceof Error ? error : new Error("Shortcut result is invalid");
      pending.reject(reason);
      throw reason;
    }
  });
  ipcMain.on("emma:quick-command", (event, value: unknown) => {
    const window = radial;
    if (!window || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents) return;
    if (!isCursorCommand(value)) return;
    overlay?.webContents.send("emma:quick-command", value);
    closeRadial();
  });
  ipcMain.on("emma:set-overlay-height", (event, value: unknown) => {
    const window = overlay;
    if (!window || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents) return;
    overlayGrow = overlayGrowth(value);
    if (overlaySurface === "pill") return;
    const bounds = window.getBounds();
    const height = overlayBaseHeight + overlayGrow;
    if (bounds.height !== height) window.setBounds({ ...bounds, height });
  });
  ipcMain.on("emma:move-pill", (event, value: unknown) => {
    const window = overlay;
    if (!window || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents || overlaySurface !== "pill") return;
    const spot = value as { x?: unknown; y?: unknown };
    if (typeof spot?.x !== "number" || typeof spot.y !== "number" || !Number.isFinite(spot.x) || !Number.isFinite(spot.y)) return;
    const point = { x: Math.round(spot.x), y: Math.round(spot.y) };
    const bounds = pillLayout(screen.getDisplayNearestPoint(point), point);
    pillSpot = { x: bounds.x, y: bounds.y };
    window.setBounds(bounds);
  });
  ipcMain.on("emma:expand-pill", (event) => {
    const window = overlay;
    if (!window || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents || overlaySurface !== "pill") return;
    expandPill(window);
  });
  ipcMain.on("emma:dismiss-overlay", (event) => {
    const window = overlay;
    if (!window || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents || overlaySurface !== "pill" || overlayBusy) return;
    window.destroy();
  });
  ipcMain.on("emma:open-workspace", (event, value: unknown) => {
    const window = overlay;
    if (!window || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents) return;
    if (typeof value === "string" && /^[a-z]{1,16}$/.test(value)) openSettingsPage(value);
    else openMain();
    closeOverlay(window);
  });
  let resyncing = false;
  ipcMain.on("emma:resync-window", (event) => {
    const window = mainWindow;
    if (!window || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents) return;
    if (resyncing) return;
    resyncing = true;
    const [width, height] = window.getContentSize();
    window.setContentSize(width + 1, height);
    setTimeout(() => {
      resyncing = false;
      if (window.isDestroyed()) return;
      const [now, tall] = window.getContentSize();
      if (now === width + 1) window.setContentSize(width, tall);
    }, 50).unref();
  });
  ipcMain.handle("emma:voice-status", async (event, value: unknown) => {
    trustedFrame(event);
    return voiceStatus(validateVoiceSettings(value));
  });
  ipcMain.handle("emma:transcribe", async (event, value: unknown) => {
    trustedFrame(event);
    if (!value || typeof value !== "object") throw new Error("The recording is invalid");
    const { audio, mimeType, settings } = value as Record<string, unknown>;
    return transcribe(validateUtterance({ audio, mimeType }), validateVoiceSettings(settings));
  });
  ipcMain.on("emma:open-overlay", (event) => {
    const window = hotspot;
    if (!window || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents || overlay) return;
    toggleOverlay();
  });
  ipcMain.handle("emma:demo-quick-ask", (event) => {
    mainWindowSender(event);
    if (!overlay) toggleOverlay();
  });
  ipcMain.on("emma:set-overlay-busy", (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== overlay?.webContents || typeof value !== "boolean") return;
    overlayBusy = value;
    if (!overlayBusy && closeOverlayWhenIdle && overlay) {
      closeOverlayWhenIdle = false;
      overlay.destroy();
    }
  });
  openMain();
  startUpdates((version) => broadcast("emma:update-ready", version));
  addUpdateMenuItem();
  readNotchGeometry();
  screen.on("display-added", readNotchGeometry);
  screen.on("display-removed", readNotchGeometry);
  screen.on("display-metrics-changed", readNotchGeometry);
  startQuickAskHotkey();
  app.on("activate", openMain);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
let quitFlushing = false;
let quitReady = false;
app.on("before-quit", (event) => {
  if (quitReady || harnessRuns.size === 0) return;
  event.preventDefault();
  if (quitFlushing) return;
  quitFlushing = true;
  stopEveryThread();
  for (const client of harnesses.values()) client.close();
  const finished = new Promise<void>((resolve) => {
    const check = () => harnessRuns.size === 0 ? resolve() : setTimeout(check, 25);
    check();
  });
  void Promise.race([finished, pause(10_000)]).finally(() => {
    quitReady = true;
    app.quit();
  });
});
app.on("will-quit", (event) => {
  bridge?.stop();
  semanticGrep.stop();
  globalShortcut.unregisterAll();
  clearTimeout(hotspotTimer);
  hotkeyHelper?.kill();
  computerRuntime?.abort("app quit");
  const processShutdown = [background.stopAll(), clis.stopAll(), terminals.stopAll()];
  browsers.stopAll();
  skillAttachment.clearAll();
  const harnessShutdown = [...harnesses.values()].map((client) => client.close());
  harnesses.clear();
  host?.close();
  if (isWindows) {
    event.preventDefault();
    if (!windowsQuitShutdown) {
      const shutdown = Promise.allSettled([...processShutdown, ...harnessShutdown]);
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, WINDOWS_SHUTDOWN_TIMEOUT_MS));
      windowsQuitShutdown = Promise.race([shutdown, timeout]).then(() => app.exit(0));
    }
  }
});
