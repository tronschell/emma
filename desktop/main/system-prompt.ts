/* The user's standing instructions, from Settings, added to every turn.
   The harness already has a channel for extra instructions, so this grew no new
   parameter: it reads them from the global `AGENTS.md` under the profile HOME
   Emma hands it. The one thing that cannot go in that file is the arm a turn
   landed on, which changes per turn — that rides the turn's skill context. */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mergeSkillContext } from "../shared/folders";
import { MAX_SYSTEM_PROMPT_CHARS, systemPromptBlock } from "../shared/settings";
import { lessonBlock, type AppliedImprovements, type Arm } from "../shared/improvement";
import { connectionsBlock } from "./connections";
import type { TurnRequest } from "./agent-loop";

let prompt = "";
let connections = "";
let written: string | undefined;
let improvements: AppliedImprovements = { kept: { instructions: "", verifier: "" } };

/** Remembers what Settings last saved. Bounded here too: this is renderer text. */
export function setSystemPrompt(value: string) {
  prompt = value.slice(0, MAX_SYSTEM_PROMPT_CHARS);
}

/**
 * The connections Settings last saved. Probing for the binaries takes a shell, so
 * it runs in the background and the next turn picks the result up; the ids come
 * in at launch, well before any turn.
 */
export function setConnections(ids: readonly string[]) {
  void connectionsBlock(ids).then((block) => { connections = block; }).catch(() => { connections = ""; });
}

/** Everything Emma adds to a turn's system context from Settings, in one block. */
const settingsBlock = () => [systemPromptBlock(prompt), connections, improvements.kept.instructions].filter(Boolean).join("\n\n");

export const systemPrompt = () => prompt;

/* ---------------------------------------------------------------------------
   The Agent page's changes.

   A kept one rides every turn. The one on trial rides half of them: the arm is
   a coin flip per turn, and the trace the turn leaves records which way it
   landed, so the two halves can be compared afterwards. Switching a change on
   and reading the week after would credit it with everything else that changed
   that week — a different model, easier work — and this does not. */

const arms = new Map<string, Arm>();
/* ponytail: the root of a turn is cleared at `takeArm`; a subagent's entry is
   not, because nothing here knows when its parent's tree is finished. One entry
   per spawn, so the cap is what bounds it rather than a lifecycle. */
const MAX_ARMS = 64;

export function setImprovements(value: AppliedImprovements) {
  improvements = value;
}

/**
 * The arm this turn runs on, decided once, at its start.
 *
 * A subagent takes its parent's arm rather than flipping again: the whole turn —
 * the run and everything it delegates — is one sample, and its spans all land in
 * the one trace the parent writes.
 */
export function turnArm(threadId: string, parentThreadId?: string): Arm | "" {
  if (!improvements.trial) return "";
  const arm: Arm = parentThreadId && arms.has(parentThreadId) ? arms.get(parentThreadId)! : Math.random() < 0.5 ? "a" : "b";
  if (arms.size >= MAX_ARMS) arms.delete(arms.keys().next().value!);
  arms.set(threadId, arm);
  return arm;
}

/** The arm a run is on, for the second model that reviews its calls mid-turn. */
export const armOf = (threadId: string): Arm | "" => arms.get(threadId) ?? "";

/**
 * The arm a finished turn ran on, and the end of it.
 *
 * Read once, on the way into the trace, and cleared: a later turn on the same
 * thread that never asked for an arm — a harness run, which takes its
 * instructions from a file rather than from here — must not inherit this one's.
 */
export function takeArm(threadId: string): Arm | "" {
  const arm = arms.get(threadId) ?? "";
  arms.delete(threadId);
  return arm;
}

/** The standing rules the auto verifier judges by, with whatever this turn's arm adds. */
export function verifierLessons(threadId: string): string {
  const trial = improvements.trial?.lever === "verifier" && armOf(threadId) === "b" ? [improvements.trial.addition] : [];
  return [improvements.kept.verifier, lessonBlock(trial)].filter(Boolean).join("\n\n");
}

/**
 * Where a turn's arm is decided — once, before the prompt goes out — and where
 * the change on trial rides the half of turns that landed on it.
 *
 * Only the trial addition: the standing instructions reach the harness through
 * `AGENTS.md` below, and repeating them here would say everything twice. The
 * arm has to come per turn instead, because it is a coin flip per turn.
 */
export function withTrialArm(turn: TurnRequest): TurnRequest {
  const arm = turnArm(turn.threadId, turn.parentThreadId);
  if (improvements.trial?.lever !== "instructions" || arm !== "b") return turn;
  const trial = lessonBlock([improvements.trial.addition]);
  return { ...turn, params: { ...turn.params, skillContext: mergeSkillContext(trial, turn.params?.skillContext ?? "") } };
}

/**
 * The harness path: its own global instructions file, under the HOME Emma gives
 * the child. `harness/src/builtins/context.zig` loads `$HOME/.fx/AGENTS.md` into
 * the stable prefix beside its built-in system prompt.
 *
 * ponytail: written per turn but only when it changed, and a harness session
 * that already gathered its context keeps the old text until the next session.
 * Send it over ACP instead if a mid-session change ever has to take effect.
 */
export function writeHarnessPrompt(home: string) {
  const block = settingsBlock();
  if (written === block) return;
  const file = path.join(home, ".fx", "AGENTS.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, block ? `${block}\n` : "");
  written = block;
}
