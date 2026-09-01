import { useCallback, useEffect, useMemo, useState } from "react";
import { branchPrefixName, matchesFilter, type WorktreeEntry } from "../shared/git";
import type { FolderGrant } from "../shared/folders";
import { reasonText } from "./errors";
import { plural } from "./plural";
import { SearchIcon } from "./icons";

const PREFIX_KEY = "emma.worktreePrefix.v1";

const readPrefix = (folderId: string) => localStorage.getItem(`${PREFIX_KEY}.${folderId}`) ?? "";
const writePrefix = (folderId: string, prefix: string) => {
  try { localStorage.setItem(`${PREFIX_KEY}.${folderId}`, prefix); } catch { /* full */ }
};

const BADGE_ORDER = { primary: 0, prunable: 1, locked: 2, detached: 3, dirty: 4, clean: 5 } as const;

function badge(entry: WorktreeEntry): { label: string; kind: keyof typeof BADGE_ORDER } {
  if (entry.prunable) return { label: "Prunable", kind: "prunable" };
  if (entry.locked) return { label: "Locked", kind: "locked" };
  if (entry.bare) return { label: "Bare", kind: "detached" };
  if (entry.detached) return { label: "Detached HEAD", kind: "detached" };
  if (entry.dirty) return { label: "Dirty", kind: "dirty" };
  return { label: "Clean", kind: "clean" };
}

export default function WorktreesView() {
  const [folders, setFolders] = useState<FolderGrant[] | null>(null);
  const [folderId, setFolderId] = useState("");
  const [entries, setEntries] = useState<WorktreeEntry[] | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reloadAt, setReloadAt] = useState(0);

  useEffect(() => {
    let live = true;
    void window.emma.listFolders()
      .then((grants) => {
        if (!live) return;
        setFolders(grants);
        setFolderId((current) => (grants.some((grant) => grant.id === current) ? current : grants[0]?.id ?? ""));
      })
      .catch((reason: unknown) => { if (live) { setError(reasonText(reason)); setFolders([]); } });
    return () => { live = false; };
  }, []);

  const prefix = readPrefix(folderId);

  const reload = useCallback(() => setReloadAt((at) => at + 1), []);

  useEffect(() => {
    if (!folderId) return;
    let live = true;
    void window.emma.worktreeList(folderId)
      .then((rows) => { if (live) { setEntries(rows); setUpdated(new Date()); setSelected(new Set()); setError(""); } })
      .catch((reason: unknown) => { if (live) { setError(reasonText(reason)); setEntries([]); } })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [folderId, reloadAt]);

  const folder = folders?.find((grant) => grant.id === folderId);
  const rows = useMemo(() => (entries ?? [])
    .map((entry) => ({ entry, badge: badge(entry) }))
    .filter((row) => matchesFilter(search, `${row.entry.branch} ${row.entry.path}`))
    .sort((left, right) =>
      (left.entry.primary ? 0 : 1) - (right.entry.primary ? 0 : 1) ||
      BADGE_ORDER[left.badge.kind] - BADGE_ORDER[right.badge.kind] ||
      left.entry.branch.localeCompare(right.entry.branch)), [entries, search]);
  const selectedPaths = rows.filter((row) => selected.has(row.entry.path)).map((row) => row.entry.path);
  const removable = selectedPaths.filter((path) => {
    const entry = entries?.find((row) => row.path === path);
    return entry && !entry.primary && !entry.bare && !entry.locked;
  });

  const pick = (path: string, on: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (on) next.add(path); else next.delete(path);
    return next;
  });

  const act = (run: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    void run().catch((reason: unknown) => setError(reasonText(reason))).finally(reload);
  };

  const create = () => {
    if (!folderId || !draft.trim()) return;
    setNaming(false);
    act(() => window.emma.worktreeAdd({ folderId, prefix, name: draft.trim() }));
    setDraft("");
  };

  const remove = () => {
    if (!removable.length) return;
    if (!confirm(`Delete ${removable.length} ${plural(removable.length, "worktree")}? Uncommitted files in them are gone.`)) return;
    act(() => window.emma.worktreeRemove({ folderId, paths: removable }));
  };

  return <div className="worktrees-view">
    <section className="worktree-prefix">
      <div>
        <span>Branch prefix</span>
        <p>New branches start like <b>{branchPreview(prefix)}</b></p>
      </div>
      <input value={prefix} spellCheck={false} maxLength={48} placeholder="emma/"
        aria-label="Branch prefix for new worktrees"
        onChange={(event) => { writePrefix(folderId, event.target.value); reload(); }} />
    </section>

    <section className="worktree-bar">
      {!folders
        ? <p className="empty-line">Reading folders…</p>
        : !folders.length
          ? <p className="empty-line">Connect a folder from the ＋ menu to see its worktrees.</p>
          : <>
            <select value={folderId} aria-label="Repository folder" onChange={(event) => setFolderId(event.target.value)}>
              {folders.map((grant) => <option value={grant.id} key={grant.id}>{grant.name}</option>)}
            </select>
            <button type="button" disabled={busy || !folderId} onClick={() => setNaming(true)}>New worktree…</button>
            <span className="worktree-updated">{updated ? `Updated ${updated.toLocaleTimeString()}` : ""}</span>
            <button type="button" disabled={busy || !folderId} onClick={reload}>Refresh</button>
          </>}
    </section>

    {naming && <form className="worktree-naming" onSubmit={(event) => { event.preventDefault(); create(); }}>
      <input autoFocus value={draft} spellCheck={false} maxLength={48} placeholder="happy-otter"
        aria-label="Branch name for the new worktree" onChange={(event) => setDraft(event.target.value)} />
      <small>{branchPreview(prefix, draft.trim())}</small>
      <button type="submit" disabled={!draft.trim() || busy}>Create</button>
      <button type="button" onClick={() => { setNaming(false); setDraft(""); }}>Cancel</button>
    </form>}

    {error && <p className="capability-error" role="alert">{error}</p>}

    {folder && <section className="worktree-list">
      <header className="worktree-controls">
        <label className="worktree-search">
          <SearchIcon />
          <input value={search} spellCheck={false} placeholder="Search branch or path"
            aria-label="Search worktrees" onChange={(event) => setSearch(event.target.value)} />
          {search && <button type="button" aria-label="Clear the search" onClick={() => setSearch("")}>×</button>}
        </label>
        <small className="worktree-count">{rows.length} {plural(rows.length, "worktree")}</small>
        <button type="button" disabled={busy || !rows.length}
          onClick={() => setSelected((current) => (current.size === rows.length ? new Set() : new Set(rows.map((row) => row.entry.path))))}>
          {selected.size && selected.size === rows.length ? "Clear all" : "Select all"}
        </button>
      </header>
      {rows.map((row) => <label className="worktree-row" data-state={row.badge.kind} key={row.entry.path} title={row.entry.path}>
        <input type="checkbox" aria-label={`Select ${row.entry.branch || row.entry.path}`}
          disabled={row.entry.primary || row.entry.bare || row.entry.locked}
          checked={selected.has(row.entry.path)} onChange={(event) => pick(row.entry.path, event.target.checked)} />
        <span className="worktree-main">
          <span className="worktree-line">
            <span className="worktree-badge">{row.badge.label}</span>
            {row.entry.primary && <span className="worktree-badge">main checkout</span>}
            <strong className="worktree-branch">{row.entry.primary ? row.entry.branch || "(bare)" : row.entry.branch || row.entry.head.slice(0, 7) || "detached"}</strong>
          </span>
          <small className="worktree-path">{row.entry.path}</small>
        </span>
      </label>)}
      {!rows.length && !!entries?.length && <p className="empty-line">Nothing matches that search.</p>}
      {!entries?.length && <p className="empty-line">No worktrees here yet — only the main checkout.</p>}
    </section>}

    {!!selectedPaths.length && <footer className="worktree-footer">
      <span>{selected.size} selected</span>
      <button type="button" onClick={() => setSelected(new Set())}>Clear</button>
      <button type="button" className="worktree-delete" disabled={busy || !removable.length}
        title={removable.length < selected.size ? "Locked and main checkouts cannot be deleted" : undefined}
        onClick={remove}>Delete {removable.length} {plural(removable.length, "worktree")}</button>
    </footer>}
  </div>;
}

function branchPreview(prefix: string, name = "happy-otter"): string {
  try { return branchPrefixName(prefix, name); }
  catch { return name; }
}
