/* The search tool: ripgrep when there is one, grep when there is not.
 *
 * The argv builders are pure so the flags can be checked without spawning
 * anything, and neither of them goes through a shell — the pattern is a regex
 * the model wrote, and a shell would read half of it as syntax.
 *
 * ponytail: the fallback is chosen by ENOENT rather than by looking first. A
 * missing rg is one wasted spawn on a Mac that never bundled it, which is
 * cheaper than a `which` on every search that works.
 */

import { spawn } from "node:child_process";
import { MAX_TOOL_OUTPUT_BYTES } from "./tools";

export type SearchQuery = {
  pattern: string;
  /** File or subdirectory, relative to the search root. The whole root when absent. */
  path?: string;
  glob?: string;
  literal: boolean;
  ignoreCase: boolean;
};

/** Match lines one call returns. Past this the answer is "narrow the pattern". */
export const MAX_SEARCH_MATCHES = 200;
/** A search across a large tree still finishes in seconds; this is a wedge, not a budget. */
const MAX_SEARCH_MS = 20_000;
/** Long enough that the line the match is on is readable, short enough that a minified file is not. */
const MAX_COLUMNS = 240;

/** ripgrep's argv. It skips .git, .gitignore'd paths and binaries on its own. */
export function ripgrepArgv(query: SearchQuery): string[] {
  // `--with-filename` because a search of one named file drops the name otherwise,
  // and a match with no file in front of it is not something to hand a model.
  const args = ["--line-number", "--with-filename", "--no-heading", "--color=never", "--no-messages", `--max-columns=${MAX_COLUMNS}`];
  if (query.ignoreCase) args.push("--ignore-case");
  if (query.literal) args.push("--fixed-strings");
  if (query.glob) args.push("--glob", query.glob);
  args.push("--regexp", query.pattern, "--", query.path ?? ".");
  return args;
}

/**
 * grep's argv, for a Mac with no ripgrep. Two differences worth knowing: it has
 * no .gitignore, so the noisy directories are excluded by hand, and `--include`
 * matches the file name where rg's `--glob` matches the whole path.
 */
export function grepArgv(query: SearchQuery): string[] {
  const args = ["-rnHIs", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=target", "--exclude-dir=dist"];
  if (query.ignoreCase) args.push("-i");
  if (query.literal) args.push("-F");
  if (query.glob) args.push(`--include=${query.glob}`);
  args.push("-e", query.pattern, "--", query.path ?? ".");
  return args;
}

/** Runs one search under `cwd`, falling back to grep when `ripgrep` is not there. */
export async function runSearch(cwd: string, query: SearchQuery, ripgrep: string): Promise<string> {
  let engine = "ripgrep";
  let result;
  try {
    result = await spawnSearch(cwd, ripgrep, ripgrepArgv(query));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    engine = "grep";
    result = await spawnSearch(cwd, "grep", grepArgv(query));
  }
  const lines = result.output.split("\n").filter((line) => line.trim());
  // Both tools exit 1 for "searched fine, found nothing", which is an answer.
  if (result.code === 1 && !lines.length) return `No matches for ${query.pattern}${query.path ? ` under ${query.path}` : ""}.`;
  if (result.code === null) return `${lines.slice(0, MAX_SEARCH_MATCHES).join("\n")}\n[search killed after ${MAX_SEARCH_MS / 1000}s — narrow it with path or glob]`.trim();
  if (result.code !== 0 && result.code !== 1) return `That search failed (${engine} exit ${result.code}).\n${result.output.trim().slice(0, 2048)}`;
  const shown = lines.slice(0, MAX_SEARCH_MATCHES);
  const body = shown.join("\n").slice(0, MAX_TOOL_OUTPUT_BYTES);
  const more = lines.length > shown.length ? `\n[${lines.length - shown.length} more matches — narrow the pattern, or set path or glob]` : "";
  return body + more;
}

/** Resolves with whatever the child said; rejects only when it could not start. */
function spawnSearch(cwd: string, bin: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (data: Buffer) => { if (output.length < MAX_TOOL_OUTPUT_BYTES * 4) output += String(data); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), MAX_SEARCH_MS);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}
