import { useId, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ModePicker } from "./agents";
import { PromptField, useTaskCommands } from "./schedule";
import { Mark } from "./icons";
import { plural } from "./plural";
import { UNATTENDED_PERMISSION_MODE, type PermissionMode } from "../shared/permissions";
import type { ResearchIteration, ResearchJob, Snapshot } from "./types";
import { zoned } from "./dates";

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const chart = { grid: token("--border"), axis: token("--text-3"), line: token("--teal"), keep: token("--lime"), crash: token("--rose"), mark: token("--orange") };

const stampFormat = zoned({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const stamp = (value: string) => stampFormat(new Date(value));
const num = (value: number | null) => value === null ? "—" : value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
const pct = (value: number | null) => value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
const cash = (micro: number) => `$${(micro / 1_000_000).toFixed(micro > 0 && micro < 10_000 ? 4 : 2)}`;
const clock = (seconds: number) => seconds < 60 ? `${Math.round(seconds)}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${String(Math.round(seconds % 3600 / 60)).padStart(2, "0")}m`;
const OUTCOMES = { keep: "◆ kept", discard: "◇ discarded", crash: "✕ crashed" };
const PROJECT_PLACEHOLDER = typeof window !== "undefined" && window.emma?.platform === "win32" ? "C:\\Users\\you\\code\\nanochat" : "/Users/you/code/nanochat";

const baselineOf = (job: ResearchJob) => job.iterations.find((item) => item.value !== null)?.value ?? null;
const bestOf = (job: ResearchJob) => [...job.iterations].reverse().find((item) => item.best !== null)?.best ?? null;

function gainOf(job: ResearchJob, value: number | null): number | null {
  const base = baselineOf(job);
  if (base === null || value === null || base === 0) return null;
  return (job.direction === "lower" ? base - value : value - base) / Math.abs(base) * 100;
}

const counts = (job: ResearchJob) => ({
  keep: job.iterations.filter((item) => item.outcome === "keep").length,
  discard: job.iterations.filter((item) => item.outcome === "discard").length,
  crash: job.iterations.filter((item) => item.outcome === "crash").length,
});

const spentOf = (spent: string, max: number, format: (value: number) => string) => max ? `${spent} of ${format(max)}` : `${spent} · no limit`;

type Act = (method: string, params?: Record<string, string>) => Promise<unknown>;
type Point = ResearchIteration & { gain: number | null };

export default function ResearchView({ snapshot, act, busy }: { snapshot: Snapshot; act: Act; busy: boolean }) {
  const jobs = snapshot.researchJobs;
  const [picked, setPicked] = useState("");
  const job = jobs.find((item) => item.id === picked);
  if (job) return <JobDetail key={job.id} job={job} act={act} busy={busy} back={() => setPicked("")} />;
  if (picked === "new") return <section className="research-view">
    <header className="research-head"><button type="button" className="research-back" onClick={() => setPicked("")}>← All experiments</button><span>Autoresearch · new experiment</span><h2>What are you optimising?</h2><p>Emma proposes one change at a time, runs your eval command, reads the metric, and keeps the change only when the number improved. Everything below can be edited later except the metric and the folder.</p></header>
    <ResearchForm act={act} busy={busy} onSaved={setPicked} />
  </section>;
  return <section className="research-view">
    <header className="research-head"><h2>Experiments</h2></header>
    <div className="research-actions"><button type="button" disabled={busy} onClick={() => setPicked("new")}>+ New experiment</button></div>
    {!jobs.length && <div className="content-empty"><Mark /><h2>No experiments yet</h2><p>Create one here, or ask Emma to set one up on a folder you have already granted.</p></div>}
    <div className="job-list">{jobs.map((item) => <JobCard key={item.id} job={item} act={act} busy={busy} open={() => setPicked(item.id)} />)}</div>
  </section>;
}

function StatusButton({ job, act, busy }: { job: ResearchJob; act: Act; busy: boolean }) {
  const running = job.status === "running";
  return <button type="button" className="research-play" disabled={busy} aria-label={`${running ? "Pause" : "Start"} ${job.title}`} onClick={() => void act("setResearchJobStatus", { jobId: job.id, status: running ? "paused" : "running" })}>{running ? "❙❙ Pause" : "▶ Start"}</button>;
}

function JobCard({ job, act, busy, open }: { job: ResearchJob; act: Act; busy: boolean; open: () => void }) {
  const best = bestOf(job);
  const tally = counts(job);
  return <article>
    <header>
      <div><span className={`job-state ${job.status === "running" ? "on" : ""}`}>{job.status}</span><h3><button type="button" className="research-open" disabled={busy} onClick={open}>{job.title}</button></h3></div>
      <StatusButton job={job} act={act} busy={busy} />
    </header>
    <dl>
      <div><dt>Metric</dt><dd>{job.metricName} · {job.direction} is better · {job.metricKind}</dd></div>
      <div><dt>Best</dt><dd>{num(best)} · {pct(gainOf(job, best))} vs baseline {num(baselineOf(job))}</dd></div>
      <div><dt>Attempts</dt><dd>{job.iterations.length} {plural(job.iterations.length, "iteration")} · {tally.keep} kept · {tally.discard} discarded · {tally.crash} crashed</dd></div>
    </dl>
    {job.statusNote && <p className="research-note"><b>{job.status === "failed" ? "Failed" : "Paused"}</b> {job.statusNote}</p>}
  </article>;
}

function JobDetail({ job, act, busy, back }: { job: ResearchJob; act: Act; busy: boolean; back: () => void }) {
  const logId = useId();
  const [confirming, setConfirming] = useState(false);
  const best = bestOf(job);
  const baseline = baselineOf(job);
  const tally = counts(job);
  const rows = [...job.iterations].reverse();
  const remove = async () => {
    if (!confirming) { setConfirming(true); return; }
    await act("deleteResearchJob", { jobId: job.id });
    back();
  };
  return <section className="research-view">
    <header className="research-head">
      <button type="button" className="research-back" onClick={back}>← All experiments</button>
      <span>{job.status} · {job.iterations.length} {plural(job.iterations.length, "iteration")} · since {stamp(job.createdAt)}</span>
      <h2>{job.title}</h2>
      <p>Optimising <b>{job.metricName}</b> — {job.direction} is better, read by {job.metricKind === "grep" ? `grepping ^${job.metricName}: out of` : "judging"} <code>{job.evalCommand}</code> in {job.projectDir}.</p>
      <div className="research-actions"><StatusButton job={job} act={act} busy={busy} /></div>
      {job.statusNote && <p className="research-note"><b>{job.status === "failed" ? "Failed" : "Paused"}</b> {job.statusNote}</p>}
    </header>
    <ProgressGraph job={job} logId={logId} />
    <div className="agent-metrics research-numbers">
      <span><b>{job.iterations.length}</b>{plural(job.iterations.length, "attempt")}<small>{tally.keep} kept · {tally.discard} discarded · {tally.crash} crashed</small></span>
      <span><b>{num(best)}</b>best {job.metricName}<small>baseline {num(baseline)} · {pct(gainOf(job, best))}</small></span>
      <span><b>{job.spentTokens.toLocaleString()}</b>tokens<small>{spentOf("spent", job.maxTokens, (value) => value.toLocaleString())}</small></span>
      <span><b>{cash(job.spentMicroDollars)}</b>spent<small>{spentOf("estimated", job.maxMicroDollars, cash)}</small></span>
      <span><b>{clock(job.spentSeconds)}</b>elapsed<small>{spentOf("running", job.maxSeconds, clock)}</small></span>
    </div>
    <table id={logId} className="research-log">
      <caption>Iteration log — the same numbers the graph plots, newest first.</caption>
      <thead><tr><th scope="col">#</th><th scope="col">Time</th><th scope="col">{job.metricName}</th><th scope="col">Outcome</th><th scope="col">What was tried</th><th scope="col">Commit</th><th scope="col">Tokens</th><th scope="col">Cost</th></tr></thead>
      <tbody>{rows.map((item) => <tr key={item.index}>
        <th scope="row">{item.index}</th>
        <td>{stamp(item.at)}</td>
        <td>{num(item.value)}</td>
        <td className={`research-outcome ${item.outcome}`}>{OUTCOMES[item.outcome]}</td>
        <td className="research-note-cell">{item.note}</td>
        <td>{item.commit}</td>
        <td>{(item.inputTokens + item.outputTokens).toLocaleString()}</td>
        <td>{cash(item.microDollars)}</td>
      </tr>)}
      {!rows.length && <tr><td colSpan={8}>Nothing has run yet.</td></tr>}</tbody>
    </table>
    <details className="research-edit">
      <summary>Edit experiment</summary>
      <ResearchForm job={job} act={act} busy={busy} onSaved={() => undefined} />
      <div className="research-actions"><button type="button" className="research-danger" disabled={busy} onClick={() => void remove()}>{confirming ? "Delete for good" : "Delete experiment"}</button></div>
    </details>
  </section>;
}

function pointsOf(job: ResearchJob): Point[] {
  let carried: number | null = null;
  return job.iterations.map((item) => {
    carried = item.best ?? carried;
    return { ...item, best: carried, gain: gainOf(job, carried) };
  });
}

function ProgressGraph({ job, logId }: { job: ResearchJob; logId: string }) {
  const data = pointsOf(job);
  const baseline = baselineOf(job);
  const last = data[data.length - 1];
  return <figure className="research-graph" role="group" aria-label={`Best ${job.metricName} across ${job.iterations.length} ${plural(job.iterations.length, "iteration")}, where ${job.direction} is better`} aria-describedby={logId}>
    <figcaption>Best {job.metricName} so far · {job.direction} is better · the iteration log below carries the same numbers.</figcaption>
    {data.length ? <ResponsiveContainer width="100%" height={300}>
      <LineChart accessibilityLayer data={data} margin={{ left: 8, right: 44, top: 16, bottom: 8 }}>
        <CartesianGrid stroke={chart.grid} vertical={false} />
        <XAxis dataKey="index" stroke={chart.axis} fontSize={10} tickFormatter={(value: number) => `#${value}`} />
        <YAxis orientation="right" domain={["auto", "auto"]} stroke={chart.axis} fontSize={10} width={40} />
        {baseline !== null && <ReferenceLine y={baseline} stroke={chart.axis} strokeDasharray="4 4" label={{ value: "baseline", position: "insideLeft", fill: chart.axis, fontSize: 10 }} />}
        {last && <ReferenceLine x={last.index} stroke={chart.axis} strokeDasharray="2 4" label={{ value: "now", position: "top", fill: chart.axis, fontSize: 10 }} />}
        <Tooltip cursor={{ stroke: chart.grid }} content={({ active, payload }) => {
          const point = active && payload?.length ? payload[0].payload as Point : null;
          return point ? <div className="research-tip">
            <b>{pct(point.gain)}</b>
            <span>{job.metricName} {num(point.value)} · iteration #{point.index}</span>
            <span className={`research-outcome ${point.outcome}`}>{OUTCOMES[point.outcome]}</span>
            <time>{stamp(point.at)}</time>
            {point.note && <p>{point.note}</p>}
          </div> : null;
        }} />
        <Line type="stepAfter" dataKey="best" name={job.metricName} stroke={chart.line} strokeWidth={1.5} isAnimationActive={false} activeDot={{ r: 5, fill: chart.mark, stroke: "none" }} dot={(props) => {
          const point = props.payload as Point;
          const { cx, cy, index } = props;
          if (typeof cx !== "number" || typeof cy !== "number") return <g key={index} />;
          if (point.outcome === "crash") return <path key={index} d={`M${cx - 3.5} ${cy - 3.5}l7 7M${cx + 3.5} ${cy - 3.5}l-7 7`} stroke={chart.crash} strokeWidth={1.5} />;
          return <rect key={index} x={cx - 3} y={cy - 3} width={6} height={6} fill={point.outcome === "keep" ? chart.keep : chart.axis} stroke="none" />;
        }} />
      </LineChart>
    </ResponsiveContainer> : <p className="research-empty">The graph draws itself once the first iteration has been measured.</p>}
  </figure>;
}

const KINDS = {
  grep: { label: "grep a number out of the output", detail: "Emma runs the eval command and greps ^<name>: out of what it printed.", example: "eval    uv run train.py 2>&1\nprints  val_bpb: 0.997900\nname    val_bpb\nbetter  lower" },
  judge: { label: "have a model score the output", detail: "Emma runs the eval command, then a model scores its output against your rubric and returns one number.", example: "eval    npm test\nrubric  score 0-100: how many suites pass,\n        and how readable is the failure output\nname    test_health\nbetter  higher" },
};

function ResearchForm({ job, act, busy, onSaved }: { job?: ResearchJob; act: Act; busy: boolean; onSaved: (id: string) => void }) {
  const frozenId = useId();
  const [title, setTitle] = useState(job?.title ?? "");
  const [projectDir, setProjectDir] = useState(job?.projectDir ?? "");
  const [kind, setKind] = useState<"grep" | "judge">(job?.metricKind ?? "grep");
  const [metricName, setMetricName] = useState(job?.metricName ?? "");
  const [direction, setDirection] = useState<"lower" | "higher">(job?.direction ?? "lower");
  const [rubric, setRubric] = useState(job?.metricPrompt ?? "");
  const [evalCommand, setEvalCommand] = useState(job?.evalCommand ?? "");
  const [prompt, setPrompt] = useState(job?.prompt ?? "");
  const { skills, tools, atItems } = useTaskCommands();
  const [model, setModel] = useState(job?.proposerModel ?? "");
  const [mode, setMode] = useState<PermissionMode>(job?.permissionMode ?? UNATTENDED_PERMISSION_MODE);
  const [hours, setHours] = useState(job ? String(Number((job.maxSeconds / 3600).toFixed(2))) : "6");
  const [tokens, setTokens] = useState(job ? String(job.maxTokens) : "2000000");
  const [dollars, setDollars] = useState(job ? String(job.maxMicroDollars / 1_000_000) : "5");
  const frozen = Boolean(job);
  const ready = Boolean(title.trim() && projectDir.trim() && metricName.trim() && evalCommand.trim() && model.trim() && (kind === "grep" || rubric.trim()));
  const whole = (value: string, scale: number) => String(Math.max(0, Math.round(Number(value) * scale) || 0));
  const save = async () => {
    if (!ready || busy) return;
    const saved = await act("saveResearchJob", {
      ...(job ? { jobId: job.id } : {}),
      title: title.trim(),
      projectDir: projectDir.trim(),
      metricName: metricName.trim(),
      metricKind: kind,
      direction,
      evalCommand: evalCommand.trim(),
      proposerModel: model.trim(),
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      permissionMode: mode,
      maxSeconds: whole(hours, 3600),
      maxTokens: whole(tokens, 1),
      maxMicroDollars: whole(dollars, 1_000_000),
      ...(kind === "judge" && rubric.trim() ? { metricPrompt: rubric.trim() } : {}),
    }) as { id?: string } | undefined;
    if (saved?.id) onSaved(saved.id);
  };
  return <div className="task-detail research-form">
    <div className="research-kind" role="radiogroup" aria-label="Metric kind">
      {(Object.keys(KINDS) as (keyof typeof KINDS)[]).map((name) => <button key={name} type="button" role="radio" aria-checked={kind === name} aria-label={`${name} — ${KINDS[name].label}`} className={kind === name ? "active" : ""} disabled={busy || frozen} onClick={() => setKind(name)}>
        <b>{kind === name ? "◆" : "◇"} {name}</b>
        <span>{KINDS[name].label}</span>
        <small>{KINDS[name].detail}</small>
        <pre>{KINDS[name].example}</pre>
      </button>)}
    </div>
    <p className={`research-frozen ${frozen ? "" : "research-warn"}`} id={frozenId}>{frozen ? "The metric and the project folder cannot be changed on a saved experiment — every iteration was measured against them. Create a new experiment for a different metric." : "Choose carefully: the metric kind, name, direction and project folder are fixed once this experiment is created. Everything else can be edited while it runs."}</p>
    <div className="task-fields">
      <label><span>Title</span><input value={title} maxLength={128} disabled={busy} onChange={(event) => setTitle(event.target.value)} placeholder="Shrink val_bpb on nanochat" /></label>
      <label><span>Project folder (git)</span><input value={projectDir} maxLength={1024} spellCheck={false} readOnly={frozen} aria-describedby={frozen ? frozenId : undefined} disabled={busy} onChange={(event) => setProjectDir(event.target.value)} placeholder={PROJECT_PLACEHOLDER} /></label>
      <label><span>Metric name</span><input value={metricName} maxLength={64} spellCheck={false} readOnly={frozen} aria-describedby={frozen ? frozenId : undefined} disabled={busy} onChange={(event) => setMetricName(event.target.value)} placeholder="val_bpb" /></label>
      <label><span>Better is</span><select value={direction} disabled={busy || frozen} aria-describedby={frozen ? frozenId : undefined} onChange={(event) => setDirection(event.target.value as "lower" | "higher")}><option value="lower">lower</option><option value="higher">higher</option></select></label>
      <label className="task-wide"><span>Eval command</span><input value={evalCommand} maxLength={4096} spellCheck={false} disabled={busy} onChange={(event) => setEvalCommand(event.target.value)} placeholder={kind === "grep" ? "uv run train.py 2>&1" : "npm test"} /></label>
      <div className="task-wide"><span className="task-label">Brief for the agent</span><PromptField value={prompt} onChange={setPrompt} commands={[...skills, ...tools]} atItems={atItems} disabled={busy} rows={4} label="What the agent should try on each iteration" placeholder="What should Emma try, and what should it leave alone? Type / for a skill or tool, @ for a file, artifact or saved page. Editable while the experiment runs." /></div>
      {kind === "judge" && <label className="task-wide"><span>Rubric for the judge</span><textarea value={rubric} maxLength={4096} rows={3} disabled={busy} onChange={(event) => setRubric(event.target.value)} placeholder="score 0-100: how many suites pass, and how readable is the failure output" /></label>}
      <label><span>Proposer model</span><input value={model} maxLength={256} spellCheck={false} disabled={busy} onChange={(event) => setModel(event.target.value)} placeholder="anthropic/claude-sonnet-4.5" /></label>
      <label><span>Runs as</span><ModePicker mode={mode} setMode={setMode} disabled={busy} /></label>
      <label><span>Hours budget</span><input value={hours} inputMode="decimal" disabled={busy} onChange={(event) => setHours(event.target.value)} placeholder="0 for no limit" /></label>
      <label><span>Token budget</span><input value={tokens} inputMode="numeric" disabled={busy} onChange={(event) => setTokens(event.target.value)} placeholder="0 for no limit" /></label>
      <label><span>Dollar budget</span><input value={dollars} inputMode="decimal" disabled={busy} onChange={(event) => setDollars(event.target.value)} placeholder="0 for no limit" /></label>
    </div>
    <p className="research-frozen">Each budget is checked before every iteration; <b>0</b> means no limit. Hitting one pauses the experiment with a note saying which — raise it and press start to carry on.</p>
    <div className="task-actions"><button type="button" disabled={busy || !ready} onClick={() => void save()}>{job ? "Save changes" : "Create experiment"}</button></div>
  </div>;
}
