import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_FILE_BYTES, MAX_FOLDER_FILES, MAX_FOLDERS, type FolderFile, type FolderGrant } from "../shared/folders";

const SKIP_DIRECTORIES = new Set(["node_modules", "target", "dist", "build", "__pycache__", ".venv", "vendor"]);
const TEXT_FILE = /\.(md|markdown|txt|rst|org|json|jsonc|ya?ml|toml|ini|csv|tsv|tsx?|jsx?|mjs|cjs|rs|zig|py|go|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|sql|css|scss|html?|xml|tex|env|gitignore)$/i;
const MAX_DEPTH = 6;

/**
 * The folders the user has granted through the native picker. The renderer only ever
 * names a grant by ID, so a compromised renderer cannot reach outside them, and every
 * read is re-checked against the grant's real path before it opens a file.
 */
export class FolderStore {
  private readonly file: string;
  private grants: FolderGrant[] = [];

  constructor(userData: string) {
    this.file = path.join(userData, "folders.json");
    try {
      const stored = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (Array.isArray(stored)) {
        this.grants = stored.filter((item): item is FolderGrant =>
          !!item && typeof item === "object" && typeof (item as FolderGrant).id === "string" && typeof (item as FolderGrant).path === "string" && typeof (item as FolderGrant).name === "string").slice(0, MAX_FOLDERS);
      }
    } catch { this.grants = []; }
  }

  list(): FolderGrant[] {
    return this.grants.map((grant) => ({ ...grant }));
  }

  add(directory: string): FolderGrant[] {
    const resolved = realpathSync(directory);
    if (!statSync(resolved).isDirectory()) throw new Error("That is not a folder.");
    if (!this.grants.some((grant) => grant.path === resolved)) {
      if (this.grants.length >= MAX_FOLDERS) throw new Error(`Emma keeps at most ${MAX_FOLDERS} folders; remove one first.`);
      this.grants.push({ id: randomUUID(), path: resolved, name: path.basename(resolved) || resolved });
      this.save();
    }
    return this.list();
  }

  remove(id: string): FolderGrant[] {
    const kept = this.grants.filter((grant) => grant.id !== id);
    if (kept.length !== this.grants.length) { this.grants = kept; this.save(); }
    return this.list();
  }

  /** Text files under a grant, breadth-bounded so a huge tree cannot stall the composer. */
  files(id: string): FolderFile[] {
    const root = this.root(id);
    const found: FolderFile[] = [];
    const walk = (directory: string, depth: number) => {
      if (depth > MAX_DEPTH || found.length >= MAX_FOLDER_FILES) return;
      let entries: import("node:fs").Dirent<string>[];
      try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (found.length >= MAX_FOLDER_FILES) return;
        if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue;
        const full = path.join(directory, entry.name);
        // Symlinks are neither file nor directory here, so they are skipped without a stat.
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && TEXT_FILE.test(entry.name)) {
          const bytes = statSync(full).size;
          if (bytes <= MAX_FILE_BYTES) found.push({ path: path.relative(root, full), bytes });
        }
      }
    };
    walk(root, 0);
    return found.sort((left, right) => left.path.localeCompare(right.path));
  }

  read(id: string, relative: string): { path: string; text: string } {
    const root = this.root(id);
    const full = realpathSync(path.resolve(root, relative));
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error("That file is outside the granted folder.");
    if (!statSync(full).isFile() || statSync(full).size > MAX_FILE_BYTES) throw new Error("That file cannot be attached.");
    return { path: path.relative(root, full), text: readFileSync(full, "utf8") };
  }

  /**
   * Replaces a file's whole contents, creating it and its parent folders if needed.
   * The path is resolved against the grant's *real* path and re-checked after every
   * symlink hop that already exists, so neither `../` nor a planted link escapes.
   */
  write(id: string, relative: string, text: string): { path: string; before: string | null } {
    const root = this.root(id);
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error(`Emma writes at most ${MAX_FILE_BYTES} bytes to one file.`);
    const full = this.contain(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    // A directory in the way is not something a whole-file write should clobber.
    let before: string | null = null;
    try {
      const stats = statSync(full);
      if (!stats.isFile()) throw new Error("That path is not a file.");
      if (stats.size <= MAX_FILE_BYTES) before = readFileSync(full, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    writeFileSync(full, text, "utf8");
    return { path: path.relative(root, full), before };
  }

  /** The real directory a grant points at, for a command's working directory. */
  directory(id: string): string {
    return this.root(id);
  }

  /**
   * A path inside a grant, back as a relative one, for a search root. Contained
   * by the same walk `write` uses, so `../` and a planted symlink are refused
   * before anything is spawned against it.
   */
  within(id: string, relative: string): string {
    const root = this.root(id);
    // The root itself has no parent to walk up from, so `contain` never sees it.
    if (!path.isAbsolute(relative) && path.resolve(root, relative) === root) return ".";
    return path.relative(root, this.contain(root, relative));
  }

  /**
   * Resolves a relative path inside a grant without requiring the leaf to exist.
   * Every existing ancestor is realpath'd, so a symlink partway up cannot land the
   * write outside the folder the user granted.
   */
  private contain(root: string, relative: string): string {
    if (path.isAbsolute(relative)) throw new Error("Name the file relative to the granted folder.");
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error("That file is outside the granted folder.");
    let existing = path.dirname(target);
    // Walk up to the deepest ancestor that exists; only that one can be realpath'd.
    while (existing !== root && existing.startsWith(root + path.sep) && !this.exists(existing)) {
      existing = path.dirname(existing);
    }
    const real = realpathSync(existing);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error("That file is outside the granted folder.");
    return target;
  }

  private exists(directory: string): boolean {
    try { statSync(directory); return true; } catch { return false; }
  }

  private root(id: string): string {
    const grant = this.grants.find((item) => item.id === id);
    if (!grant) throw new Error("That folder is no longer connected.");
    try {
      return realpathSync(grant.path);
    } catch {
      // Renamed, moved, or on a volume that went away. Raw as ENOENT this broke the
      // file list, the Play button and every folder-scoped turn at once, each with a
      // path and an errno instead of the one thing to do about it.
      throw new Error(`"${grant.name}" is no longer at ${grant.path} — reconnect it from the ＋ menu.`);
    }
  }

  private save() {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.grants, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
