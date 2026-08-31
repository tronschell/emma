import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, constants, realpath } from "node:fs/promises";
import path from "node:path";

export const isMac = process.platform === "darwin";
export const isWindows = process.platform === "win32";
export const WINDOWS_APP_USER_MODEL_ID = "com.squirrel.Emma.Emma";
const WINDOWS_META = /([()\][%!^"`<>&|;, *?])/g;
const WINDOWS_SHIM = /\.(?:cmd|bat)$/i;

function pathModule(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function folded(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

export function samePath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  const implementation = pathModule(platform);
  return folded(implementation.resolve(left), platform) === folded(implementation.resolve(right), platform);
}

export function pathInside(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const implementation = pathModule(platform);
  const base = folded(implementation.resolve(root), platform);
  const resolved = folded(implementation.resolve(target), platform);
  const relative = implementation.relative(base, resolved);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${implementation.sep}`) && !implementation.isAbsolute(relative);
}

export function canonicalResetPath(root: string): string {
  const missing: string[] = [];
  let current = root;
  while (true) {
    try {
      const resolved = realpathSync.native(current);
      return missing.reverse().reduce((base, part) => path.join(base, part), resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Reset blocked: refusing to delete unsafe Emma data path "${root}".`, { cause: error });
      const parent = path.dirname(current);
      if (parent === current) return root;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function resetRoot(value: string, platform: NodeJS.Platform, home: string, environment: NodeJS.ProcessEnv): string {
  const implementation = pathModule(platform);
  if (!value || value.includes("\0") || !implementation.isAbsolute(value)) throw new Error(`Reset blocked: refusing to delete unsafe Emma data path "${value}".`);
  const resolved = implementation.normalize(value);
  const root = implementation.parse(resolved).root;
  const depth = implementation.relative(root, resolved).split(implementation.sep).filter(Boolean).length;
  if (resolved === root || depth < 2) throw new Error(`Reset blocked: refusing to delete unsafe Emma data path "${value}".`);
  if (home && implementation.isAbsolute(home) && pathInside(resolved, home, platform)) throw new Error(`Reset blocked: refusing to delete unsafe Emma data path "${value}".`);
  const systemRoots = platform === "win32" ? [environment.SystemRoot, environment.WINDIR]
    .filter((candidate): candidate is string => Boolean(candidate?.trim()))
    .filter((candidate) => implementation.isAbsolute(candidate))
    .map((candidate) => implementation.normalize(candidate)) : [];
  const protectedRoots = [
    environment.USERPROFILE,
    environment.ProgramFiles,
    environment["ProgramFiles(x86)"],
    environment.ProgramW6432,
    environment.ProgramData,
    environment.APPDATA,
    environment.LOCALAPPDATA,
    environment.TEMP,
    environment.TMP,
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()))
    .filter((candidate) => implementation.isAbsolute(candidate))
    .map((candidate) => implementation.normalize(candidate));
  if ([...systemRoots, ...protectedRoots].some((candidate) => pathInside(resolved, candidate, platform))) throw new Error(`Reset blocked: refusing to delete unsafe Emma data path "${value}".`);
  const blockedDescendants = [
    ...systemRoots,
    environment.ProgramFiles,
    environment["ProgramFiles(x86)"],
    environment.ProgramW6432,
    environment.ProgramData,
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()))
    .filter((candidate) => implementation.isAbsolute(candidate))
    .map((candidate) => implementation.normalize(candidate));
  if (blockedDescendants.some((candidate) => pathInside(candidate, resolved, platform))) throw new Error(`Reset blocked: refusing to delete unsafe Emma data path "${value}".`);
  return resolved;
}

function defaultResetRoot(platform: NodeJS.Platform, home: string, environment: NodeJS.ProcessEnv): string {
  const implementation = pathModule(platform);
  if (platform === "win32") {
    const appData = [environment.APPDATA, environment.LOCALAPPDATA, environment.USERPROFILE].find((value) => Boolean(value?.trim()))?.trim();
    if (!appData) throw new Error("Reset blocked: Windows data location is unavailable; set EMMA_DATA_DIR to an app-specific folder.");
    return environment.APPDATA?.trim() || environment.LOCALAPPDATA?.trim()
      ? implementation.join(appData, "Emma")
      : implementation.join(appData, "AppData", "Roaming", "Emma");
  }
  return implementation.join(home, "Library", "Application Support", "Emma");
}

export function resetDataRoots(
  userData: string,
  explicit: string | undefined,
  platform: NodeJS.Platform = process.platform,
  home = platform === "win32" ? process.env.USERPROFILE ?? "" : process.env.HOME ?? "",
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const rustRoot = explicit === undefined ? defaultResetRoot(platform, home, environment) : explicit;
  const roots = [resetRoot(rustRoot, platform, home, environment), resetRoot(userData, platform, home, environment)];
  const unique: string[] = [];
  for (const root of roots) if (!unique.some((other) => samePath(other, root, platform))) unique.push(root);
  return unique;
}

function windowsRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const root = environment.SystemRoot || environment.WINDIR || "C:\\Windows";
  return path.win32.isAbsolute(root) ? root : "C:\\Windows";
}

export function windowsSystemExecutable(name: string, platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env): string {
  return platform === "win32" ? path.win32.join(windowsRoot(environment), "System32", name) : name;
}

export function windowsPowerShellExecutable(): string {
  return isWindows ? path.join(windowsRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
}

export function squirrelEvent(args: readonly string[] = process.argv): "install" | "updated" | "uninstall" | "obsolete" | null {
  const event = args.find((value) => value === "--squirrel-install" || value === "--squirrel-updated" || value === "--squirrel-uninstall" || value === "--squirrel-obsolete");
  if (event === "--squirrel-install") return "install";
  if (event === "--squirrel-updated") return "updated";
  if (event === "--squirrel-uninstall") return "uninstall";
  if (event === "--squirrel-obsolete") return "obsolete";
  return null;
}

export function shellBinary(): string {
  return isWindows ? windowsSystemExecutable("cmd.exe") : "/bin/bash";
}

export function shellArguments(command: string, login = true): string[] {
  return isWindows ? ["/d", "/s", "/c", command] : [login ? "-ilc" : "-lc", command];
}

export function commandShimArguments(command: string, args: readonly string[]): string[] {
  const shellCommand = [escapeWindowsCommand(command), ...args.map((arg) => escapeWindowsArgument(arg, true))].join(" ");
  return ["/d", "/s", "/c", `"${shellCommand}"`];
}

export function spawnCommand(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  if (isWindows && WINDOWS_SHIM.test(command)) {
    return spawn(shellBinary(), commandShimArguments(command, args), { ...options, shell: false, windowsVerbatimArguments: true });
  }
  return spawn(command, [...args], { ...options, shell: false });
}

export function processTreeCommand(pid: number, signal: NodeJS.Signals = "SIGTERM", platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env): { executable: string; args: string[] } | undefined {
  if (platform !== "win32") return undefined;
  const args = ["/pid", String(pid), "/t"];
  if (signal === "SIGKILL") args.push("/f");
  return { executable: windowsSystemExecutable("taskkill.exe", platform, environment), args };
}

export function terminateProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM", group = true, platform: NodeJS.Platform = process.platform, runner: typeof spawn = spawn): Promise<boolean> {
  const command = processTreeCommand(pid, signal, platform);
  if (command) {
    return new Promise((resolve) => {
      let killer: ChildProcess | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (success: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(success);
      };
      try {
        killer = runner(command.executable, command.args, { stdio: "ignore", windowsHide: true });
        killer.once("error", () => finish(false));
        killer.once("close", (code) => finish(code === 0));
        timer = setTimeout(() => {
          try { if (killer && !killer.killed) killer.kill(); } catch { finish(false); return; }
          finish(false);
        }, 2_000);
        timer.unref?.();
      } catch {
        finish(false);
      }
    });
  }
  try {
    process.kill(group ? -pid : pid, signal);
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

function names(command: string): string[] {
  if (!isWindows || path.extname(command)) return [command];
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

export async function findExecutable(command: string, pathValue = process.env.PATH || ""): Promise<string | null> {
  const directories = path.isAbsolute(command) ? [""] : pathValue.split(path.delimiter).filter(Boolean);
  for (const name of names(command)) {
    for (const directory of directories) {
      const candidate = directory ? path.join(directory, name) : name;
      try {
        if (!isWindows) await access(candidate, constants.X_OK);
        return await realpath(candidate);
      } catch {
        continue;
      }
    }
  }
  return null;
}

function escapeWindowsCommand(value: string): string {
  assertWindowsValue(value);
  return value.replace(WINDOWS_META, "^$1");
}

function escapeWindowsArgument(value: string, doubleEscape: boolean): string {
  assertWindowsValue(value);
  let escaped = value
    .replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"")
    .replace(/(?=(\\+?)?)\1$/g, "$1$1");
  escaped = `"${escaped}"`.replace(WINDOWS_META, "^$1");
  return doubleEscape ? escaped.replace(WINDOWS_META, "^$1") : escaped;
}

function assertWindowsValue(value: string): void {
  if (value.includes("\0") || value.includes("\r") || value.includes("\n")) throw new TypeError("Windows process arguments cannot contain NUL or line breaks");
}
