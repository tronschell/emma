export interface NextStep {
  title: string;
  detail: string;
  prompt: string;
}

export interface WorkFile {
  path: string;
  state: string;
}

export interface WorkState {
  project: string;
  branch: string;
  ahead: number;
  behind: number;
  files: WorkFile[];
  largest: { path: string; added: number; removed: number } | null;
  threads: string[];
}

export const MIN_NEXT_STEPS = 3;
export const MAX_NEXT_STEPS = 5;
export const MAX_STEP_TITLE = 52;
export const MAX_STEP_DETAIL = 96;
export const MAX_STEP_PROMPT = 400;
export const MAX_STATE_FILES = 40;
export const MAX_STATE_THREADS = 12;
export const MAX_STATE_TEXT = 200;

export const emptyWorkState: WorkState = { project: "", branch: "", ahead: 0, behind: 0, files: [], largest: null, threads: [] };

function line(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 100_000) : 0;
}

export function validateSteps(value: unknown): NextStep[] {
  if (!Array.isArray(value)) return [];
  const steps: NextStep[] = [];
  for (const entry of value.slice(0, MAX_NEXT_STEPS)) {
    const step = entry as Partial<NextStep> | null;
    const title = line(step?.title, MAX_STEP_TITLE);
    const prompt = line(step?.prompt, MAX_STEP_PROMPT);
    if (!title || !prompt) continue;
    if (steps.some((kept) => kept.title.toLowerCase() === title.toLowerCase())) continue;
    steps.push({ title, detail: line(step?.detail, MAX_STEP_DETAIL), prompt });
  }
  return steps.length >= MIN_NEXT_STEPS ? steps : [];
}

export function validateWorkState(value: unknown): WorkState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Work state is invalid");
  const state = value as Partial<WorkState>;
  const files = Array.isArray(state.files) ? state.files : [];
  const threads = Array.isArray(state.threads) ? state.threads : [];
  const largest = state.largest && typeof state.largest === "object" ? state.largest : null;
  const largestPath = line(largest?.path, MAX_STATE_TEXT);
  return {
    project: line(state.project, MAX_STATE_TEXT),
    branch: line(state.branch, MAX_STATE_TEXT),
    ahead: count(state.ahead),
    behind: count(state.behind),
    files: files.slice(0, MAX_STATE_FILES)
      .map((file) => ({ path: line((file as Partial<WorkFile> | null)?.path, MAX_STATE_TEXT), state: line((file as Partial<WorkFile> | null)?.state, 32) }))
      .filter((file) => file.path),
    largest: largestPath ? { path: largestPath, added: count(largest?.added), removed: count(largest?.removed) } : null,
    threads: threads.map((title) => line(title, MAX_STATE_TEXT)).filter(Boolean).slice(0, MAX_STATE_THREADS),
  };
}
