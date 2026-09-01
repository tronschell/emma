export type VaultKind = "obsidian" | "folder";

export type VaultChoice = {
  root: string;
  folder: string;
  kind: VaultKind;
  name: string;
};

export type KeepKind = "screenshot" | "selection" | "page" | "note";

export type KeepRequest = {
  kind: KeepKind;
  title?: string;
  text?: string;
  sourceUrl?: string;
  sourceApplication?: string;
  image?: string;
};

export type KeptNote = {
  path: string;
  relative: string;
  title: string;
  tags: readonly string[];
  savedAt: string;
  kind: KeepKind;
  folder?: string;
  excerpt?: string;
  image?: string;
  sourceUrl?: string;
  sourceApplication?: string;
};

export type NoteFolder = {
  name: string;
  changedAt: string;
};

export const DEFAULT_VAULT_FOLDER = "knowledge-base";
export const ATTACHMENT_FOLDER = "attachments";

export const MAX_NOTE_BYTES = 256 * 1024;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TAGS = 8;
export const MAX_TAG_BYTES = 48;
export const MAX_TITLE_BYTES = 120;
export const MAX_VAULT_NOTES = 2000;

export const KEEP_KINDS: readonly KeepKind[] = ["screenshot", "selection", "page", "note"] as const;

export function isKeepKind(value: unknown): value is KeepKind {
  return typeof value === "string" && (KEEP_KINDS as readonly string[]).includes(value);
}

const byteLength = (value: string) => new TextEncoder().encode(value).length;

export function noteSlug(title: string): string {
  const slug = title.normalize("NFKD").replace(/[^\p{L}\p{N}\p{M}]+/gu, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 60).replace(/-+$/g, "").normalize("NFC");
  return slug || "note";
}

export function clampBytes(value: string, limit: number): string {
  let text = value;
  while (byteLength(text) > limit) text = text.slice(0, Math.min(text.length - 1, Math.floor((text.length * limit) / byteLength(text))));
  return text;
}

export function validTag(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9/-]*$/.test(value) && byteLength(value) <= MAX_TAG_BYTES;
}

export const MAX_FOLDER_NAME = 64;

export function validNoteFolder(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const name = value.trim();
  if (!name || name.length > MAX_FOLDER_NAME || name === ATTACHMENT_FOLDER) return false;
  if (name.startsWith(".") || /[/\\:]/.test(name) || [...name].some((char) => char < " " || char === "\u007f")) return false;
  return true;
}

export function validVaultFolder(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 128) return false;
  if (value.startsWith("/") || value.includes("..") || value.includes("\\")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && !part.startsWith("."));
}

export function noteFolder(vault: VaultChoice): string {
  return `${vault.root}/${vault.folder}`;
}

export function attachmentFolder(vault: VaultChoice): string {
  return `${noteFolder(vault)}/${ATTACHMENT_FOLDER}`;
}

export function obsidianOpenUrl(vault: VaultChoice, relative: string): string {
  if (vault.kind !== "obsidian") return "";
  return `obsidian://open?vault=${encodeURIComponent(vault.name)}&file=${encodeURIComponent(`${vault.folder}/${relative}`.replace(/\.md$/, ""))}`;
}

export function keepKindLabel(kind: KeepKind): string {
  if (kind === "screenshot") return "Screenshot";
  if (kind === "selection") return "Highlight";
  if (kind === "page") return "Page";
  return "Note";
}
