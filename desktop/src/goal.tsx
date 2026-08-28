import { createContext, useContext, useState } from "react";
import { DEFAULT_GOAL_TOKEN_BUDGET, GOAL_BLOCKED_TURNS, GOAL_LABELS, MAX_GOAL_TURNS, goalSpent, goalTokensLeft, type Goal, type GoalStatus } from "../shared/goal";
import { planState, type PlanStep } from "../shared/plan";
import { charLabel } from "../shared/usage";
import { formatDuration } from "../shared/trace";
import { plural } from "./plural";
import { PlanGraph, usePlanShape, usePlans } from "./plan";
import { useAgents } from "./agents";
import { Markdown } from "./markdown";
import { InfoDot } from "./icons";
import { reasonText } from "./errors";
import { zoned } from "./dates";
import type { Thread } from "./types";

export const GoalThreads = createContext<Thread[]>([]);

const revisionTime = zoned({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const elapsed = (seconds: number) => formatDuration(seconds * 1000);

const stamp = (value: string) => {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : revisionTime(at);
};

const resumable: GoalStatus[] = ["paused", "blocked", "usageLimited", "active"];

function GoalPill({ status }: { status: GoalStatus }) {
  return <span className="goal-pill" data-status={status}>{GOAL_LABELS[status]}</span>;
}

export function GoalCard({ threadId, onOpen }: { threadId: string; onOpen: (threadId: string) => void }) {
  const goal = useContext(GoalThreads).find((item) => item.id === threadId)?.goal;
  if (!goal) return null;
  const left = goalTokensLeft(goal);
  return <button
    type="button"
    className="goal-card"
    aria-label={`${GOAL_LABELS[goal.status]}: ${goal.objective}. ${charLabel(goal.tokensUsed)} of ${charLabel(goal.tokenBudget)} tokens spent over ${goal.turns} ${plural(goal.turns, "turn")}. Open the goal.`}
    onClick={() => onOpen(threadId)}
  >
    <span className="goal-card-head"><GoalPill status={goal.status} /><strong>{goal.objective}</strong></span>
    <span className="goal-bar" aria-hidden="true"><i style={{ inlineSize: `${Math.round(goalSpent(goal) * 100)}%` }} /></span>
    <span className="goal-card-meta" aria-hidden="true">
      <span>{charLabel(goal.tokensUsed)} spent</span>
      <span>{charLabel(left)} left</span>
      <span>{elapsed(goal.timeUsedSeconds)}</span>
      <span>{goal.turns} of {MAX_GOAL_TURNS} {plural(MAX_GOAL_TURNS, "turn")}</span>
    </span>
  </button>;
}

function GoalLedger({ goal }: { goal: Goal }) {
  return <div className="goal-ledger">
    <div className="goal-bar" role="img" aria-label={`${charLabel(goal.tokensUsed)} of ${charLabel(goal.tokenBudget)} tokens spent`}><i style={{ inlineSize: `${Math.round(goalSpent(goal) * 100)}%` }} /></div>
    <dl>
      <div><dt>Budget</dt><dd>{charLabel(goal.tokenBudget)}</dd></div>
      <div><dt>Spent</dt><dd>{charLabel(goal.tokensUsed)}</dd></div>
      <div><dt>Left</dt><dd>{charLabel(goalTokensLeft(goal))}</dd></div>
      <div><dt>Elapsed</dt><dd>{elapsed(goal.timeUsedSeconds)}</dd></div>
      <div><dt>Turns</dt><dd>{goal.turns} of {MAX_GOAL_TURNS}</dd></div>
      <div><dt>Started</dt><dd>{stamp(goal.createdAt)}</dd></div>
    </dl>
  </div>;
}

function GoalPlan({ threadId, onOpenThread }: { threadId: string; onOpenThread: (threadId: string) => void }) {
  const agents = useAgents();
  const plans = usePlans(threadId);
  const plan = plans.find((item) => planState(item) === "running") ?? plans[0];
  const shape = usePlanShape(plan);
  const [pick, setPick] = useState("");
  if (!plan) return null;
  const at = plan.steps.find((item) => item.id === pick) ?? plan.steps.find((item) => item.status === "running");
  const ranBy = (step: PlanStep) => agents.find((agent) => agent.title === step.title);
  const revisions = plan.revisions ?? [];
  return <section className="goal-band goal-plan">
    <h3>{plan.title}</h3>
    <PlanGraph
      steps={plan.steps}
      shape={shape}
      at={at?.id}
      describe={(step) => ({
        label: `${step.title} — ${shape.state(step)}${ranBy(step) ? ", open its thread" : ""}`,
        title: `${step.title} — ${shape.state(step)}${step.needs.length ? `\nwaits on ${step.needs.join(", ")}` : ""}\n${step.result || step.brief}`,
      })}
      onPick={(step) => {
        const agent = ranBy(step);
        if (agent && step.id === at?.id) onOpenThread(agent.threadId);
        else setPick(step.id === pick ? "" : step.id);
      }}
    />
    {revisions.length > 0 && <ol className="goal-revisions">
      {revisions.map((revision, index) => <li key={`${revision.at}-${index}`}>
        <time dateTime={revision.at}>{stamp(revision.at)}</time>
        <span>{revision.steps} {plural(revision.steps, "step")}</span>
        <em title={revision.added.join(", ")} data-empty={revision.added.length ? undefined : ""}>+{revision.added.length}</em>
        <em title={revision.rewritten.join(", ")} data-empty={revision.rewritten.length ? undefined : ""}>~{revision.rewritten.length}</em>
        <em title={revision.removed.join(", ")} data-empty={revision.removed.length ? undefined : ""}>-{revision.removed.length}</em>
      </li>)}
    </ol>}
  </section>;
}

function GoalAgents({ threadId, onOpenThread }: { threadId: string; onOpenThread: (threadId: string) => void }) {
  const agents = useAgents().filter((agent) => agent.parentThreadId === threadId);
  if (!agents.length) return null;
  return <section className="goal-band">
    <h3>Working on it</h3>
    <ul className="subagent-list">
      {agents.map((agent) => <li key={agent.threadId}>
        <button type="button" className="subagent" title={`${agent.title} — ${agent.activity}`} onClick={() => onOpenThread(agent.threadId)}>
          <i className="subagent-square" style={{ background: agent.color }} data-status={agent.status} aria-hidden="true" />
          <span>{agent.title}</span>
          <em>{agent.status}</em>
        </button>
      </li>)}
    </ul>
  </section>;
}

export function GoalView({ thread, busy, reload, onOpenThread }: { thread: Thread; busy: boolean; reload: () => unknown; onOpenThread: (threadId: string) => void }) {
  const [error, setError] = useState("");
  const goal = thread.goal;
  const run = (work: Promise<unknown>) => {
    setError("");
    void work.then(() => reload()).catch((reason: unknown) => setError(reasonText(reason)));
  };
  return <section className="conversation goal-view" aria-label="Goal">
    <header className="thread-bar">
      <h2>Goal</h2>
      <InfoDot>While a goal is active Emma re-drives this thread turn after turn on her own, and stops when the objective is met with evidence, the same blocker stands {GOAL_BLOCKED_TURNS} turns running, or the token budget runs out.</InfoDot>
      <div className="thread-actions">{goal && <GoalPill status={goal.status} />}</div>
    </header>
    <div className="transcript">
      {error && <p className="capability-error" role="alert">{error}</p>}
      {!goal ? <p className="waiting">This thread has no goal.</p> : <>
        <p className="goal-objective">{goal.objective}</p>
        <GoalLedger goal={goal} />
        <div className="goal-controls">
          {goal.status === "active" && <button type="button" disabled={busy} onClick={() => run(window.emma.updateGoal({ threadId: thread.id, status: "paused" }))}>Pause</button>}
          {resumable.includes(goal.status) && <button type="button" disabled={busy} onClick={() => run(window.emma.updateGoal({ threadId: thread.id, status: "active" }))}>Resume</button>}
          {(goal.status === "budgetLimited" || goalTokensLeft(goal) === 0) && <button
            type="button"
            className="goal-primary"
            disabled={busy}
            title={`Grant ${charLabel(DEFAULT_GOAL_TOKEN_BUDGET)} more tokens and put Emma back on it`}
            onClick={() => run(window.emma.updateGoal({ threadId: thread.id, extraTokens: DEFAULT_GOAL_TOKEN_BUDGET }))}
          >Continue · +{charLabel(DEFAULT_GOAL_TOKEN_BUDGET)}</button>}
          <button type="button" className="goal-clear" disabled={busy} onClick={() => run(window.emma.clearGoal(thread.id))}>Clear</button>
        </div>
        {(goal.blockedReason || goal.blockedStreak > 0) && <section className="goal-band goal-blocker">
          <h3>Blocker {Math.min(Math.max(goal.blockedStreak, 1), GOAL_BLOCKED_TURNS)} of {GOAL_BLOCKED_TURNS}</h3>
          <p>{goal.blockedReason || "The blocker was not written down."}</p>
        </section>}
        {goal.evidence && <section className="goal-band">
          <h3>Evidence</h3>
          <div className="message-body"><Markdown text={goal.evidence} /></div>
        </section>}
        <GoalPlan threadId={thread.id} onOpenThread={onOpenThread} />
        <GoalAgents threadId={thread.id} onOpenThread={onOpenThread} />
      </>}
    </div>
  </section>;
}
