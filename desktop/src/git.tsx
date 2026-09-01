import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { fileState, gitArgv, layoutHistory, matchesFilter, MAX_DIFF_LINES, parseDiff, type GitCommit, type GitFileState, type GitReady, type GitSnapshot } from "../shared/git";
import { terminalSelection as trimSelection } from "../shared/terminal";
import { ChangeCount } from "./agents";
import type { BrandDefinition } from "./brands";
import { pickIntoComposer } from "./context";
import { OpenIn } from "./editors";
import { BrandIcon } from "./icons";
import { reasonText } from "./errors";
import { ReadMarkdown } from "./preview";
import { plural } from "./plural";

const MARKS = import.meta.glob<string>("../assets/filetypes/*.svg", { eager: true, query: "?url", import: "default" });
const mark = (name: string): string | undefined => MARKS[`../assets/filetypes/${name}.svg`];
const IS_WINDOWS = typeof window !== "undefined" && window.emma?.platform === "win32";
const GIT_INSTALL_COMMAND = IS_WINDOWS ? "winget install --id Git.Git --exact" : "xcode-select --install";

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
const BY_NAME: Record<string, string> = { dockerfile: "docker", containerfile: "docker", makefile: "c", cmakelists: "c", justfile: "sh", brewfile: "sh", rakefile: "ruby", gemfile: "ruby", podfile: "ruby", cargo: "rust" };

export function FileMark({ path }: { path: string }) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const src = name.startsWith(".env") ? mark("config")
    : name.startsWith(".git") ? mark("git")
    : /(\.lock|-lock\.(json|ya?ml))$/.test(name) ? mark("lock")
    : mark(BY_NAME[name.replace(/\..*$/, "")] ?? BY_EXTENSION.get(extension) ?? extension);
  return <span className="git-type" aria-hidden>{src ? <img src={src} alt="" /> : extension.slice(0, 4) || "·"}</span>;
}

export type GitState = { snapshot: GitSnapshot | null; ready: GitReady };

const NO_GIT_STATE: GitState = { snapshot: null, ready: "no-repo" };

export function useGit(folderId: string | undefined, sending: boolean): GitState {
  const [state, setState] = useState<GitState>(NO_GIT_STATE);
  useEffect(() => {
    if (!folderId) return;
    let active = true;
    const load = () => void window.emma.gitStatus(folderId)
      .then(async (snapshot) => {
        if (!active) return;
        if (snapshot) { setState({ snapshot, ready: "ready" }); return; }
        const ready = await window.emma.gitReady(folderId).catch(() => "no-repo" as GitReady);
        if (active) setState({ snapshot: null, ready });
      })
      .catch(() => { if (active) setState(NO_GIT_STATE); });
    load();
    const listener = window.emma.onChanged(load);
    return () => { active = false; window.emma.offChanged(listener); };
  }, [folderId, sending]);
  return folderId ? state : NO_GIT_STATE;
}

export function GitSetup({ ready, folderId }: { ready: GitReady; folderId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const init = () => {
    setBusy(true);
    setError("");
    void window.emma.gitInit(folderId).catch((reason: unknown) => setError(reasonText(reason))).finally(() => setBusy(false));
  };
  return <div className="git-page git-setup">
    <div className="git-setup-card">
      <span className="git-setup-mark" aria-hidden>⑂</span>
      {ready === "no-git"
        ? <><h2>Git is not installed</h2><code>{GIT_INSTALL_COMMAND}</code></>
        : <><h2>No repository here yet</h2><button type="button" className="git-do" disabled={busy} onClick={init}>{busy ? "Starting…" : "git init"}</button></>}
      {error && <p className="git-commit-error" role="alert">{error}</p>}
    </div>
  </div>;
}

function pickHighlight() {
  const selection = getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const node = selection.getRangeAt(0).commonAncestorContainer;
  const path = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".git-file")?.dataset.path;
  const excerpt = path && trimSelection(selection.toString());
  if (path && excerpt) pickIntoComposer({ kind: "diff", id: path, path, ...excerpt });
}

export function GitPanel({ snapshot, folderId, full, onOpen }: { snapshot: GitSnapshot; folderId?: string; full?: boolean; onOpen?: () => void }) {
  const files = useMemo(() => parseDiff(snapshot.diff, full ? Infinity : MAX_DIFF_LINES), [snapshot.diff, full]);
  const total = files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
  return <div className={`git-panel ${full ? "git-page" : ""}`} onMouseUp={pickHighlight}>
    <section className="git-head">
      <span>Branch</span>
      <strong>{snapshot.branch}</strong>
      {onOpen && <button type="button" className="git-expand" title="Open the full diff in a tab" aria-label="Open the full diff in a tab" onClick={onOpen}>⤢</button>}
      <small>{files.length ? `${files.length} ${plural(files.length, "file")} uncommitted` : "Working tree clean"}</small>
      {files.length > 0 && <ChangeCount stat={total} />}
      {snapshot.truncated && <small>Diff cut at its size limit — later files are not listed.</small>}
    </section>
    {files.map((file) => <details className="git-file" data-path={file.path} key={file.path} open={full}>
      <summary>
        <FileMark path={file.path} />
        <span className="git-path">{file.path}</span>
        <ChangeCount stat={file} />
        {folderId && <OpenIn folderId={folderId} path={file.path} />}
        <ReadMarkdown folderId={folderId} path={file.path} />
      </summary>
      <pre className="diff">{file.lines.map((line, index) => <span key={index}
        className={line.kind === "+" ? "added" : line.kind === "-" ? "removed" : line.kind === "@" ? "hunk" : undefined}>{line.kind === "@" ? "" : line.kind}{line.text}{"\n"}</span>)}
        {!full && file.lines.length >= MAX_DIFF_LINES && <span>… truncated at {MAX_DIFF_LINES} lines — open the Git tab for the rest</span>}</pre>
    </details>)}
  </div>;
}

const STATE_LETTER: Record<GitFileState, string> = { modified: "M", new: "A", deleted: "D", renamed: "R", untracked: "?", conflict: "U" };
const NO_CHANGE = { added: 0, removed: 0 };
const HISTORY_PAGE = 40;
const ROW_HEIGHT = 22;
const LANE_PITCH = 14;
const LANE_RADIUS = 3.5;
const LANE_COLOURS = 6;
const CONSOLE_LIMIT = 20_000;

const laneX = (lane: number) => lane * LANE_PITCH + LANE_PITCH / 2;

function ago(when: number): string {
  const minutes = Math.round((Date.now() - when) / 60_000);
  if (!when || !Number.isFinite(minutes)) return "—";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

export function GitPage({ snapshot, folderId, brand }: { snapshot: GitSnapshot; folderId: string; brand?: BrandDefinition }) {
  const [live, setLive] = useState(snapshot);
  const [view, setView] = useState<"changes" | "console">("changes");
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [branchOpen, setBranchOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [base, setBase] = useState("");
  const [draft, setDraft] = useState("");
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [more, setMore] = useState(false);
  const [command, setCommand] = useState("");
  const [filter, setFilter] = useState("");
  const [output, setOutput] = useState("");
  const menu = useRef<HTMLDivElement>(null);

  const reload = useCallback(() => void window.emma.gitStatus(folderId)
    .then((value) => { if (value) setLive(value); })
    .catch(() => undefined), [folderId]);
  useEffect(() => {
    reload();
    const listener = window.emma.onChanged(reload);
    return () => window.emma.offChanged(listener);
  }, [reload]);

  const loadHistory = useCallback((skip: number) => void window.emma.gitHistory({ folderId, skip, limit: HISTORY_PAGE })
    .then((page) => { setCommits((current) => skip ? [...current, ...page.commits] : page.commits); setMore(page.more); })
    .catch(() => { if (!skip) { setCommits([]); setMore(false); } }), [folderId]);
  useEffect(() => loadHistory(0), [loadHistory]);

  const paths = live.files.map((file) => file.path);
  const selected = paths.filter((path) => !excluded.has(path));
  const shownFiles = live.files.filter((file) => matchesFilter(filter, file.path));
  const shownPaths = shownFiles.map((file) => file.path);

  useEffect(() => {
    if (!branchOpen) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) { setBranchOpen(false); setNaming(false); } };
    addEventListener("pointerdown", outside);
    return () => removeEventListener("pointerdown", outside);
  }, [branchOpen]);

  const diffFiles = useMemo(() => parseDiff(live.diff, Infinity).filter((file) => matchesFilter(filter, file.path)), [live.diff, filter]);
  const stats = useMemo(() => new Map(diffFiles.map((file) => [file.path, { added: file.added, removed: file.removed }])), [diffFiles]);
  const rows = useMemo(() => layoutHistory(commits), [commits]);
  const width = rows.reduce((widest, row) => Math.max(widest, row.lanes, row.lane + 1), 1) * LANE_PITCH + LANE_PITCH;

  const toggle = (path: string) => setExcluded((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  const branchTo = (branch: string, create: boolean, from?: string) => {
    if (!branch.trim()) return;
    setError("");
    void window.emma.setBranch({ folderId, branch: branch.trim(), create, from: from && from !== live.branch ? from : undefined })
      .then(() => { reload(); loadHistory(0); })
      .catch((reason: unknown) => setError(reasonText(reason)))
      .finally(() => { setBranchOpen(false); setNaming(false); setDraft(""); });
  };

  const commit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    void window.emma.gitCommit({ folderId, message, paths: selected, amend })
      .then(() => { setMessage(""); setAmend(false); reload(); loadHistory(0); })
      .catch((reason: unknown) => setError(reasonText(reason)))
      .finally(() => setBusy(false));
  };

  const discard = () => {
    if (!selected.length || !confirm(`Throw away the changes in ${selected.length} ${plural(selected.length, "file")}? This cannot be undone.`)) return;
    setBusy(true); setError("");
    void window.emma.gitDiscard({ folderId, paths: selected })
      .then(reload)
      .catch((reason: unknown) => setError(reasonText(reason)))
      .finally(() => setBusy(false));
  };

  const write = () => {
    setBusy(true); setError("");
    void window.emma.gitMessage({ folderId })
      .then(setMessage)
      .catch((reason: unknown) => setError(reasonText(reason)))
      .finally(() => setBusy(false));
  };

  const print = (text: string) => setOutput((current) => `${current}${current ? "\n" : ""}${text}`.slice(-CONSOLE_LIMIT));

  const run = (event: FormEvent) => {
    event.preventDefault();
    let args: string[];
    try { args = gitArgv(command); }
    catch (reason) { print(`$ git ${command}\n${reasonText(reason)}`); return; }
    setCommand("");
    void window.emma.gitRun({ folderId, args })
      .then((result) => print(`$ git ${args.join(" ")}\n${result.output.trim() || (result.ok ? "(no output)" : "(failed with no output)")}`))
      .catch((reason: unknown) => print(`$ git ${args.join(" ")}\n${reasonText(reason)}`))
      .finally(() => { reload(); loadHistory(0); });
  };

  const dirty = message.trim().length > 0;
  return <div className="git-page" onMouseUp={pickHighlight}>
    <header className="git-bar" ref={menu}>
      <button type="button" className="git-branch" aria-haspopup="listbox" aria-expanded={branchOpen}
        aria-label={`Branch, currently ${live.branch}`} onClick={() => { setBranchOpen(!branchOpen); setNaming(false); }}>⑂ {live.branch}</button>
      {branchOpen && <div className="git-branch-menu" role="listbox" aria-label="Branch" tabIndex={-1}
        onKeyDown={(event) => { if (event.key === "Escape") { setBranchOpen(false); setNaming(false); } }}>
        {live.branches.map((branch) => <button type="button" role="option" aria-selected={branch === live.branch} key={branch}
          className={`slash-row ${branch === live.branch ? "active" : ""}`} onClick={() => branchTo(branch, false)}>
          <strong>{branch}</strong>{branch === live.branch && <small>current</small>}
        </button>)}
        {naming
          ? <form className="slash-row git-new-branch" onSubmit={(event) => { event.preventDefault(); branchTo(draft, true, base); }}>
            <input autoFocus value={draft} maxLength={128} spellCheck={false} placeholder="new-branch-name" aria-label="New branch name" onChange={(event) => setDraft(event.target.value)} />
            <select value={base} aria-label="Branch to start from" onChange={(event) => setBase(event.target.value)}>
              {live.branches.map((branch) => <option value={branch} key={branch}>from {branch}</option>)}
            </select>
            <button disabled={!draft.trim()}>Create</button>
          </form>
          : <button type="button" className="slash-row" onClick={() => { setBase(live.branch); setNaming(true); }}><strong>New branch…</strong><small>from any branch</small></button>}
      </div>}
      {live.upstream && (live.ahead > 0 || live.behind > 0) && <span className="git-ahead" title={`${live.ahead} ahead of and ${live.behind} behind ${live.upstream}`}>
        {live.ahead > 0 && `↑${live.ahead}`}{live.ahead > 0 && live.behind > 0 && " "}{live.behind > 0 && `↓${live.behind}`}
      </span>}
      {live.worktree && <span className="git-worktree" title="A checkout beside the folder itself">worktree</span>}
      <span className="git-head" title={live.head}>{live.head.slice(0, 7)}</span>
      <span className="git-spacer" />
      <OpenIn folderId={folderId} />
    </header>
    <div className="git-body">
      <aside className="git-side">
        <div className="git-side-head">
          <label><input type="checkbox" checked={!!shownPaths.length && shownPaths.every((path) => !excluded.has(path))}
            aria-label={filter ? "Include every matching file" : "Include every changed file"}
            onChange={(event) => setExcluded((current) => {
              const next = new Set(current);
              for (const path of shownPaths) { if (event.target.checked) next.delete(path); else next.add(path); }
              return next;
            })} /></label>
          <span>{filter ? `${shownPaths.length} of ${paths.length}` : `${paths.length} changed`}</span>
          <button type="button" disabled={busy || !selected.length} onClick={discard}>Discard</button>
        </div>
        <div className="git-filter">
          <input value={filter} spellCheck={false} placeholder="Filter files — name, .ts, fuzzy" aria-label="Filter changed files"
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape" && filter) { event.stopPropagation(); setFilter(""); } }} />
          {filter && <button type="button" aria-label="Clear the file filter" onClick={() => setFilter("")}>×</button>}
        </div>
        <ul className="git-files">
          {!shownFiles.length && !!paths.length && <li className="git-row git-no-match">No file matches that filter</li>}
          {shownFiles.map((file) => <li className="git-row" data-state={fileState(file)} key={file.path}>
            <input type="checkbox" checked={!excluded.has(file.path)} aria-label={`Include ${file.path}`} onChange={() => toggle(file.path)} />
            <FileMark path={file.path} />
            <span className="git-path" title={file.from ? `${file.from} → ${file.path}` : file.path}>{file.path}</span>
            <ChangeCount stat={stats.get(file.path) ?? NO_CHANGE} />
            <span className="git-state" title={fileState(file)}>{STATE_LETTER[fileState(file)]}</span>
            <OpenIn folderId={folderId} path={file.path} />
            <button type="button" className="git-attach" title="Send this file to the composer" aria-label={`Send ${file.path} to the composer`}
              onClick={() => pickIntoComposer({ kind: "file", folderId, path: file.path })}>＋</button>
            <ReadMarkdown folderId={folderId} path={file.path} />
          </li>)}
        </ul>
        <section className="git-graph-pane">
          <div className="git-side-head"><span>history</span></div>
          <div className="git-history">
            <ol className="git-graph">
              {!rows.length && <li className="git-commit-row">No commits yet</li>}
              {rows.map((row, index) => <li className="git-commit-row" key={row.commit.hash}>
                <svg className="git-lanes" width={width} height={ROW_HEIGHT} viewBox={`0 0 ${width} ${ROW_HEIGHT}`} aria-hidden>
                  {(index ? rows[index - 1].links : []).map((link) => {
                    const out = row.links.find((next) => next.to === link.to);
                    const continues = out && out.from !== link.to;
                    return <path key={`in-${link.to}`} className={`git-lane-${link.to % LANE_COLOURS}`} fill="none"
                      d={`M ${laneX(link.to)} 0 L ${laneX(link.to)} ${continues ? ROW_HEIGHT : ROW_HEIGHT / 2}`} />;
                  })}
                  {row.links.map((link, position) => <path key={position} className={`git-lane-${link.to % LANE_COLOURS}`} fill="none"
                    d={`M ${laneX(link.from)} ${ROW_HEIGHT / 2} C ${laneX(link.from)} ${ROW_HEIGHT} ${laneX(link.to)} ${ROW_HEIGHT / 2} ${laneX(link.to)} ${ROW_HEIGHT}`} />)}
                  <circle className={`git-lane-${row.lane % LANE_COLOURS}`} cx={laneX(row.lane)} cy={ROW_HEIGHT / 2} r={LANE_RADIUS} />
                </svg>
                <div className="git-commit-body">
                  <span className="git-subject">{row.commit.subject}</span>
                  {row.commit.refs.length > 0 && <span className="git-refs">{row.commit.refs.map((ref) => <b className="git-ref" key={ref}>{ref}</b>)}</span>}
                  <span className="git-meta" title={`${row.commit.author} · ${ago(row.commit.when)} · ${new Date(row.commit.when).toLocaleString()}`}>{row.commit.hash.slice(0, 7)}</span>
                </div>
              </li>)}
            </ol>
            {more && <button type="button" className="git-more" onClick={() => loadHistory(commits.length)}>Load more</button>}
          </div>
        </section>
        <form className="git-commit" onSubmit={commit}>
          <textarea className="git-message" value={message} disabled={busy} rows={3} placeholder="What changed, and why"
            aria-label="Commit message" onChange={(event) => setMessage(event.target.value)} />
          <div className="git-commit-actions">
            <label className="git-amend"><input type="checkbox" checked={amend} disabled={busy} onChange={(event) => setAmend(event.target.checked)} />amend</label>
            <button className="git-do" disabled={busy || !selected.length || (!dirty && !amend)}>Commit</button>
            <button type="button" className="git-write" disabled={busy || dirty} onClick={write}
              aria-label={busy ? "Writing the commit message" : "Have the model write this message"}
              title={dirty ? "Clear the message first to have one written" : "Have the model write this message"}><BrandIcon brand={brand} className="git-write-mark" /></button>
          </div>
          {error && <p className="git-commit-error" role="alert">{error}</p>}
        </form>
      </aside>
      <section className="git-main">
        <nav className="git-tabs">
          <button type="button" className={view === "changes" ? "active" : ""} onClick={() => setView("changes")}>Changes</button>
          <button type="button" className={view === "console" ? "active" : ""} onClick={() => setView("console")}>Console</button>
        </nav>
        {view === "changes" && <div className="git-diff">
          {!diffFiles.length && <p>{filter ? "No file matches that filter." : "Working tree clean."}</p>}
          {diffFiles.map((file) => <details className="git-file" data-path={file.path} key={file.path} open>
            <summary>
              <FileMark path={file.path} />
              <span className="git-path">{file.path}</span>
              <ChangeCount stat={file} />
              <OpenIn folderId={folderId} path={file.path} />
              <ReadMarkdown folderId={folderId} path={file.path} />
            </summary>
            <pre className="diff">{file.lines.map((line, index) => <span key={index}
              className={line.kind === "+" ? "added" : line.kind === "-" ? "removed" : line.kind === "@" ? "hunk" : undefined}>{line.kind === "@" ? "" : line.kind}{line.text}{"\n"}</span>)}</pre>
          </details>)}
          {live.truncated && <p>Diff cut at its size limit — later files are not listed.</p>}
        </div>}
        {view === "console" && <div className="git-console">
          <form className="git-console-form" onSubmit={run}>
            <input value={command} spellCheck={false} placeholder="log --stat -3" aria-label="git command" onChange={(event) => setCommand(event.target.value)} />
            <button disabled={!command.trim()}>Run</button>
          </form>
          <pre className="git-console-out">{output}</pre>
        </div>}
      </section>
    </div>
  </div>;
}
