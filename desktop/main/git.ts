/* Reads a connected folder's git state, and moves a thread between checkouts of it.
   Everything here reports except `addWorktree` and `switchBranch`, and those two only
   add a checkout or move to one — nothing stages, commits, or discards work. */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GitSnapshot } from "../shared/git";

/** What the panel renders. The buffer below is larger so an oversized diff is
    cut deliberately rather than failing the command that produced it. */
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED = 20;
/* ponytail: the menu lists this many branches and stops. A repo with more than 200
   wants a search field, not a longer list. */
const MAX_BRANCHES = 200;
const TIMEOUT_MS = 10_000;

/** Git's stderr without `execFile`'s "Command failed: git <args>" first line. */
export function gitFailure(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  const body = raw.replace(/^Command failed: git\b.*\n?/, "").trim();
  return body || raw || "git failed";
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: MAX_BUFFER_BYTES, timeout: TIMEOUT_MS }, (error, stdout) => {
      // `diff --no-index` exits 1 when the files differ, which is the whole point
      // of running it, so output wins over exit status.
      // Git's own refusal is what the composer shows — "your local changes would be
      // overwritten" is the useful sentence. Node's "Command failed: git switch x"
      // preamble in front of it is not.
      if (error && !stdout) reject(new Error(gitFailure(error)));
      else resolve(stdout);
    });
  });
}

/** Null when the folder is not a repo — the Git tab hides rather than showing an error. */
export async function gitSnapshot(cwd: string): Promise<GitSnapshot | null> {
  let status: string;
  // One call for both "is this a repo" and "which branch": it works in a repo
  // with no commits yet, where rev-parse HEAD does not.
  try { status = await git(cwd, ["-c", "core.quotepath=false", "status", "--porcelain", "-b"]); }
  catch { return null; }
  const head = status.split("\n")[0] ?? "";
  const branch = /^## No commits yet on (.+)$/.exec(head)?.[1]
    ?? (head.replace(/^## /, "").split(/\.\.\.| /)[0] || "HEAD");
  const tracked = await git(cwd, ["diff", "--no-color", "HEAD"])
    .catch(() => git(cwd, ["diff", "--no-color"]).catch(() => ""));
  const untracked = (await git(cwd, ["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard"]).catch(() => ""))
    .split("\n").filter(Boolean).slice(0, MAX_UNTRACKED);
  // A new file has no diff of its own, so it is diffed against nothing — same
  // unified output, all green, and the parser needs no second shape for it.
  const created = await Promise.all(untracked.map((file) =>
    git(cwd, ["diff", "--no-color", "--no-index", "--", "/dev/null", file]).catch(() => "")));
  const whole = [tracked, ...created].filter(Boolean).join("\n");
  // Cut on a line boundary, and say so: a diff that just stops looks like a
  // repository with fewer changed files than it has.
  const diff = whole.length > MAX_DIFF_BYTES ? whole.slice(0, whole.lastIndexOf("\n", MAX_DIFF_BYTES)) : whole;
  const [own, common] = await gitDirs(cwd).catch(() => ["", ""]);
  // Newest first: the branch someone wants next is nearly always one they touched recently.
  const branches = (await git(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]).catch(() => ""))
    .split("\n").filter(Boolean).slice(0, MAX_BRANCHES);
  return { branch, worktree: !!own && own !== common, branches, diff, truncated: diff.length < whole.length };
}

/** Moves this checkout onto a branch, creating it from HEAD when asked. The name is
    put to git itself rather than to a regex, so exactly what git refuses is refused. */
export async function switchBranch(cwd: string, branch: string, create: boolean): Promise<void> {
  // check-ref-format would read a leading dash as one of its own flags.
  if (branch.startsWith("-")) throw new Error("A branch name cannot start with “-”.");
  await git(cwd, ["check-ref-format", "--branch", branch]).catch(() => { throw new Error(`“${branch}” is not a name git can use for a branch.`); });
  await git(cwd, create ? ["switch", "-c", branch] : ["switch", branch]);
}

/** This checkout's own git dir and the repo's shared one. They differ exactly
    when cwd is a linked worktree, which is also how the main checkout is found. */
async function gitDirs(cwd: string): Promise<[string, string]> {
  const lines = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])).trim().split("\n");
  return [lines[0] ?? "", lines[1] ?? lines[0] ?? ""];
}

/** The checkout the repo's git dir lives in — where a linked worktree came from.
    Called on the main checkout it returns that same folder, so switching back is a no-op. */
export async function mainCheckout(cwd: string): Promise<string> {
  const [, common] = await gitDirs(cwd);
  return path.dirname(common);
}

/** A linked worktree of this repo on its own branch, created on first use. It sits
    beside the repo rather than inside it, so neither checkout sees the other's files. */
export async function addWorktree(cwd: string, name: string): Promise<string> {
  const top = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const dir = path.join(path.dirname(top), `${path.basename(top)}-worktrees`, name);
  if (existsSync(dir)) return dir;
  // A branch of this name already exists when the worktree was removed and asked for
  // again: check it out rather than -B, which would reset it to HEAD and lose commits.
  await git(top, ["worktree", "add", "-b", name, dir]).catch(() => git(top, ["worktree", "add", dir, name]));
  if (!existsSync(dir)) throw new Error(`git could not create a worktree at ${dir}.`);
  return dir;
}
