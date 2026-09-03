import { MAX_NEXT_STEPS, MIN_NEXT_STEPS, type NextStep, type WorkState } from "../shared/next-steps";
import { plural } from "./plural";

const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

const GENERIC: NextStep[] = [
  { title: "Take stock of the repository", detail: "Where the code stands before anything changes", prompt: "Read this project and tell me what it does, how it is laid out, and where the rough edges are." },
  { title: "Find the untested paths", detail: "The checks that would catch a regression", prompt: "Find the parts of this project with no test covering them, and tell me which are worth writing first." },
  { title: "Bring the documentation level", detail: "Docs drift faster than anything else", prompt: "Check this project's docs against what the code actually does now, and list what is out of date." },
  { title: "Hunt the loose ends", detail: "Dead code, stale flags, half-finished work", prompt: "Look for dead code, unused config and half-finished work in this project, and rank what is safe to delete." },
];

export function defaultSteps(state: WorkState): NextStep[] {
  const steps: NextStep[] = [];
  const where = state.project || "this project";

  if (state.files.length) {
    steps.push({
      title: `Commit ${state.files.length} changed ${plural(state.files.length, "file")}`,
      detail: state.branch ? `Nothing on ${state.branch} is committed yet` : "The working tree has uncommitted work",
      prompt: "Go through everything uncommitted here, group it into coherent commits, and write the messages.",
    });
  }
  if (state.largest) {
    steps.push({
      title: `Review ${baseName(state.largest.path)}`,
      detail: `+${state.largest.added} −${state.largest.removed}, the largest change here`,
      prompt: `Walk me through the changes in ${state.largest.path}, and tell me what looks wrong or unfinished.`,
    });
  }
  if (state.behind) {
    steps.push({
      title: `Catch up on ${state.behind} upstream ${plural(state.behind, "commit")}`,
      detail: `${state.branch || "This branch"} is behind its upstream`,
      prompt: "Pull the upstream commits, then tell me what changed and whether anything here conflicts with it.",
    });
  }
  if (state.ahead) {
    steps.push({
      title: `Open a pull request for ${state.ahead} ${plural(state.ahead, "commit")}`,
      detail: `${state.branch || "This branch"} is ahead of its upstream`,
      prompt: "Summarise the commits on this branch, then draft the pull request title and description for them.",
    });
  }
  if (state.threads.length) {
    steps.push({
      title: "Pick up where we left off",
      detail: `Last here: ${state.threads[0]}`,
      prompt: `Recap where we got to on “${state.threads[0]}” in ${where}, and what is still left to do.`,
    });
  }
  for (const step of GENERIC) {
    if (steps.length >= MIN_NEXT_STEPS) break;
    steps.push(step);
  }
  return steps.slice(0, MAX_NEXT_STEPS);
}
