/* The plan Emma writes down before it delegates: steps, each one a subagent's
   brief, each
   wired to the steps it waits on. Steps whose dependencies are all met are one
   wave and run at once — which is the whole reason to write the plan down rather
   than do the work inside one turn.

   Markdown is the store, not an export of one. The file under <userData>/plans is
   what the tool rewrites, what the user can open in any editor, and what this
   parses back — so nothing here ever throws on a hand-mangled file. One grammar,
   three callers: the `plan` tool writes it, main runs a wave off it, and the plan
   widget in the thread inspector draws it. */

/** Steps in one plan. Past this it is a project, and wants a plan per part of it. */
export const MAX_PLAN_STEPS = 24;
/** Tasks under one step. Long lists are what the widget paginates. */
export const MAX_STEP_TASKS = 100;
/** One plan file, in bytes. Generous — it is prose plus checkboxes, not a corpus. */
export const MAX_PLAN_BYTES = 128 * 1024;
/** Plans in the folder, so a loop that writes one a turn cannot fill the widget. */
export const MAX_PLANS = 64;
export const MAX_PLAN_TITLE_CHARS = 200;

export const PLAN_STATUSES = ["todo", "running", "done", "failed"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export type PlanTask = { text: string; done: boolean };

export type PlanStep = {
  /** Lowercase, dashed, unique in the plan: what `needs` points at and what `update` names. */
  id: string;
  title: string;
  status: PlanStatus;
  /** Step ids that must be done before this one may start. Empty is the first wave. */
  needs: string[];
  /** Everything the subagent is told. It cannot see the conversation that planned it. */
  brief: string;
  tasks: PlanTask[];
  /** One line the subagent left behind, written back when its wave finishes. */
  result?: string;
};

export type Plan = {
  /** The file's own name, minted by the store from the title. */
  id: string;
  title: string;
  /** What the whole plan is for, in a sentence or two. */
  goal: string;
  steps: PlanStep[];
  updatedAt: string;
  /** The thread that wrote it, so its inspector is where the plan is watched. */
  threadId?: string;
};

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HEADING = /^##\s+(\S+)\s*[·—-]\s*(.+)$/;
const STATUS = /\s*`(\w+)`\s*$/;
const NEEDS = /^needs:\s*(.*)$/i;
const THREAD = /^thread:\s*(\S+)$/i;
const TASK = /^-\s*\[([ xX])]\s*(.*)$/;
const RESULT = /^\*\*result:\*\*\s*(.*)$/i;
/** What "waits on nothing" is written as, so an empty `needs:` line round-trips. */
const NOTHING = ["—", "-", "none", "nothing", ""];

const clean = (value: string, max: number) => value.replace(/\s+/g, " ").trim().slice(0, max);

export function planSlug(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  return slug || "plan";
}

export function isPlanStatus(value: unknown): value is PlanStatus {
  return typeof value === "string" && (PLAN_STATUSES as readonly string[]).includes(value);
}

/* ---------- Markdown, both ways ---------- */

/**
 * The file as it is stored. Every field is re-checked on the way in: this file is
 * on the user's disk and they are invited to edit it, so anything unreadable is a
 * step that keeps its text and loses its structure, never an exception.
 */
export function parsePlan(id: string, markdown: string, updatedAt = ""): Plan {
  const lines = markdown.split("\n");
  let title = "";
  let threadId = "";
  const goal: string[] = [];
  const steps: PlanStep[] = [];
  let brief: string[] = [];
  const flush = () => {
    const step = steps[steps.length - 1];
    if (step) step.brief = brief.join("\n").trim().slice(0, MAX_PLAN_BYTES);
    brief = [];
  };
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading && ID.test(heading[1]) && !steps.some((step) => step.id === heading[1])) {
      flush();
      const found = STATUS.exec(heading[2]);
      steps.push({
        id: heading[1],
        title: clean(heading[2].replace(STATUS, ""), MAX_PLAN_TITLE_CHARS) || heading[1],
        status: isPlanStatus(found?.[1]) ? found[1] : "todo",
        needs: [],
        brief: "",
        tasks: [],
      });
      continue;
    }
    const step = steps[steps.length - 1];
    if (!step) {
      if (!title && line.startsWith("# ")) { title = clean(line.slice(2), MAX_PLAN_TITLE_CHARS); continue; }
      const owner = THREAD.exec(line.trim());
      if (owner) { threadId = clean(owner[1], 128); continue; }
      if (title) goal.push(line);
      continue;
    }
    if (steps.length > MAX_PLAN_STEPS) continue;
    const needs = NEEDS.exec(line.trim());
    if (needs) {
      step.needs = needs[1].split(/[,\s]+/).map((item) => item.trim()).filter((item) => ID.test(item) && !NOTHING.includes(item));
      continue;
    }
    const task = TASK.exec(line.trim());
    if (task) {
      if (step.tasks.length < MAX_STEP_TASKS && task[2].trim()) step.tasks.push({ text: clean(task[2], 500), done: task[1] !== " " });
      continue;
    }
    const result = RESULT.exec(line.trim());
    if (result) { step.result = clean(result[1], 2000) || undefined; continue; }
    brief.push(line);
  }
  flush();
  // A `needs` pointing at a step that is not in the file is not a dependency, and
  // leaving it in would park that step in a wave that can never come.
  const known = new Set(steps.map((step) => step.id));
  for (const step of steps) step.needs = [...new Set(step.needs.filter((need) => known.has(need) && need !== step.id))];
  return { id, title: title || id, goal: goal.join("\n").trim(), steps: steps.slice(0, MAX_PLAN_STEPS), updatedAt, ...(threadId ? { threadId } : {}) };
}

/** The plan as it is written back. `parsePlan(renderPlan(plan))` is the plan again. */
export function renderPlan(plan: Plan): string {
  const out = [`# ${plan.title}`, ""];
  if (plan.threadId) out.push(`thread: ${plan.threadId}`, "");
  if (plan.goal.trim()) out.push(plan.goal.trim(), "");
  for (const step of plan.steps) {
    out.push(`## ${step.id} · ${step.title} \`${step.status}\``);
    out.push(`needs: ${step.needs.length ? step.needs.join(", ") : "—"}`, "");
    if (step.brief.trim()) out.push(step.brief.trim(), "");
    for (const task of step.tasks) out.push(`- [${task.done ? "x" : " "}] ${task.text}`);
    if (step.tasks.length) out.push("");
    if (step.result) out.push(`**Result:** ${step.result}`, "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/* ---------- The graph, and the wave it is up to ---------- */

export type PlanEdge = { from: string; to: string };

export const planEdges = (steps: PlanStep[]): PlanEdge[] =>
  steps.flatMap((step) => step.needs.map((need) => ({ from: need, to: step.id })));

/**
 * Rows of step ids, top to bottom: a step sits one row below the last thing it
 * waits on, so a row is exactly one wave and everything in it runs at once.
 *
 * Repeated relaxation rather than a topological sort, because a hand-edited file
 * can name a cycle: whatever is still unplaced when the passes run out lands in a
 * row of its own instead of vanishing, and `planProblems` is what says why.
 */
export function planRows(steps: PlanStep[]): string[][] {
  const level = new Map<string, number>();
  for (let pass = 0; pass < steps.length; pass += 1) {
    let moved = false;
    for (const step of steps) {
      if (step.needs.some((need) => !level.has(need))) continue;
      const row = step.needs.length ? Math.max(...step.needs.map((need) => level.get(need) ?? 0)) + 1 : 0;
      if (level.get(step.id) !== row) { level.set(step.id, row); moved = true; }
    }
    if (!moved) break;
  }
  const stranded = steps.filter((step) => !level.has(step.id));
  const depth = Math.max(-1, ...level.values());
  for (const step of stranded) level.set(step.id, depth + 1);
  const rows: string[][] = [];
  for (const step of steps) (rows[level.get(step.id) ?? 0] ??= []).push(step.id);
  return rows.map((row) => row ?? []);
}

export const PLAN_ROW = 30; // px between drawn rows
export const PLAN_PAD = 15; // px above the first row and below the last
const LANE = 6; // nodes on one line before a wide wave folds onto a second

export type PlanSpot = { x: number; y: number; wave: number };

const PULL = 0.4;

export function planLayout(waves: string[][], steps: PlanStep[] = []): { spots: Map<string, PlanSpot>; height: number } {
  const spots = new Map<string, PlanSpot>();
  const needsOf = new Map(steps.map((step) => [step.id, step.needs]));
  const branch = (id: string) => steps.filter((step) => step.needs.length === 1 && step.needs[0] === id).map((step) => step.id);
  const middle = (ids: string[]) => {
    const xs = ids.map((id) => spots.get(id)?.x).filter((x): x is number => x !== undefined);
    return xs.length ? xs.reduce((total, x) => total + x, 0) / xs.length : undefined;
  };
  const lines: string[][] = [];
  let y = PLAN_PAD;
  waves.forEach((wave, index) => {
    const under = wave
      .map((id, at) => ({ id, at, x: middle(needsOf.get(id) ?? []) ?? 50 }))
      .sort((left, right) => left.x - right.x || left.at - right.at);
    for (let at = 0; at < under.length; at += LANE) {
      const line = under.slice(at, at + LANE).map((item) => item.id);
      line.forEach((id, i) => spots.set(id, { x: ((i + 1) / (line.length + 1)) * 100, y, wave: index }));
      lines.push(line);
      y += PLAN_ROW;
    }
  });
  for (const line of lines.reverse()) {
    const slot = 100 / (line.length + 1);
    line.forEach((id, i) => {
      const mid = middle(branch(id));
      if (mid === undefined) return;
      spots.set(id, { ...spots.get(id)!, x: Math.min(Math.max(mid, (i + 1 - PULL) * slot), (i + 1 + PULL) * slot) });
    });
  }
  return { spots, height: spots.size ? y - PLAN_ROW + PLAN_PAD : 0 };
}

/** Written for whoever is fixing them: the model reads them back as a tool result. */
export function planProblems(plan: Plan): string[] {
  const problems: string[] = [];
  if (!plan.steps.length) problems.push("This plan has no steps.");
  const rows = planRows(plan.steps);
  const placed = new Set(rows.flat());
  for (const step of plan.steps) {
    if (!step.brief.trim() && !step.tasks.length) problems.push(`Step "${step.id}" says nothing for its subagent to do.`);
    if (step.needs.some((need) => !placed.has(need)) || step.needs.includes(step.id)) problems.push(`Step "${step.id}" waits on itself.`);
  }
  // A cycle is the one shape a wave can never reach, so it is named rather than
  // left as steps that quietly never run.
  const cycle = plan.steps.filter((step) => step.needs.some((need) => waitsOn(plan.steps, need, step.id)));
  if (cycle.length) problems.push(`These steps wait on each other and can never start: ${cycle.map((step) => step.id).join(", ")}.`);
  if (plan.steps.length && rows.every((row) => row.length < 2)) problems.push("Nothing here runs at once — every step waits on the one before it. A subagent starts from its brief and one line per step it waited on, never from your context, so a chain of them is worth less than doing the work in this turn or handing the whole job to one subagent.");
  return problems;
}

function waitsOn(steps: PlanStep[], from: string, target: string, seen = new Set<string>()): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (steps.find((step) => step.id === from)?.needs ?? []).some((need) => waitsOn(steps, need, target, seen));
}

/** The next wave: every step nothing is still holding up. Empty means finished or stuck. */
export const readySteps = (plan: Plan): PlanStep[] =>
  plan.steps.filter((step) => step.status === "todo" && step.needs.every((need) => plan.steps.find((item) => item.id === need)?.status === "done"));

export function planProgress(plan: Plan): { done: number; steps: number; tasks: number; doneTasks: number } {
  const tasks = plan.steps.flatMap((step) => step.tasks);
  return {
    done: plan.steps.filter((step) => step.status === "done").length,
    steps: plan.steps.length,
    tasks: tasks.length,
    doneTasks: tasks.filter((task) => task.done).length,
  };
}

/**
 * A rewritten plan, keeping what the old one had already lived through: a step
 * that kept its id keeps its status and result, and a task that kept its text
 * keeps its tick.
 *
 * Without this, restructuring a plan halfway — which is the whole point of letting
 * the agent rewrite the graph — would silently untick every box and re-run every
 * finished step.
 */
export function mergePlan(previous: Plan | undefined, next: Plan): Plan {
  if (!previous) return next;
  return {
    ...next,
    // The thread that wrote it keeps it: a subagent rewriting its own plan would
    // otherwise move it into a sub thread the user is not looking at.
    threadId: previous.threadId ?? next.threadId,
    steps: next.steps.map((step) => {
      const before = previous.steps.find((item) => item.id === step.id);
      if (!before) return step;
      const ticked = new Set(before.tasks.filter((task) => task.done).map((task) => task.text));
      return {
        ...step,
        status: step.status === "todo" ? before.status : step.status,
        result: step.result ?? before.result,
        tasks: step.tasks.map((task) => ({ ...task, done: task.done || ticked.has(task.text) })),
      };
    }),
  };
}

/* ---------- What the tool is given ---------- */

/**
 * The steps a `plan write` call carries, as JSON. Errors read like `parseWorkflow`'s
 * and for the same reason: they go back as a tool result and are the model's next read.
 */
export function parsePlanSteps(json: string): { steps: PlanStep[]; errors: string[] } {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return { steps: [], errors: ["steps is not valid JSON. Send a JSON array of steps, as a string."] }; }
  if (!Array.isArray(value)) return { steps: [], errors: ["steps must be a JSON array."] };
  if (!value.length) return { steps: [], errors: ["A plan needs at least one step."] };
  if (value.length > MAX_PLAN_STEPS) return { steps: [], errors: [`A plan cannot have more than ${MAX_PLAN_STEPS} steps. Split it, or make the steps larger.`] };
  const errors: string[] = [];
  const steps: PlanStep[] = [];
  for (const [index, raw] of value.entries()) {
    const at = `Step ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push(`${at} is not an object.`); continue; }
    const step = raw as Record<string, unknown>;
    const id = typeof step.id === "string" ? step.id : "";
    if (!ID.test(id)) { errors.push(`${at} needs an id of lowercase letters, digits and dashes.`); continue; }
    if (steps.some((item) => item.id === id)) { errors.push(`${at} repeats the id "${id}".`); continue; }
    const title = typeof step.title === "string" ? clean(step.title, MAX_PLAN_TITLE_CHARS) : "";
    const brief = typeof step.brief === "string" ? step.brief.trim() : "";
    const tasks = Array.isArray(step.tasks) ? step.tasks : [];
    if (!title) errors.push(`Step "${id}" needs a title: three or four words for its subagent's row.`);
    if (!brief && !tasks.length) errors.push(`Step "${id}" needs a brief or tasks — its subagent cannot see this conversation.`);
    if (tasks.length > MAX_STEP_TASKS) errors.push(`Step "${id}" has more than ${MAX_STEP_TASKS} tasks.`);
    const needs = (Array.isArray(step.needs) ? step.needs : []).filter((need): need is string => typeof need === "string" && ID.test(need));
    steps.push({
      id,
      title: title || id,
      status: isPlanStatus(step.status) ? step.status : "todo",
      needs: [...new Set(needs)],
      brief,
      tasks: tasks.slice(0, MAX_STEP_TASKS).map((task) => typeof task === "string"
        ? { text: clean(task, 500), done: false }
        : { text: clean(String((task as Record<string, unknown>)?.text ?? ""), 500), done: (task as Record<string, unknown>)?.done === true })
        .filter((task) => task.text),
      ...(typeof step.result === "string" && step.result.trim() ? { result: clean(step.result, 2000) } : {}),
    });
  }
  for (const step of steps) {
    for (const need of step.needs) {
      if (need === step.id) errors.push(`Step "${step.id}" waits on itself.`);
      else if (!steps.some((item) => item.id === need)) errors.push(`Step "${step.id}" waits on "${need}", which is not a step in this plan.`);
    }
  }
  return { steps, errors };
}

/**
 * What one step's subagent is told. It gets the plan around it so its part lands in
 * the right place, and nothing else: it has its own transcript and cannot see the
 * conversation that planned it.
 */
export function stepBrief(plan: Plan, step: PlanStep): string {
  const done = plan.steps.filter((item) => item.status === "done" && item.result);
  const failed = plan.steps.filter((item) => item.status === "failed" && item.result);
  return [
    `You are one step of Emma's plan "${plan.title}". Other subagents are working on the other steps of this same wave right now.`,
    plan.goal.trim() ? `\nThe plan as a whole:\n${plan.goal.trim()}` : "",
    `\nYour step is ${step.id} — ${step.title}.\n`,
    step.brief.trim(),
    step.tasks.length ? `\nWhat it covers:\n${step.tasks.map((task) => `- ${task.text}`).join("\n")}` : "",
    done.length ? `\nWhat earlier steps already found:\n${done.map((item) => `- ${item.id}: ${item.result}`).join("\n")}` : "",
    failed.length ? `\nWhat has already gone wrong, so you do not walk into it again:\n${failed.map((item) => `- ${item.id}: ${item.result}`).join("\n")}` : "",
    `\nTick your tasks off as you finish them with plan {"action":"update","id":"${plan.id}","step":"${step.id}","check":<the task's number>}. Do not touch any other step — they belong to the other subagents.`,
    "Answer with one line saying what you did and anything the next step has to know. That line is written back into the plan.",
  ].filter(Boolean).join("\n");
}
