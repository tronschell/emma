import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cliHarness } from "../shared/cli";
import { cliPlan } from "../shared/settings";
import { MAX_TERMINAL_COLUMNS, MAX_TERMINAL_SCROLLBACK, MAX_TERMINAL_TABS, terminalTitle, type TerminalTab } from "../shared/terminal";
import { isWindows, shellArguments, shellBinary, terminateProcessTree } from "./platform";

const SIGKILL_AFTER_MS = 2000;

type Entry = TerminalTab & {
  child: ChildProcess;
  chunks: Buffer[];
  bytes: number;
  written: number;
};

const snapshot = (entry: Entry): TerminalTab => ({
  id: entry.id,
  threadId: entry.threadId,
  title: entry.title,
  cwd: entry.cwd,
  running: entry.running,
  exitCode: entry.exitCode,
  cli: entry.cli,
});

const size = (value: number, fallback: number) =>
  Number.isSafeInteger(value) && value > 0 && value <= MAX_TERMINAL_COLUMNS ? value : fallback;

export class Terminals {
  private tabs = new Map<string, Entry>();
  private stopping = new Map<string, Promise<void>>();

  constructor(
    private readonly binary: () => string,
    private readonly onData: (id: string, data: Buffer, at: number) => void,
    private readonly onChange: () => void,
  ) {}

  open(request: { threadId: string; cwd: string; columns: number; rows: number; cli?: string; signIn?: string }): TerminalTab {
    if (this.list(request.threadId).length >= MAX_TERMINAL_TABS) {
      throw new Error(`A thread keeps at most ${MAX_TERMINAL_TABS} terminals open.`);
    }
    const columns = size(request.columns, 80);
    const rows = size(request.rows, 24);
    const harness = request.cli ? cliHarness(request.cli) : undefined;
    if (request.cli && !harness) throw new Error("Emma does not know that CLI.");
    const plan = request.signIn ? cliPlan(request.signIn) : undefined;
    if (request.signIn && !plan) throw new Error("Emma does not know that plan.");
    const shell = isWindows ? shellBinary() : process.env.SHELL || "/bin/zsh";
    const command = plan?.signIn ?? harness?.bin;
    const windowsInteractive = /(?:pwsh|powershell)\.exe$/i.test(shell) ? ["-NoLogo"] : ["/d"];
    const login = command ? [shell, ...shellArguments(command)] : (isWindows ? [shell, ...windowsInteractive] : [shell, "-il"]);
    const child = spawn(this.binary(), [String(columns), String(rows), ...login], {
      cwd: request.cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const entry: Entry = {
      id: `terminal-${randomUUID()}`,
      threadId: request.threadId,
      title: plan ? `Sign in to ${plan.label}` : harness ? harness.label : terminalTitle(request.cwd),
      cwd: request.cwd,
      cli: harness?.id,
      running: true,
      exitCode: null,
      child,
      chunks: [],
      bytes: 0,
      written: 0,
    };
    this.tabs.set(entry.id, entry);
    child.stdin?.on("error", () => undefined);
    child.stdout?.on("data", (chunk: Buffer) => this.take(entry, chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.take(entry, chunk));
    child.on("error", (reason: Error) => {
      this.take(entry, Buffer.from(`\r\n[terminal could not start: ${reason.message}]\r\n`));
      this.ended(entry, null);
    });
    child.on("exit", (code) => {
      this.take(entry, Buffer.from(`\r\n[session ended${code ? ` — exit ${code}` : ""}]\r\n`));
      this.ended(entry, code ?? null);
    });
    this.onChange();
    return snapshot(entry);
  }

  write(id: string, data: string) {
    const entry = this.tabs.get(id);
    if (entry?.running) entry.child.stdin?.write(data);
  }

  resize(id: string, columns: number, rows: number) {
    const entry = this.tabs.get(id);
    if (!entry?.running) return;
    const control = entry.child.stdio[3];
    if (control && "write" in control) control.write(`${size(columns, 80)} ${size(rows, 24)}\n`);
  }

  close(id: string) {
    const entry = this.tabs.get(id);
    if (!entry) return;
    this.tabs.delete(id);
    if (entry.running) this.stop(entry);
    this.onChange();
  }

  list(threadId?: string): TerminalTab[] {
    return [...this.tabs.values()].filter((entry) => !threadId || entry.threadId === threadId).map(snapshot);
  }

  buffer(id: string): { data: Buffer; at: number } {
    const entry = this.tabs.get(id);
    return entry ? { data: Buffer.concat(entry.chunks), at: entry.written } : { data: Buffer.alloc(0), at: 0 };
  }

  stopAll(): Promise<void> {
    const stopping = [...this.tabs.values()].filter((entry) => entry.running).map((entry) => this.stop(entry));
    return Promise.all(stopping).then(() => {
      this.tabs.clear();
    });
  }

  private stop(entry: Entry): Promise<void> {
    const existing = this.stopping.get(entry.id);
    if (existing) return existing;
    if (!entry.running || entry.child.pid === undefined) return Promise.resolve();
    entry.running = false;
    const pid = entry.child.pid;
    const stopping = (async () => {
      if (isWindows) await terminateProcessTree(pid, "SIGTERM", false);
      else entry.child.kill("SIGHUP");
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SIGKILL_AFTER_MS);
        if (!isWindows) timer.unref();
      });
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
      if (isWindows) await terminateProcessTree(pid, "SIGKILL", false);
      else entry.child.kill("SIGKILL");
    })();
    this.stopping.set(entry.id, stopping);
    void stopping.then(() => this.stopping.delete(entry.id), () => this.stopping.delete(entry.id));
    return stopping;
  }

  private ended(entry: Entry, code: number | null) {
    if (!entry.running) return;
    entry.running = false;
    entry.exitCode = code;
    this.onChange();
  }

  private take(entry: Entry, chunk: Buffer) {
    entry.chunks.push(chunk);
    entry.bytes += chunk.length;
    entry.written += chunk.length;
    while (entry.bytes > MAX_TERMINAL_SCROLLBACK && entry.chunks.length > 1) {
      entry.bytes -= entry.chunks.shift()!.length;
    }
    this.onData(entry.id, chunk, entry.written);
  }
}
