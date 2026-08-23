import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Where the Markdown mirror of the knowledge base lives. The Rust host reads it from
 * `EMMA_KNOWLEDGE_DIR` when it is spawned, so this is the value `startHost` puts in the
 * environment, and changing it means starting the host again.
 */
export function defaultKnowledgeDir(): string {
  return path.join(homedir(), "Documents", "Emma Knowledge");
}

function store(userData: string): string {
  return path.join(userData, "knowledge-root.json");
}

export function readKnowledgeDir(userData: string): string {
  try {
    const stored = JSON.parse(readFileSync(store(userData), "utf8")) as { path?: unknown };
    if (typeof stored.path === "string" && path.isAbsolute(stored.path)) return stored.path;
  } catch { /* nothing chosen yet */ }
  // A dev run that set the variable itself keeps it, including the empty value that
  // turns the mirror off; the walkthrough's choice is what overrides it from then on.
  return process.env.EMMA_KNOWLEDGE_DIR ?? defaultKnowledgeDir();
}

/** Creates the folder — which is what trips the macOS Documents prompt — and remembers it. */
export function saveKnowledgeDir(userData: string, directory: string): string {
  if (!path.isAbsolute(directory)) throw new Error("Name the knowledge folder with a full path.");
  // macOS may refuse this until Files & Folders is granted, and the walkthrough is
  // where the user goes and grants it, so a refusal must not lose their choice.
  try { mkdirSync(directory, { recursive: true }); } catch { /* `knowledgeDirWritable` reports it */ }
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  const temporary = `${store(userData)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ path: directory }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, store(userData));
  return directory;
}

/**
 * Whether Emma can actually write the knowledge base where it is pointed.
 *
 * TCC has no query for a folder grant, and `access()` does not see it either: a denied
 * Documents folder fails at `open`. So the only honest check is to write something and
 * take it away again.
 */
export function knowledgeDirWritable(directory: string): boolean {
  // An empty path is the mirror switched off, so there is nothing to be denied.
  if (!directory) return true;
  const probe = path.join(directory, ".emma-write-check");
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(probe, "");
    rmSync(probe);
    return true;
  } catch {
    return false;
  }
}
