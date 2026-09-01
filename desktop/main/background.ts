import { spawn, type ChildProcess } from "node:child_process";
import type { BackgroundTask } from "../shared/agents";
import { isWindows, shellArguments, shellBinary, terminateProcessTree } from "./platform";

const MAX_OUTPUT = 64 * 1024;
const MAX_TASKS = 20;
const SIGKILL_AFTER_MS = 2000;

type Entry = BackgroundTask & { child: ChildProcess; output: string };

export class BackgroundCommands {
  private tasks = new Map<string, Entry>();
  private stopping = new Map<string, Promise<void>>();
  private counter = 0;

  constructor(private readonly onChange: () => void) {}

  start(cwd: string, command: string, folder: string): BackgroundTask {
    const child = spawn(shellBinary(), shellArguments(command, false), { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
    const id = `bg${++this.counter}`;
    const entry: Entry = { id, command, folder, startedAt: Date.now(), status: "running", exitCode: null, output: "", child };
    const collect = (data: Buffer) => { entry.output = (entry.output + String(data)).slice(-MAX_OUTPUT); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const finish = (note: string, code: number | null) => {
      if (entry.status === "exited") return;
      entry.status = "exited";
      entry.exitCode = code;
      entry.endedAt = Date.now();
      entry.output = (entry.output + note).slice(-MAX_OUTPUT);
      this.onChange();
    };
    child.once("error", (error) => finish(`\n[could not start: ${error.message}]`, null));
    child.once("close", (code, signal) => finish(signal ? `\n[${signal}]` : "", code));
    this.tasks.set(id, entry);
    this.forget();
    this.onChange();
    return snapshot(entry);
  }

  list(): BackgroundTask[] {
    return [...this.tasks.values()].map(snapshot);
  }

  output(id: string, chars: number): { task: BackgroundTask; output: string } | undefined {
    const entry = this.tasks.get(id);
    return entry ? { task: snapshot(entry), output: entry.output.slice(-chars) } : undefined;
  }

  stop(id: string): boolean {
    const entry = this.tasks.get(id);
    if (!entry || entry.status === "exited" || entry.child.pid === undefined) return false;
    void this.stopEntry(entry);
    return true;
  }

  stopAll(): Promise<void> {
    return Promise.all([...this.tasks.values()].map((entry) => this.stopEntry(entry))).then(() => undefined);
  }

  private forget() {
    const done = [...this.tasks.values()].filter((entry) => entry.status === "exited");
    for (const entry of done.slice(0, Math.max(0, this.tasks.size - MAX_TASKS))) this.tasks.delete(entry.id);
  }

  private stopEntry(entry: Entry): Promise<void> {
    const existing = this.stopping.get(entry.id);
    if (existing) return existing;
    const pid = entry.child.pid;
    if (entry.status === "exited" || pid === undefined) return Promise.resolve();
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
}

function snapshot(entry: Entry): BackgroundTask {
  return { id: entry.id, command: entry.command, folder: entry.folder, status: entry.status, exitCode: entry.exitCode, startedAt: entry.startedAt, endedAt: entry.endedAt };
}
