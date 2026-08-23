/* The plan this thread is working through, as a component of the inspector.

   A plan is a graph of subagents, so it is drawn as one: a row per wave of
   `planRows`, edges from what each step waits on, and every node coloured by
   where that step has got to. Pressing a node lights its whole wave — the wave
   is the parallelism, and "what is running right now" is the question the panel
   exists to answer.

   Read-only, like the two rails below it. Every node here moves because a
   subagent said so; the file it says it into is under Emma's data folder and
   opens in any editor. */

import { useEffect, useMemo, useRef, useState } from "react";
import { PLAN_ROW, planEdges, planLayout, planProgress, planRows, readySteps, renderPlan, type Plan, type PlanStep } from "../shared/plan";
import { plural } from "./activity";
import { ExpandIcon } from "./icons";
import type { LiveAgent } from "../shared/agents";

/** Tasks on one page of a column this narrow. A step of twenty is normal; a page of twenty is not. */
const TASKS_PER_PAGE = 6;

/** Where a step has got to: the four written statuses, with `todo` split by whether anything still holds it up. */
type NodeState = "done" | "running" | "failed" | "ready" | "waiting";
const STATE_ORDER: NodeState[] = ["running", "ready", "waiting", "done", "failed"];

/**
 * Every plan filed under this thread, and every tick of every subagent in a wave.
 * `sample` is the Settings preview's seam — the same one the timeline has — so the
 * arranger draws a real plan without a thread to have written one.
 */
function usePlans(threadId: string, sample?: Plan[]): Plan[] {
  const [plans, setPlans] = useState<Plan[]>([]);
  useEffect(() => {
    if (sample) return;
    const load = () => void window.emma.listPlans().then(setPlans).catch(() => undefined);
    load();
    return window.emma.onPlansChanged(load);
  }, [sample]);
  return useMemo(() => sample ?? plans.filter((plan) => plan.threadId === threadId), [sample, plans, threadId]);
}

/** The subagent working on this step right now, matched on the title it was spawned with. */
const workingOn = (agents: LiveAgent[], step: PlanStep) =>
  agents.find((agent) => agent.title === step.title && (agent.status === "running" || agent.status === "waiting"));

export function PlanRail({ threadId, agents, sample }: { threadId: string; agents: LiveAgent[]; sample?: Plan[] }) {
  const plans = usePlans(threadId, sample);
  const [pick, setPick] = useState("");
  const [pinned, setPinned] = useState("");
  const [reading, setReading] = useState(false);
  const plan = plans.find((item) => item.id === pick) ?? plans[0];
  const progress = plan ? planProgress(plan) : undefined;
  const waves = useMemo(() => plan ? planRows(plan.steps) : [], [plan]);
  const { spots, height } = useMemo(() => planLayout(waves), [waves]);
  // A step is `waiting` rather than `ready` when something it needs has not landed
  // yet — the same test the runner uses to pick the next wave, so the colours and
  // the delegation can never disagree.
  const ready = useMemo(() => new Set(plan ? readySteps(plan).map((item) => item.id) : []), [plan]);
  const state = (item: PlanStep): NodeState => item.status !== "todo" ? item.status : ready.has(item.id) ? "ready" : "waiting";
  // Where the plan is, unless you have pressed somewhere else: the running step,
  // then the first one still to go. Derived rather than an effect, so the panel
  // follows a wave finishing without a render to catch up on.
  const step = plan?.steps.find((item) => item.id === pinned)
    ?? plan?.steps.find((item) => item.status === "running")
    ?? plan?.steps.find((item) => item.status !== "done");
  const wave = step ? spots.get(step.id)?.wave : undefined;

  if (!plan || !progress) {
    return <section className="plan-widget">
      <span>Plan</span>
      <p className="subagent-empty">Nothing planned yet — Emma writes one per <code>plan write</code>.</p>
    </section>;
  }

  const lit = wave === undefined ? [] : (waves[wave] ?? []).map((id) => spots.get(id)?.y ?? 0);
  const keys = STATE_ORDER.filter((name) => plan.steps.some((item) => state(item) === name));

  return <section className="plan-widget">
    {/* The label band stacks over the graph like every other inspector section, so
        the affordance for the file itself rides the label row. */}
    <span><span className="context-title">Plan · {progress.done} of {progress.steps} {plural(progress.steps, "step")}<button type="button" className="context-expand" aria-haspopup="dialog" aria-label="Read the plan file" title={`Read ${plan.id}.md`} onClick={() => setReading(true)}><ExpandIcon /></button></span></span>
    {/* One thread can hold more than one plan. Rare, so it costs a row only when it happens. */}
    {plans.length > 1 && <div className="plan-switch">
      {plans.map((item) => <button key={item.id} type="button" className={item.id === plan.id ? "active" : ""} title={item.title} onClick={() => { setPick(item.id); setPinned(""); }}>{item.title}</button>)}
    </div>}
    <div className="plan-head">
      <strong title={plan.goal || plan.title}>{plan.title}</strong>
      <em>{progress.doneTasks}/{progress.tasks}</em>
    </div>
    <div className="plan-graph" style={{ height }}>
      {/* The pressed node's whole wave, because what runs together is the point. */}
      {lit.length > 0 && <div className="plan-band" style={{ top: Math.min(...lit) - PLAN_ROW / 2, height: Math.max(...lit) - Math.min(...lit) + PLAN_ROW }} />}
      <svg className="plan-edges" aria-hidden="true">
        {planEdges(plan.steps).map(({ from, to }) => {
          const a = spots.get(from);
          const b = spots.get(to);
          if (!a || !b) return null;
          return <line
            key={`${from}>${to}`}
            className={`${b.wave - a.wave > 1 ? "far" : ""} ${step && (from === step.id || to === step.id) ? "lit" : ""}`}
            x1={`${a.x}%`} y1={a.y} x2={`${b.x}%`} y2={b.y}
          />;
        })}
      </svg>
      {plan.steps.map((item, index) => {
        const spot = spots.get(item.id);
        if (!spot) return null;
        const agent = workingOn(agents, item);
        const ticked = item.tasks.filter((task) => task.done).length;
        return <button
          key={item.id}
          type="button"
          className={`plan-node ${item.id === step?.id ? "active" : ""}`}
          data-status={state(item)}
          style={{ left: `${spot.x}%`, top: spot.y }}
          aria-label={`${item.title} — ${state(item)}`}
          title={`${item.title} — ${state(item)}${item.tasks.length ? ` · ${ticked}/${item.tasks.length}` : ""}${item.needs.length ? `\nwaits on ${item.needs.join(", ")}` : ""}\n${agent?.activity || item.result || item.brief}`}
          onClick={() => setPinned(item.id === pinned ? "" : item.id)}
        >{index + 1}</button>;
      })}
    </div>
    {/* Only the states this plan is actually in: a five-swatch key in a 288px column
        is four more words than it needs to be. */}
    <div className="plan-key">
      {keys.map((name) => <span key={name} data-status={name}><i aria-hidden="true" />{name}</span>)}
    </div>
    {step && wave !== undefined && <PlanTasks key={`${plan.id}:${step.id}`} step={step} at={plan.steps.indexOf(step) + 1} wave={wave + 1} abreast={waves[wave]?.length ?? 1} agent={workingOn(agents, step)} />}
    {reading && <PlanFile plan={plan} close={() => setReading(false)} />}
  </section>;
}

/**
 * The whole plan as the file holds it. `renderPlan` rather than a read of the
 * bytes: the store *is* the render, so this is the same text — normalised, which
 * is all a hand-edit between saves would differ by.
 */
function PlanFile({ plan, close }: { plan: Plan; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  const dismiss = () => dialog.current?.close();
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="plan-file-title" onClose={close} onCancel={(event) => { event.preventDefault(); dismiss(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
    <section className="agent-dialog plan-dialog">
      <header><div><span>{plan.id}.md</span><h2 id="plan-file-title">{plan.title}</h2></div><button type="button" onClick={dismiss} aria-label="Close the plan file">×</button></header>
      <pre className="artifact-code plan-file">{renderPlan(plan)}</pre>
    </section>
  </dialog>;
}

/** The pressed step's own boxes, a page at a time — a plan is where the work is written down. */
function PlanTasks({ step, at, wave, abreast, agent }: { step: PlanStep; at: number; wave: number; abreast: number; agent?: LiveAgent }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(step.tasks.length / TASKS_PER_PAGE));
  const on = Math.min(page, pages - 1);
  const shown = step.tasks.slice(on * TASKS_PER_PAGE, on * TASKS_PER_PAGE + TASKS_PER_PAGE);
  return <div className="plan-tasks">
    <span className="plan-step-name">Wave {wave}{abreast > 1 ? ` · ${abreast} at once` : ""}</span>
    {/* The nodes are numbered, not labelled — this is where the pressed one says its name. */}
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
