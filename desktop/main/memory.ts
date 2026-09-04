import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathInside, samePath } from "./platform";

export const MEMORY_ROOT = "/memories";
export const MAX_MEMORY_FILE_BYTES = 256 * 1024;
export const MAX_MEMORY_FILES = 256;
const MAX_VIEW_CHARS = 16_000;
const MAX_LINES = 999_999;

export type MemoryCommand =
  | { command: "view"; path: string; view_range?: [number, number] }
  | { command: "create"; path: string; file_text: string }
  | { command: "str_replace"; path: string; old_str: string; new_str?: string }
  | { command: "insert"; path: string; insert_line: number; insert_text: string }
  | { command: "delete"; path: string }
  | { command: "rename"; old_path: string; new_path: string };

export const MEMORY_COMMANDS = ["view", "create", "str_replace", "insert", "delete", "rename"] as const;

export function resolveMemoryPath(root: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("The memory path must be a non-empty string.");
  if (value.length > 1024) throw new Error("The memory path is too long.");
  if (value !== MEMORY_ROOT && !value.startsWith(`${MEMORY_ROOT}/`)) {
    throw new Error(`Memory paths must start with ${MEMORY_ROOT}. The path ${value} does not exist. Please provide a valid path.`);
  }
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { decoded = value; }
  if (decoded.includes("\0")) throw new Error("The memory path is invalid.");
  const relative = decoded.slice(MEMORY_ROOT.length).replace(/^\/+/, "");
  const resolved = path.resolve(root, relative);
  if (!pathInside(root, resolved)) throw new Error("The memory path is outside the memory directory.");
  return resolved;
}

const isRoot = (root: string, resolved: string) => samePath(root, resolved);

const virtualPath = (root: string, absolute: string) => {
  const relative = path.relative(path.resolve(root), absolute).split(path.sep).join("/");
  return relative ? `${MEMORY_ROOT}/${relative}` : MEMORY_ROOT;
};

const clampText = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new Error(`The "${field}" argument must be a string.`);
  if (Buffer.byteLength(value) > MAX_MEMORY_FILE_BYTES) throw new Error(`Memory files are limited to ${MAX_MEMORY_FILE_BYTES} bytes.`);
  return value;
};

const numbered = (lines: string[], from = 1) => lines.map((line, index) => `${String(from + index).padStart(6, " ")}\t${line}`).join("\n");

const humanSize = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}M` : `${Math.max(1, Math.round(bytes / 1024 * 10) / 10)}K`;

export async function runMemoryCommand(root: string, command: MemoryCommand): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  switch (command.command) {
    case "view": return await view(root, command);
    case "create": return await create(root, command);
    case "str_replace": return await strReplace(root, command);
    case "insert": return await insert(root, command);
    case "delete": return await remove(root, command);
    case "rename": return await move(root, command);
  }
}

async function view(root: string, command: Extract<MemoryCommand, { command: "view" }>): Promise<string> {
  const target = resolveMemoryPath(root, command.path);
  const info = await stat(target).catch(() => undefined);
  if (!info) throw new Error(`The path ${command.path} does not exist. Please provide a valid path.`);
  if (info.isDirectory()) {
    const entries = await listing(root, target);
    return [
      `Here're the files and directories up to 2 levels deep in ${command.path}, excluding hidden items and node_modules:`,
      ...entries,
    ].join("\n");
  }
  const text = await readFile(target, "utf8");
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) throw new Error(`File ${command.path} exceeds maximum line limit of ${MAX_LINES} lines.`);
  if (!command.view_range) {
    const body = numbered(lines);
    const trimmed = body.length > MAX_VIEW_CHARS ? `${body.slice(0, MAX_VIEW_CHARS)}\n… truncated. Read the rest with view_range.` : body;
    return `Here's the content of ${command.path} with line numbers:\n${trimmed}`;
  }
  const [start, end] = command.view_range;
  if (start < 1 || start > lines.length) throw new Error(`Error: Invalid \`view_range\` parameter: ${start}. It should be within the range of lines of the file: [1, ${lines.length}]`);
  const last = end === -1 ? lines.length : Math.min(end, lines.length);
  return `Here's the content of ${command.path} with line numbers:\n${numbered(lines.slice(start - 1, last), start)}`;
}

async function listing(root: string, directory: string, depth = 0): Promise<string[]> {
  const shown = (absolute: string) => virtualPath(root, absolute);
  const self = await stat(directory);
  const rows = [`${humanSize(self.size)}\t${shown(directory)}`];
  if (depth >= 2) return rows;
  let entries: string[];
  try { entries = (await readdir(directory)).sort().slice(0, MAX_MEMORY_FILES); } catch { return rows; }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const absolute = path.join(directory, entry);
    const info = await stat(absolute).catch(() => undefined);
    if (!info) continue;
    if (info.isDirectory()) rows.push(...await listing(root, absolute, depth + 1));
    else rows.push(`${humanSize(info.size)}\t${shown(absolute)}`);
  }
  return rows;
}

async function create(root: string, command: Extract<MemoryCommand, { command: "create" }>): Promise<string> {
  const target = resolveMemoryPath(root, command.path);
  if (isRoot(root, target)) throw new Error(`Error: ${MEMORY_ROOT} is a directory, not a file.`);
  const text = clampText(command.file_text, "file_text");
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, text, { encoding: "utf8", mode: 0o600 });
  return `File created successfully at: ${command.path}`;
}

async function strReplace(root: string, command: Extract<MemoryCommand, { command: "str_replace" }>): Promise<string> {
  const target = resolveMemoryPath(root, command.path);
  const info = await stat(target).catch(() => undefined);
  if (!info || info.isDirectory()) throw new Error(`Error: The path ${command.path} does not exist. Please provide a valid path.`);
  const text = await readFile(target, "utf8");
  const old = clampText(command.old_str, "old_str");
  const replacement = command.new_str === undefined ? "" : clampText(command.new_str, "new_str");
  const first = text.indexOf(old);
  if (first < 0) throw new Error(`No replacement was performed, old_str \`${old}\` did not appear verbatim in ${command.path}.`);
  if (text.indexOf(old, first + 1) >= 0) {
    const lines = text.split("\n").flatMap((line, index) => line.includes(old) ? [index + 1] : []);
    throw new Error(`No replacement was performed. Multiple occurrences of old_str \`${old}\` in lines: ${lines.join(", ")}. Please ensure it is unique`);
  }
  const next = text.slice(0, first) + replacement + text.slice(first + old.length);
  await writeFile(target, clampText(next, "file_text"), { encoding: "utf8", mode: 0o600 });
  const line = text.slice(0, first).split("\n").length;
  const snippet = next.split("\n").slice(Math.max(0, line - 3), line + 3);
  return `The memory file has been edited.\n${numbered(snippet, Math.max(1, line - 2))}`;
}

async function insert(root: string, command: Extract<MemoryCommand, { command: "insert" }>): Promise<string> {
  const target = resolveMemoryPath(root, command.path);
  const info = await stat(target).catch(() => undefined);
  if (!info || info.isDirectory()) throw new Error(`Error: The path ${command.path} does not exist`);
  const lines = (await readFile(target, "utf8")).split("\n");
  if (!Number.isInteger(command.insert_line) || command.insert_line < 0 || command.insert_line > lines.length) {
    throw new Error(`Error: Invalid \`insert_line\` parameter: ${command.insert_line}. It should be within the range of lines of the file: [0, ${lines.length}]`);
  }
  lines.splice(command.insert_line, 0, clampText(command.insert_text, "insert_text").replace(/\n$/, ""));
  await writeFile(target, clampText(lines.join("\n"), "file_text"), { encoding: "utf8", mode: 0o600 });
  return `The file ${command.path} has been edited.`;
}

async function remove(root: string, command: Extract<MemoryCommand, { command: "delete" }>): Promise<string> {
  const target = resolveMemoryPath(root, command.path);
  if (isRoot(root, target)) throw new Error(`Error: ${MEMORY_ROOT} cannot be deleted. Delete the files inside it instead.`);
  if (!await stat(target).catch(() => undefined)) throw new Error(`Error: The path ${command.path} does not exist`);
  await rm(target, { recursive: true, force: true });
  return `Successfully deleted ${command.path}`;
}

async function move(root: string, command: Extract<MemoryCommand, { command: "rename" }>): Promise<string> {
  const from = resolveMemoryPath(root, command.old_path);
  const to = resolveMemoryPath(root, command.new_path);
  if (isRoot(root, from)) throw new Error(`Error: ${MEMORY_ROOT} cannot be renamed.`);
  if (!await stat(from).catch(() => undefined)) throw new Error(`Error: The path ${command.old_path} does not exist`);
  if (await stat(to).catch(() => undefined)) throw new Error(`Error: The destination ${command.new_path} already exists`);
  await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  await rename(from, to);
  return `Successfully renamed ${command.old_path} to ${command.new_path}`;
}

export interface MemoryNote {
  path: string;
  bytes: number;
  updatedAt: number;
  text: string;
}

export async function listMemories(root: string): Promise<MemoryNote[]> {
  const base = path.resolve(root);
  const notes: MemoryNote[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4 || notes.length >= MAX_MEMORY_FILES) return;
    const entries = await readdir(directory).catch(() => [] as string[]);
    for (const entry of entries.sort()) {
      if (entry.startsWith(".") || notes.length >= MAX_MEMORY_FILES) continue;
      const absolute = path.join(directory, entry);
      const info = await stat(absolute).catch(() => undefined);
      if (!info) continue;
      if (info.isDirectory()) { await walk(absolute, depth + 1); continue; }
      const text = info.size > MAX_MEMORY_FILE_BYTES ? "" : await readFile(absolute, "utf8").catch(() => "");
      notes.push({ path: virtualPath(root, absolute), bytes: info.size, updatedAt: info.mtimeMs, text });
    }
  };
  await walk(base, 0);
  return notes.sort((left, right) => right.updatedAt - left.updatedAt);
}
