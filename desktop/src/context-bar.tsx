/* The thread inspector, as components you can arrange.

   Three things live here, in the order they depend on each other:

   1. The two hooks the pane reads its numbers through: `useContextLedger`, over
      the ledger `context.ts` builds, and `useThreadCalls`, which is the one
      figure in it that has to be fetched.
   2. The widgets, and `ContextWidgets`, which renders one page of them. This is
      what the real inspector mounts.
   3. `ContextBarSettings`, the arranger. It mounts the *same* widgets over
      made-up data inside a column the width of the real bar, so what you drag
      around is the thing itself rather than a diagram of it.

   Nothing here fetches for the preview: every widget already took its data as
   props, and the ones that did not — the timeline's stored trace, the plan rail's
   plans — now accept an override, which is the whole of the seam. */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CONTEXT_WIDGETS, MAX_CONTEXT_PAGES, MAX_PAGE_NAME, nextPageId, widgetDefinition, type ContextPage, type ContextWidget, type ContextWidgetType, type WidgetOrientation } from "../shared/context-bar";
import { charLabel, CHARS_PER_TOKEN, shareLabel, usageKey, type ContextUse } from "../shared/usage";
import { agentColor, type LiveAgent } from "../shared/agents";
import type { Plan } from "../shared/plan";
import type { GitSnapshot } from "../shared/git";
import { countCalls, decodeSpans, type TraceSpan } from "../shared/trace";
import type { Thread } from "./types";
import { buildLedger, NO_EXPERIMENTS, type ExperimentTally, type Ledger } from "./context";
import { plural } from "./activity";
import { since, threadLabel } from "./threads";
import { brandForModel } from "./brands";
import { BrandIcon, ExpandIcon } from "./icons";
import { GitPanel } from "./git";
import { PlanRail } from "./plan";
import { Timeline } from "./timeline";

/* ------------------------------------------------------------- ledger -- */

/* The panel measures in characters but the window is stated in tokens, so every
   figure is divided back before it is shown: "62k / 4000k" was 62k chars of a
   4M-char budget, which is the same fraction but reads as a window four times
   larger than the model's. */
const tokenLabel = (chars: number): string => charLabel(Math.round(chars / CHARS_PER_TOKEN));
const KIND_NAMES: Record<ContextUse["kind"], string> = { history: "Transcript", system: "System prompt", tools: "Tool schemas", knowledge: "Knowledge", attachment: "Attachment", skill: "Skill" };

/**
 * Measured once in the pane, read by every widget that shows a piece of it.
 *
 * Lifted out of the panel it used to live in because the timeline needs the same
 * total for its context axis, and because the ledger has to stay right whether
 * or not the widget that draws it is on the page you are looking at.
 */
export function useContextLedger(thread: Thread | undefined, uses: ContextUse[], contextTokens: number, inFlight: LiveAgent[], experiments: ExperimentTally = NO_EXPERIMENTS, landedCalls = 0): Ledger {
  return useMemo(() => buildLedger(thread, uses, contextTokens, inFlight, experiments, landedCalls), [thread, uses, contextTokens, inFlight, experiments, landedCalls]);
}

/**
 * What the turns already on this thread did, off the traces the host kept.
 *
 * The agent's own calls — the harness's `terminal`, `read_file` and the rest — are
 * not segments of a request, so they were never in the usage ledger, and the
 * running count on the loop dies with the run that reported it. The stored trace
 * is the only durable record of them, and it is the same one the timeline draws,
 * so the tile and the waterfall beside it count the same spans.
 *
 * Re-read when the turn ends, because that is when its trace lands on the thread.
 */
export function useThreadCalls(threadId: string | undefined, sending: boolean): number {
  // Kept against the thread it was counted for, so switching threads reads zero
  // until its own traces arrive rather than the last thread's total — and so the
  // number the tile shows never changes until a fetch has actually answered,
  // which is what keeps it from dipping in the instant a turn lands.
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

/** "12.4k saved · 0.9k added" — what the two levers have done to this thread,
    net, so a lever that costs more than it saves says so. */
function experimentLabel({ savedTokens, addedTokens }: ExperimentTally): string {
  const net = savedTokens - addedTokens;
  return `${net >= 0 ? "−" : "+"}${charLabel(Math.abs(net))} net · ${charLabel(savedTokens)} saved, ${charLabel(addedTokens)} added`;
}

const experimentTitle = ({ savedTokens, addedTokens, prunedResults, reinjections }: ExperimentTally) =>
  `Pruning blanked ${prunedResults} tool ${plural(prunedResults, "result")}, taking about ${savedTokens.toLocaleString()} tokens out of the requests this thread has sent. The prompt was repeated ${reinjections} ${plural(reinjections, "time")}, putting about ${addedTokens.toLocaleString()} back in.`;

/** A rising line over bars — the speed curve the toggle in the tile opens. */
function CurveIcon() {
  return <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 13.5V10M6 13.5V7.5M10 13.5V9M14 13.5V4.5" /></svg>;
}

/* ------------------------------------------------------------ widgets -- */

/** The thread's totals as tiles. Horizontal is the 2-up grid; vertical is one metric a line. */
function ContextStats({ ledger, orientation }: { ledger: Ledger; orientation: WidgetOrientation }) {
  const [curveOpen, setCurveOpen] = useState(false);
  const { messages, replies, attachments, calls, tokens, elapsed, curve } = ledger;
  const peak = Math.max(...curve.map((point) => point.rate), 1);
  return <section className="context-stats" data-orientation={orientation}>
    <div className="agent-metrics">
      <span><b>{messages}</b> {plural(messages, "message")}</span>
      <span><b>{replies}</b> Emma {plural(replies, "reply", "replies")}</span>
      <span><b>{attachments}</b> {plural(attachments, "attachment")}</span>
      <span><b>{calls}</b> tool {plural(calls, "call")}</span>
      {/* The average hides the trend: generation slows as the request grows.
          The curve is the same replies pooled per doubling of input, so it
          hangs off the number it qualifies rather than standing on its own. */}
      <span className="metric-rate"><b>{elapsed ? Math.round(tokens / elapsed * 1000) : "—"}</b> avg tok/s<button type="button" className="rate-toggle" aria-expanded={curveOpen} aria-controls="rate-curve" aria-label="Tokens a second by context size" title="Tokens a second by context size" onClick={() => setCurveOpen((open) => !open)}><CurveIcon /></button></span>
      <span><b>{tokens ? charLabel(tokens) : "—"}</b> output {plural(tokens, "token")}</span>
    </div>
    {curveOpen && <div className="rate-curve" id="rate-curve">
      {curve.length ? <ol>
        {curve.map((point) => <li key={point.context} title={`${point.turns} ${plural(point.turns, "reply", "replies")} sent with ${charLabel(point.context)}–${charLabel(point.context * 2)} tokens of input`}>
          <span>{point.context / 1024}K</span><i style={{ width: `${point.rate / peak * 100}%` }} /><b>{Math.round(point.rate)}</b>
        </li>)}
      </ol> : <p>No timed replies yet.</p>}
    </div>}
  </section>;
}

/** The window as one 48-cell bar over its legend. Horizontal wraps the legend into swatches. */
function ContextLedger({ ledger, orientation }: { ledger: Ledger; orientation: WidgetOrientation }) {
  const { rows, cells, kinds, total, capacity, free, whole, largest, messages, replies, attachments, calls, tokens, elapsed, experiments } = ledger;
  // Off by default and off for most threads, so the line only appears once a
  // lever has actually fired on one of this thread's turns.
  const rewritten = experiments.prunedResults > 0 || experiments.reinjections > 0;
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  // A <dialog> is only modal once the API says so, and it is mounted by the flag.
  useEffect(() => { if (expanded && !dialog.current?.open) dialog.current?.showModal(); }, [expanded]);
  const dismiss = () => dialog.current?.close();
  const grid = cells.length > 0 && <div className="context-grid" aria-hidden="true">{cells.map((key, index) => <i key={index} data-kind={kinds.get(key)} />)}</div>;
  return <section className="context-usage" data-orientation={orientation}>
    {/* The label band stacks over its readout like every other inspector
        section, so the expand affordance rides the label row. */}
    {/* Without a stated window there is nothing to be a percentage of: the
        share would be of the send itself, and "100.0%" reads as a full window
        when it only ever means "all of what was sent". The rows below are
        still shares of the send, which is what the reader wants from them. */}
    <span title={capacity ? "" : "This model states no context window, so the rows are shares of what this thread sent, not of a window"}><span className="context-title">{capacity ? "Context window" : "Context used"}<button type="button" className="context-expand" aria-haspopup="dialog" aria-label="Expand the context ledger" title="Expand the context ledger" onClick={() => setExpanded(true)}><ExpandIcon /></button></span><b>{tokenLabel(total)}{capacity ? ` / ${tokenLabel(capacity)}` : ""} {plural(Math.round(total / CHARS_PER_TOKEN), "token")}{capacity ? ` (${shareLabel(total, whole)})` : " sent · no stated window"}</b></span>
    {grid}
    <ul className="context-legend">
      {rows.map((row) => <li key={usageKey(row)} data-kind={row.kind} title={`${KIND_NAMES[row.kind]} · ${row.label} · ${row.chars.toLocaleString()} chars · ${row.turns} ${plural(row.turns, "turn")}`}>
        <i /><span>{row.label}</span><b>{tokenLabel(row.chars)}</b><em>{shareLabel(row.chars, whole)}</em>
      </li>)}
      {capacity > 0 && <li data-kind="free" title={`${free.toLocaleString()} of ${capacity.toLocaleString()} characters left before this model's window is full`}>
        <i /><span>Free space</span><b>{tokenLabel(free)}</b><em>{shareLabel(free, whole)}</em>
      </li>}
    </ul>
    {/* Below the legend rather than in it: the rows above are what the turn
        carried, this is what was done to them. */}
    {rewritten && <p className="context-experiments" title={experimentTitle(experiments)}>Experiments · {experimentLabel(experiments)}</p>}
    {expanded && <dialog ref={dialog} className="modal-backdrop" aria-labelledby="ledger-title" onClose={() => setExpanded(false)} onCancel={(event) => { event.preventDefault(); dismiss(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
      <section className="agent-dialog context-dialog">
        <header><div><span>{capacity ? `${tokenLabel(capacity)}-token window` : "No stated window"}</span><h2 id="ledger-title">Context ledger</h2></div><button type="button" onClick={dismiss} aria-label="Close context ledger">×</button></header>
        <dl>
          <div><dt>Carried</dt><dd>{tokenLabel(total)} tokens · {total.toLocaleString()} chars</dd></div>
          {capacity > 0 && <div><dt>Window</dt><dd>{tokenLabel(capacity)} tokens · {shareLabel(total, whole)} used</dd></div>}
          {capacity > 0 && <div><dt>Free space</dt><dd>{tokenLabel(free)} tokens · {shareLabel(free, whole)}</dd></div>}
          {largest && <div><dt>Largest</dt><dd title={largest.label}>{largest.label} · {shareLabel(largest.chars, whole)}</dd></div>}
          {rewritten && <div><dt>Experiments</dt><dd title={experimentTitle(experiments)}>{experimentLabel(experiments)}</dd></div>}
          <div><dt>Messages</dt><dd>{messages} · {replies} {plural(replies, "reply", "replies")}</dd></div>
          <div><dt>Attachments</dt><dd>{attachments}</dd></div>
          <div><dt>Tool calls</dt><dd>{calls}</dd></div>
          <div><dt>Output</dt><dd>{tokens ? charLabel(tokens) : "—"} tokens · {elapsed ? Math.round(tokens / elapsed * 1000) : "—"} tok/s</dd></div>
        </dl>
        {/* Same hues, same swatches: the kind rules hang off .context-usage. */}
        <div className="context-usage context-dialog-rows">
          {grid}
          <table className="context-table">
            <thead><tr><th>Segment</th><th>Kind</th><th>Chars</th><th>Tokens</th><th>Share</th><th>Turns</th></tr></thead>
            <tbody>
              {rows.map((row) => <tr key={usageKey(row)} data-kind={row.kind}>
                <th scope="row"><i />{row.label}</th>
                <td>{KIND_NAMES[row.kind]}</td>
                <td>{row.chars.toLocaleString()}</td>
                <td>{tokenLabel(row.chars)}</td>
                <td>{shareLabel(row.chars, whole)}</td>
                <td>{row.turns}</td>
              </tr>)}
              {capacity > 0 && <tr data-kind="free">
                <th scope="row"><i />Free space</th><td>Unclaimed</td><td>{free.toLocaleString()}</td><td>{tokenLabel(free)}</td><td>{shareLabel(free, whole)}</td><td>—</td>
              </tr>}
            </tbody>
          </table>
        </div>
        <p>Characters are counted on this Mac and divided by {CHARS_PER_TOKEN} to read as tokens, so every figure here is an estimate.</p>
      </section>
    </dialog>}
  </section>;
}

/**
 * The thread's subagents: one coloured square each, into the tab that already
 * renders that agent's transcript. Nothing else — a subagent runs on whatever
 * the thread runs on. Horizontal drops the model column and wraps the squares.
 */
function SubagentRail({ agents, active, onPick, orientation }: {
  agents: LiveAgent[];
  active: string;
  onPick: (threadId: string) => void;
  orientation: WidgetOrientation;
}) {
  return <section className="subagents" data-orientation={orientation}>
    <span>Subagents{agents.length ? ` · ${agents.length}` : ""}</span>
    <ul className="subagent-list">
      {agents.map((agent) => <li key={agent.threadId}>
        <button type="button" className={`subagent ${agent.threadId === active ? "active" : ""}`} title={`${agent.title} — ${agent.activity}${agent.model ? ` · ${agent.model}` : ""}`} onClick={() => onPick(agent.threadId)}>
          <i className="subagent-square" style={{ background: agent.color }} data-status={agent.status} aria-hidden="true" />
          <span>{agent.title}</span>
          {/* The maker's mark, not the slug: "deepseek/deepseek-v4-flash-vision-exp"
              was wider than the title it sat beside, and every row on a fanned-out
              thread repeats the same one. The slug is in the title attribute. */}
          <BrandIcon brand={brandForModel(agent.model)} className="subagent-model" />
        </button>
      </li>)}
    </ul>
    {!agents.length && <p className="subagent-empty">Nothing delegated yet — a subagent gets a row here the moment it starts.</p>}
  </section>;
}

const alive = (agent?: LiveAgent) => agent?.status === "running" || agent?.status === "waiting";

/**
 * The threads this one started, which is a different question from the rail
 * above it and so a different row.
 *
 * A subagent is a step of this turn: it ends with the turn, its transcript is a
 * tab of this pane, and the square is the only handle it needs. A sub thread is a
 * place — its own row in the sidebar, its own agent, its own composer — that
 * outlives every run in it. So these rows are read off the library rather than
 * the agent list: one stays after the work in it stops, saying how long ago that
 * was, and pressing it leaves this thread for that one instead of switching a
 * tab. The stop is here because it is the one lever you would otherwise have to
 * navigate away to reach.
 */
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
            {/* Branch, not the subagent's square: a place that was opened off this
                thread, drawn in the colour its own agent wears where it has one. */}
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

/** Everything a page's widgets need. One object, because a widget takes what it takes. */
export interface WidgetContext {
  ledger: Ledger;
  threadId: string;
  sending: boolean;
  subagents: LiveAgent[];
  /** Threads owned by this one, live or not — the library's answer, not the loop's. */
  subthreads: Thread[];
  /** Every live agent, so a sub thread's own run is found by id; `subagents` is only what this thread delegated. */
  agents: LiveAgent[];
  onOpenThread: (threadId: string) => void;
  tab: string;
  onPick: (tab: string) => void;
  git: GitSnapshot | null;
  onOpenGit: () => void;
  /** Set by the Settings preview: one made-up turn for the timeline to draw. */
  sampleTrace?: { label: string; spans: TraceSpan[] };
  /** The same seam for the plan, which otherwise reads the plans folder itself. */
  samplePlans?: Plan[];
}

function Widget({ widget, context }: { widget: ContextWidget; context: WidgetContext }): ReactNode {
  const { orientation } = widget;
  if (widget.type === "stats") return <ContextStats ledger={context.ledger} orientation={orientation} />;
  if (widget.type === "context") return <ContextLedger ledger={context.ledger} orientation={orientation} />;
  if (widget.type === "timeline") return <Timeline threadId={context.threadId} sending={context.sending} carriedTokens={context.ledger.carriedTokens} sample={context.sampleTrace} />;
  if (widget.type === "plan") return <PlanRail threadId={context.threadId} agents={context.subagents} sample={context.samplePlans} onOpen={context.onPick} />;
  if (widget.type === "subagents") return <SubagentRail agents={context.subagents} active={context.tab} onPick={context.onPick} orientation={orientation} />;
  if (widget.type === "subthreads") return <SubthreadRail threads={context.subthreads} agents={context.agents} onOpen={context.onOpenThread} orientation={orientation} />;
  return context.git ? <GitPanel snapshot={context.git} onOpen={context.onOpenGit} /> : null;
}

/** One page of the bar, in order. */
export function ContextWidgets({ page, context }: { page: ContextPage; context: WidgetContext }) {
  return <>{page.widgets.map((widget) => <Widget key={widget.type} widget={widget} context={context} />)}</>;
}

/* Which page the bar is on. Kept out of settings on purpose: it is where you are
   looking, not how you set the app up, and writing it there would broadcast a
   settings change on every tab click. */
const PAGE_KEY = "emma.contextPage.v1";
export const readContextPage = (): string => localStorage.getItem(PAGE_KEY) ?? "";
export const writeContextPage = (id: string): void => localStorage.setItem(PAGE_KEY, id);

/* -------------------------------------------------------- the arranger -- */

/* A thread that never happened, sized so every widget has something to say: a
   window that is visibly part-full, a transcript that dominates it, one skill,
   and replies slow enough that the speed curve has a slope. */
const sampleGeneration = (inputTokens: number, outputTokens: number, durationMilliseconds: number) =>
  ({ inputTokens, outputTokens, durationMilliseconds, model: "anthropic/claude-sonnet-4.5" });

const SAMPLE_THREAD: Thread = {
  id: "sample",
  title: "Sample thread",
  knowledgeBaseId: "sample",
  sourceKnowledgeBaseIds: [],
  createdAt: "2026-08-22T15:38:00.000Z",
  updatedAt: "2026-08-22T15:41:42.000Z",
  messages: [
    { role: "user", content: "x".repeat(1_200), timestamp: "2026-08-22T15:38:31.000Z" },
    { role: "assistant", content: "x".repeat(14_000), timestamp: "2026-08-22T15:38:58.000Z", generation: sampleGeneration(9_400, 5_100, 41_000) },
    { role: "user", content: "x".repeat(900), timestamp: "2026-08-22T15:39:40.000Z" },
    { role: "assistant", content: "x".repeat(11_500), timestamp: "2026-08-22T15:40:12.000Z", generation: sampleGeneration(21_800, 6_300, 62_000) },
    { role: "user", content: "x".repeat(700), timestamp: "2026-08-22T15:41:02.000Z" },
    { role: "assistant", content: "x".repeat(18_000), timestamp: "2026-08-22T15:41:42.000Z", generation: sampleGeneration(43_100, 6_900, 79_000) },
  ],
};

const SAMPLE_USES: ContextUse[] = [
  { kind: "knowledge", label: "Prompt, tools & retrieval", chars: 20_000 * CHARS_PER_TOKEN, turns: 3 },
  { kind: "attachment", label: "Experiments/ · file list", chars: 3_700 * CHARS_PER_TOKEN, turns: 3 },
  { kind: "skill", label: "review-diff", chars: 1_900 * CHARS_PER_TOKEN, turns: 1 },
];

/* A thread that ran with both Harness levers on, so the line they add is part of
   what you arrange rather than something that appears later on a real thread. */
const SAMPLE_EXPERIMENTS: ExperimentTally = { savedTokens: 18_400, addedTokens: 900, prunedResults: 12, reinjections: 3 };

const SAMPLE_AGENTS: LiveAgent[] = [
  { threadId: "sample-a", parentThreadId: "sample", title: "Audit the ledger", color: agentColor(0), status: "running", mode: "acceptEdits", model: "sonnet", activity: "reading src/context-bar.tsx", startedAt: 0, steps: 14, toolCalls: 9, inputTokens: 24_100, outputTokens: 3_200, generationMs: 21_000 },
  { threadId: "sample-b", parentThreadId: "sample", title: "Sweep the CSS", color: agentColor(1), status: "done", mode: "auto", model: "haiku", activity: "done", startedAt: 0, endedAt: 1, steps: 6, toolCalls: 4, inputTokens: 8_900, outputTokens: 1_100, generationMs: 7_400 },
  /* The agent working in the sub thread below. Not a subagent — no parent — which
     is the whole difference the two rails are drawing. */
  { threadId: "sample-t1", title: "Port the old ledger", color: agentColor(2), status: "running", mode: "acceptEdits", model: "sonnet", activity: "running tests", startedAt: 0, steps: 3, toolCalls: 2, inputTokens: 6_100, outputTokens: 800, generationMs: 5_200 },
];

/* One working and one that has been quiet a while, because "it is still here with
   nothing running in it" is the state this rail exists to show. Dated off the
   clock as the module loads — a written-down stamp would read as "312d" the week
   after it was typed, and reading one during a render is not the preview's to do. */
const sampleStamp = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

const SAMPLE_SUBTHREADS: Thread[] = [
  { ...SAMPLE_THREAD, id: "sample-t1", title: "Port the old ledger", parentThreadId: "sample", updatedAt: sampleStamp(4 * 60_000), messages: [] },
  { ...SAMPLE_THREAD, id: "sample-t2", title: "Check the migration", parentThreadId: "sample", updatedAt: sampleStamp(3 * 3_600_000), messages: [] },
];

/* The turn in the screenshot, near enough: a model call, an MCP selection, the
   tool it picked, and the approval that let it run. Times are relative to zero
   and the waterfall shifts everything anyway, so no clock is read here. */
const SAMPLE_SPANS: TraceSpan[] = [
  { id: "root", name: "Turn", kind: "agent", startedAt: 0, endedAt: 43_170, status: "ok", tokens: 2_400 },
  { id: "m1", parentId: "root", name: "model", kind: "model", startedAt: 120, endedAt: 10_400, status: "ok", tokens: 5_100 },
  { id: "s1", parentId: "root", name: "Selecting tool", kind: "search", startedAt: 10_500, endedAt: 12_600, status: "ok", tokens: 900 },
  { id: "m2", parentId: "root", name: "model", kind: "model", startedAt: 12_700, endedAt: 26_800, status: "ok", tokens: 4_300 },
  { id: "t1", parentId: "root", name: "artifact", kind: "mcp", startedAt: 26_900, endedAt: 32_520, status: "ok", tokens: 6_200 },
  { id: "t2", parentId: "t1", name: "auto agent approved · artifact", kind: "permission", startedAt: 26_910, endedAt: 32_520, status: "ok" },
  { id: "m3", parentId: "root", name: "model", kind: "model", startedAt: 32_600, endedAt: 43_170, status: "ok", tokens: 3_800 },
];

/* One wave done, one running, one still to come — the three states the rows are
   drawn in — and the running step's title is the sample subagent's, so the live
   line under it is the one a real plan shows. */
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

const SAMPLE_GIT: GitSnapshot = {
  branch: "main",
  worktree: false,
  branches: ["main", "context-bar"],
  diff: "diff --git a/desktop/src/context-bar.tsx b/desktop/src/context-bar.tsx\n@@ -1,4 +1,6 @@\n+const sample = true;\n-const sample = false;\n",
  truncated: false,
};

/** The widgets, over the sample thread, at the real width of the bar. */
function usePreviewContext(): WidgetContext {
  const ledger = useContextLedger(SAMPLE_THREAD, SAMPLE_USES, 1_049_000, [], SAMPLE_EXPERIMENTS);
  const sampleTrace = useMemo(() => ({ label: "3:41:42 PM", spans: SAMPLE_SPANS }), []);
  return {
    ledger,
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
  };
}

/** dnd-kit ids. A palette card and a placed widget can share a type, so the side is in the id. */
const paletteId = (type: ContextWidgetType) => `add:${type}`;
const placedType = (id: string) => id.replace(/^add:/, "") as ContextWidgetType;

function GripIcon() {
  return <svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="4" r="1.1" /><circle cx="7.5" cy="4" r="1.1" /><circle cx="2.5" cy="8" r="1.1" /><circle cx="7.5" cy="8" r="1.1" /><circle cx="2.5" cy="12" r="1.1" /><circle cx="7.5" cy="12" r="1.1" /></svg>;
}

/** A component not on this page yet: drag it into the bar, or press it to append. */
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

/** A widget on the page: a handle row that drags it, then the component itself. */
function PlacedWidget({ widget, context, onRemove, onFlip }: { widget: ContextWidget; context: WidgetContext; onRemove: () => void; onFlip: () => void }) {
  const definition = widgetDefinition(widget.type);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: widget.type });
  return <div ref={setNodeRef} className="bar-widget" data-dragging={isDragging || undefined} style={{ transform: CSS.Transform.toString(transform), transition }}>
    <header>
      <button type="button" className="bar-grip" aria-label={`Reorder ${definition.label}`} {...attributes} {...listeners}><GripIcon /></button>
      <span>{definition.label}</span>
      {definition.orientable && <button type="button" className="bar-flip" aria-pressed={widget.orientation === "horizontal"} title={widget.orientation === "horizontal" ? "Laid across — press for one item a line" : "One item a line — press to lay it across"} onClick={onFlip}>{widget.orientation === "horizontal" ? "⇄" : "⇅"}</button>}
      <button type="button" className="bar-drop" aria-label={`Remove ${definition.label} from this page`} onClick={onRemove}>×</button>
    </header>
    {/* The real component, inert: a press in here is aimed at the card, not at
        a dialog the preview has no thread to open. */}
    <div className="bar-widget-body" inert>
      <Widget widget={widget} context={context} />
    </div>
  </div>;
}

/**
 * Settings → Context bar. The bar is arranged by dragging the real components
 * around a column the real width, which is the only honest preview: a widget
 * that overflows 288px overflows here too.
 */
export function ContextBarSettings({ pages, onChange, busy }: { pages: ContextPage[]; onChange: (pages: ContextPage[]) => void; busy: boolean }) {
  const [active, setActive] = useState(pages[0]?.id ?? "p1");
  const [dragging, setDragging] = useState<ContextWidgetType | null>(null);
  const context = usePreviewContext();
  const nameField = useId();
  const page = pages.find((item) => item.id === active) ?? pages[0];
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
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
    {/* The switcher, exactly as it reads in the bar — same tabs, same order, so
        arranging a page and finding it later are the same gesture. */}
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

        {/* The column is `.inspector` so every rule the real bar is drawn with
            applies here without a second stylesheet. */}
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
                  onFlip={() => writePage(page.widgets.map((item) => item.type === widget.type ? { ...item, orientation: item.orientation === "horizontal" ? "vertical" : "horizontal" } : item))}
                />)}
              </SortableContext>
              {!page.widgets.length && <p className="bar-empty">Drag a component in, or press its ＋. An empty page shows the thread's name and nothing else.</p>}
            </div>
          </div>
        </section>
      </div>
      {/* What the pointer carries: the component's name, not a clone of a panel
          that would be wider than the column it is being dragged into. */}
      <DragOverlay dropAnimation={null}>
        {dragging && <div className="bar-ghost"><b aria-hidden="true">{widgetDefinition(dragging).glyph}</b>{widgetDefinition(dragging).label}</div>}
      </DragOverlay>
    </DndContext>
  </div>;
}
