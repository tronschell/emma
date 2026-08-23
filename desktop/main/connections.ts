/* Third-party command-line tools Emma can lean on, offered as connections in
   Settings. A connection is deliberately not a new tool: the binary is already
   reachable through `terminal`, and all the agent is missing is that it exists on
   this Mac and what it is for. So a connection is a line of system context, and
   nothing else — no wrapper, no schema, no process Emma owns. */

import { execFile } from "node:child_process";

export type ConnectionCatalogEntry = {
  id: string;
  label: string;
  /** Binaries to probe, best first; the installed one is what the agent is told to run. */
  binaries: string[];
  detail: string;
  /** Homebrew formula, the only thing Emma installs or upgrades on the user's say-so. */
  formula: string;
};

/* Binaries and formulae are interpolated into shell scripts, so the catalog is
   held to bare names — no quoting to get wrong, and `assertCatalog` fails the
   build's tests if an entry ever strays. */
export const CONNECTIONS: ConnectionCatalogEntry[] = [
  { id: "obsidian", label: "Obsidian", binaries: ["obsidian", "obsidian-cli"], detail: "Search, open, and write vault notes.", formula: "yakitrak/yakitrak/obsidian-cli" },
  { id: "github", label: "GitHub", binaries: ["gh"], detail: "Issues, pull requests, releases, CI.", formula: "gh" },
  { id: "gitlab", label: "GitLab", binaries: ["glab"], detail: "Merge requests, issues, pipelines.", formula: "glab" },
  { id: "jira", label: "Jira", binaries: ["jira"], detail: "Read, create, and move issues.", formula: "ankitpokhrel/jira-cli/jira-cli" },
  { id: "todoist", label: "Todoist", binaries: ["todoist"], detail: "List, add, and close tasks.", formula: "sachaos/todoist/todoist" },
];

/** One catalog entry with the probe's answer: the binary found, or "" for not installed. */
export type DetectedConnection = Omit<ConnectionCatalogEntry, "binaries"> & { binary: string };

const BARE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** A formula is a bare name or a tapped `owner/tap/name`; nothing else is accepted. */
const FORMULA = /^[a-z][a-z0-9-]{0,31}(\/[a-z][a-z0-9-]{0,31}){0,2}$/;

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

/**
 * One `bash -lc` for the whole catalog: the same login shell the `terminal` tool
 * runs commands under, so a binary that is on the agent's PATH is the one detected.
 *
 * The script's own exit status is whatever its last `command -v` returned, so the
 * output is read whether or not execFile reports an error.
 */
function probe(script: string, timeout = 5_000): Promise<{ output: string; failed: boolean }> {
  return new Promise((resolve) => {
    execFile("/bin/bash", ["-lc", script], { timeout, maxBuffer: 1024 * 1024, env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" } }, (error, stdout, stderr) => resolve({ output: `${stdout ?? ""}${stderr ?? ""}`, failed: Boolean(error) }));
  });
}

export async function detectConnections(entries: readonly ConnectionCatalogEntry[] = CONNECTIONS): Promise<DetectedConnection[]> {
  assertCatalog(entries);
  const script = entries.flatMap((entry) => entry.binaries).map((binary) => `command -v ${binary} >/dev/null 2>&1 && echo ${binary}`).join("\n");
  const found = new Set((await probe(script)).output.split("\n").map((line) => line.trim()).filter(Boolean));
  return entries.map(({ binaries, ...entry }) => ({ ...entry, binary: binaries.find((binary) => found.has(binary)) ?? "" }));
}

/** Formulae are printed tap-qualified or bare depending on the tap, so match on the last segment. */
const formulaName = (formula: string) => formula.slice(formula.lastIndexOf("/") + 1);

/**
 * The ids Homebrew has a newer build for. Its own check, not part of `detectConnections`,
 * because `brew outdated` walks every installed formula and the list has to draw first.
 */
export async function outdatedConnections(entries: readonly ConnectionCatalogEntry[] = CONNECTIONS): Promise<string[]> {
  assertCatalog(entries);
  const { output, failed } = await probe("command -v brew >/dev/null 2>&1 && brew outdated --quiet 2>/dev/null", 60_000);
  if (failed) return [];
  const stale = new Set(output.split("\n").map((line) => formulaName(line.trim())).filter(Boolean));
  return entries.filter((entry) => stale.has(formulaName(entry.formula))).map((entry) => entry.id);
}

/** Installs or upgrades one catalogued formula — the user's click is the only thing that starts it. */
export async function setUpConnection(id: string, action: "install" | "upgrade", entries: readonly ConnectionCatalogEntry[] = CONNECTIONS): Promise<{ ok: boolean; message: string }> {
  const entry = assertCatalog(entries).find((item) => item.id === id);
  if (!entry) throw new Error("Unknown connection");
  const { output, failed } = await probe(`command -v brew >/dev/null 2>&1 || { echo "Homebrew is not installed — see brew.sh"; exit 1; }\nbrew ${action} ${entry.formula}`, 600_000);
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!failed) return { ok: true, message: action === "install" ? `${entry.label} installed.` : `${entry.label} is up to date.` };
  return { ok: false, message: lines.filter((line) => line.toLowerCase().includes("error")).pop() ?? lines.at(-1) ?? `brew ${action} failed.` };
}

/** The system-context block for the connections that are both switched on and installed. */
export function describeConnections(detected: readonly DetectedConnection[], ids: readonly string[]): string {
  const lines = detected
    .filter((item) => item.binary && ids.includes(item.id))
    .map((item) => `- ${item.label} — \`${item.binary}\`. ${item.detail} Run \`${item.binary} --help\` first if you are unsure of its subcommands.`);
  if (!lines.length) return "";
  return `Third-party command-line tools the user has connected on this Mac. Use them through the terminal tool, which needs a connected folder as its working directory:\n\n${lines.join("\n")}`;
}

let probedIds = "";
let probedBlock = "";

/** Rebuilds on a change of selection only — one probe per change, not per turn. */
export async function connectionsBlock(ids: readonly string[]): Promise<string> {
  const key = [...ids].sort().join(",");
  if (key === probedIds) return probedBlock;
  const block = describeConnections(await detectConnections(), ids);
  probedIds = key;
  probedBlock = block;
  return block;
}
