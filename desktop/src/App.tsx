import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { AgentImportSource, ArtifactBlock, KnowledgePage, OpenRouterCatalog, ScreenStroke, Snapshot, Thread } from "./types";
import { activityDays } from "./activity";
import { deriveAgentInsights } from "./agent-insights";
import { canRemoveLocalModel, defaultSettings, migrateQuickActionDestinations, resolveQuickActionDestination, validateSettings, type LocalModelProfile, type UserSettings } from "../shared/settings";
import { defaultPaneLayout, validatePaneLayout, type PaneLayout } from "./layout";
import { hasPersistedPrompt } from "./drafts";
import { brandForImporter, brandForModel, brandForProvider, type BrandDefinition } from "./brands";
import { brandRenderData } from "./brand-data";
import { authorizedScreenContextId } from "../shared/screen-context";

const empty: Snapshot = { threads: [], knowledgeBases: [], pages: [], scheduledJobs: [], warnings: [] };
const SNAPSHOT_REFRESH_MS = 60_000;
const AgentView = lazy(() => import("./AgentView"));
const date = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
const time = (value: string) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));

function Mark() {
  return <span className="mark" aria-hidden="true">◇</span>;
}

function BrandIcon({ brand, className }: { brand?: BrandDefinition; className: string }) {
  const data = brandRenderData(brand);
  return data.src ? <img className={`${className} brand-image`} src={data.src} alt="" aria-hidden="true" /> : <span className={`${className} brand-fallback`} aria-hidden="true">{data.fallback}</span>;
}

const LAYOUT_KEY = "emma.layout.v1";
const IMPORTS_SEEN_KEY = "emma.importsSeen.v1";
const readLayout = () => {
  try { return validatePaneLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null"), window.innerWidth); }
  catch { return defaultPaneLayout; }
};

function ResizeHandle({ label, value, min, max, direction = 1, onChange }: { label: string; value: number; min: number; max: number; direction?: 1 | -1; onChange: (value: number) => void }) {
  const drag = useRef<{ x: number; value: number } | undefined>(undefined);
  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next)));
  const key = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onChange(clamp(value + (event.key === "ArrowRight" ? 8 : -8) * direction));
  };
  return <button type="button" className="resize-handle" role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} onKeyDown={key} onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => { drag.current = { x: event.clientX, value }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (drag.current) onChange(clamp(drag.current.value + (event.clientX - drag.current.x) * direction)); }} onPointerUp={() => { drag.current = undefined; }} />;
}

function App() {
  useEffect(() => {
    const styles: HTMLStyleElement[] = [];
    void window.emma.loadUiPlugins().then((plugins) => {
      for (const plugin of plugins) {
        const style = document.createElement("style");
        style.dataset.emmaPlugin = plugin.id;
        style.textContent = plugin.css;
        document.head.append(style);
        styles.push(style);
      }
    });
    return () => styles.forEach((style) => style.remove());
  }, []);
  const query = new URLSearchParams(location.search);
  if (query.has("annotation")) return <ScreenAnnotation />;
  return query.has("overlay") ? <Overlay /> : <Workspace />;
}

function ScreenAnnotation() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const strokes = useRef<ScreenStroke[]>([]);
  const dimensions = useRef<{ width: number; height: number } | null>(null);
  const [image, setImage] = useState("");
  const [drawn, setDrawn] = useState(false);
  const [error, setError] = useState("");
  const clear = useCallback(() => {
    const target = canvas.current;
    if (!target) return;
    target.getContext("2d")?.clearRect(0, 0, target.width, target.height);
    strokes.current = [];
    setDrawn(false);
  }, []);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") void window.emma.cancelScreenAnnotation(); };
    addEventListener("keydown", cancel);
    void window.emma.getScreenAnnotationFrame().then((frame) => {
      const target = canvas.current;
      if (!target) return;
      target.width = frame.width;
      target.height = frame.height;
      dimensions.current = { width: frame.width, height: frame.height };
      setImage(frame.image);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => removeEventListener("keydown", cancel);
  }, []);
  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * target.width / rect.width, y: (event.clientY - rect.top) * target.height / rect.height, scale: target.width / rect.width };
  };
  const begin = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const context = event.currentTarget.getContext("2d");
    if (!context || !dimensions.current) return;
    const { x, y, scale } = point(event);
    drawing.current = true;
    strokes.current.push([{ x, y }]);
    event.currentTarget.setPointerCapture(event.pointerId);
    context.beginPath(); context.moveTo(x, y);
    context.lineCap = "round"; context.lineJoin = "round"; context.lineWidth = 5 * scale;
    context.strokeStyle = "#ffe84f"; context.shadowColor = "#fff46b"; context.shadowBlur = 14 * scale;
  };
  const draw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const { x, y } = point(event);
    strokes.current.at(-1)?.push({ x, y });
    context.lineTo(x, y); context.stroke();
    setDrawn(true);
  };
  const endStroke = () => {
    drawing.current = false;
    if (strokes.current.at(-1)?.length === 1) strokes.current.pop();
    setDrawn(strokes.current.length > 0);
  };
  const finish = async () => {
    if (!drawn || !strokes.current.length) return;
    try { await window.emma.finishScreenAnnotation(strokes.current); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <main className="screen-annotation"><img src={image} alt="Captured screen" /><canvas ref={canvas} aria-label="Draw yellow screen highlights" onPointerDown={begin} onPointerMove={draw} onPointerUp={endStroke} onPointerCancel={endStroke} /><div className="annotation-toolbar"><div><strong>YELLOW HIGHLIGHT</strong><span>Draw over the screen · Esc cancels</span></div><small>LOCAL PREVIEW · PROVIDER TRANSFER OFF UNTIL CHECKED</small><button type="button" onClick={clear} disabled={!drawn}>Clear</button><button type="button" onClick={() => void window.emma.cancelScreenAnnotation()}>Cancel</button><button type="button" className="annotation-done" onClick={() => void finish()} disabled={!drawn}>Keep locally</button></div>{error && <p className="annotation-error" role="alert">{error}</p>}</main>;
}

function useSnapshot(onLoad?: (snapshot: Snapshot) => void) {
  const [snapshot, setSnapshot] = useState(empty);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const next = await window.emma.request<Snapshot>("snapshot");
      setSnapshot(next);
      onLoad?.(next);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [onLoad]);
  useEffect(() => {
    queueMicrotask(() => void load());
    const listener = window.emma.onChanged(() => void load());
    const refresh = () => void load();
    const refreshVisible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    const interval = window.setInterval(refreshVisible, SNAPSHOT_REFRESH_MS);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      window.emma.offChanged(listener);
    };
  }, [load]);
  return { snapshot, load, error, setError };
}

function Workspace() {
  const [threadId, setThreadId] = useState("");
  const [pageId, setPageId] = useState("");
  const pinSelections = useCallback((next: Snapshot) => {
    setThreadId((current) => next.threads.some((item) => item.id === current) ? current : (next.threads[0]?.id ?? ""));
    setPageId((current) => next.pages.some((item) => item.id === current) ? current : (next.pages[0]?.id ?? ""));
  }, []);
  const { snapshot, load, error, setError } = useSnapshot(pinSelections);
  const [view, setView] = useState<"threads" | "knowledge" | "agent" | "scheduled" | "settings">("threads");
  const [busy, setBusy] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [importsOpen, setImportsOpen] = useState(() => !localStorage.getItem(IMPORTS_SEEN_KEY));
  const [layout, setLayout] = useState<PaneLayout>(readLayout);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("actions");
  const [settings, setSettings] = useState(readSettings);
  const [interactionLocked, setInteractionLocked] = useState(false);
  const actionInFlight = useRef(false);
  const restoredModel = useRef(false);
  const thread = snapshot.threads.find((item) => item.id === threadId) ?? snapshot.threads[0];
  const page = snapshot.pages.find((item) => item.id === pageId) ?? snapshot.pages[0];
  const uiBusy = busy || interactionLocked;
  const modelLabel = useMemo(() => selectedModelLabel(settings), [settings]);
  const modelBrand = useMemo(() => selectedModelBrand(settings), [settings]);
  useEffect(() => { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); }, [layout]);
  useEffect(() => { syncOverlayPreferences(readSettings()); }, []);
  useEffect(() => {
    const reload = () => setSettings(readSettings());
    addEventListener("storage", reload);
    addEventListener("emma-settings-changed", reload);
    return () => { removeEventListener("storage", reload); removeEventListener("emma-settings-changed", reload); };
  }, []);
  useEffect(() => {
    const fit = () => setLayout((current) => validatePaneLayout(current, window.innerWidth));
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, []);
  const pane = (change: Partial<PaneLayout>) => setLayout((current) => validatePaneLayout({ ...current, ...change }, window.innerWidth));
  const shellStyle = {
    "--nav-width": `${layout.navCollapsed ? 46 : layout.navWidth}px`,
    "--list-width": `${layout.listCollapsed ? 30 : layout.listWidth}px`,
    "--inspector-width": `${layout.inspectorCollapsed ? 30 : layout.inspectorWidth}px`,
  } as CSSProperties;

  const act = async (method: string, params: Record<string, string> = {}) => {
    if (actionInFlight.current) { setError("Wait for the current action to finish, then try again."); return undefined; }
    actionInFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await window.emma.request<unknown>(method, params);
      return result;
    } catch (reason) {
      await load();
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    if (restoredModel.current) return;
    restoredModel.current = true;
    if (settings.selectedModel === "fallback") {
      try {
        if ((JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<UserSettings> | null)?.selectedModel !== "fallback") return;
      } catch { return; }
      void window.emma.request("selectFallbackModel").catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      return;
    }
    void (async () => {
      try {
        if (settings.selectedModel.startsWith("local:")) {
          const profile = settings.localModels.find((item) => item.id === settings.selectedModel.slice("local:".length));
          if (!profile) throw new Error("The saved local model profile is missing");
          await window.emma.request("selectLocalModel", { baseUrl: profile.baseUrl, modelId: profile.modelId, credentialEnv: profile.credentialEnv });
          return;
        }
        if (settings.selectedModel.startsWith("openrouter:")) {
          const modelId = settings.selectedModel.slice("openrouter:".length);
          const catalog = await window.emma.request<OpenRouterCatalog>("listOpenRouterModels");
          if (!catalog.models.some((model) => model.id === modelId)) throw new Error("The saved OpenRouter model is no longer in the protected free catalog");
          await window.emma.request("selectOpenRouterModel", { modelId });
          return;
        }
        throw new Error("The saved model selection is invalid");
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        let resetFailure = "";
        await window.emma.request("selectFallbackModel").catch((resetReason) => {
          resetFailure = resetReason instanceof Error ? resetReason.message : String(resetReason);
        });
        setError(`Saved model unavailable; using local fallback. ${message}${resetFailure ? ` Runtime reset failed: ${resetFailure}` : ""}`);
        const next = persistSettings({ ...settings, selectedModel: "fallback" });
        setSettings(next);
      }
    })();
  }, [settings, setError]);

  const createThread = async (sourceIds: string[] = []) => {
    const created = await act("createThread") as Thread | undefined;
    if (!created) return false;
    setThreadId(created.id);
    setView("threads");
    if (sourceIds.length) {
      if (await act("selectThreadKnowledgeBase", { threadId: created.id, knowledgeBaseId: sourceIds[0] }) === undefined) return true;
      if (await act("selectThreadSources", { threadId: created.id, knowledgeBaseIds: JSON.stringify(sourceIds) }) === undefined) return true;
    }
    return true;
  };

  return (
    <div className="app-shell" style={shellStyle}>
      <a className="skip-link" href="#content">Skip to content</a>
      <header className="titlebar">
        <div className="drag-region" />
        <span>EMMA / WORKSPACE</span>
        <span className="live"><i /> HOST CONNECTED</span>
      </header>
      <aside className={`nav-rail ${layout.navCollapsed ? "collapsed" : ""}`} aria-label="Workspace navigation">
        <div className="brand"><Mark /><strong>EMMA</strong><button type="button" className="rail-toggle" aria-label={layout.navCollapsed ? "Expand navigation" : "Collapse navigation"} aria-expanded={!layout.navCollapsed} onClick={() => pane({ navCollapsed: !layout.navCollapsed })}>{layout.navCollapsed ? "›" : "‹"}</button></div>
        <button className="new-thread" title="New thread" onClick={() => { setError(""); setNewThreadOpen(true); }} disabled={uiBusy}><span>＋</span><span className="nav-label">New thread</span></button>
        <nav>
          <button title="Threads" disabled={uiBusy} className={view === "threads" ? "active" : ""} onClick={() => setView("threads")}><span>◫</span><span className="nav-label">Threads</span><b>{snapshot.threads.length}</b></button>
          <button title="Knowledge Base" disabled={uiBusy} className={view === "knowledge" ? "active" : ""} onClick={() => setView("knowledge")}><span>◇</span><span className="nav-label">Knowledge Base</span><b>{snapshot.pages.length}</b></button>
          <button title="Agent" disabled={uiBusy} className={view === "agent" ? "active" : ""} onClick={() => setView("agent")}><span>⌁</span><span className="nav-label">Agent</span><b>60D</b></button>
          <button title="Scheduled" disabled={uiBusy} className={view === "scheduled" ? "active" : ""} onClick={() => setView("scheduled")}><span>◷</span><span className="nav-label">Scheduled</span><b>{snapshot.scheduledJobs.length}</b></button>
          <button title="Settings" disabled={uiBusy} className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}><span>⚙</span><span className="nav-label">Settings</span><b>5</b></button>
        </nav>
        <div className="nav-foot"><span><i /> AGENT ONLINE</span><small>LEFT ⌥ ×2 · QUICK ASK</small></div>
        {!layout.navCollapsed && <ResizeHandle label="Resize navigation" value={layout.navWidth} min={156} max={260} onChange={(navWidth) => pane({ navWidth })} />}
      </aside>
      <aside className={`item-list ${layout.listCollapsed ? "collapsed" : ""}`}>
        <button type="button" className="list-toggle" aria-label={layout.listCollapsed ? "Expand item list" : "Collapse item list"} aria-expanded={!layout.listCollapsed} onClick={() => pane({ listCollapsed: !layout.listCollapsed })}>{layout.listCollapsed ? "›" : "‹"}</button>
        {!layout.listCollapsed && (view === "threads" ? (
          <>
            <ListHeader title="Threads" meta={`${snapshot.threads.length} DURABLE`} />
            <div className="items">
              {snapshot.threads.map((item) => <button key={item.id} disabled={uiBusy} className={item.id === thread?.id ? "selected" : ""} onClick={() => setThreadId(item.id)}><strong>{item.title}</strong><span>{item.messages.at(-1)?.content ?? "Ready for a new idea"}</span><small>{date(item.updatedAt)} · {time(item.updatedAt)}</small></button>)}
              {!snapshot.threads.length && <Empty copy="No threads yet. Start with one clear question." />}
            </div>
          </>
        ) : view === "knowledge" ? (
          <KnowledgeList snapshot={snapshot} selected={page?.id} onSelect={setPageId} act={act} busy={uiBusy} />
        ) : view === "agent" ? <AgentSummary snapshot={snapshot} />
        : view === "scheduled" ? <ScheduledSummary snapshot={snapshot} />
        : <SettingsNavigation page={settingsPage} onSelect={setSettingsPage} busy={uiBusy} />)}
        {!layout.listCollapsed && <ResizeHandle label="Resize item list" value={layout.listWidth} min={190} max={380} onChange={(listWidth) => pane({ listWidth })} />}
      </aside>
      <main id="content" className="content">
        {view === "threads" ? <ThreadView key={thread?.id} thread={thread} snapshot={snapshot} busy={uiBusy} act={act} onSendingChange={setInteractionLocked} openModels={() => { setError(""); setModelsOpen(true); }} modelLabel={modelLabel} modelBrand={modelBrand} layout={layout} pane={pane} /> : view === "knowledge" ? <PageView key={page?.id} page={page} snapshot={snapshot} act={act} busy={uiBusy} /> : view === "agent" ? <Suspense fallback={<AgentLoading />}><AgentView snapshot={snapshot} act={act} busy={uiBusy} /></Suspense> : view === "scheduled" ? <ScheduledView snapshot={snapshot} act={act} busy={uiBusy} /> : <SettingsView snapshot={snapshot} page={settingsPage} act={act} busy={uiBusy} onModelChanged={setSettings} />}
      </main>
      {(error || snapshot.warnings.length > 0) && <div className="notice" role="status"><button aria-label="Dismiss notice" onClick={() => setError("")}>×</button>{error || snapshot.warnings[0]}</div>}
      {modelsOpen && <ModelDialog close={() => setModelsOpen(false)} act={act} workspaceError={error} busy={uiBusy} onSettingsChanged={setSettings} onManage={() => { setModelsOpen(false); setView("settings"); setSettingsPage("models"); }} />}
      {newThreadOpen && <NewThreadDialog bases={snapshot.knowledgeBases} close={() => setNewThreadOpen(false)} create={createThread} error={error} />}
      {importsOpen && <ImportDialog close={() => { localStorage.setItem(IMPORTS_SEEN_KEY, "1"); setImportsOpen(false); }} />}
    </div>
  );
}

function ListHeader({ title, meta }: { title: string; meta: string }) {
  return <header className="list-head"><div><span>WORKSPACE</span><h1>{title}</h1></div><small>{meta}</small></header>;
}

function Empty({ copy }: { copy: string }) {
  return <div className="empty"><Mark /><p>{copy}</p></div>;
}

function AgentLoading() {
  return <div className="content-empty" role="status" aria-live="polite"><Mark /><p>Loading local Agent charts…</p></div>;
}

function AgentSummary({ snapshot }: { snapshot: Snapshot }) {
  const insights = deriveAgentInsights(snapshot);
  return <><ListHeader title="Agent" meta="LOCAL EVIDENCE" /><div className="agent-summary"><span>LEARNING WINDOW</span><strong>Last {insights.window.days} days</strong><p>{snapshot.pages.length} durable pages available; {insights.domains.reduce((sum, item) => sum + item.count, 0)} recent site signals.</p></div><div className="items insight-items">{insights.domains.slice(0, 5).map((item) => <div className="insight-item" key={item.domain}><strong>{item.domain}</strong><span>{item.count} collected page{item.count === 1 ? "" : "s"}</span></div>)}{!insights.domains.length && <Empty copy="Save web-backed knowledge and Emma will surface transparent patterns here." />}</div></>;
}

function ScheduledSummary({ snapshot }: { snapshot: Snapshot }) {
  return <><ListHeader title="Scheduled" meta={`${snapshot.scheduledJobs.length} APPROVED`} /><div className="items scheduled-items">{snapshot.scheduledJobs.map((job) => <div className="insight-item" key={job.id}><strong>{job.title}</strong><span>{job.schedule} · {job.enabled ? "enabled" : "paused"}</span></div>)}{!snapshot.scheduledJobs.length && <Empty copy="No recurring jobs. Emma only creates one after you approve a proposal." />}</div></>;
}

function ScheduledView({ snapshot, act, busy }: { snapshot: Snapshot; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean }) {
  return <section className="scheduled-view"><header><span>SCHEDULED / USER APPROVED</span><h2>Recurring jobs</h2><p>Each due run opens an ordinary durable thread; knowledge saving remains explicit. Pause or resume any job here.</p></header><div className="job-list">{snapshot.scheduledJobs.map((job) => <article key={job.id}><header><div><span>{job.enabled ? "ENABLED" : "PAUSED"}</span><h3>{job.title}</h3></div><label className="job-toggle"><input type="checkbox" checked={job.enabled} disabled={busy} onChange={(event) => void act("setScheduledJobEnabled", { jobId: job.id, enabled: String(event.target.checked) })} /><span>{job.enabled ? "On" : "Off"}</span></label></header><dl><div><dt>CRON · UTC</dt><dd>{job.schedule}</dd></div><div><dt>NEXT RUN</dt><dd>{date(job.nextRunAt)} · {time(job.nextRunAt)}</dd></div><div><dt>LAST RUN</dt><dd>{job.lastRunAt ? `${date(job.lastRunAt)} · ${time(job.lastRunAt)}` : "Not yet"}</dd></div><div><dt>SOURCES</dt><dd>{job.sourceDomains.join(", ") || "No domain restriction"}</dd></div></dl><p>{job.prompt}</p></article>)}{!snapshot.scheduledJobs.length && <Empty copy="Nothing is scheduled. Review Agent proposals and explicitly approve the ones you want." />}</div></section>;
}

function Activity({ snapshot }: { snapshot: Snapshot }) {
  const scroll = useRef<HTMLDivElement>(null);
  const timestamps = [...snapshot.threads.flatMap((thread) => thread.messages.map((message) => message.timestamp)), ...snapshot.pages.flatMap((page) => [page.addedAt, page.analyzedAt])];
  const days = activityDays(timestamps);
  useEffect(() => { if (scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth; }, [days.length]);
  const active = days.filter((day) => day.count).length;
  return <section className="activity" aria-label="Durable activity"><header><span>ACTIVITY</span><b>{active} ACTIVE DAYS</b></header><div className="activity-scroll" ref={scroll}><div className="heatmap">{days.map((day) => <span key={day.date} className={`heat heat-${Math.min(day.count, 4)}`} title={`${day.date}: ${day.count} durable events`} />)}</div></div><footer><span><b>{snapshot.threads.reduce((sum, thread) => sum + thread.messages.length, 0)}</b> MESSAGES</span><span><b>{snapshot.pages.length}</b> PAGES</span><span><b>{snapshot.pages.length}</b> ANALYZED</span></footer></section>;
}

function CategoryEditor({ baseId, categories, act, busy }: { baseId: string; categories: string[]; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean }) {
  const [value, setValue] = useState("");
  return <details><summary>Manage</summary><div className="category-pop"><form onSubmit={(event) => { event.preventDefault(); if (!busy && value.trim()) void act("addKnowledgeBaseCategory", { knowledgeBaseId: baseId, category: value.trim().toLowerCase().replace(/\s+/g, "-") }).then((result) => { if (result !== undefined) setValue(""); }); }}><input value={value} disabled={busy} onChange={(event) => setValue(event.target.value)} placeholder="research" aria-label="New category" /><button disabled={busy}>Add</button></form>{categories.map((item) => <button key={item} disabled={busy} onClick={() => void act("removeKnowledgeBaseCategory", { knowledgeBaseId: baseId, category: item })}>{item} ×</button>)}</div></details>;
}

function KnowledgeList({ snapshot, selected, onSelect, act, busy }: { snapshot: Snapshot; selected?: string; onSelect: (id: string) => void; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean }) {
  const [baseId, setBaseId] = useState("all");
  const [category, setCategory] = useState("all");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const basePages = baseId === "all" ? snapshot.pages : snapshot.pages.filter((page) => page.knowledgeBaseId === baseId);
  const pages = category === "all" ? basePages : basePages.filter((page) => page.category === category);
  const base = snapshot.knowledgeBases.find((item) => item.id === baseId);
  const categories = [...new Set([...basePages.map((page) => page.category), ...(base?.categories ?? [])])].sort();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !name.trim()) return;
    if (await act("createKnowledgeBase", { name: name.trim() }) === undefined) return;
    setName("");
    setCreating(false);
  };
  return <>
    <ListHeader title="Knowledge" meta={`${snapshot.knowledgeBases.length} BASES`} />
    <Activity snapshot={snapshot} />
    <div className="base-toolbar">
      <label><span className="sr-only">Knowledge base</span><select value={baseId} onChange={(event) => setBaseId(event.target.value)}><option value="all">All knowledge</option>{snapshot.knowledgeBases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}</select></label>
      <button aria-label="Create knowledge base" title="Create knowledge base" onClick={() => setCreating(!creating)}>＋</button>
    </div>
    <div className="category-toolbar"><select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filter category"><option value="all">All categories</option>{categories.map((item) => <option key={item}>{item}</option>)}</select>{base && <CategoryEditor baseId={base.id} categories={base.categories} act={act} busy={busy} />}</div>
    {creating && <form className="inline-form" onSubmit={(event) => void submit(event)}><input autoFocus value={name} maxLength={128} onChange={(event) => setName(event.target.value)} placeholder="Base name" aria-label="New knowledge base name" /><button disabled={busy}>Create</button></form>}
    <div className="items knowledge-items">
      {pages.map((item) => <button key={item.id} disabled={busy} className={item.id === selected ? "selected" : ""} onClick={() => onSelect(item.id)}><span className="category">{item.category}</span><strong>{item.title}</strong><span>{item.analysis.summary}</span><small>ANALYZED {date(item.analyzedAt).toUpperCase()}</small></button>)}
      {!pages.length && <Empty copy="Explicitly save a thread analysis and it will appear here." />}
    </div>
  </>;
}

type PaneProps = { layout: PaneLayout; pane: (change: Partial<PaneLayout>) => void };

function SourceChecks({ thread, snapshot, act, busy }: { thread: Thread; snapshot: Snapshot; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean }) {
  const select = (baseId: string, checked: boolean) => {
    if (busy) return;
    const ids = checked ? [...thread.sourceKnowledgeBaseIds, baseId] : thread.sourceKnowledgeBaseIds.filter((id) => id !== baseId);
    void act("selectThreadSources", { threadId: thread.id, knowledgeBaseIds: JSON.stringify([...new Set([thread.knowledgeBaseId, ...ids])]) });
  };
  return <div className="source-checks">{snapshot.knowledgeBases.map((base) => <label key={base.id}><input type="checkbox" checked={thread.sourceKnowledgeBaseIds.includes(base.id)} disabled={busy || base.id === thread.knowledgeBaseId} onChange={(event) => select(base.id, event.target.checked)} />{base.name}{base.id === thread.knowledgeBaseId && <small>destination</small>}</label>)}</div>;
}

function ThreadView({ thread, snapshot, busy, act, onSendingChange, openModels, modelLabel, modelBrand, layout, pane }: { thread?: Thread; snapshot: Snapshot; busy: boolean; act: (method: string, params?: Record<string, string>) => Promise<unknown>; onSendingChange: (busy: boolean) => void; openModels: () => void; modelLabel: string; modelBrand?: BrandDefinition } & PaneProps) {
  const [message, setMessage] = useState("");
  const [newBase, setNewBase] = useState("");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const sourceTrigger = useRef<HTMLButtonElement>(null);
  const closeSources = () => { setSourcesOpen(false); queueMicrotask(() => sourceTrigger.current?.focus()); };
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [thread?.messages.length]);
  if (!thread) return <div className="content-empty"><Mark /><h2>Start a durable thread</h2><p>Normal agent work stays here until you explicitly save it to knowledge.</p></div>;
  const locked = busy || sending;
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || sendingRef.current) return;
    const content = message.trim();
    if (!content) return;
    sendingRef.current = true;
    setSending(true);
    onSendingChange(true);
    const previousMessageCount = thread.messages.length;
    setMessage("");
    try {
      const result = await act("sendMessage", { threadId: thread.id, content });
      if (result === undefined) {
        const latest = await window.emma.request<Snapshot>("snapshot").catch(() => undefined);
        if (!latest || !hasPersistedPrompt(latest, thread.id, previousMessageCount, content)) setMessage(content);
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
      onSendingChange(false);
    }
  };
  const createBase = async (event: FormEvent) => {
    event.preventDefault();
    if (locked || !newBase.trim()) return;
    const base = await act("createKnowledgeBase", { name: newBase.trim() }) as { id: string } | undefined;
    if (!base) return;
    setNewBase("");
    await act("selectThreadKnowledgeBase", { threadId: thread.id, knowledgeBaseId: base.id });
  };
  return <div className="thread-layout">
    <section className="conversation" aria-label={`Thread: ${thread.title}`}>
      <header className="content-head"><div><span>THREAD / {thread.id.slice(-8).toUpperCase()}</span><h2>{thread.title}</h2></div><div className="thread-actions"><button className="agent-button" onClick={() => setAgentOpen(true)}>⌁ AGENT</button><button className="model-button" disabled={locked} onClick={openModels} aria-label={`Select model, currently ${modelLabel}`}><BrandIcon brand={modelBrand} className="model-brand" /><span className="model-label">{modelLabel}</span><span aria-hidden="true">⌄</span></button></div></header>
      <div className="transcript">
        {!thread.messages.length && <div className="welcome"><Mark /><h3>What are we working on?</h3><p>Ask Emma to research, plan, write, or think. Nothing enters knowledge unless you choose it.</p></div>}
        {thread.messages.map((item, index) => <article className={`message ${item.role}`} key={`${item.timestamp}-${index}`}><header><span>{item.role === "user" ? "YOU" : "EMMA"}</span><time dateTime={item.timestamp}>{time(item.timestamp)}</time></header><p>{item.content}</p>{item.generation && <footer className="generation-rate" title={`${item.generation.outputTokens} output tokens in ${item.generation.durationMilliseconds} ms`}>{(item.generation.outputTokens / item.generation.durationMilliseconds * 1000).toFixed(1)} TOKENS/S</footer>}</article>)}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={(event) => void send(event)}><label className="sr-only" htmlFor="message">Message Emma</label><textarea id="message" value={message} disabled={locked} maxLength={65_536} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Ask Emma to continue…" rows={2} /><div><div className="composer-tools"><button ref={sourceTrigger} type="button" className="source-trigger" disabled={locked} aria-label="Add context or plugin" aria-haspopup="dialog" aria-expanded={sourcesOpen} onClick={() => sourcesOpen ? closeSources() : setSourcesOpen(true)}>＋</button><button type="button" className="model-button composer-model" disabled={locked} onClick={openModels} aria-label={`Select model, currently ${modelLabel}`}><BrandIcon brand={modelBrand} className="model-brand" /><span className="model-label">{modelLabel}</span><span aria-hidden="true">⌄</span></button><span>↵ SEND · ⇧↵ NEW LINE</span></div><button disabled={locked || !message.trim()} aria-label="Send message">↑</button></div>{sourcesOpen && <section className="source-popover add-menu" role="dialog" aria-modal="false" aria-labelledby="source-popover-title" tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") closeSources(); }}><header><h3 id="source-popover-title">Add</h3><button autoFocus type="button" aria-label="Close add menu" onClick={closeSources}>×</button></header><div className="add-row"><b>◇</b><div><strong>Knowledge bases</strong><small>Attach one or more read-only sources to this thread</small></div></div><div className="add-sources"><SourceChecks thread={thread} snapshot={snapshot} act={act} busy={locked} /></div><span className="add-section">Built-in plugins</span><button type="button" className="add-row" onClick={() => { closeSources(); setAgentOpen(true); }}><b>⌁</b><div><strong>Agent sidecar</strong><small>Inspect Emma's Zig runtime and headless entry point</small></div></button><div className="add-row muted"><b>⌥</b><div><strong>Draw on screen</strong><small>Double-tap left Option, then choose the yellow pen</small></div></div><div className="add-row muted"><b>＋</b><div><strong>More actions come from plugins</strong><small>Imported skills and MCPs appear here after permission review</small></div></div></section>}</form>
    </section>
    <aside className={`inspector ${layout.inspectorCollapsed ? "collapsed" : ""}`}>
      {!layout.inspectorCollapsed && <ResizeHandle label="Resize thread inspector" value={layout.inspectorWidth} min={210} max={360} direction={-1} onChange={(inspectorWidth) => pane({ inspectorWidth })} />}
      <button type="button" className="inspector-toggle" aria-label={layout.inspectorCollapsed ? "Expand thread inspector" : "Collapse thread inspector"} aria-expanded={!layout.inspectorCollapsed} onClick={() => pane({ inspectorCollapsed: !layout.inspectorCollapsed })}>{layout.inspectorCollapsed ? "‹" : "›"}</button>
      {!layout.inspectorCollapsed && <div className="inspector-body"><header><span>THREAD CONTEXT</span><button onClick={() => void act("saveToKnowledge", { threadId: thread.id })} disabled={locked || !thread.messages.some((item) => item.role === "assistant")}>Save & analyze</button></header>
      <section><label>DESTINATION BASE<select value={thread.knowledgeBaseId} disabled={locked} onChange={(event) => void act("selectThreadKnowledgeBase", { threadId: thread.id, knowledgeBaseId: event.target.value })}>{snapshot.knowledgeBases.map((base) => <option value={base.id} key={base.id}>{base.name}</option>)}</select></label><p>Explicit Save & analyze writes here; retrieval spans the sources below.</p></section>
      <section><span>SOURCE KNOWLEDGE</span><SourceChecks thread={thread} snapshot={snapshot} act={act} busy={locked} /><p>Sources are read-only during normal turns. Retrieval is bounded across all selected bases.</p></section>
      <section><span>CREATE FROM THIS THREAD</span><form className="stack-form" onSubmit={(event) => void createBase(event)}><input value={newBase} disabled={locked} maxLength={128} onChange={(event) => setNewBase(event.target.value)} placeholder="New base name" aria-label="New base name" /><button disabled={locked || !newBase.trim()}>Create & use</button></form></section>
      <section className="principle"><Mark /><p><strong>Nothing saves silently.</strong> A normal request remains a thread. Knowledge creation is always explicit.</p></section></div>}
    </aside>{agentOpen && <AgentDialog thread={thread} close={() => setAgentOpen(false)} />}
  </div>;
}

function AgentDialog({ thread, close }: { thread: Thread; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  const dismiss = () => dialog.current?.close();
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="agent-title" onClose={close} onCancel={(event) => { event.preventDefault(); dismiss(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}><section className="agent-dialog"><header><div><span>THREAD AGENT</span><h2 id="agent-title">Zig sidecar</h2></div><button type="button" onClick={dismiss} aria-label="Close agent details">×</button></header><dl><div><dt>Thread</dt><dd>{thread.id}</dd></div><div><dt>Runtime</dt><dd><i /> emma-agent · NDJSON</dd></div><div><dt>Context</dt><dd>{thread.messages.length} durable messages · {thread.sourceKnowledgeBaseIds.length} source bases</dd></div><div><dt>Tools</dt><dd>Lazy MCP search; schemas load only after selection</dd></div></dl><div className="agent-cli"><span>HEADLESS ENTRY POINT</span><code>./agent/zig-out/bin/emma-agent</code><p>Run coding or automation threads without Electron. See agent/README.md for exact requests.</p></div></section></dialog>;
}

function PageView(props: { page?: KnowledgePage; snapshot: Snapshot; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean }) {
  return props.page ? <PageEditor page={props.page} snapshot={props.snapshot} act={props.act} busy={props.busy} /> : <div className="content-empty"><Mark /><h2>Knowledge with provenance</h2><p>Create a base or save an analyzed thread to begin.</p></div>;
}

type JsonObject = Record<string, unknown>;

function objectPayload(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function externalArtifactUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function RichArtifact({ markdown }: { markdown: string }) {
  const paragraphs = markdown.split(/\n{2,}/).filter(Boolean);
  return <div className="artifact-rich">{paragraphs.length ? paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>) : <p>{markdown}</p>}</div>;
}

function ChartArtifact({ labels, values }: { labels: string[]; values: number[] }) {
  const safeValues = values.map((value) => Number.isFinite(value) && value >= 0 ? value : 0);
  const maximum = Math.max(1, ...safeValues);
  return <div className="artifact-chart"><svg viewBox="0 0 360 126" role="img" aria-label="Artifact data chart"><line x1="18" y1="104" x2="350" y2="104" /><g>{safeValues.slice(0, 8).map((value, index) => { const x = 28 + index * 48; const height = value / maximum * 76; return <g key={index}><rect x={x} y={104 - height} width="24" height={height} rx="2" /><text x={x + 12} y="119" textAnchor="middle">{labels[index] ?? `Item ${index + 1}`}</text><text x={x + 12} y={98 - height} textAnchor="middle">{value}</text></g>; })}</g></svg></div>;
}

function ArtifactBlockView({ block }: { block: ArtifactBlock }) {
  const payload = objectPayload(block.payload);
  if (block.type === "rich-text" || block.type === "markdown") return <RichArtifact markdown={textValue(payload.markdown) || block.fallback} />;
  if (block.type === "list" || block.type === "bullets") {
    const items = textList(payload.items);
    const List = payload.ordered === true ? "ol" : "ul";
    return items.length ? <List>{items.map((item, index) => <li key={index}>{item}</li>)}</List> : <pre className="artifact-fallback">{block.fallback}</pre>;
  }
  if (block.type === "citations") {
    const items = Array.isArray(payload.items) ? payload.items : [];
    return items.length ? <ul className="artifact-citations">{items.map((item, index) => { const citation = objectPayload(item); const url = externalArtifactUrl(citation.url); return <li key={index}>{url ? <a href={url} target="_blank" rel="noreferrer">{textValue(citation.title) || url} ↗</a> : <span>{textValue(citation.title) || block.fallback}</span>}</li>; })}</ul> : <pre className="artifact-fallback">{block.fallback}</pre>;
  }
  if (block.type === "table") {
    const headers = textList(payload.headers);
    const rows = Array.isArray(payload.rows) ? payload.rows.filter(Array.isArray).map((row) => textList(row)) : [];
    return headers.length ? <div className="artifact-table"><table><thead><tr>{headers.map((header, index) => <th key={index}>{header}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_header, columnIndex) => <td key={columnIndex}>{row[columnIndex] ?? ""}</td>)}</tr>)}</tbody></table></div> : <pre className="artifact-fallback">{block.fallback}</pre>;
  }
  if (block.type === "chart" || block.type === "data") {
    const labels = textList(payload.labels);
    const values = Array.isArray(payload.values) ? payload.values.filter((value): value is number => typeof value === "number") : [];
    return labels.length && values.length ? <ChartArtifact labels={labels} values={values} /> : <pre className="artifact-fallback">{block.fallback}</pre>;
  }
  return <div className="artifact-unknown"><small>UNSUPPORTED BLOCK · {block.type} v{block.version}</small><pre>{block.fallback}</pre></div>;
}

function editableArtifact(block: ArtifactBlock, value: string): ArtifactBlock {
  if (block.type === "rich-text" || block.type === "markdown") {
    return { ...block, fallback: value, payload: { ...objectPayload(block.payload), markdown: value } };
  }
  if (block.type === "list" || block.type === "bullets") {
    const items = value.split("\n").map((item) => item.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
    return { ...block, fallback: value, payload: { ...objectPayload(block.payload), items, ordered: objectPayload(block.payload).ordered === true } };
  }
  return { ...block, fallback: value };
}

function ArtifactEditor({ blocks, setBlocks, busy }: { blocks: ArtifactBlock[]; setBlocks: (blocks: ArtifactBlock[]) => void; busy: boolean }) {
  const update = (index: number, block: ArtifactBlock) => setBlocks(blocks.map((item, itemIndex) => itemIndex === index ? block : item));
  const move = (index: number, delta: number) => { const next = index + delta; if (next < 0 || next >= blocks.length) return; const reordered = [...blocks]; [reordered[index], reordered[next]] = [reordered[next], reordered[index]]; setBlocks(reordered); };
  return <div className="artifact-editor">{blocks.map((block, index) => <fieldset key={block.id}><legend>{block.id} · {block.type} v{block.version}</legend><label>PORTABLE FALLBACK<textarea value={block.fallback} maxLength={65_536} disabled={busy} onChange={(event) => update(index, editableArtifact(block, event.target.value))} /></label>{(block.type === "rich-text" || block.type === "markdown" || block.type === "list" || block.type === "bullets") ? <small className="artifact-edit-help">Editing this fallback updates its declarative payload. Other blocks keep their structured payload and use this text as their export fallback.</small> : <small className="artifact-edit-help">Structured payload is preserved; this text is the portable export fallback.</small>}<div className="artifact-order"><button type="button" disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label={`Move ${block.id} up`}>↑</button><button type="button" disabled={busy || index === blocks.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${block.id} down`}>↓</button></div></fieldset>)}</div>;
}

function artifactMarkdown(blocks: ArtifactBlock[], id: string, fallback: string): string {
  const block = blocks.find((item) => item.id === id);
  const markdown = block ? textValue(objectPayload(block.payload).markdown) : "";
  return markdown || fallback;
}

function PageEditor({ page, snapshot, act, busy }: { page: KnowledgePage; snapshot: Snapshot; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean }) {
  const base = snapshot.knowledgeBases.find((item) => item.id === page.knowledgeBaseId);
  const [title, setTitle] = useState(page.title);
  const [category, setCategory] = useState(page.category);
  const [blocks, setBlocks] = useState(page.artifacts ?? []);
  const [editing, setEditing] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const info = useRef<HTMLDivElement>(null);
  const infoTrigger = useRef<HTMLButtonElement>(null);
  const closeInfo = useCallback(() => { setInfoOpen(false); queueMicrotask(() => infoTrigger.current?.focus()); }, [setInfoOpen]);
  useEffect(() => {
    if (!infoOpen) return;
    info.current?.focus();
    const outside = (event: PointerEvent) => { if (!info.current?.parentElement?.contains(event.target as Node)) closeInfo(); };
    addEventListener("pointerdown", outside);
    return () => removeEventListener("pointerdown", outside);
  }, [closeInfo, infoOpen]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (await act("updatePageDocument", { pageId: page.id, title: title.trim(), category: category.trim(), summary: artifactMarkdown(blocks, "summary", page.analysis.summary), body: artifactMarkdown(blocks, "body", page.analysis.body), artifacts: JSON.stringify(blocks) }) !== undefined) setEditing(false);
  };
  return <form className="page page-editor" onSubmit={(event) => void save(event)}><header className="page-head"><div className="page-eyebrow"><span>{base?.name.toUpperCase()} / ARTIFACT DOCUMENT</span><button ref={infoTrigger} type="button" className="page-info-button" aria-label="Show page details" aria-haspopup="dialog" aria-expanded={infoOpen} onClick={() => infoOpen ? closeInfo() : setInfoOpen(true)}>i</button>{infoOpen && <div className="page-info" role="dialog" aria-label="Page details" tabIndex={-1} ref={info} onKeyDown={(event) => { if (event.key === "Escape") closeInfo(); }}><header><span>PAGE DETAILS</span><button type="button" aria-label="Close page details" onClick={closeInfo}>×</button></header><dl><div><dt>Added</dt><dd>{date(page.addedAt)} · {time(page.addedAt)}</dd></div><div><dt>Analyzed</dt><dd>{date(page.analyzedAt)} · {time(page.analyzedAt)}</dd></div><div><dt>Model</dt><dd><i />{page.telemetry.model}</dd></div><div><dt>Tokens</dt><dd>{(page.telemetry.inputTokens + page.telemetry.outputTokens).toLocaleString()} total <small>{page.telemetry.inputTokens.toLocaleString()} in · {page.telemetry.outputTokens.toLocaleString()} out</small></dd></div><div><dt>Subagents</dt><dd>{page.telemetry.subagentCount}</dd></div>{page.sourceThreadId && <div><dt>Source thread</dt><dd><code>{page.sourceThreadId}</code></dd></div>}</dl></div>}</div><label><span className="sr-only">Page title</span><textarea className="page-title" value={title} disabled={busy} maxLength={256} rows={2} onChange={(event) => setTitle(event.target.value)} /></label><div className="page-category"><label>CATEGORY<input value={category} disabled={busy} maxLength={64} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" onChange={(event) => setCategory(event.target.value)} /></label><button type="button" disabled={busy} onClick={() => setEditing(!editing)}>{editing ? "Preview document" : "Edit & reorder"}</button>{editing && <button disabled={busy || !title.trim() || !category.trim()}>Save document</button>}</div>{!editing && <p className="page-summary">{artifactMarkdown(blocks, "summary", page.analysis.summary)}</p>}</header><div className="page-body"><div className="artifact-heading"><span>ORDERED BLOCKS</span><small>{blocks.length} / 64 · explicit save only</small></div>{editing ? <ArtifactEditor blocks={blocks} setBlocks={setBlocks} busy={busy} /> : <div className="artifact-document">{blocks.map((block) => <article className="artifact-block" key={block.id}><header><span>{block.type.toUpperCase()} · v{block.version}</span><small>{block.id}</small></header><ArtifactBlockView block={block} /></article>)}</div>}</div></form>;
}

function NewThreadDialog({ bases, close, create, error }: { bases: Snapshot["knowledgeBases"]; close: () => void; create: (ids: string[]) => Promise<boolean>; error: string }) {
  const [ids, setIds] = useState(bases.slice(0, 1).map((base) => base.id));
  const [submitting, setSubmitting] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  const dismiss = () => dialog.current?.close();
  const submit = async () => { setSubmitting(true); if (await create(ids)) dismiss(); else setSubmitting(false); };
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="new-thread-title" onClose={close} onCancel={(event) => { event.preventDefault(); if (!submitting) dismiss(); }} onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) dismiss(); }}><section className="new-thread-dialog"><header><div><span>NEW DURABLE THREAD</span><h2 id="new-thread-title">Choose source knowledge</h2></div><button type="button" onClick={dismiss} disabled={submitting} aria-label="Close new thread dialog">×</button></header><p>Select one or more bases. The first remains the initial save destination.</p>{error && <p className="dialog-error" role="alert">{error}</p>}<div className="dialog-checks">{bases.map((base) => <label key={base.id}><input type="checkbox" disabled={submitting} checked={ids.includes(base.id)} onChange={(event) => setIds(event.target.checked ? [...ids, base.id] : ids.filter((id) => id !== base.id))} />{base.name}</label>)}</div><button type="button" className="dialog-primary" onClick={() => void submit()} disabled={!ids.length || submitting}>{submitting ? "Creating…" : "Create thread"}</button></section></dialog>;
}

const SETTINGS_KEY = "emma.settings.v1";
function readSettings(): UserSettings {
  try { return validateSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null")); } catch { return structuredClone(defaultSettings); }
}

function persistSettings(settings: UserSettings): UserSettings {
  const valid = validateSettings(settings);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(valid));
  dispatchEvent(new Event("emma-settings-changed"));
  return valid;
}

function selectedModelLabel(settings: UserSettings): string {
  if (settings.selectedModel === "fallback") return "LOCAL FALLBACK";
  if (settings.selectedModel.startsWith("openrouter:")) return settings.selectedModel.slice("openrouter:".length).split("/").at(-1) ?? "OPENROUTER";
  if (settings.selectedModel.startsWith("local:")) return settings.localModels.find((profile) => profile.id === settings.selectedModel.slice("local:".length))?.name ?? "LOCAL MODEL";
  return "MODEL";
}

function selectedModelBrand(settings: UserSettings): BrandDefinition | undefined {
  if (settings.selectedModel.startsWith("openrouter:")) return brandForModel(settings.selectedModel.slice("openrouter:".length), "openrouter");
  if (settings.selectedModel.startsWith("local:")) {
    const profile = settings.localModels.find((item) => item.id === settings.selectedModel.slice("local:".length));
    return profile ? brandForModel(profile.modelId, "local") : undefined;
  }
  return undefined;
}

function syncOverlayPreferences(settings: UserSettings) {
  window.emma.setOverlayPreferences({ overlayPlacement: settings.overlayPlacement, notchGap: settings.notchGap });
}

type SettingsPage = "actions" | "models" | "imports" | "privacy" | "about";
const settingsPages: { id: SettingsPage; label: string; copy: string }[] = [
  { id: "actions", label: "Quick actions", copy: "Three overlay shortcuts" },
  { id: "models", label: "Models & voice", copy: "Local provider seams" },
  { id: "imports", label: "Imports & plugins", copy: "Skills and MCP sources" },
  { id: "privacy", label: "Privacy", copy: "Data boundaries" },
  { id: "about", label: "About Emma", copy: "Build and architecture" },
];

const providerMarks = [
  ["openai", "OpenAI", "US"], ["anthropic", "Anthropic", "US"], ["gemini", "Gemini", "US"], ["xai", "xAI", "US"],
  ["openrouter", "OpenRouter", "ROUTER"], ["meta", "Meta", "US"], ["mistral", "Mistral", "EU"], ["cohere", "Cohere", "CA"], ["qwen", "Qwen", "CN"],
  ["deepseek", "DeepSeek", "CN"], ["kimi", "Kimi", "CN"], ["glm", "Z.ai / GLM", "CN"], ["minimax", "MiniMax", "CN"],
  ["ernie", "ERNIE", "CN"], ["hunyuan", "Hunyuan", "CN"], ["naver", "HyperCLOVA", "KR"], ["sakana", "Sakana AI", "JP"],
] as const;

function ProviderMarks() {
  return <section className="provider-marks"><header><div><span>PROVIDER PLUGINS</span><h3>OpenAI-compatible routing</h3></div><small>LOCAL ASSETS · TRADEMARKS BELONG TO THEIR OWNERS</small></header><div>{providerMarks.map(([id, name, region]) => <span key={id}><BrandIcon brand={brandForProvider(id)} className={`provider-mark ${id}`} /><strong>{name}</strong><small>{region}</small></span>)}</div></section>;
}

function SettingsNavigation({ page, onSelect, busy }: { page: SettingsPage; onSelect: (page: SettingsPage) => void; busy: boolean }) {
  return <><ListHeader title="Settings" meta="LOCAL FIRST" /><nav className="settings-nav" aria-label="Settings sections">{settingsPages.map((item) => <button key={item.id} disabled={busy} className={page === item.id ? "selected" : ""} onClick={() => onSelect(item.id)}><strong>{item.label}</strong><span>{item.copy}</span></button>)}</nav></>;
}

function SettingsView({ snapshot, page, act, busy, onModelChanged }: { snapshot: Snapshot; page: SettingsPage; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean; onModelChanged: (settings: UserSettings) => void }) {
  const [settings, setSettings] = useState(readSettings);
  const [saved, setSaved] = useState(false);
  const updateAction = (index: number, field: string, value: string | boolean) => setSettings((current) => ({ ...current, quickActions: current.quickActions.map((action, actionIndex) => actionIndex === index ? { ...action, [field]: value } : action) as UserSettings["quickActions"] }));
  const save = (event: FormEvent) => { event.preventDefault(); try { const valid = persistSettings(migrateQuickActionDestinations(settings, snapshot.knowledgeBases)); setSettings(valid); syncOverlayPreferences(valid); onModelChanged(valid); setSaved(true); } catch { setSaved(false); } };
  const saveModelSettings = (next: UserSettings) => { const valid = persistSettings(next); setSettings(valid); onModelChanged(valid); };
  if (page === "models") return <section className="settings-view"><header><span>SETTINGS / LOCAL PROVIDERS</span><h2>Models & voice</h2><p>Emma keeps model routing explicit. OpenRouter free models are privacy-protected; local profiles stay on this Mac and use the existing credential environment convention.</p></header><LocalModelSettings settings={settings} onChange={saveModelSettings} act={act} busy={busy} /><div className="settings-lines"><section><div><span>AGENT FALLBACK</span><h3>Local deterministic profile</h3><p>Without a selected provider, Emma uses its deterministic local fallback. Configure an environment-backed provider with `EMMA_PROVIDER_*` only when you need a remote OpenAI-compatible route.</p></div><strong className="status-live"><i /> AVAILABLE</strong></section><section><div><span>VOICE / LOCAL ONLY</span><h3>OpenAI-compatible transcription</h3><p>The seam targets local Whisper or Parakeet-style `/v1/audio/transcriptions` servers. Microphone transport is disabled in this build because its sandbox approval boundary is not authorized; no audio is captured or uploaded.</p></div><div className="voice-values"><label>ENDPOINT<input disabled value={settings.transcriptionEndpoint} aria-label="Local transcription endpoint" readOnly /></label><label>MODEL<input disabled value={settings.transcriptionModel} aria-label="Transcription model" readOnly /></label><small>DEFAULT OFF · LOCALHOST ONLY</small></div></section></div><ProviderMarks /></section>;
  if (page === "imports") return <section className="settings-view"><header><span>SETTINGS / EXTENSIONS</span><h2>Imports & plugins</h2><p>Register skills and MCP configuration from other agents' default folders. Emma records paths only; it never copies or renders config secrets.</p></header><AgentImports /></section>;
  if (page === "privacy") return <section className="settings-view"><header><span>SETTINGS / DATA BOUNDARIES</span><h2>Privacy</h2><p>Clear boundaries for durable files, provider traffic, and explicit knowledge creation.</p></header><div className="settings-lines prose-lines"><section><div><span>DURABLE STORAGE</span><h3>Threads and knowledge stay local</h3><p>Emma stores durable Markdown through the Rust host. Pane layout, quick-action preferences, and an unsent overlay draft stay in Electron’s local application storage.</p></div></section><section><div><span>SCREEN MARKUP</span><h3>Annotated screens remain local</h3><p>The yellow pen captures and compresses a screen image locally. Provider transfer stays disabled until you explicitly authorize sending full-screen images to the selected model endpoint.</p></div></section><section><div><span>OPENROUTER</span><h3>Protected routing remains enforced</h3><p>Selected-model turns request no provider data collection and zero retention. OpenRouter account-level logging and product-improvement settings still apply.</p><a href="https://openrouter.ai/settings/privacy" target="_blank" rel="noreferrer">Review OpenRouter privacy settings ↗</a></div></section><section><div><span>KNOWLEDGE</span><h3>Nothing saves silently</h3><p>Normal agent requests remain in their thread. Creating or updating knowledge always requires an explicit user action or a quick action configured to save.</p></div></section></div></section>;
  if (page === "about") return <section className="settings-view"><header><span>SETTINGS / ABOUT</span><h2>Emma</h2><p>A local-first macOS workspace for durable threads and analyzed knowledge.</p></header><div className="settings-lines prose-lines"><section><div><span>DESKTOP</span><h3>Electron + React</h3><p>The sandboxed renderer uses a narrow preload API. Electron owns native windows and a bundled macOS listener owns the Quick Ask gesture.</p></div></section><section><div><span>DURABLE CORE</span><h3>Rust + Markdown</h3><p>The Rust host reuses emma-core for thread, knowledge, and provenance rules; Zig remains the agent sidecar.</p></div></section></div></section>;
  return <form className="settings-view" onSubmit={save}><header><span>SETTINGS / LOCAL TO THIS MAC</span><h2>Quick actions</h2><p>Double-tap the left Option key to open Quick Ask; macOS Accessibility access is required. Each of its three shortcuts runs an ordinary durable request, and knowledge saving stays explicit per action.</p></header><section className="notch-settings"><div><span>NOTCH PLACEMENT</span><h3>Choose the compact surface shape</h3><p>Electron cannot read the camera housing bounds. Split mode reserves a calibrated center gap beside it; adjust the gap to your Mac.</p></div><div className="notch-values"><label>PLACEMENT<select value={settings.overlayPlacement} onChange={(event) => setSettings((current) => ({ ...current, overlayPlacement: event.target.value as UserSettings["overlayPlacement"] }))}><option value="below">Directly below notch</option><option value="rails">Split left / right rails</option></select></label><label>NOTCH GAP · 120–260 PT<input type="number" min={120} max={260} step={2} value={settings.notchGap} onChange={(event) => setSettings((current) => ({ ...current, notchGap: event.currentTarget.valueAsNumber }))} /></label></div></section><div className="quick-settings">{settings.quickActions.map((action, index) => <section className="quick-action-row" key={index}><div className="shortcut"><kbd>⌘{index + 1}</kbd><span>OVERLAY ACTION</span></div><div className="quick-fields"><label>LABEL<input value={action.label} maxLength={40} onChange={(event) => updateAction(index, "label", event.target.value)} /></label><label className="prompt-field">PROMPT<textarea value={action.prompt} maxLength={4096} rows={2} onChange={(event) => updateAction(index, "prompt", event.target.value)} /></label><label>DESTINATION<select value={resolveQuickActionDestination(action.destinationKnowledgeBaseId, snapshot.knowledgeBases) ?? ""} onChange={(event) => updateAction(index, "destinationKnowledgeBaseId", event.target.value)}><option value="">Default</option>{snapshot.knowledgeBases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}</select></label><label>CATEGORY<input value={action.category} placeholder="optional" onChange={(event) => updateAction(index, "category", event.target.value)} /></label><label className="check"><input type="checkbox" checked={action.saveToKnowledge} onChange={(event) => updateAction(index, "saveToKnowledge", event.target.checked)} /> Save analyzed result</label></div></section>)}</div><button className="save-settings">{saved ? "Saved ✓" : "Save settings"}</button></form>;
}

function LocalModelSettings({ settings, onChange, act, busy }: { settings: UserSettings; onChange: (settings: UserSettings) => void; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean }) {
  const [draft, setDraft] = useState({ name: "", modelId: "", baseUrl: "http://127.0.0.1:1234/v1", credentialEnv: "" });
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const update = (field: keyof typeof draft, value: string) => setDraft((current) => ({ ...current, [field]: value }));
  const add = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setStatus("");
    try {
      const profile: LocalModelProfile = { id: `local-${Date.now().toString(36)}`, ...draft };
      const next = validateSettings({ ...settings, localModels: [...settings.localModels, profile] });
      onChange(next);
      setDraft({ name: "", modelId: "", baseUrl: "http://127.0.0.1:1234/v1", credentialEnv: "" });
      setStatus(`${profile.name} added. Choose Use to route the next turn.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const select = async (profile: LocalModelProfile) => {
    setError("");
    const result = await act("selectLocalModel", { baseUrl: profile.baseUrl, modelId: profile.modelId, credentialEnv: profile.credentialEnv });
    if (result === undefined) return;
    onChange({ ...settings, selectedModel: `local:${profile.id}` });
    setStatus(`${profile.name} is active for new turns.`);
  };
  const remove = (profile: LocalModelProfile) => { if (canRemoveLocalModel(settings, profile.id)) onChange({ ...settings, localModels: settings.localModels.filter((item) => item.id !== profile.id) }); };
  return <section className="local-model-settings"><header><div><span>LOCAL OPENAI-COMPATIBLE MODELS</span><h3>Import a local profile</h3><p>Store a friendly name, model ID, loopback `/v1` endpoint, and optionally the environment variable that holds its credential. Emma never stores the secret.</p></div><strong>LOCAL ONLY</strong></header><form className="local-model-form" onSubmit={add}><label>NAME<input required maxLength={64} value={draft.name} onChange={(event) => update("name", event.target.value)} placeholder="Qwen local" /></label><label>MODEL ID<input required maxLength={128} value={draft.modelId} onChange={(event) => update("modelId", event.target.value)} placeholder="qwen3:8b" /></label><label>BASE URL<input required maxLength={2048} value={draft.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="http://127.0.0.1:1234/v1" /></label><label>CREDENTIAL ENV<input maxLength={128} value={draft.credentialEnv} onChange={(event) => update("credentialEnv", event.target.value)} placeholder="Optional · LOCAL_API_KEY" /></label><button disabled={busy}>Add local model</button></form>{(error || status) && <p className={error ? "local-model-error" : "local-model-status"} role="status">{error || status}</p>}<div className="local-model-list">{settings.localModels.map((profile) => <div className={`local-model-row ${settings.selectedModel === `local:${profile.id}` ? "selected" : ""}`} key={profile.id}><div><BrandIcon brand={brandForModel(profile.modelId, "local")} className="local-model-brand" /><div><strong>{profile.name}</strong><span>{profile.modelId} · {profile.baseUrl}</span><small>{profile.credentialEnv || "NO CREDENTIAL · LOOPBACK ONLY"}</small></div></div><div><button type="button" disabled={busy} onClick={() => void select(profile)}>{settings.selectedModel === `local:${profile.id}` ? "Active" : "Use"}</button><button type="button" disabled={busy || !canRemoveLocalModel(settings, profile.id)} title={settings.selectedModel === `local:${profile.id}` ? "Select another model before removing the active profile" : "Remove local profile"} onClick={() => remove(profile)}>Remove</button></div></div>)}{!settings.localModels.length && <p className="local-model-empty">No local profiles yet.</p>}</div></section>;
}

function AgentImports({ done }: { done?: () => void }) {
  const [sources, setSources] = useState<AgentImportSource[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState("");
  useEffect(() => {
    void window.emma.discoverAgentImports().then((items) => {
      setSources(items);
      setSelected(items.filter((item) => item.skills || item.mcpConfigs).map((item) => item.id));
    }).catch((reason) => setStatus(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false));
  }, []);
  const submit = async () => {
    setBusy(true); setStatus("");
    try {
      const imported = await window.emma.importAgentSources(selected);
      setStatus(`${imported.length} agent source${imported.length === 1 ? "" : "s"} registered`);
      done?.();
    } catch (reason) { setStatus(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <div className="import-sources"><div className="import-list">{sources.map((source) => { const available = source.skills > 0 || source.mcpConfigs > 0; return <label key={source.id} className={available ? "" : "unavailable"}><input type="checkbox" disabled={!available || busy} checked={selected.includes(source.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, source.id] : selected.filter((id) => id !== source.id))} /><BrandIcon brand={brandForImporter(source.id)} className={`integration-mark ${source.id}`} /><div><strong>{source.label}</strong><small>{available ? `${source.skills} skills · ${source.mcpConfigs} MCP configs` : "Nothing found in default locations"}</small>{source.locations.length > 0 && <code>{source.locations.join(" · ")}</code>}</div></label>; })}</div><footer><p>Imports are references, not copies. Skill instructions and MCP servers remain inactive until a thread or plugin explicitly selects them.</p><button type="button" onClick={() => void submit()} disabled={busy || !selected.length}>{busy ? "Scanning…" : "Import selected"}</button></footer>{status && <p className="import-status" role="status">{status}</p>}</div>;
}

function ImportDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="import-title" onCancel={(event) => { event.preventDefault(); close(); }}><section className="import-dialog"><header><div><span>FIRST LAUNCH / OPTIONAL</span><h2 id="import-title">Bring your agent setup</h2><p>Emma can find Codex, Claude, Antigravity, Pi, OpenCode, Cursor, Windsurf, and Devin defaults on this Mac.</p></div><button type="button" onClick={close} aria-label="Skip agent imports">×</button></header><AgentImports done={close} /><button className="import-later" type="button" onClick={close}>Not now</button></section></dialog>;
}

function ModelDialog({ close, act, workspaceError, busy, onSettingsChanged, onManage }: { close: () => void; act: (method: string, params?: Record<string, string>) => Promise<unknown>; workspaceError: string; busy: boolean; onSettingsChanged: (settings: UserSettings) => void; onManage: () => void }) {
  const [catalog, setCatalog] = useState<OpenRouterCatalog>();
  const [settings, setSettings] = useState(readSettings);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  const dismiss = () => dialog.current?.close();
  const load = async () => {
    try { setCatalog(await window.emma.request<OpenRouterCatalog>("listOpenRouterModels")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const selectOpenRouter = async (modelId: string) => {
    if (busy || await act("selectOpenRouterModel", { modelId }) === undefined) return;
    const next = persistSettings({ ...settings, selectedModel: `openrouter:${modelId}` });
    setSettings(next);
    onSettingsChanged(next);
    dismiss();
  };
  const selectLocal = async (profile: LocalModelProfile) => {
    if (busy || await act("selectLocalModel", { baseUrl: profile.baseUrl, modelId: profile.modelId, credentialEnv: profile.credentialEnv }) === undefined) return;
    const next = persistSettings({ ...settings, selectedModel: `local:${profile.id}` });
    setSettings(next);
    onSettingsChanged(next);
    dismiss();
  };
  const selectFallback = async () => {
    if (busy || await act("selectFallbackModel") === undefined) return;
    const next = persistSettings({ ...settings, selectedModel: "fallback" });
    setSettings(next);
    onSettingsChanged(next);
    dismiss();
  };
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="model-title" onClose={close} onCancel={(event) => { event.preventDefault(); dismiss(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}><section className="model-dialog"><header><div><span>MODEL ROUTING</span><h2 id="model-title">Choose a model</h2></div><button type="button" onClick={dismiss} aria-label="Close model dialog">×</button></header><button type="button" className={`local-profile model-profile-button ${settings.selectedModel === "fallback" ? "selected" : ""}`} disabled={busy} onClick={() => void selectFallback()}><i /><div><strong>Deterministic local fallback</strong><p>No provider request; useful for private drafts and offline routing.</p></div><span>{settings.selectedModel === "fallback" ? "ACTIVE" : "READY"}</span></button>{settings.localModels.length > 0 && <><span className="model-section-label">SAVED LOCAL PROFILES</span><div className="model-list local-model-options">{settings.localModels.map((profile) => <button type="button" key={profile.id} disabled={busy} className={settings.selectedModel === `local:${profile.id}` ? "selected" : ""} onClick={() => void selectLocal(profile)}><BrandIcon brand={brandForModel(profile.modelId, "local")} className="model-brand" /><span><strong>{profile.name}</strong><small>{profile.modelId} · {profile.baseUrl}</small></span><em>{settings.selectedModel === `local:${profile.id}` ? "ACTIVE" : "LOCAL"}</em></button>)}</div></>}<button type="button" className="manage-models" onClick={onManage}>Manage local profiles in Settings ↗</button><div className="policy-warning"><strong>OpenRouter data policy</strong><p>Emma requests no provider data collection and zero retention on every selected-model turn. Your OpenRouter account logging and product-improvement settings still apply.</p><a href="https://openrouter.ai/settings/privacy" target="_blank" rel="noreferrer">Review provider settings ↗</a></div><button type="button" className="load-models" disabled={busy} onClick={() => void load()}>Load live free + tool-capable models</button>{(error || workspaceError) && <p className="dialog-error" role="alert">{error || workspaceError}</p>}<span className="model-section-label">OPENROUTER / FREE + TOOL-CAPABLE</span><div className="model-list">{catalog?.models.map((model) => <button type="button" key={model.id} disabled={busy} className={settings.selectedModel === `openrouter:${model.id}` ? "selected" : ""} onClick={() => void selectOpenRouter(model.id)}><BrandIcon brand={brandForModel(model.id, "openrouter")} className="model-brand" /><span><strong>{model.name}</strong><small>{model.id}</small></span><em>{settings.selectedModel === `openrouter:${model.id}` ? "ACTIVE" : `${Math.round(model.contextLength / 1000)}K CTX`}</em></button>)}{catalog && !catalog.models.length && <p className="model-empty">No free tool-capable models were returned.</p>}</div></section></dialog>;
}

const OVERLAY_DRAFT_KEY = "emma.overlayDraft.v1";

function Overlay() {
  const { snapshot, load, error, setError } = useSnapshot();
  const [message, setMessage] = useState(() => localStorage.getItem(OVERLAY_DRAFT_KEY) ?? "");
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(readSettings);
  const [annotationId, setAnnotationId] = useState("");
  const [attachAnnotation, setAttachAnnotation] = useState(false);
  const thread = snapshot.threads[0];
  const recent = useMemo(() => thread?.messages.at(-1), [thread]);
  const screenContextId = authorizedScreenContextId(annotationId, attachAnnotation);
  useEffect(() => {
    if (message) localStorage.setItem(OVERLAY_DRAFT_KEY, message);
    else localStorage.removeItem(OVERLAY_DRAFT_KEY);
  }, [message]);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const content = message.trim();
    if (!content) return;
    localStorage.removeItem(OVERLAY_DRAFT_KEY);
    setMessage("");
    window.emma.setOverlayBusy(true);
    setBusy(true); setError("");
    let active = thread;
    const previousMessageCount = active?.messages.length ?? 0;
    const usedAnnotation = Boolean(annotationId && attachAnnotation);
    try {
      active ??= await window.emma.request<Thread>("createThread");
      await window.emma.request("sendMessage", { threadId: active.id, content, ...(screenContextId ? { screenContextId } : {}) });
      if (usedAnnotation) { setAnnotationId(""); setAttachAnnotation(false); }
      await load();
    } catch (reason) {
      const latest = await window.emma.request<Snapshot>("snapshot").catch(() => undefined);
      if (!active || !latest || !hasPersistedPrompt(latest, active.id, previousMessageCount, content)) {
        localStorage.setItem(OVERLAY_DRAFT_KEY, content);
        setMessage(content);
      }
      await load();
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      window.emma.setOverlayBusy(false);
      setBusy(false);
    }
  };
  const runAction = useCallback(async (index: number) => {
    const action = settings.quickActions[index];
    if (!action || busy) return;
    window.emma.setOverlayBusy(true);
    setBusy(true); setError("");
    const usedAnnotation = Boolean(annotationId && attachAnnotation);
    try {
      const created = await window.emma.request<Thread>("createThread");
      const destination = resolveQuickActionDestination(action.destinationKnowledgeBaseId, snapshot.knowledgeBases) || snapshot.knowledgeBases[0]?.id || "default";
      await window.emma.request("selectThreadKnowledgeBase", { threadId: created.id, knowledgeBaseId: destination });
      await window.emma.request("selectThreadSources", { threadId: created.id, knowledgeBaseIds: JSON.stringify([destination]) });
      await window.emma.request("sendMessage", { threadId: created.id, content: action.prompt, ...(screenContextId ? { screenContextId } : {}) });
      if (usedAnnotation) { setAnnotationId(""); setAttachAnnotation(false); }
      if (action.saveToKnowledge) {
        const page = await window.emma.request<KnowledgePage>("saveToKnowledge", { threadId: created.id });
        if (action.category) {
          await window.emma.request("addKnowledgeBaseCategory", { knowledgeBaseId: destination, category: action.category });
          await window.emma.request("updatePage", { pageId: page.id, title: page.title, category: action.category, summary: page.analysis.summary, body: page.analysis.body });
        }
      }
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { window.emma.setOverlayBusy(false); setBusy(false); }
  }, [annotationId, attachAnnotation, busy, load, screenContextId, setError, settings, snapshot.knowledgeBases]);
  useEffect(() => { const listener = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && /^[123]$/.test(event.key)) { event.preventDefault(); void runAction(Number(event.key) - 1); } }; addEventListener("keydown", listener); return () => removeEventListener("keydown", listener); }, [runAction]);
  useEffect(() => { const reload = () => setSettings(readSettings()); addEventListener("storage", reload); addEventListener("focus", reload); return () => { removeEventListener("storage", reload); removeEventListener("focus", reload); }; }, []);
  useEffect(() => {
    const refresh = () => void window.emma.screenAnnotationStatus().then((status) => {
      const next = status?.id ?? "";
      setAnnotationId((current) => { if (current !== next) setAttachAnnotation(false); return next; });
    }).catch(() => { setAnnotationId(""); setAttachAnnotation(false); });
    refresh(); addEventListener("focus", refresh); return () => removeEventListener("focus", refresh);
  }, []);
  useEffect(() => {
    if (settings.overlayPlacement !== "rails") { window.emma.setOverlayMousePassthrough(false); return; }
    let passthrough = false;
    const move = (event: PointerEvent) => {
      const edge = (innerWidth - settings.notchGap) / 2;
      const next = event.clientX > edge && event.clientX < edge + settings.notchGap;
      if (next !== passthrough) { passthrough = next; window.emma.setOverlayMousePassthrough(next); }
    };
    addEventListener("pointermove", move);
    return () => { removeEventListener("pointermove", move); window.emma.setOverlayMousePassthrough(false); };
  }, [settings.notchGap, settings.overlayPlacement]);
  const overlayStyle = { "--notch-gap": `${settings.notchGap}px` } as CSSProperties;
  const startDrawing = async () => { try { await window.emma.startScreenAnnotation(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const clearDrawing = async () => { if (!annotationId) return; await window.emma.clearScreenAnnotation(annotationId); setAnnotationId(""); setAttachAnnotation(false); };
  return <main className="overlay" data-placement={settings.overlayPlacement} style={overlayStyle} role="dialog" aria-label="Emma quick thread"><div className="notch-glow" aria-hidden="true" /><header><div className="brand"><Mark /><strong>EMMA</strong></div><span><i /> QUICK THREAD</span></header><div className="quick-strip">{settings.quickActions.map((action, index) => <button key={index} onClick={() => void runAction(index)} disabled={busy}><kbd>⌘{index + 1}</kbd>{action.label}</button>)}</div>{recent && <p className="overlay-recent"><b>{recent.role === "assistant" ? "Emma" : "You"}:</b> {recent.content}</p>}{annotationId && <div className="annotation-chip"><label><input type="checkbox" checked={attachAnnotation} onChange={(event) => setAttachAnnotation(event.currentTarget.checked)} /> SEND FULL VISIBLE SCREEN TO SELECTED MODEL ENDPOINT ON NEXT ASK</label><button type="button" onClick={() => void clearDrawing()} aria-label="Discard screen markup">×</button></div>}<form onSubmit={(event) => void send(event)}><label className="sr-only" htmlFor="quick-message">Ask Emma</label><textarea autoFocus disabled={busy} id="quick-message" value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Ask Emma anything…" rows={2} /><div><span>NORMAL THREAD · NOTHING SAVED TO KB</span><div className="overlay-actions"><button type="button" onClick={() => void startDrawing()} disabled={busy} title="Draw yellow highlights over the screen" aria-label="Draw on screen">✎</button><button type="button" disabled title="Local voice transport is disabled in this build" aria-label="Voice input unavailable">●</button><button disabled={busy || !message.trim()}>{busy ? "···" : "↑"}</button></div></div></form>{error && <button className="overlay-error" onClick={() => setError("")}>{error} ×</button>}</main>;
}

export default App;
