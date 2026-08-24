import { app, BrowserWindow, dialog, globalShortcut, ipcMain, nativeImage, Notification, protocol, screen, session, shell, systemPreferences } from "electron";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { externalUrl, publicUrl, runCommandRequest, trustedSender, validJpegDataUrl, validateRequest } from "./ipc";
import { renderResults, webSearch } from "./web-search";
import { clipPage, fetchReadablePage, frontmostApplication, frontmostPage, frontmostTab } from "./clip";
import { discoverImports, saveImportManifest } from "./imports";
import { loadUiPlugins } from "./plugins";
import { hotspotLayout, nearBounds, overlayGrowth, overlayLayout, parseNotchGeometry, pillLayout, popoutLayout, type NotchGeometry } from "./overlay";
import { BoundedLines, parseHostLine, recordedTurn, type HostDueJob, type RecordedTurn } from "./ndjson";
import { describeRun, packVariables, parseVariables, parseWorkflow, runWorkflow, type WorkflowNode } from "../shared/workflow";
import { ImportedCapabilityRuntime, MAX_SKILL_RESULTS, SkillAttachmentStore, harnessMcpServers as readHarnessMcpServers, listEmmaTools, mirrorSkillsToHarness, seedBuiltinSkills, writeEmmaTool, writeLearnedSkill } from "./capabilities";
import { addMarketplace, installPlugin, pluginDetail, readCatalog, refreshMarketplace, removeMarketplace, runPluginHooks, trustPluginHooks, uninstallPlugin, writePlugin } from "./marketplace";
import { artifactFiles, deleteArtifact, listArtifacts, queryArtifact, readArtifact, readArtifactFile, updateArtifact, updateArtifactFile, writeArtifact, writeArtifactFile } from "./artifacts";
import { ARTIFACT_SCHEME, artifactFileType, artifactMarker, MODULE_PATH } from "../shared/artifacts";
import { deletePlan, editPlan, listPlans, readPlan, writePlan } from "./plans";
import { mergePlan, parsePlanSteps, planProblems, planProgress, readySteps, renderPlan, stepBrief, type Plan } from "../shared/plan";
import { VISUAL_MARKER } from "../shared/visualize";
import { CredentialStore } from "./credentials";
import { FolderStore } from "./folders";
import { AttachmentStore, isImageAttachment, type Attachment } from "./attachments";
import { defaultKnowledgeDir, knowledgeDirWritable, readKnowledgeDir, saveKnowledgeDir } from "./setup";
import { isRawClip, pageForUrl, type SavedPage } from "../shared/knowledge";
import { privacySettingsUrl, type SetupStatus } from "../shared/setup";
import { CatalogCache, fetchOpenRouterCatalog } from "./catalog";
import { addWorktree, gitSnapshot, mainCheckout, switchBranch } from "./git";
import { installedEditors, openInEditor } from "./editors";
import { transcribe, validateUtterance, validateVoiceSettings, voiceStatus } from "./voice";
import { configureResearch, researchJobs, resumeResearchJobs, startResearchJob, stopResearchJob, type ResearchJob } from "./research";
import { contextBlock, MAX_FILE_BYTES, mergeSkillContext } from "../shared/folders";
import { mentions, pathName } from "../shared/slash";
import { captureDisplay, compressScreenFrame, ComputerUseRuntime, MAX_RUN_STEPS } from "./computer";
import { defaultHarnessExperiments, defaultSettings, defaultToolSettings, defaultVerifier, FREE_ROUTER_KEY, freeRouterChain, holdBindings, isCursorCommand, isEnvName, isThinkingLevel, isKeybindAction, keybindCommands, normalizeLocalModelEndpoint, OPENROUTER_CHAT_ENDPOINT, validateKeybinds, validateOverlayPreferences, validateHarnessExperiments, validateTagger, validateToolSettings, validateVerifier, type Keybind, type KeybindAction, type Keybinds, type HarnessExperiments, type OverlayPreferences, type ThinkingLevel, type ToolSettings, type VerifierSettings } from "../shared/settings";
import { authorKnowledgePage, authorPageFromThread, pageTurnContext, proposePageRevision, type AuthorRoute, type PageStore } from "./knowledge-author";
import { applied, validateImprovements } from "../shared/improvement";
import { frontApplicationNote, ScreenContextStore, type FrontApplication } from "../shared/screen-context";
import { AgentRuntime, lastAssistantMessage, OWN_TOOLS, type TurnRequest } from "./agent-loop";
import { BackgroundCommands } from "./background";
import { CliRuns } from "./cli";
import { cliHarness, describeRuns } from "../shared/cli";
import { setConnections, setImprovements, setPrompts, setSystemPrompt, verifierLessons, withTrialArm, writeHarnessPrompt } from "./system-prompt";
import { detectConnections, isConnectionId, outdatedConnections, setUpConnection } from "./connections";
import { Harness, describePath, failedTurn, harnessKey, type HarnessMcpServer, type HarnessToolCall, type ThinkingRoute } from "./harness";
import { review } from "./verifier";
import { advise } from "./advisor";
import { look } from "./vision";
import { MAX_TAGGER_TEXT_CHARS, MAX_THREAD_TAGS, tagThread } from "./tagger";
import { runMemoryCommand } from "./memory";
import { browserArgv, BROWSER_NAVIGATIONS, describeToolCall, MAX_CLI_PROMPT_CHARS, parseToolArgs, shellQuoted, toolNeeds, type ToolArgs } from "./tools";
import { Browsers, type BrowserStatus } from "./browser";
import { Terminals } from "./terminal";
import { MAX_TERMINAL_COLUMNS, MAX_TERMINAL_INPUT } from "../shared/terminal";
import { asPermissionMode, DEFAULT_PERMISSION_MODE, toolGate, type PermissionMode } from "../shared/permissions";
import { editStat, MAX_LIVE_SUBAGENTS, type FileChange, type PermissionAsk, type SubagentRoute } from "../shared/agents";

// ponytail: whole snapshots cap at 16 MiB; paginate the host protocol before raising it.
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
        // Nothing asked for this line, the clock did, so it starts a turn here
        // rather than resolving one: a job is a full agent run under its saved mode.
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
/** Started at import: nothing in it until a turn asks for a background command. */
const background = new BackgroundCommands(() => broadcast("emma:background"));
/** The other coding CLIs, and what Emma has running in them. Same deal — empty until asked. */
const clis = new CliRuns(() => broadcast("emma:cli-runs"));
const browsers = new Browsers(() => broadcast("emma:browser"));
const terminals = new Terminals(
  () => nativeHelper("emma-pty"),
  (id, data, at) => broadcast("emma:terminal-data", { id, data, at }),
  () => broadcast("emma:terminals"),
);
let runBanner: BrowserWindow | null = null;
/**
 * What the composer has set for a thread: the folders it works out of, the mode
 * its picker is on, and the model name to show on an agent's tab. Mirrored here
 * because the loop gates tools on it, and only main's copy is ever trusted.
 */
const threadContexts = new Map<string, { folderIds: string[]; mode: PermissionMode; model: string; subagent?: SubagentRoute }>();
const threadFolderIds = (threadId: string) => threadContexts.get(threadId)?.folderIds ?? [];
/**
 * A folder the agent asked for and the user picked, attached mid-turn. Main's
 * copy is updated first so the very next step of the loop already advertises
 * the filesystem tools, and the composer is told because it owns the list it
 * pushes back — without this the next context push would detach the folder the
 * user just chose.
 */
/**
 * A path as the model wrote it, turned into a file that is actually there:
 * `~` expands, and a relative path is tried under each granted folder rather
 * than under the process working directory, which is nowhere the user knows.
 */
function namedPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 1024) throw new Error("That path is invalid");
  const raw = value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
  const candidates = path.isAbsolute(raw) ? [raw] : folders!.list().map((grant) => path.join(grant.path, raw));
  return candidates.find((candidate) => existsSync(candidate));
}

/** Grants a directory and attaches it, which is how an autoresearch turn is pointed at its project. */
function attachProject(threadId: string, directory: string) {
  const resolved = realpathSync(directory);
  const grant = folders!.add(resolved).find((folder) => folder.path === resolved);
  if (!grant) throw new Error(`Emma could not open ${directory} as a folder`);
  attachFolder(threadId, grant.id);
}

function attachFolder(threadId: string, folderId: string) {
  const context = threadContexts.get(threadId) ?? { folderIds: [], mode: DEFAULT_PERMISSION_MODE, model: "" };
  // Replaces rather than appends: a thread works in one directory, and that
  // directory is the harness process's cwd. A second folder beside it could only
  // be reached by the bridged tools, never by the CLI, so attaching one would
  // hand the model a filesystem half its tools cannot see.
  if (context.folderIds[0] !== folderId) threadContexts.set(threadId, { ...context, folderIds: [folderId] });
  broadcast("emma:folder-attached", { threadId, folderId });
  changed();
}
const skillAttachment = new SkillAttachmentStore();
/** One harness process per workspace directory; see `HarnessDeps.cwd` for why. */
const harnesses = new Map<string, Harness>();
/** What the harness has said this turn, so the finished answer can be recorded. */
const harnessText = new Map<string, string>();
/** And what it reasoned, kept apart so the answer is not buried in the scratchpad. */
const harnessThought = new Map<string, string>();
/** Harness subagents in flight, by the Emma thread each was given. */
const harnessChildren = new Map<string, { childId: string; title: string; startedAt: number; client: Harness }>();
const stopThread = (threadId: string) => {
  agents?.stop(threadId);
  const child = harnessChildren.get(threadId);
  if (child) { void child.client.cancelChild(child.childId).catch(() => undefined); return; }
  for (const harness of harnesses.values()) void harness.cancel(threadId);
};
let hotkeyHelper: ChildProcess | undefined;
let mainWindow: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let annotation: BrowserWindow | null = null;
let annotationFrame: { image: string; width: number; height: number } | null = null;
/** Who owned the screen under the strokes, read while the drawing sheet was hidden. */
let annotationSource: FrontApplication | undefined;
let annotationDisplay: Electron.Display | null = null;
const annotationAttachment = new ScreenContextStore();
let annotating = false;
let capturing = false;
let overlayPreferences: OverlayPreferences = { notchGap: defaultSettings.notchGap, cursorOrbsEnabled: defaultSettings.cursorOrbsEnabled, notchConcurrency: defaultSettings.notchConcurrency };
/** Auto mode's reviewer, as Settings last saved it. Its key is read from the env at call time. */
let verifier: VerifierSettings = defaultVerifier;
/** Settings → Tools, as it last saved: what is switched off, and how the configurable tools are set up. */
let toolSettings: ToolSettings = defaultToolSettings;
/** Settings → Harness: the experimental context hooks, all off until that page turns one on. */
let harnessExperiments: HarnessExperiments = defaultHarnessExperiments;

/* Emma writes her own tools and skills and installs her own MCP servers, so the
   set Settings → Tools is switching is not fixed at launch. Every path that adds
   one says so here, and the page re-reads rather than waiting for a relaunch. */
const toolsChanged = () => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("emma:tools-changed");
  for (const client of harnesses.values()) client.rebindServers();
  // A skill written or switched off now should be in the harness's catalog for
  // the next turn, not the next launch.
  syncHarnessSkills();
};
/** The Artifacts page re-reads on this. Its own channel: `emma:changed` is the thread library's, and an artifact is not one. */
const artifactsChanged = () => broadcast("emma:artifacts-changed");
/** The plan widget re-reads on this — every tick of every subagent in a wave lands on it. */
const plansChanged = () => broadcast("emma:plans-changed");
let overlayPreferencesReady = false;
/** A toggle asked for before the renderer had sent its preferences, with the command it carried. */
let queuedOverlayToggle: { command?: string } | null = null;
let overlayBusy = false;
/** Read once as the notch opens, then attached to every turn asked from it. */
let overlayFront: Promise<string> = Promise.resolve("");
let closeOverlayWhenIdle = false;
let notches: NotchGeometry[] = [];
let hotspot: BrowserWindow | null = null;
let hotspotKey = "";
let hotspotTimer: ReturnType<typeof setInterval> | undefined;
/** How far from the housing the sliver is built. It paints in ~113 ms; this is the travel that covers it. */
const HOTSPOT_WARM = 220;
let radial: BrowserWindow | null = null;
let overlayBaseHeight = 0;
const RADIAL_SIZE = 260;
/** Where Quick Ask is: wrapped around the housing, collapsed to its status chip, or hung off that chip. */
let overlaySurface: "notch" | "pill" | "popout" = "notch";
/** The spot the user dragged the chip to, kept for the rest of the session so it stays put. */
let pillSpot: { x: number; y: number } | undefined;
/** The height the island last claimed, so reopening from the chip is the size it collapsed from. */
let overlayGrow = 0;

const preload = path.join(__dirname, "preload.js");
const renderer = path.join(app.getAppPath(), "dist-renderer/index.html");

/** Where each child binary is built, which is not where it is shipped. */
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

/** The skills shipped in the bundle, seeded into Emma's own skill root at launch. */
function builtinSkills() {
  return app.isPackaged ? path.join(process.resourcesPath, "skills") : path.join(app.getAppPath(), "skills");
}

// The camera housing is not in Electron's display record, so ask AppKit for it.
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
  // stdin carries the hold bindings the listener watches for; stdout carries what it saw.
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

/** Accelerators this process currently holds, so a re-bind releases exactly what it took. */
const registeredKeybinds = new Set<string>();
/** Kept so a listener that died and came back is told about the holds again. */
let keybinds: Keybinds = {};

function runKeybindAction(action: string) {
  if (!isKeybindAction(action)) return;
  if (action === "toggle") toggleOverlay();
  else runOverlayCommand(keybindCommands[action]);
}

/**
 * Takes the user's shortcuts system-wide, and reports the ones the OS refused so the
 * settings page can say which are already spoken for. Escape is left alone: it belongs
 * to the run banner's kill switch, which registers and releases it around a live run.
 *
 * Chords are Electron's to register. Holds are not — a global shortcut is only told
 * about the key going down — so those go to the native listener that is already
 * watching for the double-tap.
 */
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

/** Hands the island a command, opening it first when it is closed. */
function runOverlayCommand(command: string) {
  if (overlay && !overlay.isDestroyed()) {
    closeRadial();
    overlay.webContents.send("emma:quick-command", command);
    overlay.focus();
    return;
  }
  toggleOverlay(command);
}

/**
 * What every surface that is not the workspace is made of.
 *
 * An NSPanel is the macOS window that can take key input while another app stays
 * frontmost. That is the whole difference between "the notch opened" and "Emma
 * opened": a normal window cannot be shown or focused without activating the
 * application, and an activated application raises all of its windows.
 */
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
  // loadURL resolves on the load event, which is before the renderer has necessarily
  // laid out at the window's real size — showing there sometimes reveals a frame
  // measured against the wrong viewport, and only a manual resize re-syncs it.
  // ready-to-show is Chromium saying it has a frame for the current bounds. The
  // timeout is the safety net: a window that never becomes ready still has to appear.
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
    // Only the workspace is allowed to bring Emma to the front. Showing a normal
    // window on macOS activates the whole application, and activating it raises
    // every window it owns — which is why the Quick Ask shortcut used to drag the
    // workspace in front of whatever the user was working in. The surfaces that
    // hang off the notch are panels (see `floating`), so `showInactive` puts them
    // on screen where they are and `focus` gives them the keyboard without the
    // app ever coming forward.
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
  // Vibrancy is for the sidebar alone: the titlebar and the content column paint
  // themselves opaque, so the only place the OS blur reaches the glass is the nav
  // pane — the Finder sidebar shape, not a whole glass window. A zero-alpha
  // backgroundColor is what lets it through; the frame itself stays normal, so
  // hiddenInset and the window shadow are untouched. Ignored off macOS, where the
  // opaque default background stands in. See --chrome in styles/tokens.css.
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
  void load(mainWindow);
}

/**
 * A turn has stopped and cannot go on until the user answers. Raises the window
 * if it is hidden, as every one of these sites already did, and posts a system
 * notification when Emma is not the app being looked at.
 *
 * The notification is the whole point of the raise being conditional: a question
 * that only ever appeared inside a window behind three other apps was a question
 * nobody saw, and it sat there until the ask timed out and declined itself.
 * Nothing is posted when the window already has focus — the dialog is on screen.
 */
function needsYou(title: string, body: string) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Read before showing: `show()` takes focus on macOS, and would then look like
  // a window the user had been watching all along.
  const watching = mainWindow.isFocused();
  if (!mainWindow.isVisible()) mainWindow.show();
  if (watching || !Notification.isSupported()) return;
  const note = new Notification({ title, body });
  // A click on the banner does not bring the app forward on its own, the same
  // reason restoreOverlay has to steal focus back from a sheet.
  note.on("click", () => {
    if (process.platform === "darwin") app.focus({ steal: true });
    openMain();
  });
  // Notifications are a permission of their own, and one Emma cannot ask for
  // twice: denied, or an unsigned dev build macOS never prompted for, and the
  // banner is dropped with no sign of it. A critical dock bounce needs no
  // authorisation and keeps bouncing until the app is activated, which is what
  // a turn waiting on an answer wants anyway.
  note.on("failed", () => app.dock?.bounce("critical"));
  note.show();
}

/** Raises the workspace on a settings page. A window that has to be built is told once it can hear. */
function openSettingsPage(page: string) {
  const fresh = !mainWindow;
  openMain();
  const window = mainWindow!;
  if (fresh) window.webContents.once("did-finish-load", () => { if (!window.isDestroyed()) window.webContents.send("emma:open-settings", page); });
  else window.webContents.send("emma:open-settings", page);
}

/** The same gate `emma:request` uses: the main frame of one of Emma's own windows. */
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

/**
 * Leaving the notch mid-turn does not take the turn with it. The window shrinks to a
 * chip the user can park anywhere, still carrying the run's status — the renderer
 * that owns the request stays alive inside it, which is the whole point of not
 * closing, and now it has a face while it works.
 */
function collapseToPill(window: BrowserWindow) {
  if (window.isDestroyed()) return;
  const bounds = pillLayout(screen.getDisplayMatching(window.getBounds()), pillSpot);
  pillSpot = { x: bounds.x, y: bounds.y };
  overlaySurface = "pill";
  window.setBounds(bounds);
  window.webContents.send("emma:overlay-surface", "pill");
  // The ring is the island's own context menu, opened at the cursor with it. A chip
  // parked in a corner has nothing for it to hang off, so it goes with the island.
  closeRadial();
}

/** The chip, clicked: the island opens where it stands rather than back at the housing. */
function expandPill(window: BrowserWindow) {
  if (window.isDestroyed()) return;
  const layout = popoutLayout(screen.getDisplayMatching(window.getBounds()), window.getBounds(), overlayGrow);
  overlaySurface = "popout";
  overlayBaseHeight = layout.base;
  window.setBounds(layout.bounds);
  window.webContents.send("emma:overlay-surface", "popout");
  window.focus();
}

/** Escape, or the pointer landing in another app: an idle notch closes, anything else parks. */
function leaveOverlay(window: BrowserWindow) {
  if (overlaySurface === "notch" && !overlayBusy) closeOverlay(window);
  else collapseToPill(window);
}

/**
 * The shortcut pressed while a quick turn is still running. By default the island
 * comes back empty and the next ask is a task of its own — the running one keeps
 * going in main and lands in its own thread, which is where the workspace reads it.
 * Settings → Notch switches this to carrying on inside the running thread instead.
 */
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
    // Off the housing the shortcut works the chip: it opens the island where the chip
    // stands, and folds it back into the chip. Reopening at the notch is what the next
    // Quick Ask does, once this one has finished and cleared itself away.
    if (overlaySurface === "pill") { newQuickSession(overlay); expandPill(overlay); return; }
    if (overlaySurface === "popout") { collapseToPill(overlay); return; }
    // Closing mid-turn only hides the window, so the run keeps its renderer. Opening
    // again brings that same window back rather than toggling it shut a second time
    // — the quick thread, its transcript and the turn still streaming into it are all
    // in there, and destroying it to build a fresh one is what lost them.
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
  // Started before the window exists: once the overlay has the keyboard, the app in
  // front is Emma, and the answer to "what was I looking at" is gone.
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
  // The surface hangs off the camera housing, so it has to sit above the menu bar.
  window.setAlwaysOnTop(true, "screen-saver");
  // Without skipTransformProcessType this call demotes Emma to an accessory app, which
  // costs the main window its Dock icon and its Cmd-Tab entry.
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
  // The command rides the query rather than an IPC message: the island runs it on mount,
  // so it cannot be sent into a renderer that has not subscribed yet.
  void load(window, "overlay", { notchLeft: String(layout.notch.left), notchWidth: String(layout.notch.width), notchHeight: String(layout.notch.height), ...(command ? { command } : {}) });
  if (overlayPreferences.cursorOrbsEnabled && !command) openRadial(display);
}

/** Commands orbit the cursor where the double-tap happened, so context is one flick away. */
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
  // Without skipTransformProcessType this call demotes Emma to an accessory app, which
  // costs the main window its Dock icon and its Cmd-Tab entry.
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

/**
 * A transparent sliver over the camera housing. It stays click-through until the cursor
 * reaches the housing, so the menu bar keeps working while Emma is idle.
 *
 * The window only exists while the cursor is near the housing. A renderer process costs
 * ~80 MB whatever it draws — measured, and unmoved by any Chromium flag — and this one
 * draws a hover hint that nobody is looking at most of the time. Hover was never the
 * window's to detect: the poll below has always run here in main, so letting it own the
 * window's lifetime too costs nothing and gives the whole process back when Emma is idle.
 */
function openHotspot() {
  const display = screen.getPrimaryDisplay();
  const notch = notches.find((item) => item.id === display.id);
  const key = notch ? [display.id, display.bounds.y, notch.x, notch.width, notch.height].join(":") : "";
  if (key === hotspotKey) return;
  hotspotKey = key;
  clearInterval(hotspotTimer);
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
    // Without skipTransformProcessType this call demotes Emma to an accessory app, which
    // costs the main window its Dock icon and its Cmd-Tab entry.
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    window.setIgnoreMouseEvents(true, { forward: true });
    window.on("closed", () => { if (hotspot === window) hotspot = null; });
    // The poll may have decided the cursor is on the housing before this renderer
    // existed to be told, so the state it missed is replayed once it can hear it.
    window.webContents.once("did-finish-load", () => {
      if (window.isDestroyed()) return;
      window.setIgnoreMouseEvents(!hovering, { forward: true });
      window.webContents.send("emma:notch-hover", hovering);
    });
    void load(window, "hotspot", { notchLeft: String(layout.notch.left), notchWidth: String(layout.notch.width), notchHeight: String(layout.notch.height) });
  };
  // ponytail: 120 ms cursor poll; swap in a native NSTrackingArea only if it ever shows up in Activity Monitor.
  hotspotTimer = setInterval(() => {
    const point = screen.getCursorScreenPoint();
    // The island covers the housing while it is open and takes the hover with it.
    if ((overlay && !overlay.isDestroyed()) || !near(point, HOTSPOT_WARM)) {
      hovering = false;
      closeHotspot();
      return;
    }
    if (!hotspot) build();
    const inside = near(point, 0);
    if (inside === hovering) return;
    hovering = inside;
    if (hotspot && !hotspot.isDestroyed()) {
      hotspot.setIgnoreMouseEvents(!inside, { forward: true });
      hotspot.webContents.send("emma:notch-hover", inside);
    }
  }, 120);
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// The annotation renderer composites the frame and strokes; nativeImage cannot decode SVG.
function composeScreenContext(annotated: unknown) {
  if (!annotationFrame) throw new Error("Annotated screen frame is unavailable");
  if (!validJpegDataUrl(annotated)) throw new Error("Annotated screen is invalid");
  return compressScreenFrame(nativeImage.createFromDataURL(annotated)).image;
}

function restoreOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.show();
  // The sheet handed focus back to whatever was behind it, so Emma has to take it: an
  // overlay that arrives already blurred closes itself, taking the capture with it.
  if (process.platform === "darwin") app.focus({ steal: true });
  overlay.focus();
  sendScreenContext();
}

/** The capture lands while the overlay is hidden, so its arrival is pushed, not polled. */
function sendScreenContext() {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send("emma:screen-context", annotationAttachment.status());
}

/** Emma is never the answer: the capture is about the app the user was actually in. */
async function frontApplication(): Promise<FrontApplication | undefined> {
  if (process.platform !== "darwin") return undefined;
  const source = await frontmostApplication().catch(() => undefined);
  return source?.application && ![app.getName(), "Electron"].includes(source.application) ? source : undefined;
}

/**
 * What the user was looking at when the notch opened, in one sentence. Read before
 * the overlay takes the keyboard, so it is still their app in front and not Emma.
 *
 * This is what makes "save this to my kb" work without a screenshot: "this" is a
 * URL the model can hand straight to `save_page`, and a video it can name.
 */
async function frontContextNote(): Promise<string> {
  const front = await frontApplication();
  if (!front) return "";
  const tab = await frontmostTab(front.application).catch(() => undefined);
  // A browser window is titled after its tab, so naming both says the same thing twice.
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

/// Credentials land in this process's own environment as well as the host's: main makes the
/// provider calls now, and `authorRoute` reads the key straight back out of `process.env`.
function startHost() {
  host?.close();
  credentials!.applyToEnv(process.env);
  // The host reads the mirror's folder from its spawn environment, so the walkthrough's
  // choice only lands on a fresh host — the same reason a pasted key needs one.
  process.env.EMMA_KNOWLEDGE_DIR = readKnowledgeDir(app.getPath("userData"));
  host = new Host(binary("emma-host"));
}

/** One of Emma's own windows, rather than anything a page managed to open. */
function ownWindow(contents: Electron.WebContents | null): boolean {
  return !!contents && trustedSender(contents.getURL(), app.getAppPath(), process.env.EMMA_DEV_SERVER_URL);
}

function pageMayAsk(contents: Electron.WebContents | null, permission: string, kinds: string[]): boolean {
  if (!ownWindow(contents)) return false;
  // Every copy button in the app goes through navigator.clipboard, which is a
  // permission — and one Chromium sanitizes and never lets a page read back.
  if (permission === "clipboard-sanitized-write") return true;
  return permission === "media" && kinds.length > 0 && kinds.every((kind) => kind === "audio");
}

function setupStatus(): SetupStatus {
  const knowledgeDir = readKnowledgeDir(app.getPath("userData"));
  const mac = process.platform === "darwin";
  return {
    accessibility: !mac || systemPreferences.isTrustedAccessibilityClient(false),
    screen: !mac || systemPreferences.getMediaAccessStatus("screen") === "granted",
    microphone: !mac || systemPreferences.getMediaAccessStatus("microphone") === "granted",
    speech: mac ? null : true,
    automation: mac ? null : true,
    notifications: Notification.isSupported() ? (mac ? null : true) : false,
    files: knowledgeDirWritable(knowledgeDir),
    knowledgeDir,
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

/** The workspace or the island: both frame the panels Emma mounted into herself,
    and a panel in the notch has to read the folder and its own rows like any other. */
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

/** A follow-up turn typed into a run's tab. Bounded to what the `cli` tool accepts. */
function cliSendRequest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CLI send request is invalid");
  const candidate = value as Record<string, unknown>;
  const id = boundedCapabilityId(candidate.id, "CLI run");
  if (typeof candidate.prompt !== "string" || !candidate.prompt.trim() || candidate.prompt.length > MAX_CLI_PROMPT_CHARS) throw new Error("CLI send request is invalid");
  return { id, prompt: candidate.prompt };
}

// ponytail: substring match on the first long words in the task. Swap in real ranking
// once there are enough learned skills for the first hit to be the wrong one.
async function bestLearnedSkill(task: string) {
  for (const word of task.toLowerCase().match(/[a-z0-9]{4,}/g)?.slice(0, 8) ?? []) {
    const [match] = await capabilities!.searchSkills(word, 1);
    if (match) return capabilities!.selectSkill(match.id).catch(() => undefined);
  }
  return undefined;
}

/** A learned skill, as the extra `sendMessage` params a turn carries. */
async function skillParams(task: string): Promise<Record<string, string>> {
  const skill = await bestLearnedSkill(task);
  return skill ? { skillContext: skill.instructions } : {};
}

/**
 * What a thread may do. Unknown threads fall back to the default rather than to the
 * last thread's pick, so a mode chosen in one thread never leaks into another.
 */
function threadMode(threadId: string): PermissionMode {
  return threadContexts.get(threadId)?.mode ?? DEFAULT_PERMISSION_MODE;
}

const threadModel = (threadId: string) => threadContexts.get(threadId)?.model ?? "";
const threadSubagent = (threadId: string) => threadContexts.get(threadId)?.subagent;

/**
 * The route this thread's subagents take, as the inspector set it.
 *
 * Only an OpenRouter model can be routed per subagent — the host carries one
 * provider profile and overrides its model per thread, and a local profile is a
 * whole other endpoint and key. Anything else lands as "" and the subagent runs
 * on whatever the thread itself is on.
 */
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
  // One thread, one directory — clamped here because this is the only door the
  // renderer has onto it. Everything downstream still takes a list, it just never
  // holds more than the folder the CLI is running in.
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

function reportRunProgress(step: number, action: string, actions: number) {
  if (runBanner && !runBanner.isDestroyed()) runBanner.webContents.send("emma:computer-run-progress", { step, action, actions });
}

function broadcast(channel: string, payload?: unknown) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

const CHANGED_COALESCE_MS = 150;
const READ_ONLY_METHODS = new Set(["snapshot", "listOpenRouterModels", "listPageVersions", "readPageAsset"]);
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

/**
 * The one directory this thread works in, or nothing when it has none.
 *
 * A thread is bound to a single folder: it is the working directory `emma-cli` is
 * spawned in, and the harness takes its workspace root from that cwd once at
 * startup. A second folder attached beside it would be reachable through Emma's
 * own tools and invisible to every tool the CLI runs itself — so there is no
 * second folder, and this is the one answer both sides read.
 */
function threadFolder(threadId: string): string | undefined {
  const [id] = threadFolderIds(threadId);
  return id && folders!.list().some((grant) => grant.id === id) ? id : undefined;
}

/** Which folder a call means: this thread's, and a name that is not it is refused. */
function grantFor(threadId: string, named: string | undefined): string {
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

/** An attachment as the composer draws it: a picture also carries a chip-sized preview. */
function held(attachment: Attachment): Attachment & { thumbnail?: string } {
  if (!isImageAttachment(attachment.name)) return attachment;
  const frame = nativeImage.createFromPath(attachment.path);
  // A file named .png that is not one is still attached; the chip just has
  // nothing to show, and the vision tool is what will say so.
  // Twice the 56px tile: the composer draws these on a Retina panel, and a thumbnail
  // at its own CSS size is the one soft thing in an interface of 1px rules.
  return frame.isEmpty() ? attachment : { ...attachment, thumbnail: frame.resize({ height: 112 }).toDataURL() };
}

/** Wide enough to fill the preview on a Retina panel, and short of the point where
    the base64 of a phone photo costs more to cross than the picture shows. */
const PREVIEW_IMAGE_WIDTH = 1600;

/** A picture for the preview modal, drawn rather than quoted as bytes. */
function previewImage(file: string): string | null {
  const frame = nativeImage.createFromPath(file);
  if (frame.isEmpty()) return null;
  return (frame.getSize().width > PREVIEW_IMAGE_WIDTH ? frame.resize({ width: PREVIEW_IMAGE_WIDTH }) : frame).toDataURL();
}

/**
 * An image the `vision` tool names, as a data URL the second model will accept.
 *
 * Decoded and re-encoded rather than read and base64'd: it is the same squeeze a
 * screen capture goes through, so a 12-megapixel photo arrives as a JPEG the
 * route will take, and a file that is not an image at all fails here — with a
 * sentence the model can act on — instead of at the provider.
 */
function folderImage(threadId: string, named: string | undefined, relative: string): string {
  // A file the user attached to a message is theirs to show, and the block that
  // attached it gave the model the absolute path to name. Anything else has to
  // be inside the folder this thread works in.
  const grant = attachments!.holds(relative) ? undefined : grantFor(threadId, named);
  const frame = nativeImage.createFromPath(grant ? path.join(folders!.directory(grant), folders!.within(grant, relative)) : relative);
  if (frame.isEmpty()) throw new Error(`Emma could not read ${relative} as an image. PNG, JPEG, GIF and BMP work; a PDF, an SVG or a missing file does not.`);
  try {
    return compressScreenFrame(frame).image;
  } catch {
    throw new Error(`${relative} could not be shrunk small enough to send. Save a smaller copy and look at that.`);
  }
}

/** The computer tool needs a live run for its ceilings and its kill switch. */
async function ensureComputerRun(threadId: string, task: string) {
  if (computerRuntime!.active) return;
  computerRuntime!.start(threadId);
  openRunBanner(threadId, task);
  await computerRuntime!.screenshot();
}

/**
 * "Add this page to my kb", done: clip the page and store it, then let the document
 * build follow. The same steps the overlay's ⌘-page button runs, reachable from a
 * sentence instead of a button.
 *
 * Unfiled is the holding pen core reserves (`UNFILED_CATEGORY` in `live.rs`); the
 * analysis that follows replaces it with a real category.
 *
 * The build does not happen inside this call. It is a model turn over the whole clip
 * — minutes, not seconds — and held open it blew the tool call's deadline: the agent
 * read a timeout, saved again, and the board ended up with two raw clips of one page.
 * So the answer comes back with the clip stored, and the document lands after it.
 */
async function savePage(threadId: string, url?: string, existing?: string): Promise<string> {
  const front = url ? { application: "", url } : await frontmostPage();
  const knowledgeBaseId = await threadKnowledgeBase(threadId);
  const kept = await savedPage(knowledgeBaseId, front.url);
  // One URL, one page. Which of the two things the user meant is theirs to say, so
  // this comes back as a question rather than a guess in either direction.
  if (kept && existing !== "refresh" && existing !== "new") {
    return `That page is already in the knowledge base: “${kept.title}”, filed under ${kept.category}${kept.pending ? " (raw clip — its document was never built)" : ""}. Ask the user which they want, and say the title so they know the one you mean: refresh that page with what the page says now, or keep it and save a second copy. Then call save_page again with existing "refresh" or "new". Do not choose for them.`;
  }
  const refreshing = kept && existing === "refresh" ? kept : undefined;
  const clip = await clipPage(front);
  const captured = await host!.request({
    method: "captureToKnowledge",
    params: {
      knowledgeBaseId,
      category: "unfiled",
      title: clip.title,
      text: clip.text,
      sourceUrl: clip.url,
      ...(clip.application ? { sourceApplication: clip.application } : {}),
      ...(clip.images.length ? { images: JSON.stringify(clip.images) } : {}),
      ...(refreshing ? { pageId: refreshing.id } : {}),
    },
  }) as { id: string };
  changed();
  void buildPageDocument(captured.id, clip.url);
  return `${refreshing ? "Refreshed" : "Saved"} “${clip.title}” (${clip.url}) ${refreshing ? "in" : "to"} the knowledge base. Emma is building its document now, in the background — it appears on the board when it lands, so do not call save_page for this page again. Say what the page covers rather than repeating the steps.`;
}

/**
 * The document build, off the tool call's clock. A failure leaves the raw clip on the
 * board, which says so and offers Build document — nothing is lost, and nothing
 * pretends to be a written page.
 */
async function buildPageDocument(pageId: string, url: string) {
  try {
    const page = await answerRequest("analyzePage", { pageId }) as { title: string; category: string };
    fireEvent("page-saved", { title: page.title, url, category: page.category });
  } catch (error) {
    console.error(`Could not build the document for ${pageId}:`, error);
  } finally {
    changed();
  }
}

/** The page this base already keeps for a URL, so one page is not shelved twice. */
async function savedPage(knowledgeBaseId: string, url: string) {
  const snapshot = await host!.request({ method: "snapshot", params: {} }).catch(() => ({})) as { pages?: SavedPage[] };
  const page = pageForUrl(snapshot.pages ?? [], knowledgeBaseId, url);
  return page && { ...page, pending: isRawClip(page) };
}

/** Every saved page, for an unattended run resolving an "@" token against one. */
async function knowledgePages(): Promise<{ id: string; title: string; analysis?: { summary?: string; body?: string } }[]> {
  const snapshot = await host!.request({ method: "snapshot", params: {} }).catch(() => ({})) as {
    pages?: { id: string; title: string; analysis?: { summary?: string; body?: string } }[];
  };
  return snapshot.pages ?? [];
}

/** ponytail: one snapshot per save, to read one field. Cheap beside fetching the page. */
async function threadKnowledgeBase(threadId: string): Promise<string> {
  const snapshot = await host!.request({ method: "snapshot", params: {} }) as {
    threads?: { id: string; knowledgeBaseId: string }[];
    knowledgeBases?: { id: string }[];
  };
  const thread = snapshot.threads?.find((item) => item.id === threadId);
  return thread?.knowledgeBaseId ?? snapshot.knowledgeBases?.[0]?.id ?? "default";
}

/**
 * What this thread's window holds, and — when asked — the request to shrink it.
 *
 * The used figure is the provider's own input count rather than an estimate, so
 * it includes everything assembled below Emma: the system prompt, the tool
 * schemas, retrieved knowledge, the whole transcript. The run in flight has one
 * only once it reports; until then the last landed turn is the honest number and
 * the wording says which it is.
 */
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

/** Runs one already-permitted call. Throwing here reaches the model as a tool result. */
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
      // The turn has already finished by the time this resolves, so the output is
      // the answer — reading it back with cli_runs would be a wasted call.
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
      await ensureComputerRun(turn.threadId, turn.content);
      reportRunProgress(computerRuntime!.steps, String(args.args.action ?? "act"), computerRuntime!.actions);
      if (!computerRuntime!.step()) throw new Error("This computer run reached its step limit.");
      return await computerRuntime!.execute(args.args);
    }
    case "browser": {
      if (args.action === "open") return `Opened ${browserPage(await browsers.open(turn.threadId, args.url!))}. Snapshot it to see what is on it.`;
      const navigation = BROWSER_NAVIGATIONS.find((candidate) => candidate === args.action);
      if (!navigation) return await browsers.run(turn.threadId, browserArgv(args));
      const status = await browsers.navigate(turn.threadId, navigation);
      return navigation === "close" ? "Closed this thread's browser." : `Now on ${browserPage(status)}.`;
    }
    case "write_skill": {
      const skill = await writeLearnedSkill(app.getPath("userData"), args.skill, args.instructions);
      toolsChanged();
      return `Saved the skill "${skill.name}". Future runs can find it by name.`;
    }
    case "write_tool": {
      const tool = await writeEmmaTool(app.getPath("userData"), args.tool, args.description, args.code);
      toolsChanged();
      return `Saved the tool "${tool.name}". Run it with run_tool {"name":"${tool.name}","input":"…"}, in this thread or any later one.`;
    }
    case "write_plugin": {
      const { plugin } = await writePlugin(app.getPath("userData"), args.plugin);
      toolsChanged();
      const names = plugin.skills.map((skill) => skill.name).join(", ");
      return `Packaged and installed the plugin "${plugin.name}" at ${plugin.root}. It carries ${plugin.skills.length} ${plugin.skills.length === 1 ? "skill" : "skills"} (${names}), usable by name from the next turn. It is listed on the Plugins page under "Written by Emma".`;
    }
    case "run_tool": {
      // A tool Emma wrote is switched off under the name `run_tool` reaches it by.
      const disabled = toolSettings.disabledTools;
      const tools = (await listEmmaTools(app.getPath("userData"))).filter((tool) => !disabled.includes(`run_tool:${tool.name}`));
      const listing = tools.length
        ? `Your tools:\n${tools.map((tool) => `${tool.name} — ${tool.description}`).join("\n")}`
        : "You have not written any tools yet. write_tool makes one.";
      if (!args.tool) return listing;
      const match = tools.find((tool) => tool.name === args.tool);
      if (!match) throw new Error(`There is no tool called "${args.tool}". ${listing}`);
      // The connected folder when the thread has one, so a tool that works on the
      // project needs no path argument; its own directory otherwise, rather than
      // wherever Emma happened to be launched from.
      const attached = threadFolder(turn.threadId);
      const cwd = attached ? folders!.directory(attached) : path.dirname(match.run);
      return await runCommand(cwd, `${shellQuoted(match.run)} ${shellQuoted(args.input ?? "")}`);
    }
    case "memory":
      // `/memories` is a fiction the store maps onto this directory; nothing in the
      // model's arguments picks it, which is what keeps the tool inside Emma's own
      // data folder however creative a path it sends.
      return await runMemoryCommand(path.join(app.getPath("userData"), "memories"), args.command);
    case "vision": {
      // `publicUrl`, not `externalUrl`: the URL came from the model, so it may
      // not point at the user's own LAN.
      const image = args.url ? publicUrl(args.url)?.href : folderImage(turn.threadId, args.folder, args.path!);
      if (!image) throw new Error("That is not a public image URL. Use a path in a connected folder for a file on this Mac.");
      return await look(toolSettings.vision, image, args.question);
    }
    case "plan":
      return await planTool(args, turn);
    case "context":
      return await reportContext(turn, args.compact);
    case "save_page":
      return await savePage(turn.threadId, args.url, args.existing);
    case "web_search": {
      // The store puts saved credentials on the environment, as verifier and
      // advisor already read them.
      const { credentialEnv } = toolSettings.webSearch;
      const results = await webSearch(toolSettings.webSearch, args.query, args.limit, (credentialEnv && process.env[credentialEnv]) || "");
      return renderResults(args.query, results);
    }
    case "install_mcp": {
      const { id } = await capabilities!.installMcpServer({ name: args.server, command: args.command, args: args.argv, env: args.env });
      toolsChanged();
      return `Installed "${args.server}" (${id}) into Emma's configuration — the harness connects it when the next turn starts, and its tools are found from then on with mcp_search_tools.`;
    }
    case "workflow":
      return await workflowTool(args);
    case "autoresearch":
      return await researchTool(args);
    case "artifact":
      return await artifactTool(args, turn.threadId);
    case "visualize":
      // Nothing is stored, and nothing needs to be: `parseToolArgs` already
      // validated the picture, and the transcript draws it off this call's own
      // arguments. All the result has to carry is the marker saying one happened
      // — which is why it leads, the harness passing on only the first 200 bytes.
      return `${VISUAL_MARKER} Drawn in the conversation, under the answer you are writing. Do not repeat its numbers — the chart is the explanation.`;
  }
}

/** One plan as a line: enough to pick one out of a list, and to see whether it moved. */
function describePlan(plan: Plan): string {
  const { done, steps, doneTasks, tasks } = planProgress(plan);
  const running = plan.steps.filter((step) => step.status === "running").map((step) => step.id);
  const failed = plan.steps.filter((step) => step.status === "failed").map((step) => step.id);
  return `${plan.id} — ${plan.title} — ${done}/${steps} steps, ${doneTasks}/${tasks} tasks`
    + (running.length ? ` — running: ${running.join(", ")}` : "")
    + (failed.length ? ` — failed: ${failed.join(", ")}` : "");
}

/**
 * The `plan` tool: the markdown file a large job is broken up in, and the waves of
 * subagents it runs.
 *
 * The file is the record. Every action here reads it, changes it and writes it back
 * through `plans.ts`, which serialises the writes — a running wave is several
 * subagents ticking their own steps off in the same file at the same time.
 */
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
      // A rewrite keeps what the plan has already lived through, so restructuring
      // halfway does not untick every box and re-run every finished step.
      const previous = args.id ? await readPlan(userData, args.id).catch(() => undefined) : undefined;
      // The plan is watched in the inspector of the thread that asked for it, so a
      // subagent writing one files it under the thread it was delegated from.
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
        if (running.length) return `${running.map((step) => step.id).join(", ")} ${running.length === 1 ? "is" : "are"} still marked running in "${plan.title}". Wait for them, or set one failed with plan update if it will not finish.`;
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
        + wave.map((step) => `### ${step.id}\n${stepBrief(plan, step)}`).join("\n\n")
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

/**
 * The `artifact` tool: the documents a conversation leaves behind.
 *
 * Every answer that changed one ends its first line with `[artifact:<id>]`, which
 * is what the transcript draws the card from — on a create the id is chosen here,
 * so there is no other way for the renderer to learn it.
 */
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
      // An app is several files, so a get that does not say which has to say what
      // there is — otherwise the only way to learn a file exists is to guess it.
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
      // A rewrite keeps whatever the call did not send: a new body under the same
      // title and kind is the common one, and re-stating them is a chance to differ.
      const existing = args.action === "rewrite" ? await readArtifact(userData, args.id!) : undefined;
      const saved = await writeArtifact(userData, {
        // A create never addresses an id, even when the call sent one: the store
        // would rewrite whatever is already there, and a model reaching for the
        // id it remembers would quietly overwrite the user's artifact. `rewrite`
        // is how you mean that. The id is minted from the title instead.
        id: existing?.id,
        title: args.title ?? existing?.title ?? "",
        kind: args.kind ?? existing?.kind ?? "",
        language: args.language ?? existing?.language,
        surface: args.surface,
        content: args.content!,
        sourceThreadId: threadId,
      });
      artifactsChanged();
      // The marker leads every one of these. The harness passes on only the
      // first 200 bytes of a tool result, and the MCP envelope it wraps them in
      // spends about 110 of those on its own header — so anything after a long
      // title is cut off, and the transcript loses the card.
      // A mounted panel reloads as this returns, so the result says so: it is the
      // only signal that the write landed somewhere the user is already looking.
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

/**
 * ponytail: one command, no pty, killed at the deadline. Add streaming if a build outgrows it.
 *
 * The deadline is a parameter because an autoresearch eval is not a tool call: a
 * training run or a full suite takes minutes, and the tool's two is a kill.
 */
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
/** What the terminal pane may show. Larger than a tool result: a person scrolls it. */
const MAX_CLI_VIEW_CHARS = 128 * 1024;
const MAX_COMMAND_MS = 120_000;

/**
 * One harness per workspace, reused across that workspace's threads.
 *
 * `key` is the workspace unless the turn is a nested one, which takes a process
 * of its own — see `harnessKey`.
 */
function harnessClient(cwd: string, key = cwd): Harness {
  const running = harnesses.get(key);
  if (running?.running) {
    // Re-inserted so map order stays least-recently-used, which is what `reapHarnesses`
    // reads: without this a long-lived project harness ages out behind a burst of
    // scratch ones it is still the most used of.
    harnesses.delete(key);
    harnesses.set(key, running);
    return running;
  }
  if (running) harnesses.delete(key);
  const binaryPath = binary("emma-cli");
  // This is the only agent loop there is now, so a missing binary is a broken
  // install rather than a reason to take another path. It used to fall through to
  // a second loop in `agent-loop.ts`, which is what let a bad build look like a
  // working Emma that quietly behaved differently.
  if (!existsSync(binaryPath)) throw new Error(`Emma could not find its agent at ${binaryPath}. The install is incomplete — reinstall Emma, or run npm run build:harness from the repo.`);
  const client = new Harness({
    binaryPath,
    cwd,
    // A profile of Emma's own: the harness never reads the user's ~/.fx.
    home: path.join(app.getPath("userData"), "harness"),
    apiKey: process.env.OPENROUTER_API_KEY,
    onDelta: (threadId, delta) => {
      harnessText.set(threadId, (harnessText.get(threadId) ?? "") + delta);
      agents?.noteDelta(threadId, delta);
      broadcast("emma:delta", { threadId, delta });
    },
    onThought: (threadId, delta) => {
      harnessThought.set(threadId, (harnessThought.get(threadId) ?? "") + delta);
      // Counted like any other token: a reasoning-heavy model spends most of a
      // turn here, and leaving it out made the live rate read as a stall.
      agents?.noteDelta(threadId, delta);
      broadcast("emma:delta", { threadId, delta, thinking: true });
    },
    // The step itself is live-only, but the trace keeps it: passing the whole
    // record is what gives a harness span its status, arguments and result.
    onToolCall: (call) => {
      agents?.noteTool(call.threadId, call.toolCallId, call.title || call.kind, call);
      // The Changes tab and its revert button read this list. The harness writes
      // files itself, so nothing was recording them and a harness turn's edits
      // were unreviewable and unrevertable. The pair it builds is also what the
      // transcript counts its `+145 −1` from, so the step carries it out.
      const wrote = noteHarnessChange(cwd, call);
      broadcast("emma:step", wrote ? { ...call, edit: editStat(wrote) } : call);
    },
    // Live only, and deliberately not recorded with the turn: it is what happened
    // to the window on one step, not something Emma said.
    onContextExperiment: (threadId, fired) => broadcast("emma:context-experiment", { threadId, ...fired }),
    onContextBreakdown: (threadId, parts) => broadcast("emma:context-breakdown", { threadId, ...parts }),
    onUsage: (threadId, usage) => agents?.noteUsage(threadId, usage),
    // A subagent the harness spawned, seen for the first time. It gets a thread of
    // its own so its transcript is not glued into its parent's answer, and an
    // adopted run so it shows up in the agent rail and can be opened like any
    // other subagent. Its text and tool calls arrive through the callbacks above,
    // against this thread id.
    onChildStart: async ({ parentThreadId, childId, title }) => {
      const created = await host!.request({ method: "createThread", params: { parentThreadId, title, kind: "subagent" } });
      const threadId = (created as { id?: unknown }).id;
      if (typeof threadId !== "string") throw new Error("Emma host returned an invalid thread");
      harnessText.set(threadId, "");
      harnessThought.set(threadId, "");
      harnessChildren.set(threadId, { childId, title, startedAt: Date.now(), client });
      const parent = harnessTurns.get(parentThreadId);
      agents!.adopt({
        threadId,
        content: title,
        title,
        parentThreadId,
        depth: (parent?.depth ?? 0) + 1,
        mode: parent?.mode ?? DEFAULT_PERMISSION_MODE,
        model: parent?.model ?? "",
        // The `subagent` call that asked for it, so the child's whole tree hangs
        // under that call exactly as Emma's own subagents do.
        parentSpanId: agents!.spanFor(parentThreadId),
      });
      return threadId;
    },
    // The child said all it is going to. Written back as one turn on its own
    // thread, so its tab still has a transcript after the run is over — nothing
    // else records it, since the harness owns the loop that produced it.
    onChildEnd: (threadId) => {
      const child = harnessChildren.get(threadId);
      if (!child) return;
      harnessChildren.delete(threadId);
      const spoken = (harnessText.get(threadId) ?? "").trim();
      const thinking = harnessThought.get(threadId);
      harnessText.delete(threadId);
      harnessThought.delete(threadId);
      const spent = agents!.list().find((agent) => agent.threadId === threadId);
      agents!.finish(threadId);
      void recordTurn({
        threadId,
        prompt: child.title,
        thinking,
        answer: spoken || "(the subagent finished without an answer)",
        durationMilliseconds: String(Date.now() - child.startedAt),
        outputTokens: String(spent?.outputTokens ?? 0),
        inputTokens: String(spent?.inputTokens ?? 0),
        model: modelName(threadModel(threadId)),
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
      // Preferred in order rather than by list position: `find` over a list of
      // kinds returns whichever the harness happened to send first, so one
      // reordering upstream would turn "Allow once" into a session-wide grant.
      const pick = (...kinds: string[]) => {
        for (const kind of kinds) {
          const found = options.find((option) => option.kind === kind)?.optionId;
          if (found) return found;
        }
        return undefined;
      };
      const deny = () => pick("reject_once", "reject_always") ?? null;
      // The granted folder, enforced here because the harness does not know one
      // exists. This is not a prompt the user can override: Emma's own loop
      // makes an outside-the-grant write impossible in every mode, and a
      // permission dialog offering to allow it would be a worse promise than
      // the one the picker already makes.
      if (context.outsideWorkspace) {
        broadcast("emma:step", { threadId: ask.threadId, toolCallId: ask.id, title: `blocked: ${ask.tool} is outside the connected folder`, kind: "other", status: "failed", at: Date.now() });
        return deny();
      }
      // What each mode promised the user, now that every decision routes here.
      // `full` runs unattended, and `acceptEdits` edits without asking but still
      // asks before running anything — so only its file mutations pass silently.
      if (context.mode === "full") return pick("allow_once", "allow_always") ?? options[0]?.optionId ?? null;
      if (context.mode === "acceptEdits" && context.kind === "edit") return pick("allow_once", "allow_always") ?? options[0]?.optionId ?? null;
      const allowed = await agents!.question({ threadId: ask.threadId, tool: ask.tool, summary: ask.summary, detail: ask.detail });
      // A denial picks the harness's own reject option so the turn continues with
      // a "no"; cancelling would end the run and lose everything before it.
      return allowed ? pick("allow_once", "allow_always") ?? options[0]?.optionId ?? null : deny();
    },
    onToolRequest: (threadId, name, args) => runEmmaTool(threadId, name, args),
    mcpServers: (threadId) => harnessMcpServers(threadId),
  });
  harnesses.set(cwd, client);
  reapHarnesses();
  return client;
}

/**
 * How many harness processes may be alive at once.
 *
 * A thread with no connected folder works in a scratch directory of its own, so
 * "one process per workspace" is one process per thread for those — and nothing
 * ever closed them. Now that this is the default path rather than an opt-in,
 * that is a process per thread the user has ever opened.
 */
const MAX_HARNESSES = 4;

/** Closes the least recently used harnesses, never one with a turn in flight. */
function reapHarnesses() {
  // Map order is least-recently-used, so the front is the first to go.
  for (const [cwd, client] of [...harnesses]) {
    if (harnesses.size <= MAX_HARNESSES) return;
    if (client.busy) continue;
    client.close();
    harnesses.delete(cwd);
  }
}

/**
 * Drops every idle harness so the next turn spawns one against the current environment.
 *
 * A harness reads its key and its zero-retention flag out of the environment it was
 * spawned with, so an idle one would keep going out the old way and the user would have
 * no way to tell the change had landed. A busy one keeps its turn and is replaced after.
 */
function recycleHarnesses() {
  for (const [cwd, client] of [...harnesses]) {
    if (client.busy) continue;
    client.close();
    harnesses.delete(cwd);
  }
}

/** A file's text before a harness edit, keyed by the call that is about to make it. */
const harnessBefore = new Map<string, { threadId: string; text: string | null }>();

/**
 * Records a harness file mutation as one of Emma's own changes.
 *
 * A `FileChange` is what the Changes tab lists and what revert writes back. The
 * harness edits files in its own process, so the only sighting Emma gets is the
 * tool call: read the file
 * when the call opens, read it again when it completes, and the pair is the
 * same record. Only for a connected folder — a scratch workspace has no folder
 * to revert into.
 *
 * Returns the change when the call made one, so the caller can put it on the step.
 */
function noteHarnessChange(cwd: string, call: HarnessToolCall): FileChange | undefined {
  if (call.kind !== "edit") return;
  const relative = describePath(call.input);
  if (!relative) return;
  const grant = folders!.list().find((folder) => folder.path === cwd);
  if (!grant) return;
  const absolute = path.resolve(cwd, relative);
  // Not `escapesRoot`: this is bookkeeping, and the permission handler has
  // already refused anything outside the folder.
  if (absolute !== cwd && !absolute.startsWith(cwd + path.sep)) return;
  const read = () => { try { return readFileSync(absolute, "utf8"); } catch { return null; } };

  if (call.status !== "completed") {
    if (!harnessBefore.has(call.toolCallId)) harnessBefore.set(call.toolCallId, { threadId: call.threadId, text: read() });
    return;
  }
  const before = harnessBefore.get(call.toolCallId)?.text ?? null;
  harnessBefore.delete(call.toolCallId);
  const after = read();
  // A delete leaves nothing to show as the new text, and an unchanged file is
  // not a change the user needs to review.
  if (after === null || after === before) return;
  const change: FileChange = { folderId: grant.id, path: path.relative(cwd, absolute), before, after, at: Date.now() };
  agents!.noteChange(call.threadId, change);
  changed();
  return change;
}

/**
 * Puts every skill the user has where the harness can find it.
 *
 * Run at launch and again whenever the set of skills changes, because the
 * harness reads its catalog from disk when a session starts rather than being
 * told about one.
 */
function syncHarnessSkills() {
  void mirrorSkillsToHarness(app.getPath("userData"), path.join(app.getPath("userData"), "harness"), toolSettings.disabledSkills)
    .catch((error) => console.warn("Emma could not mirror skills to the harness:", error instanceof Error ? error.message : error));
}

/** The turn a delegated call belongs to, since `executeTool` runs against one. */
const harnessTurns = new Map<string, TurnRequest>();

/**
 * Tools the harness had to name differently, mapped back to what Emma calls them.
 *
 * Only one so far. `vision` is a name the harness needs for itself: its gateway
 * forces a tool of that exact name when the model cannot see an image the user
 * attached, against a schema of its own. Emma's image tool is advertised as
 * `look_at_image` to leave it alone, and is translated here rather than renamed
 * throughout — `GATES`, the Settings → Tools switches and `executeTool` all key
 * on `vision`, and changing that key would quietly turn the switch back on for
 * everyone who had switched it off.
 */
const HARNESS_TOOL_NAMES: Record<string, string> = { look_at_image: "vision" };

/**
 * Runs one of Emma's own tools for the harness.
 *
 * The harness advertises these natively now — it used to reach them over an MCP
 * server on localhost, because MCP was the only door it left open for a tool it
 * did not ship. What did not change is where they run: they read and write
 * Emma's durable stores, its threads and its grants, so the harness can only ask.
 *
 * Availability is answered here rather than by leaving a tool out of the
 * catalog. A native tool is registered for the whole process, so "no folder is
 * connected" has to come back as a refusal the model can read instead of an
 * absence it cannot see.
 */
async function runEmmaTool(threadId: string, wireName: string, args: Record<string, unknown>): Promise<string> {
  const name = HARNESS_TOOL_NAMES[wireName] ?? wireName;
  const turn = harnessTurns.get(threadId);
  if (!turn) throw new Error("Emma's tools are only available while a turn is running.");
  // The same gate the other loop applies, because a filtered list is not an
  // enforced one: the harness caches its catalog and the model can guess.
  // Refusals name the tool the model called, not the one Emma gates internally:
  // `look_at_image` is `vision` on this side of the translation, and a refusal
  // naming a tool it was never offered reads as a different tool being blocked.
  const gate = toolGate(turn.mode, name, toolSettings.disabledTools);
  if (gate === "hidden") {
    throw new Error(`${wireName} is not available in ${turn.mode} mode, or is switched off in Settings → Tools.`);
  }
  const unavailable = whyUnavailable(threadId, name, wireName);
  if (unavailable) throw new Error(unavailable);
  const parsed = parseToolArgs(name, JSON.stringify(args));
  if (gate === "ask") {
    const allowed = await agents!.question({
      threadId,
      tool: name,
      summary: describeToolCall(parsed),
      detail: JSON.stringify(args, null, 2).slice(0, 4096),
    });
    if (!allowed) throw new Error(`The user did not allow ${wireName} to run. Do not try it again this turn; say what you needed it for instead.`);
  }
  // The loop answers its own thread and agent tools — `threads`, `read_trace`,
  // `agents`, `advisor` — because the record they read is the one it writes.
  // Sending them to `executeTool` would advertise them here and then fall off
  // the end of its switch. Its own list, so the two can never drift.
  return OWN_TOOLS.has(name)
    ? await agents!.runThreadTool(parsed, turn)
    : await executeTool(parsed as ToolArgs, turn);
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

/** The user's configured MCP servers. Emma's own tools are registered natively. */
async function harnessMcpServers(_threadId: string): Promise<HarnessMcpServer[]> {
  try {
    return await readHarnessMcpServers(app.getPath("userData"));
  } catch {
    // A broken config costs the user their servers, not their thread.
    return [];
  }
}

/**
 * The route a turn takes, from the key the picker is on.
 *
 * Emma's free router is not a model, so it expands here into the chain the
 * transport turns into OpenRouter's `models` fallback array. A local profile
 * and the deterministic fallback name no route the harness can take — its
 * gateway is Emma's provider endpoint, not a loopback server — so those leave
 * it on its own default rather than sending it somewhere it cannot reach.
 */
function harnessModel(key: string | undefined) {
  if (key === FREE_ROUTER_KEY) return freeRouterChain(modelCatalog?.ids());
  return key?.startsWith("openrouter:") ? key.slice("openrouter:".length) : undefined;
}

/** The same key as something a transcript can show: the model's ID, not Emma's routing prefix. */
function modelName(key: string | undefined) {
  return key?.startsWith("openrouter:") ? key.slice("openrouter:".length) : key ?? "";
}

/** A model's real context window, so the harness stops guessing at it. The chain's is its first link's. */
function contextWindowFor(model: string | undefined) {
  return modelCatalog?.contextLength(model?.split(",")[0]);
}

/**
 * The thinking stop a turn asks for, with the stops its model publishes.
 *
 * Clamped against the catalog rather than trusted, because the two disagree all the
 * time: models publish different vocabularies, a saved stop outlives the model it was
 * chosen on, and the slider offers "off" to models that publish no name for it. An
 * effort a model never listed is a 400, so an unpublished one asks for the default.
 */
function thinkingRoute(model: string | undefined, level: string | undefined): ThinkingRoute | undefined {
  if (!model) return undefined;
  const published = modelCatalog?.reasoningEfforts(model.split(",")[0]) ?? [];
  return { level: level && published.includes(level) ? level : "", published };
}

/** What the picker last chose, in the composer's own grammar. Empty is the local fallback. */
let selectedModel = "";
/** The stop the slider is on, for the model it was chosen on. Blank is that model's own default. */
let selectedEffort: ThinkingLevel = "";
/**
 * Where a knowledge page is authored — the one thing outside the harness that still
 * calls a provider directly. The picker used to route this into the Zig sidecar, which
 * checked the model against a catalog only it could fetch; main holds that catalog, so
 * the check and the route it produces live here now. Unset means the local scaffold,
 * which is what "Local fallback" has always been.
 */
let pageRoute: { endpoint: string; model: string; credentialEnv: string; effort: string } | undefined;

/** The route with its key attached. Read per call, so a key pasted mid-session is live at once. */
const authorRoute = (): AuthorRoute | undefined =>
  pageRoute && { endpoint: pageRoute.endpoint, model: pageRoute.model, key: process.env[pageRoute.credentialEnv] ?? "", effort: pageRoute.effort };

/** A model OpenRouter still lists. A saved selection that fell out of the catalog is refused here. */
function catalogued(modelId: string): string {
  if (!modelCatalog!.ids().includes(modelId)) throw new Error("That model is no longer in OpenRouter's catalog. Reload the models page and pick again.");
  return modelId;
}

/** A stop off the slider, as one of the nine Emma knows. Anything else is not a stop at all. */
const thinkingLevel = (value: unknown): ThinkingLevel => isThinkingLevel(value) ? value : "";

/**
 * The model picker, answered here rather than by the store.
 *
 * `effort` is kept beside the model it was picked on, because that is the only model it
 * means anything for: the stops are the model's own, and the next one publishes a
 * different set. It reaches the harness on every turn and the authoring endpoint on
 * every page, both clamped against the catalog first.
 */
function selectModel(method: string, params: Record<string, string>): unknown {
  if (method === "setThreadModel") {
    // The route itself rides the turn; an empty id clears the pin. All that is left
    // here is refusing a model that is not real, which is what the caller catches to
    // run a subagent where its parent runs instead of failing the work.
    if (params.modelId) catalogued(params.modelId);
    return { set: true };
  }
  if (method === "selectFallbackModel") {
    selectedModel = "";
    selectedEffort = "";
    pageRoute = undefined;
    return { model: "" };
  }
  if (method === "selectLocalModel") {
    // Loopback only, and checked here rather than trusted: this is an endpoint main
    // POSTs the user's own saved pages to.
    const baseUrl = normalizeLocalModelEndpoint(params.baseUrl);
    if (!baseUrl) throw new Error("A local model server has to be on this Mac.");
    if (!isEnvName(params.credentialEnv)) throw new Error("The local model key must be the name of an environment variable.");
    selectedModel = "";
    // A local server publishes no catalog, so there is no list to check a stop against.
    selectedEffort = "";
    pageRoute = { endpoint: `${baseUrl}/chat/completions`, model: params.modelId, credentialEnv: params.credentialEnv, effort: "" };
    return { model: params.modelId };
  }
  const modelId = catalogued(params.modelId);
  selectedModel = `openrouter:${modelId}`;
  selectedEffort = thinkingLevel(params.effort);
  pageRoute = { endpoint: OPENROUTER_CHAT_ENDPOINT, model: modelId, credentialEnv: "OPENROUTER_API_KEY", effort: thinkingRoute(modelId, selectedEffort)?.level ?? "" };
  return { model: modelId };
}

/** Every store call the page flows make goes through the host untouched. */
const pageStore: PageStore = (method, params) => host!.request({ method, params });

/** Talking to a page is a turn like any other, with the document as its attached context. */
async function chatAboutPage(params: Record<string, string>) {
  const { threadId, title, skillContext } = await pageTurnContext(pageStore, params.pageId);
  return driveTurn({
    threadId,
    content: params.content,
    mode: threadMode(threadId),
    title: title || "This page",
    model: threadModel(threadId) || selectedModel,
    params: { skillContext },
  });
}

/**
 * One door onto the store, for main's own callers as much as for the renderer.
 *
 * Most methods are forwarded untouched. The picker is answered here because main holds
 * the catalog it is checked against, and the knowledge-page methods are a provider call
 * between two store calls because main is the only part of Emma that talks to a model.
 */
function answerRequest(method: string, params: Record<string, string> = {}): Promise<unknown> {
  switch (method) {
    // The catalog answers from disk when the fetch fails, and reports what changed when it
    // does not — a reload that lands on an identical list has to say so, not look inert.
    case "listOpenRouterModels": return modelCatalog!.refresh(() => fetchOpenRouterCatalog());
    case "selectOpenRouterModel": case "selectLocalModel": case "selectFallbackModel": case "setThreadModel":
      return Promise.resolve().then(() => selectModel(method, params));
    case "analyzePage": return authorKnowledgePage(pageStore, params, authorRoute());
    case "saveToKnowledge": return authorPageFromThread(pageStore, params.threadId, authorRoute());
    case "revisePageDocument": return proposePageRevision(pageStore, params, authorRoute());
    case "chatAboutPage": return chatAboutPage(params);
    default: return host!.request({ method, params });
  }
}

/**
 * Threads the `context` tool has asked to compact, drained by their next turn.
 *
 * Not done where the tool is called, because that call happens inside a running
 * turn: the harness refuses a compaction while a prompt is in flight, and it is
 * right to — the turn in progress is reading the history that would be rewritten
 * under it. So the request waits for the gap between turns, which is also the
 * first moment a smaller history could change anything.
 */
const compactNext = new Set<string>();

/**
 * Where a harness turn runs. A thread with a connected folder runs in it; one
 * without gets a scratch directory of Emma's own, because the alternative is
 * an agent loose in the user's home.
 */
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
      return file.text === undefined ? [file.path] : [];
    } catch { return []; }
  });
}

/**
 * One turn on the harness, then written back into the durable thread.
 *
 * The harness owns the live session; Emma's Markdown store is the record. This
 * is the whole of the one-way sync: prompt in, finished answer out.
 */
async function runOnHarness(client: Harness, cwd: string, turn: TurnRequest) {
  harnessText.set(turn.threadId, "");
  harnessThought.set(turn.threadId, "");
  // What a bridged tool call runs against. Set before the prompt, because the
  // harness may call one back before `session/prompt` has returned anything.
  harnessTurns.set(turn.threadId, turn);
  const startedAt = Date.now();
  // The harness owns the loop, so nothing here calls `agents.run`. Without this
  // there is no Run record and every live number — deltas, tool calls, rate —
  // lands nowhere.
  agents!.adopt({ ...turn, model: modelName(turn.model) });
  const route = harnessModel(turn.model);
  try {
    const { stopReason, usage } = await client.prompt(turn.threadId, cwd, turn.content, turn.mode, route, {
      // Skills, attached folders, files and knowledge all arrive on this one
      // field. It was being dropped entirely: the chip cleared, the attachment
      // was marked delivered, and the instructions never left this process.
      skillContext: typeof turn.params?.skillContext === "string" ? turn.params.skillContext : undefined,
      images: attachedImagePaths(turn.params?.attachedImages),
      contextWindow: contextWindowFor(route),
      effort: thinkingRoute(route, turn.effort),
      experiments: harnessExperiments,
      // Asked for by the `context` tool on an earlier turn. Consumed here, at
      // the one point the harness will take it: between turns, with the session
      // loaded and no prompt in flight.
      compact: compactNext.delete(turn.threadId),
    });
    // The adopted run carries a chars/4 estimate; this is what the provider
    // actually charged. Without it the autoresearch token budget only ever sees
    // the output side and stops at roughly half the real spend.
    agents!.noteUsage(turn.threadId, usage);
    const spoken = (harnessText.get(turn.threadId) ?? "").trim();
    // A provider or auth failure arrives as ordinary assistant text and still
    // resolves the call, so without this the error string is recorded as Emma's
    // answer and the user loses both the error banner and their typed prompt.
    if (failedTurn(stopReason)) throw new Error(spoken || "The run was refused.");
    agents!.finish(turn.threadId);
    return await recordTurn({
      threadId: turn.threadId,
      prompt: turn.content,
      thinking: harnessThought.get(turn.threadId),
      // A turn that ended without words still happened, so the thread says why
      // rather than dropping the prompt that caused it.
      answer: spoken || `(the run ended: ${stopReason})`,
      durationMilliseconds: String(Date.now() - startedAt),
      outputTokens: String(usage.outputTokens),
      inputTokens: String(usage.inputTokens),
      // Recorded per turn, not read off the picker at render time: the picker
      // moves, and a thread half answered by another model has to say so.
      // ponytail: on the free router this records the chain, not the link that
      // answered — OpenRouter names it in the response, the harness does not
      // pass it back. Surface it once the ACP result carries the served model.
      model: modelName(turn.model),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // `driveTurn`'s `forget` only clears a run that is not running, so an adopted
    // run left running would block the next turn on this thread.
    agents!.finish(turn.threadId, detail);
    // Work that already happened is kept, even though the turn ended badly.
    // Throwing unconditionally dropped everything the harness had streamed and
    // handed the prompt back as unsent, so a long run that hit the idle timeout
    // left nothing to resume from — the files it wrote were on disk with no
    // record in the thread of what it had done or how far it got. Recorded with
    // the failure appended, the transcript reads as far as it reached.
    const spoken = (harnessText.get(turn.threadId) ?? "").trim();
    const thought = harnessThought.get(turn.threadId) ?? "";
    if (spoken || thought.trim()) {
      return await recordTurn({
        threadId: turn.threadId,
        prompt: turn.content,
        thinking: thought,
        answer: `${spoken}\n\n_(this run stopped: ${detail})_`.trim(),
        durationMilliseconds: String(Date.now() - startedAt),
        // No `usage` ever arrived, and guessing here would be worse than a
        // turn the ledger knows it cannot account for.
        outputTokens: "0",
        inputTokens: "0",
        model: turn.model ?? "",
      });
    }
    // Nothing was produced, so the prompt goes back to the composer unsent
    // rather than becoming a thread entry that says only that it failed.
    throw error;
  } finally {
    harnessText.delete(turn.threadId);
    harnessThought.delete(turn.threadId);
    harnessTurns.delete(turn.threadId);
    for (const [id, opened] of harnessBefore) if (opened.threadId === turn.threadId) harnessBefore.delete(id);
  }
}

/** One turn from any surface: the composer, Quick Ask, a quick action, a subagent. */
async function driveTurn(turn: TurnRequest) {
  agents!.forget(turn.threadId);
  // Every surface's turn carries the thread's own subagent route without each of
  // them having to remember to look it up; a subagent's turn never comes through
  // here, so this only ever fills a top-level run's.
  turn.subagent ??= threadSubagent(turn.threadId);
  // The slider is the app's, so it applies to the app's model and to nothing else:
  // a thread pinned elsewhere — the island's own model, a subagent's — runs on
  // that model's default unless it was given a stop of its own.
  turn.effort ??= harnessModel(turn.model) === harnessModel(selectedModel) ? selectedEffort : "";
  const cwd = harnessCwd(turn.threadId);
  const key = harnessKey(cwd, turn.nested ? turn.threadId : undefined);
  try {
    // The harness reads its standing instructions from a file — the user's
    // Settings text, written before the run rather than carried into it. Only
    // the Agent page's trial arm rides the turn, because it is decided per turn.
    writeHarnessPrompt(path.join(app.getPath("userData"), "harness"), { model: turn.model, workspace: cwd, mode: turn.mode, disabledTools: toolSettings.disabledTools });
    return await runOnHarness(harnessClient(cwd, key), cwd, withTrialArm(turn));
  } finally {
    if (key !== cwd) {
      harnesses.get(key)?.close();
      harnesses.delete(key);
    }
    if (!agents!.busy) {
      computerRuntime?.abort("finished");
      closeRunBanner();
    }
    changed();
  }
}

/** A scheduled task as the store keeps it, which is all the snapshot reports back. */
type StoredJob = {
  id: string; title: string; schedule: string; prompt: string; nodes: string; outputs: string;
  sourceDomains: string[]; enabled: boolean; permissionMode: string;
  nextRunAt?: string | null; lastRunAt?: string | null;
};

async function scheduledJobs(): Promise<StoredJob[]> {
  const snapshot = await host!.request({ method: "snapshot", params: {} }) as { scheduledJobs?: StoredJob[] };
  return snapshot.scheduledJobs ?? [];
}

/**
 * The "/skill" and "@thing" tokens a scheduled prompt was written with. The
 * composer resolves these as they are typed — attaching the skill, reading the
 * file into the turn — but a task fires with nobody there, so a run resolves its
 * own text: the named skill is attached to the run's thread, and every named
 * artifact, knowledge page and file is read into the same bounded context block a
 * composed turn would carry. A "/" that names a built-in tool resolves to nothing
 * here on purpose — the turn advertises the tool anyway, so the token is left in
 * the prompt as the instruction it is.
 */
async function resolveMentions(prompt: string, threadId: string): Promise<string> {
  const named = mentions(prompt, "/");
  if (named.length) {
    const skills = await capabilities!.searchSkills("", 64);
    // The attachment store holds one skill per turn, so the first name wins.
    const skill = skills.find((item) => named.includes(item.name) && !toolSettings.disabledSkills.includes(item.id));
    if (skill) skillAttachment.put(await capabilities!.selectSkill(skill.id), threadId);
  }
  const sections: { heading: string; body: string }[] = [];
  const paths = mentions(prompt, "@");
  // The three sources the "@" menu offers, looked up in the order it lists them:
  // what Emma made, what it saved, then the files on disk. Both lists are fetched
  // once, and only when the prompt actually names something.
  const userData = app.getPath("userData");
  const artifacts = paths.length ? await listArtifacts(userData).catch(() => []) : [];
  const pages = paths.length ? await knowledgePages() : [];
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
    const page = pages.find((item) => pathName(item.title) === mention);
    if (page) {
      sections.push({ heading: `Knowledge page ${page.title}`, body: `${page.analysis?.summary ?? ""}\n${page.analysis?.body ?? ""}`.trim() });
      continue;
    }
    for (const grant of folders!.list()) {
      // The token carries the name the menu wrote, which is the path in the
      // grammar's alphabet — so the match is against that, not the raw path.
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

/**
 * One scheduled task, from the line that fired it to the outputs it leaves behind.
 *
 * The graph is walked here rather than in core because every agent step of it is a
 * full turn on this thread — the same run the composer drives — and only this
 * process can drive one. Core owns when a task fires and what happens after it
 * finishes; between those two moments the work happens here.
 */
async function runScheduledWorkflow(job: HostDueJob["dueJob"]) {
  const { nodes, errors } = parseWorkflow(job.nodes, job.prompt);
  if (errors.length) {
    // The thread is already saved and the user will open it, so it says why it is
    // empty rather than leaving them with nothing.
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
    const outcome = await driveTurn({ threadId: job.threadId, content, mode, title: job.title, model: threadModel(job.threadId) });
    return lastAssistantMessage(outcome) ?? "";
  });
  // Finishing is what fires whatever waits `after` this task, so it happens even
  // when a step came back empty — a task that produced nothing still ran.
  await host!.request({ method: "finishScheduledJob", params: { jobId: job.jobId, outputs: packVariables(run.variables), depth: String(job.depth) } });
  changed();
}

/** Raises an app event, so a task triggered `on <event>` fires. Best effort by design. */
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
  const state = [`trigger ${job.schedule}`, job.enabled ? "" : "paused", `mode ${job.permissionMode}`, job.nextRunAt ? `next ${job.nextRunAt}` : "", job.lastRunAt ? `last ran ${job.lastRunAt}` : ""].filter(Boolean).join(" · ");
  return [
    `${job.title} (${job.id})`,
    state,
    nodes.map(describeNode).join("\n"),
    errors.length ? `broken: ${errors.join(" ")}` : "",
    job.outputs.trim() ? `last outputs: ${job.outputs.slice(0, 400)}` : "",
  ].filter(Boolean).join("\n");
}

/** The `workflow` tool: the user's scheduled tasks, as Emma reads and writes them. */
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
      // The stand-in runner is the whole difference from a live run: the path,
      // the branches and the variables are real, the turns are not taken.
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

/** The `autoresearch` tool: the user's experiment loops, as Emma reads and writes them. */
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
  // Escape is grabbed system-wide only while a run is live: the agent is clicking in
  // other apps, so the kill switch has to work wherever focus happens to be.
  if (!globalShortcut.isRegistered("Escape")) globalShortcut.register("Escape", () => { computerRuntime?.abort("stopped by the user"); closeRunBanner(); });
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
  // Without skipTransformProcessType this call demotes Emma to an accessory app, which
  // costs the main window its Dock icon and its Cmd-Tab entry.
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  window.on("closed", () => { if (runBanner === window) runBanner = null; });
  void load(window, "run", { threadId, task: task.slice(0, 200), maxSteps: String(MAX_RUN_STEPS) });
}

function closeRunBanner() {
  globalShortcut.unregister("Escape");
  if (runBanner && !runBanner.isDestroyed()) runBanner.destroy();
  runBanner = null;
}

// The pen draws on a transparent sheet over the live screen; the frame underneath is only
// captured when the user keeps the markup, so there is no frozen screenshot to draw on.
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
  // Without skipTransformProcessType this call demotes Emma to an accessory app, which
  // costs the main window its Dock icon and its Cmd-Tab entry.
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

/* The bridge an app artifact's own script calls, and the whole of it: `emma.sql`,
   which is a postMessage to Emma and an answer back. It is injected into what is
   served rather than written into the artifact, so the app's source stays the app
   and no page can be authored with a wider one — and `parent` is the only party it
   can address, which is the renderer, which answers for that artifact's database
   and no other. */
const APP_BRIDGE = '<script>(()=>{const w=new Map();let n=0;addEventListener("message",(e)=>{const a=w.get(e.data?.n);'
  + 'if(e.source!==parent||!a)return;w.delete(e.data.n);e.data.error?a[1](new Error(e.data.error)):a[0](e.data.rows)});'
  + 'window.emma={sql:(sql,...params)=>new Promise((ok,no)=>{w.set(++n,[ok,no]);parent.postMessage({emma:"sql",n,sql,params},"*")})}})()</script>';

/** After the doctype, so the page is not quirks-mode, and before everything else,
    so a script that queries as it parses already has `emma.sql`. */
function appPage(content: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(content);
  return doctype ? doctype[0] + APP_BRIDGE + content.slice(doctype[0].length) : APP_BRIDGE + content;
}

/* Has to be said before the app is ready, so it sits above the lock with the rest
   of the launch. An html artifact is framed from here; see `ARTIFACT_SCHEME`. */
/* `supportFetchAPI` and `corsEnabled` are what make `/module.js` importable: a
   dynamic import is a fetch, and a scheme without them is refused before the
   handler is ever asked. A region's module is imported into the renderer's own
   realm — see `artifactModuleUrl`. */
protocol.registerSchemesAsPrivileged([{ scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else app.on("second-instance", () => { void app.whenReady().then(openMain); });

if (primaryInstance) app.whenReady().then(() => {
  // Dictation and copying are the only capabilities a page here may ask the OS for,
  // and only from one of Emma's own windows: audio in, text out. Everything else —
  // the camera, geolocation, notifications, the lot — is still refused outright.
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => pageMayAsk(contents, permission, details.mediaType ? [details.mediaType] : []));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(pageMayAsk(contents, permission, (details as { mediaTypes?: string[] }).mediaTypes ?? [])));
  /* One artifact per host, and the path names a file inside that one artifact's
     folder — `artifactFilePath` is the only thing that decides a name is a file, so
     a crafted `../` is refused there rather than guarded for here. The policy is the
     artifact's own: it may script and style itself inline, an app may additionally
     load its own files from its own host, and neither reaches the network, another
     frame, or a plugin. The renderer sandboxes the frame to an opaque origin on top
     of that, so `'self'` would be nobody — which is why the host is named outright. */
  protocol.handle(ARTIFACT_SCHEME, async (request) => {
    const notFound = (why: string, status = 404) => new Response(why, { status, headers: { "content-type": "text/plain" } });
    try {
      const userData = app.getPath("userData");
      const url = new URL(request.url);
      const id = boundedCapabilityId(url.hostname, "Artifact");
      const artifact = await readArtifact(userData, id);
      // A region's module: the renderer imports this into its own realm, so it is
      // served as JavaScript and nothing else. Only an artifact that is actually
      // mounted is served this way — the source of an unmounted `code` artifact is
      // read, quoted and highlighted, never run.
      if (decodeURIComponent(url.pathname).replace(/^\/+/, "") === MODULE_PATH && artifact.surface) {
        if (artifact.kind !== "code") return notFound("Not a module.");
        return new Response(artifact.content, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      }
      if (artifact.kind !== "html" && artifact.kind !== "app") return notFound("Not a page.");
      const file = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (file) {
        if (artifact.kind !== "app") return notFound("Not a file.");
        /* Tagged in with `<script src>`, never imported: a module is fetched, and the frame's
           opaque origin makes an app's own file cross-origin to itself. Measured — neither
           `supportFetchAPI` on the scheme nor `access-control-allow-origin` on this response
           changes it. So an app is classic scripts and globals, and a runtime it uses has to
           be one too. */
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
  credentials = new CredentialStore(app.getPath("userData"));
  folders = new FolderStore(app.getPath("userData"));
  attachments = new AttachmentStore(app.getPath("userData"));
  modelCatalog = new CatalogCache(app.getPath("userData"));
  startHost();
  fireEvent("launch");
  void host!.request({ method: "snapshot", params: {} }).catch(() => undefined);
  capabilities = new ImportedCapabilityRuntime(app.getPath("userData"));
  // `artifact` is preserved: it is the one bundled skill the user is invited to
  // tailor, so a copy they have edited survives the launch that reseeds the rest.
  void seedBuiltinSkills(builtinSkills(), app.getPath("userData"), path.join(app.getPath("userData"), "harness"), ["artifact"]).then(syncHarnessSkills);
  computerRuntime = new ComputerUseRuntime(nativeHelper());
  agents = new AgentRuntime({
    request: (method, params) => answerRequest(method, params),
    ask: (request: PermissionAsk) => {
      // Only the main window can answer, so a run started from the overlay raises it.
      if (!mainWindow || mainWindow.isDestroyed()) { agents!.answer(request.id, false); return; }
      needsYou("Emma needs your approval", request.summary);
      mainWindow.webContents.send("emma:permission-ask", request);
    },
    // The key never leaves main: `review` reads it out of the process environment
    // the credential store already mirrors into.
    // A change the Agent page is trialling on the verifier's rules is appended
    // for the half of turns whose arm carries it, and for nothing else.
    verify: (request, threadId) => {
      const lessons = verifierLessons(threadId);
      return review(lessons ? { ...verifier, system: `${verifier.system}\n\n${lessons}` } : verifier, request);
    },
    advise: (transcript) => advise(toolSettings.advisor, transcript),
    // A thread the loop spawned takes the same door every other surface takes,
    // so it runs on the harness whenever Emma is running on the harness. Its
    // folders are the owner's: a thread minted a moment ago has none of its
    // own, and the harness would otherwise put it in a scratch workspace
    // instead of the project.
    spawnTurn: (turn, owner) => {
      const context = owner ? threadContexts.get(owner) : undefined;
      if (context && !threadContexts.has(turn.threadId)) threadContexts.set(turn.threadId, { ...context });
      return driveTurn(turn);
    },
    changed: () => { broadcast("emma:agents", agents!.list()); broadcast("emma:spans", agents!.spans()); },
    step: (step) => broadcast("emma:step", step),
  });
  configureResearch({
    request: (method, params) => answerRequest(method, params),
    turn: (request) => driveTurn(request),
    stopTurn: (threadId) => agents!.stop(threadId),
    run: runCommand,
    attachProject,
    resolve: resolveMentions,
    // What the run that just finished counted, which is the loop's own tally of
    // this iteration: the host reports output tokens and the loop estimates the rest.
    usage: (threadId) => {
      const run = agents!.list().find((agent) => agent.threadId === threadId);
      return { inputTokens: run?.inputTokens ?? 0, outputTokens: run?.outputTokens ?? 0 };
    },
    catalogFile: path.join(app.getPath("userData"), "openrouter-catalog.json"),
    changed,
  });
  // Recovery: a job the store still calls running was interrupted by a quit or a
  // crash, and everything it needs to carry on is on disk.
  void resumeResearchJobs().catch((error: unknown) => console.error("Emma: could not resume the autoresearch jobs", error));
  ipcMain.handle("emma:request", async (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !trustedSender(event.senderFrame.url, app.getAppPath(), process.env.EMMA_DEV_SERVER_URL)) {
      throw new Error("IPC sender is not allowed");
    }
    // The `tools`/`screenContext` parameters are deliberately absent from the renderer
    // allowlist: only main's own surfaces may attach a picture of the screen to a turn.
    let request = validateRequest(value);
    if (request.method === "listOpenRouterModels") return answerRequest(request.method);
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
        // A picture of a screen says nothing about whose screen it is: the app the user
        // was in rides the same attached-context channel a folder or skill does.
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
      // Every turn asked from the notch carries what the user had in front when they
      // opened it. "Save this to my kb" is the whole sentence they type; without this
      // the model has no referent for "this" unless they also attached a screenshot.
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
      // Attached folders, files, and knowledge categories ride the same channel a skill
      // does; the host caps that channel, so the merge is truncated to fit it.
      if (request.params.attachedContext) {
        const { attachedContext, skillContext, ...params } = request.params;
        request = { method: request.method, params: { ...params, skillContext: mergeSkillContext(attachedContext, skillContext) } };
      }
      // Every surface's prompt becomes a full agent turn here rather than at its own
      // call site: the composer, Quick Ask, a quick action and a page chat all send
      // `sendMessage`, so one interception is what makes them all the same agent.
      const { threadId, content, ...extra } = request.params;
      // A learned skill only pays off if something reads it back, and an explicit
      // attachment always wins — `extra` is spread last.
      const result = request.method === "sendMessage"
        ? await driveTurn({ threadId, content, mode: threadMode(threadId), title: "This thread", model: threadModel(threadId), params: { ...await skillParams(content), ...extra } })
        : await answerRequest(request.method, request.params);
      // Core stores an autoresearch job's status; running one is this process's
      // business, so the flip that lands there is also what starts and stops a loop.
      if (request.method === "setResearchJobStatus") {
        if (request.params.status === "running") startResearchJob(request.params.jobId);
        else stopResearchJob(request.params.jobId);
      }
      if (request.method === "deleteResearchJob") stopResearchJob(request.params.jobId);
      delivered = true;
      if (screenClaimed) annotationAttachment.finish(screenContextId!, true);
      if (skillClaimed) skillAttachment.finish(skillAttachmentId!, true);
      if (!READ_ONLY_METHODS.has(request.method)) changed();
      return result;
    } finally {
      if (screenClaimed && !delivered) annotationAttachment.finish(screenContextId!, false);
      if (skillClaimed && !delivered) skillAttachment.finish(skillAttachmentId!, false);
    }
  });
  ipcMain.handle("emma:set-thread-context", (event, value: unknown) => {
    // The island has a permission picker of its own, so it sets the mode of the
    // thread it created the same way the composer sets the mode of an open one.
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== overlay?.webContents) mainWindowSender(event);
    const { threadId, ...context } = threadContextRequest(value);
    threadContexts.set(threadId, context);
    // A turn already in flight follows the picker rather than the mode it opened on.
    agents!.setMode(threadId, context.mode);
    return context.mode;
  });
  ipcMain.handle("emma:list-agents", (event) => {
    mainWindowSender(event);
    return agents!.list();
  });
  ipcMain.handle("emma:list-background", (event) => {
    mainWindowSender(event);
    return background.list();
  });
  /* Play, next to a command Emma printed. It runs verbatim, as a background task,
     so it streams into the transcript and stops from the same place a dev server
     does. Pressing play is the permission: the user is looking at the command. */
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
  /* The meta harness, from the renderer's side: the dock pinned above the thread
     and each run's own tab. Read-only apart from Stop — a run is *started* by an
     agent turn, which is where the permission question belongs. */
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
  ipcMain.handle("emma:installed-clis", (event) => {
    mainWindowSender(event);
    return clis.installed();
  });
  /* The user's own follow-up, typed into that run's tab. It starts a turn without
     a permission dialog on purpose: naming the run and pressing send is the
     consent, exactly as it is for Stop. The run's folder and its skip-approvals
     setting are fixed when it was created, so this cannot widen either. */
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
  ipcMain.handle("emma:browser-stream", async (event, value: unknown) => {
    mainWindowSender(event);
    return { port: await browsers.ensureStream(boundedCapabilityId(value, "Browser thread")) };
  });
  ipcMain.handle("emma:terminal-open", (event, value: unknown) => {
    mainWindowSender(event);
    const candidate = terminalRequest(value);
    const threadId = boundedCapabilityId(candidate.threadId, "Terminal thread");
    const { columns, rows } = terminalSize(candidate);
    return terminals.open({ threadId, cwd: folders!.directory(grantFor(threadId, undefined)), columns, rows });
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
  /** This turn's spans, so a panel that mounts mid-run is not blank until the next change. */
  ipcMain.handle("emma:list-spans", (event) => {
    mainWindowSender(event);
    return agents!.spans();
  });
  /** The turns already on the thread, as spans: what the inspector shows after a restart. */
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
    agents!.answer(answer.id, answer.allowed);
  });
  ipcMain.handle("emma:steer-agent", async (event, value: unknown) => {
    mainWindowSender(event);
    const request = agentMessage(value);
    const child = harnessChildren.get(request.threadId);
    if (!child) { agents!.steer(request.threadId, request.text); return; }
    if (!child.client.running) throw new Error("That subagent's harness is no longer running.");
    await child.client.steerChild(child.childId, request.text);
  });
  ipcMain.on("emma:stop-agent", (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || ![mainWindow?.webContents, runBanner?.webContents].includes(event.sender)) return;
    if (typeof value === "string") { stopThread(value); return; }
    agents!.stopAll();
    for (const threadId of harnessText.keys()) stopThread(threadId);
    for (const threadId of harnessChildren.keys()) stopThread(threadId);
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
    agents?.stopAll();
    computerRuntime?.abort("stopped by the user");
    closeRunBanner();
  });
  /* Auto mode's reviewer. Validated again here rather than trusted from the page:
     what arrives is the URL main will POST the user's prompt and the agent's
     command to, and the renderer is the one surface that is not main. */
  ipcMain.handle("emma:set-verifier", (event, value: unknown) => {
    mainWindowSender(event);
    verifier = validateVerifier(value);
    return verifier;
  });
  /* Settings → Models: the categorizer that files a thread under one of the user's
     own tags. Stateless, unlike the verifier — the route arrives with the request
     because nothing in main ever asks for a tag on its own — so it is validated on
     the way in for the same reason, and the tag goes back to the page that files it. */
  ipcMain.handle("emma:tag-thread", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object") throw new Error("The categorizer request is invalid");
    const request = value as { tagger?: unknown; text?: unknown; tags?: unknown; examples?: unknown };
    const line = (item: unknown) => (typeof item === "string" ? item.slice(0, MAX_TAGGER_TEXT_CHARS) : "");
    if (typeof request.text !== "string" || !Array.isArray(request.tags) || !Array.isArray(request.examples)) throw new Error("The categorizer request is invalid");
    return await tagThread(validateTagger(request.tagger), {
      text: line(request.text),
      tags: request.tags.slice(0, MAX_THREAD_TAGS).map(line).filter(Boolean),
      examples: request.examples.slice(0, MAX_THREAD_TAGS).map((item) => {
        const example = item as { tag?: unknown; text?: unknown };
        return { tag: line(example?.tag), text: line(example?.text) };
      }).filter((item) => item.tag && item.text),
    });
  });
  /* Settings → Tools. Validated here for the same reason the verifier is: it
     carries the advisor's endpoint and the search provider's, both of which main
     will POST to, and the renderer is the one surface that is not main. */
  ipcMain.handle("emma:set-tool-settings", (event, value: unknown) => {
    mainWindowSender(event);
    toolSettings = validateToolSettings(value);
    return toolSettings;
  });
  /* Settings → Harness. Validated here too: these numbers are handed straight to
     the harness as a config option, and the renderer is the one surface that is
     not main. They apply from the next turn — the harness reads them per prompt. */
  ipcMain.handle("emma:set-harness-experiments", (event, value: unknown) => {
    mainWindowSender(event);
    harnessExperiments = validateHarnessExperiments(value);
    return harnessExperiments;
  });
  /**
   * What the Agent page has changed about Emma: the lessons it kept, and the one
   * it is trialling. Main is told the whole record and keeps only what rides a
   * turn — the page owns the history, the receipts and the arithmetic.
   */
  ipcMain.handle("emma:set-improvements", (event, value: unknown) => {
    mainWindowSender(event);
    const store = validateImprovements(value);
    setImprovements(applied(store));
    return store;
  });
  /**
   * A path the model printed, clicked in the transcript. Revealing a file only
   * opens Finder on it — nothing is read, written or run — but a relative path
   * is still resolved against the granted folders rather than the process cwd,
   * so a click lands where the model was working.
   */
  ipcMain.handle("emma:reveal-path", (event, value: unknown) => {
    mainWindowSender(event);
    const found = namedPath(value);
    if (!found) return false;
    shell.showItemInFolder(found);
    return true;
  });
  /**
   * The same path, read for the in-app preview. Revealing a file is harmless, so
   * it takes any path that exists; showing its contents is a read, so it goes
   * through the folder grant that owns it — a path outside every grant comes
   * back with no text and the preview offers Finder instead.
   */
  ipcMain.handle("emma:preview-path", (event, value: unknown) => {
    mainWindowSender(event);
    const found = namedPath(value);
    if (!found) return null;
    const grant = folders!.list().find((folder) => found === folder.path || found.startsWith(folder.path + path.sep));
    // An attachment reads like a grant here. It is the user's own choice of file,
    // and it is what lets a file handed to one message open again from that message.
    const attached = !grant && attachments!.holds(found);
    if (!grant && !attached) return { path: found, text: null };
    try {
      // A picture is drawn, not quoted: `folders.read` is text-only, so a .png in a
      // connected folder used to come back as "Emma cannot read this" either way.
      if (isImageAttachment(found)) return { path: found, text: null, image: previewImage(found) };
      if (attached && statSync(found).size > MAX_FILE_BYTES) return { path: found, text: null };
      return { path: found, text: attached ? readFileSync(found, "utf8") : folders!.read(grant!.id, path.relative(grant!.path, found)).text };
    } catch {
      // Binary, too large, or gone since it was named: still worth a reveal.
      return { path: found, text: null };
    }
  });
  /* The plan widget, which only ever reads: a plan is written by the agent that
     is working through it, and the file is on disk for anyone who wants to edit it
     by hand. Whole plans rather than a summary — the section draws the graph and
     the tasks, and a plan is a few kilobytes of markdown. */
  ipcMain.handle("emma:list-plans", (event) => {
    panelSender(event);
    return listPlans(app.getPath("userData"));
  });
  /* The Artifacts page. It reaches the same store the `artifact` tool does, so an
     id typed here is checked exactly where one from the model is. */
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
  /* An app artifact's own database. The frame that asked never names one — the
     renderer answers for the artifact it is drawing — and the id is checked here
     exactly where one typed on the page and one from the model are. */
  ipcMain.handle("emma:artifact-sql", (event, value: unknown) => {
    panelSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Artifact query is invalid");
    const request = value as Record<string, unknown>;
    return queryArtifact(app.getPath("userData"), boundedCapabilityId(request.id, "Artifact"), request.sql, request.params);
  });
  ipcMain.handle("emma:list-folders", (event) => {
    mainWindowSender(event);
    return folders!.list();
  });
  ipcMain.handle("emma:plugin-catalog", (event) => {
    mainWindowSender(event);
    return readCatalog(app.getPath("userData"));
  });
  ipcMain.handle("emma:add-marketplace", async (event, value: unknown) => {
    mainWindowSender(event);
    const request = (value ?? {}) as Record<string, unknown>;
    return await addMarketplace(app.getPath("userData"), { source: request.source, ref: request.ref, sparse: request.sparse });
  });
  ipcMain.handle("emma:remove-marketplace", async (event, value: unknown) => {
    mainWindowSender(event);
    const catalog = await removeMarketplace(app.getPath("userData"), value);
    toolsChanged();
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
    toolsChanged();
    return catalog;
  });
  ipcMain.handle("emma:uninstall-plugin", async (event, value: unknown) => {
    mainWindowSender(event);
    const catalog = await uninstallPlugin(app.getPath("userData"), value);
    toolsChanged();
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
  /* Start fresh: the host's own root — threads, knowledge, scheduled and research —
     and userData, which is where credentials, folders, artifacts, plans, harness
     state and the renderer's storage all live. The Markdown mirror in Documents is
     the user's own folder, so it stays; nothing reads it back in. */
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
  ipcMain.handle("emma:set-knowledge-dir", async (event, value: unknown) => {
    mainWindowSender(event);
    if (value !== "pick" && value !== "default") throw new Error("Knowledge folder request is invalid");
    let directory = defaultKnowledgeDir();
    if (value === "pick") {
      const choice = await dialog.showOpenDialog(mainWindow!, { title: "Where should Emma keep your knowledge base?", defaultPath: readKnowledgeDir(app.getPath("userData")), buttonLabel: "Keep knowledge here", properties: ["openDirectory", "createDirectory"] });
      if (choice.canceled || !choice.filePaths[0]) return setupStatus();
      directory = choice.filePaths[0];
    }
    const moved = readKnowledgeDir(app.getPath("userData")) !== directory;
    saveKnowledgeDir(app.getPath("userData"), directory);
    // Restarting drops whatever turn is on the wire, so it happens only on a real move.
    if (moved) startHost();
    return setupStatus();
  });
  ipcMain.handle("emma:pick-folder", async (event) => {
    mainWindowSender(event);
    const choice = await dialog.showOpenDialog(mainWindow!, { title: "Connect a folder", properties: ["openDirectory", "createDirectory"] });
    if (choice.canceled || !choice.filePaths[0]) return folders!.list();
    return folders!.add(choice.filePaths[0]);
  });
  ipcMain.handle("emma:forget-folder", (event, value: unknown) => {
    mainWindowSender(event);
    return folders!.remove(boundedCapabilityId(value, "Folder"));
  });
  ipcMain.handle("emma:git-status", async (event, value: unknown) => {
    mainWindowSender(event);
    return await gitSnapshot(folders!.directory(boundedCapabilityId(value, "Folder")));
  });
  ipcMain.handle("emma:list-editors", (event) => {
    mainWindowSender(event);
    return installedEditors();
  });
  // Named by grant and relative path like every other file call here, so the editor
  // is handed a path inside the folder the user granted or nothing at all.
  ipcMain.handle("emma:open-in-editor", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Editor request is invalid");
    const request = value as Record<string, unknown>;
    const editorId = boundedCapabilityId(request.editorId, "Editor");
    // No folder means no grant to resolve within, so the only path that opens is
    // one the user attached themselves — the same key the preview turns.
    if (request.folderId === undefined) {
      const file = namedPath(request.path);
      const grant = file && folders!.list().some((folder) => file === folder.path || file.startsWith(folder.path + path.sep));
      // Attached, or inside a connected folder. The preview names a path without
      // knowing which it is, so this asks exactly what the preview itself asks.
      if (!file || (!grant && !attachments!.holds(file))) throw new Error("That file is not open to Emma.");
      await openInEditor(editorId, file);
      return;
    }
    const folderId = boundedCapabilityId(request.folderId, "Folder");
    const root = folders!.directory(folderId);
    const relative = folders!.within(folderId, boundedCapabilityId(request.path, "File path"));
    await openInEditor(editorId, path.join(root, relative));
  });
  // Checks out a branch in the thread's folder, creating it from HEAD when asked. Work
  // in progress comes along, as it does on the command line; git refuses the move itself
  // when it cannot carry it, and that refusal is what the composer shows.
  ipcMain.handle("emma:set-branch", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Branch request is invalid");
    const request = value as Record<string, unknown>;
    const cwd = folders!.directory(boundedCapabilityId(request.folderId, "Folder"));
    await switchBranch(cwd, boundedCapabilityId(request.branch, "Branch"), request.create === true);
    // The same signal a write sends: every git view in the renderer re-reads itself.
    changed();
  });
  // Moves a thread between a repo's main checkout and a worktree of it. Both ends are
  // folders the user already granted, or derived from one, so this widens nothing: the
  // new checkout is granted the same way the picker grants one, and named by ID after.
  ipcMain.handle("emma:set-worktree", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Worktree request is invalid");
    const request = value as Record<string, unknown>;
    const cwd = folders!.directory(boundedCapabilityId(request.folderId, "Folder"));
    const name = boundedCapabilityId(request.name, "Worktree name");
    // The name becomes a branch and a directory beside the repo, so it stays in an
    // alphabet neither git nor a path walk can read as anything else.
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
  /* Files attached to one message: code, a CSV, notes, a screenshot. The dialog
     is main's, so these paths are the user's own choice and no renderer names one. */
  ipcMain.handle("emma:attach-files", async (event) => {
    mainWindowSender(event);
    const choice = await dialog.showOpenDialog(mainWindow!, { title: "Attach files", properties: ["openFile", "multiSelections"] });
    if (choice.canceled) return [];
    return choice.filePaths.map((file) => held(attachments!.hold(file)));
  });
  /* The other door, and the only one a drop or a paste can take: a dropped file
     reaches the renderer as contents without a path, so the contents are what
     crosses, and main writes them where the tools can reach them. */
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
  ipcMain.handle("emma:import-agent-sources", (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== mainWindow?.webContents || !Array.isArray(value) || value.length > 8 || value.some((id) => typeof id !== "string")) throw new Error("Import selection is invalid");
    const saved = saveImportManifest(app.getPath("userData"), homedir(), value);
    toolsChanged();
    return saved;
  });
  ipcMain.handle("emma:search-imported-skills", async (event, value: unknown) => {
    mainWindowSender(event);
    const query = boundedCapabilityQuery(value, "Skill search");
    const found = await capabilities!.searchSkills(query.query, query.limit);
    return found.filter((skill) => !toolSettings.disabledSkills.includes(skill.id));
  });
  /* The unfiltered lists, for the one screen whose whole job is switching them off.
     Everywhere else sees the filtered ones, which is what makes the switch mean
     something rather than only hiding a row in Settings.

     Read live rather than from a constant because Emma writes her own tools and
     her own skills mid-turn: `toolsChanged()` fires when she does, and Settings
     re-reads this. A page that needed a relaunch would be a page that is wrong
     for exactly as long as the session lasts. */
  ipcMain.handle("emma:list-tool-targets", async (event) => {
    mainWindowSender(event);
    return {
      written: (await listEmmaTools(app.getPath("userData"))).map((tool) => ({ id: `run_tool:${tool.name}`, name: tool.name, source: tool.description })),
      skills: await capabilities!.searchSkills("", 64),
      servers: await capabilities!.listMcpServers(),
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
  // The harness reads the flag from its spawn environment, so a change recycles the
  // idle ones the same way a pasted key does — otherwise the header keeps going out
  // the old way on every session that was already up.
  ipcMain.handle("emma:set-zero-retention", (event, value: unknown) => {
    mainWindowSender(event);
    if (typeof value !== "boolean") throw new Error("The zero-retention preference must be a boolean");
    if ((process.env.EMMA_OPENROUTER_ZDR !== undefined) === value) return;
    if (value) process.env.EMMA_OPENROUTER_ZDR = "1";
    else delete process.env.EMMA_OPENROUTER_ZDR;
    recycleHarnesses();
  });
  // Only masks cross back to the renderer; the plaintext never leaves main.
  ipcMain.handle("emma:list-credentials", (event) => {
    mainWindowSender(event);
    return credentials!.list();
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
  // Reading a link the user typed into the capture dialog. Text only, size
  // capped, no cookies: the page becomes captured text, nothing else.
  ipcMain.handle("emma:fetch-url", async (event, value: unknown) => {
    mainWindowSender(event);
    if (typeof value !== "string") throw new Error("Only http and https links can be read");
    const { title, text } = await fetchReadablePage(value);
    return { title, text };
  });
  // Clips the page the browser had in front when Quick Ask opened: its text, its favicon,
  // and the pictures it leads with. Emma has to step out of the way to see who was in front.
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
  // Screenshot-as-context: capture without the drawing step, hiding Emma's own surfaces first.
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
  // Captured on demand, with the drawing sheet hidden, so the frame matches what the user drew over.
  ipcMain.handle("emma:get-screen-annotation-frame", async (event) => {
    const window = annotation;
    if (!window || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents || !annotationDisplay) throw new Error("Screen annotation frame is unavailable");
    window.hide();
    try {
      await pause(120);
      // The sheet is hidden here, so this is also the moment the real front app is visible.
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
  // The island extends as the quick thread grows; past the cap the transcript scrolls instead.
  ipcMain.on("emma:set-overlay-height", (event, value: unknown) => {
    const window = overlay;
    if (!window || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents) return;
    overlayGrow = overlayGrowth(value);
    // A chip is 44 points square whatever the thread inside it has grown to; the
    // measurement is still kept, because that is the size it reopens at.
    if (overlaySurface === "pill") return;
    const bounds = window.getBounds();
    const height = overlayBaseHeight + overlayGrow;
    if (bounds.height !== height) window.setBounds({ ...bounds, height });
  });
  // The chip is the user's to park: the window follows the pointer that is dragging it.
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
  // The chip faded out after its green: the turn landed, nothing is left to show, and
  // the renderer nothing is running in can go. A turn started during the fade keeps it.
  ipcMain.on("emma:dismiss-overlay", (event) => {
    const window = overlay;
    if (!window || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents || overlaySurface !== "pill" || overlayBusy) return;
    window.destroy();
  });
  ipcMain.on("emma:open-workspace", (event, value: unknown) => {
    const window = overlay;
    if (!window || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents) return;
    // A settings page the island asked for: how "voice is not set up yet" from the
    // notch lands on the page that sets it up, rather than on whatever was last open.
    if (typeof value === "string" && /^[a-z]{1,16}$/.test(value)) openSettingsPage(value);
    else openMain();
    closeOverlay(window);
  });
  // The workspace has noticed it is laid out wider than the window it is in: the
  // frame measured against the wrong viewport that `load` warns about, arrived at
  // some other way — a resize the window was asleep for, a display swapped under
  // it. Whatever put it there, one real resize is what clears it, which is why
  // dragging the window has always been the fix by hand. This is that drag. The
  // pixel goes back a frame later rather than in the same tick, because two sizes
  // set together collapse into the one the renderer already believes it has.
  let resyncing = false;
  ipcMain.on("emma:resync-window", (event) => {
    const window = mainWindow;
    if (!window || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame || event.sender !== window.webContents) return;
    // One at a time, and the pixel only comes back off a window still wearing it:
    // a second ask landing mid-drag would measure the pixel as the real width and
    // give it back a wider window every time, and a user dragging the edge during
    // those 50ms owns the size, not this.
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
  globalShortcut.unregisterAll();
  clearInterval(hotspotTimer);
  hotkeyHelper?.kill();
  computerRuntime?.abort("app quit");
  // Emma started them, so Emma takes them with it: a dev server left holding a
  // port after the app is gone is nobody's to find.
  background.stopAll();
  clis.stopAll();
  browsers.stopAll();
  terminals.stopAll();
  skillAttachment.clearAll();
  for (const client of harnesses.values()) client.close();
  harnesses.clear();
  host?.close();
});
