export type CliHarness = {
  id: string;
  label: string;
  bin: string;
  start: (prompt: string, session: string, model?: string, effort?: string) => string[];
  resume: (prompt: string, session: string, model?: string, effort?: string) => string[];
  efforts: readonly string[];
  effortLabel?: string;
  ownsSession: boolean;
  unattended: string[];
};

const pick = (model: string | undefined) => (model ? ["--model", model] : []);
const think = (flag: string, effort: string | undefined) => effort ? [flag, effort] : [];
const codexEffort = (effort: string | undefined) => effort ? ["--config", `model_reasoning_effort=${JSON.stringify(effort)}`] : [];

export const CLI_HARNESSES: readonly CliHarness[] = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    start: (prompt, session, model, effort) => ["--print", "--session-id", session, ...pick(model), ...think("--effort", effort), prompt],
    resume: (prompt, session, model, effort) => ["--print", "--resume", session, ...pick(model), ...think("--effort", effort), prompt],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    ownsSession: true,
    unattended: ["--dangerously-skip-permissions"],
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    start: (prompt, _session, model, effort) => ["exec", "--color", "never", ...pick(model), ...codexEffort(effort), prompt],
    resume: (prompt, _session, model, effort) => ["exec", "--color", "never", "resume", "--last", ...pick(model), ...codexEffort(effort), prompt],
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    ownsSession: false,
    unattended: ["--dangerously-bypass-approvals-and-sandbox"],
  },
  {
    id: "pi",
    label: "Pi",
    bin: "pi",
    start: (prompt, session, model, effort) => ["--print", "--session-id", session, ...pick(model), ...think("--thinking", effort), prompt],
    resume: (prompt, session, model, effort) => ["--print", "--session-id", session, ...pick(model), ...think("--thinking", effort), prompt],
    efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    ownsSession: true,
    unattended: [],
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    start: (prompt, _session, model, effort) => ["run", ...pick(model), ...think("--variant", effort), prompt],
    resume: (prompt, _session, model, effort) => ["run", "--continue", ...pick(model), ...think("--variant", effort), prompt],
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    effortLabel: "Variant",
    ownsSession: false,
    unattended: ["--auto"],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    start: (prompt, _session, model) => [...pick(model), "--prompt", prompt],
    resume: (prompt, _session, model) => ["--resume", "latest", ...pick(model), "--prompt", prompt],
    efforts: [],
    ownsSession: false,
    unattended: ["--approval-mode=yolo"],
  },
  {
    id: "cursor",
    label: "Cursor CLI",
    bin: "cursor-agent",
    start: (prompt, _session, model) => ["--print", ...pick(model), prompt],
    resume: (prompt, _session, model) => ["--print", "--resume", ...pick(model), prompt],
    efforts: [],
    ownsSession: false,
    unattended: ["--force"],
  },
  {
    id: "antigravity",
    label: "Antigravity CLI",
    bin: "agy",
    start: (prompt, _session, model, effort) => [...pick(model), ...think("--effort", effort), "--print", prompt],
    resume: (prompt, _session, model, effort) => ["--continue", ...pick(model), ...think("--effort", effort), "--print", prompt],
    efforts: ["low", "medium", "high"],
    ownsSession: false,
    unattended: ["--dangerously-skip-permissions"],
  },
];

export function cliHarness(id: string): CliHarness | undefined {
  return CLI_HARNESSES.find((harness) => harness.id === id);
}

export const CLI_IDS = CLI_HARNESSES.map((harness) => harness.id);

export const MAX_CLI_MODELS = 400;
export const CLI_MODELS_STALE_MS = 60 * 60 * 1000;

export type CliModels = { cli: string; models: string[]; at: number; effortByModel?: Record<string, string[]> };

export type CliOptions = { model?: string; effort?: string };

export function cliOptions(value: unknown): CliOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid harness options.");
  const request = value as Record<string, unknown>;
  const result: CliOptions = {};
  for (const key of ["model", "effort"] as const) {
    const item = request[key];
    if (item === undefined) continue;
    if (typeof item !== "string" || item.length > (key === "model" ? 256 : 64) || (item !== "" && !/^[a-zA-Z0-9][a-zA-Z0-9._/:@+[\]-]*$/.test(item))) throw new Error(`Invalid harness ${key}. Use an exact identifier or an empty string for the harness default.`);
    result[key] = item;
  }
  return result;
}

export function validateCliOptions(cli: string, options: CliOptions): CliOptions {
  const checked = cliOptions(options);
  const harness = cliHarness(cli);
  if (!harness) throw new Error("Unknown harness.");
  if (checked.effort && (!harness.efforts.length || (cli !== "opencode" && !harness.efforts.includes(checked.effort)))) throw new Error(`${harness.label} does not support effort "${checked.effort}". ${harness.efforts.length ? `Choose ${harness.efforts.join(", ")}.` : "Choose a model or use its native settings instead."}`);
  return checked;
}

export type CliInput = { id: string; cli: string; turn: number };

export type CliHandoffRequest = { sourceId: string; cli?: string; id?: string; prompt: string } & CliOptions;

export function cliInputIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8 || value.some((id) => typeof id !== "string" || id.length > 64 || !/^cli[0-9]+$/.test(id))) throw new Error("fromRuns must contain up to eight CLI run ids.");
  return [...new Set(value as string[])];
}

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
  effort?: string;
  inputs?: CliInput[];
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
    .map((run) => `${run.id}  ${run.cli}${run.model ? ` (${run.model})` : ""}  ${run.effort ? `effort=${run.effort}  ` : ""}${run.status}${run.status !== "running" && run.exitCode ? ` (exit ${run.exitCode})` : ""}  ${run.turns} ${run.turns === 1 ? "turn" : "turns"}  ${run.folder}  ${run.title}`)
    .join("\n");
}
