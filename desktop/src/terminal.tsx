import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { terminalSelection, type TerminalTab } from "../shared/terminal";
import { reasonText } from "./errors";

export type TerminalSelection = { id: string; text: string; lines: number };

const RESIZE_SETTLE_MS = 80;
const LINK_MENU_WIDTH = 340;

export function useTerminals(threadId: string): TerminalTab[] {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  useEffect(() => {
    let alive = true;
    const read = () => void window.emma.listTerminals(threadId)
      .then((found) => { if (alive) setTabs(found); })
      .catch(() => undefined);
    read();
    const stop = window.emma.onTerminals(read);
    return () => { alive = false; stop(); };
  }, [threadId]);
  return tabs;
}

export async function closeTerminals(threadId: string) {
  const tabs = await window.emma.listTerminals(threadId).catch(() => []);
  await Promise.all(tabs.map((tab) => window.emma.closeTerminal(tab.id).catch(() => undefined)));
}

function paletteOf(node: HTMLElement) {
  const read = (name: string) => getComputedStyle(node).getPropertyValue(name).trim();
  return {
    background: read("--bg") || "#0e0e10",
    foreground: read("--text") || "#e8e6df",
    cursor: read("--accent") || "#ff6a3d",
    selectionBackground: read("--border-strong") || "#e8e6df47",
    red: read("--rose") || "#ed7a9b",
    green: read("--lime") || "#c3d64b",
    yellow: read("--orange") || "#ff6a3d",
    blue: read("--blue") || "#6faee6",
    magenta: read("--violet") || "#ae78f0",
    cyan: read("--teal") || "#3fd8c0",
  };
}

export function TerminalSurface({ tab, active, onSelect, onLink }: {
  tab: TerminalTab;
  active: boolean;
  onSelect: (value: TerminalSelection) => void;
  onLink: (value: { url: string; x: number; y: number }) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fitter = useRef<FitAddon>(null);
  const terminal = useRef<Terminal>(null);
  const held = useRef({ onSelect, onLink });
  useEffect(() => { held.current = { onSelect, onLink }; });

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const colours = paletteOf(node);
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(node).getPropertyValue("--font-code").trim() || "ui-monospace, Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.3,
      scrollback: 5000,
      theme: {
        background: colours.background,
        foreground: colours.foreground,
        cursor: colours.cursor,
        cursorAccent: colours.background,
        selectionBackground: colours.selectionBackground,
        red: colours.red,
        green: colours.green,
        yellow: colours.yellow,
        blue: colours.blue,
        magenta: colours.magenta,
        cyan: colours.cyan,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((event: MouseEvent, uri: string) => {
      if (!event.metaKey) return;
      event.preventDefault();
      held.current.onLink({ url: uri, x: Math.min(event.clientX, innerWidth - LINK_MENU_WIDTH), y: event.clientY });
    }));
    term.open(node);
    terminal.current = term;
    fitter.current = fit;

    const queued: { data: Uint8Array; at: number }[] = [];
    let replayedTo = -1;
    const stopData = window.emma.onTerminalData((chunk) => {
      if (chunk.id !== tab.id) return;
      if (replayedTo < 0) queued.push({ data: chunk.data, at: chunk.at });
      else term.write(chunk.data);
    });
    void window.emma.readTerminal(tab.id).then((saved) => {
      term.write(saved.data);
      for (const chunk of queued) {
        if (chunk.at > saved.at) term.write(chunk.data);
      }
      queued.length = 0;
      replayedTo = saved.at;
    }).catch(() => { replayedTo = 0; });

    const typed = term.onData((data) => void window.emma.writeTerminal({ id: tab.id, data }).catch(() => undefined));
    const resized = term.onResize(({ cols, rows }) => void window.emma.resizeTerminal({ id: tab.id, columns: cols, rows }).catch(() => undefined));
    const picked = () => {
      const selection = terminalSelection(term.getSelection());
      if (selection) held.current.onSelect({ id: tab.id, ...selection });
    };
    node.addEventListener("mouseup", picked);

    let settle: ReturnType<typeof setTimeout> | undefined;
    const watch = new ResizeObserver(() => {
      clearTimeout(settle);
      settle = setTimeout(() => { if (node.clientWidth > 0 && node.clientHeight > 0) fit.fit(); }, RESIZE_SETTLE_MS);
    });
    watch.observe(node);
    if (node.clientWidth > 0 && node.clientHeight > 0) fit.fit();

    return () => {
      clearTimeout(settle);
      watch.disconnect();
      node.removeEventListener("mouseup", picked);
      typed.dispose();
      resized.dispose();
      stopData();
      term.dispose();
      terminal.current = null;
      fitter.current = null;
    };
  }, [tab.id]);

  useEffect(() => {
    if (!active) return;
    const node = host.current;
    if (node && node.clientWidth > 0 && node.clientHeight > 0) fitter.current?.fit();
    terminal.current?.focus();
  }, [active]);

  return <div className="terminal-surface" data-active={active} ref={host} />;
}

function TerminalGlyph() {
  return <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 4.5L6.5 8 3 11.5M8.5 12h4.5" /></svg>;
}

export function TerminalIcon() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="1.6" y="2.6" width="12.8" height="10.8" /><path d="M4.2 6.1l2.3 2.3-2.3 2.3M8.6 10.7h3.2" /></svg>;
}

export function TerminalPanel({ threadId, popped, onPop, onSelect, onHide, onOpenInEmma }: {
  threadId: string;
  popped: string[];
  onPop: (id: string) => void;
  onSelect: (value: TerminalSelection) => void;
  onHide: () => void;
  onOpenInEmma: (url: string) => void;
}) {
  const tabs = useTerminals(threadId).filter((tab) => !popped.includes(tab.id));
  const [picked, setPicked] = useState("");
  const [error, setError] = useState("");
  const [link, setLink] = useState<{ url: string; x: number; y: number }>();
  const started = useRef("");

  const start = useCallback(() => {
    setError("");
    return window.emma.openTerminal({ threadId, columns: 80, rows: 24 })
      .then((tab) => setPicked(tab.id))
      .catch((reason: unknown) => setError(reasonText(reason)));
  }, [threadId]);

  useEffect(() => {
    if (started.current === threadId) return;
    started.current = threadId;
    void window.emma.listTerminals(threadId).then((found) => { if (!found.length) void start(); }).catch(() => void start());
  }, [threadId, start]);

  useEffect(() => {
    if (!link) return;
    const dismiss = () => setLink(undefined);
    addEventListener("pointerdown", dismiss);
    return () => removeEventListener("pointerdown", dismiss);
  }, [link]);

  const activeId = tabs.some((tab) => tab.id === picked) ? picked : (tabs[0]?.id ?? "");

  const openLink = (where: "emma" | "system") => {
    const url = link?.url;
    setLink(undefined);
    if (!url) return;
    if (where === "emma") onOpenInEmma(url);
    else void window.emma.openLink(url).catch((reason: unknown) => setError(reasonText(reason)));
  };

  return <section className="terminal-panel" aria-label="Terminal">
    <header className="terminal-tabs">
      {tabs.map((tab) => <div className="terminal-tab" key={tab.id} data-active={tab.id === activeId} data-ended={!tab.running}>
        <button type="button" onClick={() => setPicked(tab.id)} title={tab.cwd}><TerminalGlyph /><span>{tab.title}</span></button>
        <button type="button" className="terminal-tab-pop" aria-label={`Pop ${tab.title} out`} title="Pop this shell out into a floating window" onClick={() => onPop(tab.id)}>⇱</button>
        <button type="button" className="terminal-tab-close" aria-label={`Close ${tab.title}`} title="Close this shell" onClick={() => void window.emma.closeTerminal(tab.id).catch(() => undefined)}>×</button>
      </div>)}
      <button type="button" className="terminal-add" aria-label="New terminal" title="New terminal" onClick={() => void start()}>+</button>
      <button type="button" className="terminal-hide" aria-label="Hide the terminal" title="Hide the terminal — the shells keep running" onClick={onHide}>×</button>
    </header>
    <div className="terminal-stage">
      {tabs.map((tab) => <TerminalSurface key={tab.id} tab={tab} active={tab.id === activeId} onSelect={onSelect} onLink={setLink} />)}
      {!tabs.length && <p className="terminal-empty">{error || "No shell is running here."}</p>}
    </div>
    {error && tabs.length > 0 && <p className="terminal-error" role="alert">{error}</p>}
    {link && <section className="source-popover terminal-link" role="menu" aria-label="Open this link" style={{ left: `${link.x}px`, bottom: `${innerHeight - link.y + 8}px` }} onPointerDown={(event) => event.stopPropagation()}>
      <span className="terminal-link-url">{link.url}</span>
      <button type="button" role="menuitem" autoFocus onClick={() => openLink("emma")}><strong>Emma's browser</strong><small>The pane beside this thread, where the agent looks too</small></button>
      <button type="button" role="menuitem" onClick={() => openLink("system")}><strong>Default browser</strong><small>Hands it to macOS</small></button>
    </section>}
  </section>;
}
