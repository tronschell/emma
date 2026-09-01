export type HarnessFlow = "out" | "in" | "err";

export type HarnessLogLine = { at: number; flow: HarnessFlow; label: string; body: string };

export type HarnessState = { cwd: string; running: boolean; busy: boolean; silentMs: number; failure: string };

export type HarnessReport = { processes: HarnessState[]; lines: HarnessLogLine[] };

export type HarnessHealth = "ready" | "online" | "stalled" | "offline";

export const CLOSED_BY_EMMA = "Harness closed";
export const STALL_MS = 120_000;
export const MAX_LOG_LINES = 500;
export const MAX_LOG_BODY = 8 * 1024;

export const FLOW_LABEL: Record<HarnessFlow, string> = {
  out: "Emma → agent",
  in: "Agent → Emma",
  err: "Process",
};

export const HEALTH_LABEL: Record<HarnessHealth, string> = {
  ready: "Agent ready",
  online: "Agent online",
  stalled: "Agent stalled",
  offline: "Agent offline",
};

export const HEALTH_ADVICE: Record<HarnessHealth, string> = {
  ready: "No emma-cli process is running. The next turn starts one.",
  online: "emma-cli is up and answering.",
  stalled: `A turn is in flight but emma-cli has said nothing for over ${Math.round(STALL_MS / 60_000)} minutes. Stop the turn, or restart the agent.`,
  offline: "emma-cli stopped. Restart it; if it dies again, hand the fix prompt to another agent.",
};

export function harnessHealth(processes: readonly HarnessState[]): HarnessHealth {
  if (!processes.length) return "ready";
  if (processes.some((process) => process.running && process.busy && process.silentMs > STALL_MS)) return "stalled";
  if (processes.some((process) => process.running)) return "online";
  return processes.some((process) => process.failure && process.failure !== CLOSED_BY_EMMA) ? "offline" : "ready";
}

export function stoppedReason(processes: readonly HarnessState[]): string {
  if (harnessHealth(processes) !== "offline") return "";
  return processes.find((process) => process.failure && process.failure !== CLOSED_BY_EMMA)?.failure ?? "";
}

const clock = (at: number) => new Date(at).toISOString().slice(11, 19);

export const logLine = (line: HarnessLogLine, bodyChars = MAX_LOG_BODY) =>
  `${clock(line.at)} ${line.flow.padEnd(3)} ${line.label} ${line.body.slice(0, bodyChars)}`;

const stateLine = (state: HarnessState) =>
  [
    state.cwd,
    state.running ? "running" : "not running",
    state.busy ? "a turn is in flight" : "idle",
    state.silentMs ? `silent for ${Math.round(state.silentMs / 1000)}s` : "never spoke",
    state.failure ? `last error: ${state.failure}` : "",
  ].filter(Boolean).join(" · ");

const PROMPT_LINES = 40;
const PROMPT_BODY = 600;

export function fixPrompt(report: HarnessReport): string {
  const health = harnessHealth(report.processes);
  return [
    `Emma's agent harness is ${HEALTH_LABEL[health].toLowerCase()}. It is emma-cli, the Zig program in harness/, spawned and driven over the Agent Client Protocol by desktop/main/harness.ts.`,
    "",
    report.processes.length ? "Processes Emma is holding:" : "Emma is holding no harness process.",
    ...report.processes.map((state) => `- ${stateLine(state)}`),
    "",
    report.lines.length ? `Last ${Math.min(PROMPT_LINES, report.lines.length)} wire messages Emma recorded, oldest first (out = Emma to the agent, in = the agent to Emma, err = the process itself):` : "Emma recorded no wire traffic.",
    ...report.lines.slice(-PROMPT_LINES).map((line) => logLine(line, PROMPT_BODY)),
    "",
    "Find out why the harness is in this state and fix it. Start at desktop/main/harness.ts for the client side and harness/src/acp/ for the agent side, then rebuild with `npm run build:harness`. Report what was actually wrong rather than restarting it and calling it fixed.",
  ].join("\n");
}
