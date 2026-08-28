import { useEffect, useMemo, useState } from "react";
import { attemptsOf, benchLine, benchMetricNames, paired, pairsOf, provenCount, runArms, runComplete, runExpected, runMetric, scoreboard, MAX_BENCH_CASES, MAX_BENCH_PROMPT_CHARS, MIN_BENCH_PAIRS, type BenchMetric, type BenchRun } from "../shared/bench";
import { readBench, saveBench, sweepBench } from "./bench";
import { benchBlocker, driveBench, stopBench, type BenchProgress } from "./bench-run";
import { Arm, per } from "./AgentView";
import { threadFolders } from "./context";
import { readImprovements } from "./improvements";
import { plural } from "./plural";
import { InfoDot, Mark } from "./icons";
import { reasonText } from "./errors";
import { attemptIds, stat, type Improvement } from "../shared/improvement";
import type { FolderGrant } from "../shared/folders";
import type { Snapshot } from "./types";
import { day } from "./dates";

const BENCH_THREADS = 40;
const METRICS = Object.keys(benchMetricNames) as BenchMetric[];

const tick = (value: number) => value > 0 ? `+${value}` : String(value);
const lean = (value: number) => value < 0 ? "win" : value > 0 ? "loss" : "tie";
const call = (verdict: string) => verdict === "improved" ? "win" : verdict === "regressed" ? "loss" : "tie";

const Row = ({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: string }) =>
  <div className="agent-arm"><dt>{label}</dt><dd><b data-delta={tone}>{value}</b>{note && <small>{note}</small>}</dd></div>;

export default function BenchPanel({ snapshot, busy, openThread, mode, model, trial, onLive, onDecide }: {
  snapshot: Snapshot;
  busy: boolean;
  openThread: (id: string) => void;
  mode: string;
  model: string;
  trial: Improvement | undefined;
  onLive: (live: boolean) => void;
  onDecide: (item: Improvement, state: Improvement["state"], result: string) => void;
}) {
  const [store, setStore] = useState(sweepBench);
  const [folders, setFolders] = useState<FolderGrant[] | null>(null);
  const [progress, setProgress] = useState<BenchProgress | null>(null);
  const [choice, setChoice] = useState<BenchMetric>("failed");
  const [pick, setPick] = useState("");
  const [error, setError] = useState("");

  const harvestable = useMemo(() => snapshot.threads
    .filter((thread) => !thread.archivedAt && thread.kind !== "subagent")
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, BENCH_THREADS), [snapshot.threads]);

  useEffect(() => { void window.emma.listFolders().then(setFolders).catch(() => setFolders([])); }, []);

  const live = store.runs.find((row) => row.state === "running");
  const pending = trial ? attemptsOf(store.runs, [trial.id]).at(-1) : undefined;
  const run = live ?? pending ?? store.runs.at(-1);
  const liveId = live?.id ?? "";
  const metric = run ? runMetric(run) : choice;

  useEffect(() => {
    if (!liveId) return;
    const timer = setInterval(() => setStore(readBench()), 500);
    return () => { clearInterval(timer); };
  }, [liveId]);

  useEffect(() => { onLive(!!liveId); }, [liveId, onLive]);

  const reading = useMemo(() => run ? paired(run, metric) : undefined, [run, metric]);
  const deltas = useMemo(() => run?.state === "done" && run.improvementId ? pairsOf(run, metric) : [], [run, metric]);
  const items = readImprovements().items;
  const measured = run?.improvementId ? items.find((row) => row.id === run.improvementId) : undefined;
  const family = attemptIds(items, run?.improvementId ?? "");
  const attempts = attemptsOf(store.runs, family);
  const curves = useMemo(() => METRICS
    .map((key) => ({ metric: key, points: scoreboard(store.runs, key, { mode, model }) }))
    .sort((left, right) => right.points.length - left.points.length || (right.points.at(-1)?.at ?? 0) - (left.points.at(-1)?.at ?? 0)), [store.runs, mode, model]);
  const points = curves[0].points;
  const curve = points.length ? curves[0].metric : choice;
  const proven = provenCount(items);

  const caseTitle = (id: string) => store.cases.find((row) => row.id === id)?.title ?? "removed case";
  const saved = (id: string) => store.cases.some((row) => row.fromThreadId === id);
  const folderName = (id: string) => folders?.find((row) => row.id === id)?.name ?? "no folder";
  const patch = (runId: string, next: (row: BenchRun) => BenchRun) => {
    const current = readBench();
    setStore(saveBench({ ...current, runs: current.runs.map((row) => row.id === runId ? next(row) : row) }));
  };

  const start = async (improvement: Improvement | undefined) => {
    setError("");
    const cases = store.cases;
    const grants = await window.emma.listFolders().catch(() => []);
    setFolders(grants);
    const refusal = benchBlocker(cases, mode, grants);
    if (refusal) { setError(refusal); return; }
    const current = readBench();
    const next: BenchRun = { id: `run-${Date.now().toString(36)}`, improvementId: improvement?.id ?? "", attempt: improvement ? Math.max(0, ...attemptsOf(current.runs, [improvement.id]).map((row) => row.attempt)) + 1 : 0, metric: improvement?.metric ?? choice, mode, model, startedAt: Date.now(), plannedCases: cases.length, caseIds: cases.map((row) => row.id), threads: [], state: "running", results: [] };
    setStore(saveBench({ ...current, runs: [...current.runs, next] }));
    await driveBench({
      run: next,
      cases,
      onThread: (runId, threadId) => patch(runId, (row) => ({ ...row, threads: [...row.threads, threadId] })),
      onResult: (runId, value) => patch(runId, (row) => ({ ...row, results: [...row.results, value] })),
      onProgress: setProgress,
    }).catch((reason: unknown) => setError(reasonText(reason)))
      .finally(() => {
        patch(next.id, (row) => ({ ...row, state: runComplete(row) ? "done" : "stopped", finishedAt: Date.now() }));
        setProgress(null);
      });
  };

  const harvest = () => {
    setError("");
    const thread = harvestable.find((row) => row.id === pick);
    const prompt = thread?.messages.find((message) => message.role === "user")?.content.trim() ?? "";
    const folderId = thread ? threadFolders(thread.id)[0] ?? "" : "";
    if (!thread || !prompt) { setError("That thread has no prompt."); return; }
    if (!folderId) { setError("That thread has no folder."); return; }
    const current = readBench();
    if (current.cases.some((row) => row.fromThreadId === thread.id)) { setError("That thread is already a case."); return; }
    if (current.cases.length >= MAX_BENCH_CASES) { setError(`The bench holds ${MAX_BENCH_CASES} cases. Remove one first.`); return; }
    setStore(saveBench({ ...current, cases: [...current.cases, { id: `case-${Date.now().toString(36)}`, title: thread.title, prompt: prompt.slice(0, MAX_BENCH_PROMPT_CHARS), folderId, fromThreadId: thread.id, createdAt: Date.now() }] }));
  };

  const drop = (id: string) => {
    const current = readBench();
    setStore(saveBench({ ...current, cases: current.cases.filter((row) => row.id !== id) }));
  };

  const done = progress?.done ?? live?.results.length ?? 0;
  const total = progress?.total ?? (run ? runExpected(run) : 0);
  const arms = run ? runArms(run) : 2;
  const stage = progress?.arm ?? (done % arms ? "b" : "a");
  const caseNo = run ? Math.min(Math.floor(done / arms) + 1, Math.max(run.plannedCases, 1)) : 0;
  const worst = reading ? Math.max(reading.a.mean, reading.b.mean) || 1 : 1;
  const swing = Math.max(...deltas.map((pair) => Math.abs(pair.d)), 1);
  const crest = Math.max(...points.map((point) => point.mean), 1);
  const baseline = run && !run.improvementId ? stat(run.results.filter((row) => row.arm === "a").map((row) => row[metric])) : undefined;
  const look = trial?.look ?? 0;
  const ready = store.cases.length >= MIN_BENCH_PAIRS;
  const full = store.cases.length >= MAX_BENCH_CASES;
  const blocker = folders ? benchBlocker(store.cases, mode, folders) : "Reading your folders.";

  return <>
    <section className="evidence-table">
      <header>
        <div><span>Bench · your own cases, replayed</span><div className="agent-head"><h3>Proof by replay</h3><InfoDot>A case is one prompt from one of your threads, replayed under both arms back to back so each pair cancels the day it ran on. The verdict needs a paired t-test and a sign test to agree, and it needs {MIN_BENCH_PAIRS} pairs: below six one-way cases the exact sign-test p is 2/2^m, which cannot reach 0.05 however clean the result. A run declares its cases and its metric up front and is read only under that metric, once it is over, so there is nothing to stop early for and nothing to shop for afterwards. Re-running a trial does not replace the last attempt; every attempt is listed, because the fourth try clearing at p=0.05 is one run in twenty, not proof. Cases, runs and verdicts stay on this Mac.</InfoDot></div></div>
      </header>

      <div className="agent-metrics">
        <span><b>{store.cases.length}</b> {plural(store.cases.length, "case")}</span>
        <span><b>{store.runs.length}</b> {plural(store.runs.length, "run")}</span>
        <span><b>{points.at(-1) ? per(points.at(-1)!.mean) : "—"}</b> {benchMetricNames[curve]}</span>
        <span><b>{proven}</b> proven</span>
      </div>

      {error && <p className="capability-error" role="alert">{error}</p>}

      <div className="agent-actions">
        <select aria-label="Thread to save as a case" value={pick} disabled={busy || !!live} onChange={(event) => setPick(event.target.value)}>
          <option value="">Pick a thread</option>
          {harvestable.map((thread) => <option key={thread.id} value={thread.id} disabled={saved(thread.id)}>{thread.title}{saved(thread.id) ? " · saved" : ""}</option>)}
        </select>
        <button type="button" disabled={busy || !pick || !!live || full} onClick={harvest}>Save as case</button>
        {full && <small>{store.cases.length}/{MAX_BENCH_CASES} · remove one first</small>}
      </div>

      {store.cases.map((item) => <details key={item.id}>
        <summary>
          <span><strong>{folderName(item.folderId)}</strong><small title={item.title}>{item.title}</small></span>
        </summary>
        <p>{item.prompt}</p>
        <div className="agent-actions">
          <button type="button" className="agent-receipt" onClick={() => openThread(item.fromThreadId)}>{day(item.createdAt)} · source thread</button>
          <button type="button" disabled={busy || !!live} onClick={() => drop(item.id)}>Remove</button>
        </div>
      </details>)}
      {!store.cases.length && <div className="empty"><Mark /><p>No cases saved yet.</p></div>}

      <div className="agent-actions">
        <button type="button" disabled={busy || !!live || !ready || !!blocker} onClick={() => void start(undefined)}>Run the bench · {store.cases.length} {plural(store.cases.length, "turn")}</button>
        <button type="button" disabled={busy || !!live || !ready || !!blocker || !trial} onClick={() => void start(trial)}>Test the trial{look > 1 ? ` · attempt ${look}` : ""} · {store.cases.length * 2} {plural(store.cases.length * 2, "turn")}</button>
        <small>Next run</small>
        <select aria-label="Metric the next baseline run is stamped with" value={choice} disabled={busy || !!live} onChange={(event) => setChoice(event.target.value as BenchMetric)}>
          {Object.entries(benchMetricNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        {!ready ? <small>{store.cases.length} need {MIN_BENCH_PAIRS}</small> : blocker ? <small>{blocker}</small> : null}
      </div>
    </section>

    {run && <section className="agent-proposal agent-trial">
      <div>
        <span>{live ? `Run · ${done}/${total}` : `Run · ${day(run.finishedAt ?? run.startedAt)}`}{run.attempt > 1 ? ` · attempt ${run.attempt}` : ""}</span>
        <h3>{run.improvementId ? measured?.title ?? "Paired run" : "Baseline"}</h3>
        {live
          ? <>
            <div className="goal-bar" role="img" aria-label={`${done} of ${total} case runs done`}><i style={{ inlineSize: `${total ? Math.round((done / total) * 100) : 0}%` }} /></div>
            <dl className="agent-trial-arms">
              <Row label="Case" value={`${caseNo}/${run.plannedCases}`} note={progress?.caseTitle || caseTitle(run.caseIds[caseNo - 1] ?? "")} />
              <Row label="Arm" value={run.improvementId ? stage === "a" ? "WITHOUT IT" : "WITH IT" : "BASELINE"} />
              <Row label="Metric" value={benchMetricNames[metric].toUpperCase()} />
            </dl>
          </>
          : run.state !== "done" || !reading
            ? <dl className="agent-trial-arms">
              <Row label="Run" value="STOPPED" tone="tie" />
              <Row label="Cases" value={`${run.results.length}/${runExpected(run)}`} />
              <Row label="Read as" value={benchMetricNames[metric].toUpperCase()} />
            </dl>
            : <dl className="agent-trial-arms">
              {run.improvementId ? <>
                <Arm label="Without it" stat={reading.a} worst={worst} unit="case" />
                <Arm label="With it" stat={reading.b} worst={worst} unit="case" />
                <Row label="Δ" value={reading.n ? tick(Number(reading.d.mean.toFixed(2))) : "—"} note={reading.t === null ? "±—" : `±${per(reading.ci)}`} />
                <Row label="T" value={reading.t === null ? "—" : per(reading.t)} note={reading.t === null ? "no spread · sign test only" : `crit ${per(reading.tCritical)} · df ${Math.max(0, reading.n - 1)}`} />
                <Row label="Sign" value={`+${reading.wins} −${reading.losses} =${reading.ties}`} note={`p=${reading.signP.toFixed(3)}`} />
                <Row label="Pairs" value={String(reading.n)} note={reading.short} />
                <Row label="Metric" value={benchMetricNames[metric].toUpperCase()} />
                <Row label="Verdict" value={reading.verdict.toUpperCase()} tone={call(reading.verdict)} />
              </> : <>
                <Row label="Baseline" value={baseline?.n ? per(baseline.mean) : "—"} note={`${benchMetricNames[metric]} · ${baseline?.n ?? 0} ${plural(baseline?.n ?? 0, "case")}`} />
                <Row label="Cases" value={String(run.results.length)} />
              </>}
            </dl>}
        {!live && attempts.length > 1 && <dl className="agent-trial-arms">
          {attempts.map((row) => {
            const read = paired(row, runMetric(row));
            return <Row key={row.id} label={`Attempt ${row.attempt}`} value={read.verdict.toUpperCase()} note={`n=${read.n} · ${benchMetricNames[runMetric(row)]}`} tone={call(read.verdict)} />;
          })}
        </dl>}
      </div>
      {live
        ? <div className="agent-actions"><button type="button" onClick={stopBench}>Stop</button></div>
        : trial && reading && run.improvementId === trial.id && run.state === "done" && <div className="agent-actions">
          <button type="button" disabled={busy} onClick={() => onDecide(trial, "kept", benchLine(run, true))}>Keep it</button>
          <button type="button" disabled={busy} onClick={() => onDecide(trial, "reverted", benchLine(run, false))}>Revert it</button>
        </div>}
    </section>}

    {deltas.length > 0 && <ol className="bench-deltas" aria-label={`per case · ${benchMetricNames[metric]}`}>
      {deltas.map((pair) => <li key={pair.caseId}>
        <span title={caseTitle(pair.caseId)}>{caseTitle(pair.caseId)}</span>
        <div><i data-lean={lean(pair.d)} style={pair.d ? { width: `${Math.round((Math.abs(pair.d) / swing) * 50)}%` } : undefined} aria-hidden="true" /></div>
        <b>{tick(pair.d)}</b>
      </li>)}
    </ol>}

    {points.length > 1 && <section className="evidence-table">
      <header>
        <div><span>Baseline · arm A only</span><h3>Emma over time</h3></div>
        <small>{benchMetricNames[curve]} · {points[0].n} shared {plural(points[0].n, "case")} · {mode} · {model}</small>
      </header>
      <div className="rate-curve">
        <ol>{points.map((point) => <li key={point.runId}>
          <span>{day(point.at)}</span>
          <i data-empty={point.mean ? undefined : true} style={{ width: `${Math.round((point.mean / crest) * 100)}%` }} />
          <b>{per(point.mean)}</b>
        </li>)}</ol>
      </div>
    </section>}
  </>;
}
