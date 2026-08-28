import { open, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { usageDay } from "../shared/invocations";

const MAX_KEYS = 1024;
const MAX_DAYS = 90;
const MAX_USAGE_BYTES = 1024 * 1024;
const MAX_COUNTED_CALLS = 4096;
const DAY_MILLISECONDS = 86_400_000;
const USAGE_KEY = /^(?:skill|mcp)\/[A-Za-z0-9._/-]{1,200}$/;
const MCP_TOOL = /^mcp__[A-Za-z0-9._-]{1,64}__[A-Za-z0-9._-]{1,96}$/;

export type Usage = Record<string, Record<string, number>>;

const usageFile = (userData: string) => path.join(userData, "usage.json");

export function skillKey(id: unknown) {
  if (typeof id !== "string") return "";
  const parts = id.split(":");
  return parts.length === 4 && parts[0] === "skill" && /^[a-z0-9-]{1,64}$/.test(parts[1]) && /^[a-zA-Z0-9._-]{1,96}$/.test(parts[3]) ? `skill/${parts[1]}/${parts[3]}` : "";
}

export function mcpToolKey(toolName: unknown) {
  return typeof toolName === "string" && MCP_TOOL.test(toolName) ? `mcp/${toolName}` : "";
}

export function mcpServerPrefix(name: string) {
  return `mcp/mcp__${name}__`;
}

export function daysUnder(usage: Usage, prefix: string) {
  const days: Record<string, number> = {};
  for (const [key, counts] of Object.entries(usage)) {
    if (!key.startsWith(prefix)) continue;
    for (const [day, count] of Object.entries(counts)) days[day] = (days[day] ?? 0) + count;
  }
  return days;
}

function parseUsage(value: unknown): Usage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const usage: Usage = {};
  for (const [key, stored] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
    if (!USAGE_KEY.test(key) || !stored || typeof stored !== "object" || Array.isArray(stored)) continue;
    const days: Record<string, number> = {};
    for (const [day, count] of Object.entries(stored as Record<string, unknown>)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof count === "number" && Number.isSafeInteger(count) && count > 0) days[day] = count;
    }
    if (Object.keys(days).length) usage[key] = days;
  }
  return usage;
}

export async function readUsage(userData: string): Promise<Usage> {
  let handle;
  try { handle = await open(usageFile(userData), "r"); }
  catch { return {}; }
  try {
    const information = await handle.stat();
    if (!information.isFile() || information.size > MAX_USAGE_BYTES) return {};
    return parseUsage(JSON.parse(await handle.readFile("utf8")));
  } catch {
    return {};
  } finally {
    await handle.close();
  }
}

const counted = new Set<string>();
let writing: Promise<unknown> = Promise.resolve();

export function recordUse(userData: string, key: string, once = "") {
  if (!key) return writing;
  if (once) {
    if (counted.has(once)) return writing;
    if (counted.size >= MAX_COUNTED_CALLS) counted.clear();
    counted.add(once);
  }
  writing = writing.then(async () => {
    const usage = await readUsage(userData);
    const at = new Date();
    const cutoff = usageDay(new Date(at.getTime() - MAX_DAYS * DAY_MILLISECONDS));
    const day = usageDay(at);
    const days: Record<string, number> = { ...usage[key] };
    days[day] = (days[day] ?? 0) + 1;
    usage[key] = Object.fromEntries(Object.entries(days).filter(([stamp]) => stamp >= cutoff));
    const file = usageFile(userData);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(Object.fromEntries(Object.entries(usage).slice(-MAX_KEYS))), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  }).catch((error: unknown) => console.warn("Emma could not record capability use:", error instanceof Error ? error.message : error));
  return writing;
}
