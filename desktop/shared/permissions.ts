/* What a turn is allowed to do without stopping to ask. One table, shared by the
   composer's mode picker, main's tool gate, and a scheduled job's saved mode, so
   the label the user picked and the check that enforces it can never drift. */

export const PERMISSION_MODES = ["plan", "ask", "acceptEdits", "auto", "full"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask";

export const permissionModeNames: Record<PermissionMode, string> = {
  plan: "Plan",
  ask: "Ask",
  acceptEdits: "Accept edits",
  auto: "Auto",
  full: "Full access",
};

export const permissionModeGlyphs: Record<PermissionMode, string> = {
  plan: "◇",
  ask: "◈",
  acceptEdits: "◆",
  auto: "⬗",
  full: "⬥",
};

export const permissionModeHints: Record<PermissionMode, string> = {
  plan: "Reads and subagents only. Nothing on this Mac changes.",
  ask: "Every write, command, and click asks first.",
  acceptEdits: "File writes and grep go through; other commands and the pointer still ask.",
  auto: "A separate verifier model reads each gated call; anything it will not clear still asks you.",
  full: "Nothing asks. Escape still stops a run.",
};

/** Every tool the agent loop can advertise. `computer` and `write_skill` predate this table. */
export const AGENT_TOOLS = [
  "read_file",
  "list_files",
  "ripgrep",
  "write_file",
  "bash",
  "background",
  "cli",
  "cli_runs",
  "connect_folder",
  "computer",
  "write_skill",
  "write_tool",
  "run_tool",
  "memory",
  "advisor",
  "vision",
  "web_fetch",
  "web_search",
  "task",
  "plan",
  "threads",
  "read_trace",
  "context",
  "save_page",
  "mcp_tool",
  "agents",
  "install_mcp",
  "workflow",
  "autoresearch",
  "artifact",
  "visualize",
] as const;
export type AgentToolName = (typeof AGENT_TOOLS)[number];

/** `hidden` is never advertised, so the model cannot even ask for it. */
export type ToolGate = "hidden" | "ask" | "auto";

/* `auto` has no column of its own: it reads `ask`'s, and the question goes to the
   verifier model instead of to the user. One column, so the two can never drift —
   whatever asks a person in `ask` is exactly what a verifier is asked to clear. */
type GatedMode = Exclude<PermissionMode, "auto">;

/* Reads are free everywhere: a grant is already the user saying yes to the folder.
   `task` is free too — a subagent inherits this same mode, so its own writes and
   commands hit this table again rather than escaping through the spawn. */
const GATES: Record<AgentToolName, Record<GatedMode, ToolGate>> = {
  read_file: { plan: "auto", ask: "auto", acceptEdits: "auto", full: "auto" },
  list_files: { plan: "auto", ask: "auto", acceptEdits: "auto", full: "auto" },
  // Searching the granted folder is a read, and it runs one bundled binary with
  // no shell — strictly less than the bare-grep carve-out `bash` already gets.
  ripgrep: { plan: "auto", ask: "auto", acceptEdits: "auto", full: "auto" },
  task: { plan: "auto", ask: "auto", acceptEdits: "auto", full: "auto" },
  // A markdown file in Emma's own data folder, which the user reads in the Plans
  // section and can open in any editor. Running a wave off it is `task` eight
  // times over, and every one of those subagents inherits this mode — so what
  // gates here is the file, and it sits exactly where `artifact` does, hidden in
  // `plan` where the promise is that nothing at all happens.
  plan: { plan: "hidden", ask: "auto", acceptEdits: "auto", full: "auto" },
  // Emma's own record of what Emma already did in this thread. It reaches no
  // file the user did not already own and changes nothing, so it is strictly
  // less than `read_file`, which is auto in every mode including `plan`.
  read_trace: { plan: "auto", ask: "auto", acceptEdits: "auto", full: "auto" },
  // Emma's own window, read and shrunk. It reaches nothing on the Mac and the
  // history it folds is Emma's own — the same summary the loop already writes
  // by itself under token pressure, just asked for early. Free in `plan` too:
  // there is nothing to plan about running out of room.
  context: { plan: "auto", ask: "auto", acceptEdits: "auto", full: "auto" },
  // Emma's own threads, which the user can already read and rename in the
  // sidebar. Reading, listing and renaming change nothing, so the tool is
  // offered everywhere; the halves that add a row or put an agent to work are
  // refused inside it in `plan`, where the promise is that nothing happens.
  // Spawning is gated like `task` and for the same reason: a thread's agent
  // inherits this mode, so its own writes and commands hit this table again
  // rather than escaping through the spawn.
  threads: { plan: "auto", ask: "auto", acceptEdits: "auto", full: "auto" },
  write_skill: { plan: "hidden", ask: "auto", acceptEdits: "auto", full: "auto" },
  // One script into Emma's own tools folder. Writing is not running: nothing
  // executes until `run_tool`, which gates like `bash` because that is exactly
  // what it is — so this sits with `write_skill`, and the code is in the
  // transcript either way.
  write_tool: { plan: "hidden", ask: "auto", acceptEdits: "auto", full: "auto" },
  // Runs a script with the connected folder as its working directory. Whoever
  // wrote it, that is arbitrary code on the user's Mac, so it sits exactly where
  // `bash` does and never lower — including in `acceptEdits`, where the promise
  // is edits and not commands.
  run_tool: { plan: "hidden", ask: "ask", acceptEdits: "ask", full: "auto" },
  // Emma's own memory directory, under its data folder. Reaches no file the user
  // owns, but it does write, so it sits exactly where `write_skill` does — and in
  // `plan`, where nothing at all happens, the tool is not offered and the memory
  // protocol simply does not apply to that turn.
  memory: { plan: "hidden", ask: "auto", acceptEdits: "auto", full: "auto" },
  // Sends this thread's transcript to the second model the user configured and
  // reads back a paragraph. Nothing on the Mac changes, and the route is one the
  // user set up in Settings — the same standing consent the Auto verifier runs on.
  // Free in `plan` above all: a plan is exactly what it is for.
  advisor: { plan: "auto", ask: "auto", acceptEdits: "auto", full: "auto" },
  // Sends one image the user's folder already grants — or a public URL — to the
  // vision model they configured, and reads a paragraph back. Nothing on the Mac
  // changes, and it is strictly less than `read_file`, which hands the whole text
  // of that same folder to the model on every turn.
  vision: { plan: "auto", ask: "auto", acceptEdits: "auto", full: "auto" },
  // Reads a public URL and returns its text. It stores nothing, so unlike
  // `save_page` it is free in `plan` too. What comes back is untrusted data, not
  // instructions — that warning lives in the tool's own description.
  web_fetch: { plan: "auto", ask: "auto", acceptEdits: "auto", full: "auto" },
  web_search: { plan: "auto", ask: "auto", acceptEdits: "auto", full: "auto" },
  // Reads a public page and files it in the user's own knowledge base: nothing
  // on the Mac changes, but the library grows, so `plan` — where nothing at all
  // happens — does not offer it.
  save_page: { plan: "hidden", ask: "auto", acceptEdits: "auto", full: "auto" },
  // The picker is the permission: nothing happens until the user chooses a
  // folder in their own dialog, so no mode has a second question to ask. Plan
  // included — a grant is Emma's own configuration, not a change to the Mac.
  connect_folder: { plan: "auto", ask: "auto", acceptEdits: "auto", full: "auto" },
  write_file: { plan: "hidden", ask: "ask", acceptEdits: "auto", full: "auto" },
  bash: { plan: "hidden", ask: "ask", acceptEdits: "ask", full: "auto" },
  // Listing, reading and stopping commands Emma itself started. Starting one went
  // through `bash`, and stopping is the safe direction, so nothing here asks again.
  background: { plan: "hidden", ask: "auto", acceptEdits: "auto", full: "auto" },
  // Hands the folder to another coding agent — Claude Code, Codex, Pi, OpenCode —
  // which then edits and runs whatever it decides to. That is strictly more than
  // `bash` does, and the ask carries the whole argv including any bypass flag, so
  // it sits exactly where `bash` does and never lower.
  cli: { plan: "hidden", ask: "ask", acceptEdits: "ask", full: "auto" },
  // Watching, reading and stopping runs Emma itself started, and asking which
  // CLIs are installed. Starting one went through `cli`, and stopping is the safe
  // direction — the same split, for the same reason, as `bash` and `background`.
  // Free in `plan` too: it reads what already happened and changes nothing.
  cli_runs: { plan: "auto", ask: "auto", acceptEdits: "auto", full: "auto" },
  computer: { plan: "hidden", ask: "ask", acceptEdits: "ask", full: "auto" },
  mcp_tool: { plan: "hidden", ask: "ask", acceptEdits: "ask", full: "auto" },
  // Writes one entry into Emma's own MCP config and starts that process. The ask
  // carries the exact command, arguments and environment keys, so answering it is
  // the same review the capability panel's one-use token stands for. It sits with
  // `bash` rather than with `write_skill`: what lands on disk is a config line,
  // but what it does is run a program.
  agents: { plan: "auto", ask: "auto", acceptEdits: "auto", full: "auto" },
  install_mcp: { plan: "hidden", ask: "ask", acceptEdits: "ask", full: "auto" },
  // Saving or firing a task hands out an agent turn that runs later with nobody
  // watching, under whatever mode the task was saved with. That is the one thing
  // this table exists to gate, so it asks — including for a read, since the gate
  // is per tool and a stray prompt beats an unattended run nobody agreed to.
  workflow: { plan: "hidden", ask: "ask", acceptEdits: "ask", full: "auto" },
  // Starting a job hands out agent turns that edit a project and run its commands
  // for as long as its budgets last, so it sits exactly where `workflow` does.
  autoresearch: { plan: "hidden", ask: "ask", acceptEdits: "ask", full: "auto" },
  // A document in Emma's own data folder, which the user can edit and delete on the
  // Artifacts page. It reaches no file they own, so it sits with `write_skill` — and
  // in `plan`, where nothing at all happens, a new document is still something.
  artifact: { plan: "hidden", ask: "auto", acceptEdits: "auto", full: "auto" },
  // Draws a chart in the transcript and stops there: no file, no folder, nothing
  // that outlives the thread it was drawn in. That is strictly less than
  // `artifact`, which is why this one is offered in `plan` too — a plan made of
  // numbers is exactly where a picture beats a paragraph, and drawing it changes
  // nothing on the Mac.
  visualize: { plan: "auto", ask: "auto", acceptEdits: "auto", full: "auto" },
};

/**
 * What one tool may do in one mode, with the user's own switches applied.
 *
 * `disabled` comes from Settings → Tools and is checked here rather than at the
 * point a tool is advertised, so a switched-off tool is hidden from the model
 * *and* refused if it is asked for anyway — one place, both halves.
 */
export function toolGate(mode: PermissionMode, tool: string, disabled: readonly string[] = []): ToolGate {
  if (disabled.includes(tool)) return "hidden";
  const row = GATES[tool as AgentToolName];
  // An unknown name is not a tool Emma advertises, so there is nothing to allow.
  return row ? row[mode === "auto" ? "ask" : mode] : "hidden";
}

/**
 * Every built-in tool as Settings → Tools shows it: what it is for, in one line,
 * and which group it belongs under.
 *
 * Here rather than beside the schemas in `main/tools.ts` because the renderer
 * cannot import that file — it pulls in Electron — and because sitting next to
 * `GATES` is what stops the two lists from drifting apart. The test asserts they
 * cover exactly the same names.
 */
export const TOOL_CATALOG: { name: AgentToolName; label: string; blurb: string; group: string }[] = [
  { name: "connect_folder", label: "Connect folder", blurb: "Opens your folder picker so a thread gets a project to work in.", group: "Files" },
  { name: "read_file", label: "Read file", blurb: "Reads a text file from a connected folder.", group: "Files" },
  { name: "list_files", label: "List files", blurb: "Lists the text files in a connected folder, with sizes.", group: "Files" },
  { name: "ripgrep", label: "Search files", blurb: "Searches a connected folder with the bundled ripgrep.", group: "Files" },
  { name: "write_file", label: "Write file", blurb: "Writes a file's whole contents in a connected folder.", group: "Files" },
  { name: "bash", label: "Shell", blurb: "Runs one shell command in a connected folder.", group: "Files" },
  { name: "background", label: "Background commands", blurb: "Lists, reads and stops the commands the shell tool started.", group: "Files" },
  { name: "web_search", label: "Web search", blurb: "Searches the web through the provider configured below.", group: "Web" },
  { name: "web_fetch", label: "Web fetch", blurb: "Fetches one URL and returns its readable text.", group: "Web" },
  { name: "save_page", label: "Save page", blurb: "Clips a web page into your knowledge base and files it.", group: "Web" },
  { name: "computer", label: "Control this Mac", blurb: "Takes the real pointer and keyboard, and looks at the screen.", group: "This Mac" },
  { name: "cli", label: "Run another CLI", blurb: "Runs Claude Code, Codex, Pi, OpenCode or Cursor in a folder.", group: "This Mac" },
  { name: "cli_runs", label: "CLI runs", blurb: "Lists the installed CLIs and watches the runs already going.", group: "This Mac" },
  { name: "advisor", label: "Advisor", blurb: "Consults a stronger model with this thread's transcript for a plan.", group: "Thinking" },
  { name: "vision", label: "Vision", blurb: "Asks a model that can see about an image, for one that cannot.", group: "Thinking" },
  { name: "memory", label: "Memory", blurb: "Emma's own notes directory, carried between conversations.", group: "Thinking" },
  { name: "write_skill", label: "Write skill", blurb: "Records a durable lesson so later runs do not repeat a mistake.", group: "Thinking" },
  { name: "read_trace", label: "Read trace", blurb: "Reads what past turns in this thread actually did, call by call.", group: "Thinking" },
  { name: "context", label: "Context window", blurb: "Reads how full this thread's context window is, and folds its older turns into one summary.", group: "Thinking" },
  { name: "task", label: "Subagent", blurb: "Hands self-contained work to a subagent and waits for its answer.", group: "Threads" },
  { name: "plan", label: "Plan", blurb: "Breaks a job into steps in a markdown file, then runs the ones that can go at once as parallel subagents.", group: "Threads" },
  { name: "threads", label: "Threads", blurb: "Starts, lists, reads, renames and messages the threads in your sidebar.", group: "Threads" },
  { name: "write_tool", label: "Write tool", blurb: "Writes a script of Emma's own, callable by name in later threads.", group: "Extensions" },
  { name: "run_tool", label: "Run tool", blurb: "Lists and runs the tools Emma wrote for herself.", group: "Extensions" },
  { name: "mcp_tool", label: "MCP tools", blurb: "Calls a tool on a connected MCP server.", group: "Extensions" },
  { name: "agents", label: "Live agents", blurb: "Lists what is running right now, and sends a message into a run in flight or stops it.", group: "Threads" },
  { name: "install_mcp", label: "Install MCP server", blurb: "Adds an MCP server to Emma's config and connects it in the same call.", group: "Extensions" },
  { name: "workflow", label: "Scheduled tasks", blurb: "Builds and runs the workflows in the Scheduled section.", group: "Automation" },
  { name: "autoresearch", label: "Autoresearch", blurb: "Builds and runs the long experiment loops in the Autoresearch section.", group: "Automation" },
  { name: "artifact", label: "Artifacts", blurb: "Writes and edits the documents, pages and drawings kept on the Artifacts page.", group: "Thinking" },
  { name: "visualize", label: "Visualize", blurb: "Draws a chart inline in the conversation. Nothing is saved — it belongs to the answer it explains.", group: "Thinking" },
];

/* Anything that could chain, redirect, substitute or subshell. A command carrying one
   of these is not the single read it looks like, so it goes back to asking. */
// ponytail: flat scan, so a quoted metacharacter — grep -E 'a|b' — asks rather than
// running. Swap in a real shell-word split if that turns out to be the common case.
const SHELL_OPERATORS = /[;&|<>$`(){}\r\n]/;

/** One lone `grep`, no shell operators: a read, and reads are free in every mode. */
export function isBareGrep(command: string): boolean {
  const trimmed = command.trim();
  return /^grep(\s|$)/.test(trimmed) && !SHELL_OPERATORS.test(trimmed);
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function asPermissionMode(value: unknown): PermissionMode {
  return isPermissionMode(value) ? value : DEFAULT_PERMISSION_MODE;
}
