import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CLI_HARNESSES, cliHarness, terminalText, type CliRun } from "../shared/cli";
import { findExecutable, isWindows, shellArguments, shellBinary, spawnCommand, terminateProcessTree } from "./platform";

const MAX_OUTPUT = 256 * 1024;
const MAX_RUNS = 12;
const SIGKILL_AFTER_MS = 2000;
const MAX_TURN_MS = 30 * 60 * 1000;
const NOTIFY_EVERY_MS = 120;

type Entry = CliRun & {
  session: string;
  child?: ChildProcess;
  output: string;
};

export class CliRuns {
  private runs = new Map<string, Entry>();
  private stopping = new Map<string, Promise<void>>();
  private counter = 0;
  private notifyAt = 0;
  private pending?: NodeJS.Timeout;
  private paths = new Map<string, string | null>();
  private loginPath?: Promise<string>;
  private cachedPath?: string;

  constructor(private readonly onChange: () => void) {}

  async installed(): Promise<{ id: string; label: string; bin: string; path: string }[]> {
    const found = [];
    for (const harness of CLI_HARNESSES) {
      const resolved = await this.resolve(harness.bin);
      if (resolved) found.push({ id: harness.id, label: harness.label, bin: harness.bin, path: resolved });
    }
    return found;
  }

  list(threadId?: string): CliRun[] {
    return [...this.runs.values()].filter((run) => !threadId || run.threadId === threadId).map(snapshot);
  }

  get(id: string): CliRun | undefined {
    const entry = this.runs.get(id);
    return entry && snapshot(entry);
  }

  output(id: string, chars: number): { run: CliRun; output: string } | undefined {
    const entry = this.runs.get(id);
    return entry ? { run: snapshot(entry), output: terminalText(entry.output).slice(-chars) } : undefined;
  }

  async start(options: { threadId: string; cli: string; prompt: string; cwd: string; folder: string; unattended: boolean; model?: string }): Promise<CliRun> {
    const harness = cliHarness(options.cli);
    if (!harness) throw new Error(`Emma does not know a CLI called ${options.cli.slice(0, 32)}.`);
    const binary = await this.resolve(harness.bin);
    if (!binary) throw new Error(`${harness.label} is not installed — \`${harness.bin}\` is not on the PATH.`);
    const now = Date.now();
    const id = `cli${++this.counter}`;
    const entry: Entry = {
      id,
      cli: harness.id,
      threadId: options.threadId,
      title: options.prompt.split("\n")[0].slice(0, 80),
      cwd: options.cwd,
      folder: options.folder,
      status: "running",
      exitCode: null,
      turns: 0,
      startedAt: now,
      turnStartedAt: now,
      unattended: options.unattended && harness.unattended.length > 0,
      model: options.model,
      session: randomUUID(),
      output: "",
    };
    this.runs.set(id, entry);
    this.forget();
    await this.turn(entry, binary, harness.start(options.prompt, entry.session, entry.model), harness.unattended);
    return snapshot(entry);
  }

  async send(id: string, prompt: string): Promise<CliRun> {
    const entry = this.runs.get(id);
    if (!entry) throw new Error(`There is no CLI run called ${id.slice(0, 32)}.`);
    if (entry.status === "running") throw new Error(`${id} is still working on its previous turn. Read it until it goes idle, or stop it.`);
    const harness = cliHarness(entry.cli);
    if (!harness) throw new Error(`Emma no longer knows a CLI called ${entry.cli}.`);
    const binary = await this.resolve(harness.bin);
    if (!binary) throw new Error(`${harness.label} is no longer on the PATH.`);
    await this.turn(entry, binary, harness.resume(prompt, entry.session, entry.model), harness.unattended);
    return snapshot(entry);
  }

  setModel(id: string, model: string): CliRun {
    const entry = this.runs.get(id);
    if (!entry) throw new Error(`There is no CLI run called ${id.slice(0, 32)}.`);
    entry.model = model || undefined;
    this.onChange();
    return snapshot(entry);
  }

  async where(cli: string): Promise<{ binary: string; path: string } | null> {
    const harness = cliHarness(cli);
    if (!harness) return null;
    const binary = await this.resolve(harness.bin);
    return binary ? { binary, path: this.cachedPath ?? process.env.PATH ?? "" } : null;
  }

  stop(id: string): boolean {
    const entry = this.runs.get(id);
    const pid = entry?.child?.pid;
    if (!entry || entry.status !== "running" || pid === undefined) return false;
    void this.stopEntry(entry);
    return true;
  }

  stopAll(): Promise<void> {
    return Promise.all([...this.runs.values()].map((entry) => this.stopEntry(entry))).then(() => undefined);
  }

  private turn(entry: Entry, binary: string, args: string[], unattended: string[]): Promise<void> {
    const argv = entry.unattended ? [...unattended, ...args] : args;
    entry.turns += 1;
    entry.status = "running";
    entry.exitCode = null;
    entry.turnStartedAt = Date.now();
    entry.endedAt = undefined;
    this.append(entry, `\n$ ${[binary.split(/[\\/]/).pop(), ...argv].join(" ")}\n`);
    return new Promise((resolve) => {
      const child = spawnCommand(binary, argv, {
        cwd: entry.cwd,
        env: { ...process.env, PATH: this.cachedPath ?? process.env.PATH ?? "" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        windowsHide: true,
      });
      entry.child = child;
      const collect = (data: Buffer) => this.append(entry, String(data));
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const deadline = setTimeout(() => this.stop(entry.id), MAX_TURN_MS);
      deadline.unref();
      const finish = (note: string, code: number | null, failed: boolean) => {
        if (entry.status !== "running") return;
        clearTimeout(deadline);
        entry.child = undefined;
        entry.status = failed ? "failed" : "idle";
        entry.exitCode = code;
        entry.endedAt = Date.now();
        if (note) this.append(entry, note);
        this.onChange();
        resolve();
      };
      child.once("error", (error) => finish(`\n[could not start: ${error.message}]\n`, null, true));
      child.once("close", (code, signal) => finish(signal ? `\n[${signal}]\n` : `\n[exit ${code ?? "?"}]\n`, code, false));
      this.onChange();
    });
  }

  private append(entry: Entry, text: string) {
    entry.output = (entry.output + text).slice(-MAX_OUTPUT);
    this.notify();
  }

  private notify() {
    const now = Date.now();
    if (now - this.notifyAt >= NOTIFY_EVERY_MS) {
      this.notifyAt = now;
      this.onChange();
      return;
    }
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.notifyAt = Date.now();
      this.onChange();
    }, NOTIFY_EVERY_MS);
    this.pending.unref?.();
  }

  private forget() {
    const done = [...this.runs.values()].filter((entry) => entry.status !== "running");
    for (const entry of done.slice(0, Math.max(0, this.runs.size - MAX_RUNS))) this.runs.delete(entry.id);
  }

  private stopEntry(entry: Entry): Promise<void> {
    const existing = this.stopping.get(entry.id);
    if (existing) return existing;
    const pid = entry.child?.pid;
    if (entry.status !== "running" || pid === undefined) return Promise.resolve();
    const stopping = terminateProcessTree(pid).then(async () => {
      if (entry.status !== "running") return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SIGKILL_AFTER_MS);
        if (!isWindows) timer.unref();
      });
      if (entry.status === "running") await terminateProcessTree(pid, "SIGKILL");
    });
    this.stopping.set(entry.id, stopping);
    void stopping.then(() => this.stopping.delete(entry.id), () => this.stopping.delete(entry.id));
    return stopping;
  }

  private async resolve(bin: string): Promise<string | null> {
    const known = this.paths.get(bin);
    if (known !== undefined) return known;
    this.cachedPath ??= await this.path();
    const resolved = await findExecutable(bin, this.cachedPath);
    this.paths.set(bin, resolved);
    return resolved;
  }

  private path(): Promise<string> {
    this.loginPath ??= isWindows ? Promise.resolve(process.env.PATH || "") : shell("printf %s \"$PATH\"").then((value) => value || process.env.PATH || "");
    return this.loginPath;
  }
}

function shell(command: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(shellBinary(), shellArguments(command, false), { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (data: Buffer) => { if (out.length < 8192) out += String(data); });
    const timer = setTimeout(() => { if (child.pid !== undefined) terminateProcessTree(child.pid, "SIGKILL", false); }, 5000);
    timer.unref();
    child.once("error", () => { clearTimeout(timer); resolve(""); });
    child.once("close", () => { clearTimeout(timer); resolve(out.trim().split("\n")[0] ?? ""); });
  });
}

function snapshot(entry: Entry): CliRun {
  return {
    id: entry.id,
    cli: entry.cli,
    threadId: entry.threadId,
    title: entry.title,
    cwd: entry.cwd,
    folder: entry.folder,
    status: entry.status,
    exitCode: entry.exitCode,
    turns: entry.turns,
    startedAt: entry.startedAt,
    turnStartedAt: entry.turnStartedAt,
    endedAt: entry.endedAt,
    unattended: entry.unattended,
    model: entry.model,
  };
}
