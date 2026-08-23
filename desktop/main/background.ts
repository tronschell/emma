/* Commands that outlive the run that started them: dev servers, watchers, long
   builds. A foreground command waits and dies at its deadline, which is right
   for a build and wrong for `npm run dev` — that one blocks until it is killed.
   A background command returns an id immediately; the user reads its output or
   stops it from the sidebar. */

import { spawn, type ChildProcess } from "node:child_process";
import type { BackgroundTask } from "../shared/agents";

/** Kept per task, oldest bytes dropped. Enough to hold a server's startup banner and a stack trace. */
const MAX_OUTPUT = 64 * 1024;
/** Finished tasks kept for their output before the oldest is forgotten. */
const MAX_TASKS = 20;
/** How long a stopped command gets to exit on its own before SIGKILL. */
const SIGKILL_AFTER_MS = 2000;

type Entry = BackgroundTask & { child: ChildProcess; output: string };

export class BackgroundCommands {
  private tasks = new Map<string, Entry>();
  private counter = 0;

  /** `onChange` refreshes the sidebar: a task appearing, exiting, or being stopped. */
  constructor(private readonly onChange: () => void) {}

  start(cwd: string, command: string, folder: string): BackgroundTask {
    // Its own process group, so stopping a dev server also stops the workers it
    // forked — killing only bash would leave the port held.
    const child = spawn("/bin/bash", ["-lc", command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
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

  /** The tail of what a task has printed, newest bytes kept. */
  output(id: string, chars: number): { task: BackgroundTask; output: string } | undefined {
    const entry = this.tasks.get(id);
    return entry ? { task: snapshot(entry), output: entry.output.slice(-chars) } : undefined;
  }

  stop(id: string): boolean {
    const entry = this.tasks.get(id);
    if (!entry || entry.status === "exited" || entry.child.pid === undefined) return false;
    const pid = entry.child.pid;
    kill(pid, "SIGTERM");
    setTimeout(() => { if (entry.status === "running") kill(pid, "SIGKILL"); }, SIGKILL_AFTER_MS).unref();
    return true;
  }

  stopAll() {
    for (const entry of this.tasks.values()) this.stop(entry.id);
  }

  /** Only finished tasks are dropped: a running one is still someone's server. */
  private forget() {
    const done = [...this.tasks.values()].filter((entry) => entry.status === "exited");
    for (const entry of done.slice(0, Math.max(0, this.tasks.size - MAX_TASKS))) this.tasks.delete(entry.id);
  }
}

/** The whole group, so a shell that forked children takes them with it. */
function kill(pid: number, signal: NodeJS.Signals) {
  try { process.kill(-pid, signal); } catch { /* already gone */ }
}

function snapshot(entry: Entry): BackgroundTask {
  return { id: entry.id, command: entry.command, folder: entry.folder, status: entry.status, exitCode: entry.exitCode, startedAt: entry.startedAt, endedAt: entry.endedAt };
}
