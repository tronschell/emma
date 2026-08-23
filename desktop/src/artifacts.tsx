/* An artifact, shown as the thing it is: a document reads, a page runs, a drawing
   draws, a diagram draws itself. The Artifacts page renders every one of them for
   real rather than as a thumbnail — a picture of the work is the only way to find
   the right one at a glance — and clips each to a fixed height so a long document
   cannot blow the grid out.

   The kinds that can carry script (html, app, svg, and the react source we do not
   run) never touch Emma's own document. Everything else here is elements built from
   parsed data, the same rule markdown.tsx keeps. */

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ARTIFACT_EXTENSIONS, ARTIFACT_KINDS, ARTIFACT_LABELS, artifactFrameUrl, SURFACE_LABELS, type Artifact, type ArtifactKind, type ArtifactMeta } from "../shared/artifacts";
import { reasonText } from "./errors";
import { tokenize } from "./highlight";
import { Markdown } from "./markdown";

const MermaidArtifact = lazy(() => import("./mermaid-artifact"));

const GONE = "That artifact is no longer in the folder.";

/** An SVG is a document, not a fragment: it is framed, so the shell is the frame's page. */
const svgPage = (svg: string) => `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}body{display:grid;place-items:center}svg{max-width:100%;max-height:100%}</style>${svg}`;

/** One artifact, read by id. `null` while it loads, `false` once it is known to be gone. */
function useArtifact(id: string) {
  // The id it was read for is kept beside it, so a card never shows the previous
  // artifact for a frame — the same reason run-block keeps its task's id.
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

/**
 * A page's frame — an `html` artifact, an `app`, or either of them mounted into
 * Emma herself — and the only thing what runs inside it can reach out and do.
 *
 * It is loaded from `ARTIFACT_SCHEME` rather than srcDoc, which would inherit the
 * workspace's `script-src 'self'` and silently make it inert, and granted script
 * and nothing else. Never allow-same-origin alongside it, which would let the page
 * reach out and rewrite the sandbox attribute holding it. No allow-forms and no
 * allow-popups either: it may draw, it may not post or open.
 *
 * The id it answers for is this component's — the artifact it was handed to draw —
 * and never the frame's, so a page cannot ask for another app's rows by naming one.
 * The reply goes back to that one window and nowhere else; `"*"` is the target
 * because the sandbox holds it at an opaque origin, which no origin string matches.
 * An `html` page has no bridge to ask with, so the listener simply never fires.
 */
export function ArtifactFrame({ meta, className = "artifact-frame" }: { meta: ArtifactMeta; className?: string }) {
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
  return <iframe ref={frame} className={className} title={meta.title} sandbox="allow-scripts" src={artifactFrameUrl(meta.id, meta.version)} />;
}

/** The visual. `source` flips any kind back to the text it was written as. */
export function ArtifactRender({ artifact, source }: { artifact: Artifact; source?: boolean }) {
  // React is source by definition — Emma renders no model-written component — and
  // `code` is source by name, so only the other four have a picture to show.
  if (source || artifact.kind === "code" || artifact.kind === "react") {
    const language = artifact.language || ARTIFACT_EXTENSIONS[artifact.kind];
    return <pre className="artifact-code"><code>{tokenize(artifact.content, language).map((token, at) =>
      <span key={at} className={token.kind && `tok-${token.kind}`}>{token.text}</span>)}</code></pre>;
  }
  if (artifact.kind === "markdown") return <div className="message-body artifact-prose"><Markdown text={artifact.content} /></div>;
  if (artifact.kind === "mermaid") return <Suspense fallback={<pre className="artifact-code">{artifact.content}</pre>}><MermaidArtifact text={artifact.content} /></Suspense>;
  // A drawing is a picture, so its frame is the file preview's: no script at all,
  // and srcDoc is enough because nothing in it has to run.
  if (artifact.kind === "svg") return <iframe className="artifact-frame" title={artifact.title} sandbox="" srcDoc={svgPage(artifact.content)} />;
  // Both pages take the same frame; an app is the one that gets answered.
  return <ArtifactFrame meta={artifact} />;
}

/** The card a thread shows inline, where the reply named an artifact. */
export function ArtifactCard({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const artifact = useArtifact(id);
  if (artifact === false) return <p className="artifact-missing">{GONE}</p>;
  if (!artifact) return null;
  return <button type="button" className="artifact-card artifact-card-inline" onClick={() => onOpen(id)}>
    <header><span>{ARTIFACT_LABELS[artifact.kind]}</span><strong>{artifact.title}</strong><small>v{artifact.version}</small></header>
    {/* inert, so the frame inside never takes the click or the tab stop that
        belongs to the card. */}
    <div className="artifact-clip" inert><ArtifactRender artifact={artifact} /></div>
  </button>;
}

/** The page behind the nav tab. `select` opens one straight into its dialog. */
export function ArtifactsView({ busy, select, openArtifact }: { busy: boolean; select?: string; openArtifact: (artifact: Artifact) => void }) {
  const [list, setList] = useState<ArtifactMeta[]>([]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ArtifactKind | "">("");
  // `select` is read as an edge, not a level: whichever the caller last named is
  // open until something else is picked or the dialog is closed against it.
  // ponytail: a repeat of the same id after a close is a no-op — hand it a value
  // that changes (the id and a counter) if a second click must re-open.
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
    // A turn, a scheduled task or this page itself writes one; the folder is the truth.
    const stop = window.emma.onArtifactsChanged(load);
    return () => { active = false; stop(); };
  }, []);

  const remove = async (id: string) => {
    try {
      await window.emma.deleteArtifact(id);
      // The change event will say the same thing; dropping it here is what makes
      // the card leave on the click rather than on the round trip.
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
      <span>Artifacts · what the conversations made</span>
      <h2>Artifacts</h2>
      <p>Each one is a file on disk that a thread wrote and you kept. Open it to read it, edit it in a new thread, or reveal it in Finder.</p>
    </header>
    {error && <p className="dialog-error">{error}</p>}
    {list.length > 0 && <div className="artifacts-toolbar">
      <input value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by title" aria-label="Filter artifacts by title" />
      <button type="button" className={`shelf-chip ${kind ? "" : "on"}`} disabled={busy} onClick={() => setKind("")}>All</button>
      {kinds.map((name) => <button key={name} type="button" className={`shelf-chip ${kind === name ? "on" : ""}`} disabled={busy} onClick={() => setKind(name)}>{ARTIFACT_LABELS[name]}</button>)}
    </div>}
    {!list.length && <div className="content-empty">
      <span className="mark" aria-hidden="true">◆</span>
      <h2>Nothing kept yet</h2>
      <p>An artifact is something a conversation produced that is worth keeping — a document, a snippet, a page, a drawing, a diagram. Type <b>/artifact</b> in a thread to make one.</p>
    </div>}
    {list.length > 0 && !shown.length && <p className="artifact-missing">Nothing matches that.</p>}
    <div className="artifact-grid">{shown.map((meta) =>
      // Keyed by version: a rewritten artifact is a different picture, so the card
      // that holds its content remounts and reads the file again.
      <GridCard key={`${meta.id}:${meta.version}`} meta={meta} busy={busy} open={() => openArtifactId(meta.id)} edit={openArtifact} remove={() => setDoomed(meta)} />)}</div>
    {openId && <ArtifactDialog id={openId} busy={busy} close={() => openArtifactId("")} edit={openArtifact} remove={setDoomed} />}
    {doomed && <ConfirmDialog meta={doomed} busy={busy} close={() => setDoomed(null)} confirm={() => void remove(doomed.id)} />}
  </section>;
}

function GridCard({ meta, busy, open, edit, remove }: { meta: ArtifactMeta; busy: boolean; open: () => void; edit: (artifact: Artifact) => void; remove: () => void }) {
  const artifact = useArtifact(meta.id);
  return <article className="artifact-card">
    {/* A mounted panel says where it is running, because the Artifacts page is
        where the user takes it back out — of the four regions, only this one lists it. */}
    <header><span>{ARTIFACT_LABELS[meta.kind]}{meta.surface ? ` · in the ${SURFACE_LABELS[meta.surface]}` : ""}</span><strong>{meta.title}</strong><small>v{meta.version}</small></header>
    {artifact === false ? <p className="artifact-missing">{GONE}</p>
      : <div className="artifact-clip" inert>{artifact && <ArtifactRender artifact={artifact} />}</div>}
    <div className="artifact-actions">
      <button type="button" disabled={busy} onClick={open}>Open</button>
      <button type="button" disabled={busy || !artifact} onClick={() => { if (artifact) edit(artifact); }}>Edit</button>
      <button type="button" disabled={busy} onClick={() => void window.emma.revealArtifact(meta.id)}>Reveal</button>
      <button type="button" className="artifact-danger" disabled={busy} onClick={remove}>Delete</button>
    </div>
  </article>;
}

function ArtifactDialog({ id, busy, close, edit, remove }: { id: string; busy: boolean; close: () => void; edit: (artifact: Artifact) => void; remove: (meta: ArtifactMeta) => void }) {
  const artifact = useArtifact(id);
  const [source, setSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);

  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="artifact-title" onClose={close}
    onCancel={(event) => { event.preventDefault(); close(); }}
    onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="agent-dialog artifact-dialog">
      <header>
        <div>
          <span>{artifact ? `${ARTIFACT_LABELS[artifact.kind]} · v${artifact.version}` : "Artifact"}</span>
          <h2 id="artifact-title">{artifact ? artifact.title : id}</h2>
        </div>
        {artifact && <button type="button" className="artifact-toggle" onClick={() => setSource((current) => !current)}>{source ? "Preview" : "Code"}</button>}
        {artifact && <button type="button" className="artifact-toggle" aria-label={copied ? "Copied" : "Copy artifact"}
          onClick={() => void navigator.clipboard.writeText(artifact.content).then(() => setCopied(true)).catch(() => undefined)}>{copied ? "Copied" : "Copy"}</button>}
        <button type="button" onClick={close} aria-label="Close artifact">×</button>
      </header>
      {/* Where it is, is half the question — the same answer the file preview gives. */}
      {artifact && <button type="button" className="artifact-location" title="Reveal in Finder" onClick={() => void window.emma.revealArtifact(artifact.id)}>{artifact.path}</button>}
      {artifact === false && <p className="dialog-error">{GONE}</p>}
      {artifact && <div className="artifact-body"><ArtifactRender artifact={artifact} source={source} /></div>}
      {artifact && <div className="artifact-actions">
        <button type="button" disabled={busy} onClick={() => edit(artifact)}>Edit in a thread</button>
        <button type="button" className="artifact-danger" disabled={busy} onClick={() => remove(artifact)}>Delete</button>
      </div>}
    </section>
  </dialog>;
}

/** Deleting takes the file off disk, so it is never one click. */
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
