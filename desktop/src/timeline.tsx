/* The turn as a waterfall, in the inspector.

   Read-only, like everything else the renderer shows about a run: main owns the
   loops and writes every span — the run, each request to the model, each tool
   call, each subagent — `shared/trace.ts` owns the geometry and the storage
   format, and this file is the rows, the carets, and the one selected span.

   Two sources, one list: the turn in flight arrives over `onSpans`, and the
   turns before it are read back off the thread, where `recordTrace` put them. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { axisTicks, decodeSpans, formatDuration, layoutSpans, summarizeSpans, tokenAxis, type TraceRow, type TraceSpan } from "../shared/trace";
import { charLabel } from "../shared/usage";
import { ExpandIcon, ToolIcon } from "./icons";

/** How often an open span's bar is re-measured against the clock. */
const TICK_MS = 500;
/** The synthesised root every turn hangs off, so the thread reads as one tree. */
const OVERALL = "overall";
/** What each hue means, spelled out over the expanded waterfall. */
const LEGEND = [["agent", "Agent"], ["model", "Model"], ["tool", "Tool"], ["failed", "Failed"]] as const;
/** Past this much of the axis, a bar's duration has no room to its right. */
const LABEL_AFTER = 78;
/** And it goes to the bar's left instead, if the bar starts this far along. */
const LABEL_BEFORE = 12;
/** The same `1.2k` the context ledger reads in, since a bar is no wider here. */
const tokenLabel = (value: number) => `${charLabel(Math.round(value))} tok`;

type Turn = { key: string; label: string; spans: TraceSpan[]; live: boolean };
/** What the axis measures: how long a span took, or what it left in the window. */
type Axis = "time" | "context";

/**
 * The thread's turns as one waterfall, newest first, under an "Overall" root.
 * Renders nothing until something has run, so it can be mounted unconditionally
 * beside the context ledger.
 */
export function Timeline({ threadId, sending, carriedTokens, sample }: { threadId: string; sending: boolean; carriedTokens: number; sample?: { label: string; spans: TraceSpan[] } }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const [live, setLive] = useState<TraceSpan[]>([]);
  const [fetched, setFetched] = useState<Turn[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [axis, setAxis] = useState<Axis>("time");

  const take = useCallback((trees: Record<string, TraceSpan[]>) => setLive(trees[threadId] ?? []), [threadId]);
  useEffect(() => {
    if (sample) return;
    void window.emma.listSpans().then(take).catch(() => undefined);
    return window.emma.onSpans(take);
  }, [sample, take]);

  // Refetched when the turn ends, because that is when its trace lands on the
  // thread; until then the live spans are the same turn, only fresher.
  useEffect(() => {
    if (sample) return;
    let alive = true;
    void window.emma.threadTraces(threadId)
      .then((traces) => {
        if (!alive) return;
        setFetched(traces
          .map((trace, index): Turn => ({ key: `${trace.timestamp}-${index}`, label: new Date(trace.timestamp).toLocaleTimeString(), spans: decodeSpans(trace.text), live: false }))
          .filter((turn) => turn.spans.length));
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [sample, threadId, sending]);
  // `sample` is the Settings arranger handing over one made-up turn instead: the
  // waterfall you drag around there is this component, not a picture of it, and
  // that page has no thread to read a real trace off.
  const saved = useMemo(() => sample ? [{ key: "sample", label: sample.label, spans: sample.spans, live: false }] : fetched, [sample, fetched]);

  const open = live.some((span) => span.endedAt === undefined);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [open]);

  // One tree for the whole thread: an "Overall" root with every turn under it,
  // so the panel is one list rather than a stack of little ones.
  //
  // Turns are laid end to end rather than at their real clock positions. The
  // gaps between them are the user reading and typing, often hours of it, and
  // an axis that included them would squeeze every bar to a sliver. Within a
  // turn the geometry is exact, which is the part that says where time went.
  // ponytail: gap-collapsed, so the axis is agent time, not wall time. A real
  // wall-clock axis needs zooming to stay readable.
  const turns = useMemo(
    () => live.length ? [...saved, { key: "live", label: sending ? "Running" : "This turn", spans: live, live: true }] : saved,
    [saved, live, sending],
  );

  const { spans, original } = useMemo(() => {
    const original = new Map<string, TraceSpan>();
    const out: TraceSpan[] = [];
    let cursor = 0;
    turns.forEach((turn, index) => {
      // Only a live turn runs to the clock. A stored trace can still hold an
      // open span — a subagent that outlived the turn that spawned it — and
      // closing that against `now` made a finished turn get longer every tick,
      // taking the thread's total with it.
      const close = (span: TraceSpan) => span.endedAt ?? (turn.live ? now : span.startedAt);
      const from = Math.min(...turn.spans.map((span) => span.startedAt));
      const to = Math.max(...turn.spans.map(close));
      const shift = cursor - from;
      for (const span of turn.spans) {
        const id = `${turn.key}/${span.id}`;
        original.set(id, span);
        out.push({
          ...span,
          id,
          // A turn's own root hangs off Overall and says which turn it is; the
          // agent's title is already the row above it.
          parentId: span.parentId ? `${turn.key}/${span.parentId}` : OVERALL,
          name: span.parentId ? span.name : `Turn ${index + 1} · ${turn.label}`,
          startedAt: span.startedAt + shift,
          // Closed against the clock here rather than in the layout, because a
          // shifted axis has no "now" on it.
          endedAt: close(span) + shift,
        });
      }
      // Butted up against the turn before it, so the Overall bar is exactly the
      // sum of the turns and its duration stays a number worth reading.
      cursor = to + shift;
    });
    const running = out.some((span) => original.get(span.id)?.endedAt === undefined);
    // Everything the context ledger counts that no span here can see — the system
    // prompt, the tool schemas, host-retrieved knowledge, and the transcript every
    // step resends — carried on the root as its own share. A span tree can only
    // weigh what these steps produced, so on its own the context axis totalled a
    // fraction of the window and read as if it disagreed with the panel above it.
    // The tail past the last turn's bar is that unseen mass, which is exactly the
    // flame-graph reading a parent's unaccounted remainder already has.
    const grew = out.reduce((sum, span) => sum + (span.tokens ?? 0), 0);
    out.unshift({ id: OVERALL, name: "Overall", kind: "agent", startedAt: 0, endedAt: cursor, status: running ? "running" : "ok", tokens: Math.max(0, carriedTokens - grew) });
    return { spans: out, original };
  }, [turns, now, carriedTokens]);

  // Two readings of one tree. On the context axis a span's bar is what it added
  // to the window rather than how long it took, so a two-second call that read a
  // whole file is a sliver of time and a third of the turn's growth. Only the
  // coordinates change: same rows, same carets, same selected span.
  const measured = useMemo(() => (axis === "context" ? tokenAxis(spans) : spans), [axis, spans]);
  const format = axis === "context" ? tokenLabel : formatDuration;

  // Newest turn first, the rest of the thread below it. Done to the rows rather
  // than to the tree: the layout has to walk a turn in the order it ran.
  const rows = useMemo(() => {
    const laid = layoutSpans(measured, now, collapsed);
    if (!laid.length) return laid;
    const groups: (typeof laid)[] = [];
    for (const row of laid.slice(1)) {
      if (row.depth === 1) groups.push([row]);
      else groups[groups.length - 1]?.push(row);
    }
    return [laid[0], ...groups.reverse().flat()];
  }, [measured, now, collapsed]);
  // On the spans, not the rows: with Overall collapsed there is exactly one row,
  // and that is a folded timeline rather than an empty one.
  if (spans.length < 2) return null;
  const toggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const list = <Rows rows={rows} original={original} now={now} format={format} collapsed={collapsed} toggle={toggle} selected={selected} select={setSelected} />;
  // The root's own extent, in real milliseconds, whichever axis the bars are on:
  // the dialog's stats are clock time even when the waterfall is not.
  const agentMs = (spans[0].endedAt ?? now) - spans[0].startedAt;
  // Offered only when something reported a size. A thread whose turns all predate
  // the field would otherwise switch to an axis on which every bar is zero. The
  // root is skipped: its share is the ledger's residual, which any thread has, so
  // it would offer the axis on evidence the spans themselves never gave.
  const weighed = spans.slice(1).some((span) => span.tokens);

  return <section className="trace" aria-label="Agent timeline">
    {/* The label band stacks over its value like every other inspector section,
        so the expand affordance rides the label row rather than the duration. */}
    <span><span className="trace-title">Timeline{weighed && <span className="trace-axes" role="group" aria-label="What the bars measure">
      <button type="button" aria-pressed={axis === "time"} title="Bars are how long each span took" onClick={() => setAxis("time")}>Time</button>
      <button type="button" aria-pressed={axis === "context"} title="Bars are what each span added to the context window" onClick={() => setAxis("context")}>Context</button>
    </span>}<button type="button" className="trace-expand" aria-haspopup="dialog" aria-label="Expand the timeline" title="Expand the timeline" onClick={() => setExpanded(true)}><ExpandIcon /></button></span><b>{format(rows[0].durationMs)}{open ? " · running" : ""}</b></span>
    <div className="trace-scroll">{list}</div>
    {expanded && <TimelineDialog turns={turns} agentMs={agentMs} axis={axis} total={rows[0].durationMs} format={format} now={now} close={() => setExpanded(false)}>{list}</TimelineDialog>}
  </section>;
}

/** The waterfall itself, drawn the same in the 210px column and in the modal. */
function Rows({ rows, original, now, format, collapsed, toggle, selected, select }: {
  rows: TraceRow[];
  original: Map<string, TraceSpan>;
  now: number;
  /** Reads a bar's extent in whatever the axis is measuring. */
  format: (value: number) => string;
  collapsed: ReadonlySet<string>;
  toggle: (id: string) => void;
  selected?: string;
  select: (id: string | undefined) => void;
}) {
  return <ol className="trace-rows">
    {rows.map(({ span, depth, offset, width, durationMs, children }) => {
      const id = span.id;
      const shut = collapsed.has(id);
      // The three cells past the label are the expanded view's; the column hides
      // them in CSS rather than taking a prop, because they are the same rows.
      //
      // The duration sits after its bar. A bar ending at the right edge has no
      // "after", so it goes before the bar instead — and inside the bar when
      // there is no "before" either, which is the root and only the root.
      const end = offset + width;
      const label = end <= LABEL_AFTER ? { className: "trace-bar-label", style: { left: `${end}%` } }
        : offset >= LABEL_BEFORE ? { className: "trace-bar-label trace-bar-label-before", style: { right: `${100 - offset}%` } }
        : { className: "trace-bar-label trace-bar-label-in", style: { left: `${offset}%` } };
      return <li key={span.id} className="trace-row" data-kind={span.kind === "agent" ? "agent" : span.kind === "model" ? "model" : "tool"} data-status={span.status}>
        {/* Only the label indents. The track keeps the full width so every bar
            is read against the same axis — nesting is depth, not a new axis. */}
        <div className="trace-head" style={{ paddingLeft: `calc(${depth} * var(--s-3))` }}>
          {children > 0
            ? <button type="button" className="trace-caret" aria-expanded={!shut} aria-label={`${shut ? "Expand" : "Collapse"} ${span.name}`} onClick={() => toggle(id)}>{shut ? "▸" : "▾"}</button>
            : <i className="trace-caret" aria-hidden="true" />}
          {children > 0 && <i className="trace-kids" aria-hidden="true">{children}</i>}
          {/* Only a tool call is marked: the run and the model requests are
              the frame a turn is read against, the calls are the work in it. */}
          {span.kind !== "agent" && span.kind !== "model" && <ToolIcon />}
          <button type="button" className="trace-name" aria-pressed={selected === id} title={`${span.name} — ${span.kind} · ${format(durationMs)}`} onClick={() => select(selected === id ? undefined : id)}>{span.name}</button>
          <b>{format(durationMs)}</b>
        </div>
        {/* The kind, not a second name: what a row *did* is the label, what it
            was is the column you scan down. */}
        <span className="trace-op" aria-hidden="true">{span.kind}</span>
        <div className="trace-track" aria-hidden="true">
          <i style={{ left: `${offset}%`, width: `${width}%` }} />
          {/* Duplicated from the head, which the expanded view hides: the
              duration belongs at the end of the bar once there is room for it.
              The name button's title carries it either way, so nothing is lost
              to a screen reader when one of the two is display:none. */}
          <b {...label}>{format(durationMs)}</b>
        </div>
        {/* Under the row it belongs to, not at the foot of the panel: with
            every turn in one scroller, a detail pane down there is nowhere
            near the bar that opened it. */}
        {selected === id && <SpanDetail span={original.get(id) ?? span} now={now} close={() => select(undefined)} />}
      </li>;
    })}
  </ol>;
}

/**
 * The thread's whole life so far: the same waterfall at full width, over the
 * numbers the column has no room for.
 *
 * Read off the raw turns rather than the shifted ones, because this is the one
 * place that wants real clock time — including the gaps the axis collapses.
 */
function TimelineDialog({ turns, agentMs, axis, total, format, now, close, children }: { turns: Turn[]; agentMs: number; axis: Axis; total: number; format: (value: number) => string; now: number; close: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  const dismiss = () => dialog.current?.close();

  const stats = useMemo(() => summarizeSpans(turns.flatMap((turn) => turn.spans), now), [turns, now]);
  if (!stats) return null;

  const wall = stats.to - stats.from;
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="timeline-title" onClose={close} onCancel={(event) => { event.preventDefault(); dismiss(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
    <section className="agent-dialog trace-dialog">
      {/* The two timestamps trail the title: they are the longest strings here
          and the only ones that are context rather than a measurement, so a
          whole stat cell each was two lines of dialog spent on a date. */}
      <header><div><h2 id="timeline-title">Timeline</h2><span>{new Date(stats.from).toLocaleString()} → {new Date(stats.to).toLocaleTimeString()}</span></div><button type="button" onClick={dismiss} aria-label="Close timeline">×</button></header>
      {/* Six short values on one line. Between-turns is lifetime minus agent
          time, which the percentage already says, and the slowest call is the
          head of the tool list right below it. */}
      <dl>
        <div><dt>Turns</dt><dd>{turns.length}</dd></div>
        <div><dt>Lifetime</dt><dd>{formatDuration(wall)}</dd></div>
        <div><dt>Agent time</dt><dd>{formatDuration(agentMs)} · {Math.round((agentMs / Math.max(1, wall)) * 100)}%</dd></div>
        <div><dt>Model requests</dt><dd>{stats.modelRequests}</dd></div>
        <div><dt>Tool calls</dt><dd>{stats.toolCalls}</dd></div>
        <div><dt>Failed spans</dt><dd>{stats.failed}</dd></div>
      </dl>
      {stats.tools.length > 0 && <div className="trace-tools">
        <span>Where tool time went</span>
        <ol>{stats.tools.slice(0, 8).map((tool) => <li key={tool.name}><b title={tool.name}>{tool.name}</b><i>{tool.count}×</i><em>{formatDuration(tool.ms)}</em></li>)}</ol>
      </div>}
      <TimelineAxis total={total} format={format}>{children}</TimelineAxis>
      <p>{axis === "context"
        ? "Bars are the tokens each span put in the window, laid end to end — a step's own share is what its children do not account for. Overall totals the context ledger, so the tail past the last turn is everything assembled below Emma: the system prompt, the tool schemas, retrieved knowledge, and the transcript every step resends. Estimated at four characters a token."
        : "Turns sit end to end on the axis, so the time between them is not to scale — the numbers above are real clock time."}</p>
    </section>
  </dialog>;
}

/**
 * The header the expanded waterfall is read against: what each hue means, the
 * two column names, and the tick labels the bars line up under.
 *
 * The step goes down as a custom property because the ruled grid behind the
 * bars is drawn by each row's own track, which is the only element that already
 * spans exactly the axis.
 */
function TimelineAxis({ total, format, children }: { total: number; format: (value: number) => string; children: React.ReactNode }) {
  // The tick maths is round numbers over a span, which a token count is as much
  // as a duration is; only the labels know which of the two they are reading.
  const { step, marks } = axisTicks(total);
  const whole = Math.max(1, total);
  return <div className="trace trace-dialog-rows" style={{ "--trace-step": `${(step / whole) * 100}%` } as React.CSSProperties}>
    <ul className="trace-legend">
      {LEGEND.map(([kind, label]) => <li key={kind} data-kind={kind}><i aria-hidden="true" />{label}</li>)}
    </ul>
    <div className="trace-axis">
      <span>Span</span>
      <span>Operation</span>
      <div aria-hidden="true">{marks.map((at) => <i key={at} style={{ left: `${(at / whole) * 100}%` }}>{format(at)}</i>)}</div>
    </div>
    {children}
  </div>;
}

/** The clicked span, opened under its own bar: the inspector is one narrow column. */
function SpanDetail({ span, now, close }: { span: TraceSpan; now: number; close: () => void }) {
  return <div className="trace-detail">
    <header><strong title={span.name}>{span.name}</strong><button type="button" onClick={close} aria-label="Close span details">×</button></header>
    <dl>
      <div><dt>Kind</dt><dd>{span.kind}</dd></div>
      <div><dt>State</dt><dd>{span.status}</dd></div>
      <div><dt>Start</dt><dd>{new Date(span.startedAt).toLocaleTimeString()}</dd></div>
      <div><dt>Took</dt><dd>{formatDuration((span.endedAt ?? now) - span.startedAt)}</dd></div>
      {/* Its own, not its subtree's: what this one step put in the window. */}
      {span.tokens !== undefined && <div><dt>Context</dt><dd>+{tokenLabel(span.tokens)}</dd></div>}
    </dl>
    {span.input !== undefined && <><span>Input</span><pre>{span.input}</pre></>}
    <span>Output</span>
    <pre>{span.output ?? (span.endedAt === undefined ? "Still running." : "This span reported no output.")}</pre>
  </div>;
}
