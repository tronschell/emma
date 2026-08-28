import { useEffect, useRef, useState, type FunctionComponent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { componentModuleUrl, componentShotUrl, MAX_COMPONENT_SELECTOR_CHARS, type ComponentMeta } from "../shared/components";
import { RegionBoundary, runtime } from "./regions";
import { MoreIcon } from "./icons";
import { reasonText } from "./errors";

const REVEAL_MS = 720;
const GLYPHS = "░▒▓█▚▞╱╲┃┇┊+*=~-_/\\<>[]{}();:.,0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const REVEAL_CHARS = 900;
/**
 * The three places a component may live. The transcript is deliberately not one
 * of them: it is rebuilt per thread, so a selector into it points at nothing the
 * moment the user opens another conversation. Whole zones, not arbitrary divs,
 * so the anchor survives every redraw inside them.
 */
const ZONES = [
  { selector: "aside.sidebar", label: "the sidebar" },
  { selector: "aside.inspector", label: "the context bar" },
  { selector: "form.composer", label: "the composer" },
] as const;
type Zone = (typeof ZONES)[number];
const ZONE_SELECTORS = ZONES.map((zone) => zone.selector).join(", ");

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
  const [ask, setAsk] = useState<{ id: string; title: string } | null>(null);
  useEffect(() => window.emma.onComponentPlace(setAsk), []);
  return <>
    {built.filter((one) => !one.disabled).map((one) => <Mounted key={one.id} meta={one} />)}
    {ask && <Placer title={ask.title} onDone={(anchor) => { window.emma.answerPlace({ id: ask.id, ...anchor }); setAsk(null); }} />}
  </>;
}

function Mounted({ meta }: { meta: ComponentMeta }) {
  // One host node for the life of the component. Handing React a container it
  // never has to swap is what keeps a rewrite from leaving its old body behind:
  // re-creating it made every version mount into a fresh portal and the old DOM
  // was never collected.
  const [host] = useState(() => {
    const node = document.createElement("div");
    node.className = "built-host";
    return node;
  });
  useEffect(() => {
    let frame = 0;
    const settle = () => {
      const zone = resolve(meta.anchor.selector);
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
  }, [host, meta.anchor.selector]);
  return createPortal(<Frame meta={meta} />, host);
}

function resolve(selector: string): Element | null {
  if (selector.length > MAX_COMPONENT_SELECTOR_CHARS) return null;
  try {
    const found = document.querySelector(selector);
    return found && !found.closest(".built") ? found : null;
  } catch {
    return null;
  }
}

function Frame({ meta }: { meta: ComponentMeta }) {
  const [made, setMade] = useState<{ version: number; Component: FunctionComponent } | null>(null);
  const [error, setError] = useState("");
  const [moving, setMoving] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const shot = useRef("");

  useEffect(() => {
    let alive = true;
    void import(/* @vite-ignore */ componentModuleUrl(meta.id, meta.version))
      .then((module: { default?: unknown }) => {
        if (!alive) return;
        if (typeof module.default !== "function") throw new Error("A component module has to `export default` a function: it is handed { h, useState, emma } and returns the component.");
        const Component = (module.default as (api: typeof runtime) => unknown)(runtime);
        if (typeof Component !== "function") throw new Error(`The default export returned ${typeof Component}. It has to return a component — a function that returns h(...).`);
        setMade({ version: meta.version, Component: Component as FunctionComponent });
        setError("");
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        setMade(null);
        setError(reasonText(reason));
      });
    return () => { alive = false; };
  }, [meta.id, meta.version]);

  useEffect(() => {
    const key = `${meta.id}:${meta.version}`;
    if (!made || made.version !== meta.version || shot.current === key) return;
    const timer = setTimeout(() => {
      const rect = box.current?.getBoundingClientRect();
      if (!rect || rect.width < 8 || rect.height < 8) return;
      shot.current = key;
      void window.emma.shootComponent({ id: meta.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height })
        .catch(() => { shot.current = ""; });
    }, REVEAL_MS + 160);
    return () => clearTimeout(timer);
  }, [made, meta.id, meta.version]);

  const Component = made?.version === meta.version ? made.Component : undefined;
  return <div className="built" ref={box} data-built={meta.id}>
    {moving && <Placer title={meta.title} onDone={(anchor) => {
      setMoving(false);
      if (anchor.selector) void window.emma.moveComponent({ id: meta.id, selector: anchor.selector, label: anchor.label ?? anchor.selector });
    }} />}
    {error
      ? <p className="built-error" role="status">{meta.title} could not run · {error}</p>
      : Component && <RegionBoundary key={`body-${meta.version}`} fallback={<p className="built-error" role="status">{meta.title} stopped while it was drawing.</p>} onError={setError}>
        <div className="built-body"><Component /></div>
      </RegionBoundary>}
    {Component && <Reveal key={`reveal-${meta.version}`} />}
    <BuiltMenu meta={meta} onMove={() => setMoving(true)} />
  </div>;
}

function Reveal() {
  const [done, setDone] = useState(false);
  const [glyphs] = useState(() => Array.from({ length: REVEAL_CHARS }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]).join(""));
  if (done) return null;
  return <pre className="built-reveal" aria-hidden="true" onAnimationEnd={() => setDone(true)}>{glyphs}</pre>;
}

function BuiltMenu({ meta, onMove }: { meta: ComponentMeta; onMove: () => void }) {
  const [open, setOpen] = useState(false);
  const remove = () => {
    setOpen(false);
    if (!confirm(`Delete “${meta.title}”?\n\nEmma built this into ${meta.anchor.label}. It goes for good — only she can build it again.`)) return;
    void window.emma.deleteComponent(meta.id);
  };
  return <span className="built-menu"
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
    <Grip meta={meta} />
    <button type="button" aria-label={`More for ${meta.title}`} aria-expanded={open} title={`${meta.title} — built by Emma`} onClick={() => setOpen((was) => !was)}><MoreIcon /></button>
    {open && <span className="built-menu-list" role="menu">
      <button type="button" role="menuitem" onClick={() => { setOpen(false); onMove(); }}>Move…</button>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); void window.emma.enableComponent(meta.id, false); }}>Switch off</button>
      <button type="button" role="menuitem" className="built-danger" onClick={remove}>Delete…</button>
    </span>}
  </span>;
}

/**
 * Drag the whole component to another zone. The pointer picks the drop target by
 * what is under it, so the same outline the click picker draws is the one the
 * drag lands in.
 */
function Grip({ meta }: { meta: ComponentMeta }) {
  const [dragging, setDragging] = useState(false);
  const start = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const glow = lamp();
    const root = document.documentElement;
    root.setAttribute("data-emma-drag", "");
    setDragging(true);
    let over: Zone | null = null;
    const move = (moved: PointerEvent) => { over = zoneAt(document.elementFromPoint(moved.clientX, moved.clientY)); glow.show(over); };
    const stop = (dropped: Zone | null) => {
      glow.show(null);
      root.removeAttribute("data-emma-drag");
      removeEventListener("pointermove", move, true);
      removeEventListener("pointerup", up, true);
      removeEventListener("keydown", key, true);
      setDragging(false);
      if (dropped && dropped.selector !== meta.anchor.selector) void window.emma.moveComponent({ id: meta.id, ...dropped });
    };
    const up = () => stop(over);
    const key = (pressed: KeyboardEvent) => { if (pressed.key === "Escape") { pressed.preventDefault(); stop(null); } };
    addEventListener("pointermove", move, true);
    addEventListener("pointerup", up, true);
    addEventListener("keydown", key, true);
  };
  return <button type="button" className="built-grip" aria-label={`Drag ${meta.title} somewhere else`}
    title="Drag me to the sidebar, the context bar or the composer" data-dragging={dragging || undefined} onPointerDown={start}>⠿</button>;
}

function zoneAt(target: EventTarget | null): Zone | null {
  if (!(target instanceof Element)) return null;
  const found = target.closest(ZONE_SELECTORS);
  return (found && ZONES.find((zone) => found.matches(zone.selector))) ?? null;
}

/** One lit outline at a time, shared by the click picker and the drag. */
function lamp() {
  let lit: Element | null = null;
  return {
    show(zone: Zone | null) {
      const element = zone ? document.querySelector(zone.selector) : null;
      if (lit === element) return;
      lit?.removeAttribute("data-emma-lit");
      lit = element;
      lit?.setAttribute("data-emma-lit", "");
    },
  };
}

function Placer({ title, onDone }: { title: string; onDone: (anchor: { selector?: string; label?: string }) => void }) {
  useEffect(() => {
    const glow = lamp();
    const over = (event: PointerEvent) => glow.show(zoneAt(event.target));
    const down = (event: MouseEvent) => { if (zoneAt(event.target)) { event.preventDefault(); event.stopPropagation(); } };
    const click = (event: MouseEvent) => {
      const zone = zoneAt(event.target);
      if (!zone) return;
      event.preventDefault();
      event.stopPropagation();
      glow.show(null);
      onDone({ ...zone });
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onDone({}); } };
    document.documentElement.setAttribute("data-emma-place", "");
    addEventListener("pointerover", over, true);
    addEventListener("pointerdown", down, true);
    addEventListener("click", click, true);
    addEventListener("keydown", key, true);
    return () => {
      glow.show(null);
      document.documentElement.removeAttribute("data-emma-place");
      removeEventListener("pointerover", over, true);
      removeEventListener("pointerdown", down, true);
      removeEventListener("click", click, true);
      removeEventListener("keydown", key, true);
    };
  }, [onDone]);
  return <div className="placing" role="status">
    <strong>Point at where “{title}” goes</strong>
    <span>The sidebar, the context bar or the composer · Esc to leave it</span>
  </div>;
}

export function BuiltSettings({ busy, onAttach }: { busy: boolean; onAttach: (meta: ComponentMeta) => void }) {
  const built = useComponents();
  const [note, setNote] = useState("");
  const act = (work: Promise<unknown>) => void work.then(() => setNote("")).catch((reason: unknown) => setNote(reasonText(reason)));
  const removeAll = () => {
    if (!confirm(`Delete all ${built.length} of them?\n\nEverything Emma has built into her interface goes for good.`)) return;
    act(Promise.all(built.map((one) => window.emma.deleteComponent(one.id))));
  };
  if (!built.length) return <p className="built-empty">Emma has built nothing into her interface yet. Ask her for one in a thread — she asks you where it goes, then builds it there.</p>;
  return <div className="built-list">
    {note && <p className="built-error" role="status">{note}</p>}
    {built.map((one) => <article key={one.id} className="built-card" data-off={one.disabled || undefined}>
      <Shot key={one.version} meta={one} />
      <div className="built-card-body">
        <strong>{one.title}</strong>
        <small>in {one.anchor.label} · v{one.version}{one.disabled ? " · switched off" : ""}</small>
      </div>
      <div className="built-card-acts">
        <button type="button" disabled={busy} onClick={() => onAttach(one)}>Send to a thread</button>
        <button type="button" disabled={busy} onClick={() => act(window.emma.enableComponent(one.id, !!one.disabled))}>{one.disabled ? "Switch on" : "Switch off"}</button>
        <button type="button" className="built-danger" disabled={busy} onClick={() => { if (confirm(`Delete “${one.title}”?\n\nIt goes for good — only Emma can build it again.`)) act(window.emma.deleteComponent(one.id)); }}>Delete…</button>
      </div>
    </article>)}
    <footer><button type="button" className="built-danger" disabled={busy} onClick={removeAll}>Delete all {built.length}</button></footer>
  </div>;
}

function Shot({ meta }: { meta: ComponentMeta }) {
  const [missing, setMissing] = useState(false);
  if (missing) return <span className="built-shot built-shot-none" aria-hidden="true" />;
  return <img className="built-shot" src={componentShotUrl(meta.id, meta.version)} alt={`${meta.title}, as it looks in Emma`} onError={() => setMissing(true)} />;
}
