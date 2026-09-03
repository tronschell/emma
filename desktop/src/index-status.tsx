import { useEffect, useRef, useState } from "react";
import { progressLabel, timeLeft, type SemanticGrepStatus } from "../shared/semantic-grep";
import { EMBEDDING_MODELS, hostedEmbeddingModel } from "../shared/settings";
import { TextIcon } from "./icons";

const EMPTY: SemanticGrepStatus = { available: false, enabled: false, model: "", folders: [] };

export const indexStateLabel = { indexing: "Indexing", ready: "Ready", failed: "Failed" };

export function useSemanticGrepStatus(): SemanticGrepStatus {
  const [status, setStatus] = useState(EMPTY);
  useEffect(() => {
    let live = true;
    const load = () => void window.emma.semanticGrepStatus().then((next) => { if (live) setStatus(next); }).catch(() => undefined);
    load();
    const off = window.emma.onSemanticGrep(load);
    return () => { live = false; off(); };
  }, []);
  return status;
}

export function embeddingModelLabel(id: string): string {
  const model = EMBEDDING_MODELS.find((item) => item.id === id);
  if (!model) return id;
  const hosted = hostedEmbeddingModel(id);
  return hosted ? `${model.label} · ${hosted.detail.split(" · ")[0]}` : model.label;
}

export function embeddingModelMode(id: string): string {
  return hostedEmbeddingModel(id) ? "hosted" : "local";
}

export function IndexStatus({ paths }: { paths: string[] }) {
  const status = useSemanticGrepStatus();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    addEventListener("pointerdown", outside);
    return () => removeEventListener("pointerdown", outside);
  }, [open]);
  const folders = status.folders.filter((folder) => paths.includes(folder.path));
  if (!status.enabled || !status.available || !folders.length) return null;
  const busy = folders.filter((folder) => folder.state === "indexing");
  const failed = folders.some((folder) => folder.state === "failed");
  const done = busy.reduce((sum, folder) => sum + folder.done, 0);
  const total = busy.reduce((sum, folder) => sum + folder.total, 0);
  const state = failed ? "failed" : busy.length ? "indexing" : "ready";
  const left = timeLeft(Math.max(0, ...busy.map((folder) => folder.left)));
  const title = state === "indexing" ? `Indexing ${total ? `${Math.round((done / total) * 100)}%` : "…"}${left ? ` · ${left}` : ""}` : state === "failed" ? "Index failed" : "Index ready";
  const shared = folders.every((folder) => folder.model === folders[0].model) ? folders[0].model : "";
  return <div className="pane-switch" ref={box} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
    <button type="button" className="pane-toggle index-toggle" data-state={state} style={{ "--p": total ? `${Math.min(100, (done / total) * 100)}%` : "0%" } as React.CSSProperties} aria-label="Search index" aria-haspopup="dialog" aria-expanded={open} title={title} onClick={() => setOpen((current) => !current)}><TextIcon /><i><b /></i></button>
    {open && <section className="source-popover pane-menu index-menu" role="dialog" aria-label="Search index">
      <header><strong data-state={state}>{indexStateLabel[state]}</strong>{shared && <span>{embeddingModelLabel(shared)} · {embeddingModelMode(shared)}</span>}</header>
      <table className="index-ledger">
        <thead><tr><th>Folder</th><th>State</th>{!shared && <th>Model</th>}<th>Progress</th></tr></thead>
        <tbody>{folders.map((folder) => <tr key={folder.path}>
          <td>{folder.path.split(/[\\/]/).pop()}</td>
          <td data-state={folder.state}>{indexStateLabel[folder.state]}</td>
          {!shared && <td>{embeddingModelLabel(folder.model)} · {embeddingModelMode(folder.model)}</td>}
          <td>{progressLabel(folder)}</td>
        </tr>)}</tbody>
      </table>
      {state !== "ready" && <footer>{state === "indexing" ? "Searches use keywords until this finishes" : "Searches use keywords; see the folder below"}</footer>}
    </section>}
  </div>;
}
