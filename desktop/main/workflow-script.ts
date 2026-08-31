import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { MAX_VARIABLE_CHARS } from "../shared/workflow";

const SCRIPT_TIMEOUT_MS = 120_000;

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function workflowScriptPath(file: string, roots: string[]): Promise<string> {
  if (!path.isAbsolute(file) || file.includes("{{")) throw new Error("A workflow script needs a fixed absolute path.");
  let script: string;
  try { script = await realpath(file); } catch { throw new Error(`The workflow script does not exist: ${file}`); }
  if (!(await stat(script)).isFile()) throw new Error(`The workflow script is not a file: ${file}`);
  const connected = (await Promise.all(roots.map((root) => realpath(root).catch(() => "")))).filter(Boolean);
  if (!connected.some((root) => inside(root, script))) throw new Error("A workflow script must be inside a connected folder.");
  return script;
}

function executable(script: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const extension = path.extname(script).toLowerCase();
  if (extension === ".py") return { command: "/usr/bin/env", args: ["python3", script], env: process.env };
  if ([".js", ".cjs", ".mjs"].includes(extension)) return { command: process.execPath, args: [script], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
  if (extension === ".sh") return { command: "/bin/sh", args: [script], env: process.env };
  if (extension === ".zsh") return { command: "/bin/zsh", args: [script], env: process.env };
  return { command: script, args: [], env: process.env };
}

function stop(child: ChildProcess) {
  if (child.pid && process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); return; } catch { child.kill("SIGKILL"); return; }
  }
  child.kill("SIGKILL");
}

export async function runWorkflowScript(file: string, input: string, roots: string[]): Promise<string> {
  const script = await workflowScriptPath(file, roots);
  const launch = executable(script);
  return await new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, {
      cwd: path.dirname(script),
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const collect = (target: "stdout" | "stderr", data: Buffer) => {
      const room = MAX_VARIABLE_CHARS - stdout.length - stderr.length;
      if (room <= 0) return;
      if (target === "stdout") stdout += String(data).slice(0, room);
      else stderr += String(data).slice(0, room);
    };
    const timer = setTimeout(() => { timedOut = true; stop(child); }, SCRIPT_TIMEOUT_MS);
    timer.unref();
    const finish = (status: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = stdout.trim();
      const error = stderr.trim();
      resolve([output, error ? `[stderr]\n${error}` : "", status].filter(Boolean).join("\n\n") || "(no output)");
    };
    child.stdout?.on("data", (data: Buffer) => collect("stdout", data));
    child.stderr?.on("data", (data: Buffer) => collect("stderr", data));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input.slice(0, MAX_VARIABLE_CHARS));
    child.once("error", (error) => finish(`[script could not start: ${error.message}]`));
    child.once("close", (code, signal) => finish(timedOut
      ? `[script killed after ${SCRIPT_TIMEOUT_MS / 1000}s]`
      : signal ? `[script killed by ${signal}]`
      : code === 0 ? ""
      : `[script exit ${code ?? "unknown"}]`));
  });
}
