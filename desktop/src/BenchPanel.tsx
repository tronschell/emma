import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { attemptsOf, benchLine, benchMetricNames, boardFrontier, boardMetricNames, boardValue, cellMetricNames, exampleBench, modelBoard, paired, placeLabels, pairsOf, provenCount, runArms, runExpected, runMetric, runName, scoreboard, MAX_BENCH_CASES, MAX_BENCH_RUBRIC_CHARS, MIN_BENCH_PAIRS, type BenchMetric, type BoardCell, type BoardMetric, type BoardRow, type CellMetric } from "../shared/bench";
import { formulaSafe, toCsv } from "../shared/csv";
import { addBenchCase, readBench, saveBench, startBench, sweepBench } from "./bench";
import { benchBlocker, stopBench, type BenchProgress } from "./bench-run";
import { Arm, per } from "./AgentView";
import { threadFolders } from "./context";
import { readImprovements } from "./improvements";
import { plural } from "./plural";
import { BrandIcon, InfoDot } from "./icons";
import { brandForModel, brandForProvider, type BrandDefinition } from "./brands";
import { brandRenderData } from "./brand-data";
import { reasonText } from "./errors";
import { attemptIds, stat, type Improvement } from "../shared/improvement";
import type { FolderGrant } from "../shared/folders";
import type { Snapshot, Thread } from "./types";
import { threadTitle } from "./threads";
import type { VerifierSettings } from "../shared/settings";
import { day } from "./dates";

const BENCH_THREADS = 200;
const METRICS = Object.keys(benchMetricNames) as BenchMetric[];

const tick = (value: number) => value > 0 ? `+${value}` : String(value);
const lean = (value: number) => value < 0 ? "win" : value > 0 ? "loss" : "tie";
const call = (verdict: string) => verdict === "improved" ? "win" : verdict === "regressed" ? "loss" : "tie";

const HUES = ["var(--teal)", "var(--lime)", "var(--violet)", "var(--blue)", "var(--rose)", "var(--yellow)", "var(--orange)"];
const BOARD_METRICS = Object.keys(boardMetricNames) as BoardMetric[];
const CELL_METRICS = Object.keys(cellMetricNames) as CellMetric[];

const usd = (micro: number) => `$${(micro / 1e6).toFixed(micro < 1e6 ? 3 : 2)}`;
const span = (ms: number) => ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;
const thousands = (value: number) => value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value));
const brandOf = (row: BoardRow): BrandDefinition | undefined => row.brand ? brandForProvider(row.brand) : brandForModel(row.model.split("@")[0]);

export type BenchPickers = {
  run: (model: string, effort: string, onPick: (next: { model: string; effort: string }) => void, busy: boolean) => ReactNode;
  judge: (draft: VerifierSettings | undefined, onChange: (next: VerifierSettings | undefined) => void, busy: boolean) => ReactNode;
  describe: (model: string) => { label: string; brand: string };
};
const LABEL_CHAR = 6.2;

const show = (metric: BoardMetric | CellMetric, value: number | null): string =>
  value === null ? "—"
    : metric === "judge" ? value.toFixed(2)
      : metric === "cost" || metric === "perCase" ? usd(value)
        : metric === "ms" ? span(value)
          : metric === "tokens" || metric === "out" ? thousands(value)
            : String(Math.round(value));

const cellValue = (cell: BoardCell, metric: CellMetric): number | null => metric === "judge" ? cell.judge : cell[metric];

function Scatter({ rows, x, y, hue, front, chart }: {
  rows: readonly BoardRow[];
  x: BoardMetric;
  y: BoardMetric;
  hue: (model: string) => string;
  front: Set<string>;
  chart: "scatter" | "bars";
}) {
  const width = 700;
  const height = 300;
  const left = 56;
  const right = 104;
  const top = 20;
  const foot = 36;
  const plotWidth = width - left - right;
  const plotHeight = height - top - foot;
  const ceiling = (metric: BoardMetric) => metric === "judge" ? 1 : Math.max(...rows.map((row) => boardValue(row, metric)), 1) * 1.15;
  const xMax = ceiling(x);
  const yMax = ceiling(y);
  const atX = (value: number) => left + (value / xMax) * plotWidth;
  const atY = (value: number) => top + plotHeight - (value / yMax) * plotHeight;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const ordered = [...rows].sort((one, two) => boardValue(one, x) - boardValue(two, x));
  const path = ordered.filter((row) => front.has(row.model)).map((row, index) => `${index ? "L" : "M"}${atX(boardValue(row, x)).toFixed(1)} ${atY(boardValue(row, y)).toFixed(1)}`).join(" ");
  const bars = [...rows].sort((one, two) => boardValue(two, y) - boardValue(one, y));
  const band = plotHeight / Math.max(bars.length, 1);
  const labels = new Map(placeLabels(
    rows.map((row) => ({ id: row.model, x: atX(boardValue(row, x)), y: atY(boardValue(row, y)), width: row.name.length * LABEL_CHAR })),
    ordered.filter((row) => front.has(row.model)).map((row) => row.model),
    { left: left - 40, right: width, top: 0, bottom: height - foot + 8 },
  ).map((box) => [box.id, box]));
  const Glyph = ({ cx, cy, row }: { cx: number; cy: number; row: BoardRow }) => {
    const src = brandRenderData(brandOf(row)).src;
    return <>
      <circle cx={cx} cy={cy} r="9" fill="var(--bg)" stroke={hue(row.model)} strokeWidth="2" />
      {src ? <image href={src} x={cx - 5.5} y={cy - 5.5} width="11" height="11" preserveAspectRatio="xMidYMid meet" /> : <circle cx={cx} cy={cy} r="3.5" fill={hue(row.model)} />}
    </>;
  };

  return <svg className="bench-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${boardMetricNames[y]} against ${boardMetricNames[x]} for ${rows.length} models`}>
    {ticks.map((share) => <g key={share}>
      <line x1={left} x2={width - right} y1={atY(yMax * share)} y2={atY(yMax * share)} stroke="var(--border)" strokeWidth="1" />
      <text x={left - 8} y={atY(yMax * share) + 3} textAnchor="end" className="bench-tick">{show(y, yMax * share)}</text>
    </g>)}
    {chart === "bars"
      ? bars.map((row, index) => <g key={row.model}>
        <rect x={left} y={top + index * band + band * 0.2} width={Math.max(2, (boardValue(row, y) / yMax) * plotWidth)} height={band * 0.6} fill={hue(row.model)} opacity={front.has(row.model) ? 1 : 0.4} />
        <Glyph cx={left + Math.max(2, (boardValue(row, y) / yMax) * plotWidth) + 14} cy={top + index * band + band * 0.5} row={row} />
        <text x={left + Math.max(2, (boardValue(row, y) / yMax) * plotWidth) + 28} y={top + index * band + band * 0.5 + 4} className="bench-point">{row.name} · {show(y, boardValue(row, y))}</text>
      </g>)
      : <>
        {path && <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3" />}
        {rows.map((row) => {
          const cx = atX(boardValue(row, x));
          const cy = atY(boardValue(row, y));
          const on = front.has(row.model);
          const label = labels.get(row.model);
          return <g key={row.model} opacity={on ? 1 : 0.45}>
            <Glyph cx={cx} cy={cy} row={row} />
            <text x={label?.x ?? cx + 12} y={label?.y ?? cy + 4} textAnchor={label?.anchor ?? "start"} className="bench-point">{row.name}</text>
          </g>;
        })}
      </>}
    <line x1={left} x2={width - right} y1={top + plotHeight} y2={top + plotHeight} stroke="var(--border-strong)" strokeWidth="1" />
    <text x={left} y={height - 8} className="bench-tick">{chart === "bars" ? boardMetricNames[y] : `${boardMetricNames[x]} · 0 to ${show(x, xMax)}`}</text>
  </svg>;
}

const Row = ({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: string }) =>
  <div className="agent-arm"><dt>{label}</dt><dd><b data-delta={tone}>{value}</b>{note && <small>{note}</small>}</dd></div>;

export default function BenchPanel({ snapshot, busy, openThread, mode, model, pickers, trial, onLive, onDecide }: {
  snapshot: Snapshot;
  busy: boolean;
  openThread: (id: string) => void;
  mode: string;
  model: string;
  pickers: BenchPickers;
  trial: Improvement | undefined;
  onLive: (live: boolean) => void;
  onDecide: (item: Improvement, state: Improvement["state"], result: string) => void;
}) {
  const [store, setStore] = useState(sweepBench);
  const [folders, setFolders] = useState<FolderGrant[] | null>(null);
  const [progress, setProgress] = useState<BenchProgress | null>(null);
  const [choice, setChoice] = useState<BenchMetric>("failed");
  const [pick, setPick] = useState("");
  const [rubric, setRubric] = useState("");
  const [runModel, setRunModel] = useState(model);
  const [runEffort, setRunEffort] = useState("");
  const [xAxis, setXAxis] = useState<BoardMetric>("perCase");
  const [yAxis, setYAxis] = useState<BoardMetric>("judge");
  const [chart, setChart] = useState<"scatter" | "bars">("scatter");
  const [cell, setCell] = useState<CellMetric>("judge");
  const [example, setExample] = useState(false);
  const [judgeNote, setJudgeNote] = useState("");
  const [error, setError] = useState("");
  const starting = useRef(false);

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

  useEffect(() => { onLive(!!liveId); return () => onLive(false); }, [liveId, onLive]);

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
  const shown = useMemo(() => example ? exampleBench() : store, [example, store]);
  const board = useMemo(() => modelBoard(shown.runs, shown.cases), [shown]);
  const x: BoardMetric = xAxis === "perCase" && board.rows.length > 0 && board.rows.every((row) => !boardValue(row, "perCase")) ? "tokens" : xAxis;
  const front = useMemo(() => boardFrontier(board.rows, x, yAxis), [board.rows, x, yAxis]);
  const hues = useMemo(() => new Map(board.rows.map((row, index) => [row.model, HUES[index % HUES.length]])), [board.rows]);
  const hue = (name: string) => hues.get(name) ?? "var(--text-3)";
  const best = (key: BoardMetric) => Math.max(...board.rows.map((row) => boardValue(row, key)), 0);
  const least = (key: BoardMetric) => Math.min(...board.rows.map((row) => boardValue(row, key)));
  const shareOf = (row: BoardRow, key: BoardMetric) => {
    const value = boardValue(row, key);
    if (!value) return key === "judge" ? 0 : 100;
    return Math.round(Math.min(1, key === "judge" ? value / (best(key) || 1) : least(key) / value) * 100);
  };
  const leader = board.rows[0];

  const caseTitle = (id: string) => shown.cases.find((row) => row.id === id)?.title ?? "removed case";
  const saved = (id: string) => store.cases.some((row) => row.fromThreadId === id);
  const folderName = (id: string) => folders?.find((row) => row.id === id)?.name ?? "no folder";
  const start = async (improvement: Improvement | undefined, under = model, effort = "") => {
    if (starting.current) return;
    starting.current = true;
    setError("");
    setJudgeNote("");
    const cases = store.cases;
    const grants = await window.emma.listFolders().catch(() => []);
    setFolders(grants);
    const refusal = benchBlocker(cases, mode, grants);
    if (refusal || readBench().runs.some((row) => row.state === "running")) { starting.current = false; setError(refusal || "A bench is already running."); return; }
    const current = readBench();
    starting.current = false;
    try {
      await startBench({
        cases,
        metric: improvement?.metric ?? choice,
        mode,
        model: under,
        ...(effort ? { effort } : {}),
        ...(improvement ? { improvement } : {}),
        describe: pickers.describe(under),
        ...(current.judge ? { judge: current.judge } : {}),
        onStore: setStore,
        onProgress: setProgress,
        onJudgeError: setJudgeNote,
      }).finished;
    } catch (reason: unknown) { setError(reasonText(reason)); }
  };

  const harvest = async () => {
    setError("");
    const summary = harvestable.find((row) => row.id === pick);
    const thread = summary ? await window.emma.request<{ id: string; title: string; messages: { role: string; content: string }[] }>("thread", { threadId: pick }).catch(() => undefined) : undefined;
    const prompt = thread?.messages.find((message) => message.role === "user")?.content.trim() ?? "";
    const folderId = thread ? threadFolders(thread.id)[0] ?? "" : "";
    if (!thread || !prompt) { setError("That thread has no prompt."); return; }
    if (!folderId) { setError("That thread has no folder."); return; }
    const current = readBench();
    if (current.cases.some((row) => row.fromThreadId === thread.id)) { setError("That thread is already a case."); return; }
    const solution = thread.messages.filter((message) => message.role === "assistant").at(-1)?.content.trim() ?? "";
    try {
      setStore(addBenchCase({ title: threadTitle(thread as Thread), prompt, folderId, fromThreadId: thread.id, rubric, ...(solution ? { solution } : {}) }).store);
    } catch (reason: unknown) { setError(reasonText(reason)); return; }
    setRubric("");
    setPick("");
  };

  const sheets = () => {
    const titleOf = (id: string) => store.cases.find((row) => row.id === id)?.title ?? "";
    const runs: (string | number)[][] = [["run", "model", "name", "effort", "mode", "started", "case", "title", "judge", "cost", "ms", "tokens", "out", "steps", "requests", "failed", "thread"]];
    for (const item of store.runs) for (const result of item.results) {
      runs.push([item.id, item.model, runName(item), item.effort ?? "", item.mode, new Date(item.startedAt).toISOString(), result.caseId, titleOf(result.caseId), result.judge ?? "", result.cost, result.ms, result.tokens, result.out ?? 0, result.steps, result.requests, result.failed, result.threadId ?? ""]);
    }
    return [
      { name: "RUNS", rows: runs },
      { name: "CASES", rows: [["id", "title", "folder", "prompt", "rubric", "solution", "created", "from thread"], ...store.cases.map((row): (string | number)[] => [row.id, row.title, folderName(row.folderId), row.prompt, row.rubric ?? "", row.solution ?? "", new Date(row.createdAt).toISOString(), row.fromThreadId])] },
      { name: "SOLUTIONS", rows: [["run", "model", "name", "case", "answer", "judge note"], ...store.runs.flatMap((item) => item.results.map((result): (string | number)[] => [item.id, item.model, runName(item), result.caseId, result.answer ?? "", result.judgeNote ?? ""]))] },
    ];
  };

  const stamp = () => `bench-${new Date().toISOString().slice(0, 10)}`;

  const exportCsv = async () => {
    setError("");
    await window.emma.exportThreadStats({
      folder: stamp(),
      files: sheets().map((sheet) => ({ name: `${sheet.name.toLowerCase()}.csv`, text: toCsv(sheet.rows.map((row) => row.map(formulaSafe))) })),
    }).catch((reason: unknown) => { setError(reasonText(reason)); });
  };

  const exportXlsx = async () => {
    setError("");
    await window.emma.exportBench({ name: stamp(), sheets: sheets() }).catch((reason: unknown) => { setError(reasonText(reason)); });
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
    {!board.rows.length && !!board.skipped && <p className="bench-note">{board.skipped} {plural(board.skipped, "case")} dropped — not every model ran {board.skipped === 1 ? "it" : "them"}.</p>}
    {!board.rows.length && <section className="evidence-table bench-primer">
      <header><div><span>Bench · one replay of every case under every model</span><h3>Which model for these cases</h3></div><small><button type="button" onClick={() => setExample(true)}>Show an example</button></small></header>
      <ol>
        <li><b>1</b><span>Pick a thread below and save it as a case. Add a rubric: what a right answer must do.</span></li>
        <li><b>2</b><span>Run a model over every case. Each replay runs in its own archived thread, then the judge model you pick scores it against the rubric.</span></li>
        <li><b>3</b><span>Come back here: the frontier, the model cards and the case grid compare every model that has run, and export gives you the sheets.</span></li>
      </ol>
      <p className="bench-note">Nothing has run yet. Nothing runs on its own; every replay starts from a button on this page.</p>
    </section>}
    {example && <div className="bench-example"><b>Example</b><span>Made-up numbers to show the layout. No model ran, nothing is saved.</span><button type="button" onClick={() => setExample(false)}>Hide example</button></div>}
    {board.rows.length > 0 && <>
      <section className="evidence-table">
        <header>
          <div><span>Bench · one replay of every case under every model</span><div className="agent-head"><h3>Which model for these cases</h3><InfoDot>Each model is read from its latest finished plain run — no trial arms. Models are compared only on the {board.caseIds.length} {plural(board.caseIds.length, "case")} every one of them ran; a model that ran fewer is marked partial and the cases it skipped are dropped from every column, so no model is credited for a case another never saw. The judge score is a cheap model reading the case rubric against the replay&apos;s final answer, once per replay.</InfoDot></div></div>
        </header>
        <div className="agent-metrics">
          <span><b>{board.caseIds.length}</b> shared {plural(board.caseIds.length, "case")}</span>
          <span><b>{board.rows.length}</b> {plural(board.rows.length, "model")}</span>
          <span><b>{leader ? show("judge", leader.judge) : "—"}</b> best judge · {leader ? leader.name : "—"}</span>
          <span><b>{show("perCase", least("perCase"))}</b> cheapest per case</span>
        </div>
        {!!board.skipped && <p className="bench-note">{board.skipped} {plural(board.skipped, "case")} dropped — not every model ran {board.skipped === 1 ? "it" : "them"}.</p>}
      </section>

      <section className="evidence-table bench-section">
        <header>
          <div><span>Joined points are non-dominated on the two axes picked</span><h3>Frontier</h3></div>
          <small>
            <select aria-label="Horizontal axis" value={x} onChange={(event) => setXAxis(event.target.value as BoardMetric)}>
              {BOARD_METRICS.map((key) => <option key={key} value={key}>x · {boardMetricNames[key]}</option>)}
            </select>
            <select aria-label="Vertical axis" value={yAxis} onChange={(event) => setYAxis(event.target.value as BoardMetric)}>
              {BOARD_METRICS.map((key) => <option key={key} value={key}>y · {boardMetricNames[key]}</option>)}
            </select>
            <select aria-label="Chart type" value={chart} onChange={(event) => setChart(event.target.value === "bars" ? "bars" : "scatter")}>
              <option value="scatter">scatter</option>
              <option value="bars">bars</option>
            </select>
          </small>
        </header>
        <Scatter rows={board.rows} x={x} y={yAxis} hue={hue} front={front} chart={chart} />
      </section>

      <section className="evidence-table bench-section">
        <header>
          <div><span>Totals over the shared cases · a full bar is the best model on that metric</span><h3>Models</h3></div>
          <small>{front.size} on the frontier</small>
        </header>
        <div className="bench-cards">
          {board.rows.map((row) => <article key={row.model} className="bench-card" data-default={row.model === model ? "" : undefined}>
            <header>
              <span><BrandIcon brand={brandOf(row)} className="bench-mark" /><i className="bench-dot" style={{ background: hue(row.model) }} aria-hidden="true" />{row.name}</span>
              <em data-on={front.has(row.model) ? "" : undefined}>{front.has(row.model) ? "frontier" : "dominated"}</em>
            </header>
            <div className="bench-lead"><b>{show("judge", row.judge)}</b><small>judge · {row.cells.length - row.failed}/{row.cells.length} ended well{row.partial ? " · partial" : ""}</small></div>
            {(["perCase", "ms", "tokens", "out", "steps"] as BoardMetric[]).map((key) => <div key={key} className="bench-bar">
              <span>{boardMetricNames[key]}</span>
              <i><b style={{ inlineSize: `${shareOf(row, key)}%`, background: shareOf(row, key) === 100 ? "var(--lime)" : "var(--text-2)" }} /></i>
              <small>{show(key, boardValue(row, key))}</small>
            </div>)}
          </article>)}
        </div>
      </section>

      <section className="evidence-table bench-section">
        <header>
          <div><span>Every shared case under every model · pick a cell to open that replay</span><h3>Cases × models</h3></div>
          <small>
            <select aria-label="What each cell shows" value={cell} onChange={(event) => setCell(event.target.value as CellMetric)}>
              {CELL_METRICS.map((key) => <option key={key} value={key}>{cellMetricNames[key]}</option>)}
            </select>
          </small>
        </header>
        <div className="bench-grid">
          <table>
            <thead><tr><th>case</th>{board.rows.map((row) => <th key={row.model}><BrandIcon brand={brandOf(row)} className="bench-mark" /><i className="bench-dot" style={{ background: hue(row.model) }} aria-hidden="true" />{row.name}</th>)}</tr></thead>
            <tbody>{board.caseIds.map((caseId) => <tr key={caseId}>
              <td title={caseTitle(caseId)}>{caseTitle(caseId)}</td>
              {board.rows.map((row) => {
                const found = row.cells.find((item) => item.caseId === caseId);
                const value = found ? cellValue(found, cell) : null;
                return <td key={row.model} className="bench-cell" style={cell === "judge" && value !== null ? { background: `color-mix(in srgb, ${hue(row.model)} ${Math.round(value * 45)}%, transparent)` } : undefined}>
                  <button type="button" disabled={!found?.threadId} title={found?.judgeNote || undefined} onClick={() => { if (found?.threadId) openThread(found.threadId); }}>{show(cell, value)}</button>
                </td>;
              })}
            </tr>)}</tbody>
            <tfoot>
              {(["judge", "cost", "ms", "tokens", "out", "steps"] as BoardMetric[]).map((key) => <tr key={key}>
                <td>{boardMetricNames[key]}{key === "judge" ? " · mean" : " · total"}</td>
                {board.rows.map((row) => <td key={row.model}>{show(key, key === "judge" ? row.judge : boardValue(row, key))}</td>)}
              </tr>)}
              <tr><td>frontier</td>{board.rows.map((row) => <td key={row.model} data-delta={front.has(row.model) ? "win" : undefined}>{front.has(row.model) ? "▲" : "·"}</td>)}</tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section className="evidence-table bench-section">
        <header>
          <div><span>Every run on this bench, as a spreadsheet</span><h3>Export</h3></div>
          <small>{store.runs.reduce((total, item) => total + item.results.length, 0)} replays · {store.cases.length} {plural(store.cases.length, "case")}</small>
        </header>
        <div className="agent-actions">
          <button type="button" disabled={busy || !!live || example} onClick={() => void exportCsv()}>Export CSV</button>
          <button type="button" disabled={busy || !!live || example} onClick={() => void exportXlsx()}>Export XLSX · 3 sheets</button>
          <small>RUNS · CASES · SOLUTIONS</small>
        </div>
      </section>
    </>}

    <section className="evidence-table">
      <header>
        <div><span>Bench · your own cases, replayed</span><div className="agent-head"><h3>Proof by replay</h3><InfoDot>A case is one prompt from one of your threads, replayed under both arms back to back so each pair cancels the day it ran on. The verdict needs a paired t-test and a sign test to agree, and it needs {MIN_BENCH_PAIRS} pairs: below six one-way cases the exact sign-test p is 2/2^m, which cannot reach 0.05 however clean the result. A run declares its cases and its metric up front and is read only under that metric, once it is over, so there is nothing to stop early for and nothing to shop for afterwards. Re-running a trial does not replace the last attempt; every attempt is listed, because the fourth try clearing at p=0.05 is one run in twenty, not proof. Cases, runs and verdicts stay on this computer.</InfoDot></div></div>
        <small className="bench-strip"><span><b>{store.cases.length}</b> {plural(store.cases.length, "case")}</span><span><b>{store.runs.length}</b> {plural(store.runs.length, "run")}</span><span><b>{points.at(-1) ? per(points.at(-1)!.mean) : "—"}</b> {benchMetricNames[curve]}</span><span><b>{proven}</b> proven</span></small>
      </header>

      {error && <p className="capability-error" role="alert">{error}</p>}
      {judgeNote && <p className="bench-note">{judgeNote}</p>}

      <div className="bench-setup">
        <div className="bench-col">
          <div className="bench-band bench-band-head"><span>Cases</span><small>{store.cases.length}{ready ? "" : ` · need ${MIN_BENCH_PAIRS}`}{full ? ` · ${MAX_BENCH_CASES} max` : ""}</small></div>
          {store.cases.map((item) => <div key={item.id} className="bench-band bench-case">
            <div><strong>{folderName(item.folderId)}</strong><button type="button" className="bench-x" aria-label={`Remove ${item.title}`} disabled={busy || !!live} onClick={() => drop(item.id)}>×</button></div>
            <details><summary title={item.title}>{item.title}</summary><p>{item.prompt}</p></details>
            <div className="bench-kv"><span>Rubric</span><small title={item.rubric}>{item.rubric || "none · the judge scores on the prompt alone"}</small></div>
            <button type="button" className="agent-receipt" onClick={() => openThread(item.fromThreadId)}>{day(item.createdAt)} · source thread</button>
          </div>)}
          {!store.cases.length && <div className="bench-band bench-empty">No cases yet. Save one from a thread below.</div>}
          <div className="bench-band bench-add">
            <select aria-label="Thread to save as a case" value={pick} disabled={busy || !!live} onChange={(event) => setPick(event.target.value)}>
              <option value="">Pick a thread</option>
              {harvestable.map((thread) => <option key={thread.id} value={thread.id} disabled={saved(thread.id)}>{thread.title}{saved(thread.id) ? " · saved" : ""}</option>)}
            </select>
            <input aria-label="What a correct answer must do" value={rubric} disabled={busy || !!live} maxLength={MAX_BENCH_RUBRIC_CHARS} placeholder="Rubric — what a correct answer must do" onChange={(event) => setRubric(event.target.value)} />
            <button type="button" disabled={busy || !pick || !!live || full} onClick={() => void harvest()}>Save as case</button>
          </div>
        </div>
        <div className="bench-col">
          <div className="bench-band bench-band-head"><span>Model to run</span><small>{store.cases.length} {plural(store.cases.length, "turn")}</small></div>
          <div className="bench-band bench-model">
            {pickers.run(runModel, runEffort, (next) => { setRunModel(next.model); setRunEffort(next.effort); }, busy || !!live)}
          </div>
        </div>
        <div className="bench-col">
          <div className="bench-band bench-band-head"><span>Judge</span></div>
          <div className="bench-band bench-model">
            <div className="task-model">{pickers.judge(store.judge, (judge) => setStore(saveBench({ ...readBench(), ...(judge ? { judge: { ...judge, system: "" } } : {}) })), busy || !!live)}</div>
            <small>Scores each replay against its rubric</small>
          </div>
        </div>
      </div>

      <div className="agent-actions bench-foot">
        <small>Next run</small>
        <select aria-label="Metric the next baseline run is stamped with" value={choice} disabled={busy || !!live} onChange={(event) => setChoice(event.target.value as BenchMetric)}>
          {Object.entries(benchMetricNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        {blocker && <small>{blocker}</small>}
        <span className="bench-gap" />
        <button type="button" disabled={busy || !!live || !ready || !!blocker} onClick={() => void start(undefined)}>Baseline · {store.cases.length}</button>
        <button type="button" disabled={busy || !!live || !ready || !!blocker || !trial} onClick={() => void start(trial)}>Trial{look > 1 ? ` · attempt ${look}` : ""} · {store.cases.length * 2}</button>
        <button type="button" className="bench-primary" disabled={busy || !!live || !store.cases.length || !runModel.trim() || !!blocker} onClick={() => void start(undefined, runModel.trim(), runEffort)}>Run · {store.cases.length} {plural(store.cases.length, "turn")}</button>
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
