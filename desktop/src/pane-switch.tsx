import { useEffect, useRef, useState, type ReactNode } from "react";

export function PaneSwitch({ open, running, onOpen, onHide, onClose, openLabel, closeLabel, hideNote, closeNote, children }: {
  open: boolean;
  running: () => Promise<boolean>;
  onOpen: () => void;
  onHide: () => void;
  onClose: () => void;
  openLabel: string;
  closeLabel: string;
  hideNote: string;
  closeNote: string;
  children: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!asking) return;
    const outside = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setAsking(false); };
    addEventListener("pointerdown", outside);
    return () => removeEventListener("pointerdown", outside);
  }, [asking]);
  const press = () => {
    if (!open) { onOpen(); return; }
    void running().then((live) => { if (live) setAsking(true); else onHide(); }).catch(onHide);
  };
  const pick = (quit: boolean) => { setAsking(false); (quit ? onClose : onHide)(); };
  return <div className="pane-switch" ref={box} onKeyDown={(event) => { if (event.key === "Escape") setAsking(false); }}>
    <button type="button" className="pane-toggle" aria-label={open ? closeLabel : openLabel} aria-pressed={open} aria-haspopup={open ? "menu" : undefined} aria-expanded={open ? asking : undefined} title={open ? closeLabel : openLabel} onClick={press}>{children}</button>
    {asking && <section className="source-popover pane-menu" role="menu" aria-label={closeLabel}>
      <button type="button" role="menuitem" autoFocus onClick={() => pick(false)}><strong>Hide</strong><small>{hideNote}</small></button>
      <button type="button" role="menuitem" onClick={() => pick(true)}><strong>Close</strong><small>{closeNote}</small></button>
    </section>}
  </div>;
}
