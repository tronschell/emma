import { useEffect, useMemo, useState } from "react";
import WorktreesView from "./WorktreesView";
import { compare, draftProposal, frictionOf, heldBack, lessonShaped, leverNames, lineageOf, metricNames, readTurn, retryDraft, revertLine, room, startTrial, toolOf, MAX_ADDITION_CHARS, MAX_IMPROVEMENTS, MAX_KEPT, MIN_ARM_TURNS, type Comparison, type Draft as Proposal, type Friction, type Improvement, type Stat, type Turn } from "../shared/improvement";
import { readImprovements, readQueue, saveImprovements, saveQueue } from "./improvements";
import { Bars } from "./bars";
import { brandForModel } from "./brands";
import BenchPanel from "./BenchPanel";
import { readBench } from "./bench";
import { benchKin } from "./bench-run";
import { plural } from "./plural";
import { BrandIcon, InfoDot, Mark, ToolMark, TrashIcon } from "./icons";
import { reasonText } from "./errors";
import ActivityView from "./ActivityView";
import type { MemoryNote, Snapshot, Thread } from "./types";
import { day } from "./dates";

const RECENT_THREADS = 40;
const READ_DAYS = 90;
const WINDOWS = [7, 30, 90];
const DAY_MS = 86_400_000;
const MIN_MODEL_TURNS = 3;
const MAX_RAIL_ROWS = 8;

const leverOf = (item: Friction) => lessonShaped(item) ? draftProposal(item).lever : "none";
const leverLabels: Record<string, string> = { instructions: "instructions", verifier: "verifier", none: "not a lesson" };
const saidOf = (text: string) => /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1].replace(/\\"/g, '"') ?? text;

function daily(turns: readonly Turn[], days: number, now: number) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const first = midnight.getTime() - (days - 1) * DAY_MS;
  const all = Array.from({ length: days }, () => 0);
  const bad = Array.from({ length: days }, () => 0);
  for (const turn of turns) {
    const index = Math.floor((turn.at - first) / DAY_MS);
    if (index < 0 || index >= days) continue;
    all[index] += 1;
    if (!turn.ok) bad[index] += 1;
  }
  return { all, rate: all.map((count, index) => count ? (bad[index] / count) * 100 : 0), first };
}

function Spark({ values }: { values: number[] }) {
  const peak = Math.max(1, ...values);
  const step = values.length > 1 ? 100 / (values.length - 1) : 100;
  const points = values.map((value, index) => `${(index * step).toFixed(2)},${(33 - (value / peak) * 31).toFixed(2)}`).join(" ");
  return <svg className="repairs-line" viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">
    <polygon className="repairs-fill" points={`0,34 ${points} 100,34`} />
    <polyline points={points} />
  </svg>;
}

export const per = (value: number) => value.toFixed(2);
const recordLine = (item: Improvement) => item.result || `${leverNames[item.lever]} · ${metricNames[item.metric]}`;
const fromBench = (item: Improvement) => (item.result ?? "").includes("paired case");
const Empty = ({ copy }: { copy: string }) => <div className="empty"><Mark /><p>{copy}</p></div>;

type Act = (method: string, params?: Record<string, string>) => Promise<unknown>;
type Draft = Proposal & { key: string };

let pending: Draft | null = null;

function useTurns(snapshot: Snapshot) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [ready, setReady] = useState(false);
  const threads = useMemo(() => {
    const bench = benchKin(snapshot.threads, readBench().runs.flatMap((run) => run.threads));
    return snapshot.threads
      .filter((thread) => !thread.archivedAt && thread.kind !== "subagent" && !bench.has(thread.id))
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, RECENT_THREADS)
      .map((thread) => ({ id: thread.id, title: thread.title, updatedAt: thread.updatedAt }));
  }, [snapshot.threads]);
  const signature = threads.map((thread) => `${thread.id}:${thread.updatedAt}`).join(",");
  useEffect(() => {
    let live = true;
    const since = Date.now() - READ_DAYS * DAY_MS;
    void Promise.all(threads.map(async (thread) => {
      const traces = await window.emma.threadTraces(thread.id).catch(() => []);
      return traces.map((trace) => readTurn(trace, thread));
    })).then((rows) => {
      if (!live) return;
      setTurns(rows.flat().filter((turn) => turn.at >= since));
      setReady(true);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return { turns, ready, read: threads.length };
}

export default function AgentView({ snapshot, act, busy, openThread, projectName, mode, model }: { snapshot: Snapshot; act: Act; busy: boolean; openThread: (id: string) => void; projectName: (thread: Thread) => string; mode: string; model: string }) {
  const [tab, setTab] = useState<"activity" | "improvement" | "worktrees">("activity");
  const [memories, setMemories] = useState(false);
  const [store, setStore] = useState(readImprovements);
  const [draft, setDraft] = useState<Draft | null>(pending);
  useEffect(() => { pending = draft; }, [draft]);
  const [error, setError] = useState("");
  const [benched, setBenched] = useState(false);
  const [days, setDays] = useState(30);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [ticked, setTicked] = useState<string[]>([]);
  const [queue, setQueue] = useState(readQueue);
  const { turns, ready, read } = useTurns(snapshot);
  const windowed = useMemo(() => {
    const since = Date.now() - days * DAY_MS;
    return turns.filter((turn) => turn.at >= since);
  }, [turns, days]);
  const friction = useMemo(() => frictionOf(windowed), [windowed]);
  const trial = store.items.find((item) => item.state === "trial");
  const superseded = trial ? lineageOf(trial) : "";
  const held = new Set(heldBack(store.items));
  const paused = (item: Improvement) => held.has(item.id) && lineageOf(item) === superseded;
  const kept = store.items.filter((item) => item.state === "kept" && !held.has(item.id));
  const decided = store.items.filter((item) => item.state !== "trial");
  const priors = (title: string) => [...new Map(decided
    .filter((row) => row.title === title)
    .sort((left, right) => (left.decidedAt ?? 0) - (right.decidedAt ?? 0))
    .map((row) => [lineageOf(row), row] as const)).values()];
  const comparison = useMemo(() => trial ? compare(turns, trial) : undefined, [turns, trial]);
  const save = (items: Improvement[]) => setStore(saveImprovements({ items }));
  const badly = windowed.filter((turn) => !turn.ok).length;
  const spread = useMemo(() => daily(windowed, days, Date.now()), [windowed, days]);
  const byTool = useMemo(() => {
    const found = new Map<string, number>();
    for (const turn of windowed) {
      for (const span of turn.spans) {
        if (span.status !== "failed" || span.kind === "agent" || span.kind === "model" || span.kind === "verifier") continue;
        const name = toolOf(span);
        found.set(name, (found.get(name) ?? 0) + 1);
      }
    }
    return [...found.entries()].sort((left, right) => right[1] - left[1]).slice(0, MAX_RAIL_ROWS);
  }, [windowed]);
  const byModel = useMemo(() => {
    const found = new Map<string, { turns: number; bad: number }>();
    for (const turn of windowed) {
      if (!turn.model) continue;
      const row = found.get(turn.model) ?? { turns: 0, bad: 0 };
      row.turns += 1;
      if (!turn.ok) row.bad += 1;
      found.set(turn.model, row);
    }
    return [...found.entries()]
      .filter(([, row]) => row.turns >= MIN_MODEL_TURNS)
      .sort((left, right) => right[1].bad / right[1].turns - left[1].bad / left[1].turns)
      .slice(0, MAX_RAIL_ROWS);
  }, [windowed]);
  const segments = useMemo(() => (["instructions", "verifier", "none"] as const)
    .map((lever) => [lever, friction.filter((item) => leverOf(item) === lever).length] as const)
    .filter(([, count]) => count > 0), [friction]);
  const additionOf = (item: Friction) => texts[item.key] ?? draftProposal(item).addition;
  const picked = friction.filter((item) => ticked.includes(item.key) && lessonShaped(item) && additionOf(item).trim());

  const retry = (item: Improvement) => { setError(""); setDraft({ key: item.id, ...retryDraft(item) }); };
  const start = () => {
    if (!draft?.addition.trim()) return;
    save(startTrial(store.items, draft, Date.now()));
    setDraft(null);
  };
  const decide = (item: Improvement, state: Improvement["state"], result: string) => {
    const items = store.items.map((row) => row.id === item.id ? { ...row, state, decidedAt: Date.now(), result } : row);
    const [next, ...rest] = queue;
    if (next && item.id === trial?.id) {
      setQueue(saveQueue(rest));
      save(startTrial(items, next, Date.now()));
      return;
    }
    save(items);
  };

  const tick = (key: string) => setTicked(ticked.includes(key) ? ticked.filter((row) => row !== key) : [...ticked, key]);
  const queueThem = () => {
    setError("");
    const drafts = picked.map((item) => ({ ...draftProposal(item), addition: additionOf(item).trim() }));
    const [first, ...rest] = drafts;
    if (!trial && first) save(startTrial(store.items, first, Date.now()));
    setQueue(saveQueue([...queue, ...(trial ? drafts : rest)]));
    setTicked([]);
  };

  const handOver = async (item: Friction) => {
    setError("");
    try {
      const thread = await act("createThread") as { id?: string } | undefined;
      if (!thread?.id) throw new Error("Emma could not open a thread for this");
      await act("renameThread", { threadId: thread.id, title: `Fix · ${item.tool}`.slice(0, 120) });
      const answered = await act("sendMessage", { threadId: thread.id, content: briefFor(item) }) as { messages?: { content: string }[] } | undefined;
      const written = (answered?.messages?.at(-1)?.content ?? "").trim().slice(0, MAX_ADDITION_CHARS);
      if (written) setTexts((current) => ({ ...current, [item.key]: written }));
      openThread(thread.id);
    } catch (reason) { setError(reasonText(reason)); }
  };

  return <section className="agent-view">
    <header>
      <div className="agent-head">
        <h2>{tab === "activity" ? "Agent activity" : tab === "worktrees" ? "Worktrees" : "What keeps going wrong"}</h2>
        {tab === "improvement" && <InfoDot>Emma stores a trace of every turn it finishes: each tool call, how long it took, and whether it failed. This page groups the failures from the window you pick, drafts a change about the ones that repeat, and — once you approve it — runs the next turns half with the change and half without. That live split is a hint, not a measurement: it has no fixed size and it moves with every turn, so it can only tell you whether the change is worth a bench run. Keeping a change takes a finished run on the bench below, against cases and a metric declared before the numbers arrive. Reverting takes nothing — dropping a change never needs proof. Nothing here is applied without you, and nothing leaves this computer.</InfoDot>}
        {tab === "activity" && <InfoDot>Everything on this tab is counted from the threads already on this computer: when they ran, which project they belong to, and which of them spawned subagents. Nothing is uploaded and nothing is asked of a model to draw it.</InfoDot>}
      </div>
    </header>

    <div className="plugins-tabs agent-tabs" role="tablist" aria-label="Agent activity, self improvement and worktrees">
      <button type="button" role="tab" aria-selected={tab === "activity"} className={tab === "activity" ? "on" : ""} onClick={() => setTab("activity")}>Agent activity</button>
      <button type="button" role="tab" aria-selected={tab === "improvement"} className={tab === "improvement" ? "on" : ""} onClick={() => setTab("improvement")}>Self improvement</button>
      <button type="button" role="tab" aria-selected={tab === "worktrees"} className={tab === "worktrees" ? "on" : ""} onClick={() => setTab("worktrees")}>Worktrees</button>
      <button type="button" className="agent-memories-open" aria-haspopup="dialog" onClick={() => setMemories(true)}>Memories</button>
    </div>

    {memories && <MemoriesDialog close={() => setMemories(false)} />}

    {tab === "worktrees" && <WorktreesView />}

    {tab === "activity" && <ActivityView snapshot={snapshot} projectName={projectName} openThread={openThread} />}

    {tab === "improvement" && <>

    <div className="repairs">
      <aside className="repairs-rail">
        <div className="repairs-band">
          <span className="repairs-eyebrow">The read</span>
          <h3>Your own runs</h3>
        </div>
        <div className="repairs-band">
          <div className="repairs-window" role="group" aria-label="How far back to read">
            {WINDOWS.map((span) => <button key={span} type="button" className={span === days ? "on" : ""} aria-pressed={span === days} onClick={() => setDays(span)}>{span} days</button>)}
          </div>
        </div>
        <div className="repairs-band">
          <div className="repairs-stat">
            <div className="repairs-head"><span>Turns read</span><b>{windowed.length}</b></div>
            <Bars values={spread.all} labels={spread.all.map((_, index) => day(spread.first + index * DAY_MS))} className="repairs-chart" />
            <small>{day(spread.first)} → {day(Date.now())} · peak {Math.max(0, ...spread.all)}/day</small>
          </div>
          <div className="repairs-stat">
            <div className="repairs-head"><span>Ended badly</span><b>{windowed.length ? Math.round((badly / windowed.length) * 100) : 0}%</b></div>
            <Spark values={spread.rate} />
            <small>{badly} of {windowed.length} {plural(windowed.length, "turn")}</small>
          </div>
          <div className="repairs-stat">
            <div className="repairs-head"><span>Repeating</span><b>{friction.length}</b></div>
            <div className="repairs-seg" aria-hidden="true">
              {segments.map(([lever, count], index) => <i key={lever} className={`repairs-hue-${lever}`} style={{ flex: count, animationDelay: `${index * 90}ms` }} />)}
            </div>
            <div className="repairs-segkey">
              {segments.map(([lever, count]) => <span key={lever}><i className={`repairs-hue-${lever}`} /><span>{leverLabels[lever]}</span><b>{count}</b></span>)}
            </div>
          </div>
          <div className="repairs-stat">
            <div className="repairs-head"><span>Lessons kept</span><b>{kept.length}</b></div>
            <small>{kept.length ? "riding every turn" : "nothing here has been acted on yet"}</small>
          </div>
        </div>
        {byTool.length > 0 && <div className="repairs-band">
          <span className="repairs-eyebrow">Where it failed</span>
          <div className="repairs-rows">
            {byTool.map(([name, count]) => <div key={name}><ToolMark name={name} kind={name} /><span>{name}</span><b>{count}</b></div>)}
          </div>
        </div>}
        {byModel.length > 0 && <div className="repairs-band">
          <span className="repairs-eyebrow">By model</span>
          <div className="repairs-rows">
            {byModel.map(([name, row]) => <div key={name}>
              <BrandIcon brand={brandForModel(name)} className="repairs-mark" />
              <span>{name}</span>
              <b>{Math.round((row.bad / row.turns) * 100)}%</b>
            </div>)}
          </div>
        </div>}
        <div className="repairs-band repairs-foot">
          <button type="button" className="repairs-cta" disabled={busy || benched || !picked.length} onClick={queueThem}>
            {picked.length ? `Queue ${picked.length} ${plural(picked.length, "repair")}` : "Nothing ticked"}
          </button>
          <p className="repairs-note">One trial at a time. Each needs {MIN_ARM_TURNS} paired cases on the bench before it can be kept.</p>
          {(trial || queue.length > 0) && <div className="repairs-queue">
            {trial && <div><span>▸</span><span>{trial.title}</span><small>running</small></div>}
            {queue.map((row, index) => <div key={`${row.title}-${index}`}><span>{index + (trial ? 2 : 1)}</span><span>{row.title}</span><small>waiting</small></div>)}
          </div>}
        </div>
      </aside>

      <div className="repairs-list">
        <header>
          <div><span className="repairs-eyebrow">Friction · read from your own traces</span></div>
          <small>{days} days · {read} recent {plural(read, "thread")} read</small>
        </header>
        {friction.map((item) => {
          const proposal = draftProposal(item);
          const looks = priors(proposal.title);
          const lever = leverOf(item);
          const shaped = lever !== "none";
          const on = ticked.includes(item.key);
          return <details key={item.key}>
            <summary>
              <button type="button" role="checkbox" aria-checked={on} aria-label={`Queue a repair for ${proposal.title}`}
                className={`repairs-tick ${shaped ? on ? "on" : "" : "off"}`} disabled={!shaped}
                onClick={(event) => { event.preventDefault(); tick(item.key); }} />
              <ToolMark name={item.kind === "verifier" ? "verifier" : item.tool} />
              <em className={`repairs-lever repairs-hue-${lever}`}>{leverLabels[lever]}</em>
              <span className="repairs-what">
                <strong>{proposal.title}</strong>
                <small>{item.hits} {plural(item.hits, "call")}{item.evidence[0] ? ` · “${saidOf(item.evidence[0].text)}”` : ""}</small>
              </span>
              <b>{item.turns} {plural(item.turns, "turn")}</b>
            </summary>
            <div className="repairs-body">
              {item.evidence.map((line, index) => <p key={index}>
                <button type="button" className="agent-receipt" onClick={() => openThread(line.threadId)}>{day(line.at)} · {line.thread}</button>
                {line.text || "(nothing was said)"}
              </p>)}
              {shaped ? <>
                <label className="sr-only" htmlFor={`addition-${item.key}`}>What to add. Finish the line, or paste what Emma answered.</label>
                <textarea id={`addition-${item.key}`} value={additionOf(item)} maxLength={MAX_ADDITION_CHARS} rows={4} disabled={busy}
                  onChange={(event) => setTexts({ ...texts, [item.key]: event.target.value })} />
                <dl className="repairs-pair">
                  <div><dt>Goes into</dt><dd>{leverNames[proposal.lever]}</dd></div>
                  <div><dt>Measured by</dt><dd>{metricNames[proposal.metric]}</dd></div>
                </dl>
                <div className="agent-actions">
                  <button type="button" disabled={busy || !additionOf(item).trim()} onClick={() => tick(item.key)}>{on ? "Take it out" : "Add to the queue"}</button>
                  <button type="button" disabled={busy} onClick={() => void handOver(item)}>Ask Emma to write it · 1 turn</button>
                </div>
              </> : <p className="repairs-note">
                Calls you refused, calls you stopped, and commands that merely exited non-zero.
                <InfoDot>Every trial is judged on failed tool calls per turn, and these are failures no standing instruction can remove. Left proposable, the cheapest way for a change to win would be for Emma to stop asking you things. They stay on the page because they are still what the last {days} days cost, and they stay out of the queue because nothing you write would move them.</InfoDot>
              </p>}
              {looks.map((row) => <div key={row.id} className="agent-actions">
                <button type="button" disabled={busy || benched || !!trial || draft?.key === row.id} onClick={() => retry(row)}>Another look at this one</button>
                <small>{row.state} {day(row.decidedAt ?? row.startedAt)} · {recordLine(row)}</small>
              </div>)}
            </div>
          </details>;
        })}
        {!friction.length && <Empty copy={ready
          ? windowed.length ? "Nothing repeated twice." : "No finished turns yet."
          : "Reading traces…"} />}
      </div>
    </div>

    {error && <p className="capability-error" role="alert">{error}</p>}
    {trial && comparison && <TrialPanel trial={trial} comparison={comparison} busy={busy || benched} onDecide={decide} />}
    <BenchPanel snapshot={snapshot} busy={busy} openThread={openThread} mode={mode} model={model} trial={trial} onLive={setBenched} onDecide={decide} />
    {draft && <ProposalPanel draft={draft} full={room(store.items) <= 0} busy={busy || benched} onChange={setDraft} onStart={start} onDiscard={() => setDraft(null)} />}

    {decided.length > 0 && <section className="evidence-table">
      <header><div><span>Decided</span><h3>What Emma changed about itself</h3></div><small>Kept lessons ride every turn</small></header>
      {decided.slice().sort((left, right) => (right.decidedAt ?? 0) - (left.decidedAt ?? 0)).map((item) => <details key={item.id}>
        <summary>
          <span><strong>{paused(item) ? "retesting" : item.state}</strong><small>{item.title}{fromBench(item) ? "" : " · no bench run behind it"}{paused(item) ? " · off while retested" : held.has(item.id) ? ` · past the ${MAX_KEPT}-lesson ceiling` : ""}</small></span>
          <b>{day(item.decidedAt ?? item.startedAt)}</b>
        </summary>
        <p>{item.addition}</p>
        <div className="agent-actions">
          <small>{recordLine(item)}</small>
          <button type="button" disabled={busy || benched || !!trial || draft?.key === item.id} onClick={() => retry(item)}>Try it again</button>
          {item.state === "kept" && <button type="button" disabled={busy || benched} onClick={() => decide(item, "reverted", item.result ?? "")}>Stop using this</button>}
        </div>
      </details>)}
    </section>}
    </>}
  </section>;
}

function MemoriesDialog({ close }: { close: () => void }) {
  const [notes, setNotes] = useState<MemoryNote[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void window.emma.listMemories()
      .then((found) => { if (live) setNotes(found); })
      .catch((reason: unknown) => { if (live) { setError(reasonText(reason)); setNotes([]); } });
    return () => { live = false; };
  }, []);
  const forget = (path: string) => {
    if (!confirm(`Delete ${path}? Emma loses it for good.`)) return;
    setBusy(true);
    setError("");
    void window.emma.deleteMemory(path)
      .then(setNotes)
      .catch((reason: unknown) => setError(reasonText(reason)))
      .finally(() => setBusy(false));
  };
  return <dialog className="modal-backdrop" open aria-labelledby="memories-title"
    onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="agent-dialog memories-dialog">
      <header>
        <div>
          <span>{notes ? `${notes.length} ${plural(notes.length, "file")}` : "Reading…"}</span>
          <h2 id="memories-title">Memories<InfoDot>Emma writes these itself, between conversations, into its own notes directory on this computer. Every turn is handed what is in them. Nothing else reads them and nothing leaves this computer.</InfoDot></h2>
        </div>
        <button type="button" onClick={close} aria-label="Close memories">×</button>
      </header>
      {error && <p className="dialog-error">{error}</p>}
      {notes?.length === 0 && <Empty copy="Emma has written nothing down yet." />}
      {notes?.map((note) => <details key={note.path} className="memory-note">
        <summary>
          <span><strong>{note.path.replace("/memories/", "")}</strong><small>{day(note.updatedAt)} · {Math.max(1, Math.round(note.bytes / 1024))}K</small></span>
          <button type="button" className="artifact-danger" disabled={busy} title={`Delete ${note.path}`} aria-label={`Delete ${note.path}`}
            onClick={(event) => { event.preventDefault(); forget(note.path); }}><TrashIcon /></button>
        </summary>
        <pre>{note.text || "(binary or too large to show)"}</pre>
      </details>)}
    </section>
  </dialog>;
}

function TrialPanel({ trial, comparison, busy, onDecide }: { trial: Improvement; comparison: Comparison; busy: boolean; onDecide: (item: Improvement, state: Improvement["state"], result: string) => void }) {
  const worst = Math.max(comparison.a.mean, comparison.b.mean) || 1;
  const better = comparison.delta !== null && comparison.delta < 0;
  const hint = comparison.waiting ? "TOO EARLY" : comparison.clear ? "WORTH BENCHING" : "NO SIGNAL";
  return <section className="agent-proposal agent-trial">
    <div>
      <span>Trial · hint only, since {day(trial.startedAt)}</span>
      <div className="agent-head">
        <h3>{trial.title}</h3>
        <InfoDot>These two arms are your own turns, split by a coin at the start of each one. Nothing about the split is fixed in advance: its size is whatever the last {READ_DAYS} days happened to give it, the arms are unpaired, and the whole thing is recomputed after every turn, so it flips back and forth and stopping at a flip proves nothing. Read it as a cheap answer to "is this worth a bench run?" and nothing else. A change is kept only on a finished bench run, which fixes its cases and its metric before it sees a number.</InfoDot>
      </div>
      <p>{trial.addition}</p>
      <dl className="agent-trial-arms">
        <Arm label="Without it" stat={comparison.a} worst={worst} />
        <Arm label="With it" stat={comparison.b} worst={worst} />
        <div className="agent-arm"><dt>Δ</dt><dd>
          <b data-delta={comparison.delta === null ? "tie" : better ? "win" : "loss"}>{comparison.delta === null ? "—" : `${comparison.delta > 0 ? "+" : ""}${comparison.delta.toFixed(0)}%`}</b>
          <small>{metricNames[trial.metric]}</small>
        </dd></div>
        <div className="agent-arm"><dt>N</dt><dd><b>{comparison.a.n}/{comparison.b.n}</b><small>not fixed · need {MIN_ARM_TURNS}</small></dd></div>
        <div className="agent-arm"><dt>Hint</dt><dd>
          <b data-delta={comparison.clear ? better ? "win" : "loss" : "tie"}>{hint}</b>
          <small>unpaired · not a verdict</small>
        </dd></div>
      </dl>
    </div>
    <div className="agent-actions">
      <button type="button" disabled={busy} onClick={() => onDecide(trial, "reverted", revertLine(comparison))}>Revert it</button>
      <small>Only a finished bench run keeps a change — save cases below, then Test the trial</small>
    </div>
  </section>;
}

export function Arm({ label, stat, worst, unit = "turn" }: { label: string; stat: Stat; worst: number; unit?: string }) {
  return <div className="agent-arm">
    <dt>{label}</dt>
    <dd>
      <i style={{ width: `${Math.round((stat.mean / worst) * 100)}%` }} aria-hidden="true" />
      <b>{stat.n ? per(stat.mean) : "—"}</b>
      <small>{stat.n} {plural(stat.n, unit)}</small>
    </dd>
  </div>;
}

function ProposalPanel({ draft, full, busy, onChange, onStart, onDiscard }: { draft: Draft; full: boolean; busy: boolean; onChange: (draft: Draft) => void; onStart: () => void; onDiscard: () => void }) {
  return <section className="agent-proposal">
    <div>
      <span>Proposal · {draft.origin ? "another look at a change you already decided" : "a new change"} · nothing is applied until you start it</span>
      <h3>{draft.title}</h3>
      <label className="sr-only" htmlFor="agent-addition">What to add. Finish the line, or paste what Emma answered.</label>
      <textarea id="agent-addition" value={draft.addition} maxLength={1024} rows={5} disabled={busy}
        onChange={(event) => onChange({ ...draft, addition: event.target.value })} />
      <dl className="agent-trial-arms">
        <div className="agent-arm"><dt>Goes into</dt><dd><b>{leverNames[draft.lever]}</b></dd></div>
        <div className="agent-arm"><dt>Measured by</dt><dd><b>{metricNames[draft.metric]}</b></dd></div>
      </dl>
    </div>
    <div className="agent-actions">
      <button type="button" disabled={busy || full || !draft.addition.trim()} onClick={onStart}>Start the trial</button>
      <button type="button" disabled={busy} onClick={onDiscard}>Discard</button>
      {full && <small>{MAX_IMPROVEMENTS} changes on file · stop using one first</small>}
    </div>
  </section>;
}

export function briefFor(friction: Friction): string {
  return [
    "Emma found a pattern in its own past runs and needs one line to fix it. That is you.",
    "",
    friction.kind === "verifier"
      ? `The auto-mode verifier blocked \`${friction.tool}\` in ${friction.turns} ${friction.turns === 1 ? "turn" : "turns"}. What it said each time:`
      : `\`${friction.tool}\` calls failed in ${friction.turns} ${friction.turns === 1 ? "turn" : "turns"}. What came back:`,
    ...friction.evidence.map((line) => `- thread ${line.threadId} — ${line.text}`),
    "",
    "Read those threads' traces with read_trace if you need the whole run.",
    "",
    friction.kind === "verifier"
      ? "Then answer with ONE short rule to add to the verifier's standing rules, saying exactly which case it should clear and which it still must not. Nothing else — no preamble."
      : "Then answer with ONE short instruction, in the second person, that would have prevented it. Nothing else — no preamble.",
    "It will be shown to the user on the Agent page, and if they approve it, it runs against half of the next turns so we can measure whether it helped.",
  ].join("\n");
}
