import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ARTIFACT_EXTENSIONS, ARTIFACT_KINDS, ARTIFACT_LABELS, artifactFrameUrl, SURFACE_LABELS, type Artifact, type ArtifactKind, type ArtifactMeta } from "../shared/artifacts";
import { reasonText } from "./errors";
import { tokenize } from "./highlight";
import { Mark, TrashIcon } from "./icons";
import { Markdown } from "./markdown";

const MermaidArtifact = lazy(() => import("./mermaid-artifact"));

const GONE = "That artifact is no longer in the folder.";
const REVEAL_LABEL = typeof window !== "undefined" && window.emma?.platform === "win32" ? "Reveal in File Explorer" : "Reveal in Finder";
const GRID_PREVIEW_MARGIN = "400px";

const svgPage = (svg: string) => `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}body{display:grid;place-items:center}svg{max-width:100%;max-height:100%}</style>${svg}`;

function useArtifact(id: string) {
  const [state, setState] = useState<{ id: string; artifact: Artifact | false } | null>(null);
  useEffect(() => {
    if (!id) return;
    let active = true;
    void window.emma.readArtifact(id)
      .then((artifact) => { if (active) setState({ id, artifact }); })
      .catch(() => { if (active) setState({ id, artifact: false }); });
    return () => { active = false; };
  }, [id]);
  return state?.id === id ? state.artifact : null;
}

function useNearViewport() {
  const [nearViewport, setNearViewport] = useState(() => typeof IntersectionObserver === "undefined");
  const target = useRef<HTMLElement>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const node = target.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setNearViewport(entry?.isIntersecting ?? false), { rootMargin: GRID_PREVIEW_MARGIN });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [target, nearViewport] as const;
}

export function ArtifactFrame({ meta, className = "artifact-frame", loading }: { meta: ArtifactMeta; className?: string; loading?: "eager" | "lazy" }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const answer = (event: MessageEvent) => {
      const asked = event.data as { emma?: unknown; n?: unknown; sql?: unknown; params?: unknown };
      const page = frame.current?.contentWindow;
      if (!page || event.source !== page || asked?.emma !== "sql" || typeof asked.n !== "number") return;
      const reply = (value: object) => page.postMessage({ n: asked.n, ...value }, "*");
      void window.emma.artifactSql(meta.id, String(asked.sql ?? ""), Array.isArray(asked.params) ? asked.params : [])
        .then((rows) => reply({ rows }))
        .catch((error: unknown) => reply({ error: reasonText(error) }));
    };
    window.addEventListener("message", answer);
    return () => window.removeEventListener("message", answer);
  }, [meta.id]);
  return <iframe ref={frame} className={className} title={meta.title} loading={loading} sandbox="allow-scripts" src={artifactFrameUrl(meta.id, meta.version)} />;
}

export function ArtifactRender({ artifact, source, loading }: { artifact: Artifact; source?: boolean; loading?: "eager" | "lazy" }) {
  if (source || artifact.kind === "code" || artifact.kind === "react") {
    const language = artifact.language || ARTIFACT_EXTENSIONS[artifact.kind];
    return <pre className="artifact-code"><code>{tokenize(artifact.content, language).map((token, at) =>
      <span key={at} className={token.kind && `tok-${token.kind}`}>{token.text}</span>)}</code></pre>;
  }
  if (artifact.kind === "markdown") return <div className="message-body artifact-prose"><Markdown text={artifact.content} /></div>;
  if (artifact.kind === "mermaid") return <Suspense fallback={<pre className="artifact-code">{artifact.content}</pre>}><MermaidArtifact text={artifact.content} /></Suspense>;
  if (artifact.kind === "svg") return <iframe className="artifact-frame" title={artifact.title} loading={loading} sandbox="" srcDoc={svgPage(artifact.content)} />;
  return <ArtifactFrame meta={artifact} loading={loading} />;
}

export function ArtifactCard({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const artifact = useArtifact(id);
  if (artifact === false) return <p className="artifact-missing">{GONE}</p>;
  if (!artifact) return null;
  return <button type="button" className="artifact-card artifact-card-inline" onClick={() => onOpen(id)}>
    <header><span>{ARTIFACT_LABELS[artifact.kind]}</span><strong>{artifact.title}</strong><small>v{artifact.version}</small></header>
    <div className="artifact-clip" inert><ArtifactRender artifact={artifact} /></div>
  </button>;
}

export function ArtifactsView({ busy, select, openArtifact }: { busy: boolean; select?: string; openArtifact: (artifact: Artifact) => void }) {
  const [list, setList] = useState<ArtifactMeta[]>([]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ArtifactKind | "">("");
  const [picked, setPicked] = useState<{ id: string; from?: string }>({ id: "" });
  const openId = picked.from === select ? picked.id : select ?? "";
  const openArtifactId = (id: string) => setPicked({ id, from: select });
  const [doomed, setDoomed] = useState<ArtifactMeta | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const load = () => void window.emma.listArtifacts()
      .then((found) => { if (active) setList(found); })
      .catch(() => { if (active) setError("Emma could not read the artifacts folder."); });
    load();
    const stop = window.emma.onArtifactsChanged(load);
    return () => { active = false; stop(); };
  }, []);

  const remove = async (id: string) => {
    try {
      await window.emma.deleteArtifact(id);
      setList((current) => current.filter((item) => item.id !== id));
      setDoomed(null);
      if (openId === id) openArtifactId("");
    } catch { setError("That artifact could not be deleted."); }
  };

  const needle = query.trim().toLowerCase();
  const kinds = ARTIFACT_KINDS.filter((name) => list.some((item) => item.kind === name));
  const shown = list.filter((item) => (!kind || item.kind === kind) && item.title.toLowerCase().includes(needle));

  return <section className="artifacts-view">
    <header>
      <span>Kept from threads</span>
      <h2>Artifacts</h2>
    </header>
    {error && <p className="dialog-error">{error}</p>}
    {list.length > 0 && <div className="artifacts-toolbar">
      <input value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by title" aria-label="Filter artifacts by title" />
      <button type="button" className={`shelf-chip ${kind ? "" : "on"}`} disabled={busy} onClick={() => setKind("")}>All</button>
      {kinds.map((name) => <button key={name} type="button" className={`shelf-chip ${kind === name ? "on" : ""}`} disabled={busy} onClick={() => setKind(name)}>{ARTIFACT_LABELS[name]}</button>)}
    </div>}
    {!list.length && <div className="content-empty">
      <Mark />
      <h2>Nothing kept yet</h2>
      <p>An artifact is something a conversation produced that is worth keeping — a document, a snippet, a page, a drawing, a diagram. Type <b>/artifact</b> in a thread to make one.</p>
    </div>}
    {list.length > 0 && !shown.length && <p className="artifact-missing">Nothing matches that.</p>}
    <div className="artifact-grid">{shown.map((meta) => <GridCard key={`${meta.id}:${meta.version}`} meta={meta} busy={busy} open={() => openArtifactId(meta.id)} edit={openArtifact} onEditError={() => setError("That artifact could not be opened for editing.")} remove={() => setDoomed(meta)} />)}</div>
    {openId && <ArtifactDialog id={openId} busy={busy} close={() => openArtifactId("")} edit={openArtifact} remove={setDoomed} />}
    {doomed && <ConfirmDialog meta={doomed} busy={busy} close={() => setDoomed(null)} confirm={() => void remove(doomed.id)} />}
  </section>;
}

function GridCard({ meta, busy, open, edit, onEditError, remove }: { meta: ArtifactMeta; busy: boolean; open: () => void; edit: (artifact: Artifact) => void; onEditError: () => void; remove: () => void }) {
  const [target, nearViewport] = useNearViewport();
  const editCurrent = () => {
    void window.emma.readArtifact(meta.id).then(edit).catch(onEditError);
  };
  return <article ref={target} className="artifact-card">
    <button type="button" className="artifact-card-open" onClick={open} aria-label={`Open ${meta.title}`}>
      <header><span>{ARTIFACT_LABELS[meta.kind]}{meta.surface ? ` · in the ${SURFACE_LABELS[meta.surface]}` : ""}</span><strong>{meta.title}</strong><small>v{meta.version}</small></header>
      {nearViewport ? <GridPreview meta={meta} /> : <div className="artifact-clip artifact-clip-lazy" inert />}
    </button>
    <div className="artifact-actions artifact-icons">
      <button type="button" title="Edit in a thread" aria-label="Edit in a thread" disabled={busy} onClick={editCurrent}><PencilIcon /></button>
      <button type="button" title={REVEAL_LABEL} aria-label={REVEAL_LABEL} disabled={busy} onClick={() => void window.emma.revealArtifact(meta.id)}><FolderIcon /></button>
      <button type="button" className="artifact-danger" title="Delete" aria-label="Delete" disabled={busy} onClick={remove}><TrashIcon /></button>
    </div>
  </article>;
}

function GridPreview({ meta }: { meta: ArtifactMeta }) {
  const artifact = useArtifact(meta.id);
  if (artifact === false) return <p className="artifact-missing">{GONE}</p>;
  return <div className="artifact-clip" inert>{artifact && <ArtifactRender artifact={artifact} loading="lazy" />}</div>;
}

function CodeIcon() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5.8 4.6 2.4 8l3.4 3.4M10.2 4.6 13.6 8l-3.4 3.4M9.1 2.9 6.9 13.1" /></svg>;
}

function CopyIcon() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5.6 5.6h7.1v7.1H5.6zM10.4 5.6V3.3H3.3v7.1h2.3" /></svg>;
}

function CheckIcon() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.2 8.4 6.3 11.5 12.8 5" /></svg>;
}

function PencilIcon() {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11.1 2.3a1.3 1.3 0 0 1 1.9 0l.7.7a1.3 1.3 0 0 1 0 1.9l-7.6 7.6-3 .8.8-3zM10.2 3.2l2.6 2.6" /></svg>;
}

function FolderIcon() {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1.9 12.6V3.9a.9.9 0 0 1 .9-.9h3l1.6 1.8h5.8a.9.9 0 0 1 .9.9v6.9a.9.9 0 0 1-.9.9H2.8a.9.9 0 0 1-.9-.9z" /></svg>;
}

function ArtifactPanel({ id, className, busy, close, edit, remove }: { id: string; className: string; busy: boolean; close: () => void; edit: (artifact: Artifact) => void; remove: (meta: ArtifactMeta) => void }) {
  const artifact = useArtifact(id);
  const [source, setSource] = useState(false);
  const [copied, setCopied] = useState(false);

  return <section className={className}>
    <header>
      <div>
        <span>{artifact ? `${ARTIFACT_LABELS[artifact.kind]} · v${artifact.version}` : "Artifact"}</span>
        <h2 id="artifact-title">{artifact ? artifact.title : id}</h2>
      </div>
      {artifact && <button type="button" className="artifact-icon" aria-pressed={source} aria-label={source ? "Show the preview" : "Show the code"} title={source ? "Preview" : "Code"} onClick={() => setSource((current) => !current)}><CodeIcon /></button>}
      {artifact && <button type="button" className="artifact-icon" aria-label={copied ? "Copied" : "Copy artifact"} title={copied ? "Copied" : "Copy"}
        onClick={() => void navigator.clipboard.writeText(artifact.content).then(() => setCopied(true)).catch(() => undefined)}>{copied ? <CheckIcon /> : <CopyIcon />}</button>}
      <button type="button" className="artifact-icon" onClick={close} aria-label="Close artifact" title="Close">×</button>
    </header>
    {artifact && <button type="button" className="artifact-location" title={REVEAL_LABEL} onClick={() => void window.emma.revealArtifact(artifact.id)}>{artifact.path}</button>}
    {artifact === false && <p className="dialog-error">{GONE}</p>}
    {artifact && <div className="artifact-body"><ArtifactRender artifact={artifact} source={source} /></div>}
    {artifact && <div className="artifact-actions">
      <button type="button" disabled={busy} onClick={() => edit(artifact)}>Edit in a thread</button>
      <button type="button" className="artifact-danger" disabled={busy} onClick={() => remove(artifact)}>Delete</button>
    </div>}
  </section>;
}

export function ArtifactPane({ id, busy, close, edit }: { id: string; busy: boolean; close: () => void; edit: (artifact: Artifact) => void }) {
  const [doomed, setDoomed] = useState<ArtifactMeta | null>(null);
  const [error, setError] = useState("");
  const remove = async () => {
    if (!doomed) return;
    try {
      await window.emma.deleteArtifact(doomed.id);
      setDoomed(null);
      close();
    } catch { setError("That artifact could not be deleted."); }
  };
  return <>
    <ArtifactPanel id={id} className="artifact-pane" busy={busy} close={close} edit={edit} remove={setDoomed} />
    {error && <p className="region-error">{error}</p>}
    {doomed && <ConfirmDialog meta={doomed} busy={busy} close={() => setDoomed(null)} confirm={() => void remove()} />}
  </>;
}

function ArtifactDialog({ id, busy, close, edit, remove }: { id: string; busy: boolean; close: () => void; edit: (artifact: Artifact) => void; remove: (meta: ArtifactMeta) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);

  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="artifact-title" onClose={close}
    onCancel={(event) => { event.preventDefault(); close(); }}
    onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <ArtifactPanel id={id} className="agent-dialog artifact-dialog" busy={busy} close={close} edit={edit} remove={remove} />
  </dialog>;
}

function ConfirmDialog({ meta, busy, close, confirm }: { meta: ArtifactMeta; busy: boolean; close: () => void; confirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);

  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="artifact-delete-title" onClose={close}
    onCancel={(event) => { event.preventDefault(); close(); }}
    onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="agent-dialog artifact-confirm">
      <header>
        <div><span>{ARTIFACT_LABELS[meta.kind]}</span><h2 id="artifact-delete-title">Delete this artifact?</h2></div>
        <button type="button" onClick={close} aria-label="Keep artifact">×</button>
      </header>
      <p><b>{meta.title}</b> and its folder are removed from disk. Emma cannot bring it back.</p>
      <div className="artifact-actions">
        <button type="button" className="artifact-danger" disabled={busy} onClick={confirm}>Delete for good</button>
        <button type="button" disabled={busy} onClick={close}>Keep it</button>
      </div>
    </section>
  </dialog>;
}
