export type CliHarness = {
  id: string;
  label: string;
  bin: string;
  start: (prompt: string, session: string, model?: string) => string[];
  resume: (prompt: string, session: string, model?: string) => string[];
  ownsSession: boolean;
  unattended: string[];
};

const pick = (model: string | undefined) => (model ? ["--model", model] : []);

export const CLI_HARNESSES: readonly CliHarness[] = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    start: (prompt, session, model) => ["--print", "--session-id", session, ...pick(model), prompt],
    resume: (prompt, session, model) => ["--print", "--resume", session, ...pick(model), prompt],
    ownsSession: true,
    unattended: ["--dangerously-skip-permissions"],
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    start: (prompt, _session, model) => ["exec", "--color", "never", ...pick(model), prompt],
    resume: (prompt, _session, model) => ["exec", "resume", "--last", "--color", "never", ...pick(model), prompt],
    ownsSession: false,
    unattended: ["--dangerously-bypass-approvals-and-sandbox"],
  },
  {
    id: "pi",
    label: "Pi",
    bin: "pi",
    start: (prompt, session, model) => ["--print", "--session-id", session, ...pick(model), prompt],
    resume: (prompt, session, model) => ["--print", "--session-id", session, ...pick(model), prompt],
    ownsSession: true,
    unattended: [],
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    start: (prompt, _session, model) => ["run", ...pick(model), prompt],
    resume: (prompt, _session, model) => ["run", "--continue", ...pick(model), prompt],
    ownsSession: false,
    unattended: ["--auto"],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    start: (prompt, _session, model) => [...pick(model), "--prompt", prompt],
    resume: (prompt, _session, model) => ["--resume", "latest", ...pick(model), "--prompt", prompt],
    ownsSession: false,
    unattended: ["--approval-mode=yolo"],
  },
  {
    id: "cursor",
    label: "Cursor CLI",
    bin: "cursor-agent",
    start: (prompt, _session, model) => ["--print", ...pick(model), prompt],
    resume: (prompt, _session, model) => ["--print", "--resume", ...pick(model), prompt],
    ownsSession: false,
    unattended: ["--force"],
  },
];

export function cliHarness(id: string): CliHarness | undefined {
  return CLI_HARNESSES.find((harness) => harness.id === id);
}

export const CLI_IDS = CLI_HARNESSES.map((harness) => harness.id);

export const MAX_CLI_MODELS = 400;
export const CLI_MODELS_STALE_MS = 60 * 60 * 1000;

export type CliModels = { cli: string; models: string[]; at: number };

export type CliRun = {
  id: string;
  cli: string;
  threadId: string;
  title: string;
  cwd: string;
  folder: string;
  status: "running" | "idle" | "failed";
  exitCode: number | null;
  turns: number;
  startedAt: number;
  turnStartedAt: number;
  endedAt?: number;
  unattended: boolean;
  model?: string;
};

// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;

export function terminalText(raw: string): string {
  return raw
    .replace(ANSI, "")
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      let out = "";
      for (const part of line.split("\r")) out = part + out.slice(part.length);
      return out;
    })
    .join("\n");
}

export function describeRuns(runs: CliRun[]): string {
  if (!runs.length) return "No CLI runs have been started in this session.";
  return runs
    .map((run) => `${run.id}  ${run.cli}${run.model ? ` (${run.model})` : ""}  ${run.status}${run.status === "idle" && run.exitCode ? ` (exit ${run.exitCode})` : ""}  ${run.turns} ${run.turns === 1 ? "turn" : "turns"}  ${run.folder}  ${run.title}`)
    .join("\n");
}
