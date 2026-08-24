/* The Git view: what the working tree of this thread's folder looks like against
   the last commit, whichever loop wrote it. The Changes tab only knows the edits
   Emma recorded; git knows what a shell one-liner did too.
   The same panel draws twice: narrow in the inspector rail, and full-width in its own
   tab, where the per-file line cap comes off. Either way each file can be handed to
   an editor. */

import { useEffect, useMemo, useState } from "react";
import { MAX_DIFF_LINES, parseDiff, type GitSnapshot } from "../shared/git";
import { ChangeCount } from "./agents";
import { OpenIn } from "./editors";
import { plural } from "./plural";

/* The mark beside each path. Every file in assets/filetypes is either a Simple
   Icons mark (CC0, recoloured #fff like the brand marks — the trademark stays
   with its owner) or, for the categories no language owns, one drawn on the same
   24-unit grid. Globbed rather than listed: sixty `new URL` lines to say what the
   filename already says are sixty lines that can drift from the folder. */
const MARKS = import.meta.glob<string>("../assets/filetypes/*.svg", { eager: true, query: "?url", import: "default" });
const mark = (name: string): string | undefined => MARKS[`../assets/filetypes/${name}.svg`];

/* Mark → the extensions that land on it, so each mark is named once. An extension
   absent from here uses the file of its own name if one exists, which covers most
   of them: rust, py, go, swift, zig, css, json, toml, svg, php, lua, dart, nim… */
const GROUPS: Record<string, string> = {
  rust: "rs", js: "mjs cjs", ts: "mts cts", react: "jsx tsx", py: "pyi pyw ipynb", md: "markdown mdx",
  julia: "jl", crystal: "cr", sass: "scss", yaml: "yml",
  html: "htm xhtml", sh: "bash zsh fish ksh", cpp: "cc cxx hpp hh hxx", c: "h", csharp: "cs csx cshtml csproj",
  elixir: "ex exs heex", erlang: "erl hrl", haskell: "hs lhs", clojure: "clj cljs cljc edn", ocaml: "ml mli",
  perl: "pl pm", ruby: "rb erb rake gemspec", fsharp: "fs fsx fsi fsproj", kotlin: "kt kts", java: "class jar",
  scala: "sc", graphql: "gql", tex: "latex bib", wasm: "wat", groovy: "gvy", racket: "rkt", solidity: "sol",
  terraform: "tf tfvars hcl", vim: "vimrc nvim", db: "sql sqlite3", fortran: "f f90 f95 for",
  image: "png jpg jpeg webp gif avif tiff tif bmp ico heic heif dng raw cr2 nef arw psd icns",
  font: "woff woff2 ttf otf eot", audio: "mp3 wav flac aac ogg oga m4a opus aiff",
  video: "mp4 mov avi mkv webm m4v mpg mpeg", archive: "zip tar gz tgz bz2 xz zst 7z rar dmg pkg",
  config: "ini conf cfg properties plist editorconfig", binary: "o a so dylib exe bin node",
  doc: "txt log pdf rtf csv tsv",
};
const BY_EXTENSION = new Map(Object.entries(GROUPS).flatMap(([name, extensions]) => extensions.split(" ").map((extension) => [extension, name] as const)));
/* Keyed on the name up to its first dot, so Dockerfile.dev lands with Dockerfile. */
const BY_NAME: Record<string, string> = { dockerfile: "docker", containerfile: "docker", makefile: "c", cmakelists: "c", justfile: "sh", brewfile: "sh", rakefile: "ruby", gemfile: "ruby", podfile: "ruby", cargo: "rust" };

/** The mark for a path, or the extension in text for the long tail without one. */
export function FileMark({ path }: { path: string }) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const src = name.startsWith(".env") ? mark("config")
    : name.startsWith(".git") ? mark("git")
    : /(\.lock|-lock\.(json|ya?ml))$/.test(name) ? mark("lock")
    : mark(BY_NAME[name.replace(/\..*$/, "")] ?? BY_EXTENSION.get(extension) ?? extension);
  // Truncated, and a dot for LICENSE and friends: the column holds one width for
  // every row, so the paths beside it stay on a single left edge.
  return <span className="git-type" aria-hidden>{src ? <img src={src} alt="" /> : extension.slice(0, 4) || "·"}</span>;
}

/** Refreshed whenever a turn starts or ends, and whenever main says something changed. */
export function useGit(folderId: string | undefined, sending: boolean): GitSnapshot | null {
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  useEffect(() => {
    if (!folderId) return;
    let active = true;
    const load = () => void window.emma.gitStatus(folderId)
      .then((value) => { if (active) setSnapshot(value); })
      .catch(() => { if (active) setSnapshot(null); });
    load();
    const listener = window.emma.onChanged(load);
    return () => { active = false; window.emma.offChanged(listener); };
  }, [folderId, sending]);
  // Detaching the folder hides the tab here rather than in the effect: a state
  // write in an effect body costs a second render pass for the same answer.
  return folderId ? snapshot : null;
}

export function GitPanel({ snapshot, folderId, full, onOpen }: { snapshot: GitSnapshot; folderId?: string; full?: boolean; onOpen?: () => void }) {
  // No cap in the tab: the whole point of opening it is the diff the rail cut off.
  const files = useMemo(() => parseDiff(snapshot.diff, full ? Infinity : MAX_DIFF_LINES), [snapshot.diff, full]);
  const total = files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
  return <div className={`git-panel ${full ? "git-page" : ""}`}>
    <section className="git-head">
      <span>Branch</span>
      <strong>{snapshot.branch}</strong>
      {onOpen && <button type="button" className="git-expand" title="Open the full diff in a tab" aria-label="Open the full diff in a tab" onClick={onOpen}>⤢</button>}
      <small>{files.length ? `${files.length} ${plural(files.length, "file")} uncommitted` : "Working tree clean"}</small>
      {files.length > 0 && <ChangeCount stat={total} />}
      {snapshot.truncated && <small>Diff cut at its size limit — later files are not listed.</small>}
    </section>
    {files.map((file) => <details className="git-file" key={file.path} open={full}>
      <summary>
        <FileMark path={file.path} />
        <span className="git-path">{file.path}</span>
        <ChangeCount stat={file} />
        {folderId && <OpenIn folderId={folderId} path={file.path} />}
      </summary>
      <pre className="diff">{file.lines.map((line, index) => <span key={index}
        className={line.kind === "+" ? "added" : line.kind === "-" ? "removed" : line.kind === "@" ? "hunk" : undefined}>{line.kind === "@" ? "" : line.kind}{line.text}{"\n"}</span>)}
        {!full && file.lines.length >= MAX_DIFF_LINES && <span>… truncated at {MAX_DIFF_LINES} lines — open the Git tab for the rest</span>}</pre>
    </details>)}
  </div>;
}
