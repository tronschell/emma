export const GOAL_STATUSES = ["active", "paused", "complete", "blocked", "budgetLimited", "usageLimited"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export type Goal = {
  objective: string;
  status: GoalStatus;
  evidence: string;
  blockedReason: string;
  blockedStreak: number;
  blockedAtTurn: number;
  tokenBudget: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  turns: number;
  createdAt: string;
  updatedAt: string;
};

export const DEFAULT_GOAL_TOKEN_BUDGET = 200_000;
export const GOAL_BLOCKED_TURNS = 3;
export const MAX_GOAL_OBJECTIVE_CHARS = 2_000;
export const MAX_GOAL_EVIDENCE_CHARS = 4_000;
export const MAX_GOAL_TURNS = 40;

export const GOAL_LABELS: Record<GoalStatus, string> = {
  active: "Pursuing",
  paused: "Paused",
  complete: "Achieved",
  blocked: "Blocked",
  budgetLimited: "Budget reached",
  usageLimited: "Usage limited",
};

export const GOAL_MARKER = /\[goal:([a-z0-9-]{1,96})]$/;

export const goalMarker = (threadId: string) => `[goal:${threadId}]`;

export function markedGoal(output: string | undefined): string | undefined {
  for (const line of (output ?? "").split("\n")) {
    const found = GOAL_MARKER.exec(line.trim());
    if (found) return found[1];
  }
  return undefined;
}

export function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === "string" && (GOAL_STATUSES as readonly string[]).includes(value);
}

export const goalPursuing = (goal: Goal | undefined | null): goal is Goal => goal?.status === "active";

export const goalTokensLeft = (goal: Goal) => Math.max(0, goal.tokenBudget - goal.tokensUsed);

export const goalSpent = (goal: Goal) => goal.tokenBudget > 0 ? Math.min(1, goal.tokensUsed / goal.tokenBudget) : 0;

export function goalContinues(goal: Goal | undefined | null): boolean {
  return goalPursuing(goal) && goal.turns < MAX_GOAL_TURNS && goalTokensLeft(goal) > 0;
}

export function goalDrivesAgain(state: { goal?: Goal | null; subagent?: boolean; halted?: boolean }): boolean {
  return !state.subagent && !state.halted && goalContinues(state.goal);
}

export const GOAL_ACTIONS = ["set", "get", "update", "extend", "clear"] as const;
export type GoalAction = (typeof GOAL_ACTIONS)[number];

export const MAX_GOAL_REASON_CHARS = 1_000;
export const MAX_GOAL_TOKEN_BUDGET = 100_000_000;

export const GOAL_UPDATE_STATUSES = ["active", "paused", "complete", "blocked"] as const;
export type GoalUpdateStatus = (typeof GOAL_UPDATE_STATUSES)[number];

const USAGE_LIMITED = /\b(429|402)\b|rate[ _-]?limit|too many requests|quota|out of credits|insufficient (credit|balance|funds|quota)|usage limit|billing|payment required/i;

export function usageLimitedFailure(detail: string | undefined): boolean {
  return !!detail && USAGE_LIMITED.test(detail);
}

export function goalTitle(objective: string, max = 48): string {
  const first = objective.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/, 1)[0] ?? "";
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

const count = (value: number) => value.toLocaleString("en-US");

export function goalLine(goal: Goal): string {
  return `${GOAL_LABELS[goal.status]} — turn ${count(goal.turns)} of at most ${count(MAX_GOAL_TURNS)}, `
    + `${count(goal.tokensUsed)} of ${count(goal.tokenBudget)} tokens spent and ${count(goalTokensLeft(goal))} left, `
    + `${count(goal.timeUsedSeconds)} seconds pursuing it.`;
}

const blockerNote = (goal: Goal) => goal.blockedReason
  ? `\nThe blocker on record: ${goal.blockedReason} — reported on ${count(goal.blockedStreak)} of the ${count(GOAL_BLOCKED_TURNS)} consecutive goal turns it takes to call a goal blocked.`
  : "";

const evidenceNote = (goal: Goal) => goal.evidence ? `\nEvidence on record: ${goal.evidence}` : "";

const spentSoFar = (goal: Goal) =>
  `It took ${count(goal.turns)} ${goal.turns === 1 ? "turn" : "turns"} and ${count(goal.tokensUsed)} of the ${count(goal.tokenBudget)} tokens it was given.`;

export function goalResult(action: GoalAction, threadId: string, goal: Goal | undefined): string {
  const mark = goalMarker(threadId);
  if (!goal) {
    return action === "clear"
      ? `The goal is cleared. This thread is pursuing nothing now, and no further turns are driven at it on its own. Finish what you are saying and stop.`
      : `This thread has no goal. Set one with goal {"action":"set","objective":"…"} when the user asks for an end state that will not fit in one turn.`;
  }
  const state = `${goalLine(goal)}${evidenceNote(goal)}${blockerNote(goal)}`;
  switch (action) {
    case "set":
      return `Pursuing "${goal.objective}". ${mark}\n\n${state}\n`
        + `This goal outlives this turn: when you stop talking Emma drives another turn at it, and another, until you record it complete with evidence, the budget runs out, or the user stops it. `
        + `So start the work now instead of describing what you are about to do, and keep the objective whole — do not shrink it to what fits in this turn.`;
    case "get":
      return `Pursuing "${goal.objective}". ${mark}\n\n${state}`;
    case "extend":
      return `The budget is now ${count(goal.tokenBudget)} tokens and the goal is active again. ${mark}\n\n${state}\n`
        + `${count(goalTokensLeft(goal))} tokens are left to spend on it. This is the user's money — do not extend it a second time without asking.`;
    case "clear":
      return `The goal is cleared. This thread is pursuing nothing now, and no further turns are driven at it on its own.`;
    case "update":
      switch (goal.status) {
        case "complete":
          return `Achieved: "${goal.objective}". ${mark}\n\n${state}\n`
            + `Nothing more is driven at this thread on its own. Tell the user what the evidence actually shows and what it cost — ${spentSoFar(goal)}`;
        case "blocked":
          return `Blocked: ${goal.blockedReason || "the same condition, three goal turns running"}. ${mark}\n\n${state}\n`
            + `That blocker has now stopped you on ${count(GOAL_BLOCKED_TURNS)} consecutive goal turns, so the pursuit stops here rather than burning the rest of the budget on it. `
            + `Tell the user what is in the way and exactly what you need from them. goal {"action":"update","status":"active"} picks it back up, with the blocked count starting fresh.`;
        case "paused":
          return `Paused: "${goal.objective}". ${mark}\n\n${state}\n`
            + `No further turns are driven at it until it is made active again. Nothing has been thrown away — the budget and the turns already spent are still on it.`;
        case "budgetLimited":
          return `Out of budget: "${goal.objective}". ${mark}\n\n${state}\n`
            + `Say how far you actually got and what is left. goal {"action":"extend","extraTokens":…} carries on, but ask the user first.`;
        case "usageLimited":
          return `Stopped by the provider: "${goal.objective}". ${mark}\n\n${state}\n`
            + `The model refused on usage or rate limits, not on the work. Say so, and pick it back up with goal {"action":"update","status":"active"} once the user says the limit is behind them.`;
        case "active":
          return goal.blockedStreak > 0
            ? `Blocker recorded — ${count(goal.blockedStreak)} of ${count(GOAL_BLOCKED_TURNS)}. ${mark}\n\n${state}\n`
              + `The goal stays active, because one blocked turn is not a blocked goal. Keep working: route around it, come at it another way, or do the part of the objective it does not touch. `
              + `If the same thing stops you again next goal turn, report it again — Emma counts the streak, and at ${count(GOAL_BLOCKED_TURNS)} in a row the goal is called blocked and the pursuit ends.`
            : `Pursuing "${goal.objective}", with a clean slate on blockers. ${mark}\n\n${state}\n`
              + `Carry on with the work. Completion still needs evidence of the end state itself, not of the effort.`;
      }
  }
}
