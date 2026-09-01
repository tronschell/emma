import { lazy, Suspense, useEffect, useState } from "react";
import type { TerminalTab } from "../shared/terminal";

export type TerminalSelection = { id: string; text: string; lines: number };
export type TerminalSurfaceProps = {
  tab: TerminalTab;
  active: boolean;
  onSelect: (value: TerminalSelection) => void;
  onLink: (value: { url: string; x: number; y: number }) => void;
};
export type TerminalPanelProps = {
  threadId: string;
  folderId: string;
  popped: string[];
  onPop: (id: string) => void;
  onSelect: (value: TerminalSelection) => void;
  onHide: () => void;
  onOpenInEmma: (url: string) => void;
};

export function useTerminals(threadId: string): TerminalTab[] {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    const read = () => void window.emma.listTerminals(threadId)
      .then((found) => { if (alive) setTabs(found); })
      .catch(() => undefined);
    read();
    const stop = window.emma.onTerminals(read);
    return () => { alive = false; stop(); };
  }, [threadId]);
  return tabs.filter((tab) => tab.threadId === threadId);
}

export async function closeTerminals(threadId: string) {
  const tabs = await window.emma.listTerminals(threadId).catch(() => []);
  await Promise.all(tabs.map((tab) => window.emma.closeTerminal(tab.id).catch(() => undefined)));
}

function TerminalGlyph() {
  return <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 4.5L6.5 8 3 11.5M8.5 12h4.5" /></svg>;
}

export function TerminalIcon() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="1.6" y="2.6" width="12.8" height="10.8" /><path d="M4.2 6.1l2.3 2.3-2.3 2.3M8.6 10.7h3.2" /></svg>;
}

const LazyTerminalSurface = lazy(() => import("./terminal-implementation").then(({ TerminalSurfaceImplementation }) => ({ default: TerminalSurfaceImplementation })));
const LazyTerminalPanel = lazy(() => import("./terminal-implementation").then(({ TerminalPanelImplementation }) => ({ default: TerminalPanelImplementation })));

function TerminalSurfaceFallback({ active }: Pick<TerminalSurfaceProps, "active">) {
  return <div className="terminal-surface" data-active={active} aria-busy="true"><p className="terminal-empty" role="status">Loading terminal…</p></div>;
}

function TerminalPanelFallback({ onHide }: Pick<TerminalPanelProps, "onHide">) {
  return <section className="terminal-panel" aria-label="Terminal" aria-busy="true">
    <header className="terminal-tabs"><span className="sr-only">Terminal loading</span><button type="button" className="terminal-hide" aria-label="Hide the terminal" title="Hide the terminal — the shells keep running" onClick={onHide}>×</button></header>
    <div className="terminal-stage"><p className="terminal-empty" role="status">Loading terminal…</p></div>
  </section>;
}

export function TerminalSurface(props: TerminalSurfaceProps) {
  return <Suspense fallback={<TerminalSurfaceFallback active={props.active} />}><LazyTerminalSurface {...props} /></Suspense>;
}

export function TerminalPanel(props: TerminalPanelProps) {
  const tabs = useTerminals(props.threadId);
  return <Suspense fallback={<TerminalPanelFallback onHide={props.onHide} />}><LazyTerminalPanel {...props} tabs={tabs} tabGlyph={TerminalGlyph} /></Suspense>;
}
