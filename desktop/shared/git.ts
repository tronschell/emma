export type GitFileEntry = {
  path: string;
  index: string;
  work: string;
  from?: string;
};

export type GitSnapshot = {
  branch: string;
  head: string;
  upstream: string;
  ahead: number;
  behind: number;
  worktree: boolean;
  branches: string[];
  remotes: string[];
  files: GitFileEntry[];
  diff: string;
  truncated: boolean;
};

export type GitCommit = {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  when: number;
  refs: string[];
};

export type GitHistory = { commits: GitCommit[]; more: boolean };

export type GitCommandResult = { ok: boolean; output: string };

export type WorktreeEntry = {
  path: string;
  head: string;
  branch: string;
  primary: boolean;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  dirty: boolean;
};

export function parseWorktrees(text: string, primaryPath: string): WorktreeEntry[] {
  const rows: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | undefined;
  const flush = () => {
    if (!current?.path) return;
    rows.push({
      path: current.path,
      head: current.head ?? "",
      branch: current.branch ?? "",
      primary: current.path === primaryPath,
      bare: current.bare ?? false,
      detached: current.detached ?? false,
      locked: current.locked ?? false,
      prunable: current.prunable ?? false,
      dirty: current.dirty ?? false,
    });
    current = undefined;
  };
  for (const field of text.split("\0")) {
    if (!field) { flush(); continue; }
    if (field.startsWith("worktree ")) { flush(); current = { path: field.slice("worktree ".length) };
    } else if (field.startsWith("HEAD ")) { current = current ?? {}; current.head = field.slice("HEAD ".length);
    } else if (field.startsWith("branch ")) { current = current ?? {}; current.branch = field.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (field === "detached") { current = current ?? {}; current.detached = true;
    } else if (field === "bare") { current = current ?? {}; current.bare = true;
    } else if (field.startsWith("locked")) { current = current ?? {}; current.locked = true;
    } else if (field.startsWith("prunable")) { current = current ?? {}; current.prunable = true;
    } else if (field.startsWith("dirty")) { current = current ?? {}; current.dirty = true; }
  }
  flush();
  return rows;
}

export function branchPrefixName(prefix: string, name: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (!clean) throw new Error("Give the branch a name.");
  const stem = prefix.replace(/[^A-Za-z0-9._/-]+/g, "").replace(/\/+$/, "");
  return stem ? `${stem}/${clean}` : clean;
}

export type GitReady = "ready" | "no-git" | "no-repo";

export type GitFileState = "new" | "modified" | "deleted" | "renamed" | "untracked" | "conflict";

export function worktreeName(threadId: string): string {
  return `emma-${threadId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "thread"}`;
}

export function fileState(entry: GitFileEntry): GitFileState {
  const { index, work } = entry;
  if (index === "?" || work === "?") return "untracked";
  if (index === "U" || work === "U" || (index === "A" && work === "A") || (index === "D" && work === "D")) return "conflict";
  if (index === "R") return "renamed";
  if (index === "A") return "new";
  if (index === "D" || work === "D") return "deleted";
  return "modified";
}

export function parseStatus(text: string): GitFileEntry[] {
  const entries: GitFileEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.length < 4) continue;
    const index = line[0] === "?" ? "?" : line[0];
    const work = line[1] === "?" ? "?" : line[1];
    const rest = line.slice(3);
    const split = rest.indexOf(" -> ");
    if (split >= 0) entries.push({ path: rest.slice(split + 4), index, work, from: rest.slice(0, split) });
    else entries.push({ path: rest, index, work });
  }
  return entries;
}

export function parseHistory(text: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of text.split("\x00")) {
    const line = record.trim();
    if (!line) continue;
    const [hash, parents, when, author, refs, ...subject] = line.split("\x01");
    if (!hash) continue;
    commits.push({
      hash,
      parents: (parents ?? "").split(" ").filter(Boolean),
      when: Number(when) * 1000 || 0,
      author: author ?? "",
      refs: (refs ?? "").split(", ").map((ref) => ref.replace(/^HEAD -> /, "").trim()).filter(Boolean),
      subject: subject.join("\x01"),
    });
  }
  return commits;
}

export type GraphLink = { from: number; to: number };
export type GraphRow = { commit: GitCommit; lane: number; lanes: number; links: GraphLink[] };

export function layoutHistory(commits: GitCommit[]): GraphRow[] {
  const active: (string | undefined)[] = [];
  const free = () => {
    const spare = active.indexOf(undefined);
    if (spare >= 0) return spare;
    active.push(undefined);
    return active.length - 1;
  };
  return commits.map((commit) => {
    let lane = active.indexOf(commit.hash);
    if (lane < 0) lane = free();
    active[lane] = undefined;
    const taken = new Map<number, true>();
    commit.parents.forEach((parent, index) => {
      let target = active.indexOf(parent);
      if (target < 0) target = index === 0 && active[lane] === undefined ? lane : free();
      active[target] = parent;
      taken.set(target, true);
    });
    const links: GraphLink[] = [];
    active.forEach((waiting, index) => {
      if (waiting === undefined) return;
      links.push({ from: taken.has(index) ? lane : index, to: index });
    });
    while (active.length && active[active.length - 1] === undefined) active.pop();
    return { commit, lane, lanes: active.length, links };
  });
}

export type DiffLine = { kind: " " | "+" | "-" | "@"; text: string };
export type DiffFile = { path: string; added: number; removed: number; lines: DiffLine[] };

export const MAX_DIFF_LINES = 600;

const strip = (path: string) => path.replace(/^[ab]\//, "").replace(/\t.*$/, "");

export function parseDiff(text: string, max = MAX_DIFF_LINES): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let removedPath = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) { current = undefined; continue; }
    if (line.startsWith("--- ")) { removedPath = strip(line.slice(4)); continue; }
    if (line.startsWith("+++ ")) {
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

export const MAX_GIT_ARGS = 32;
export const MAX_GIT_ARG_CHARS = 512;

export function gitArgv(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote = "";
  let held = false;
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) quote = "";
      else current += character;
      continue;
    }
    if (character === "'" || character === "\"") { quote = character; held = true; continue; }
    if (/\s/.test(character)) {
      if (current || held) args.push(current);
      current = "";
      held = false;
      continue;
    }
    current += character;
  }
  if (quote) throw new Error("That command has an unclosed quote.");
  if (current || held) args.push(current);
  if (args[0] === "git") args.shift();
  return args;
}

export function validateGitArgs(args: unknown): string[] {
  if (!Array.isArray(args) || !args.length) throw new Error("Type a git subcommand to run.");
  if (args.length > MAX_GIT_ARGS) throw new Error(`A git command takes at most ${MAX_GIT_ARGS} arguments here.`);
  const checked = args.map((arg) => {
    if (typeof arg !== "string" || arg.length > MAX_GIT_ARG_CHARS) throw new Error("That argument is not something git can be given.");
    if (arg.includes("\0")) throw new Error("That argument is not something git can be given.");
    return arg;
  });
  if (checked[0].startsWith("-")) throw new Error("Start with the subcommand itself — git's own options before it are not run here.");
  return checked;
}

export function matchesFilter(query: string, path: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const target = path.toLowerCase();
  const name = target.slice(target.lastIndexOf("/") + 1);
  return terms.every((term) => {
    const extension = term.startsWith("*.") ? term.slice(1) : term.startsWith(".") ? term : "";
    if (extension) return target.endsWith(extension);
    if (target.includes(term)) return true;
    let at = 0;
    for (const letter of term) {
      at = name.indexOf(letter, at) + 1;
      if (!at) return false;
    }
    return true;
  });
}
