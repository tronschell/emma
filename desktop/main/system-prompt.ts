import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { platform, release } from "node:os";
import path from "node:path";
import { mergeSkillContext } from "../shared/folders";
import { familiesOf, familyLabel, normalizeModel, scopeApplies, resolvePrompt, type PromptPreset, type PromptVariables } from "../shared/prompts";
import { MAX_SYSTEM_PROMPT_CHARS, systemPromptBlock } from "../shared/settings";
import { toolDefinitions } from "./tools";
import type { PermissionMode } from "../shared/permissions";
import { applied, knobOf, lessonBlock, preselectOf, toolHintsOf, type Improvements, type Arm } from "../shared/improvement";
import type { TurnRequest } from "./agent-loop";
import { GOAL_BLOCKED_TURNS, GOAL_LABELS, MAX_GOAL_TURNS, goalTokensLeft, type Goal } from "../shared/goal";

let prompt = "";
let presets: PromptPreset[] = [];
let improvements: Improvements = { items: [] };

export function setSystemPrompt(value: string) {
  prompt = value.slice(0, MAX_SYSTEM_PROMPT_CHARS);
}

export function setPrompts(value: readonly PromptPreset[]) {
  presets = [...value];
}

export interface PromptContext {
  model?: string;
  addition?: string;
  workspace?: string;
  mode?: PermissionMode;
  disabledTools?: readonly string[];
}

function promptVariables(context: PromptContext): PromptVariables {
  const model = normalizeModel(context.model ?? "");
  const mode = context.mode ?? "ask";
  const families = familiesOf(model).map(familyLabel);
  return {
    available_tools: toolDefinitions(mode, { folders: true, computer: true }, context.disabledTools ?? []).map((tool) => tool.name).join(", "),
    model: model || "the agent's own default model",
    model_family: families.join(" and ") || "unknown",
    workspace: context.workspace || "no folder",
    os: `${platform()} ${release()}`,
    date: new Date().toISOString().slice(0, 10),
    mode,
  };
}

export const resolveHarnessPrompt = (context: PromptContext) =>
  systemPromptBlock([resolvePrompt(prompt, presets, context.model ?? "", promptVariables(context)), context.addition].filter(Boolean).join("\n\n"));

const arms = new Map<string, Arm>();
const forced = new Map<string, { arm: Arm; at: number }>();
const MAX_ARMS = 64;
const PIN_MS = 2 * 60_000;

export function setImprovements(value: Improvements) {
  improvements = value;
  forced.clear();
}

export function forceArm(threadId: string, arm: Arm) {
  if (forced.size >= MAX_ARMS) forced.delete(forced.keys().next().value!);
  forced.set(threadId, { arm, at: Date.now() });
}

export function turnArm(threadId: string, parentThreadId?: string, model = ""): Arm | "" {
  const pin = forced.get(threadId);
  forced.delete(threadId);
  const pinned = pin && Date.now() - pin.at < PIN_MS ? pin.arm : undefined;
  if (!pinned && !improvements.items.some((item) => item.state === "trial" && scopeApplies(item.scope ?? "", model))) {
    arms.delete(threadId);
    return "";
  }
  const arm: Arm = pinned ?? (parentThreadId && arms.has(parentThreadId) ? arms.get(parentThreadId)! : Math.random() < 0.5 ? "a" : "b");
  if (arms.size >= MAX_ARMS) {
    for (const key of arms.keys()) if (key !== threadId && key !== parentThreadId) { arms.delete(key); break; }
  }
  arms.set(threadId, arm);
  return arm;
}

export function takeArm(threadId: string): Arm | "" {
  const arm = arms.get(threadId) ?? "";
  arms.delete(threadId);
  return arm;
}

export function withTrialArm(turn: TurnRequest, model = turn.model ?? ""): TurnRequest {
  const arm = turnArm(turn.threadId, turn.parentThreadId, model);
  const resolved = applied(improvements, model);
  const trials = arm === "b" ? resolved.trial ?? [] : [];
  const bodies = resolved.kept.prompts.map((preset) => preset.body);
  const toolHints = { ...resolved.kept.toolHints };
  const preselect = [...resolved.kept.preselect];
  const knobs = { ...resolved.kept.knobs };
  const lessons: string[] = [];
  for (const trial of trials) {
    if (trial.lever === "prompt") bodies.push(trial.addition);
    if (trial.lever === "instructions") lessons.push(trial.addition);
    if (trial.lever === "tools") Object.assign(toolHints, toolHintsOf(trial.addition));
    if (trial.lever === "advertise") preselect.push(...preselectOf(trial.addition));
    if (trial.lever === "knobs") Object.assign(knobs, knobOf(trial.addition));
  }
  const block = [resolved.kept.instructions, lessonBlock(lessons), ...bodies].filter(Boolean).join("\n\n");
  return {
    ...turn,
    traceContext: {
      ...turn.traceContext,
      arm,
      trials: improvements.items.filter((item) => item.state === "trial" && scopeApplies(item.scope ?? "", model)).map((item) => item.id).join(","),
      changes: JSON.stringify({ kept: resolved.kept, trial: trials }),
    },
    ...(block ? { promptAddition: block } : {}),
    ...(Object.keys(toolHints).length ? { toolHints } : {}),
    ...(preselect.length ? { preselect: [...new Set(preselect)] } : {}),
    ...(Object.keys(knobs).length ? { knobs } : {}),
  };
}

const tokens = (value: number) => value.toLocaleString("en-US");

export function goalBlock(goal: Goal): string {
  return [
    "GOAL:",
    `This thread is pursuing one objective, and this is it: ${goal.objective}`,
    `Status: ${GOAL_LABELS[goal.status]}. Turn ${tokens(goal.turns)} of at most ${tokens(MAX_GOAL_TURNS)}.`,
    `Tokens: ${tokens(goal.tokensUsed)} of ${tokens(goal.tokenBudget)} spent, ${tokens(goalTokensLeft(goal))} left.`,
    `Time spent pursuing this goal: ${tokens(goal.timeUsedSeconds)} seconds.`,
    goal.evidence ? `Evidence recorded so far: ${goal.evidence}` : "",
    goal.blockedReason ? `Blocker on record: ${goal.blockedReason} — reported on ${tokens(goal.blockedStreak)} of the ${tokens(GOAL_BLOCKED_TURNS)} consecutive goal turns it takes to call the goal blocked.` : "",
    "",
    "The goal persists across turns, so the end of this turn is not the end of it: when you stop, Emma starts another turn at the same objective on its own. Work accordingly.",
    "Keep the whole objective intact. If it cannot be finished now, make concrete progress toward the end state that was actually asked for and leave the goal active — never redefine success as the smaller, easier thing that happens to fit this turn.",
    "Treat completion as unproven until you have checked it against the current state of the thing itself. Intent, partial progress, memory of earlier work and a plausible-looking answer are none of them proof. Marking the goal complete claims the full objective is finished and would survive being read back requirement by requirement, so send it only with evidence of the real end state: what you ran, what it printed, what changed. If the evidence is indirect, partial, merely consistent with being done, or leaves one requirement unverified, keep working instead.",
    "Never call it complete because the budget is nearly gone or because you are stopping. A budget that runs out is budgetLimited, and asking the user to extend it is the honest move.",
    `Report status blocked only when the same blocking condition has stopped you on ${tokens(GOAL_BLOCKED_TURNS)} consecutive goal turns, counting the turn the user asked for and every continuation since. The first two times, record the blocker and carry on working around it. Once it has repeated ${tokens(GOAL_BLOCKED_TURNS)} times, do report it rather than staying active while saying you are stuck. A goal picked back up after being blocked starts its count fresh.`,
    "When what is left is more than one subagent's worth of work, write a plan with the plan tool and fan it out. That is how a goal makes progress in parallel instead of one small step per turn.",
    "Any thread or subagent you start toward this goal has to be told the objective in its brief. It cannot see this.",
    "When the goal is done, tell the user what it cost: the turns it took and the tokens against the budget.",
  ].filter(Boolean).join("\n");
}

export function withGoal(turn: TurnRequest, goal: Goal | undefined): TurnRequest {
  if (!goal) return turn;
  return { ...turn, params: { ...turn.params, skillContext: mergeSkillContext(goalBlock(goal), turn.params?.skillContext ?? "") } };
}

export const harnessPromptFile = (home: string, key: string) =>
  path.join(home, ".fx", `system-prompt-${createHash("sha256").update(key).digest("hex").slice(0, 16)}.md`);

export function writeHarnessPrompt(home: string, context: PromptContext = {}, file = path.join(home, ".fx", "system-prompt.md")) {
  const resolved = resolveHarnessPrompt(context);
  const directory = path.join(home, ".fx");
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, resolved ? `${resolved}\n` : "");
  writeFileSync(path.join(directory, "AGENTS.md"), "");
  return resolved;
}
