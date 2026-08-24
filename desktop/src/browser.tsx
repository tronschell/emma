import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserStatus, BrowserTab } from "./types";

const BLANK: BrowserStatus = { running: false, loading: false, canGoBack: false, canGoForward: false, tabs: [] };

function NavIcon({ path, size = 15 }: { path: string; size?: number }) {
  return <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}

const BACK = "M10 3.5 5.5 8l4.5 4.5";
const FORWARD = "M6 3.5 10.5 8 6 12.5";
const RELOAD = "M13.2 6.6A5.4 5.4 0 1 0 13.4 9M13.4 2.8v3.8h-3.8";
const PLUS = "M8 3.4v9.2M3.4 8h9.2";
const CLOSE = "M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6";
const WIDEN = "M9.5 2H14v4.5M14 2l-5.5 5.5M6.5 14H2V9.5M2 14l5.5-5.5";
const HIDE = "M3 8h10";
const MORE = "M8 3.6h.01M8 8h.01M8 12.4h.01";

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

function tabName(tab: BrowserTab): string {
  return tab.title.trim() || host(tab.url) || "New tab";
}

export function BrowserPane({ threadId, onHide, onClose, wide, onToggleWide }: {
  threadId: string;
  onHide: () => void;
  onClose: () => void;
  wide: boolean;
  onToggleWide: () => void;
}) {
  const [known, setKnown] = useState<{ threadId: string; status: BrowserStatus }>();
  const [typed, setTyped] = useState<{ threadId: string; url: string }>();
  const stage = useRef<HTMLDivElement>(null);
  const showing = useRef(threadId);

  useEffect(() => {
    showing.current = threadId;
    let alive = true;
    const read = () => void window.emma.browserStatus(threadId)
      .then((status) => { if (alive) setKnown({ threadId, status }); })
      .catch(() => { if (alive) setKnown({ threadId, status: BLANK }); });
    read();
    const stop = window.emma.onBrowser(read);
    return () => { alive = false; stop(); };
  }, [threadId]);

  const place = useCallback(() => {
    const box = stage.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const blocked = !!document.querySelector("dialog[open]") || rect.width < 1 || rect.height < 1;
    void window.emma.browserPlace({ threadId, bounds: blocked ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }).catch(() => undefined);
  }, [threadId]);

  useEffect(() => {
    const box = stage.current;
    if (!box) return;
    place();
    const observer = new ResizeObserver(place);
    observer.observe(box);
    const dialogs = new MutationObserver(place);
    dialogs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      dialogs.disconnect();
      removeEventListener("resize", place);
      removeEventListener("scroll", place, true);
      void window.emma.browserPlace({ threadId, bounds: null }).catch(() => undefined);
    };
  }, [threadId, place]);

  const status = known?.threadId === threadId ? known.status : BLANK;
  const apply = (next: BrowserStatus) => { if (showing.current === threadId) setKnown({ threadId, status: next }); };
  const nav = (action: "back" | "forward" | "reload") =>
    void window.emma.browserNav({ threadId, action }).then(apply).catch(() => undefined);

  const draft = typed?.threadId === threadId ? typed.url : undefined;
  const go = () => {
    const wanted = (draft ?? "").trim();
    setTyped(undefined);
    if (!wanted) return;
    const url = /^[a-z][a-z0-9+.-]*:/i.test(wanted) ? wanted : `https://${wanted}`;
    void window.emma.browserOpen({ threadId, url }).then(apply).catch(() => undefined);
  };

  return <section className="browser-pane" aria-label="Browser">
    <header className="browser-tabs">
      <div className="browser-tab-strip" role="tablist" aria-label="Browser tabs">
        {status.tabs.map((tab) => <div key={tab.id} className="browser-tab" data-active={tab.id === status.activeTab}>
          <button type="button" role="tab" aria-selected={tab.id === status.activeTab} title={tab.url || tabName(tab)}
            onClick={() => void window.emma.browserSelectTab({ threadId, tabId: tab.id }).then(apply).catch(() => undefined)}>
            {tab.favicon ? <img className="browser-favicon" src={tab.favicon} alt="" /> : <i className="browser-favicon browser-favicon-blank" aria-hidden="true" />}
            <span>{tabName(tab)}</span>
          </button>
          <button type="button" className="browser-tab-close" aria-label={`Close ${tabName(tab)}`}
            onClick={() => void window.emma.browserCloseTab({ threadId, tabId: tab.id }).then(apply).catch(() => undefined)}><NavIcon path={CLOSE} size={11} /></button>
        </div>)}
        <button type="button" className="browser-icon browser-new-tab" aria-label="New tab" title="New tab"
          onClick={() => void window.emma.browserNewTab({ threadId }).then(apply).catch(() => undefined)}><NavIcon path={PLUS} size={13} /></button>
      </div>
      <div className="browser-window-controls">
        <button type="button" className="browser-icon" aria-label={wide ? "Narrow the browser" : "Widen the browser"} aria-pressed={wide} title={wide ? "Narrow" : "Widen"} onClick={onToggleWide}><NavIcon path={WIDEN} size={12} /></button>
        <button type="button" className="browser-icon" aria-label="Hide the browser" title="Hide — keeps the page and its cookies" onClick={onHide}><NavIcon path={HIDE} size={13} /></button>
        <button type="button" className="browser-icon" aria-label="Close the browser" title="Close — frees what it holds" onClick={onClose}><NavIcon path={CLOSE} size={12} /></button>
      </div>
    </header>
    <nav className="browser-bar" aria-label="Page">
      <button type="button" className="browser-icon" aria-label="Back" title="Back" disabled={!status.canGoBack} onClick={() => nav("back")}><NavIcon path={BACK} /></button>
      <button type="button" className="browser-icon" aria-label="Forward" title="Forward" disabled={!status.canGoForward} onClick={() => nav("forward")}><NavIcon path={FORWARD} /></button>
      <button type="button" className="browser-icon" aria-label="Reload" title="Reload" disabled={!status.running} onClick={() => nav("reload")}><NavIcon path={RELOAD} size={13} /></button>
      {draft === undefined
        ? <button type="button" className="browser-address" title={status.url ?? "Open a page"} onClick={() => setTyped({ threadId, url: status.url ?? "" })}>
            {status.loading ? <em className="browser-loading" aria-label="Loading" /> : null}
            <span>{status.url ? host(status.url) : "Open a page"}</span>
          </button>
        : <input className="browser-address browser-address-field" autoFocus aria-label="Address" value={draft} spellCheck={false} autoComplete="off" placeholder="Search or enter address" enterKeyHint="go"
            onChange={(event) => setTyped({ threadId, url: event.target.value })}
            onBlur={() => setTyped(undefined)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); go(); }
              if (event.key === "Escape") setTyped(undefined);
            }} />}
      <button type="button" className="browser-icon" aria-label="Open in a new tab" title="New tab"
        onClick={() => void window.emma.browserNewTab({ threadId }).then(apply).catch(() => undefined)}><NavIcon path={PLUS} size={13} /></button>
      <button type="button" className="browser-icon" aria-label="Open this page in your default browser" title="Open in your browser" disabled={!status.url}
        onClick={() => { if (status.url) void window.emma.openLink(status.url).catch(() => undefined); }}><NavIcon path={MORE} size={14} /></button>
    </nav>
    <div className="browser-stage" ref={stage} data-idle={!status.running}>
      {!status.running && <div className="browser-empty">
        <p>Nothing open</p>
        <button type="button" onClick={() => void window.emma.browserNewTab({ threadId }).then(apply).catch(() => undefined)}>New tab</button>
      </div>}
    </div>
  </section>;
}
