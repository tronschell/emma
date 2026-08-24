import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { externalUrl } from "./ipc";
import { MAX_TOOL_OUTPUT_BYTES } from "./tools";

export type BrowserStatus = {
  installed: boolean;
  running: boolean;
  streamPort?: number;
  url?: string;
  title?: string;
};

export const INSTALL_COMMAND = "npm install -g agent-browser && agent-browser install";

const NAVIGATIONS = ["back", "forward", "reload", "close"] as const;
type Navigation = (typeof NAVIGATIONS)[number];

const MAX_COMMAND_MS = 60_000;
const RESOLVE_MS = 5_000;
const RECHECK_MS = 15_000;
const DRAIN_MS = 100;
const MAX_STDERR = 4 * 1024;
const MAX_SESSION_CHARS = 48;
const TRUNCATION_NOTICE = "\n[truncated — read less at a time: snapshot with interactive true, or narrow it with a selector]";

type Session = { name: string; running: boolean; port?: number; url?: string; title?: string; stream?: Promise<number> };
type Payload = Record<string, unknown> | string;

export class Browsers {
  private sessions = new Map<string, Session>();
  private lookup?: Promise<string | null>;
  private path: string | null = null;
  private expires = 0;
  private loginPath?: string;

  constructor(private readonly onChange: () => void) {}

  async status(threadId: string): Promise<BrowserStatus> {
    if (!(await this.binary())) return { installed: false, running: false };
    const session = this.session(threadId);
    return { installed: true, running: session.running, streamPort: session.port, url: session.url, title: session.title };
  }

  async run(threadId: string, argv: readonly string[]): Promise<string> {
    const session = this.session(threadId);
    const out = await this.exec(session, argv);
    if (!session.running) {
      session.running = true;
      this.onChange();
    }
    return bounded(out);
  }

  async ensureStream(threadId: string): Promise<number> {
    const session = this.session(threadId);
    session.stream ??= this.startStream(session).catch((error: unknown) => {
      session.stream = undefined;
      throw error;
    });
    return session.stream;
  }

  async open(threadId: string, url: string): Promise<BrowserStatus> {
    const target = externalUrl(url);
    if (!target) throw new Error(`Emma's browser opens http and https addresses only, and ${url.slice(0, 120)} is neither.`);
    const session = this.session(threadId);
    const out = await this.exec(session, ["--json", "open", target.href]);
    if (!this.record(session, out)) await this.locate(session, target.href);
    this.onChange();
    return this.status(threadId);
  }

  async navigate(threadId: string, action: Navigation): Promise<BrowserStatus> {
    if (!NAVIGATIONS.includes(action)) throw new Error(`Emma's browser has no "${String(action).slice(0, 32)}" navigation.`);
    const session = this.session(threadId);
    const out = await this.exec(session, ["--json", action]);
    if (action === "close") {
      session.running = false;
      session.port = undefined;
      session.stream = undefined;
      session.url = undefined;
      session.title = undefined;
    } else if (!this.record(session, out)) {
      await this.locate(session);
    }
    this.onChange();
    return this.status(threadId);
  }

  stopAll() {
    for (const session of this.sessions.values()) {
      if (!session.running || !this.path) continue;
      session.running = false;
      session.stream = undefined;
      spawn(this.path, ["--session", session.name, "close"], { detached: true, stdio: "ignore" }).unref();
    }
  }

  private session(threadId: string): Session {
    const name = sessionName(threadId);
    const known = this.sessions.get(name);
    if (known) return known;
    const created: Session = { name, running: false };
    this.sessions.set(name, created);
    return created;
  }

  private async startStream(session: Session): Promise<number> {
    const bound = streamPort(await this.exec(session, ["--json", "stream", "status"]));
    const port = bound ?? (await freePort());
    if (bound === undefined) await this.exec(session, ["stream", "enable", "--port", String(port)]);
    session.port = port;
    session.running = true;
    this.onChange();
    return port;
  }

  private record(session: Session, out: string): string | undefined {
    const data = parsed(out);
    if (data === undefined) return undefined;
    const page = typeof data === "string" ? {} : data;
    const url = field(page, "url");
    const title = field(page, "title");
    const changed = !session.running || (url !== undefined && url !== session.url) || (title !== undefined && title !== session.title);
    session.running = true;
    if (url) session.url = url;
    if (title) session.title = title;
    if (changed) this.onChange();
    return url;
  }

  private async locate(session: Session, fallback?: string) {
    const data = parsed(await this.exec(session, ["--json", "get", "url"]));
    const found = typeof data === "string" ? data.trim() : field(data ?? {}, "url", "value", "text", "result");
    if (found ?? fallback) session.url = found ?? fallback;
  }

  private async exec(session: Session, argv: readonly string[]): Promise<string> {
    const binary = await this.binary();
    if (!binary) throw new Error(`agent-browser is not installed on this Mac, so there is no browser to drive. Install it by running: ${INSTALL_COMMAND}`);
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

function sessionName(threadId: string): string {
  return `emma-${threadId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_SESSION_CHARS)}`;
}

function parsed(out: string): Payload | undefined {
  try {
    const value = JSON.parse(out) as { success?: unknown; data?: unknown };
    if (!value || typeof value !== "object" || Array.isArray(value) || value.success === false) return undefined;
    if (typeof value.data === "string") return value.data;
    return value.data && typeof value.data === "object" && !Array.isArray(value.data) ? (value.data as Record<string, unknown>) : {};
  } catch {
    return undefined;
  }
}

function field(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function streamPort(out: string): number | undefined {
  const data = parsed(out);
  if (data === undefined || typeof data === "string" || data.enabled === false) return undefined;
  const port = Number(data.port);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("Emma could not find a free port for the browser stream."))));
    });
  });
}

function bounded(value: string): string {
  if (Buffer.byteLength(value) <= MAX_TOOL_OUTPUT_BYTES) return value;
  const kept = Buffer.from(value).subarray(0, MAX_TOOL_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE)).toString("utf8");
  return `${kept.replace(/\uFFFD$/, "")}${TRUNCATION_NOTICE}`;
}

function capture(binary: string, argv: readonly string[], path: string): Promise<string> {
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
      if (signal) return resolve(`${body}\n[agent-browser was killed after ${MAX_COMMAND_MS / 1000}s]`.trim());
      resolve(body || (code === 0 ? "(no output)" : `${err.trim() || "(no output)"}\n[exit ${code}]`));
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
