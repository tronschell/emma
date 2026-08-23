/* The working tree of a connected folder, as git sees it. Main runs the commands;
   this is the parse both sides name, so the diff the panel paints is git's own
   unified output rather than a second guess at what changed. */

export type GitSnapshot = {
  branch: string;
  /** This folder is a linked worktree of the repo, not its main checkout. */
  worktree: boolean;
  /** Local branches, most recently committed to first. Bounded; may omit the tail. */
  branches: string[];
  /** Unified diff of everything uncommitted, tracked and new, as one document. */
  diff: string;
  /** The diff hit its size ceiling, so the tail of it — whole files — is missing. */
  truncated: boolean;
};

/** The branch and directory a thread's worktree takes: one thread, one checkout, and
    a name main can accept as both without escaping anywhere. */
export function worktreeName(threadId: string): string {
  return `emma-${threadId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "thread"}`;
}

export type DiffLine ={ kind: " " | "+" | "-" | "@"; text: string };
export type DiffFile = { path: string; added: number; removed: number; lines: DiffLine[] };

/* ponytail: one file's rendered hunks stop here; the counts stay exact. Raise it
   if someone actually reads a 600-line diff in a 300px rail. */
export const MAX_DIFF_LINES = 600;

const strip = (path: string) => path.replace(/^[ab]\//, "").replace(/\t.*$/, "");

/** Splits `git diff` output into per-file diffs. Unknown header lines are dropped.
    `max` is per file: the rail keeps the default, the full-page tab lifts it. */
export function parseDiff(text: string, max = MAX_DIFF_LINES): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let removedPath = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) { current = undefined; continue; }
    if (line.startsWith("--- ")) { removedPath = strip(line.slice(4)); continue; }
    if (line.startsWith("+++ ")) {
      // A deleted file's new side is /dev/null, so its name is on the old side.
      const added = strip(line.slice(4));
      current = { path: added === "/dev/null" ? removedPath : added, added: 0, removed: 0, lines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    const kind = line[0];
    if (line.startsWith("@@")) { push(current, { kind: "@", text: line }, max); continue; }
    if (kind === "+") { current.added += 1; push(current, { kind: "+", text: line.slice(1) }, max); }
    else if (kind === "-") { current.removed += 1; push(current, { kind: "-", text: line.slice(1) }, max); }
    else if (kind === " ") push(current, { kind: " ", text: line.slice(1) }, max);
  }
  return files;
}

function push(file: DiffFile, line: DiffLine, max: number) {
  if (file.lines.length < max) file.lines.push(line);
}
