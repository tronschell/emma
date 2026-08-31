import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isWindows, pathInside, samePath } from "./platform";
import {
  ATTACHMENT_FOLDER,
  DEFAULT_VAULT_FOLDER,
  MAX_ATTACHMENT_BYTES,
  MAX_NOTE_BYTES,
  MAX_TAGS,
  MAX_TITLE_BYTES,
  MAX_VAULT_NOTES,
  attachmentFolder,
  isKeepKind,
  keepKindLabel,
  noteFolder,
  noteSlug,
  validTag,
  validVaultFolder,
  type KeepRequest,
  type KeptNote,
  type VaultChoice,
} from "../shared/vault";

const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const OBSIDIAN_CONFIG = isWindows
  ? path.join(process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"), "obsidian", "obsidian.json")
  : path.join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
const OBSIDIAN_APPS = isWindows ? (() => {
  const local = process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local");
  const programRoots = [process.env.ProgramFiles, process.env.ProgramW6432, process.env["ProgramFiles(x86)"], "C:\\Program Files"]
    .filter((value): value is string => Boolean(value?.trim()));
  const candidates = [
    path.join(local, "Programs", "Obsidian", "Obsidian.exe"),
    path.join(local, "Obsidian", "Obsidian.exe"),
    path.join(local, "Microsoft", "WindowsApps", "Obsidian.exe"),
    ...programRoots.flatMap((root) => [path.join(root, "Obsidian", "Obsidian.exe"), path.join(root, "WindowsApps", "Obsidian.exe")]),
  ];
  for (const root of programRoots.map((value) => path.join(value, "WindowsApps"))) {
    try {
      for (const entry of readdirSync(root)) if (/^Obsidian\.Obsidian(?:_|$)/i.test(entry)) candidates.push(path.join(root, entry, "Obsidian.exe"));
    } catch { continue; }
  }
  return [...new Set(candidates)];
})() : ["/Applications/Obsidian.app", path.join(homedir(), "Applications", "Obsidian.app")];
const BREW = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];

type Frontmatter = Record<string, string | string[]>;

function attempt(action: () => void): boolean {
  try {
    action();
    return true;
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

function clampBytes(value: string, limit: number): string {
  let text = value;
  while (byteLength(text) > limit) text = text.slice(0, Math.min(text.length - 1, Math.floor((text.length * limit) / byteLength(text))));
  return text;
}

function writeAtomic(file: string, data: string | Buffer, mode?: number): void {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, data, mode === undefined ? {} : { mode });
  renameSync(temporary, file);
}

function contains(folder: string, target: string): boolean {
  return pathInside(folder, target);
}

function normalizeVault(value: unknown): VaultChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pick the folder Emma should keep your notes in.");
  const choice = value as Partial<VaultChoice>;
  const root = typeof choice.root === "string" ? choice.root.trim() : "";
  if (!root || !path.isAbsolute(root)) throw new Error("Name your vault with a full path.");
  const folder = validVaultFolder(choice.folder) ? choice.folder : DEFAULT_VAULT_FOLDER;
  const kind = choice.kind === "obsidian" ? "obsidian" : "folder";
  const named = typeof choice.name === "string" ? choice.name.trim().slice(0, 128) : "";
  return { root, folder, kind, name: named || path.basename(root) };
}

const store = (userData: string) => path.join(userData, "vault.json");

export function readVault(userData: string): VaultChoice | null {
  try {
    return normalizeVault(JSON.parse(readFileSync(store(userData), "utf8")));
  } catch {
    return null;
  }
}

export function saveVault(userData: string, choice: VaultChoice): VaultChoice {
  const vault = normalizeVault(choice);
  attempt(() => mkdirSync(noteFolder(vault), { recursive: true }));
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  writeAtomic(store(userData), `${JSON.stringify(vault, null, 2)}\n`, 0o600);
  return vault;
}

export function vaultWritable(vault: VaultChoice): boolean {
  let folder: string;
  try {
    folder = noteFolder(normalizeVault(vault));
  } catch {
    return false;
  }
  const probe = path.join(folder, ".emma-write-check");
  return attempt(() => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(probe, "");
    rmSync(probe);
  });
}

export function detectObsidianVaults(): { name: string; path: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(OBSIDIAN_CONFIG, "utf8"));
  } catch {
    return [];
  }
  const vaults = (parsed as { vaults?: unknown } | null)?.vaults;
  if (!vaults || typeof vaults !== "object" || Array.isArray(vaults)) return [];
  const found: { name: string; path: string }[] = [];
  for (const entry of Object.values(vaults as Record<string, unknown>)) {
    const root = (entry as { path?: unknown } | null)?.path;
    if (typeof root !== "string" || !path.isAbsolute(root)) continue;
    const cleaned = path.resolve(root);
    if (!isDirectory(cleaned) || found.some((item) => samePath(item.path, cleaned))) continue;
    found.push({ name: path.basename(cleaned), path: cleaned });
  }
  return found;
}

export function obsidianInstalled(): boolean {
  return OBSIDIAN_APPS.some((app) => existsSync(app));
}

export function obsidianInstallCommand(): string {
  if (isWindows) return "winget install --id Obsidian.Obsidian --exact";
  return BREW.some((brew) => existsSync(brew)) ? "brew install --cask obsidian" : "";
}

function serializeFrontmatter(fields: Frontmatter): string {
  const lines = Object.entries(fields).map(([key, value]) =>
    Array.isArray(value) ? `${key}: [${value.map((item) => JSON.stringify(item)).join(", ")}]` : `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

function scalar(raw: string): string | string[] {
  const value = raw.trim();
  if (value.startsWith("[")) {
    return value.slice(1, value.endsWith("]") ? -1 : undefined).split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : value;
    } catch {
      return value;
    }
  }
  return value;
}

function parseFrontmatter(text: string): Frontmatter | null {
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  const fields: Frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (pair) fields[pair[1]] = scalar(pair[2]);
  }
  return fields;
}

function fallbackTitle(request: KeepRequest): string {
  const line = (request.text ?? "").split("\n").map((item) => item.trim()).find(Boolean);
  if (request.kind === "page" && request.sourceUrl) {
    try {
      const url = new URL(request.sourceUrl);
      return `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return line ?? keepKindLabel(request.kind);
    }
  }
  if (line) return line.slice(0, 80);
  if (request.kind === "screenshot" && request.sourceApplication) return `Screenshot of ${request.sourceApplication}`;
  return keepKindLabel(request.kind);
}

function freeNotePath(folder: string, slug: string): { file: string; relative: string } {
  for (let index = 1; index <= MAX_VAULT_NOTES; index += 1) {
    const relative = `${slug}${index === 1 ? "" : `-${index}`}.md`;
    const file = path.join(folder, relative);
    if (!existsSync(file)) return { file, relative };
  }
  throw new Error("Your vault already keeps too many notes by that name.");
}

function writeAttachment(vault: VaultChoice, stem: string, image: string): string {
  const match = IMAGE_DATA_URL.exec(image.trim());
  if (!match) throw new Error("That screenshot is not an image Emma can keep.");
  const data = Buffer.from(match[2], "base64");
  if (!data.length || data.length > MAX_ATTACHMENT_BYTES) throw new Error("That screenshot is too large to keep.");
  const folder = attachmentFolder(vault);
  const name = `${stem}.${match[1] === "jpeg" || match[1] === "jpg" ? "jpg" : match[1]}`;
  const file = path.join(folder, name);
  if (!contains(folder, file)) throw new Error("Emma will not write outside your knowledge folder.");
  mkdirSync(folder, { recursive: true });
  writeAtomic(file, data);
  return name;
}

function noteBody(request: KeepRequest, embed: string): string {
  const text = (request.text ?? "").trim();
  if (request.kind === "screenshot") return [embed, text].filter(Boolean).join("\n\n");
  if (request.kind !== "selection") return text;
  const quoted = text.split("\n").map((line) => `> ${line}`).join("\n");
  const from = request.sourceApplication ? `Highlighted in ${request.sourceApplication}` : "";
  return [quoted, from].filter(Boolean).join("\n\n");
}

export async function keepNote(vault: VaultChoice, request: KeepRequest): Promise<KeptNote> {
  const choice = normalizeVault(vault);
  if (!request || typeof request !== "object" || !isKeepKind(request.kind)) throw new Error("Emma keeps screenshots, highlights, pages and notes.");
  const folder = noteFolder(choice);
  mkdirSync(folder, { recursive: true });
  const title = clampBytes((((request.title ?? "").trim() || fallbackTitle(request)).replace(/\s+/g, " ")), MAX_TITLE_BYTES);
  const { file, relative } = freeNotePath(folder, noteSlug(title));
  if (!contains(folder, file)) throw new Error("Emma will not write outside your knowledge folder.");
  const sourceUrl = typeof request.sourceUrl === "string" ? request.sourceUrl.trim().slice(0, 2048) : "";
  const sourceApplication = typeof request.sourceApplication === "string" ? request.sourceApplication.trim().slice(0, 120) : "";
  const embed = request.kind === "screenshot" && typeof request.image === "string" && request.image
    ? `![[${ATTACHMENT_FOLDER}/${writeAttachment(choice, relative.replace(/\.md$/, ""), request.image)}]]`
    : "";
  const savedAt = new Date().toISOString();
  const fields: Frontmatter = {
    title,
    kind: request.kind,
    saved: savedAt,
    ...(sourceUrl ? { source: sourceUrl } : {}),
    ...(sourceApplication ? { application: sourceApplication } : {}),
    tags: [],
  };
  writeAtomic(file, `${serializeFrontmatter(fields)}\n${clampBytes(noteBody(request, embed), MAX_NOTE_BYTES)}\n`);
  return {
    path: file,
    relative,
    title,
    tags: [],
    savedAt,
    kind: request.kind,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(sourceApplication ? { sourceApplication } : {}),
  };
}

function readNote(folder: string, name: string): KeptNote | null {
  const file = path.join(folder, name);
  try {
    const fields = parseFrontmatter(readFileSync(file, "utf8"));
    const kind = fields?.kind;
    if (!fields || !isKeepKind(kind)) return null;
    const saved = typeof fields.saved === "string" ? fields.saved.trim() : "";
    const title = typeof fields.title === "string" ? fields.title.trim() : "";
    const source = typeof fields.source === "string" ? fields.source.trim() : "";
    const application = typeof fields.application === "string" ? fields.application.trim() : "";
    return {
      path: file,
      relative: name,
      title: title || name.replace(/\.md$/, ""),
      tags: (Array.isArray(fields.tags) ? fields.tags : []).filter(validTag).slice(0, MAX_TAGS),
      savedAt: Number.isNaN(Date.parse(saved)) ? statSync(file).mtime.toISOString() : saved,
      kind,
      ...(source ? { sourceUrl: source } : {}),
      ...(application ? { sourceApplication: application } : {}),
    };
  } catch {
    return null;
  }
}

export function listNotes(vault: VaultChoice): KeptNote[] {
  let folder: string;
  try {
    folder = noteFolder(normalizeVault(vault));
  } catch {
    return [];
  }
  let names: string[];
  try {
    names = readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name);
  } catch {
    return [];
  }
  const notes: KeptNote[] = [];
  for (const name of names.slice(0, MAX_VAULT_NOTES * 2)) {
    const note = readNote(folder, name);
    if (note) notes.push(note);
  }
  return notes.sort((left, right) => right.savedAt.localeCompare(left.savedAt)).slice(0, MAX_VAULT_NOTES);
}

export function applyNoteTags(notePath: string, title: string, tags: readonly string[]): void {
  if (typeof notePath !== "string" || !path.isAbsolute(notePath) || !notePath.endsWith(".md")) throw new Error("That is not a note Emma saved.");
  const text = readFileSync(notePath, "utf8");
  const match = FRONTMATTER.exec(text);
  const fields = match ? parseFrontmatter(text) : null;
  if (!match || !fields) throw new Error("That note has no frontmatter to fill in.");
  const kept = typeof fields.title === "string" ? fields.title : "";
  const named = clampBytes(((typeof title === "string" ? title : "").trim() || kept).replace(/\s+/g, " "), MAX_TITLE_BYTES);
  const cleaned = [...new Set((Array.isArray(tags) ? tags : []).filter(validTag))].slice(0, MAX_TAGS);
  writeAtomic(notePath, `${serializeFrontmatter({ ...fields, title: named, tags: cleaned })}${text.slice(match[0].length)}`);
}
