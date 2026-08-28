import { useEffect, useMemo, useRef, useState } from "react";
import { PLAN_ROW, planEdges, planLayout, planProgress, planRows, planState, readySteps, type Plan, type PlanSpot, type PlanStep } from "../shared/plan";
import { plural } from "./plural";
import { ExpandIcon } from "./icons";
import { Markdown } from "./markdown";
import type { LiveAgent } from "../shared/agents";

const TASKS_PER_PAGE = 6;

type NodeState = "done" | "running" | "failed" | "ready" | "waiting";
const STATE_ORDER: NodeState[] = ["running", "ready", "waiting", "done", "failed"];

export type PlanShape = {
  waves: string[][];
  spots: Map<string, PlanSpot>;
  height: number;
  row: number;
  state: (step: PlanStep) => NodeState;
};

const MAP_ROW = 56;

export function usePlans(threadId: string, sample?: Plan[]): Plan[] {
  const [plans, setPlans] = useState<Plan[]>([]);
  useEffect(() => {
    if (sample) return;
    const load = () => void window.emma.listPlans().then(setPlans).catch(() => undefined);
    load();
    return window.emma.onPlansChanged(load);
  }, [sample]);
  return useMemo(() => sample ?? plans.filter((plan) => plan.threadId === threadId), [sample, plans, threadId]);
}

export function usePlanShape(plan: Plan | undefined, row = PLAN_ROW): PlanShape {
  const waves = useMemo(() => plan ? planRows(plan.steps) : [], [plan]);
  const { spots, height } = useMemo(() => planLayout(waves, plan?.steps ?? [], row), [waves, plan, row]);
  const ready = useMemo(() => new Set(plan ? readySteps(plan).map((item) => item.id) : []), [plan]);
  return { waves, spots, height, row, state: (step) => step.status !== "todo" ? step.status : ready.has(step.id) ? "ready" : "waiting" };
}

const workingOn = (agents: LiveAgent[], step: PlanStep) =>
  agents.find((agent) => agent.title === step.title && (agent.status === "running" || agent.status === "waiting"));

const ranBy = (agents: LiveAgent[], step: PlanStep) =>
  workingOn(agents, step) ?? agents.find((agent) => agent.title === step.title);

export function PlanGraph({ steps, shape, at, describe, onPick }: {
  steps: PlanStep[];
  shape: PlanShape;
  at?: string;
  describe: (step: PlanStep) => { title: string; label: string };
  onPick: (step: PlanStep) => void;
}) {
  const { waves, spots, height, row, state } = shape;
  const wave = at === undefined ? undefined : spots.get(at)?.wave;
  const lit = wave === undefined ? [] : (waves[wave] ?? []).map((id) => spots.get(id)?.y ?? 0);
  return <div className="plan-graph" style={{ height }}>
    {lit.length > 0 && <div className="plan-band" style={{ top: Math.min(...lit) - row / 2, height: Math.max(...lit) - Math.min(...lit) + row }} />}
    <svg className="plan-edges" aria-hidden="true">
      {planEdges(steps).map(({ from, to }) => {
        const a = spots.get(from);
        const b = spots.get(to);
        if (!a || !b) return null;
        return <line
          key={`${from}>${to}`}
          className={`${b.wave - a.wave > 1 ? "far" : ""} ${at === from || at === to ? "lit" : ""}`}
          x1={`${a.x}%`} y1={a.y} x2={`${b.x}%`} y2={b.y}
        />;
      })}
    </svg>
    {steps.map((item, index) => {
      const spot = spots.get(item.id);
      if (!spot) return null;
      const said = describe(item);
      return <button
        key={item.id}
        type="button"
        className={`plan-node ${item.id === at ? "active" : ""}`}
        data-status={state(item)}
        style={{ left: `${spot.x}%`, top: spot.y }}
        aria-label={said.label}
        title={said.title}
        onClick={() => onPick(item)}
      >{index + 1}</button>;
    })}
  </div>;
}

function PlanKey({ plan, shape }: { plan: Plan; shape: PlanShape }) {
  const keys = STATE_ORDER.filter((name) => plan.steps.some((item) => shape.state(item) === name));
  return <div className="plan-key">
    {keys.map((name) => <span key={name} data-status={name}><i aria-hidden="true" />{name}</span>)}
  </div>;
}

export function PlanRail({ threadId, agents, sample, onOpen }: { threadId: string; agents: LiveAgent[]; sample?: Plan[]; onOpen?: (threadId: string) => void }) {
  const plans = usePlans(threadId, sample);
  const [pick, setPick] = useState("");
  const [pinned, setPinned] = useState("");
  const [reading, setReading] = useState(false);
  const shown = useMemo(() => [...plans].sort((left, right) => left.id.localeCompare(right.id)), [plans]);
  const plan = plans.find((item) => item.id === pick)
    ?? plans.find((item) => planState(item) === "running")
    ?? plans[0];
  const shape = usePlanShape(plan);
  const progress = plan ? planProgress(plan) : undefined;
  const step = plan?.steps.find((item) => item.id === pinned)
    ?? plan?.steps.find((item) => item.status === "running")
    ?? plan?.steps.find((item) => item.status !== "done");

  if (!plan || !progress) {
    return <section className="plan-widget">
      <span>Plan</span>
      <p className="subagent-empty">Nothing planned yet — Emma writes one per <code>plan write</code>.</p>
    </section>;
  }

  const tabFor = (item: PlanStep) => onOpen && item.id === step?.id ? ranBy(agents, item) : undefined;

  return <section className="plan-widget">
    <span><span className="context-title">Plan · {progress.done} of {progress.steps} {plural(progress.steps, "step")}<button type="button" className="context-expand" aria-haspopup="dialog" aria-label="Read the plan file" title={`Read ${plan.id}.md`} onClick={() => setReading(true)}><ExpandIcon /></button></span></span>
    {shown.length > 1 && <div className="plan-switch">
      {shown.map((item) => {
        const state = planState(item);
        const at = planProgress(item);
        const said = `${item.title} — ${state}, ${at.done} of ${at.steps} ${plural(at.steps, "step")}`;
        return <button
          key={item.id}
          type="button"
          data-status={state}
          className={item.id === plan.id ? "active" : ""}
          aria-current={item.id === plan.id || undefined}
          aria-label={said}
          title={said}
          onClick={() => { setPick(item.id); setPinned(""); }}
        ><i aria-hidden="true" /><span>{item.title}</span></button>;
      })}
    </div>}
    <div className="plan-head">
      <strong title={plan.goal || plan.title}>{plan.title}</strong>
      <em>{progress.doneTasks}/{progress.tasks}</em>
    </div>
    <PlanGraph
      steps={plan.steps}
      shape={shape}
      at={step?.id}
      describe={(item) => {
        const agent = workingOn(agents, item);
        const tab = tabFor(item);
        const ticked = item.tasks.filter((task) => task.done).length;
        return {
          label: tab ? `${item.title} — ${shape.state(item)}, open its tab` : `${item.title} — ${shape.state(item)}`,
          title: `${item.title} — ${shape.state(item)}${item.tasks.length ? ` · ${ticked}/${item.tasks.length}` : ""}${item.needs.length ? `\nwaits on ${item.needs.join(", ")}` : ""}\n${agent?.activity || item.result || item.brief}${tab ? "\npress again to open its tab" : ""}`,
        };
      }}
      onPick={(item) => {
        const tab = tabFor(item);
        if (tab) onOpen?.(tab.threadId);
        else setPinned(item.id === pinned || item.id === step?.id ? "" : item.id);
      }}
    />
    <PlanKey plan={plan} shape={shape} />
    {step && <PlanTasks key={`${plan.id}:${step.id}`} step={step} at={plan.steps.indexOf(step) + 1} agent={workingOn(agents, step)} />}
    {reading && <PlanFile plan={plan} agents={agents} at={step?.id} close={() => setReading(false)} />}
  </section>;
}

function PlanFile({ plan, agents, at, close }: { plan: Plan; agents: LiveAgent[]; at?: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const doc = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState(at ?? "");
  const shape = usePlanShape(plan, MAP_ROW);
  const progress = planProgress(plan);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  useEffect(() => {
    if (!pick) return;
    doc.current?.querySelector(`[data-step="${CSS.escape(pick)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [pick]);
  const dismiss = () => dialog.current?.close();
  const wave = pick ? shape.spots.get(pick)?.wave : undefined;
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="plan-file-title" onClose={close} onCancel={(event) => { event.preventDefault(); dismiss(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
    <section className="agent-dialog plan-dialog">
      <header><div><span>{plan.id}.md</span><h2 id="plan-file-title">{plan.title}</h2></div><button type="button" onClick={dismiss} aria-label="Close the plan file">×</button></header>
      <div className="plan-split">
        <aside className="plan-map">
          <div className="plan-head">
            <strong>{progress.done} of {progress.steps} {plural(progress.steps, "step")}</strong>
            <em>{progress.doneTasks}/{progress.tasks}</em>
          </div>
          <PlanGraph
            steps={plan.steps}
            shape={shape}
            at={pick}
            describe={(item) => ({ label: `${item.title} — ${shape.state(item)}, show it in the plan`, title: `${item.title} — ${shape.state(item)}` })}
            onPick={(item) => setPick(item.id)}
          />
          <PlanKey plan={plan} shape={shape} />
        </aside>
        <div className="plan-doc" ref={doc}>
          {plan.goal.trim() && <div className="message-body plan-goal"><Markdown text={plan.goal} /></div>}
          {plan.steps.map((step, index) => <PlanEntry
            key={step.id}
            step={step}
            at={index + 1}
            state={shape.state(step)}
            agent={workingOn(agents, step)}
            active={step.id === pick}
            lit={wave !== undefined && shape.spots.get(step.id)?.wave === wave}
          />)}
        </div>
      </div>
    </section>
  </dialog>;
}

function PlanEntry({ step, at, state, agent, active, lit }: { step: PlanStep; at: number; state: NodeState; agent?: LiveAgent; active: boolean; lit: boolean }) {
  return <section data-step={step.id} className={`plan-entry ${lit ? "lit" : ""} ${active ? "active" : ""}`}>
    <h3 className="plan-entry-title">
      <b>{at}</b>
      <span>{step.title}</span>
      <span className="plan-key"><span data-status={state}><i aria-hidden="true" />{state}</span></span>
    </h3>
    <p className="plan-entry-needs">
      <code>{step.id}</code>
      {step.needs.length ? <>waits on {step.needs.map((need) => <code key={need}>{need}</code>)}</> : <em>first wave</em>}
    </p>
    {agent && <p className="plan-live"><i aria-hidden="true" />{agent.activity || "working"}</p>}
    {step.brief.trim() && <div className="message-body"><Markdown text={step.brief} /></div>}
    {step.tasks.length > 0 && <ol className="plan-list">
      {step.tasks.map((task, index) => <li key={index} className={task.done ? "done" : ""}>
        <i aria-hidden="true">{task.done ? "▣" : "▢"}</i>
        <span>{task.text}</span>
      </li>)}
    </ol>}
    {step.result && <p className="plan-result"><b>Result:</b> {step.result}</p>}
  </section>;
}

function PlanTasks({ step, at, agent }: { step: PlanStep; at: number; agent?: LiveAgent }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(step.tasks.length / TASKS_PER_PAGE));
  const on = Math.min(page, pages - 1);
  const shown = step.tasks.slice(on * TASKS_PER_PAGE, on * TASKS_PER_PAGE + TASKS_PER_PAGE);
  return <div className="plan-tasks">
    <p className="plan-step-title"><b>{at}</b><span>{step.title}</span></p>
    {agent && <p className="plan-live"><i aria-hidden="true" />{agent.activity || "working"}</p>}
    {step.result && <p className="plan-result">{step.result}</p>}
    <ol className="plan-list">
      {shown.map((task, offset) => <li key={on * TASKS_PER_PAGE + offset} className={task.done ? "done" : ""}>
        <i aria-hidden="true">{task.done ? "▣" : "▢"}</i>
        <span>{task.text}</span>
      </li>)}
      {!step.tasks.length && <li className="plan-none">No tasks written down — the brief is the whole of it.</li>}
    </ol>
    {pages > 1 && <nav className="plan-pages" aria-label="Task pages">
      <button type="button" disabled={on === 0} onClick={() => setPage(on - 1)} aria-label="Previous tasks">‹</button>
      <span>{on + 1} / {pages}</span>
      <button type="button" disabled={on >= pages - 1} onClick={() => setPage(on + 1)} aria-label="More tasks">›</button>
    </nav>}
  </div>;
}
