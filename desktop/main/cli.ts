/* Running the user's other coding CLIs, one child per turn.
 *
 * This is the software half of the meta harness: `BackgroundCommands` next door
 * runs a shell line and forgets it, where a CLI run is a *conversation* — it
 * takes turns, it keeps a session between them, and the user is watching it in
 * the dock while it works. So a run outlives its child: the child exits at the
 * end of a turn and the run goes `idle`, holding the transcript and the session
 * id until the next prompt resumes it.
 *
 * ponytail: pipes, not a pty. Every CLI here has a non-interactive mode that is
 * exactly what a pipe is for, and a pty means node-pty — a native module to
 * rebuild per Electron version — plus a terminal emulator in the renderer. Add
 * both when driving a CLI's *interactive* TUI is the thing being asked for.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CLI_HARNESSES, cliHarness, terminalText, type CliRun } from "../shared/cli";

/** Kept per run, oldest bytes dropped. A few turns of a chatty CLI. */
const MAX_OUTPUT = 256 * 1024;
/** Runs kept before the oldest finished one is forgotten. */
const MAX_RUNS = 12;
/** How long a stopped turn gets to exit on its own before SIGKILL. */
const SIGKILL_AFTER_MS = 2000;
/** A turn that has said nothing and done nothing for this long is wedged. */
const MAX_TURN_MS = 30 * 60 * 1000;
/** Output arrives in bursts; the dock does not need a repaint per chunk. */
const NOTIFY_EVERY_MS = 120;

type Entry = CliRun & {
  session: string;
  child?: ChildProcess;
  output: string;
};

export class CliRuns {
  private runs = new Map<string, Entry>();
  private counter = 0;
  private notifyAt = 0;
  private pending?: NodeJS.Timeout;
  /** Resolved binary paths, and the login PATH children inherit. Looked up once. */
  private paths = new Map<string, string | null>();
  private loginPath?: Promise<string>;
  private cachedPath?: string;

  /** `onChange` repaints the dock and the tabs: a turn starting, printing, or ending. */
  constructor(private readonly onChange: () => void) {}

  /**
   * Which harnesses are actually installed.
   *
   * Resolution goes through a login shell because Electron inherits launchd's
   * PATH, not the user's: `claude` lives in ~/.local/bin and `opencode` in
   * ~/.opencode/bin, and neither is on the PATH this process starts with.
   */
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

  /** The tail of what a run has printed, across every turn, newest bytes kept. */
  output(id: string, chars: number): { run: CliRun; output: string } | undefined {
    const entry = this.runs.get(id);
    return entry ? { run: snapshot(entry), output: terminalText(entry.output).slice(-chars) } : undefined;
  }

  /** Opens a conversation with a CLI and runs its first turn. */
  async start(options: { threadId: string; cli: string; prompt: string; cwd: string; folder: string; unattended: boolean }): Promise<CliRun> {
    const harness = cliHarness(options.cli);
    if (!harness) throw new Error(`Emma does not know a CLI called ${options.cli.slice(0, 32)}.`);
    const binary = await this.resolve(harness.bin);
    if (!binary) throw new Error(`${harness.label} is not installed on this Mac — \`${harness.bin}\` is not on the PATH.`);
    // `unattended` on a CLI with no approval gate to bypass — pi — is a no-op,
    // not a refusal, so the run records what actually applied rather than what
    // was asked for.
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
      session: randomUUID(),
      output: "",
    };
    this.runs.set(id, entry);
    this.forget();
    await this.turn(entry, binary, harness.start(options.prompt, entry.session), harness.unattended);
    return snapshot(entry);
  }

  /** The next turn of a run that is between turns. */
  async send(id: string, prompt: string): Promise<CliRun> {
    const entry = this.runs.get(id);
    if (!entry) throw new Error(`There is no CLI run called ${id.slice(0, 32)}.`);
    if (entry.status === "running") throw new Error(`${id} is still working on its previous turn. Read it until it goes idle, or stop it.`);
    const harness = cliHarness(entry.cli);
    if (!harness) throw new Error(`Emma no longer knows a CLI called ${entry.cli}.`);
    const binary = await this.resolve(harness.bin);
    if (!binary) throw new Error(`${harness.label} is no longer on the PATH.`);
    await this.turn(entry, binary, harness.resume(prompt, entry.session), harness.unattended);
    return snapshot(entry);
  }

  stop(id: string): boolean {
    const entry = this.runs.get(id);
    const pid = entry?.child?.pid;
    if (!entry || entry.status !== "running" || pid === undefined) return false;
    kill(pid, "SIGTERM");
    setTimeout(() => { if (entry.status === "running") kill(pid, "SIGKILL"); }, SIGKILL_AFTER_MS).unref();
    return true;
  }

  stopAll() {
    for (const entry of this.runs.values()) this.stop(entry.id);
  }

  /** One turn: spawn, stream into the run's transcript, resolve when the child exits. */
  private turn(entry: Entry, binary: string, args: string[], unattended: string[]): Promise<void> {
    const argv = entry.unattended ? [...unattended, ...args] : args;
    entry.turns += 1;
    entry.status = "running";
    entry.exitCode = null;
    entry.turnStartedAt = Date.now();
    entry.endedAt = undefined;
    this.append(entry, `\n$ ${[binary.split("/").pop(), ...argv].join(" ")}\n`);
    return new Promise((resolve) => {
      // Its own process group: a CLI that forked a language server or a sandbox
      // helper takes them with it when the user hits Stop.
      const child = spawn(binary, argv, {
        cwd: entry.cwd,
        env: { ...process.env, PATH: this.cachedPath ?? process.env.PATH ?? "" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
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

  /** Coalesced: a CLI printing a token at a time must not be a repaint at a time. */
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

  /** Only finished runs are dropped: a running one is still someone's agent. */
  private forget() {
    const done = [...this.runs.values()].filter((entry) => entry.status !== "running");
    for (const entry of done.slice(0, Math.max(0, this.runs.size - MAX_RUNS))) this.runs.delete(entry.id);
  }

  private async resolve(bin: string): Promise<string | null> {
    const known = this.paths.get(bin);
    if (known !== undefined) return known;
    this.cachedPath ??= await this.path();
    const found = await shell(`command -v ${bin}`);
    const resolved = found && found.startsWith("/") ? found : null;
    this.paths.set(bin, resolved);
    return resolved;
  }

  private path(): Promise<string> {
    this.loginPath ??= shell("printf %s \"$PATH\"").then((value) => value || process.env.PATH || "");
    return this.loginPath;
  }
}

/** One short read out of a login shell, so `~/.local/bin` and friends are on the PATH. */
function shell(command: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", command], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (data: Buffer) => { if (out.length < 8192) out += String(data); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    timer.unref();
    child.once("error", () => { clearTimeout(timer); resolve(""); });
    child.once("close", () => { clearTimeout(timer); resolve(out.trim().split("\n")[0] ?? ""); });
  });
}

/** The whole group, so a CLI that forked helpers takes them with it. */
function kill(pid: number, signal: NodeJS.Signals) {
  try { process.kill(-pid, signal); } catch { /* already gone */ }
}

/** Listed field by field, so a handle or a transcript can never reach the renderer. */
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
  };
}
