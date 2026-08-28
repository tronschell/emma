import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { FoldIcon, MoreIcon } from "./icons";

export type PipMenuItem = { label: string; icon: ReactNode; onSelect: () => void };

export type PipWindow = {
  id: string;
  label: string;
  detail?: string;
  tone?: string;
  icon: ReactNode;
  status?: ReactNode;
  menu?: PipMenuItem[];
  body: ReactNode;
  footer?: ReactNode;
};

type Box = { x: number; y: number; width: number; height: number };
type Placement = Box & { collapsed: boolean; loose: boolean };

const PIP_WIDTH = 384;
const PIP_HEIGHT = 300;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 260;
const EDGE = 12;
const STACK = 18;
const DEEPEST = 3;
const TOP = EDGE + STACK * DEEPEST;
const RAIL = 36;
const SAMPLE_COLUMNS = 5;
const SAMPLE_ROWS = 4;
const CROWD_WEIGHT = 2.4;
const OVERLAP_PENALTY = 10;
const TRAVEL_WEIGHT = 0.55;
const TEAR = 5;
const GUARDS = ".composer";
const ANCHORS = [0, 1 / 3, 2 / 3, 1];
const INK_TAGS = ["IMG", "CANVAS", "SVG", "BUTTON", "TEXTAREA", "INPUT", "PRE", "CODE"];

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

const overlap = (a: Box, b: Box) => {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
};

const inked = (element: Element | undefined) => {
  if (!element) return false;
  if (INK_TAGS.includes(element.tagName.toUpperCase())) return true;
  return element.childElementCount === 0 && !!element.textContent?.trim();
};

function floorOf(layer: HTMLElement) {
  const origin = layer.getBoundingClientRect();
  let floor = layer.clientHeight;
  for (const guard of layer.parentElement?.querySelectorAll<HTMLElement>(GUARDS) ?? []) {
    if (!guard.clientHeight || layer.contains(guard)) continue;
    floor = Math.min(floor, guard.getBoundingClientRect().top - origin.top - EDGE);
  }
  return Math.max(TOP + MIN_HEIGHT, floor);
}

function coverage(layer: HTMLElement, box: Box) {
  const origin = layer.getBoundingClientRect();
  let hits = 0;
  for (let column = 1; column <= SAMPLE_COLUMNS; column += 1) {
    for (let row = 1; row <= SAMPLE_ROWS; row += 1) {
      const x = origin.left + box.x + (box.width * column) / (SAMPLE_COLUMNS + 1);
      const y = origin.top + box.y + (box.height * row) / (SAMPLE_ROWS + 1);
      const under = document.elementsFromPoint(x, y).find((element) => !layer.contains(element));
      if (inked(under)) hits += 1;
    }
  }
  return hits / (SAMPLE_COLUMNS * SAMPLE_ROWS);
}

function restfulSpot(layer: HTMLElement, box: Box, others: Box[], from?: { x: number; y: number }) {
  const room = { width: layer.clientWidth - RAIL, height: floorOf(layer) };
  const lastX = Math.max(EDGE, room.width - box.width - EDGE);
  const lastY = Math.max(TOP, room.height - box.height - EDGE);
  const reach = Math.hypot(room.width, room.height) || 1;
  let best = { x: clamp(box.x, EDGE, lastX), y: clamp(box.y, TOP, lastY) };
  let lowest = Number.POSITIVE_INFINITY;
  for (const column of ANCHORS.map((share) => EDGE + (lastX - EDGE) * share)) {
    for (const row of ANCHORS.map((share) => TOP + (lastY - TOP) * share)) {
      const spot = { x: clamp(column, EDGE, lastX), y: clamp(row, TOP, lastY) };
      const candidate = { ...spot, width: box.width, height: box.height };
      const crowd = others.reduce((total, other) => total + overlap(candidate, other), 0) / (box.width * box.height);
      const travel = from ? Math.hypot(spot.x - from.x, spot.y - from.y) / reach : 0;
      const score = (crowd > 0 ? OVERLAP_PENALTY : 0) + coverage(layer, candidate) + crowd * CROWD_WEIGHT + travel * TRAVEL_WEIGHT;
      if (score < lowest) {
        lowest = score;
        best = spot;
      }
    }
  }
  return best;
}

function PipMenu({ label, items }: { label: string; items: PipMenuItem[] }) {
  const [open, setOpen] = useState(false);
  return <span className="pip-menu" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
    <button type="button" aria-label={`More for ${label}`} aria-expanded={open} title="More" onClick={() => setOpen((was) => !was)}><MoreIcon /></button>
    {open && <span className="pip-menu-list" role="menu">
      {items.map((item) => <button key={item.label} type="button" role="menuitem" onClick={() => { setOpen(false); item.onSelect(); }}>
        <b aria-hidden="true">{item.icon}</b>{item.label}
      </button>)}
    </span>}
  </span>;
}

export function PipLayer({ panes }: { panes: PipWindow[] }) {
  const layer = useRef<HTMLDivElement>(null);
  const [places, setPlaces] = useState<Record<string, Placement>>({});
  const [front, setFront] = useState("");
  const [held, setHeld] = useState("");
  const [railAt, setRailAt] = useState<{ x: number; y: number }>();
  const railTorn = useRef(false);
  const shown = useRef(places);
  const move = useRef<{ id: string; dx: number; dy: number; from: { x: number; y: number }; torn: boolean } | undefined>(undefined);
  const stretch = useRef<{ id: string; x: number; y: number; width: number; height: number } | undefined>(undefined);
  useEffect(() => { shown.current = places; });

  const ids = panes.map((pane) => pane.id).join(" ");
  useEffect(() => {
    const node = layer.current;
    if (!node) return;
    const live = ids.split(" ").filter(Boolean);
    const next: Record<string, Placement> = {};
    const taken: Box[] = [];
    let deck: Placement | undefined;
    for (const id of live) {
      const place = shown.current[id];
      if (!place) continue;
      next[id] = place;
      if (place.collapsed) continue;
      if (place.loose) taken.push(place);
      else deck = place;
    }
    let added = false;
    for (const id of live) {
      if (next[id]) continue;
      added = true;
      if (deck) {
        next[id] = deck;
        continue;
      }
      const box = { x: EDGE, y: TOP, width: PIP_WIDTH, height: PIP_HEIGHT };
      deck = { ...box, ...restfulSpot(node, box, taken), collapsed: false, loose: false };
      next[id] = deck;
    }
    if (added || Object.keys(next).length !== Object.keys(shown.current).length) setPlaces(next);
  }, [ids]);

  const deckIds = panes.map((pane) => pane.id).filter((id) => places[id] && !places[id]!.collapsed && !places[id]!.loose);
  const frontId = deckIds.includes(front) ? front : deckIds[deckIds.length - 1] ?? "";
  const deck = places[frontId];

  const settle = (id: string, place: Placement, others: Box[]) => {
    const node = layer.current;
    if (!node) return;
    const spot = restfulSpot(node, place, others, { x: place.x, y: place.y });
    setPlaces((current) => {
      const kin = current[id];
      if (!kin) return current;
      const moved = { ...kin, ...spot };
      if (kin.loose) return { ...current, [id]: moved };
      const next = { ...current };
      for (const [other, place] of Object.entries(current)) {
        if (!place.loose) next[other] = { ...place, ...spot };
      }
      return next;
    });
  };

  const spread = (id: string, box: Box) => setPlaces((current) => {
    const place = current[id];
    if (!place) return current;
    return { ...current, [id]: { ...place, ...box, loose: true } };
  });

  const shift = (id: string, box: { x: number; y: number }) => setPlaces((current) => {
    const place = current[id];
    if (!place) return current;
    if (place.loose) return { ...current, [id]: { ...place, ...box } };
    const next = { ...current };
    for (const [other, kin] of Object.entries(current)) {
      if (!kin.loose) next[other] = { ...kin, ...box };
    }
    return next;
  });

  const grab = (id: string, depth: number) => (event: ReactPointerEvent) => {
    const node = layer.current;
    const place = places[id];
    if (!node || !place || (event.target as HTMLElement).closest("button")) return;
    const origin = node.getBoundingClientRect();
    const at = { x: place.x + depth * STACK, y: place.y - depth * STACK };
    move.current = {
      id,
      dx: event.clientX - origin.left - at.x,
      dy: event.clientY - origin.top - at.y,
      from: { x: event.clientX, y: event.clientY },
      torn: place.loose || deckIds.length < 2,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setFront(id);
    setHeld(id);
  };

  const slide = (event: ReactPointerEvent) => {
    const node = layer.current;
    const drag = move.current;
    if (!node || !drag) return;
    const origin = node.getBoundingClientRect();
    const place = shown.current[drag.id];
    if (!place) return;
    const box = {
      x: clamp(event.clientX - origin.left - drag.dx, 0, node.clientWidth - RAIL - place.width),
      y: clamp(event.clientY - origin.top - drag.dy, TOP - STACK * DEEPEST, floorOf(node) - place.height),
    };
    if (!drag.torn) {
      if (Math.hypot(event.clientX - drag.from.x, event.clientY - drag.from.y) < TEAR) return;
      drag.torn = true;
      spread(drag.id, { ...box, width: place.width, height: place.height });
      return;
    }
    shift(drag.id, box);
  };

  const seize = (id: string) => (event: ReactPointerEvent) => {
    const place = places[id];
    if (!place) return;
    stretch.current = { id, x: event.clientX, y: event.clientY, width: place.width, height: place.height };
    event.currentTarget.setPointerCapture(event.pointerId);
    setHeld(id);
  };

  const pull = (event: ReactPointerEvent) => {
    const node = layer.current;
    const grip = stretch.current;
    if (!node || !grip) return;
    setPlaces((current) => {
      const place = current[grip.id];
      if (!place) return current;
      const size = {
        width: clamp(grip.width + event.clientX - grip.x, MIN_WIDTH, node.clientWidth - RAIL - place.x),
        height: clamp(grip.height + event.clientY - grip.y, MIN_HEIGHT, floorOf(node) - place.y),
      };
      if (place.loose) return { ...current, [grip.id]: { ...place, ...size } };
      const next = { ...current };
      for (const [other, kin] of Object.entries(current)) {
        if (!kin.loose) next[other] = { ...kin, ...size };
      }
      return next;
    });
  };

  const release = () => {
    const dragged = move.current;
    move.current = undefined;
    stretch.current = undefined;
    setHeld("");
    if (!dragged?.torn) return;
    const place = shown.current[dragged.id];
    if (!place) return;
    const others = Object.entries(shown.current)
      .filter(([id, other]) => id !== dragged.id && !other.collapsed && (other.loose || place.loose))
      .map(([, other]) => other);
    settle(dragged.id, place, others);
  };

  const resizeKeys = (id: string) => (event: ReactKeyboardEvent) => {
    const node = layer.current;
    const place = places[id];
    const step = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key];
    if (!node || !place || !step) return;
    event.preventDefault();
    setPlaces((current) => ({ ...current, [id]: {
      ...place,
      width: clamp(place.width + step[0]!, MIN_WIDTH, node.clientWidth - RAIL - place.x),
      height: clamp(place.height + step[1]!, MIN_HEIGHT, floorOf(node) - place.y),
    } }));
  };

  const grabRail = (event: ReactPointerEvent<HTMLDivElement>) => {
    const node = layer.current;
    if (!node) return;
    const box = event.currentTarget.getBoundingClientRect();
    const dx = event.clientX - box.left;
    const dy = event.clientY - box.top;
    const from = { x: event.clientX, y: event.clientY };
    const pressed = (event.target as HTMLElement).closest("button")?.getAttribute("data-pane") ?? "";
    let torn = false;
    setRailAt({ x: box.left - node.getBoundingClientRect().left, y: box.top - node.getBoundingClientRect().top });
    const slide = (moved: PointerEvent) => {
      if (!torn && Math.hypot(moved.clientX - from.x, moved.clientY - from.y) < TEAR) return;
      torn = true;
      const origin = node.getBoundingClientRect();
      setRailAt({
        x: clamp(moved.clientX - origin.left - dx, EDGE, node.clientWidth - box.width - EDGE),
        y: clamp(moved.clientY - origin.top - dy, EDGE, floorOf(node) - box.height),
      });
    };
    const drop = () => {
      removeEventListener("pointermove", slide);
      removeEventListener("pointerup", drop);
      railTorn.current = torn;
      if (!torn && pressed) fold(pressed, false);
    };
    addEventListener("pointermove", slide);
    addEventListener("pointerup", drop);
  };

  const fold = (id: string, collapsed: boolean) => setPlaces((current) => {
    const place = current[id];
    return place ? { ...current, [id]: { ...place, collapsed } } : current;
  });

  const card = (pane: PipWindow, place: Placement, depth: number) =>
    <section key={pane.id} className="pip" data-status={pane.tone} data-held={held === pane.id} data-depth={depth}
      style={{ left: `${place.x + depth * STACK}px`, top: `${place.y - depth * STACK}px`, width: `${place.width}px`, height: `${place.height}px` }}
      aria-label={pane.label} onPointerDown={depth ? () => setFront(pane.id) : undefined}>
      <header onPointerDown={grab(pane.id, depth)} onPointerMove={slide} onPointerUp={release} onPointerCancel={release}>
        <span className="pip-mark">{pane.icon}</span>
        <span className="pip-title"><strong>{pane.label}</strong>{pane.detail && <small>{pane.detail}</small>}</span>
        {pane.status}
        <span className="pip-tools">
          {pane.menu?.length ? <PipMenu label={pane.label} items={pane.menu} /> : null}
          <button type="button" title="Hide into the rail" aria-label={`Hide ${pane.label}`} onClick={() => fold(pane.id, true)}><FoldIcon /></button>
        </span>
      </header>
      <div className="pip-body">{pane.body}</div>
      {pane.footer}
      <button type="button" className="pip-grip" aria-label={`Resize ${pane.label}`}
        onPointerDown={seize(pane.id)} onPointerMove={pull} onPointerUp={release} onPointerCancel={release} onKeyDown={resizeKeys(pane.id)} />
    </section>;

  const behind = deckIds.filter((id) => id !== frontId);
  const hidden = panes.filter((pane) => places[pane.id]?.collapsed);
  return <div className="pip-layer" ref={layer}>
    {deck && behind.map((id, index) => {
      const pane = panes.find((item) => item.id === id);
      return pane ? card(pane, deck, Math.min(behind.length - index, DEEPEST)) : null;
    })}
    {deck && frontId && card(panes.find((pane) => pane.id === frontId)!, deck, 0)}
    {panes.filter((pane) => places[pane.id]?.loose && !places[pane.id]!.collapsed).map((pane) => card(pane, places[pane.id]!, 0))}
    {hidden.length > 0 && <div className="pip-rail" role="toolbar" aria-label="Hidden windows"
      style={railAt && { left: `${railAt.x}px`, top: `${railAt.y}px`, right: "auto", transform: "none" }}
      onPointerDown={grabRail}
      onClickCapture={(event) => { if (railTorn.current) { event.preventDefault(); event.stopPropagation(); } }}>
      {hidden.map((pane) => <button key={pane.id} type="button" data-status={pane.tone} data-pane={pane.id}
        title={`${pane.label} — show, or drag to move`} aria-label={`Show ${pane.label}`} onClick={() => fold(pane.id, false)}>{pane.icon}</button>)}
    </div>}
  </div>;
}
