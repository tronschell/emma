/* The other coding CLIs on this Mac.
 *
 * Emma is a meta harness: it does not reimplement Claude Code, Codex, Pi or
 * OpenCode, it runs the one the user already has in the thread's own folder,
 * shows its terminal live, and feeds it the next prompt. What actually differs
 * between four of them is three strings — the binary, how to phrase one run,
 * and how to phrase the next run in the same conversation — so that is all this
 * table holds. Everything else about a run is the same for all of them.
 *
 * Ids match `importerBrands` in src/brands.ts, so a run's tab gets its logo for
 * free rather than carrying an asset path through main and the IPC boundary.
 */

export type CliHarness = {
  id: string;
  label: string;
  /** Looked up on the user's login PATH, not Electron's. */
  bin: string;
  /** One run, starting a new conversation. */
  start: (prompt: string, session: string) => string[];
  /** The next run, continuing that conversation. */
  resume: (prompt: string, session: string) => string[];
  /**
   * True when `resume` names Emma's own session id.
   *
   * ponytail: false means the CLI only offers "continue the newest session in
   * this directory", so two Emma runs of it in one folder would resume each
   * other's. Fine for one at a time, which is what the dock shows; upgrade by
   * scraping the id the CLI prints on its first run.
   */
  ownsSession: boolean;
  /** The flags that stop it asking a human for approval. Empty when it never asks. */
  unattended: string[];
};

/** Session ids are UUIDs because `claude --session-id` and `codex exec resume` require one. */
export const CLI_HARNESSES: readonly CliHarness[] = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    start: (prompt, session) => ["--print", "--session-id", session, prompt],
    resume: (prompt, session) => ["--print", "--resume", session, prompt],
    ownsSession: true,
    unattended: ["--dangerously-skip-permissions"],
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    start: (prompt) => ["exec", "--color", "never", prompt],
    resume: (prompt) => ["exec", "resume", "--last", "--color", "never", prompt],
    ownsSession: false,
    unattended: ["--dangerously-bypass-approvals-and-sandbox"],
  },
  {
    id: "pi",
    label: "Pi",
    bin: "pi",
    start: (prompt, session) => ["--print", "--session-id", session, prompt],
    resume: (prompt, session) => ["--print", "--session-id", session, prompt],
    ownsSession: true,
    unattended: [],
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    start: (prompt) => ["run", prompt],
    resume: (prompt) => ["run", "--continue", prompt],
    ownsSession: false,
    unattended: ["--auto"],
  },
  {
    // ponytail: the only one not verified against an install — `cursor-agent` was
    // not on the machine this was written on. Its flags come from Cursor's own
    // docs; if a run fails at argv, this row is the first place to look.
    id: "cursor",
    label: "Cursor CLI",
    bin: "cursor-agent",
    start: (prompt) => ["--print", prompt],
    resume: (prompt) => ["--print", "--resume", prompt],
    ownsSession: false,
    unattended: ["--force"],
  },
];

export function cliHarness(id: string): CliHarness | undefined {
  return CLI_HARNESSES.find((harness) => harness.id === id);
}

export const CLI_IDS = CLI_HARNESSES.map((harness) => harness.id);

/** One CLI conversation Emma started, across however many turns it has taken. */
export type CliRun = {
  id: string;
  /** Harness id, which is also its brand id. */
  cli: string;
  /** The thread whose tab strip owns this run. */
  threadId: string;
  /** First line of the opening prompt, for the tab label. */
  title: string;
  cwd: string;
  /** Name of the connected folder it runs in, for the dock's second line. */
  folder: string;
  /** `running` while a child is alive; a run between turns is `idle`, not finished. */
  status: "running" | "idle" | "failed";
  /** The last turn's exit code. Null while one is in flight. */
  exitCode: number | null;
  /** Turns sent so far: the opening prompt plus every follow-up. */
  turns: number;
  startedAt: number;
  /** When the current turn started, so the dock's clock is per turn. */
  turnStartedAt: number;
  endedAt?: number;
  unattended: boolean;
};

/* CSI, OSC and two-byte escapes. A CLI writing to a pipe usually turns colour off
   by itself, but "usually" is not "never" and a raw escape in a <pre> is noise. */
// eslint-disable-next-line no-control-regex -- ANSI escapes are control characters; matching them is the point.
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;

/**
 * Terminal bytes as the screen would have them.
 *
 * ponytail: escapes stripped and carriage returns applied, which covers colour
 * and the spinner rewriting its own line. It is not a terminal emulator — a CLI
 * that addresses the cursor to redraw a box needs a real one, and that is
 * node-pty plus xterm.js, not this.
 */
export function terminalText(raw: string): string {
  return raw
    .replace(ANSI, "")
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      // Each \r puts the write head back at column zero: what it writes next
      // overwrites, and anything past it is still on screen.
      let out = "";
      for (const part of line.split("\r")) out = part + out.slice(part.length);
      return out;
    })
    .join("\n");
}

/** The last `count` lines, for the dock — the pinned strip is a few lines tall, not a page. */
export function tailLines(text: string, count: number): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

/** One line per run, for the tool result the model reads back. */
export function describeRuns(runs: CliRun[]): string {
  if (!runs.length) return "No CLI runs have been started in this session.";
  return runs
    .map((run) => `${run.id}  ${run.cli}  ${run.status}${run.status === "idle" && run.exitCode ? ` (exit ${run.exitCode})` : ""}  ${run.turns} ${run.turns === 1 ? "turn" : "turns"}  ${run.folder}  ${run.title}`)
    .join("\n");
}
