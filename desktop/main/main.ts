import { app, BrowserWindow, dialog, globalShortcut, ipcMain, nativeImage, Notification, powerMonitor, protocol, screen, session, shell, systemPreferences } from "electron";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { externalUrl, keepRequest, publicUrl, runCommandRequest, statsExportRequest, trustedSender, validJpegDataUrl, validateRequest, vaultRequest, type Request } from "./ipc";
import { renderResults, webSearch } from "./web-search";
import { clipPage, fetchReadablePage, frontmostApplication, frontmostPage, frontmostTab } from "./clip";
import { discoverImports, saveImportManifest } from "./imports";
import { loadUiPlugins } from "./plugins";
import { hotspotLayout, hotspotPollDelay, nearBounds, overlayGrowth, overlayLayout, parseNotchGeometry, pillLayout, popoutLayout, type NotchGeometry } from "./overlay";
import { BoundedLines, parseHostLine, recordedTurn, type HostDueJob, type RecordedTurn } from "./ndjson";
import { describeRun, packVariables, parseVariables, parseWorkflow, runWorkflow, type WorkflowNode } from "../shared/workflow";
import { ImportedCapabilityRuntime, MAX_SKILL_RESULTS, SkillAttachmentStore, harnessMcpServers as readHarnessMcpServers, listEmmaTools, listImportedMcpServers, mirrorSkillsToHarness, searchImportedSkills, seedBuiltinSkills, writeEmmaTool, writeLearnedSkill } from "./capabilities";
import { daysUnder, mcpServerPrefix, mcpToolKey, readUsage, recordUse, skillKey } from "./invocations";
import { addMarketplace, ensureDefaultMarketplace, installPlugin, pluginDetail, refreshMarketplace, removeMarketplace, runPluginHooks, trustPluginHooks, uninstallPlugin, writePlugin } from "./marketplace";
import { artifactFiles, deleteArtifact, listArtifacts, queryArtifact, readArtifact, readArtifactFile, updateArtifact, updateArtifactFile, writeArtifact, writeArtifactFile } from "./artifacts";
import { ARTIFACT_LABELS, ARTIFACT_SCHEME, artifactFileType, artifactMarker, artifactSlug, MODULE_PATH } from "../shared/artifacts";
import { deleteComponent, listComponents, readComponent, readComponentShot, setComponentAnchor, setComponentEnabled, writeComponent, writeComponentShot } from "./components";
import { COMPONENT_MODULE_PATH, COMPONENT_SCHEME, COMPONENT_SHOT_PATH, PLACE_TIMEOUT_MS, type ComponentAnchor } from "../shared/components";
import { deletePlan, editPlan, listPlans, readPlan, writePlan } from "./plans";
import { DEFAULT_GOAL_TOKEN_BUDGET, goalDrivesAgain, goalPursuing, goalResult, goalTitle, goalTokensLeft, isGoalStatus, MAX_GOAL_EVIDENCE_CHARS, MAX_GOAL_OBJECTIVE_CHARS, MAX_GOAL_REASON_CHARS, MAX_GOAL_TOKEN_BUDGET, usageLimitedFailure, type Goal } from "../shared/goal";
import { mergePlan, parsePlanSteps, planProblems, planProgress, readySteps, renderPlan, stepBrief, type Plan } from "../shared/plan";
import { VISUAL_CSP, VISUAL_SCHEME, visualMarker, visualPage } from "../shared/visualize";
import { captureVisual, keepVisual, readVisual } from "./visuals";
import { CredentialStore } from "./credentials";
import { FolderStore } from "./folders";
import { AttachmentStore, isImageAttachment, type Attachment } from "./attachments";
import { defaultVaultRoot, vaultReady } from "./setup";
import { applyNoteTags, detectObsidianVaults, keepNote, listNotes, obsidianInstallCommand, obsidianInstalled, readVault, saveVault } from "./vault";
import { tagNote } from "./vault-tags";
import { DEFAULT_VAULT_FOLDER, keepKindLabel, MAX_NOTE_BYTES, noteFolder, obsidianOpenUrl, type KeepRequest, type KeptNote, type VaultChoice } from "../shared/vault";
import { privacySettingsUrl, type SetupStatus } from "../shared/setup";
import { CatalogCache, fetchOpenRouterBalance, fetchOpenRouterCatalog, probeProvider } from "./catalog";
import { validateGitArgs } from "../shared/git";
import { installUpdate, readyUpdate, startUpdates } from "./update";
import { addWorktree, commit, commitPaths, discard, gitHistory, gitReady, gitSnapshot, initRepo, mainCheckout, MAX_COMMIT_MESSAGE_BYTES, MAX_HISTORY, runGit, switchBranch, writeCommitMessage } from "./git";
import { installedEditors, openInEditor } from "./editors";
import { machineSample } from "./machine";
import { transcribe, validateUtterance, validateVoiceSettings, voiceStatus } from "./voice";
import { configureResearch, researchJobs, resumeResearchJobs, startResearchJob, stopResearchJob, type ResearchJob } from "./research";
import { contextBlock, MAX_FILE_BYTES, MAX_TURN_IMAGES, mergeSkillContext } from "../shared/folders";
import { BUILTIN_COMMANDS, mentions, pathName } from "../shared/slash";
import { captureDisplay, compressScreenFrame, ComputerUseRuntime, MAX_RUN_STEPS } from "./computer";
import { MIN_UI_SCALE, MAX_UI_SCALE, defaultHarnessExperiments, defaultSettings, defaultTagger, defaultToolSettings, defaultVerifier, routerChain, routerIdFor, validateRouters, holdBindings, isCursorCommand, isThinkingLevel, isKeybindAction, keybindCommands, providerChatUrl, validateProviders, validateKeybinds, validateOverlayPreferences, validateHarnessExperiments, validateTagger, validateToolSettings, validateVerifier, type Keybind, type KeybindAction, type Keybinds, type HarnessExperiments, type OverlayPreferences, type ModelRouter, type ProviderProfile, type TaggerSettings, type ThinkingLevel, type ToolSettings, type VerifierSettings } from "../shared/settings";
import { applied, validateImprovements, type Arm } from "../shared/improvement";
import { frontApplicationNote, ScreenContextStore, type FrontApplication } from "../shared/screen-context";
import { AgentRuntime, benchReplay, benchThread, haltBench, inheritBench, lastAssistantMessage, ownBench, OWN_TOOLS, refuseBenchTurn, towardGoal, type TurnRequest } from "./agent-loop";
import { BackgroundCommands } from "./background";
import { CliRuns } from "./cli";
import { CliModelCatalog } from "./cli-models";
import { CLI_IDS, cliHarness, describeRuns } from "../shared/cli";
import { forceArm, setConnections, setImprovements, setPrompts, setSystemPrompt, verifierLessons, withGoal, withTrialArm, writeHarnessPrompt } from "./system-prompt";
import { detectConnections, isConnectionId, outdatedConnections, setUpConnection } from "./connections";
import { Harness, describePath, failedTurn, harnessKey, type HarnessMcpServer, type HarnessToolCall, type ThinkingRoute } from "./harness";
import { MAX_LOG_LINES, type HarnessLogLine, type HarnessReport } from "../shared/harness-log";
import { review } from "./verifier";
import { advise } from "./advisor";
import { look } from "./vision";
import { readSecret } from "./secret";
import { listMemories, runMemoryCommand } from "./memory";
import { browserArgv, BROWSER_NAVIGATIONS, describeToolCall, MAX_CLI_PROMPT_CHARS, parseToolArgs, shellQuoted, toolNeeds, type ToolArgs } from "./tools";
import { Browsers, type BrowserStatus } from "./browser";
import { Terminals } from "./terminal";
import { MAX_TERMINAL_COLUMNS, MAX_TERMINAL_INPUT } from "../shared/terminal";
import { asPermissionMode, DEFAULT_PERMISSION_MODE, TOOL_CATALOG, toolGate, type PermissionMode } from "../shared/permissions";
import { agentName, editStat, MAX_LIVE_SUBAGENTS, type FileChange, type PermissionAsk, type SubagentRoute } from "../shared/agents";
import { createBridge, type Bridge } from "./bridge";
import { MAX_ASK_MS, PROTOCOL_VERSION, relayOrigin, type BridgeEvent, type BridgeMethod, type CommandMenu, type DesktopIdentity, type GitSyncResult, type LiveAgent, type LiveState, type ModelEntry, type Message, type ThreadStep as RemoteStep, type ThreadSummary, type TraceSpan } from "../shared/mobile-protocol";

const MAX_HOST_RESPONSE_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_CACHE_MS = 5000;

class Host {
  private child: ChildProcessWithoutNullStreams;
  private lines = new BoundedLines(MAX_HOST_RESPONSE_BYTES);
  private nextId = 1;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private failure: Error | null = null;
  private writes = 0;
  private snapshot: { writes: number; at: number; value: Promise<unknown> } | undefined;

  constructor(binary: string) {
    this.child = spawn(binary, [], { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (data: Buffer) => {
      try { for (const line of this.lines.push(data)) { if (this.failure) break; this.receive(line); } }
      catch (error) { this.abort(error instanceof Error ? error : new Error("Emma host protocol error")); }
    });
    this.child.stdout.on("end", () => { try { this.lines.end(); } catch (error) { this.abort(error as Error); } });
    this.child.stderr.on("data", (data) => console.error(String(data).trim()));
    this.child.once("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.once("exit", () => this.fail(new Error("Emma host stopped")));
  }

  request(request: { method: string; params: Record<string, string> }): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (request.method !== "snapshot") {
      this.storeChanged();
      return this.send(request);
    }
    const cached = this.snapshot;
    if (cached && cached.writes === this.writes && Date.now() - cached.at < SNAPSHOT_CACHE_MS) return cached.value;
    const value = this.send(request);
    const entry = { writes: this.writes, at: Date.now(), value };
    this.snapshot = entry;
    const { at } = entry;
    setTimeout(() => { if (this.snapshot?.at === at) this.snapshot = undefined; }, SNAPSHOT_CACHE_MS).unref();
    value.catch(() => { if (this.snapshot === entry) this.snapshot = undefined; });
    return value;
  }

  private storeChanged() {
    this.writes++;
    this.snapshot = undefined;
  }

  private send(request: { method: string; params: Record<string, string> }): Promise<unknown> {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, ...request })}\n`, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  close() {
    this.fail(new Error("Emma host closed"));
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (!this.child.killed) this.child.kill();
  }

  private receive(line: string) {
    try {
      const response = parseHostLine(line);
      if ("dueJob" in response) {
        const job = response.dueJob;
        this.storeChanged();
        void runScheduledWorkflow(job).catch((error: unknown) => console.error(`Scheduled job ${job.jobId} failed:`, error));
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
    this.snapshot = undefined;
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
  }
}

let host: Host | undefined;
let credentials: CredentialStore | undefined;
let folders: FolderStore | undefined;
let attachments: AttachmentStore | undefined;
let modelCatalog: CatalogCache | undefined;
let capabilities: ImportedCapabilityRuntime | undefined;
let computerRuntime: ComputerUseRuntime | undefined;
let agents: AgentRuntime | undefined;
let bridge: Bridge | undefined;
const background = new BackgroundCommands(() => broadcast("emma:background"));
const clis = new CliRuns(() => broadcast("emma:cli-runs"));
let cliModels: CliModelCatalog;
const browsers = new Browsers(() => broadcast("emma:browser"));
const terminals = new Terminals(
  () => nativeHelper("emma-pty"),
  (id, data, at) => broadcast("emma:terminal-data", { id, data, at }),
  () => broadcast("emma:terminals"),
);
let runBanner: BrowserWindow | null = null;
const threadContexts = new Map<string, { folderIds: string[]; mode: PermissionMode; model: string; subagent?: SubagentRoute }>();

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

const threadFolderIds = (threadId: string) => threadContexts.get(threadId)?.folderIds ?? [];
function namedPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 1024) throw new Error("That path is invalid");
  const raw = value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
  const candidates = path.isAbsolute(raw) ? [raw] : folders!.list().map((grant) => path.join(grant.path, raw));
  return candidates.find((candidate) => existsSync(candidate));
}

function attachProject(threadId: string, directory: string) {
  const resolved = realpathSync(directory);
  const grant = folders!.add(resolved).find((folder) => folder.path === resolved);
  if (!grant) throw new Error(`Emma could not open ${directory} as a folder`);
  attachFolder(threadId, grant.id);
}

function attachFolder(threadId: string, folderId: string) {
  const context = threadContexts.get(threadId) ?? { folderIds: [], mode: DEFAULT_PERMISSION_MODE, model: "" };
  if (context.folderIds[0] !== folderId) threadContexts.set(threadId, { ...context, folderIds: [folderId] });
  broadcast("emma:folder-attached", { threadId, folderId });
  changed();
}
const skillAttachment = new SkillAttachmentStore();
const harnesses = new Map<string, Harness>();
const harnessLog: HarnessLogLine[] = [];

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
  for (const client of harnesses.values()) client.close();
  harnesses.clear();
  noteHarnessLog({ at: Date.now(), flow: "err", label: "restart", body: `Emma stopped ${stopped} emma-cli ${stopped === 1 ? "process" : "processes"}. The next turn starts a fresh one.` });
  return readHarnessReport();
}
const harnessText = new Map<string, string>();
const harnessThought = new Map<string, string>();
const harnessRouted = new Map<string, string>();
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
    return;
  }
  for (const harness of harnesses.values()) {
    if (await harness.steer(threadId, text)) return;
  }
  agents!.steer(threadId, text);
}
function answerAsk(id: string, allowed: boolean) {
  agents!.answer(id, allowed);
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
let verifier: VerifierSettings = defaultVerifier;
let toolSettings: ToolSettings = defaultToolSettings;
let harnessExperiments: HarnessExperiments = defaultHarnessExperiments;

const toolsChanged = async () => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("emma:tools-changed");
  for (const client of harnesses.values()) client.rebindServers();
  await syncHarnessSkills();
};
const artifactsChanged = () => broadcast("emma:artifacts-changed");
const componentsChanged = () => broadcast("emma:components-changed");

const placements = new Map<string, ComponentAnchor>();
let placeAsk: { id: string; settle: (anchor: ComponentAnchor | undefined) => void } | undefined;

function askPlace(title: string): Promise<ComponentAnchor | undefined> {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Emma's window is not open, so there is nowhere for the user to point at.");
  placeAsk?.settle(undefined);
  const id = randomUUID();
  needsYou("Emma needs a spot", `Point at where \u201c${title}\u201d goes`);
  mainWindow.webContents.send("emma:component-place", { id, title });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (placeAsk?.id === id) placeAsk.settle(undefined); }, PLACE_TIMEOUT_MS);
    placeAsk = { id, settle: (anchor) => { clearTimeout(timer); placeAsk = undefined; resolve(anchor); } };
  });
}
const plansChanged = () => broadcast("emma:plans-changed");
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
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(app.getAppPath(), "..", DEV_BINARIES[name] ?? name);
}

function nativeHelper(name = "emma-option-tap") {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(app.getAppPath(), `dist-native/${name}`);
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
  if (process.platform !== "darwin") return;
  const child = spawn(nativeHelper(), [], { stdio: ["pipe", "pipe", "pipe"] });
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
    try {
      const taken = globalShortcut.register(keybind.accelerator, () => runKeybindAction(action));
      if (!taken) throw new Error("already registered");
      registeredKeybinds.add(keybind.accelerator);
    } catch (error) {
      console.error(`Emma: ${keybind.accelerator} is unavailable`, error);
      refused.push(action);
    }
  }
  return refused;
}

function sendHoldKeybinds() {
  try { hotkeyHelper?.stdin?.write(`${JSON.stringify({ holds: holdBindings(keybinds) })}\n`); }
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
  window.webContents.on("will-navigate", (event, url) => {
    const current = window.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
  return window;
}

async function load(window: BrowserWindow, mode: "main" | "overlay" | "annotation" | "hotspot" | "run" | "radial" = "main", extra: Record<string, string> = {}) {
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
    else window.showInactive();
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
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 17 },
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
  overlaySurface = "notch";
  overlayGrow = 0;
  overlayFront = frontContextNote().catch(() => "");
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const layout = overlayLayout(display, overlayPreferences, notches.find((item) => item.id === display.id));
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
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  window.on("blur", () => { if (!annotating && !capturing) leaveOverlay(window); });
  window.on("closed", () => {
    if (overlay === window) overlay = null;
    closeRadial();
    annotationAttachment.clearAll();
    overlayBusy = false;
    overlayFront = Promise.resolve("");
    closeOverlayWhenIdle = false;
    overlaySurface = "notch";
    overlayGrow = 0;
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (input.key === "Escape") {
      event.preventDefault();
      leaveOverlay(window);
    }
  });
  closeHotspot();
  void load(window, "overlay", { notchLeft: String(layout.notch.left), notchWidth: String(layout.notch.width), notchHeight: String(layout.notch.height), ...(command ? { command } : {}) });
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
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
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
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
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
      const inside = near(point, 0);
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
  if (process.platform !== "darwin") return undefined;
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
  const mac = process.platform === "darwin";
  const vault = readVault(app.getPath("userData"));
  return {
    accessibility: !mac || systemPreferences.isTrustedAccessibilityClient(false),
    screen: !mac || systemPreferences.getMediaAccessStatus("screen") === "granted",
    microphone: !mac || systemPreferences.getMediaAccessStatus("microphone") === "granted",
    speech: mac ? null : true,
    automation: mac ? null : true,
    notifications: Notification.isSupported() ? (mac ? null : true) : false,
    files: vaultReady(vault),
    vault,
  };
}

function credentialSlot(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider key request is invalid");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.env !== "string" || (candidate.secret !== undefined && typeof candidate.secret !== "string")) throw new Error("Provider key request is invalid");
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
  return { id, prompt: candidate.prompt };
}

async function bestLearnedSkill(task: string) {
  for (const word of task.toLowerCase().match(/[a-z0-9]{4,}/g)?.slice(0, 8) ?? []) {
    const [match] = await capabilities!.searchSkills(word, 1);
    if (match) return capabilities!.selectSkill(match.id).catch(() => undefined);
  }
  return undefined;
}

async function skillParams(task: string): Promise<Record<string, string>> {
  const skill = await bestLearnedSkill(task);
  if (!skill) return {};
  void recordUse(app.getPath("userData"), skillKey(skill.id));
  return { skillContext: skill.instructions };
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
  return { threadId, folderIds: raw.map((id) => boundedCapabilityId(id, "Thread folder")), mode: asPermissionMode(candidate.mode), model, subagent: subagentRoute(candidate) };
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

function reportRunProgress(step: number, action: string, actions: number) {
  if (runBanner && !runBanner.isDestroyed()) runBanner.webContents.send("emma:computer-run-progress", { step, action, actions });
}

const BRIDGE_EVENTS: Record<string, (payload: unknown) => BridgeEvent> = {
  "emma:changed": () => ({ k: "evt", t: "invalidate", what: "snapshot" }),
  "emma:artifacts-changed": () => ({ k: "evt", t: "invalidate", what: "artifacts" }),
  "emma:plans-changed": () => ({ k: "evt", t: "invalidate", what: "plans" }),
  "emma:notes-changed": () => ({ k: "evt", t: "invalidate", what: "notes" }),
  "emma:components-changed": () => ({ k: "evt", t: "invalidate", what: "components" }),
  "emma:cli-runs": () => ({ k: "evt", t: "invalidate", what: "cliRuns" }),
  "emma:background": () => ({ k: "evt", t: "invalidate", what: "background" }),
  "emma:delta": (payload) => ({ k: "evt", ...(payload as { threadId: string; delta: string; thinking?: boolean }), t: "delta" }),
  "emma:step": (payload) => ({ k: "evt", t: "step", step: payload as RemoteStep }),
  "emma:agents": (payload) => ({ k: "evt", t: "agents", agents: payload as LiveAgent[] }),
  "emma:spans": (payload) => ({ k: "evt", t: "spans", spans: payload as Record<string, TraceSpan[]> }),
  "emma:folder-attached": (payload) => ({ k: "evt", ...(payload as { threadId: string; folderId: string }), t: "folder-attached" }),
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
const READ_ONLY_METHODS = new Set(["snapshot", "listOpenRouterModels"]);
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
  if (!id) throw new Error("No folder is connected to this thread. Ask the user to connect one from the ＋ menu.");
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
    vaultFolderId = folders!.add(root).find((grant) => grant.path === root)?.id;
  } catch (error) {
    console.error("Emma: could not connect the vault folder", error);
  }
}

function visibleFolders() {
  return folders!.list().filter((grant) => grant.id !== vaultFolderId);
}

const obsidianVaults = (): VaultChoice[] =>
  detectObsidianVaults().map((found) => ({ root: found.path, folder: DEFAULT_VAULT_FOLDER, kind: "obsidian", name: found.name }));

function noteInVault(vault: VaultChoice, value: unknown): string {
  const root = noteFolder(vault);
  const full = path.resolve(root, boundedCapabilityId(value, "Note"));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("That note is not in your vault.");
  return path.relative(root, full);
}

const notesChanged = () => broadcast("emma:notes-changed");

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

function folderImage(threadId: string, named: string | undefined, relative: string): string {
  const grant = attachments!.holds(relative) ? undefined : grantFor(threadId, named);
  const frame = nativeImage.createFromPath(grant ? path.join(folders!.directory(grant), folders!.within(grant, relative)) : relative);
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
  const snapshot = await host!.request({ method: "snapshot", params: {} }) as {
    threads?: { id: string; messages?: { generation?: { inputTokens?: number } | null }[] }[];
  };
  const messages = snapshot.threads?.find((item) => item.id === turn.threadId)?.messages ?? [];
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
      const run = args.action === "run"
        ? await clis.start({
          threadId: turn.threadId,
          cli: args.cli!,
          prompt: args.prompt!,
          cwd: folders!.directory(grantFor(turn.threadId, args.folder)),
          folder: folderNames([grantFor(turn.threadId, args.folder)])[0] ?? "",
          unattended: args.unattended,
        })
        : await clis.send(args.id!, args.prompt!);
      const read = clis.output(run.id, MAX_COMMAND_OUTPUT);
      const harness = cliHarness(run.cli);
      const caveat = harness && !harness.ownsSession && args.action === "run"
        ? ` ${harness.label} resumes by "most recent session in this folder" rather than by id, so keep one ${run.cli} run going at a time here.`
        : "";
      return `${run.cli} run ${run.id} finished turn ${run.turns} (${run.status === "failed" ? "failed to start" : `exit ${run.exitCode ?? "?"}`}). Send it more with cli {"action":"send","id":"${run.id}","prompt":"…"}.${caveat}\n\n${read?.output.trim() || "(no output)"}`;
    }
    case "cli_runs": {
      if (!args.id) {
        const installed = await clis.installed();
        const available = installed.length
          ? installed.map((item) => `${item.id} — ${item.label} at ${item.path}`).join("\n")
          : "None of the CLIs Emma knows are installed on this Mac.";
        return `Installed CLIs:\n${available}\n\nRuns:\n${describeRuns(clis.list())}`;
      }
      if (args.stop) {
        return clis.stop(args.id)
          ? `Stopped the turn ${args.id} was working on.`
          : `${args.id} is not working on a turn right now. ${describeRuns(clis.list())}`;
      }
      const read = clis.output(args.id, MAX_COMMAND_OUTPUT);
      if (!read) return `There is no CLI run called ${args.id}. ${describeRuns(clis.list())}`;
      const state = read.run.status === "running" ? `still working on turn ${read.run.turns}` : `idle after ${read.run.turns} ${read.run.turns === 1 ? "turn" : "turns"} (exit ${read.run.exitCode ?? "?"})`;
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
      reportRunProgress(computerRuntime!.steps, `${String(args.args.action)}${args.args.app ? ` · ${args.args.app}` : ""}`, computerRuntime!.actions);
      return said;
    }
    case "browser": {
      if (args.action !== "close") broadcast("emma:browser-show", { threadId: turn.threadId });
      if (args.action === "open") return `Opened ${browserPage(await browsers.open(turn.threadId, args.url!))}. Snapshot it to see what is on it.`;
      if (args.action === "screenshot") {
        const file = shotFile("png");
        await browsers.run(turn.threadId, ["screenshot", ...(args.selector ? [args.selector] : []), file]);
        return shownToUser(file, "Took a screenshot of the page.");
      }
      const navigation = BROWSER_NAVIGATIONS.find((candidate) => candidate === args.action);
      if (!navigation) return await browsers.run(turn.threadId, browserArgv(args));
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
      return await runCommand(cwd, `${shellQuoted(match.run)} ${shellQuoted(args.input ?? "")}`);
    }
    case "memory":
      return await runMemoryCommand(memoryRoot(), args.command);
    case "vision": {
      const image = args.url ? publicUrl(args.url)?.href : folderImage(turn.threadId, args.folder, args.path!);
      if (!image) throw new Error("That is not a public image URL. Use a path in a connected folder for a file on this Mac.");
      return await look(toolSettings.vision, image, args.question);
    }
    case "secret": {
      const attached = threadFolder(turn.threadId);
      const output = await runCommand(attached ? folders!.directory(attached) : homedir(), args.command);
      return await readSecret(toolSettings.secret, args.command, output, args.question);
    }
    case "plan":
      return await planTool(args, turn);
    case "goal":
      return await goalTool(args, turn);
    case "context":
      return await reportContext(turn, args.compact);
    case "keep":
      return await keepTool(args);
    case "web_search": {
      const { credentialEnv } = toolSettings.webSearch;
      const results = await webSearch(toolSettings.webSearch, args.query, args.limit, (credentialEnv && process.env[credentialEnv]) || "");
      return renderResults(args.query, results);
    }
    case "install_mcp": {
      const { id } = await capabilities!.installMcpServer({ name: args.server, command: args.command, args: args.argv, env: args.env });
      await toolsChanged();
      return `Installed "${args.server}" (${id}) into Emma's configuration — the harness connects it when the next turn starts, and its tools are found from then on with mcp_search_tools.`;
    }
    case "workflow":
      return await workflowTool(args);
    case "autoresearch":
      return await researchTool(args);
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

async function componentTool(args: Extract<ToolArgs, { name: "component" }>, threadId: string): Promise<string> {
  const userData = app.getPath("userData");
  switch (args.action) {
    case "list": {
      const built = await listComponents(userData);
      if (!built.length) return 'Emma has built nothing into her interface yet. Start with component {"action":"place"} \u2014 the user points at where it goes.';
      return `Components:\n${built.map((one) => `${one.id} \u2014 ${one.title} \u2014 in ${one.anchor.label} \u2014 v${one.version}${one.disabled ? " \u2014 switched off by the user" : ""}`).join("\n")}`;
    }
    case "get": {
      const one = await readComponent(userData, args.id!);
      return `${one.title} (${one.id}) \u2014 in ${one.anchor.label}, version ${one.version}\n\n${one.code}`;
    }
    case "place": {
      const anchor = await askPlace(args.title ?? "the new component");
      if (!anchor) return "The user did not pick a spot, so there is nowhere to build. Ask them where it should go before trying again.";
      placements.set(threadId, anchor);
      return `The user pointed at ${anchor.label}. Now ask them whatever the request left open \u2014 what it shows, where its numbers come from, how it behaves \u2014 unless they already said it. Then build it with component {"action":"create","title":"\u2026","code":"\u2026"}.`;
    }
    case "create": {
      const anchor = placements.get(threadId);
      if (!anchor) throw new Error('There is nowhere to put it yet. Call component {"action":"place"} first: the user points at the spot and this thread remembers it.');
      const saved = await writeComponent(userData, { title: args.title!, code: args.code!, anchor, sourceThreadId: threadId });
      placements.delete(threadId);
      componentsChanged();
      return `Built "${saved.title}" (${saved.id}) into ${anchor.label}, and it is on screen now. Ask the user how it looks: component {"action":"rewrite","id":"${saved.id}","code":"\u2026"} reloads it in place while they watch. The \u22ef in its corner is how they delete it.`;
    }
    case "rewrite": {
      const existing = await readComponent(userData, args.id!);
      const saved = await writeComponent(userData, { id: existing.id, title: args.title ?? existing.title, code: args.code!, sourceThreadId: threadId });
      componentsChanged();
      return `Reworked "${saved.title}" \u2014 v${saved.version}, reloaded in place. Ask whether that is what they meant.`;
    }
  }
}

function runCommand(cwd: string, command: string, timeoutMs = MAX_COMMAND_MS): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (data: Buffer) => { if (output.length < MAX_COMMAND_OUTPUT) output += String(data); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); resolve(`That command could not start: ${error.message}`); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const body = output.slice(0, MAX_COMMAND_OUTPUT).trim() || "(no output)";
      if (signal) return resolve(`${body}\n[killed after ${timeoutMs / 1000}s]`);
      resolve(code === 0 ? body : `${body}\n[exit ${code}]`);
    });
  });
}

const MAX_COMMAND_OUTPUT = 16 * 1024;
const MAX_CLI_VIEW_CHARS = 128 * 1024;
const MAX_COMMAND_MS = 120_000;

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
  const client = new Harness({
    binaryPath,
    cwd,
    home: path.join(app.getPath("userData"), "harness"),
    apiKey: route ? route.apiKey : process.env.OPENROUTER_API_KEY,
    chatUrl: route?.chatUrl,
    onDelta: (threadId, delta) => {
      if (agents && !agents.noteDelta(threadId, delta)) return;
      harnessText.set(threadId, (harnessText.get(threadId) ?? "") + delta);
      broadcast("emma:delta", { threadId, delta });
    },
    onThought: (threadId, delta) => {
      if (agents && !agents.noteDelta(threadId, delta)) return;
      harnessThought.set(threadId, (harnessThought.get(threadId) ?? "") + delta);
      broadcast("emma:delta", { threadId, delta, thinking: true });
    },
    onToolCall: (call) => {
      agents?.noteTool(call.threadId, call.toolCallId, call.title || call.kind, call);
      void recordUse(app.getPath("userData"), mcpToolKey(call.title), `${call.threadId}:${call.toolCallId}`);
      const wrote = noteHarnessChange(cwd, call);
      broadcast("emma:step", wrote ? { ...call, edit: editStat(wrote) } : call);
    },
    onContextExperiment: (threadId, fired) => broadcast("emma:context-experiment", { threadId, ...fired }),
    onContextBreakdown: (threadId, parts) => broadcast("emma:context-breakdown", { threadId, ...parts }),
    onRoutedModel: (threadId, routed) => {
      harnessRouted.set(threadId, routed.model);
      broadcast("emma:routed-model", { threadId, ...routed });
    },
    onUsage: (threadId, usage) => {
      agents?.noteUsage(threadId, usage);
      const goal = goals.get(threadId);
      if (goalPursuing(goal) && noteTurnSpend(threadId, usage) >= goalTokensLeft(goal)) stopThread(threadId);
    },
    onChildStart: async ({ parentThreadId, childId, title }) => {
      const name = agentName(childId, new Set(agents!.list().map((agent) => agent.title)));
      const created = await host!.request({ method: "createThread", params: { parentThreadId, title: name, kind: "subagent" } });
      const threadId = (created as { id?: unknown }).id;
      if (typeof threadId !== "string") throw new Error("Emma host returned an invalid thread");
      harnessText.set(threadId, "");
      harnessThought.set(threadId, "");
      harnessChildren.set(threadId, { childId, title, startedAt: Date.now(), client });
      const parent = harnessTurns.get(parentThreadId);
      agents!.adopt({
        threadId,
        content: title,
        title: name,
        parentThreadId,
        depth: (parent?.depth ?? 0) + 1,
        mode: parent?.mode ?? DEFAULT_PERMISSION_MODE,
        model: modelName(parent?.model),
        effort: parent?.effort ?? "",
        parentSpanId: agents!.spanFor(parentThreadId),
      });
      return threadId;
    },
    onChildEnd: (threadId, reason) => {
      const child = harnessChildren.get(threadId);
      if (!child) return;
      harnessChildren.delete(threadId);
      const spoken = (harnessText.get(threadId) ?? "").trim();
      const thinking = harnessThought.get(threadId);
      harnessText.delete(threadId);
      harnessThought.delete(threadId);
      const spent = agents!.list().find((agent) => agent.threadId === threadId);
      agents!.finish(threadId, reason);
      void recordTurn({
        threadId,
        prompt: child.title,
        thinking,
        answer: spoken || (reason ? `(this subagent stopped: ${reason})` : "(the subagent finished without an answer)"),
        durationMilliseconds: String(Date.now() - child.startedAt),
        outputTokens: String(spent?.outputTokens ?? 0),
        inputTokens: String(spent?.inputTokens ?? 0),
        model: harnessRouted.get(threadId) ?? modelName(threadModel(threadId)),
      }).catch((error: unknown) => console.error("Emma: a subagent's transcript could not be recorded", error));
    },
    onPlan: () => {},
    onLifecycle: async (event, threadId, input) => {
      if (event === "Stop") input.last_assistant_message = harnessText.get(threadId)?.trim() || null;
      const failures = await runPluginHooks(app.getPath("userData"), event, input);
      for (const failure of failures) {
        broadcast("emma:step", { threadId, toolCallId: `hook:${event}:${failure.slice(0, 40)}`, title: failure, kind: "other", status: "failed", at: Date.now() });
      }
    },
    onPermission: async (ask, options, context) => {
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
      if (context.mode === "full") return pick("allow_once", "allow_always") ?? options[0]?.optionId ?? null;
      if (context.mode === "acceptEdits" && context.kind === "edit") return pick("allow_once", "allow_always") ?? options[0]?.optionId ?? null;
      const allowed = await agents!.question({ threadId: ask.threadId, tool: ask.tool, summary: ask.summary, detail: ask.detail });
      return allowed ? pick("allow_once", "allow_always") ?? options[0]?.optionId ?? null : deny();
    },
    onToolRequest: (threadId, name, args) => runEmmaTool(threadId, name, args),
    mcpServers: (threadId) => harnessMcpServers(threadId),
    onLog: noteHarnessLog,
  });
  harnesses.set(key, client);
  reapHarnesses();
  return client;
}

const MAX_HARNESSES = 4;

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
  const relative = describePath(call.input);
  if (!relative) return;
  const grant = folders!.list().find((folder) => folder.path === cwd);
  if (!grant) return;
  const absolute = path.resolve(cwd, relative);
  if (absolute !== cwd && !absolute.startsWith(cwd + path.sep)) return;
  const read = () => { try { return readFileSync(absolute, "utf8"); } catch { return null; } };

  if (call.status !== "completed") {
    if (!harnessBefore.has(call.toolCallId)) harnessBefore.set(call.toolCallId, { threadId: call.threadId, text: read() });
    return;
  }
  const before = harnessBefore.get(call.toolCallId)?.text ?? null;
  harnessBefore.delete(call.toolCallId);
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
  const running = () => agents!.isLive(threadId);
  if (!turn || !running()) throw new Error("Emma's tools are only available while a turn is running.");
  const gate = toolGate(turn.mode, name, toolSettings.disabledTools);
  if (gate === "hidden") {
    throw new Error(`${wireName} is not available in ${turn.mode} mode, or is switched off in Settings → Tools.`);
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
  if (harnessTurns.get(threadId) !== turn || !running()) throw new Error("This turn ended before the tool could run.");
  const call = () => OWN_TOOLS.has(name)
    ? agents!.runThreadTool(parsed, turn)
    : executeTool(parsed as ToolArgs, turn);
  return turn.bench ? await benchReplay.run(true, call) : await call();
}

function whyUnavailable(threadId: string, name: string, called = name): string | undefined {
  const needs = toolNeeds(name);
  if (needs === "folders" && threadFolderIds(threadId).length === 0) {
    return `${called} needs a connected folder. Ask the user to connect one — the folder button in Emma's sidebar opens the picker.`;
  }
  if (needs === "computer" && process.platform !== "darwin") {
    return `${called} controls this Mac, and this is not a Mac.`;
  }
  return undefined;
}

async function harnessMcpServers(_threadId: string): Promise<HarnessMcpServer[]> {
  try {
    return await readHarnessMcpServers(app.getPath("userData"));
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

function providerRoute(key: string | undefined): ProviderRoute | undefined {
  const profile = providerFor(key);
  if (!profile) return undefined;
  return { id: profile.id, chatUrl: providerChatUrl(profile), apiKey: (profile.credentialEnv ? process.env[profile.credentialEnv] : "") || "no-key" };
}

function harnessModel(key: string | undefined) {
  const routerId = routerIdFor(key);
  if (routerId) return routerChain(modelCatalog?.ids(), routers.find((router) => router.id === routerId)?.models ?? []);
  if (key?.startsWith("openrouter:")) return key.slice("openrouter:".length);
  return providerFor(key)?.modelId;
}

function modelName(key: string | undefined) {
  if (key?.startsWith("openrouter:")) return key.slice("openrouter:".length);
  return providerFor(key)?.modelId ?? key ?? "";
}

function contextWindowFor(model: string | undefined, key?: string) {
  return providerFor(key)?.contextWindow || modelCatalog?.contextLength(model?.split(",")[0]);
}

function thinkingRoute(model: string | undefined, level: string | undefined): ThinkingRoute | undefined {
  if (!model) return undefined;
  const published = modelCatalog?.reasoningEfforts(model.split(",")[0]) ?? [];
  return { level: level && published.includes(level) ? level : "", published };
}

let selectedModel = "";
let selectedEffort: ThinkingLevel = "";
function catalogued(modelId: string): string {
  if (!modelCatalog!.ids().includes(modelId)) throw new Error("That model is no longer in OpenRouter's catalog. Reload the models page and pick again.");
  return modelId;
}

const thinkingLevel = (value: unknown): ThinkingLevel => isThinkingLevel(value) ? value : "";

function selectModel(method: string, params: Record<string, string>): unknown {
  if (method === "setThreadModel") {
    if (params.modelId) catalogued(params.modelId);
    return { set: true };
  }
  if (method === "selectFallbackModel") {
    selectedModel = "";
    selectedEffort = "";
    return { model: "" };
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

function answerRequest(method: string, params: Record<string, string> = {}): Promise<unknown> {
  switch (method) {
    case "listOpenRouterModels":
      return modelCatalog!.refresh(() => fetchOpenRouterCatalog(), params.force ? 0 : 24 * 60 * 60 * 1000);
    case "selectOpenRouterModel": case "selectProviderModel": case "selectFallbackModel": case "setThreadModel":
      return Promise.resolve().then(() => selectModel(method, params));
    case "createThread":
      return host!.request({ method, params }).then((created) => {
        const id = (created as { id?: unknown } | null)?.id;
        if (typeof id === "string" && params.parentThreadId && inheritBench(id, params.parentThreadId)) stopThread(id);
        return created;
      });
    case "setRouters":
      return Promise.resolve().then(() => {
        routers = validateRouters(JSON.parse(params.routers ?? "[]"));
        return { routers: routers.length };
      });
    default: return host!.request({ method, params });
  }
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

function recordTurn(turn: RecordedTurn): Promise<unknown> {
  return host!.request({ method: "recordTurn", params: recordedTurn(turn) });
}

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

const WAKE_GRACE_MS = 45_000;
const harnessRuns = new Map<string, Harness>();
const sleepWedged = new Set<string>();
const SLEEP_CONTINUATION = "This Mac went to sleep mid-turn and the connection to the model was lost. Carry on from the last step you finished.";
const pausedRecovery = new Set<string>();
const CRASH_CONTINUATION = "The harness process died mid-turn and has been restarted. Carry on from the last step you finished, and check what is already on disk before redoing any of it.";

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

async function runOnHarness(client: Harness, cwd: string, turn: TurnRequest, key = cwd) {
  computerRuntime?.end(turn.threadId);
  harnessText.set(turn.threadId, "");
  harnessThought.set(turn.threadId, "");
  harnessRouted.delete(turn.threadId);
  harnessTurns.set(turn.threadId, turn);
  harnessRuns.set(turn.threadId, client);
  const startedAt = Date.now();
  agents!.adopt({ ...turn, model: modelName(turn.model) });
  const route = harnessModel(turn.model);
  try {
    const { stopReason, usage } = await client.prompt(turn.threadId, cwd, turn.content, turn.mode, route, {
      skillContext: typeof turn.params?.skillContext === "string" ? turn.params.skillContext : undefined,
      images: attachedImagePaths(turn.params?.attachedImages),
      contextWindow: contextWindowFor(route, turn.model),
      effort: thinkingRoute(route, turn.effort),
      experiments: harnessExperiments,
      compact: compactNext.delete(turn.threadId),
      continueRecovery: turn.continueRecovery,
    });
    agents!.noteUsage(turn.threadId, usage);
    const spoken = (harnessText.get(turn.threadId) ?? "").trim();
    if (failedTurn(stopReason)) {
      pausedRecovery.add(turn.threadId);
      throw new Error(spoken || "The run was refused.");
    }
    agents!.finish(turn.threadId);
    return await recordTurn({
      threadId: turn.threadId,
      prompt: turn.content,
      thinking: harnessThought.get(turn.threadId),
      answer: spoken || `(the run ended: ${stopReason})`,
      durationMilliseconds: String(Date.now() - startedAt),
      outputTokens: String(usage.outputTokens),
      inputTokens: String(usage.inputTokens),
      model: harnessRouted.get(turn.threadId) ?? modelName(turn.model),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    agents!.finish(turn.threadId, detail);
    if (sleepWedged.delete(turn.threadId) && agents!.list().find((agent) => agent.threadId === turn.threadId)?.status !== "stopped") {
      agents!.forget(turn.threadId);
      return await runOnHarness(harnessClient(cwd, key, providerRoute(turn.model)), cwd, { ...turn, content: SLEEP_CONTINUATION }, key);
    }
    if (pausedRecovery.delete(turn.threadId) && !turn.continueRecovery && agents!.list().find((agent) => agent.threadId === turn.threadId)?.status !== "stopped") {
      agents!.forget(turn.threadId);
      try {
        return await runOnHarness(harnessClient(cwd, key, providerRoute(turn.model)), cwd, { ...turn, continueRecovery: true }, key);
      } catch {
        throw error;
      }
    }
    if (!client.running && turn.content !== CRASH_CONTINUATION && agents!.list().find((agent) => agent.threadId === turn.threadId)?.status !== "stopped") {
      agents!.forget(turn.threadId);
      try {
        return await runOnHarness(harnessClient(cwd, key, providerRoute(turn.model)), cwd, { ...turn, content: CRASH_CONTINUATION }, key);
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
        answer: `${spoken}\n\n_(this run stopped: ${detail})_`.trim(),
        durationMilliseconds: String(Date.now() - startedAt),
        outputTokens: String(stoppedUsage.outputTokens),
        inputTokens: String(stoppedUsage.inputTokens),
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
  turn.effort ??= harnessModel(turn.model) === harnessModel(selectedModel) ? selectedEffort : "";
  turn.objective ??= activeGoal(turn.threadId)?.objective;
  const cwd = harnessCwd(turn.threadId);
  const nested = turn.nested ? turn.threadId : undefined;
  const route = providerRoute(turn.model);
  const key = harnessKey(cwd, nested, route?.id);
  try {
    writeHarnessPrompt(path.join(app.getPath("userData"), "harness"), { model: turn.model, workspace: cwd, mode: turn.mode, disabledTools: toolSettings.disabledTools });
    return await runOnHarness(harnessClient(cwd, key, route), cwd, withGoal(withTrialArm(turn), activeGoal(turn.threadId)), key);
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
  const result = request.method === "sendMessage"
    ? await driveTurn({ threadId, content, mode: threadMode(threadId), title: "This thread", model: threadModel(threadId), params: { ...await skillParams(content), ...extra } })
    : await answerRequest(request.method, request.params);
  if (request.method === "setResearchJobStatus") {
    if (request.params.status === "running") startResearchJob(request.params.jobId);
    else stopResearchJob(request.params.jobId);
  }
  if (request.method === "deleteResearchJob") stopResearchJob(request.params.jobId);
  if (!READ_ONLY_METHODS.has(request.method)) changed();
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

type StoredThreads = { threads: (Omit<ThreadSummary, "messages"> & { messages: Message[] })[]; warnings: string[] };

async function threadStore(): Promise<StoredThreads> {
  const stored = await runRequest(validateRequest({ method: "snapshot", params: {} })) as Partial<StoredThreads>;
  return { threads: stored.threads ?? [], warnings: stored.warnings ?? [] };
}

function threadSummary(thread: unknown): ThreadSummary {
  const { messages, ...rest } = thread as { messages?: unknown[] };
  return { ...rest, messages: Array.isArray(messages) ? messages.length : 0 } as ThreadSummary;
}

function bridgeLive(): LiveState {
  return { agents: agents!.list(), spans: agents!.spans(), asks: [], partial: livePartial(), desktop: desktopIdentity };
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
      const stored = await threadStore();
      return {
        threads: stored.threads.map((thread) => ({ ...threadSummary(thread), folderIds: threadFolderIds((thread as { id: string }).id) })),
        warnings: stored.warnings,
      };
    }
    case "threadMessages": {
      const threadId = boundedCapabilityId(params.threadId, "Thread");
      const thread = (await threadStore()).threads.find((entry) => entry.id === threadId);
      if (!thread) throw new Error("That thread is gone.");
      const total = thread.messages.length;
      const before = Math.min(gitCount(params.before, "Before") ?? total, total);
      const limit = Math.min(gitCount(params.limit, "Limit") || MESSAGE_PAGE, MESSAGE_PAGE);
      const from = Math.max(0, before - limit);
      return { messages: thread.messages.slice(from, before), total, from };
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
      return threadSummary(await runRequest(validateRequest({ method, params: { threadId: params.threadId, content: params.content } })));
    case "stopAgent":
      if (params.threadId === undefined) stopEveryThread();
      else stopThread(boundedCapabilityId(params.threadId, "Thread"));
      return { stopped: true };
    case "steerAgent": {
      const request = agentMessage(params);
      await steerThread(request.threadId, request.text);
      return { steered: true };
    }
    case "answerPermission":
      answerAsk(boundedCapabilityId(params.id, "Permission"), flag(params.allowed, "Permission answer"));
      return { answered: true };
    case "getThreadContext": {
      const threadId = boundedCapabilityId(params.threadId, "Thread");
      const context = threadContexts.get(threadId);
      return { threadId, folderIds: context?.folderIds ?? [], mode: context?.mode ?? DEFAULT_PERMISSION_MODE, model: context?.model ?? "" };
    }
    case "setThreadContext": {
      const { threadId, ...context } = threadContextRequest(params);
      threadContexts.set(threadId, context);
      agents!.setMode(threadId, context.mode);
      return { threadId, folderIds: context.folderIds, mode: context.mode, model: context.model };
    }
    case "threadTraces": {
      const traces = await host!.request({ method: "readTrace", params: { threadId: boundedCapabilityId(params.threadId, "Thread") } });
      return Array.isArray(traces) ? traces : [];
    }
    case "listModels": {
      const catalog = await runRequest(validateRequest({ method: "listOpenRouterModels", params: params.force === true ? { force: "true" } : {} }));
      const models = (catalog as { models?: { id: string; name: string; contextLength: number; free: boolean; reasoningEfforts?: string[] }[] }).models ?? [];
      return models.map((model): ModelEntry => ({ id: model.id, key: `openrouter:${model.id}`, name: model.name, contextLength: model.contextLength, free: model.free, efforts: model.reasoningEfforts ?? [] }));
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
          ...skills.map((skill) => ({ id: skill.id, name: skill.name, kind: "skill" as const, detail: `${skill.source} · skill` })),
          ...servers.map((server) => ({ id: server.id, name: server.name, kind: "mcp" as const, detail: `${server.source} · MCP server` })),
          ...TOOL_CATALOG
            .filter((tool) => !toolSettings.disabledTools.includes(tool.name))
            .map((tool) => ({ id: `tool:${tool.name}`, name: tool.name, kind: "tool" as const, detail: tool.blurb })),
        ],
        at: [
          ...artifacts.map((artifact) => ({ id: `artifact:${artifact.id}`, name: pathName(artifact.title), kind: "artifact" as const, detail: `${ARTIFACT_LABELS[artifact.kind]} · artifact` })),
          ...(vault ? listNotes(vault) : []).map((note) => ({ id: `note:${note.path}`, name: pathName(note.title), kind: "page" as const, detail: [keepKindLabel(note.kind), ...note.tags].join(" · ") })),
          ...attached.flatMap((folderId) => {
            const folder = grants.find((grant) => grant.id === folderId);
            return folder ? folders!.files(folderId).map((file) => ({ id: `file:${folderId}:${file.path}`, name: pathName(file.path), kind: "file" as const, detail: `${folder.name}/${file.path}` })) : [];
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
  }
}

function driveTurn(turn: TurnRequest) {
  refuseBenchTurn(turn.threadId);
  turn.bench = benchThread(turn.threadId);
  return runDrivenTurn(turn);
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
  return recorded;
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
        mode: turn.mode,
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
  const snapshot = await host!.request({ method: "snapshot", params: {} }) as { scheduledJobs?: StoredJob[] };
  return snapshot.scheduledJobs ?? [];
}

async function resolveMentions(prompt: string, threadId: string): Promise<string> {
  const named = mentions(prompt, "/");
  if (named.length) {
    const skills = await capabilities!.searchSkills("", 64);
    const skill = skills.find((item) => named.includes(item.name) && !toolSettings.disabledSkills.includes(item.id));
    if (skill) skillAttachment.put(await capabilities!.selectSkill(skill.id), threadId);
  }
  const sections: { heading: string; body: string }[] = [];
  const paths = mentions(prompt, "@");
  const userData = app.getPath("userData");
  const artifacts = paths.length ? await listArtifacts(userData).catch(() => []) : [];
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
    for (const grant of folders!.list()) {
      const listed = folders!.files(grant.id).find((file) => pathName(file.path) === mention);
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
  return sections.length ? `${prompt}\n\n${contextBlock(sections)}` : prompt;
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
  const run = await runWorkflow(nodes, parseVariables(job.variables), async (prompt) => {
    const content = await resolveMentions(prompt, job.threadId);
    const outcome = await driveTurn({ threadId: job.threadId, content, mode, title: job.title, model: job.model || threadModel(job.threadId) });
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
      return `Deleted "${job.title}".`;
    }
    case "run": {
      const job = named();
      await host!.request({ method: "runScheduledJob", params: { jobId: job.id, variables: args.variables ?? "" } });
      return `Started "${job.title}". It runs as its own thread under Scheduled tasks; read it there when it finishes.`;
    }
    case "test": {
      const existing = args.jobId ? named() : undefined;
      const { nodes, errors } = parseWorkflow(args.nodes ?? existing?.nodes ?? "", args.prompt ?? existing?.prompt ?? "");
      if (errors.length) return `That graph will not run:\n${errors.join("\n")}`;
      const run = await runWorkflow(nodes, parseVariables(args.variables ?? existing?.outputs ?? ""), (prompt) => Promise.resolve(`(a turn would run: ${prompt.slice(0, 200)})`));
      return `Dry run — nothing was actually run:\n${describeRun(run.steps)}\n\nVariables afterwards: ${packVariables(run.variables)}`;
    }
    case "save": {
      const existing = args.jobId ? named() : undefined;
      const title = args.title ?? existing?.title;
      const trigger = args.trigger ?? existing?.schedule;
      const prompt = args.prompt ?? existing?.prompt;
      if (!title || !trigger || !prompt) throw new Error("A new task needs a title, a trigger and a prompt. Send all three the first time you save it.");
      const nodes = args.nodes ?? existing?.nodes ?? "";
      const errors = parseWorkflow(nodes, prompt).errors;
      if (errors.length) return `Not saved — the graph will not run:\n${errors.join("\n")}`;
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
      return `${existing ? "Updated" : "Saved"} "${title}" (${saved.id ?? existing?.id}), triggered by ${trigger}. Nothing has run yet — test it, or run it once to see what it does.`;
    }
  }
}

function describeResearchJob(job: ResearchJob): string {
  const budget = (spent: number, limit: number, unit: string) => `${spent}${unit} of ${limit ? `${limit}${unit}` : "unlimited"}`;
  const recent = job.iterations.slice(-5).map((iteration) =>
    `  ${iteration.index}  ${iteration.value ?? "no value"}  ${iteration.outcome}  ${iteration.note}`);
  return [
    `${job.title} (${job.id})`,
    `${job.status} · ${job.projectDir} · ${job.metricName} ${job.direction} is better · ${job.metricKind}`,
    `eval: ${job.evalCommand}`,
    job.prompt ? `brief: ${job.prompt.replace(/\s+/g, " ").slice(0, 400)}` : "no brief",
    `model ${job.proposerModel} · mode ${job.permissionMode} · ${budget(job.spentSeconds, job.maxSeconds, "s")} · ${budget(job.spentTokens, job.maxTokens, " tokens")} · ${budget(job.spentMicroDollars, job.maxMicroDollars, "µ$")}`,
    job.iterations.length ? `${job.iterations.length} iterations:\n${recent.join("\n")}` : "no iterations yet",
  ].join("\n");
}

async function researchTool(args: Extract<ToolArgs, { name: "autoresearch" }>): Promise<string> {
  const jobs = await researchJobs();
  const named = () => {
    const job = jobs.find((candidate) => candidate.id === args.jobId);
    if (!job) throw new Error(args.jobId ? `There is no autoresearch job with the id ${args.jobId}. List them first.` : "Say which job with jobId.");
    return job;
  };
  const setStatus = async (job: ResearchJob, status: "running" | "paused", note: string) => {
    await host!.request({ method: "setResearchJobStatus", params: { jobId: job.id, status, note } });
    if (status === "running") startResearchJob(job.id); else stopResearchJob(job.id);
    changed();
  };
  switch (args.action) {
    case "list":
      return jobs.length ? jobs.map(describeResearchJob).join("\n\n") : "There are no autoresearch jobs yet.";
    case "get":
      return describeResearchJob(named());
    case "delete": {
      const job = named();
      stopResearchJob(job.id);
      await host!.request({ method: "deleteResearchJob", params: { jobId: job.id } });
      changed();
      return `Deleted "${job.title}". Its thread and everything it committed are still there.`;
    }
    case "start": {
      const job = named();
      await setStatus(job, "running", "started by Emma");
      return `Started "${job.title}". Every iteration is a turn on its own thread; the graph and the log are in the Autoresearch section.`;
    }
    case "pause": {
      const job = named();
      await setStatus(job, "paused", "paused by Emma");
      return `Paused "${job.title}" after ${job.iterations.length} iterations. Nothing is lost — starting it again carries on.`;
    }
    case "save": {
      const existing = args.jobId ? named() : undefined;
      const title = args.title ?? existing?.title ?? "";
      const projectDir = args.projectDir ?? existing?.projectDir ?? "";
      const metricName = args.metricName ?? existing?.metricName ?? "";
      const metricKind = args.metricKind ?? existing?.metricKind ?? "";
      const direction = args.direction ?? existing?.direction ?? "";
      const evalCommand = args.evalCommand ?? existing?.evalCommand ?? "";
      const proposerModel = args.proposerModel ?? existing?.proposerModel ?? "";
      if (!title || !projectDir || !metricName || !evalCommand || !proposerModel) throw new Error("A new job needs a title, projectDir, metricName, metricKind, direction, evalCommand and proposerModel. Send them all the first time you save it.");
      if (!["grep", "judge"].includes(metricKind)) throw new Error('metricKind must be "grep" or "judge".');
      if (!["lower", "higher"].includes(direction)) throw new Error('direction must be "lower" or "higher".');
      const metricPrompt = args.metricPrompt ?? existing?.metricPrompt ?? "";
      const prompt = args.prompt ?? existing?.prompt ?? "";
      if (metricKind === "judge" && !metricPrompt) throw new Error("A judge metric needs metricPrompt: the rubric the model scores the output against.");
      const saved = await host!.request({
        method: "saveResearchJob",
        params: {
          ...(existing ? { jobId: existing.id } : {}),
          title,
          projectDir,
          metricName,
          metricKind,
          direction,
          evalCommand,
          proposerModel,
          permissionMode: asPermissionMode(args.permissionMode ?? existing?.permissionMode),
          maxSeconds: String(args.maxSeconds ?? existing?.maxSeconds ?? 0),
          maxTokens: String(args.maxTokens ?? existing?.maxTokens ?? 0),
          maxMicroDollars: String(args.maxMicroDollars ?? existing?.maxMicroDollars ?? 0),
          ...(metricPrompt ? { metricPrompt } : {}),
          ...(prompt ? { prompt } : {}),
        },
      }) as { id?: string };
      changed();
      return `${existing ? "Updated" : "Saved"} "${title}" (${saved.id ?? existing?.id}). Nothing runs until it is started; ${metricName} (${direction} is better) is fixed for the life of the job.`;
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
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  window.on("closed", () => { if (runBanner === window) runBanner = null; });
  void load(window, "run", { threadId, task: task.slice(0, 200), maxSteps: String(MAX_RUN_STEPS) });
}

function closeRunBanner() {
  globalShortcut.unregister("Escape");
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
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
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

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else app.on("second-instance", () => { void app.whenReady().then(openMain); });

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
  startHost();
  fireEvent("launch");
  void host!.request({ method: "snapshot", params: {} }).then(primeGoals).catch(() => undefined);
  capabilities = new ImportedCapabilityRuntime(app.getPath("userData"));
  void seedBuiltinSkills(builtinSkills(), app.getPath("userData"), path.join(app.getPath("userData"), "harness"), ["artifact"]).then(syncHarnessSkills);
  computerRuntime = new ComputerUseRuntime(nativeHelper("emma-computer"), closeRunBanner);
  agents = new AgentRuntime({
    request: (method, params) => answerRequest(method, params),
    ask: (request: PermissionAsk) => {
      const askedAt = Date.now();
      const reached = bridge ? bridge.ask({ ...request, askedAt, expiresAt: askedAt + MAX_ASK_MS }) : false;
      if (!mainWindow || mainWindow.isDestroyed()) {
        if (!reached) answerAsk(request.id, false);
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
    verify: (request, threadId) => {
      const lessons = verifierLessons(threadId);
      return review(lessons ? { ...verifier, system: `${verifier.system}\n\n${lessons}` } : verifier, request);
    },
    advise: (transcript) => advise(toolSettings.advisor, transcript),
    spawnTurn: (turn, owner) => {
      const context = owner ? threadContexts.get(owner) : undefined;
      if (context && !threadContexts.has(turn.threadId)) threadContexts.set(turn.threadId, { ...context });
      return driveTurn(turn);
    },
    changed: () => { broadcast("emma:agents", agents!.list()); broadcast("emma:spans", agents!.spans()); },
    step: (step) => broadcast("emma:step", step),
  });
  bridge = createBridge({
    userData: app.getPath("userData"),
    identity: desktopIdentity,
    dispatch: bridgeDispatch,
    live: bridgeLive,
    onStatus: (status) => broadcast("emma:mobile-status", status),
  });
  bridge.start();
  configureResearch({
    request: (method, params) => answerRequest(method, params),
    turn: (request) => driveTurn(request),
    stopTurn: (threadId) => agents!.stop(threadId),
    run: runCommand,
    attachProject,
    resolve: resolveMentions,
    usage: (threadId) => {
      const run = agents!.list().find((agent) => agent.threadId === threadId);
      return { inputTokens: run?.inputTokens ?? 0, outputTokens: run?.outputTokens ?? 0 };
    },
    catalogFile: path.join(app.getPath("userData"), "openrouter-catalog.json"),
    changed,
  });
  void resumeResearchJobs().catch((error: unknown) => console.error("Emma: could not resume the autoresearch jobs", error));
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
    threadContexts.set(threadId, context);
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
    const request = (value ?? {}) as { id?: unknown; model?: unknown };
    const model = typeof request.model === "string" ? request.model.slice(0, 128).trim() : "";
    return clis.setModel(boundedCapabilityId(request.id, "CLI run"), model);
  });
  ipcMain.handle("emma:installed-clis", (event) => {
    mainWindowSender(event);
    return clis.installed();
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
  ipcMain.handle("emma:live-partial", (event) => {
    mainWindowSender(event);
    return livePartial();
  });
  ipcMain.handle("emma:thread-traces", async (event, value: unknown) => {
    mainWindowSender(event);
    const threadId = boundedCapabilityId(value, "Trace thread");
    const result = await host!.request({ method: "readTrace", params: { threadId } });
    return Array.isArray(result) ? result : [];
  });
  ipcMain.on("emma:answer-permission", (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== mainWindow?.webContents) return;
    if (!value || typeof value !== "object") return;
    const answer = value as Record<string, unknown>;
    if (typeof answer.id !== "string" || typeof answer.allowed !== "boolean") return;
    answerAsk(answer.id, answer.allowed);
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
    const file = boundedCapabilityId(request.path, "Revert path");
    if (typeof request.before !== "string") throw new Error("Only a file Emma rewrote can be reverted here.");
    folders!.write(folderId, file, request.before);
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
  ipcMain.handle("emma:set-verifier", (event, value: unknown) => {
    mainWindowSender(event);
    verifier = validateVerifier(value);
    return verifier;
  });
  ipcMain.handle("emma:set-tagger", (event, value: unknown) => {
    mainWindowSender(event);
    tagger = validateTagger(value);
    return tagger;
  });
  ipcMain.handle("emma:set-zoom", (event, value: unknown) => {
    mainWindowSender(event);
    const zoom = typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_UI_SCALE / 100, Math.max(MIN_UI_SCALE / 100, value)) : 1;
    event.sender.setZoomFactor(zoom);
    return zoom;
  });
  ipcMain.handle("emma:set-tool-settings", (event, value: unknown) => {
    mainWindowSender(event);
    toolSettings = validateToolSettings(value);
    return toolSettings;
  });
  ipcMain.handle("emma:set-harness-experiments", (event, value: unknown) => {
    mainWindowSender(event);
    harnessExperiments = validateHarnessExperiments(value);
    return harnessExperiments;
  });
  ipcMain.handle("emma:set-improvements", (event, value: unknown) => {
    mainWindowSender(event);
    const store = validateImprovements(value);
    setImprovements(applied(store));
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
    shell.showItemInFolder(found);
    return true;
  });
  ipcMain.handle("emma:preview-path", (event, value: unknown) => {
    mainWindowSender(event);
    const found = namedPath(value);
    if (!found) return null;
    const grant = folders!.list().find((folder) => found === folder.path || found.startsWith(folder.path + path.sep));
    const attached = !grant && attachments!.holds(found);
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
    const request = goalIpc(value);
    const objective = boundedGoalText(request.objective, "Goal objective", MAX_GOAL_OBJECTIVE_CHARS, true);
    const budget = wholeGoalNumber(request.tokenBudget, "Goal token budget");
    const thread = await goalRequest("setGoal", { threadId: request.threadId, objective, tokenBudget: String(budget ?? DEFAULT_GOAL_TOKEN_BUDGET) });
    if (thread?.title === DEFAULT_THREAD_TITLE) {
      await host!.request({ method: "renameThread", params: { threadId: request.threadId, title: goalTitle(objective) } }).catch(() => undefined);
      changed();
    }
    return thread;
  });
  ipcMain.handle("emma:update-goal", async (event, value: unknown) => {
    panelSender(event);
    const request = goalIpc(value);
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
        title: "This thread",
        model: threadModel(request.threadId),
      }).catch((error: unknown) => console.error("Emma: a resumed goal could not start", error));
    }
    return updated;
  });
  ipcMain.handle("emma:clear-goal", async (event, value: unknown) => {
    panelSender(event);
    return await goalRequest("clearGoal", { threadId: boundedCapabilityId(value, "Goal thread") });
  });
  ipcMain.handle("emma:list-plans", (event) => {
    panelSender(event);
    return listPlans(app.getPath("userData"));
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
  ipcMain.handle("emma:move-component", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Component request is invalid");
    const request = value as Record<string, unknown>;
    const meta = await setComponentAnchor(app.getPath("userData"), boundedCapabilityId(request.id, "Component"), { selector: request.selector, label: request.label });
    componentsChanged();
    return meta;
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
  ipcMain.on("emma:answer-place", (event, value: unknown) => {
    if (!placeAsk) return;
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== mainWindow?.webContents) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) { placeAsk.settle(undefined); return; }
    const request = value as Record<string, unknown>;
    if (request.id !== placeAsk.id) return;
    if (typeof request.selector !== "string" || !request.selector.trim()) { placeAsk.settle(undefined); return; }
    placeAsk.settle({ selector: request.selector, label: typeof request.label === "string" ? request.label : request.selector });
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
    host?.close();
    host = undefined;
    for (const root of [process.env.EMMA_DATA_DIR || path.join(homedir(), "Library/Application Support/Emma"), app.getPath("userData")]) rmSync(root, { recursive: true, force: true });
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle("emma:open-privacy-settings", async (event, value: unknown) => {
    mainWindowSender(event);
    const url = privacySettingsUrl(value);
    const mac = process.platform === "darwin";
    if (value === "microphone" && mac && await systemPreferences.askForMediaAccess("microphone")) return;
    if (value === "accessibility" && mac) systemPreferences.isTrustedAccessibilityClient(true);
    void shell.openExternal(url);
  });
  ipcMain.handle("emma:pick-vault-folder", async (event): Promise<VaultChoice | null> => {
    mainWindowSender(event);
    const choice = await dialog.showOpenDialog(mainWindow!, { title: "Where should Emma keep your notes?", defaultPath: readVault(app.getPath("userData"))?.root ?? defaultVaultRoot(), buttonLabel: "Keep notes here", properties: ["openDirectory", "createDirectory"] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    pickedVaultRoot = choice.filePaths[0];
    return { root: pickedVaultRoot, folder: DEFAULT_VAULT_FOLDER, kind: "folder", name: path.basename(pickedVaultRoot) || pickedVaultRoot };
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
  ipcMain.handle("emma:read-note", (event, value: unknown) => {
    panelSender(event);
    const vault = readVault(app.getPath("userData"));
    if (!vault) throw new Error("No vault is connected.");
    const file = path.join(noteFolder(vault), noteInVault(vault, value));
    if (!statSync(file).isFile() || statSync(file).size > MAX_NOTE_BYTES) throw new Error("That note cannot be read.");
    return readFileSync(file, "utf8");
  });
  ipcMain.handle("emma:open-in-obsidian", (event, value: unknown) => {
    panelSender(event);
    const vault = readVault(app.getPath("userData"));
    if (!vault) throw new Error("No vault is connected.");
    const relative = noteInVault(vault, value);
    if (vault.kind === "obsidian") void shell.openExternal(obsidianOpenUrl(vault, relative));
    else shell.showItemInFolder(path.join(noteFolder(vault), relative));
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
    return await gitSnapshot(folders!.directory(boundedCapabilityId(value, "Folder")));
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
    return bridge!.status();
  });
  ipcMain.handle("emma:mobile-pair", async (event, value: unknown) => {
    mainWindowSender(event);
    const relay = relayOrigin(process.env.EMMA_RELAY_URL || value);
    if (!relay) throw new Error("Set the address of your own relay in Settings → Mobile before pairing a phone.");
    return await bridge!.pair(relay);
  });
  ipcMain.handle("emma:mobile-cancel-pair", (event) => {
    mainWindowSender(event);
    bridge!.cancelPair();
    return bridge!.status();
  });
  ipcMain.handle("emma:mobile-unpair", (event) => {
    mainWindowSender(event);
    bridge!.unpair();
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
      const grant = file && folders!.list().some((folder) => file === folder.path || file.startsWith(folder.path + path.sep));
      if (!file || (!grant && !attachments!.holds(file))) throw new Error("That file is not open to Emma.");
      await openInEditor(editorId, file);
      return;
    }
    const folderId = boundedCapabilityId(request.folderId, "Folder");
    const root = folders!.directory(folderId);
    const relative = folders!.within(folderId, boundedCapabilityId(request.path, "File path"));
    await openInEditor(editorId, path.join(root, relative));
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
  ipcMain.handle("emma:detect-connections", (event) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== mainWindow?.webContents) throw new Error("Connection discovery sender is not allowed");
    return detectConnections();
  });
  ipcMain.handle("emma:outdated-connections", (event) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== mainWindow?.webContents) throw new Error("Connection discovery sender is not allowed");
    return outdatedConnections();
  });
  ipcMain.handle("emma:set-up-connection", (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== mainWindow?.webContents) throw new Error("Connection setup sender is not allowed");
    const request = (value ?? {}) as Record<string, unknown>;
    if (!isConnectionId(request.id) || (request.action !== "install" && request.action !== "upgrade")) throw new Error("Connection setup request is invalid");
    return setUpConnection(request.id, request.action);
  });
  ipcMain.handle("emma:import-agent-sources", async (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== mainWindow?.webContents || !Array.isArray(value) || value.length > 8 || value.some((id) => typeof id !== "string")) throw new Error("Import selection is invalid");
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
  ipcMain.handle("emma:capability-usage", async (event) => {
    mainWindowSender(event);
    const usage = await readUsage(app.getPath("userData"));
    const [skills, servers] = await Promise.all([capabilities!.searchSkills("", MAX_SKILL_RESULTS), capabilities!.listMcpServers()]);
    return {
      skills: skills.filter((skill) => skill.source !== "installed").map((skill) => ({ id: skill.id, name: skill.name, source: skill.source, days: usage[skillKey(skill.id)] ?? {} })),
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
      setConnections(overlayPreferences.connections ?? []);
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
    return applyKeybinds(validateKeybinds(value));
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
app.on("will-quit", () => {
  bridge?.stop();
  globalShortcut.unregisterAll();
  clearTimeout(hotspotTimer);
  hotkeyHelper?.kill();
  computerRuntime?.abort("app quit");
  background.stopAll();
  clis.stopAll();
  browsers.stopAll();
  terminals.stopAll();
  skillAttachment.clearAll();
  for (const client of harnesses.values()) client.close();
  harnesses.clear();
  host?.close();
});
