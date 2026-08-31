
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cacheHitRate, cacheWriteTokens, CONTEXT_METRICS, CONTEXT_WIDGETS, costLabel, costPerTask, DEFAULT_METRICS, MAX_CONTEXT_PAGES, MAX_PAGE_NAME, nextPageId, widgetDefinition, type ContextMetric, type ContextPage, type ContextWidget, type ContextWidgetType, type WidgetOrientation } from "../shared/context-bar";
import { charLabel, CHARS_PER_TOKEN, shareLabel, usageKey, type ContextUse } from "../shared/usage";
import { agentColor, type LiveAgent } from "../shared/agents";
import type { Plan } from "../shared/plan";
import type { TaskList } from "../shared/task-list";
import type { GitSnapshot } from "../shared/git";
import { countCalls, decodeSpans, type TraceSpan } from "../shared/trace";
import type { Message, Thread } from "./types";
import { buildLedger, NO_BREAKDOWN, NO_EXPERIMENTS, segmentItems, SEGMENT_NOTES, type ContextBreakdown, type ExperimentTally, type Ledger, type SegmentItem, type SegmentSource } from "./context";
import { plural } from "./plural";
import { since, threadLabel } from "./threads";
import { brandForModel } from "./brands";
import { BrandIcon, CaretIcon, ExpandIcon } from "./icons";
import { GitPanel } from "./git";
import { MachineGraph, MachineMeters, MachineStats } from "./machine";
import { PlanRail } from "./plan";
import { TaskListRail } from "./task-list";
import { Timeline } from "./timeline";

const tokenLabel = (chars: number): string => charLabel(Math.round(chars / CHARS_PER_TOKEN));
const LEGEND_COLLAPSED = 3;
const KIND_NAMES: Record<ContextUse["kind"], string> = { messages: "Messages", system: "System prompt", tools: "System tools", mcp: "MCP tools", skills: "Skills", memory: "Memory files" };

export function useContextLedger(thread: Thread | undefined, uses: ContextUse[], contextTokens: number, inFlight: LiveAgent[], experiments: ExperimentTally = NO_EXPERIMENTS, landedCalls = 0, breakdown: ContextBreakdown = NO_BREAKDOWN): Ledger {
  return useMemo(() => buildLedger(thread, uses, contextTokens, inFlight, experiments, landedCalls, breakdown), [thread, uses, contextTokens, inFlight, experiments, landedCalls, breakdown]);
}

export function useThreadCalls(threadId: string | undefined, sending: boolean): number {
  const [counted, setCounted] = useState<{ threadId: string; calls: number }>();
  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    const take = (calls: number) => { if (alive) setCounted({ threadId, calls }); };
    void window.emma.threadTraces(threadId)
      .then((traces) => take(traces.reduce((sum, trace) => sum + countCalls(decodeSpans(trace.text)), 0)))
      .catch(() => take(0));
    return () => { alive = false; };
  }, [threadId, sending]);
  return counted && counted.threadId === threadId ? counted.calls : 0;
}

function experimentLabel({ savedTokens, addedTokens }: ExperimentTally): string {
  const net = savedTokens - addedTokens;
  return `${net >= 0 ? "−" : "+"}${charLabel(Math.abs(net))} net · ${charLabel(savedTokens)} saved, ${charLabel(addedTokens)} added`;
}

const experimentTitle = ({ savedTokens, addedTokens, prunedResults, reinjections }: ExperimentTally) =>
  `Pruning blanked ${prunedResults} tool ${plural(prunedResults, "result")}, taking about ${savedTokens.toLocaleString()} tokens out of the requests this thread has sent. The prompt was repeated ${reinjections} ${plural(reinjections, "time")}, putting about ${addedTokens.toLocaleString()} back in.`;

function CurveIcon() {
  return <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 13.5V10M6 13.5V7.5M10 13.5V9M14 13.5V4.5" /></svg>;
}

function metricCell(id: ContextMetric, ledger: Ledger, context: WidgetContext): { value: string; label: string } {
  const { messages, replies, attachments, calls, tokens, elapsed, total, capacity, free, whole, largest, experiments } = ledger;
  switch (id) {
    case "messages": return { value: `${messages}`, label: plural(messages, "message") };
    case "replies": return { value: `${replies}`, label: `Emma ${plural(replies, "reply", "replies")}` };
    case "attachments": return { value: `${attachments}`, label: plural(attachments, "attachment") };
    case "calls": return { value: `${calls}`, label: `tool ${plural(calls, "call")}` };
    case "rate": return { value: elapsed ? `${Math.round(tokens / elapsed * 1000)}` : "—", label: "avg tok/s" };
    case "output": return { value: tokens ? charLabel(tokens) : "—", label: `output ${plural(tokens, "token")}` };
    case "cache": {
      const rate = cacheHitRate(context.messages.flatMap((message) => message.generation ? [message.generation] : []));
      return { value: rate === undefined ? "—" : `${Math.round(rate * 100)}%`, label: "cache hit rate" };
    }
    case "cacheWrites": {
      const writes = cacheWriteTokens(context.messages.flatMap((message) => message.generation ? [message.generation] : []));
      return { value: writes === undefined ? "—" : charLabel(writes), label: "cache writes" };
    }
    case "cost": {
      const cost = costPerTask(context.messages.flatMap((message) => message.generation ? [message.generation] : []));
      return { value: costLabel(cost), label: "cost/task" };
    }
    case "elapsed": return { value: elapsed ? `${Math.round(elapsed / 1000)}s` : "—", label: "generating" };
    case "context": return { value: total ? tokenLabel(total) : "—", label: "context carried" };
    case "window": return { value: capacity ? tokenLabel(capacity) : "—", label: "context window" };
    case "free": return { value: capacity ? tokenLabel(free) : "—", label: "free tokens" };
    case "share": return { value: capacity ? shareLabel(total, whole) : "—", label: "context used" };
    case "largest": return { value: largest ? tokenLabel(largest.chars) : "—", label: largest ? largest.label : "largest segment" };
    case "subagents": return { value: `${context.subagents.length}`, label: plural(context.subagents.length, "subagent") };
    case "subthreads": return { value: `${context.subthreads.length}`, label: `sub ${plural(context.subthreads.length, "thread")}` };
    case "saved": return { value: experiments.savedTokens ? charLabel(experiments.savedTokens) : "—", label: "tokens pruned" };
    case "added": return { value: experiments.addedTokens ? charLabel(experiments.addedTokens) : "—", label: "tokens reinjected" };
    case "pruned": return { value: `${experiments.prunedResults}`, label: `pruned ${plural(experiments.prunedResults, "result")}` };
    default: return { value: `${experiments.reinjections}`, label: plural(experiments.reinjections, "reinjection") };
  }
}

function ContextStats({ widget, context }: { widget: ContextWidget; context: WidgetContext }) {
  const [curveOpen, setCurveOpen] = useState(false);
  const { ledger } = context;
  const { curve } = ledger;
  const peak = Math.max(...curve.map((point) => point.rate), 1);
  return <section className="context-stats" data-orientation={widget.orientation}>
    <div className="agent-metrics">
      {(widget.metrics ?? DEFAULT_METRICS).map((id) => {
        const { value, label } = metricCell(id, ledger, context);
        return <span key={id} className={id === "rate" ? "metric-rate" : undefined}>
          <b>{value}</b> {label}
          {id === "rate" && <button type="button" className="rate-toggle" aria-expanded={curveOpen} aria-controls="rate-curve" aria-label="Tokens a second by context size" title="Tokens a second by context size" onClick={() => setCurveOpen((open) => !open)}><CurveIcon /></button>}
        </span>;
      })}
    </div>
    {curveOpen && <div className="rate-curve" id="rate-curve">
      {curve.length ? <ol>
        {curve.map((point) => <li key={point.context} title={`${point.turns} ${plural(point.turns, "reply", "replies")} sent with ${charLabel(point.context)}–${charLabel(point.context * 2)} tokens of input`}>
          <span>{point.context / 1024}K</span><i data-empty={point.turns === 0 || undefined} style={{ width: `${point.rate / peak * 100}%` }} /><b>{point.turns ? Math.round(point.rate) : "—"}</b>
        </li>)}
      </ol> : <p>No timed replies yet.</p>}
    </div>}
  </section>;
}

function ContextLedger({ ledger, messages: history, threadId, orientation }: { ledger: Ledger; messages: Message[]; threadId: string; orientation: WidgetOrientation }) {
  const { rows, cells, kinds, total, capacity, free, whole, largest, messages, replies, attachments, calls, tokens, elapsed, experiments } = ledger;
  const rewritten = experiments.prunedResults > 0 || experiments.reinjections > 0;
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [drilled, setDrilled] = useState<string>();
  const shown = showAll ? rows : rows.slice(0, LEGEND_COLLAPSED);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (expanded && !dialog.current?.open) dialog.current?.showModal(); }, [expanded]);
  const dismiss = () => dialog.current?.close();
  const grid = cells.length > 0 && <div className="context-grid" aria-hidden="true">{cells.map((key, index) => <i key={index} data-kind={kinds.get(key)} />)}</div>;
  return <section className="context-usage" data-orientation={orientation}>
    <span title={capacity ? "" : "This model states no context window, so the rows are shares of what this thread sent, not of a window"}><span className="context-title">{capacity ? "Context window" : "Context used"}<button type="button" className="context-expand" aria-haspopup="dialog" aria-label="Expand the context ledger" title="Expand the context ledger" onClick={() => setExpanded(true)}><ExpandIcon /></button></span><b>{tokenLabel(total)}{capacity ? ` / ${tokenLabel(capacity)}` : ""} {plural(Math.round(total / CHARS_PER_TOKEN), "token")}{capacity ? ` (${shareLabel(total, whole)})` : " sent · no stated window"}</b></span>
    {grid}
    <ul className="context-legend">
      {shown.map((row) => <li key={usageKey(row)} data-kind={row.kind} title={`${KIND_NAMES[row.kind]} · ${row.label} · ${row.chars.toLocaleString()} chars · ${row.turns} ${plural(row.turns, "turn")}`}>
        <i /><span>{row.label}</span><b>{tokenLabel(row.chars)}</b><em>{shareLabel(row.chars, whole)}</em>
      </li>)}
      {rows.length > LEGEND_COLLAPSED && <li className="context-more">
        <button type="button" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? "Less" : `${rows.length - LEGEND_COLLAPSED} more`}</button>
      </li>}
      {showAll && capacity > 0 && <li data-kind="free" title={`${free.toLocaleString()} of ${capacity.toLocaleString()} characters left before this model's window is full`}>
        <i /><span>Free space</span><b>{tokenLabel(free)}</b><em>{shareLabel(free, whole)}</em>
      </li>}
    </ul>
    {rewritten && <p className="context-experiments" title={experimentTitle(experiments)}>Experiments · {experimentLabel(experiments)}</p>}
    {expanded && <dialog ref={dialog} className="modal-backdrop" aria-labelledby="ledger-title" onClose={() => setExpanded(false)} onCancel={(event) => { event.preventDefault(); dismiss(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
      <section className="agent-dialog context-dialog">
        <header><div><span>{capacity ? `${tokenLabel(capacity)}-token window` : "No stated window"}</span><h2 id="ledger-title">Context ledger</h2></div><button type="button" onClick={dismiss} aria-label="Close context ledger">×</button></header>
        <div className="context-summary">
          <p className="context-hero">
            <b>{tokenLabel(total)}</b>
            <span>{capacity ? `of ${tokenLabel(capacity)} tokens carried` : `tokens carried · no stated window`}</span>
            {capacity > 0 && <em>{shareLabel(total, whole)} used</em>}
            <small>{total.toLocaleString()} characters measured on this computer</small>
          </p>
          {grid}
          <dl>
            {capacity > 0 && <div><dt>Free space</dt><dd>{tokenLabel(free)}<small>tokens · {shareLabel(free, whole)}</small></dd></div>}
            {largest && <div><dt>Largest</dt><dd>{shareLabel(largest.chars, whole)}<small title={largest.label}>{largest.label}</small></dd></div>}
            <div><dt>Messages</dt><dd>{messages}<small>{replies} {plural(replies, "reply", "replies")}</small></dd></div>
            <div><dt>Tool calls</dt><dd>{calls}<small>this thread</small></dd></div>
            <div><dt>Attachments</dt><dd>{attachments}<small>{attachments === 1 ? "item" : "items"} pinned in</small></dd></div>
            <div><dt>Output</dt><dd>{tokens ? charLabel(tokens) : "—"}<small>tokens · {elapsed ? Math.round(tokens / elapsed * 1000) : "—"} tok/s</small></dd></div>
            {rewritten && <div><dt>Experiments</dt><dd title={experimentTitle(experiments)}>{experimentLabel(experiments)}<small>harness levers</small></dd></div>}
          </dl>
        </div>
        <div className="context-usage context-dialog-rows">
          <table className="context-table">
            <thead><tr><th>Segment</th><th>Kind</th><th>Chars</th><th>Tokens</th><th>Share</th><th>Turns</th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const key = usageKey(row);
                const open = drilled === key;
                return <Fragment key={key}>
                  <tr data-kind={row.kind} data-open={open || undefined}>
                    <th scope="row"><button type="button" className="context-drill" aria-expanded={open} onClick={() => setDrilled(open ? undefined : key)}><i />{row.label}<CaretIcon /></button></th>
                    <td>{KIND_NAMES[row.kind]}</td>
                    <td>{row.chars.toLocaleString()}</td>
                    <td>{tokenLabel(row.chars)}</td>
                    <td>{shareLabel(row.chars, whole)}</td>
                    <td>{row.turns}</td>
                  </tr>
                  {open && <tr className="context-detail"><td colSpan={6}><SegmentPanel key={key} source={row.source} messages={history} threadId={threadId} /></td></tr>}
                </Fragment>;
              })}
              {capacity > 0 && <tr data-kind="free">
                <th scope="row"><span className="context-drill" aria-disabled="true"><i />Free space</span></th><td>Unclaimed</td><td>{free.toLocaleString()}</td><td>{tokenLabel(free)}</td><td>{shareLabel(free, whole)}</td><td>—</td>
              </tr>}
            </tbody>
          </table>
        </div>
        <p>The total is the provider's own count for the last request it read. How that total splits across the rows is estimated: each segment is measured in characters on this computer and divided by {CHARS_PER_TOKEN}, and whatever the split does not reach lands in the last row.</p>
      </section>
    </dialog>}
  </section>;
}

function SegmentPanel({ source, messages, threadId }: { source: SegmentSource; messages: Message[]; threadId: string }) {
  const [items, setItems] = useState<SegmentItem[]>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void segmentItems(source, messages, threadId)
      .then((found) => { if (alive) setItems(found); })
      .catch(() => { if (alive) { setItems([]); setFailed(true); } });
    return () => { alive = false; };
  }, [source, messages, threadId]);
  const sized = items?.some((item) => item.chars !== undefined);
  const ordered = sized ? [...(items ?? [])].sort((left, right) => (right.chars ?? 0) - (left.chars ?? 0)) : items ?? [];
  return <div className="context-items">
    <p>{failed ? "Emma could not read what is in this segment." : SEGMENT_NOTES[source]}</p>
    {items === undefined && <span className="context-items-wait">Reading…</span>}
    {!!ordered.length && <ul>
      {ordered.map((item, index) => <li key={`${item.name}-${index}`}>
        <span title={item.name}>{item.name}</span>
        {item.detail && <small title={item.detail}>{item.detail}</small>}
        {item.chars !== undefined && <b>{tokenLabel(item.chars)}</b>}
      </li>)}
    </ul>}
  </div>;
}

const railColumns = (count: number) => ({ "--cols": Math.max(1, Math.ceil(Math.sqrt(count))) }) as CSSProperties;

function SubagentRail({ agents, all, active, onPick, orientation }: {
  agents: LiveAgent[];
  all: LiveAgent[];
  active: string;
  onPick: (threadId: string) => void;
  orientation: WidgetOrientation;
}) {
  const live = agents.filter(alive);
  const done = agents.filter((agent) => !alive(agent));
  const roots = (list: LiveAgent[]) => list.filter((agent) => !list.some((other) => other.threadId === agent.parentThreadId));
  const branch = (agent: LiveAgent) => {
    const kids = all.filter((other) => other.parentThreadId === agent.threadId && alive(other) === alive(agent));
    return <li key={agent.threadId}>
      <button type="button" className={`subagent ${agent.threadId === active ? "active" : ""}`} title={`${agent.title} — ${agent.activity}${agent.model ? ` · ${agent.model}` : ""}`} onClick={() => onPick(agent.threadId)}>
        <i className="subagent-square" style={{ background: agent.color }} data-status={agent.status} aria-hidden="true" />
        <span>{agent.title}</span>
        <BrandIcon brand={brandForModel(agent.model)} className="subagent-model" />
      </button>
      {!!kids.length && <ul className="subagent-list subagent-kids" style={railColumns(kids.length)}>{kids.map(branch)}</ul>}
    </li>;
  };
  return <section className="subagents" data-orientation={orientation}>
    <span>Subagents{live.length ? ` · ${live.length} working` : ""}</span>
    {!!live.length && <ul className="subagent-list" style={railColumns(live.length)}>{roots(live).map(branch)}</ul>}
    {!live.length && !done.length && <p className="subagent-empty">Nothing delegated yet — a subagent gets a row here the moment it starts.</p>}
    {!!done.length && <details className="subagent-done">
      <summary><CaretIcon />{done.length} finished</summary>
      <ul className="subagent-list">{roots(done).map(branch)}</ul>
    </details>}
  </section>;
}

const alive = (agent?: LiveAgent) => agent?.status === "running" || agent?.status === "waiting";

function SubthreadRail({ threads, agents, onOpen, orientation }: {
  threads: Thread[];
  agents: LiveAgent[];
  onOpen: (threadId: string) => void;
  orientation: WidgetOrientation;
}) {
  const working = threads.filter((thread) => alive(agents.find((agent) => agent.threadId === thread.id))).length;
  return <section className="subthreads" data-orientation={orientation}>
    <span>Sub threads{threads.length ? ` · ${working} of ${threads.length} working` : ""}</span>
    <ul className="subthread-list">
      {threads.map((thread) => {
        const agent = agents.find((item) => item.threadId === thread.id);
        const label = threadLabel(thread);
        return <li key={thread.id}>
          <button type="button" className="subthread" title={`${label} — ${alive(agent) ? agent!.activity : `idle · last moved ${since(thread)} ago`}`} onClick={() => onOpen(thread.id)}>
            <i className="subthread-branch" style={agent ? { color: agent.color } : undefined} data-status={agent?.status ?? "idle"} aria-hidden="true">↳</i>
            <span>{label}</span>
            <em>{alive(agent) ? agent!.status : since(thread)}</em>
          </button>
          {alive(agent) && <button type="button" className="subthread-stop" title={`Stop ${label}`} aria-label={`Stop ${label}`} onClick={() => window.emma.stopAgent(thread.id)}>■</button>}
        </li>;
      })}
    </ul>
    {!threads.length && <p className="subagent-empty">Nothing branched off yet — Emma opens one per <code>threads spawn</code>.</p>}
  </section>;
}

export interface WidgetContext {
  ledger: Ledger;
  messages: Message[];
  threadId: string;
  sending: boolean;
  subagents: LiveAgent[];
  subthreads: Thread[];
  agents: LiveAgent[];
  onOpenThread: (threadId: string) => void;
  tab: string;
  onPick: (tab: string) => void;
  git: GitSnapshot | null;
  onOpenGit: () => void;
  sampleTrace?: { label: string; spans: TraceSpan[] };
  samplePlans?: Plan[];
  sampleTaskLists?: TaskList[];
}

function Widget({ widget, context }: { widget: ContextWidget; context: WidgetContext }): ReactNode {
  const { orientation } = widget;
  if (widget.type === "stats") return <ContextStats widget={widget} context={context} />;
  if (widget.type === "context") return <ContextLedger ledger={context.ledger} messages={context.messages} threadId={context.threadId} orientation={orientation} />;
  if (widget.type === "timeline") return <Timeline threadId={context.threadId} sending={context.sending} carriedTokens={context.ledger.carriedTokens} sample={context.sampleTrace} />;
  if (widget.type === "tasklist") return <TaskListRail threadId={context.threadId} sample={context.sampleTaskLists} />;
  if (widget.type === "plan") return <PlanRail threadId={context.threadId} agents={context.subagents} sample={context.samplePlans} onOpen={context.onPick} />;
  if (widget.type === "subagents") return <SubagentRail agents={context.subagents} all={context.agents} active={context.tab} onPick={context.onPick} orientation={orientation} />;
  if (widget.type === "machine") return <MachineStats orientation={orientation} />;
  if (widget.type === "machinegraph") return <MachineGraph orientation={orientation} />;
  if (widget.type === "machinemeters") return <MachineMeters orientation={orientation} />;
  if (widget.type === "subthreads") return <SubthreadRail threads={context.subthreads} agents={context.agents} onOpen={context.onOpenThread} orientation={orientation} />;
  return context.git ? <GitPanel snapshot={context.git} onOpen={context.onOpenGit} /> : null;
}

export function ContextWidgets({ page, context, onChange }: { page: ContextPage; context: WidgetContext; onChange: (widgets: ContextWidget[]) => void }) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const sensors = useBarSensors();
  const spare = CONTEXT_WIDGETS.filter((definition) => !page.widgets.some((widget) => widget.type === definition.type));
  const dropped = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = page.widgets.findIndex((widget) => widget.type === active.id);
    const to = page.widgets.findIndex((widget) => widget.type === over.id);
    if (from < 0 || to < 0) return;
    onChange(arrayMove(page.widgets, from, to));
  };
  return <>
    {editing
      ? <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dropped}>
        <SortableContext items={page.widgets.map((widget) => widget.type)} strategy={verticalListSortingStrategy}>
          {page.widgets.map((widget) => <PlacedWidget
            key={widget.type}
            widget={widget}
            context={context}
            onRemove={() => onChange(page.widgets.filter((item) => item.type !== widget.type))}
            onEdit={(changes) => onChange(page.widgets.map((item) => item.type === widget.type ? { ...item, ...changes } : item))}
          />)}
        </SortableContext>
      </DndContext>
      : page.widgets.map((widget) => <Widget key={widget.type} widget={widget} context={context} />)}
    {!page.widgets.length && <p className="bar-empty">Nothing on this page — press ＋ to put a component back.</p>}
    {adding && <div className="inspector-add">
      {spare.map((definition) => <button key={definition.type} type="button" title={definition.blurb} onClick={() => { onChange([...page.widgets, { type: definition.type, orientation: "vertical" }]); setAdding(false); }}>
        <b aria-hidden="true">{definition.glyph}</b>{definition.label}
      </button>)}
    </div>}
    <footer className="inspector-arrange">
      <button type="button" className="bar-add" disabled={!spare.length} aria-expanded={adding} aria-label="Add a component to this page" title={spare.length ? "Add a component" : "Every component is already on this page"} onClick={() => setAdding((open) => !open)}>＋</button>
      <button type="button" className="bar-edit" aria-pressed={editing} title={editing ? "Stop arranging" : "Reorder, flip and remove the components on this page"} onClick={() => { setEditing((on) => !on); setAdding(false); }}>{editing ? "Done" : "Edit"}</button>
    </footer>
  </>;
}

const PAGE_KEY = "emma.contextPage.v1";
export const readContextPage = (): string => localStorage.getItem(PAGE_KEY) ?? "";
export const writeContextPage = (id: string): void => localStorage.setItem(PAGE_KEY, id);

const sampleGeneration = (inputTokens: number, outputTokens: number, durationMilliseconds: number, cacheReadTokens: number) =>
  ({ inputTokens, outputTokens, durationMilliseconds, cacheInputTokens: inputTokens, cacheReadTokens, model: "anthropic/claude-sonnet-4.5" });

const SAMPLE_THREAD: Thread = {
  id: "sample",
  title: "Sample thread",
  createdAt: "2026-08-22T15:38:00.000Z",
  updatedAt: "2026-08-22T15:41:42.000Z",
  messages: [
    { role: "user", content: "x".repeat(1_200), timestamp: "2026-08-22T15:38:31.000Z" },
    { role: "assistant", content: "x".repeat(14_000), timestamp: "2026-08-22T15:38:58.000Z", generation: sampleGeneration(9_400, 5_100, 41_000, 0) },
    { role: "user", content: "x".repeat(900), timestamp: "2026-08-22T15:39:40.000Z" },
    { role: "assistant", content: "x".repeat(11_500), timestamp: "2026-08-22T15:40:12.000Z", generation: sampleGeneration(21_800, 6_300, 62_000, 14_600) },
    { role: "user", content: "x".repeat(700), timestamp: "2026-08-22T15:41:02.000Z" },
    { role: "assistant", content: "x".repeat(18_000), timestamp: "2026-08-22T15:41:42.000Z", generation: sampleGeneration(43_100, 6_900, 79_000, 37_800) },
  ],
};

const SAMPLE_USES: ContextUse[] = [
  { kind: "messages", label: "Experiments/ · file list", chars: 3_700 * CHARS_PER_TOKEN, turns: 3 },
  { kind: "skills", label: "review-diff", chars: 1_900 * CHARS_PER_TOKEN, turns: 1 },
];

const SAMPLE_BREAKDOWN: ContextBreakdown = {
  systemPromptBytes: 5_200 * CHARS_PER_TOKEN,
  systemToolsBytes: 21_000 * CHARS_PER_TOKEN,
  mcpToolsBytes: 8_600 * CHARS_PER_TOKEN,
  skillsBytes: 5_500 * CHARS_PER_TOKEN,
  memoryBytes: 915 * CHARS_PER_TOKEN,
};

const SAMPLE_EXPERIMENTS: ExperimentTally = { savedTokens: 18_400, addedTokens: 900, prunedResults: 12, reinjections: 3 };

const SAMPLE_AGENTS: LiveAgent[] = [
  { threadId: "sample-a", prompt: "Port the old ledger", parentThreadId: "sample", title: "Ramona", color: agentColor(0), status: "running", mode: "acceptEdits", model: "sonnet", activity: "reading src/context-bar.tsx", tool: true, startedAt: 0, steps: 14, toolCalls: 9, inputTokens: 24_100, outputTokens: 3_200, generationMs: 21_000 },
  { threadId: "sample-b", prompt: "Port the old ledger", parentThreadId: "sample", title: "Otis", color: agentColor(1), status: "done", mode: "auto", model: "haiku", activity: "done", tool: false, startedAt: 0, endedAt: 1, steps: 6, toolCalls: 4, inputTokens: 8_900, outputTokens: 1_100, generationMs: 7_400 },
  { threadId: "sample-t1", prompt: "Port the old ledger", title: "Port the old ledger", color: agentColor(2), status: "running", mode: "acceptEdits", model: "sonnet", activity: "running tests", tool: true, startedAt: 0, steps: 3, toolCalls: 2, inputTokens: 6_100, outputTokens: 800, generationMs: 5_200 },
];

const sampleStamp = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

const SAMPLE_SUBTHREADS: Thread[] = [
  { ...SAMPLE_THREAD, id: "sample-t1", title: "Port the old ledger", parentThreadId: "sample", updatedAt: sampleStamp(4 * 60_000), messages: [] },
  { ...SAMPLE_THREAD, id: "sample-t2", title: "Check the migration", parentThreadId: "sample", updatedAt: sampleStamp(3 * 3_600_000), messages: [] },
];

const SAMPLE_SPANS: TraceSpan[] = [
  { id: "root", name: "Turn", kind: "agent", startedAt: 0, endedAt: 43_170, status: "ok", tokens: 2_400 },
  { id: "m1", parentId: "root", name: "model", kind: "model", startedAt: 120, endedAt: 10_400, status: "ok", tokens: 5_100 },
  { id: "s1", parentId: "root", name: "Selecting tool", kind: "search", startedAt: 10_500, endedAt: 12_600, status: "ok", tokens: 900 },
  { id: "m2", parentId: "root", name: "model", kind: "model", startedAt: 12_700, endedAt: 26_800, status: "ok", tokens: 4_300 },
  { id: "t1", parentId: "root", name: "artifact", kind: "mcp", startedAt: 26_900, endedAt: 32_520, status: "ok", tokens: 6_200 },
  { id: "t2", parentId: "t1", name: "auto agent approved · artifact", kind: "permission", startedAt: 26_910, endedAt: 32_520, status: "ok" },
  { id: "m3", parentId: "root", name: "model", kind: "model", startedAt: 32_600, endedAt: 43_170, status: "ok", tokens: 3_800 },
];

const SAMPLE_PLANS: Plan[] = [{
  id: "port-the-ledger",
  title: "Port the ledger",
  goal: "Move the ledger onto the new usage rows without changing what it reads.",
  threadId: "sample",
  updatedAt: SAMPLE_THREAD.updatedAt,
  steps: [
    { id: "step-1", title: "Read the old ledger", status: "done", needs: [], brief: "Read src/context-bar.tsx and write down what each row measures.", tasks: [{ text: "list the kinds", done: true }, { text: "note the char/token divide", done: true }], result: "Six kinds, all measured in characters and divided by four." },
    { id: "step-2", title: "Audit the ledger", status: "running", needs: ["step-1"], brief: "Check every row against what the provider reported.", tasks: [{ text: "compare against the last turn", done: true }, { text: "flag the residual", done: false }, { text: "write the note", done: false }] },
    { id: "step-3", title: "Sweep the CSS", status: "running", needs: ["step-1"], brief: "Bring the legend onto the shared swatch rules.", tasks: [{ text: "drop the duplicate hues", done: true }, { text: "check both orientations", done: false }] },
    { id: "step-4", title: "Run the check", status: "todo", needs: ["step-2", "step-3"], brief: "npm run check, and fix whatever falls out.", tasks: [{ text: "tests", done: false }, { text: "typecheck", done: false }] },
  ],
}];

const SAMPLE_TASK_LISTS: TaskList[] = [{
  id: "ship-the-task-list",
  title: "Ship the task list",
  goal: "Add durable nested tasks without changing the plan tool's delegation role.",
  threadId: "sample",
  updatedAt: SAMPLE_THREAD.updatedAt,
  tasks: [
    { id: "inspect", title: "Inspect the plan flow", status: "completed", subtasks: [
      { id: "store", title: "Trace Markdown storage", status: "completed", subtasks: [] },
      { id: "widget", title: "Trace the plan widget", status: "completed", subtasks: [] },
    ] },
    { id: "build", title: "Build nested tasks", status: "in_progress", subtasks: [
      { id: "tool", title: "Wire the tool", status: "completed", subtasks: [] },
      { id: "surface", title: "Draw the widget", status: "in_progress", subtasks: [] },
      { id: "checks", title: "Run the checks", status: "pending", subtasks: [] },
    ] },
  ],
}];

const SAMPLE_GIT: GitSnapshot = {
  branch: "main",
  head: "0000000",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  worktree: false,
  branches: ["main", "context-bar"],
  remotes: ["origin"],
  files: [{ path: "desktop/src/context-bar.tsx", index: " ", work: "M" }],
  diff: "diff --git a/desktop/src/context-bar.tsx b/desktop/src/context-bar.tsx\n@@ -1,4 +1,6 @@\n+const sample = true;\n-const sample = false;\n",
  truncated: false,
};

function usePreviewContext(): WidgetContext {
  const ledger = useContextLedger(SAMPLE_THREAD, SAMPLE_USES, 1_049_000, [], SAMPLE_EXPERIMENTS, 0, SAMPLE_BREAKDOWN);
  const sampleTrace = useMemo(() => ({ label: "3:41:42 PM", spans: SAMPLE_SPANS }), []);
  return {
    ledger,
    messages: SAMPLE_THREAD.messages,
    threadId: "sample",
    sending: false,
    subagents: SAMPLE_AGENTS.filter((agent) => agent.parentThreadId),
    subthreads: SAMPLE_SUBTHREADS,
    agents: SAMPLE_AGENTS,
    onOpenThread: () => undefined,
    tab: "sample-a",
    onPick: () => undefined,
    git: SAMPLE_GIT,
    onOpenGit: () => undefined,
    sampleTrace,
    samplePlans: SAMPLE_PLANS,
    sampleTaskLists: SAMPLE_TASK_LISTS,
  };
}

const useBarSensors = () => useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

const paletteId = (type: ContextWidgetType) => `add:${type}`;
const placedType = (id: string) => id.replace(/^add:/, "") as ContextWidgetType;

function GripIcon() {
  return <svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="4" r="1.1" /><circle cx="7.5" cy="4" r="1.1" /><circle cx="2.5" cy="8" r="1.1" /><circle cx="7.5" cy="8" r="1.1" /><circle cx="2.5" cy="12" r="1.1" /><circle cx="7.5" cy="12" r="1.1" /></svg>;
}

function PaletteCard({ type, disabled, onAdd }: { type: ContextWidgetType; disabled: boolean; onAdd: () => void }) {
  const definition = widgetDefinition(type);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: paletteId(type), disabled });
  return <div ref={setNodeRef} className="bar-palette-card" data-dragging={isDragging || undefined} data-disabled={disabled || undefined}>
    <b aria-hidden="true">{definition.glyph}</b>
    <div>
      <strong>{definition.label}</strong>
      <small>{definition.blurb}</small>
    </div>
    {disabled
      ? <span className="bar-palette-on" title="Already on this page">On page</span>
      : <><button type="button" className="bar-grip" aria-label={`Drag ${definition.label} into the bar`} {...attributes} {...listeners}><GripIcon /></button>
        <button type="button" className="bar-add" aria-label={`Add ${definition.label} to this page`} onClick={onAdd}>+</button></>}
  </div>;
}

function MetricPicker({ metrics, onChange }: { metrics: ContextMetric[]; onChange: (metrics: ContextMetric[]) => void }) {
  return <div className="bar-metrics">
    {CONTEXT_METRICS.map((metric) => {
      const on = metrics.includes(metric.id);
      return <label key={metric.id}>
        <input
          type="checkbox"
          checked={on}
          disabled={on && metrics.length < 2}
          onChange={() => onChange(on ? metrics.filter((id) => id !== metric.id) : [...metrics, metric.id])}
        />
        {metric.label}
      </label>;
    })}
  </div>;
}

function PlacedWidget({ widget, context, onRemove, onEdit }: { widget: ContextWidget; context: WidgetContext; onRemove: () => void; onEdit: (changes: Partial<ContextWidget>) => void }) {
  const definition = widgetDefinition(widget.type);
  const [picking, setPicking] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: widget.type });
  const metrics = widget.metrics ?? DEFAULT_METRICS;
  return <div ref={setNodeRef} className="bar-widget" data-dragging={isDragging || undefined} style={{ transform: CSS.Transform.toString(transform), transition }}>
    <header>
      <button type="button" className="bar-grip" aria-label={`Reorder ${definition.label}`} {...attributes} {...listeners}><GripIcon /></button>
      <span>{definition.label}</span>
      {widget.type === "stats" && <button type="button" className="bar-flip" aria-expanded={picking} aria-label="Choose which metrics this component shows" title={`Choose the metrics — ${metrics.length} of ${CONTEXT_METRICS.length}`} onClick={() => setPicking((open) => !open)}>▦</button>}
      {definition.orientable && <button type="button" className="bar-flip" aria-pressed={widget.orientation === "horizontal"} title={widget.orientation === "horizontal" ? "Laid across — press for one item a line" : "One item a line — press to lay it across"} onClick={() => onEdit({ orientation: widget.orientation === "horizontal" ? "vertical" : "horizontal" })}>{widget.orientation === "horizontal" ? "⇄" : "⇅"}</button>}
      <button type="button" className="bar-drop" aria-label={`Remove ${definition.label} from this page`} onClick={onRemove}>×</button>
    </header>
    {picking && <MetricPicker metrics={metrics} onChange={(next) => onEdit({ metrics: next })} />}
    <div className="bar-widget-body" inert>
      <Widget widget={widget} context={context} />
    </div>
  </div>;
}

export function ContextBarSettings({ pages, onChange, busy }: { pages: ContextPage[]; onChange: (pages: ContextPage[]) => void; busy: boolean }) {
  const [active, setActive] = useState(pages[0]?.id ?? "p1");
  const [dragging, setDragging] = useState<ContextWidgetType | null>(null);
  const context = usePreviewContext();
  const nameField = useId();
  const page = pages.find((item) => item.id === active) ?? pages[0];
  const sensors = useBarSensors();
  const { setNodeRef: setCanvasRef, isOver } = useDroppable({ id: "bar-canvas" });

  const writePage = useCallback((widgets: ContextWidget[]) => {
    onChange(pages.map((item) => item.id === page.id ? { ...item, widgets } : item));
  }, [onChange, page.id, pages]);

  const spare = CONTEXT_WIDGETS.filter((definition) => !page.widgets.some((widget) => widget.type === definition.type));
  const add = (type: ContextWidgetType, at = page.widgets.length) => {
    const widgets = [...page.widgets];
    widgets.splice(at, 0, { type, orientation: "vertical" });
    writePage(widgets);
  };

  const dropped = ({ active: from, over }: DragEndEvent) => {
    setDragging(null);
    if (!over) return;
    const type = placedType(String(from.id));
    const target = over.id === "bar-canvas" ? page.widgets.length : page.widgets.findIndex((widget) => widget.type === over.id);
    if (String(from.id).startsWith("add:")) { add(type, target < 0 ? page.widgets.length : target); return; }
    const at = page.widgets.findIndex((widget) => widget.type === type);
    if (at < 0 || target < 0 || at === target) return;
    writePage(arrayMove(page.widgets, at, target));
  };

  const addPage = () => {
    if (pages.length >= MAX_CONTEXT_PAGES) return;
    const id = nextPageId(pages);
    onChange([...pages, { id, name: `Page ${pages.length + 1}`, widgets: [{ type: "stats", orientation: "horizontal" }] }]);
    setActive(id);
  };
  const removePage = () => {
    if (pages.length < 2) return;
    const rest = pages.filter((item) => item.id !== page.id);
    onChange(rest);
    setActive(rest[0].id);
  };
  const rename = (name: string) => onChange(pages.map((item) => item.id === page.id ? { ...item, name } : item));

  return <div className="bar-editor" aria-busy={busy || undefined}>
    <section className="bar-pages">
      <header>
        <span>Pages · {pages.length} of {MAX_CONTEXT_PAGES}</span>
        <button type="button" disabled={busy || pages.length >= MAX_CONTEXT_PAGES} onClick={addPage}>New page</button>
      </header>
      <div className="bar-page-tabs" role="tablist" aria-label="Context bar pages">
        {pages.map((item) => <button key={item.id} type="button" role="tab" aria-selected={item.id === page.id} disabled={busy} onClick={() => setActive(item.id)}>{item.name}</button>)}
      </div>
      <div className="bar-page-fields">
        <label htmlFor={nameField}>Name</label>
        <input id={nameField} value={page.name} maxLength={MAX_PAGE_NAME} disabled={busy} onChange={(event) => rename(event.target.value)} />
        <button type="button" className="bar-page-remove" disabled={busy || pages.length < 2} onClick={removePage}>Delete page</button>
      </div>
    </section>

    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={({ active: from }: DragStartEvent) => setDragging(placedType(String(from.id)))} onDragCancel={() => setDragging(null)} onDragEnd={dropped}>
      <div className="bar-workbench">
        <section className="bar-palette">
          <header><span>Components</span><small>{spare.length} left</small></header>
          {CONTEXT_WIDGETS.map((definition) => <PaletteCard key={definition.type} type={definition.type} disabled={busy || page.widgets.some((widget) => widget.type === definition.type)} onAdd={() => add(definition.type)} />)}
        </section>

        <section className="bar-stage">
          <header><span>{page.name}</span><small>288px · live data is your own</small></header>
          <div className="inspector bar-preview">
            <div className="inspector-body" ref={setCanvasRef} data-over={isOver || undefined}>
              <header><span>{page.name}</span><button type="button" inert>Save &amp; analyze</button></header>
              <SortableContext items={page.widgets.map((widget) => widget.type)} strategy={verticalListSortingStrategy}>
                {page.widgets.map((widget) => <PlacedWidget
                  key={widget.type}
                  widget={widget}
                  context={context}
                  onRemove={() => writePage(page.widgets.filter((item) => item.type !== widget.type))}
                  onEdit={(changes) => writePage(page.widgets.map((item) => item.type === widget.type ? { ...item, ...changes } : item))}
                />)}
              </SortableContext>
              {!page.widgets.length && <p className="bar-empty">Drag a component in, or press its ＋. An empty page shows the thread's name and nothing else.</p>}
            </div>
          </div>
        </section>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging && <div className="bar-ghost"><b aria-hidden="true">{widgetDefinition(dragging).glyph}</b>{widgetDefinition(dragging).label}</div>}
      </DragOverlay>
    </DndContext>
  </div>;
}
