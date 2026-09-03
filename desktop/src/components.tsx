import { useCallback, useEffect, useMemo, useRef, useState, type FunctionComponent } from "react";
import { createPortal } from "react-dom";
import { componentModuleUrl, componentShotUrl, COMPONENT_ZONE, COMPONENT_ZONE_LABEL, type ComponentMeta, type ComponentRequest } from "../shared/components";
import type { CredentialSummary } from "./types";
import { RegionBoundary, runtime } from "./regions";
import { ExpandIcon, MoreIcon } from "./icons";
import { reasonText } from "./errors";

const REVEAL_MS = 720;
const GLYPHS = "░▒▓█▚▞╱╲┃┇┊+*=~-_/\\<>[]{}();:.,0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const REVEAL_CHARS = 900;

export function useComponents(): ComponentMeta[] {
  const [built, setBuilt] = useState<ComponentMeta[]>([]);
  useEffect(() => {
    let alive = true;
    const read = () => void window.emma.listComponents()
      .then((found) => { if (alive) setBuilt(found); })
      .catch(() => { if (alive) setBuilt([]); });
    read();
    const stop = window.emma.onComponentsChanged(read);
    return () => { alive = false; stop(); };
  }, []);
  return built;
}

export function Built() {
  const built = useComponents();
  return <>{built.filter((one) => !one.disabled).map((one) => <Mounted key={one.id} meta={one} />)}</>;
}

function Mounted({ meta }: { meta: ComponentMeta }) {
  const [host] = useState(() => {
    const node = document.createElement("div");
    node.className = "built-host";
    return node;
  });
  useEffect(() => {
    let frame = 0;
    const settle = () => {
      const zone = document.querySelector(COMPONENT_ZONE);
      if (zone && host.parentElement !== zone) zone.append(host);
    };
    settle();
    const watch = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; settle(); });
    });
    watch.observe(document.body, { childList: true, subtree: true });
    return () => {
      watch.disconnect();
      if (frame) cancelAnimationFrame(frame);
      host.remove();
    };
  }, [host]);
  return createPortal(<Frame meta={meta} />, host);
}

function useModule(meta: ComponentMeta, onError: (why: string) => void) {
  const [made, setMade] = useState<{ version: number; Component: FunctionComponent<{ expanded: boolean }> } | null>(null);
  const api = useMemo(() => ({
    ...runtime,
    variables: meta.variables ?? [],
    fetch: (url: string, init?: Omit<ComponentRequest, "url">) => window.emma.componentFetch({ id: meta.id, request: { ...init, url } }),
  }), [meta.id, meta.variables]);
  useEffect(() => {
    let alive = true;
    void import(/* @vite-ignore */ componentModuleUrl(meta.id, meta.version))
      .then((module: { default?: unknown }) => {
        if (!alive) return;
        if (typeof module.default !== "function") throw new Error("A component module has to `export default` a function: it is handed { h, useState, emma, fetch } and returns the component.");
        const Component = (module.default as (given: typeof api) => unknown)(api);
        if (typeof Component !== "function") throw new Error(`The default export returned ${typeof Component}. It has to return a component — a function that returns h(...).`);
        setMade({ version: meta.version, Component: Component as FunctionComponent<{ expanded: boolean }> });
        onError("");
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        setMade(null);
        onError(reasonText(reason));
      });
    return () => { alive = false; };
  }, [api, meta.id, meta.version, onError]);
  return made?.version === meta.version ? made.Component : undefined;
}

function Frame({ meta }: { meta: ComponentMeta }) {
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const report = useCallback((why: string) => setError(why), []);
  const Component = useModule(meta, report);
  const box = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const shot = useRef("");

  const open = expanded && !!meta.expands;
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); }, [open]);

  useEffect(() => {
    const key = `${meta.id}:${meta.version}`;
    if (!Component || open || shot.current === key) return;
    const timer = setTimeout(() => {
      const rect = box.current?.getBoundingClientRect();
      if (!rect || rect.width < 8 || rect.height < 8) return;
      shot.current = key;
      void window.emma.shootComponent({ id: meta.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height })
        .catch(() => { shot.current = ""; });
    }, REVEAL_MS + 160);
    return () => clearTimeout(timer);
  }, [Component, open, meta.id, meta.version]);

  const body = (full: boolean) => Component && <RegionBoundary key={`body-${meta.version}-${full}`} fallback={<p className="built-error" role="status">{meta.title} stopped while it was drawing.</p>} onError={report}>
    <div className="built-body"><Component expanded={full} /></div>
  </RegionBoundary>;

  return <section className="bar-widget built" ref={box} data-built={meta.id}>
    <header>
      <span>{meta.title}</span>
      {meta.expands && <button type="button" className="bar-flip" aria-haspopup="dialog" aria-label={`Open ${meta.title} full screen`} title="Open it full screen" onClick={() => setExpanded(true)}><ExpandIcon /></button>}
      <BuiltMenu meta={meta} />
    </header>
    <div className="bar-widget-body">
      {error ? <p className="built-error" role="status">{meta.title} could not run · {error}</p> : body(false)}
      {Component && !error && <Reveal key={`reveal-${meta.version}`} />}
    </div>
    {open && <dialog ref={dialog} className="modal-backdrop" aria-label={meta.title} onClose={() => setExpanded(false)} onCancel={(event) => { event.preventDefault(); dialog.current?.close(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="built-full">
        <header><strong>{meta.title}</strong><button type="button" aria-label="Close" onClick={() => dialog.current?.close()}>×</button></header>
        {error ? <p className="built-error" role="status">{meta.title} could not run · {error}</p> : body(true)}
      </div>
    </dialog>}
  </section>;
}

function Reveal() {
  const [done, setDone] = useState(false);
  const [glyphs] = useState(() => Array.from({ length: REVEAL_CHARS }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]).join(""));
  if (done) return null;
  return <pre className="built-reveal" aria-hidden="true" onAnimationEnd={() => setDone(true)}>{glyphs}</pre>;
}

function BuiltMenu({ meta }: { meta: ComponentMeta }) {
  const [open, setOpen] = useState(false);
  const remove = () => {
    setOpen(false);
    if (!confirm(`Delete “${meta.title}”?\n\nEmma built this into ${COMPONENT_ZONE_LABEL}. It goes for good — only she can build it again.`)) return;
    void window.emma.deleteComponent(meta.id);
  };
  return <span className="built-menu"
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
    <button type="button" className="bar-flip" aria-label={`More for ${meta.title}`} aria-expanded={open} title={`${meta.title} — built by Emma`} onClick={() => setOpen((was) => !was)}><MoreIcon /></button>
    {open && <span className="built-menu-list" role="menu">
      <button type="button" role="menuitem" onClick={() => { setOpen(false); void window.emma.expandComponent({ id: meta.id, expands: !meta.expands }); }}>{meta.expands ? "No full screen" : "Allow full screen"}</button>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); void window.emma.enableComponent(meta.id, false); }}>Switch off</button>
      <button type="button" role="menuitem" className="built-danger" onClick={remove}>Delete…</button>
    </span>}
  </span>;
}

export function BuiltSettings({ busy, onAttach }: { busy: boolean; onAttach: (meta: ComponentMeta) => void }) {
  const built = useComponents();
  const [note, setNote] = useState("");
  const act = (work: Promise<unknown>) => void work.then(() => setNote("")).catch((reason: unknown) => setNote(reasonText(reason)));
  const removeAll = () => {
    if (!confirm(`Delete all ${built.length} of them?\n\nEverything Emma has built into her interface goes for good.`)) return;
    act(Promise.all(built.map((one) => window.emma.deleteComponent(one.id))));
  };
  if (!built.length) return <div className="settings-lines"><section><div><p className="built-empty">Emma has built nothing into her interface yet. Ask her for one in a thread — it appears in {COMPONENT_ZONE_LABEL}, under the built-in widgets.</p></div></section></div>;
  return <div className="built-list">
    {note && <p className="built-error" role="status">{note}</p>}
    {built.map((one) => <article key={one.id} className="built-card" data-off={one.disabled || undefined}>
      <Shot key={one.version} meta={one} />
      <div className="built-card-body">
        <strong>{one.title}</strong>
        <small>v{one.version}{one.expands ? " · opens full screen" : ""}{one.disabled ? " · switched off" : ""}</small>
      </div>
      <div className="built-card-acts">
        <button type="button" disabled={busy} onClick={() => onAttach(one)}>Send to a thread</button>
        <button type="button" disabled={busy} onClick={() => act(window.emma.expandComponent({ id: one.id, expands: !one.expands }))}>{one.expands ? "No full screen" : "Allow full screen"}</button>
        <button type="button" disabled={busy} onClick={() => act(window.emma.enableComponent(one.id, !!one.disabled))}>{one.disabled ? "Switch on" : "Switch off"}</button>
        <button type="button" className="built-danger" disabled={busy} onClick={() => { if (confirm(`Delete “${one.title}”?\n\nIt goes for good — only Emma can build it again.`)) act(window.emma.deleteComponent(one.id)); }}>Delete…</button>
      </div>
      {one.variables?.length ? <Variables meta={one} busy={busy} onError={setNote} /> : null}
    </article>)}
    <footer><button type="button" className="built-danger" disabled={busy} onClick={removeAll}>Delete all {built.length}</button></footer>
  </div>;
}

function Variables({ meta, busy, onError }: { meta: ComponentMeta; busy: boolean; onError: (why: string) => void }) {
  const [stored, setStored] = useState<CredentialSummary[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => { void window.emma.listCredentials().then(setStored).catch(() => setStored([])); }, []);
  const save = (env: string, secret: string | undefined) => {
    void window.emma.saveCredential({ env, secret })
      .then((next) => { setStored(next); setDrafts((was) => ({ ...was, [env]: "" })); onError(""); })
      .catch((reason: unknown) => onError(reasonText(reason)));
  };
  return <div className="built-vars">
    {(meta.variables ?? []).map((env) => {
      const held = stored.find((one) => one.env === env);
      const draft = drafts[env] ?? "";
      return <label key={env}>
        <span>{env}</span>
        <input type="password" value={draft} disabled={busy} spellCheck={false} autoComplete="off"
          placeholder={held ? held.masked : "not set"}
          onChange={(event) => setDrafts((was) => ({ ...was, [env]: event.target.value }))}
          onKeyDown={(event) => { if (event.key === "Enter" && draft.trim()) save(env, draft.trim()); }} />
        <button type="button" disabled={busy || !draft.trim()} onClick={() => save(env, draft.trim())}>Save</button>
        {held && <button type="button" className="built-danger" disabled={busy} onClick={() => save(env, undefined)}>Clear</button>}
      </label>;
    })}
  </div>;
}

function Shot({ meta }: { meta: ComponentMeta }) {
  const [missing, setMissing] = useState(false);
  if (missing) return <span className="built-shot built-shot-none" aria-hidden="true" />;
  return <img className="built-shot" src={componentShotUrl(meta.id, meta.version)} alt={`${meta.title}, as it looks in Emma`} onError={() => setMissing(true)} />;
}
