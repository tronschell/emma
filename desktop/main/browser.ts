import { app, WebContentsView, type BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { recentClips, rememberClip, restoreClip } from "./clip";
import { externalUrl } from "./ipc";
import { MAX_TOOL_OUTPUT_BYTES } from "./tools";

export const INSTALL_COMMAND = "npm install -g agent-browser && agent-browser install";

export type BrowserTab = { id: string; url: string; title: string; favicon?: string; loading: boolean };
export type BrowserStatus = {
  running: boolean;
  url?: string;
  title?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  activeTab?: string;
  tabs: BrowserTab[];
};
export type BrowserBounds = { x: number; y: number; width: number; height: number };

const NAVIGATIONS = ["back", "forward", "reload", "close"] as const;
type Navigation = (typeof NAVIGATIONS)[number];

const MAX_COMMAND_MS = 60_000;
const RESOLVE_MS = 5_000;
const RECHECK_MS = 15_000;
const DRAIN_MS = 100;
const MAX_STDERR = 4 * 1024;
const MAX_SESSION_CHARS = 48;
const MAX_TABS = 12;
const HOME = "about:blank";
const CLIP_SETTLE_MS = 150;
const CLIP_KEYS = ["c", "x", "v"];
const TRUNCATION_NOTICE = "\n[truncated — read less at a time: snapshot with interactive true, or narrow it with a selector]";

export type Ran = { text: string; code: number | null; signal: NodeJS.Signals | null };
type Tab = { id: string; view: WebContentsView; targetId?: string; favicon?: string };
type Session = { name: string; threadId: string; tabs: Tab[]; activeId?: string; bounds?: BrowserBounds; shown: boolean; connected?: Promise<void>; pinned?: string };

export class Browsers {
  private sessions = new Map<string, Session>();
  private window: BrowserWindow | null = null;
  private path: string | null = null;
  private lookup?: Promise<string | null>;
  private port?: Promise<number | null>;
  private expires = 0;
  private loginPath?: string;
  private counter = 0;

  constructor(private readonly onChange: () => void) {}

  attach(window: BrowserWindow) {
    this.window = window;
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });
  }

  status(threadId: string): BrowserStatus {
    const session = this.sessions.get(sessionName(threadId));
    const active = session && this.active(session);
    if (!session?.tabs.length || !active) return { running: false, loading: false, canGoBack: false, canGoForward: false, tabs: [] };
    const contents = active.view.webContents;
    return {
      running: true,
      url: contents.getURL() || undefined,
      title: contents.getTitle() || undefined,
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      activeTab: active.id,
      tabs: session.tabs.map((tab) => ({
        id: tab.id,
        url: tab.view.webContents.getURL(),
        title: tab.view.webContents.getTitle(),
        favicon: tab.favicon,
        loading: tab.view.webContents.isLoading(),
      })),
    };
  }

  async open(threadId: string, url: string): Promise<BrowserStatus> {
    const target = externalUrl(url);
    if (!target) throw new Error(`Emma's browser opens http and https addresses only, and ${url.slice(0, 120)} is neither.`);
    const session = this.session(threadId);
    const tab = this.active(session) ?? this.spawnTab(session);
    await tab.view.webContents.loadURL(target.href).catch(() => undefined);
    this.onChange();
    return this.status(threadId);
  }

  async newTab(threadId: string, url?: string): Promise<BrowserStatus> {
    const session = this.session(threadId);
    if (session.tabs.length >= MAX_TABS) throw new Error(`Emma's browser holds ${MAX_TABS} tabs at once. Close one first.`);
    const tab = this.spawnTab(session);
    const target = url ? externalUrl(url) : null;
    if (url && !target) throw new Error(`Emma's browser opens http and https addresses only, and ${url.slice(0, 120)} is neither.`);
    await tab.view.webContents.loadURL(target ? target.href : HOME).catch(() => undefined);
    this.onChange();
    return this.status(threadId);
  }

  selectTab(threadId: string, tabId: string): BrowserStatus {
    const session = this.session(threadId);
    if (!session.tabs.some((tab) => tab.id === tabId)) throw new Error("That browser tab is already gone.");
    session.activeId = tabId;
    this.layout(session);
    this.onChange();
    return this.status(threadId);
  }

  closeTab(threadId: string, tabId: string): BrowserStatus {
    const session = this.session(threadId);
    const index = session.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return this.status(threadId);
    this.destroyTab(session, session.tabs[index]!);
    session.tabs.splice(index, 1);
    if (session.activeId === tabId) session.activeId = session.tabs[Math.min(index, session.tabs.length - 1)]?.id;
    if (!session.tabs.length) this.forget(session);
    else this.layout(session);
    this.onChange();
    return this.status(threadId);
  }

  async navigate(threadId: string, action: Navigation): Promise<BrowserStatus> {
    if (!NAVIGATIONS.includes(action)) throw new Error(`Emma's browser has no "${String(action).slice(0, 32)}" navigation.`);
    const session = this.session(threadId);
    if (action === "close") {
      for (const tab of session.tabs) this.destroyTab(session, tab);
      session.tabs = [];
      this.forget(session);
      this.onChange();
      return this.status(threadId);
    }
    const contents = this.active(session)?.view.webContents;
    if (!contents) return this.status(threadId);
    if (action === "reload") contents.reload();
    if (action === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (action === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    this.onChange();
    return this.status(threadId);
  }

  place(threadId: string, bounds: BrowserBounds | null) {
    const session = this.sessions.get(sessionName(threadId));
    if (!session) return;
    session.shown = bounds !== null;
    if (bounds) session.bounds = bounds;
    this.layout(session);
  }

  hideAllExcept(threadId: string) {
    const keep = sessionName(threadId);
    for (const [name, session] of this.sessions) {
      if (name === keep) continue;
      session.shown = false;
      this.layout(session);
    }
  }

  clips(): string[] {
    return recentClips();
  }

  reuseClip(threadId: string, index: number) {
    const text = restoreClip(index);
    if (text === undefined) throw new Error("That clipboard item is gone.");
    const session = this.sessions.get(sessionName(threadId));
    const contents = session && this.active(session)?.view.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.focus();
    contents.paste();
  }

  async run(threadId: string, argv: readonly string[]): Promise<string> {
    const session = this.session(threadId);
    const tab = this.active(session) ?? this.spawnTab(session);
    await this.pin(session, tab);
    return bounded((await this.exec(session, argv)).text);
  }

  stopAll() {
    for (const session of this.sessions.values()) {
      for (const tab of session.tabs) this.destroyTab(session, tab);
      session.tabs = [];
    }
    this.sessions.clear();
  }

  private session(threadId: string): Session {
    const name = sessionName(threadId);
    const known = this.sessions.get(name);
    if (known) return known;
    const created: Session = { name, threadId, tabs: [], shown: true };
    this.sessions.set(name, created);
    return created;
  }

  private active(session: Session): Tab | undefined {
    return session.tabs.find((tab) => tab.id === session.activeId) ?? session.tabs[0];
  }

  private spawnTab(session: Session): Tab {
    this.counter += 1;
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    const tab: Tab = { id: `t${this.counter}`, view };
    const contents = view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (externalUrl(url) && session.tabs.length < MAX_TABS) void this.newTab(session.threadId, url);
      return { action: "deny" };
    });
    contents.on("before-input-event", (_event, input) => {
      if (input.type !== "keyUp" || !input.meta || input.control || input.alt) return;
      if (!CLIP_KEYS.includes(input.key.toLowerCase())) return;
      setTimeout(rememberClip, CLIP_SETTLE_MS).unref();
    });
    contents.on("page-favicon-updated", (_event, icons) => {
      tab.favicon = icons.find((icon) => icon.startsWith("https://") || icon.startsWith("http://"));
      this.onChange();
    });
    const changed = () => this.onChange();
    contents.on("did-navigate", changed);
    contents.on("did-navigate-in-page", changed);
    contents.on("page-title-updated", changed);
    contents.on("did-start-loading", changed);
    contents.on("did-stop-loading", changed);
    session.tabs.push(tab);
    session.activeId = tab.id;
    this.window?.contentView.addChildView(view);
    this.layout(session);
    return tab;
  }

  private destroyTab(session: Session, tab: Tab) {
    session.connected = undefined;
    session.pinned = undefined;
    try {
      this.window?.contentView.removeChildView(tab.view);
    } catch {
      /* the window is already gone */
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }

  private forget(session: Session) {
    session.connected = undefined;
    session.pinned = undefined;
    session.activeId = undefined;
    this.sessions.delete(session.name);
    if (this.path) spawn(this.path, ["--session", session.name, "close"], { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
  }

  private layout(session: Session) {
    const active = this.active(session);
    const zoom = this.window?.webContents.getZoomFactor() ?? 1;
    for (const tab of session.tabs) {
      const shows = session.shown && !!session.bounds && tab.id === active?.id;
      tab.view.setVisible(shows);
      if (shows && session.bounds) tab.view.setBounds(whole(session.bounds, zoom));
    }
  }

  private async pin(session: Session, tab: Tab) {
    const port = await this.cdpPort();
    if (port === null) throw new Error("Emma could not open a debugging port for its browser, so the agent cannot drive it.");
    session.connected ??= this.exec(session, ["connect", String(port)])
      .then((ran) => attached(ran, `connect to Emma's browser on port ${port}`))
      .catch((error: unknown) => {
        session.connected = undefined;
        throw error;
      });
    await session.connected;
    const targetId = (tab.targetId ??= await targetOf(tab));
    if (session.pinned === targetId) return;
    attached(await this.exec(session, ["tab", targetId, "--pin-tab"]), "pin itself to the tab in Emma's browser pane");
    session.pinned = targetId;
  }

  private cdpPort(): Promise<number | null> {
    this.port ??= readFile(join(app.getPath("userData"), "DevToolsActivePort"), "utf8")
      .then((body) => {
        const port = Number(body.split("\n")[0]);
        return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
      })
      .catch(() => null);
    return this.port;
  }

  private async exec(session: Session, argv: readonly string[]): Promise<Ran> {
    const binary = await this.binary();
    if (!binary) throw new Error(`agent-browser is not installed on this Mac, so the agent cannot drive Emma's browser. The pane still works. Install it by running: ${INSTALL_COMMAND}`);
    return capture(binary, ["--session", session.name, ...argv], this.loginPath ?? process.env.PATH ?? "");
  }

  private binary(): Promise<string | null> {
    if (this.lookup && Date.now() < this.expires) return this.lookup;
    this.expires = Number.MAX_SAFE_INTEGER;
    this.lookup = this.find();
    void this.lookup.then((found) => {
      if (!found) this.expires = Date.now() + RECHECK_MS;
    });
    return this.lookup;
  }

  private async find(): Promise<string | null> {
    this.loginPath ??= (await shell('printf %s "$PATH"')) || process.env.PATH || "";
    const found = await shell("command -v agent-browser");
    this.path = found.startsWith("/") ? found : null;
    return this.path;
  }
}

async function targetOf(tab: Tab): Promise<string> {
  const contents = tab.view.webContents;
  if (contents.debugger.isAttached()) contents.debugger.detach();
  contents.debugger.attach("1.3");
  try {
    const info = await contents.debugger.sendCommand("Target.getTargetInfo") as { targetInfo?: { targetId?: unknown } };
    const id = info.targetInfo?.targetId;
    if (typeof id !== "string" || !/^[0-9A-F]{8,}$/i.test(id)) throw new Error("Emma could not identify its browser view to the agent.");
    return id;
  } finally {
    if (contents.debugger.isAttached()) contents.debugger.detach();
  }
}

function whole(bounds: BrowserBounds, zoom: number): BrowserBounds {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    x: Math.round(bounds.x * scale),
    y: Math.round(bounds.y * scale),
    width: Math.max(0, Math.round(bounds.width * scale)),
    height: Math.max(0, Math.round(bounds.height * scale)),
  };
}

function sessionName(threadId: string): string {
  return `emma-${threadId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_SESSION_CHARS)}`;
}

function bounded(value: string): string {
  if (Buffer.byteLength(value) <= MAX_TOOL_OUTPUT_BYTES) return value;
  const kept = Buffer.from(value).subarray(0, MAX_TOOL_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE)).toString("utf8");
  return `${kept.replace(/�$/, "")}${TRUNCATION_NOTICE}`;
}

export function attached(ran: Ran, what: string): void {
  if (ran.code === 0 && !ran.signal) return;
  throw new Error(`agent-browser could not ${what}, so nothing was driven and the browser pane shows nothing. Do not report what you cannot see. It said: ${ran.text.slice(0, 400) || "(nothing)"}`);
}

function capture(binary: string, argv: readonly string[], path: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...argv], { env: { ...process.env, PATH: path }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    child.stdout.on("data", (data: Buffer) => { if (out.length < MAX_TOOL_OUTPUT_BYTES) out += String(data); });
    child.stderr.on("data", (data: Buffer) => { if (err.length < MAX_STDERR) err += String(data); });
    const timer = setTimeout(() => child.kill("SIGKILL"), MAX_COMMAND_MS);
    timer.unref();
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const body = out.trim();
      if (signal) return resolve({ text: `${body}\n[agent-browser was killed after ${MAX_COMMAND_MS / 1000}s]`.trim(), code, signal });
      resolve({ text: body || (code === 0 ? "(no output)" : `${err.trim() || "(no output)"}\n[exit ${code}]`), code, signal });
    };
    child.once("error", (error) => {
      settled = true;
      clearTimeout(timer);
      reject(new Error(`agent-browser could not start: ${error.message}. Install or repair it by running: ${INSTALL_COMMAND}`));
    });
    child.once("exit", (code, signal) => { setTimeout(() => finish(code, signal), DRAIN_MS).unref(); });
    child.once("close", (code, signal) => finish(code, signal));
  });
}

function shell(command: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", command], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (data: Buffer) => { if (out.length < 8192) out += String(data); });
    const timer = setTimeout(() => child.kill("SIGKILL"), RESOLVE_MS);
    timer.unref();
    child.once("error", () => { clearTimeout(timer); resolve(""); });
    child.once("close", () => { clearTimeout(timer); resolve(out.trim().split("\n")[0] ?? ""); });
  });
}
