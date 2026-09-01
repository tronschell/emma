import { useMemo, useState } from "react";
import { usageDay, recentDays } from "../shared/invocations";
import { activeYears, countDays, heatLevel, lineage, messageDays, projectActivity, streak, weekGrid, type DayGrid } from "./activity";
import { Bars } from "./bars";
import { InfoDot, Mark } from "./icons";
import { plural } from "./plural";
import { day } from "./dates";
import { threadMessageCount, threadUserMessageCount, type Snapshot, type Thread } from "./types";

const SPARK_DAYS = 30;
const LINEAGE_ROWS = 60;
const LANE_PITCH = 14;
const LANE_COLOURS = 6;
const ROW_HEIGHT = 22;
const LANE_RADIUS = 3.5;

const laneX = (lane: number) => lane * LANE_PITCH + LANE_PITCH / 2;
const WEEKDAYS = ["", "Mon", "", "Wed", "", "Fri", ""];
const WEEK_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayNumber = (key: string) => String(Number(key.slice(8)));

function WeekStrip({ week, days, peak, today }: { week: string[]; days: Record<string, number>; peak: number; today: string }) {
  return <ol className="week-strip">
    {week.map((key, index) => <li key={key} className={key === today ? "on" : ""}>
      <span>{WEEK_NAMES[index]}</span>
      <i className={key > today ? "heat-cell heat-void" : "heat-cell"} data-level={key > today ? undefined : heatLevel(days[key] ?? 0, peak)} />
      <b>{dayNumber(key)}</b>
      <small>{key > today ? "—" : days[key] ?? 0}</small>
    </li>)}
  </ol>;
}

function Heat({ grid, days, peak, today, labels }: { grid: DayGrid; days: Record<string, number>; peak: number; today: string; labels: boolean }) {
  return <div className="heat">
    {labels && <div className="heat-months">{grid.months.map((month) => <span key={`${month.label}-${month.column}`} style={{ gridColumn: month.column + 1 }}>{month.label}</span>)}</div>}
    <div className="heat-days">{WEEKDAYS.map((name, index) => <span key={index}>{name}</span>)}</div>
    <div className="heat-grid">
        {grid.weeks.map((week) => <div className="heat-week" key={week[0]}>
          {week.map((key) => key > today
            ? <i key={key} className="heat-cell heat-void" />
            : <i key={key} className="heat-cell" data-level={heatLevel(days[key] ?? 0, peak)} title={`${key} · ${days[key] ?? 0} ${plural(days[key] ?? 0, "message")}`} />)}
      </div>)}
    </div>
  </div>;
}

function HistoryDialog({ days, peak, today, close }: { days: Record<string, number>; peak: number; today: string; close: () => void }) {
  const years = activeYears(days);
  return <dialog className="modal-backdrop" open aria-labelledby="activity-history-title"
    onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="agent-dialog activity-dialog">
      <header>
        <div><span>Every day Emma has run</span><h2 id="activity-history-title">All time</h2></div>
        <button type="button" onClick={close} aria-label="Close activity history">×</button>
      </header>
      {years.map((year) => {
        const grid = weekGrid(new Date(year, 0, 1), new Date(year, 11, 31));
        const total = grid.weeks.flat().reduce((sum, key) => sum + (days[key] ?? 0), 0);
        return <section className="activity-year" key={year}>
          <header><h3>{year}</h3><small>{total} {plural(total, "message")}</small></header>
          <Heat grid={grid} days={days} peak={peak} today={today} labels />
        </section>;
      })}
    </section>
  </dialog>;
}

function HeatPanel({ days }: { days: Record<string, number> }) {
  const [span, setSpan] = useState<"week" | "year">("week");
  const [history, setHistory] = useState(false);
  const now = useMemo(() => new Date(), []);
  const today = usageDay(now);
  const from = useMemo(() => {
    if (span === "week") return now;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    start.setFullYear(start.getFullYear() - 1);
    return start;
  }, [span, now]);
  const grid = useMemo(() => weekGrid(from, now), [from, now]);
  const peak = Math.max(1, ...Object.values(days));
  const shown = grid.weeks.flat().filter((key) => key <= today);
  const total = shown.reduce((sum, key) => sum + (days[key] ?? 0), 0);
  const active = shown.filter((key) => days[key]).length;

  return <section className="skill-graph activity-heat">
    <header>
      <h3>Every day<InfoDot>One square a day, darker the more messages that day carried. The week view is this week only; the year view is the last 53 weeks. All time opens every year Emma has a record of.</InfoDot></h3>
      <small>{total} {plural(total, "message")} · {active} active {plural(active, "day")} · {streak(days, now)} day streak</small>
      <button type="button" onClick={() => setSpan(span === "week" ? "year" : "week")}>{span === "week" ? "Year" : "Week"}</button>
      <button type="button" onClick={() => setHistory(true)}>All time</button>
    </header>
    {span === "week"
      ? <WeekStrip week={grid.weeks[0]} days={days} peak={peak} today={today} />
      : <Heat grid={grid} days={days} peak={peak} today={today} labels />}
    <footer><small>Less</small><div className="heat-key">{[0, 1, 2, 3, 4].map((level) => <i key={level} className="heat-cell" data-level={level} />)}</div><small>More</small></footer>
    {history && <HistoryDialog days={days} peak={peak} today={today} close={() => setHistory(false)} />}
  </section>;
}

function ProjectPanel({ threads, projectName }: { threads: Thread[]; projectName: (thread: Thread) => string }) {
  const rows = useMemo(() => projectActivity(threads, projectName), [threads, projectName]);
  const spark = recentDays(SPARK_DAYS);
  const busiest = Math.max(1, ...rows.map((row) => row.messages));
  return <section className="skill-list activity-projects">
    <header><h3>Projects over time<InfoDot>Every thread grouped by the folder it is filed under, with the last {SPARK_DAYS} days of its messages beside it.</InfoDot></h3><small>{rows.length} {plural(rows.length, "project")}</small></header>
    {rows.map((row) => <div className="activity-project" key={row.name}>
      <div><strong>{row.name}</strong><span>{row.threads} {plural(row.threads, "thread")} · last {day(row.lastAt)}</span></div>
      <i style={{ width: `${Math.round(row.messages / busiest * 100)}%` }} aria-hidden="true" />
      <Bars values={spark.map((key) => row.days[key] ?? 0)} labels={spark} className="skill-spark" />
      <b>{row.messages}</b>
    </div>)}
    {!rows.length && <div className="empty"><Mark /><p>No threads yet.</p></div>}
  </section>;
}

function LineagePanel({ threads, openThread }: { threads: Thread[]; openThread: (id: string) => void }) {
  const rows = useMemo(() => lineage(threads, LINEAGE_ROWS), [threads]);
  const width = rows.reduce((widest, row) => Math.max(widest, row.depth + 1), 1) * LANE_PITCH;
  const middle = ROW_HEIGHT / 2;
  return <section className="skill-list activity-tree">
    <header><h3>Thread tree<InfoDot>The spine is your own threads, newest first. A branch off it is a subagent that thread spawned, and a branch off that one is a subagent of the subagent.</InfoDot></h3><small>{rows.length} of {threads.length}</small></header>
    <ol className="git-graph">
      {rows.map((row) => <li className="git-commit-row" key={row.thread.id}>
        <svg className="git-lanes" width={width} height={ROW_HEIGHT} viewBox={`0 0 ${width} ${ROW_HEIGHT}`} aria-hidden>
          {row.open.map((lane) => <path key={lane} className={`git-lane-${lane % LANE_COLOURS}`} d={`M ${laneX(lane)} 0 L ${laneX(lane)} ${ROW_HEIGHT}`} />)}
          {row.elbow && <path className={`git-lane-${(row.depth - 1) % LANE_COLOURS}`}
            d={`M ${laneX(row.depth - 1)} 0 L ${laneX(row.depth - 1)} ${middle} L ${laneX(row.depth)} ${middle}`} />}
          {row.up && <path className={`git-lane-${row.depth % LANE_COLOURS}`} d={`M ${laneX(row.depth)} 0 L ${laneX(row.depth)} ${middle}`} />}
          {row.down && <path className={`git-lane-${row.depth % LANE_COLOURS}`} d={`M ${laneX(row.depth)} ${middle} L ${laneX(row.depth)} ${ROW_HEIGHT}`} />}
          <circle className={`git-lane-${row.depth % LANE_COLOURS}`} cx={laneX(row.depth)} cy={middle} r={LANE_RADIUS} />
        </svg>
        <div className="git-commit-body">
          <span className="activity-title">
            <button type="button" className="git-subject activity-open" onClick={() => openThread(row.thread.id)}>{row.thread.title || "Untitled thread"}</button>
            {row.thread.kind === "subagent" && <b className="git-ref">subagent</b>}
          </span>
          <span className="git-meta">{threadMessageCount(row.thread)} · {day(new Date(row.thread.updatedAt).getTime())}</span>
        </div>
      </li>)}
      {!rows.length && <li className="git-commit-row">No threads yet</li>}
    </ol>
  </section>;
}

export default function ActivityView({ snapshot, projectName, openThread }: { snapshot: Snapshot; projectName: (thread: Thread) => string; openThread: (id: string) => void }) {
  const threads = useMemo(() => snapshot.threads.filter((thread) => !thread.archivedAt), [snapshot.threads]);
  const days = useMemo(() => messageDays(threads), [threads]);
  const spark = recentDays(SPARK_DAYS);
  const started = useMemo(() => countDays(threads.map((thread) => thread.createdAt)), [threads]);
  const subagents = threads.filter((thread) => thread.kind === "subagent").length;
  const turns = threads.reduce((sum, thread) => sum + threadUserMessageCount(thread), 0);

  return <div className="activity-view">
    <div className="agent-metrics">
      <span><b>{threads.length}</b> live {plural(threads.length, "thread")}</span>
      <span><b>{turns}</b> {plural(turns, "turn")} asked</span>
      <span><b>{subagents}</b> {plural(subagents, "subagent")} spawned</span>
      <span><b>{streak(days)}</b> day streak</span>
    </div>

    <HeatPanel days={days} />

    <section className="skill-graph">
      <header><h3>Threads started<InfoDot>One bar a day, counting the threads created that day.</InfoDot></h3><small>Peak {Math.max(0, ...Object.values(started))}/day</small></header>
      <Bars values={spark.map((key) => started[key] ?? 0)} labels={spark} className="skill-chart activity-chart" />
      <footer><small>{spark[0]}</small><small>{spark.at(-1)}</small></footer>
    </section>

    <ProjectPanel threads={threads} projectName={projectName} />
    <LineagePanel threads={threads} openThread={openThread} />
  </div>;
}
