import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { byUse, recentDays, rowSeries, rowTotal, type UsageRow } from "../shared/invocations";
import { emptyWorkState, type NextStep, type WorkState } from "../shared/next-steps";
import { fileState, parseDiff, type GitSnapshot } from "../shared/git";
import type { FolderGrant } from "../shared/folders";
import { countDays, projectActivity, streak } from "./activity";
import { threadFolderMap } from "./context";
import { threadMessageCount, threadMessageDates, type Thread } from "./types";
import { defaultSteps } from "./next-steps";
import { BrandIcon, InfoDot, Mark } from "./icons";
import { brandForModel } from "./brands";
import { FileMark } from "./git";
import { plural } from "./plural";
import { Bars } from "./bars";
import { day } from "./dates";

const RIDGE_DAYS = 30;
const SPARK_DAYS = 14;
const RANKED_ROWS = 5;
const TILE_THREADS = 6;
const STATUS_PROJECTS = 4;
const STEPS_TTL_MS = 6 * 60 * 60 * 1000;
const STEPS_KEY = "emma.nextSteps.v1";

type Repo = { id: string; name: string; git: GitSnapshot };

const HUES = ["rose", "orange", "lime", "teal", "blue", "violet"];

const dayLabel = (key: string) => {
  const [year, month, date] = key.split("-").map(Number);
  return day(new Date(year, month - 1, date).getTime());
};

const auto = (name: string) => name === "auto" ? "Default route" : name;
const short = (name: string) => auto(name).split("/").at(-1) ?? name;

function Ridge({ values, labels }: { values: number[]; labels: string[] }) {
  const peak = Math.max(1, ...values);
  const step = 100 / Math.max(1, values.length - 1);
  const points = values.map((value, index) => `${(index * step).toFixed(2)},${(100 - (value / peak) * 96).toFixed(2)}`).join(" ");
  const total = values.reduce((sum, value) => sum + value, 0);
  return <svg className="dash-ridge" viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
    aria-label={`${total} ${plural(total, "message")} between ${labels[0]} and ${labels.at(-1)}`}>
    <polygon points={`0,100 ${points} 100,100`} />
    <polyline points={points} vectorEffect="non-scaling-stroke" />
    {values.map((value, index) => <rect key={labels[index]} x={Math.max(0, index * step - step / 2)} y="0" width={step} height="100">
      <title>{`${dayLabel(labels[index])} · ${value} ${plural(value, "message")}`}</title>
    </rect>)}
  </svg>;
}

function Ranked({ rows, hue, unit }: { rows: RankedRow[]; hue: string; unit: string }) {
  const peak = Math.max(1, ...rows.map((row) => row.value));
  return <ol className="dash-ranked" data-hue={hue}>
    {rows.map((row) => <li key={row.key}>
      <span className="dash-ranked-name" title={row.note || row.label}>{row.mark}<span>{row.label}</span></span>
      <i style={{ width: `${Math.round((row.value / peak) * 100)}%` }} title={`${row.value} ${plural(row.value, unit)} in the last 90 days`} />
      <Bars values={row.series} labels={row.days} className="dash-spark" />
      <b>{row.value}</b>
    </li>)}
  </ol>;
}

function Panel({ title, note, hint, children }: { title: string; note: string; hint?: string; children: ReactNode }) {
  return <section className="dash-panel">
    <header><h4>{title}{hint && <InfoDot>{hint}</InfoDot>}</h4><small>{note}</small></header>
    {children}
  </section>;
}

type RankedRow = { key: string; label: string; note: string; value: number; series: number[]; days: string[]; mark?: ReactNode };

function usageRows(rows: UsageRow[], days: string[], label: (row: UsageRow) => string, mark?: (row: UsageRow) => ReactNode): RankedRow[] {
  return byUse(rows.filter((row) => rowTotal(row) > 0)).slice(0, RANKED_ROWS).map((row) => ({
    key: row.id,
    label: label(row),
    note: row.source,
    mark: mark?.(row),
    value: rowTotal(row),
    series: rowSeries(row, days),
    days,
  }));
}

function largestChange(snapshot: GitSnapshot) {
  const files = parseDiff(snapshot.diff);
  if (!files.length) return null;
  const worst = files.reduce((top, file) => file.added + file.removed > top.added + top.removed ? file : top);
  return { path: worst.path, added: worst.added, removed: worst.removed };
}

function storedSteps(signature: string): NextStep[] | null {
  try {
    const stored = JSON.parse(localStorage.getItem(STEPS_KEY) ?? "{}") as { signature?: string; at?: number; steps?: NextStep[] };
    if (stored.signature !== signature || !Array.isArray(stored.steps)) return null;
    return Date.now() - (stored.at ?? 0) < STEPS_TTL_MS ? stored.steps : null;
  } catch { return null; }
}

function keepSteps(signature: string, steps: NextStep[]) {
  try { localStorage.setItem(STEPS_KEY, JSON.stringify({ signature, at: Date.now(), steps })); } catch { return; }
}

export function Dashboard({ threads, folders, folderId, seed }: {
  threads: Thread[];
  folders: FolderGrant[];
  folderId: string;
  seed: (prompt: string) => void;
}) {
  const [usage, setUsage] = useState<{ skills: UsageRow[]; models: UsageRow[] }>({ skills: [], models: [] });
  const [repos, setRepos] = useState<Repo[]>([]);
  const [steps, setSteps] = useState<{ signature: string; steps: NextStep[] } | null>(null);
  const [asked, setAsked] = useState("");
  const requested = useRef(new Set<string>());

  const project = folders.find((grant) => grant.id === folderId);
  const filed = useMemo(() => threadFolderMap(), []);
  const mine = useMemo(() => {
    const own = threads.filter((thread) => thread.kind !== "subagent" && !thread.archivedAt);
    return project ? own.filter((thread) => filed[thread.id]?.[0] === project.id) : own;
  }, [threads, filed, project]);

  const ridgeDays = useMemo(() => recentDays(RIDGE_DAYS), []);
  const sparkDays = useMemo(() => recentDays(SPARK_DAYS), []);
  const days = useMemo(() => countDays(mine.flatMap(threadMessageDates)), [mine]);
  const messages = useMemo(() => mine.reduce((sum, thread) => sum + threadMessageCount(thread), 0), [mine]);
  const active = Object.keys(days).length;
  const ridge = useMemo(() => { const values = ridgeDays.map((key) => days[key] ?? 0); return { values, total: values.reduce((sum, value) => sum + value, 0) }; }, [ridgeDays, days]);
  const projects = useMemo(() => projectActivity(mine, (thread) => folders.find((grant) => grant.id === filed[thread.id]?.[0])?.name ?? "Unfiled"), [mine, folders, filed]);
  const recent = useMemo(() => [...mine].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [mine]);

  useEffect(() => {
    let live = true;
    void window.emma.capabilityUsage()
      .then((rows) => { if (live) setUsage({ skills: rows.skills, models: rows.models ?? [] }); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  const watched = useMemo(() => {
    if (project) return [project];
    const order = new Map(projects.map((row, index) => [row.name, index]));
    return [...folders].sort((left, right) => (order.get(left.name) ?? 99) - (order.get(right.name) ?? 99)).slice(0, STATUS_PROJECTS);
  }, [project, folders, projects]);

  useEffect(() => {
    let live = true;
    void Promise.all(watched.map((grant) => window.emma.gitStatus(grant.id)
      .then((git) => git ? { id: grant.id, name: grant.name, git } : null)
      .catch(() => null)))
      .then((found) => { if (live) setRepos(found.filter((repo): repo is Repo => !!repo)); });
    return () => { live = false; };
  }, [watched]);

  const here = repos.find((repo) => repo.id === folderId) ?? (project ? undefined : repos[0]);
  const state: WorkState = useMemo(() => here ? {
    project: here.name,
    branch: here.git.branch,
    ahead: here.git.ahead,
    behind: here.git.behind,
    files: here.git.files.map((file) => ({ path: file.path, state: fileState(file) })),
    largest: largestChange(here.git),
    threads: recent.slice(0, TILE_THREADS).map((thread) => thread.displayTitle || thread.title),
  } : { ...emptyWorkState, project: project?.name ?? "", threads: recent.slice(0, TILE_THREADS).map((thread) => thread.displayTitle || thread.title) },
  [here, project, recent]);

  const signature = `${state.project}|${state.branch}|${state.ahead}|${state.behind}|${state.files.length}|${state.largest?.path ?? ""}|${state.threads[0] ?? ""}`;
  const cached = useMemo(() => storedSteps(signature), [signature]);

  useEffect(() => {
    if (cached || requested.current.has(signature)) return;
    requested.current.add(signature);
    let live = true;
    void window.emma.nextSteps(state)
      .then((found) => {
        if (!live) return;
        setAsked(signature);
        if (!found.length) return;
        setSteps({ signature, steps: found });
        keepSteps(signature, found);
      })
      .catch(() => { if (live) setAsked(signature); });
    return () => { live = false; };
  }, [cached, signature, state]);

  const suggested = cached ?? (steps?.signature === signature ? steps.steps : []);
  const settled = !!cached || asked === signature;
  const tiles = suggested.length ? suggested : defaultSteps(state);
  const modelRows = usageRows(usage.models, sparkDays, (row) => short(row.name), (row) => <BrandIcon brand={brandForModel(row.name)} className="dash-brand" />);
  const skillRows = usageRows(usage.skills, sparkDays, (row) => row.name);

  return <div className="dash">
    <header className="dash-head">
      <Mark />
      <h3>{project ? project.name : "What are we working on?"}</h3>
      <p>{project
        ? `${mine.length} ${plural(mine.length, "thread")} here · ${messages} ${plural(messages, "message")} · ${streak(days)} day streak`
        : `${mine.length} ${plural(mine.length, "thread")} · ${messages} ${plural(messages, "message")} · ${active} active ${plural(active, "day")}`}</p>
    </header>

    <div className="dash-grid">
      <section className="dash-panel dash-wide">
        <header>
          <h4>Last {RIDGE_DAYS} days<InfoDot>Every message in {project ? "this project's threads" : "your threads"}, by the day it was sent.</InfoDot></h4>
          <small>{ridge.total ? `peak ${Math.max(...ridge.values)}/day · ${streak(days)} day streak` : "nothing sent yet"}</small>
        </header>
        {ridge.total
          ? <><Ridge values={ridge.values} labels={ridgeDays} /><footer><small>{dayLabel(ridgeDays[0])}</small><small>{dayLabel(ridgeDays.at(-1) ?? "")}</small></footer></>
          : <p className="dash-empty">Nothing sent in the last {RIDGE_DAYS} days. Every message you send draws a day here.</p>}
      </section>

      <Panel title="Models" note={modelRows.length ? `${usage.models.length} used` : "none yet"}
        hint="Every model a turn has been sent to in the last 90 days, and how often.">
        {modelRows.length
          ? <Ranked rows={modelRows} hue="violet" unit="turn" />
          : <p className="dash-empty">No turn has run yet. Whichever model answers gets a row here.</p>}
      </Panel>

      <Panel title="Skills" note={skillRows.length ? `${usage.skills.length} imported` : "none yet"}
        hint="Imported skills, counted the turn they fire.">
        {skillRows.length
          ? <Ranked rows={skillRows} hue="teal" unit="run" />
          : <p className="dash-empty">Nothing imported has fired yet. Use <code>/import</code> to scan this Mac.</p>}
      </Panel>

      {project
        ? <Panel title="Working tree" note={here ? here.git.branch : "not a repository"}
            hint="What git says about this project right now: its branch, how it sits against its upstream, and the biggest uncommitted change.">
            {here ? <TreeStatus repo={here} largest={state.largest} /> : <p className="dash-empty">No git repository in this folder.</p>}
          </Panel>
        : <Panel title="Projects" note={`${projects.length} ${plural(projects.length, "project")}`}
            hint="Threads grouped by the folder they are filed under, with each project's git state beside it.">
            {projects.length
              ? <ol className="dash-projects">
                  {projects.slice(0, RANKED_ROWS).map((row, index) => {
                    const repo = repos.find((one) => one.name === row.name);
                    return <li key={row.name} data-hue={HUES[index % HUES.length]}>
                      <strong>{row.name}</strong>
                      <span>{repo ? `${repo.git.branch}${repo.git.files.length ? ` · ${repo.git.files.length} changed` : " · clean"}` : `last ${day(row.lastAt)}`}</span>
                      <Bars values={sparkDays.map((key) => row.days[key] ?? 0)} labels={sparkDays} className="dash-spark" />
                      <b>{row.threads}</b>
                    </li>;
                  })}
                </ol>
              : <p className="dash-empty">No threads filed under a folder yet.</p>}
          </Panel>}
    </div>

    <section className="dash-next">
      <header>
        <h4>What to work on next</h4>
        <small>{!settled ? "reading the project…" : suggested.length ? "suggested on a free model" : "from your working tree"}</small>
      </header>
      <div className="dash-tiles">
        {tiles.map((step, index) => <button type="button" key={step.title} onClick={() => seed(step.prompt)} data-hue={HUES[index % HUES.length]}>
          <em>{String(index + 1).padStart(2, "0")}</em>
          <strong>{step.title}</strong>
          <small>{step.detail}</small>
        </button>)}
      </div>
    </section>
  </div>;
}

function TreeStatus({ repo, largest }: { repo: Repo; largest: WorkState["largest"] }) {
  const changed = repo.git.files.length;
  return <dl className="dash-tree">
    <div><dt>Branch</dt><dd>{repo.git.branch || "detached"}</dd></div>
    <div><dt>Upstream</dt><dd>{repo.git.upstream ? `${repo.git.ahead} ahead · ${repo.git.behind} behind` : "not tracked"}</dd></div>
    <div><dt>Uncommitted</dt><dd>{changed ? `${changed} ${plural(changed, "file")}` : "clean"}</dd></div>
    <div><dt>Largest change</dt><dd>{largest ? <span className="dash-diff"><FileMark path={largest.path} /><code>{largest.path}</code><b>+{largest.added}</b><i>−{largest.removed}</i></span> : "—"}</dd></div>
  </dl>;
}
