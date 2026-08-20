import { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen, session, shell, systemPreferences, type Display } from "electron";
import { Buffer } from "node:buffer";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { externalUrl, MAX_SCREEN_CONTEXT_CHARS, trustedSender, validJpegDataUrl, validateRequest } from "./ipc";
import { discoverImports, saveImportManifest } from "./imports";
import { loadUiPlugins } from "./plugins";
import { overlayBounds } from "./overlay";
import { BoundedLines, parseHostResponse } from "./ndjson";
import { ImportedCapabilityRuntime, SkillAttachmentStore } from "./capabilities";
import { defaultSettings, validateOverlayPreferences, type OverlayPreferences } from "../shared/settings";
import { ScreenContextStore, validateScreenStrokes, type ScreenStroke } from "../shared/screen-context";

// ponytail: whole snapshots cap at 16 MiB; paginate the host protocol before raising it.
const MAX_HOST_RESPONSE_BYTES = 16 * 1024 * 1024;

class Host {
  private child: ChildProcessWithoutNullStreams;
  private lines = new BoundedLines(MAX_HOST_RESPONSE_BYTES);
  private nextId = 1;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private failure: Error | null = null;

  constructor(binary: string, agent: string) {
    this.child = spawn(binary, [], { env: { ...process.env, EMMA_AGENT_BIN: agent }, stdio: ["pipe", "pipe", "pipe"] });
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
      const response = parseHostResponse(line);
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
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
  }
}

let host: Host | undefined;
let capabilities: ImportedCapabilityRuntime | undefined;
const skillAttachment = new SkillAttachmentStore();
let hotkeyHelper: ChildProcess | undefined;
let mainWindow: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let annotation: BrowserWindow | null = null;
let annotationFrame: { image: string; width: number; height: number } | null = null;
const annotationAttachment = new ScreenContextStore();
let annotating = false;
let overlayPreferences: OverlayPreferences = { overlayPlacement: defaultSettings.overlayPlacement, notchGap: defaultSettings.notchGap };
let overlayPreferencesReady = false;
let queuedOverlayToggle = false;
let overlayBusy = false;
let closeOverlayWhenIdle = false;

const preload = path.join(__dirname, "preload.js");
const renderer = path.join(app.getAppPath(), "dist-renderer/index.html");

function binary(name: string) {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(app.getAppPath(), "..", name === "emma-host" ? "target/debug/emma-host" : "agent/zig-out/bin/emma-agent");
}

function startQuickAskHotkey() {
  if (process.platform !== "darwin") return;
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, "emma-option-tap")
    : path.join(app.getAppPath(), "dist-native/emma-option-tap");
  const child = spawn(executable, [], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = new BoundedLines(16);
  hotkeyHelper = child;
  child.stdout?.on("data", (data: Buffer) => {
    try {
      for (const line of lines.push(data)) {
        if (line !== "toggle") throw new Error("invalid Quick Ask hotkey event");
        toggleOverlay();
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

function secureWindow(options: Electron.BrowserWindowConstructorOptions) {
  const window = new BrowserWindow({
    backgroundColor: "#090a09",
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

async function load(window: BrowserWindow, mode: "main" | "overlay" | "annotation" = "main") {
  try {
    const dev = process.env.EMMA_DEV_SERVER_URL;
    const query = mode === "main" ? "" : `?${mode}=1`;
    if (dev) await window.loadURL(`${dev}${query}`);
    else await window.loadFile(renderer, mode === "main" ? undefined : { query: { [mode]: "1" } });
    if (!window.isDestroyed()) window.show();
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
    backgroundColor: "#00000000",
    width: 1380,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 17 },
    vibrancy: "under-window",
    visualEffectState: "active",
  });
  mainWindow.on("closed", () => (mainWindow = null));
  void load(mainWindow);
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

function toggleOverlay() {
  if (annotating) {
    closeAnnotation();
    return;
  }
  if (!overlayPreferencesReady) {
    queuedOverlayToggle = true;
    return;
  }
  if (overlay) {
    closeOverlay(overlay);
    return;
  }
  overlayBusy = false;
  closeOverlayWhenIdle = false;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = overlayBounds(display, overlayPreferences);
  const window = secureWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    roundedCorners: overlayPreferences.overlayPlacement === "below",
  });
  overlay = window;
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.on("blur", () => { if (!annotating) closeOverlay(window); });
  window.on("closed", () => {
    if (overlay === window) overlay = null;
    annotationAttachment.clearAll();
    overlayBusy = false;
    closeOverlayWhenIdle = false;
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (input.key === "Escape") {
      event.preventDefault();
      closeOverlay(window);
    }
  });
  void load(window, "overlay");
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function captureDisplay(display: Display) {
  if (process.platform === "darwin" && ["denied", "restricted"].includes(systemPreferences.getMediaAccessStatus("screen"))) {
    throw new Error("Screen Recording permission is required. Enable Emma in System Settings → Privacy & Security → Screen Recording.");
  }
  const width = Math.min(2560, Math.round(display.bounds.width * display.scaleFactor));
  const height = Math.min(1600, Math.round(display.bounds.height * display.scaleFactor));
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height }, fetchWindowIcons: false });
  const source = sources.find((item) => item.display_id === String(display.id));
  if (!source || source.thumbnail.isEmpty()) throw new Error("Emma could not capture this display. Check Screen Recording permission and try again.");
  const size = source.thumbnail.getSize();
  const image = `data:image/jpeg;base64,${source.thumbnail.toJPEG(82).toString("base64")}`;
  if (!validJpegDataUrl(image)) throw new Error("Emma captured an invalid screen frame");
  return { image, width: size.width, height: size.height };
}

function composeScreenContext(strokes: unknown) {
  const frame = annotationFrame;
  if (!frame || !validJpegDataUrl(frame.image)) throw new Error("Annotated screen frame is unavailable");
  const paths = validateScreenStrokes(strokes, frame.width, frame.height).map((stroke: ScreenStroke) => {
    const [first, ...rest] = stroke;
    return `<path d="M ${first.x} ${first.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(" ")}" fill="none" stroke="#ffe84f" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>`;
  }).join("");
  const encodedFrame = frame.image.slice("data:image/jpeg;base64,".length);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}" viewBox="0 0 ${frame.width} ${frame.height}"><defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><image href="data:image/jpeg;base64,${encodedFrame}" width="${frame.width}" height="${frame.height}"/><g>${paths}</g></svg>`;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  if (image.isEmpty()) throw new Error("Annotated screen could not be composited");
  const size = image.getSize();
  for (const width of [Math.min(size.width, 1440), 1200, 960, 720]) {
    for (const quality of [68, 54, 42, 32]) {
      const jpeg = image.resize({ width, quality: "good" }).toJPEG(quality);
      const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
      if (validJpegDataUrl(dataUrl, MAX_SCREEN_CONTEXT_CHARS)) return dataUrl;
    }
  }
  throw new Error("Annotated screen could not be compressed safely");
}

function restoreOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.show();
  overlay.focus();
}

function closeAnnotation() {
  annotating = false;
  annotationFrame = null;
  if (annotation && !annotation.isDestroyed()) annotation.destroy();
  else restoreOverlay();
}

function mainWindowSender(event: Electron.IpcMainInvokeEvent) {
  if (event.senderFrame !== event.sender.mainFrame || event.sender !== mainWindow?.webContents) throw new Error("Capability sender is not allowed");
}

function boundedCapabilityQuery(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.query !== "string" || candidate.query.length > 256) throw new Error(`${label} is invalid`);
  const rawLimit = candidate.limit;
  const limit = rawLimit === undefined ? 16 : rawLimit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error(`${label} is invalid`);
  return { query: candidate.query, limit };
}

function boundedCapabilityId(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new Error(`${label} is invalid`);
  return value;
}

async function startAnnotation() {
  if (!overlay || overlay.isDestroyed() || annotating) return;
  annotating = true;
  overlay.hide();
  try {
    await pause(100);
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const frame = await captureDisplay(display);
    if (!annotating) return;
    annotationFrame = frame;
    const window = secureWindow({
      ...display.bounds,
      frame: false,
      backgroundColor: "#050605",
      resizable: false,
      minimizable: false,
      maximizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
    });
    annotation = window;
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.on("closed", () => {
      if (annotation === window) annotation = null;
      annotating = false;
      annotationFrame = null;
      restoreOverlay();
    });
    void load(window, "annotation");
  } catch (error) {
    annotating = false;
    annotationFrame = null;
    restoreOverlay();
    throw error;
  }
}

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else app.on("second-instance", () => { void app.whenReady().then(openMain); });

if (primaryInstance) app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  host = new Host(binary("emma-host"), binary("emma-agent"));
  capabilities = new ImportedCapabilityRuntime(app.getPath("userData"));
  ipcMain.handle("emma:request", async (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !trustedSender(event.senderFrame.url, app.getAppPath(), process.env.EMMA_DEV_SERVER_URL)) {
      throw new Error("IPC sender is not allowed");
    }
    let request = validateRequest(value);
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
        request = {
          method: request.method,
          params: { threadId: request.params.threadId, content: request.params.content, screenContext: attachment.image },
        };
      }
      if (skillAttachmentId) {
        const skill = skillAttachment.claim(skillAttachmentId, request.params.threadId);
        skillClaimed = true;
        request = {
          method: request.method,
          params: { threadId: request.params.threadId, content: request.params.content, ...(request.params.screenContext ? { screenContext: request.params.screenContext } : {}), skillContext: skill.instructions },
        };
      }
      const result = await host!.request(request);
      delivered = true;
      if (screenClaimed) annotationAttachment.finish(screenContextId!, true);
      if (skillClaimed) skillAttachment.finish(skillAttachmentId!, true);
      if (!(["snapshot", "listOpenRouterModels"] as string[]).includes(request.method)) {
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send("emma:changed");
      }
      return result;
    } finally {
      if (screenClaimed && !delivered) annotationAttachment.finish(screenContextId!, false);
      if (skillClaimed && !delivered) skillAttachment.finish(skillAttachmentId!, false);
    }
  });
  ipcMain.handle("emma:discover-agent-imports", (event) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== mainWindow?.webContents) throw new Error("Import discovery sender is not allowed");
    return discoverImports(homedir());
  });
  ipcMain.handle("emma:import-agent-sources", (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== mainWindow?.webContents || !Array.isArray(value) || value.length > 8 || value.some((id) => typeof id !== "string")) throw new Error("Import selection is invalid");
    return saveImportManifest(app.getPath("userData"), homedir(), value);
  });
  ipcMain.handle("emma:search-imported-skills", async (event, value: unknown) => {
    mainWindowSender(event);
    const query = boundedCapabilityQuery(value, "Skill search");
    return capabilities!.searchSkills(query.query, query.limit);
  });
  ipcMain.handle("emma:select-imported-skill", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Skill selection is invalid");
    const candidate = value as Record<string, unknown>;
    const id = boundedCapabilityId(candidate.id, "Skill selection");
    const threadId = boundedCapabilityId(candidate.threadId, "Skill attachment thread");
    const skill = await capabilities!.selectSkill(id);
    skillAttachment.put(skill, threadId);
    return { id: skill.id, source: skill.source, name: skill.name, threadId };
  });
  ipcMain.handle("emma:imported-skill-status", (event) => {
    mainWindowSender(event);
    return skillAttachment.status();
  });
  ipcMain.handle("emma:clear-imported-skill", (event, value: unknown) => {
    mainWindowSender(event);
    skillAttachment.clear(boundedCapabilityId(value, "Skill attachment"));
  });
  ipcMain.handle("emma:list-imported-mcp-servers", (event) => {
    mainWindowSender(event);
    return capabilities!.listMcpServers();
  });
  ipcMain.handle("emma:review-imported-mcp-server", async (event, value: unknown) => {
    mainWindowSender(event);
    return capabilities!.permissionReview(boundedCapabilityId(value, "MCP server selection"));
  });
  ipcMain.handle("emma:connect-imported-mcp-server", async (event, value: unknown) => {
    mainWindowSender(event);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP connection is invalid");
    const candidate = value as Record<string, unknown>;
    return capabilities!.connect(boundedCapabilityId(candidate.serverId, "MCP server selection"), boundedCapabilityId(candidate.token, "MCP permission token"));
  });
  ipcMain.handle("emma:search-mcp-tools", async (event, value: unknown) => {
    mainWindowSender(event);
    const query = boundedCapabilityQuery(value, "MCP tool search");
    return capabilities!.searchTools(query.query, query.limit);
  });
  ipcMain.handle("emma:select-mcp-tool", (event, value: unknown) => {
    mainWindowSender(event);
    return capabilities!.selectTool(boundedCapabilityId(value, "MCP tool selection"));
  });
  ipcMain.handle("emma:call-mcp-tool", async (event, value: unknown) => {
    mainWindowSender(event);
    if (typeof value !== "string" || value.length === 0 || value.length > 64 * 1024) throw new Error("MCP tool arguments are invalid");
    let args: unknown;
    try { args = JSON.parse(value); } catch (error) { throw new Error("MCP tool arguments must be valid JSON", { cause: error }); }
    return capabilities!.callTool(args);
  });
  ipcMain.handle("emma:close-imported-mcp-server", (event) => {
    mainWindowSender(event);
    return capabilities!.close();
  });
  ipcMain.handle("emma:load-ui-plugins", (event) => {
    if (event.senderFrame !== event.sender.mainFrame || !trustedSender(event.senderFrame.url, app.getAppPath(), process.env.EMMA_DEV_SERVER_URL)) throw new Error("UI plugin sender is not allowed");
    return loadUiPlugins(app.getPath("userData"));
  });
  ipcMain.handle("emma:start-screen-annotation", async (event) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== overlay?.webContents) throw new Error("Screen annotation is available only from the quick overlay");
    await startAnnotation();
  });
  ipcMain.handle("emma:get-screen-annotation-frame", (event) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== annotation?.webContents || !annotationFrame) throw new Error("Screen annotation frame is unavailable");
    return annotationFrame;
  });
  ipcMain.handle("emma:finish-screen-annotation", (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== annotation?.webContents) throw new Error("Screen annotation sender is not allowed");
    annotationAttachment.put({ id: randomUUID(), image: composeScreenContext(value) });
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
      if (queuedOverlayToggle) {
        queuedOverlayToggle = false;
        toggleOverlay();
      }
    }
    catch { console.error("Emma: invalid overlay settings"); }
  });
  ipcMain.on("emma:set-overlay-mouse-passthrough", (event, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender !== overlay?.webContents || typeof value !== "boolean") return;
    overlay.setIgnoreMouseEvents(value && overlayPreferences.overlayPlacement === "rails", { forward: true });
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
  startQuickAskHotkey();
  app.on("activate", openMain);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => {
  hotkeyHelper?.kill();
  skillAttachment.clearAll();
  void capabilities?.close();
  host?.close();
});
