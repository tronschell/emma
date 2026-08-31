import { execFile } from "node:child_process";
import { findExecutable, isWindows, shellArguments, shellBinary, spawnCommand, terminateProcessTree, windowsSystemExecutable } from "./platform";

export type ConnectionCatalogEntry = {
  id: string;
  label: string;
  binaries: string[];
  detail: string;
  formula: string;
};

export const CONNECTIONS: ConnectionCatalogEntry[] = [
  { id: "obsidian", label: "Obsidian", binaries: ["obsidian", "obsidian-cli"], detail: "Search, open, and write vault notes.", formula: "yakitrak/yakitrak/obsidian-cli" },
  { id: "github", label: "GitHub", binaries: ["gh"], detail: "Issues, pull requests, releases, CI.", formula: "gh" },
  { id: "gitlab", label: "GitLab", binaries: ["glab"], detail: "Merge requests, issues, pipelines.", formula: "glab" },
  { id: "jira", label: "Jira", binaries: ["jira"], detail: "Read, create, and move issues.", formula: "ankitpokhrel/jira-cli/jira-cli" },
  { id: "todoist", label: "Todoist", binaries: ["todoist"], detail: "List, add, and close tasks.", formula: "sachaos/todoist/todoist" },
];

export type DetectedConnection = Omit<ConnectionCatalogEntry, "binaries"> & { binary: string };

const BARE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const FORMULA = /^[a-z][a-z0-9-]{0,31}(\/[a-z][a-z0-9-]{0,31}){0,2}$/;
const WINDOWS_PACKAGES: Partial<Record<string, string>> = { obsidian: "Obsidian.Obsidian", github: "GitHub.cli", gitlab: "GLab.GLab" };

export function assertCatalog(entries: readonly ConnectionCatalogEntry[] = CONNECTIONS) {
  for (const entry of entries) {
    if (!BARE_NAME.test(entry.id)) throw new Error(`connection id ${entry.id} is not a bare name`);
    if (!entry.binaries.length || !entry.binaries.every((binary) => BARE_NAME.test(binary))) throw new Error(`connection ${entry.id} has a binary that needs quoting`);
    if (!FORMULA.test(entry.formula)) throw new Error(`connection ${entry.id} has a formula that needs quoting`);
  }
  return entries;
}

export function isConnectionId(value: unknown): value is string {
  return typeof value === "string" && BARE_NAME.test(value);
}

export function connectionCommand(binary: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `"${binary.replaceAll('"', "\\\"")}"` : binary;
}

export function windowsConnectionPackage(id: string): string | undefined {
  return WINDOWS_PACKAGES[id];
}

function probe(script: string, timeout = 5_000): Promise<{ output: string; failed: boolean }> {
  return new Promise((resolve) => {
    execFile(shellBinary(), shellArguments(script, false), { timeout, maxBuffer: 1024 * 1024, env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" } }, (error, stdout, stderr) => resolve({ output: `${stdout ?? ""}${stderr ?? ""}`, failed: Boolean(error) }));
  });
}

async function windowsWinget(): Promise<string | null> {
  const candidates = [
    await findExecutable("winget.exe"),
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\winget.exe` : "",
    windowsSystemExecutable("winget.exe"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = await findExecutable(candidate);
    if (resolved) return resolved;
  }
  return null;
}

function runWindows(binary: string, args: string[], timeout = 60_000): Promise<{ output: string; failed: boolean }> {
  return new Promise((resolve) => {
    const child = spawnCommand(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const collect = (chunk: Buffer) => { if (output.length < 64 * 1024) output += String(chunk); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => { if (child.pid !== undefined) terminateProcessTree(child.pid, "SIGKILL", false); }, timeout);
    timer.unref();
    child.once("error", () => { clearTimeout(timer); resolve({ output, failed: true }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ output, failed: code !== 0 }); });
  });
}

export async function detectConnections(entries: readonly ConnectionCatalogEntry[] = CONNECTIONS): Promise<DetectedConnection[]> {
  assertCatalog(entries);
  if (isWindows) {
    return await Promise.all(entries.map(async ({ binaries, ...entry }) => {
      const found = (await Promise.all(binaries.map(async (binary) => ({ binary, path: await findExecutable(binary) })))).find((candidate) => candidate.path);
      return { ...entry, binary: found?.path ?? "" };
    }));
  }
  const script = entries.flatMap((entry) => entry.binaries).map((binary) => `command -v ${binary} >/dev/null 2>&1 && echo ${binary}`).join("\n");
  const found = new Set((await probe(script)).output.split("\n").map((line) => line.trim()).filter(Boolean));
  return entries.map(({ binaries, ...entry }) => ({ ...entry, binary: binaries.find((binary) => found.has(binary)) ?? "" }));
}

const formulaName = (formula: string) => formula.slice(formula.lastIndexOf("/") + 1);

export async function outdatedConnections(entries: readonly ConnectionCatalogEntry[] = CONNECTIONS): Promise<string[]> {
  assertCatalog(entries);
  if (isWindows) {
    const winget = await windowsWinget();
    if (!winget) return [];
    const checks = await Promise.all(entries.flatMap((entry) => {
      const id = windowsConnectionPackage(entry.id);
      return id ? [runWindows(winget, ["list", "--id", id, "--exact", "--upgrade-available", "--accept-source-agreements", "--disable-interactivity"]).then(({ output, failed }) => !failed && new RegExp(`(?:^|\\s)${id.replace(".", "\\.")}(?:\\s|$)`, "im").test(output) ? entry.id : "")] : [];
    }));
    return checks.filter(Boolean);
  }
  const { output, failed } = await probe("command -v brew >/dev/null 2>&1 && brew outdated --quiet 2>/dev/null", 60_000);
  if (failed) return [];
  const stale = new Set(output.split("\n").map((line) => formulaName(line.trim())).filter(Boolean));
  return entries.filter((entry) => stale.has(formulaName(entry.formula))).map((entry) => entry.id);
}

export async function setUpConnection(id: string, action: "install" | "upgrade", entries: readonly ConnectionCatalogEntry[] = CONNECTIONS): Promise<{ ok: boolean; message: string }> {
  const entry = assertCatalog(entries).find((item) => item.id === id);
  if (!entry) throw new Error("Unknown connection");
  if (isWindows) {
    const packageId = windowsConnectionPackage(entry.id);
    if (!packageId) return { ok: false, message: `${entry.label} has no supported Windows CLI package in WinGet. Install its Windows CLI from the publisher, then try Detect again.` };
    const winget = await windowsWinget();
    if (!winget) return { ok: false, message: `WinGet is unavailable on this PC. Install ${entry.label} from its publisher, then try Detect again.` };
    const command = action === "install" ? "install" : "upgrade";
    const result = await runWindows(winget, [command, "--id", packageId, "--exact", "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity"], 600_000);
    if (!result.failed) {
      if (entry.id === "obsidian") return { ok: true, message: `${entry.label} ${action === "install" ? "installed" : "updated"}. Enable the Obsidian CLI in Obsidian Settings → General, restart Emma, then press Detect.` };
      return { ok: true, message: action === "install" ? `${entry.label} installed.` : `${entry.label} is up to date.` };
    }
    const lines = result.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return { ok: false, message: lines.at(-1) ?? `WinGet could not ${command} ${entry.label}.` };
  }
  const { output, failed } = await probe(`command -v brew >/dev/null 2>&1 || { echo "Homebrew is not installed — see brew.sh"; exit 1; }\nbrew ${action} ${entry.formula}`, 600_000);
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!failed) return { ok: true, message: action === "install" ? `${entry.label} installed.` : `${entry.label} is up to date.` };
  return { ok: false, message: lines.filter((line) => line.toLowerCase().includes("error")).pop() ?? lines.at(-1) ?? `brew ${action} failed.` };
}

export function describeConnections(detected: readonly DetectedConnection[], ids: readonly string[]): string {
  const lines = detected
    .filter((item) => item.binary && ids.includes(item.id))
    .map((item) => {
      const binary = connectionCommand(item.binary, process.platform);
      return `- ${item.label} — \`${binary}\`. ${item.detail} Run \`${binary} --help\` first if you are unsure of its subcommands.`;
    });
  if (!lines.length) return "";
  return `Third-party command-line tools the user has connected on this machine. Use them through the terminal tool, which needs a connected folder as its working directory:\n\n${lines.join("\n")}`;
}

let probedIds = "";
let probedBlock = "";

export async function connectionsBlock(ids: readonly string[]): Promise<string> {
  const key = [...ids].sort().join(",");
  if (key === probedIds) return probedBlock;
  const block = describeConnections(await detectConnections(), ids);
  probedIds = key;
  probedBlock = block;
  return block;
}
