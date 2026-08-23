/* The Agent page: where Emma works on Emma.
 *
 * Three things, in the order they have to happen. What its own runs keep
 * tripping over, read off the traces every finished turn leaves on its thread.
 * A change to try about one of them, which nobody applies until the user says
 * so. And then the only honest way to find out whether the change helped: run
 * half the turns with it and half without, and compare the two halves.
 *
 * Everything on this page is derived on this Mac from what is already stored
 * here. No model is asked to find the patterns — a pattern the user is being
 * asked to approve had better be one they can check, and every row opens onto
 * the thread and the error it came from.
 */

import { useEffect, useMemo, useState } from "react";
import { compare, draftProposal, frictionOf, leverNames, metricNames, readTurn, resultLine, MIN_ARM_TURNS, type Comparison, type Friction, type Improvement, type Lever, type Metric, type Stat, type Turn } from "../shared/improvement";
import { readImprovements, saveImprovements } from "./improvements";
import { plural } from "./activity";
import { InfoDot } from "./icons";
import { reasonText } from "./errors";
import type { Snapshot } from "./types";
import { zoned } from "./dates";

/* ponytail: the newest threads, not all of them — one IPC per thread, and a
   pattern needs recent turns rather than every turn Emma has ever run. Raise
   both if the page ever has to answer for a quarter. */
const RECENT_THREADS = 40;
const WINDOW_DAYS = 30;

const dayFormat = zoned({ month: "short", day: "numeric" });
const day = (at: number) => at ? dayFormat(new Date(at)) : "—";
const per = (value: number) => value.toFixed(2);
const Empty = ({ copy }: { copy: string }) => <div className="empty"><span className="mark" aria-hidden="true">◇</span><p>{copy}</p></div>;

type Act = (method: string, params?: Record<string, string>) => Promise<unknown>;
type Draft = { key: string; title: string; lever: Lever; metric: Metric; addition: string };

/* ponytail: the open draft lives on the module, not in storage — the page
   unmounts when you go read the thread Emma is writing the fix in, and it has to
   still be here when you come back to paste the answer in. Module scope survives
   that; it does not survive a reload, which is the right amount of memory for
   something nobody has approved yet. */
let pending: Draft | null = null;

/**
 * Every recorded turn of the recent threads, as spans.
 *
 * Keyed on the threads' own timestamps rather than on the snapshot: the snapshot
 * is replaced on every change anywhere in the app, and re-reading forty threads
 * because a knowledge page was renamed would be forty requests for nothing.
 */
function useTurns(snapshot: Snapshot) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [ready, setReady] = useState(false);
  const threads = useMemo(() => snapshot.threads
    // A subagent's spans are inside its parent's trace, so its own thread has none.
    .filter((thread) => !thread.archivedAt && thread.kind !== "subagent")
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, RECENT_THREADS)
    .map((thread) => ({ id: thread.id, title: thread.title, updatedAt: thread.updatedAt })), [snapshot.threads]);
  const signature = threads.map((thread) => `${thread.id}:${thread.updatedAt}`).join(",");
  useEffect(() => {
    let live = true;
    const since = Date.now() - WINDOW_DAYS * 86_400_000;
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
  return { turns, ready };
}

export default function AgentView({ snapshot, act, busy, openThread }: { snapshot: Snapshot; act: Act; busy: boolean; openThread: (id: string) => void }) {
  const [store, setStore] = useState(readImprovements);
  const [draft, setDraft] = useState<Draft | null>(pending);
  useEffect(() => { pending = draft; }, [draft]);
  const [error, setError] = useState("");
  const { turns, ready } = useTurns(snapshot);
  const friction = useMemo(() => frictionOf(turns), [turns]);
  const trial = store.items.find((item) => item.state === "trial");
  const kept = store.items.filter((item) => item.state === "kept");
  const decided = store.items.filter((item) => item.state !== "trial");
  const comparison = useMemo(() => trial ? compare(turns, trial) : undefined, [turns, trial]);
  const save = (items: Improvement[]) => setStore(saveImprovements({ items }));
  const badly = turns.filter((turn) => !turn.ok).length;

  const propose = (item: Friction) => { setError(""); setDraft({ key: item.key, ...draftProposal(item) }); };
  const start = () => {
    if (!draft?.addition.trim()) return;
    save([...store.items, { id: `imp-${Date.now().toString(36)}`, title: draft.title, lever: draft.lever, addition: draft.addition.trim(), metric: draft.metric, startedAt: Date.now(), state: "trial" }]);
    setDraft(null);
  };
  const decide = (item: Improvement, state: Improvement["state"], result?: string) =>
    save(store.items.map((row) => row.id === item.id ? { ...row, state, decidedAt: Date.now(), ...(result ? { result } : {}) } : row));

  /* The other way to write the fix: hand the pattern to Emma in a thread of its
     own, with the receipts, and paste back what it answers. The page drafts a
     skeleton because it can see what happened; what to do instead is the part
     that wants a model — or the user, who may simply know. The proposal is opened
     on the way out, so the box to paste the answer into is already here on return. */
  const handOver = async (item: Friction) => {
    setError("");
    try {
      const thread = await act("createThread") as { id?: string } | undefined;
      if (!thread?.id) throw new Error("Emma could not open a thread for this");
      await act("renameThread", { threadId: thread.id, title: `Fix · ${item.tool}`.slice(0, 120) });
      await act("sendMessage", { threadId: thread.id, content: briefFor(item) });
      if (!trial) propose(item);
      openThread(thread.id);
    } catch (reason) { setError(reasonText(reason)); }
  };

  return <section className="agent-view">
    <header>
      <span>Agent · self-improvement</span>
      <div className="agent-head">
        <h2>What keeps going wrong</h2>
        <InfoDot>Emma stores a trace of every turn it finishes: each tool call, how long it took, and whether it failed. This page groups the failures from the last {WINDOW_DAYS} days, drafts a change about the ones that repeat, and — once you approve it — runs the next turns half with the change and half without, so the two halves can be compared. Nothing here is applied without you, and nothing leaves this Mac.</InfoDot>
      </div>
    </header>

    <div className="agent-metrics">
      <span><b>{turns.length}</b> {plural(turns.length, "turn")} read</span>
      <span><b>{turns.length ? Math.round((badly / turns.length) * 100) : 0}%</b> ended badly</span>
      <span><b>{friction.length}</b> repeating {plural(friction.length, "pattern")}</span>
      <span><b>{kept.length}</b> {plural(kept.length, "lesson")} kept</span>
    </div>

    {error && <p className="capability-error" role="alert">{error}</p>}
    {trial && comparison && <TrialPanel trial={trial} comparison={comparison} busy={busy} onDecide={decide} />}
    {draft && <ProposalPanel draft={draft} busy={busy} onChange={setDraft} onStart={start} onDiscard={() => setDraft(null)} />}

    <section className="evidence-table">
      <header>
        <div><span>Friction · from your own runs</span><h3>Where runs get stuck</h3></div>
        <small>{WINDOW_DAYS} days · {Math.min(RECENT_THREADS, snapshot.threads.length)} recent threads</small>
      </header>
      {friction.map((item) => <details key={item.key}>
        <summary>
          <span><strong>{item.tool}</strong><small>{item.kind === "verifier" ? "blocked by the auto verifier" : "tool call failed"}</small></span>
          <b>{item.turns} {plural(item.turns, "turn")}</b>
        </summary>
        {item.evidence.map((line, index) => <p key={index}>
          <button type="button" className="agent-receipt" onClick={() => openThread(line.threadId)}>{day(line.at)} · {line.thread}</button>
          {line.text || "(nothing was said)"}
        </p>)}
        <div className="agent-actions">
          <button type="button" disabled={busy || !!trial || draft?.key === item.key} onClick={() => propose(item)}>{trial ? "A trial is already running" : "Propose a change"}</button>
          <button type="button" disabled={busy} onClick={() => void handOver(item)}>Ask Emma to write it</button>
        </div>
      </details>)}
      {!friction.length && <Empty copy={ready
        ? turns.length ? `Nothing repeated itself across ${turns.length} ${plural(turns.length, "turn")}. Patterns need to happen twice.` : "No finished turns in this window yet. Emma writes a trace when a turn ends."
        : "Reading the traces…"} />}
    </section>

    {decided.length > 0 && <section className="evidence-table">
      <header><div><span>Decided</span><h3>What Emma changed about itself</h3></div><small>Kept lessons ride every turn</small></header>
      {decided.slice().sort((left, right) => (right.decidedAt ?? 0) - (left.decidedAt ?? 0)).map((item) => <details key={item.id}>
        <summary>
          <span><strong>{item.state}</strong><small>{item.title}</small></span>
          <b>{day(item.decidedAt ?? item.startedAt)}</b>
        </summary>
        <p>{item.addition}</p>
        <div className="agent-actions">
          <small>{item.result || `${leverNames[item.lever]} · ${metricNames[item.metric]}`}</small>
          {item.state === "kept" && <button type="button" disabled={busy} onClick={() => decide(item, "reverted")}>Stop using this</button>}
        </div>
      </details>)}
    </section>}
  </section>;
}

/** The change on trial: both arms, the reading, and the two ways it can end. */
function TrialPanel({ trial, comparison, busy, onDecide }: { trial: Improvement; comparison: Comparison; busy: boolean; onDecide: (item: Improvement, state: Improvement["state"], result: string) => void }) {
  const worst = Math.max(comparison.a.mean, comparison.b.mean) || 1;
  const better = comparison.delta !== null && comparison.delta < 0;
  return <section className="agent-proposal agent-trial">
    <div>
      <span>Trial · running since {day(trial.startedAt)}</span>
      <h3>{trial.title}</h3>
      <p>{trial.addition}</p>
      <dl className="agent-trial-arms">
        <Arm label="Without it" stat={comparison.a} worst={worst} />
        <Arm label="With it" stat={comparison.b} worst={worst} />
      </dl>
      <p className="agent-reading">
        {comparison.waiting
          ? `Too early: ${comparison.waiting}. Each turn takes an arm at random, so both halves fill up on their own.`
          : comparison.clear
            ? `${better ? "Better" : "Worse"} by ${Math.abs(comparison.delta ?? 0).toFixed(0)}% on ${metricNames[trial.metric]}, beyond the spread in both arms.`
            : `${comparison.delta === null ? "No difference to read" : `${Math.abs(comparison.delta).toFixed(0)}% ${better ? "better" : "worse"}`} — but within the noise of ${MIN_ARM_TURNS}+ turns an arm. Leave it running, or decide anyway.`}
      </p>
    </div>
    <div className="agent-actions">
      <button type="button" disabled={busy} onClick={() => onDecide(trial, "kept", resultLine(comparison, true))}>Keep it</button>
      <button type="button" disabled={busy} onClick={() => onDecide(trial, "reverted", resultLine(comparison, false))}>Revert it</button>
    </div>
  </section>;
}

function Arm({ label, stat, worst }: { label: string; stat: Stat; worst: number }) {
  return <div className="agent-arm">
    <dt>{label}</dt>
    <dd>
      <i style={{ width: `${Math.round((stat.mean / worst) * 100)}%` }} aria-hidden="true" />
      <b>{stat.n ? per(stat.mean) : "—"}</b>
      <small>{stat.n} {plural(stat.n, "turn")}</small>
    </dd>
  </div>;
}

/** The draft, editable: what goes in front of the model is text a person read first. */
function ProposalPanel({ draft, busy, onChange, onStart, onDiscard }: { draft: Draft; busy: boolean; onChange: (draft: Draft) => void; onStart: () => void; onDiscard: () => void }) {
  return <section className="agent-proposal">
    <div>
      <span>Proposal · nothing is applied until you start it</span>
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
      <button type="button" disabled={busy || !draft.addition.trim()} onClick={onStart}>Start the trial</button>
      <button type="button" disabled={busy} onClick={onDiscard}>Discard</button>
    </div>
  </section>;
}

/** What Emma is told when the fix is handed to it: the pattern, the receipts, and one job. */
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
