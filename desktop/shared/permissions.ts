export const PERMISSION_MODES = ["ask", "acceptEdits", "auto", "full"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask";

export const permissionModeNames: Record<PermissionMode, string> = {
  ask: "Ask",
  acceptEdits: "Accept edits",
  auto: "Auto",
  full: "Full access",
};

export const permissionModeGlyphs: Record<PermissionMode, string> = {
  ask: "◈",
  acceptEdits: "◆",
  auto: "⬗",
  full: "⬥",
};

export const permissionModeHints: Record<PermissionMode, string> = {
  ask: "Writes and commands ask first; app access asks once per turn.",
  acceptEdits: "File edits go through; commands and app access still ask.",
  auto: "A verifier reviews gated calls. App access always asks you.",
  full: "Tools run automatically; app access still asks. Escape stops a computer run.",
};

export const AGENT_TOOLS = [
  "browser",
  "cli",
  "cli_runs",
  "computer",
  "shortcut",
  "write_skill",
  "write_tool",
  "write_plugin",
  "run_tool",
  "memory",
  "advisor",
  "vision",
  "secret",
  "web_search",
  "task_list",
  "plan",
  "goal",
  "threads",
  "read_trace",
  "context",
  "keep",
  "agents",
  "install_mcp",
  "workflow",
  "autoresearch",
  "artifact",
  "component",
  "visualize",
] as const;
export type AgentToolName = (typeof AGENT_TOOLS)[number];

export type ToolGate = "hidden" | "ask" | "auto";

type GatedMode = Exclude<PermissionMode, "auto">;

const GATES: Record<AgentToolName, Record<GatedMode, ToolGate>> = {
  task_list: { ask: "auto", acceptEdits: "auto", full: "auto" },
  plan: { ask: "auto", acceptEdits: "auto", full: "auto" },
  goal: { ask: "auto", acceptEdits: "auto", full: "auto" },
  read_trace: { ask: "auto", acceptEdits: "auto", full: "auto" },
  context: { ask: "auto", acceptEdits: "auto", full: "auto" },
  threads: { ask: "auto", acceptEdits: "auto", full: "auto" },
  write_skill: { ask: "auto", acceptEdits: "auto", full: "auto" },
  write_tool: { ask: "auto", acceptEdits: "auto", full: "auto" },
  write_plugin: { ask: "auto", acceptEdits: "auto", full: "auto" },
  run_tool: { ask: "ask", acceptEdits: "ask", full: "auto" },
  memory: { ask: "auto", acceptEdits: "auto", full: "auto" },
  advisor: { ask: "auto", acceptEdits: "auto", full: "auto" },
  vision: { ask: "auto", acceptEdits: "auto", full: "auto" },
  secret: { ask: "ask", acceptEdits: "ask", full: "auto" },
  web_search: { ask: "auto", acceptEdits: "auto", full: "auto" },
  keep: { ask: "auto", acceptEdits: "auto", full: "auto" },
  cli: { ask: "ask", acceptEdits: "ask", full: "auto" },
  cli_runs: { ask: "auto", acceptEdits: "auto", full: "auto" },
  computer: { ask: "ask", acceptEdits: "ask", full: "ask" },
  shortcut: { ask: "auto", acceptEdits: "auto", full: "auto" },
  browser: { ask: "ask", acceptEdits: "ask", full: "auto" },
  agents: { ask: "auto", acceptEdits: "auto", full: "auto" },
  install_mcp: { ask: "ask", acceptEdits: "ask", full: "auto" },
  workflow: { ask: "ask", acceptEdits: "ask", full: "auto" },
  autoresearch: { ask: "ask", acceptEdits: "ask", full: "auto" },
  artifact: { ask: "auto", acceptEdits: "auto", full: "auto" },
  component: { ask: "auto", acceptEdits: "auto", full: "auto" },
  visualize: { ask: "auto", acceptEdits: "auto", full: "auto" },
};

export function toolGate(mode: PermissionMode, tool: string, disabled: readonly string[] = []): ToolGate {
  if (disabled.includes(tool)) return "hidden";
  const row = GATES[tool as AgentToolName];

  return row ? row[mode === "auto" ? "ask" : mode] : "hidden";
}

export const TOOL_CATALOG: { name: AgentToolName; label: string; blurb: string; group: string }[] = [
  { name: "web_search", label: "Web search", blurb: "Searches the web through the provider configured below.", group: "Web" },
  { name: "keep", label: "Keep", blurb: "Saves a page, a highlight or a note into your knowledge base as Markdown.", group: "Web" },
  { name: "browser", label: "Browser", blurb: "Drives a real Chrome browser, mirrored in the browser pane so you can watch it and take the wheel.", group: "Web" },
  { name: "computer", label: "Computer use", blurb: "Reads and controls a running app in the background, only after you allow that app for the turn.", group: "This computer" },
  { name: "shortcut", label: "Shortcuts", blurb: "Turns a natural-language request into a global Quick Action shortcut on this computer.", group: "This computer" },
  { name: "cli", label: "Run another CLI", blurb: "Runs Claude Code, Codex, Pi, OpenCode or Cursor in a folder.", group: "This computer" },
  { name: "cli_runs", label: "CLI runs", blurb: "Lists the installed CLIs and watches the runs already going.", group: "This computer" },
  { name: "advisor", label: "Advisor", blurb: "Consults a stronger model with this thread's transcript for a plan.", group: "Thinking" },
  { name: "vision", label: "Vision", blurb: "Asks a model that can see about an image, for one that cannot.", group: "Thinking" },
  { name: "secret", label: "Secrets", blurb: "Runs a command whose output holds keys or tokens, and sends that output only to the model you picked for secrets.", group: "This computer" },
  { name: "memory", label: "Memory", blurb: "Emma's own notes directory, carried between conversations.", group: "Thinking" },
  { name: "write_skill", label: "Write skill", blurb: "Records a durable lesson so later runs do not repeat a mistake.", group: "Thinking" },
  { name: "read_trace", label: "Read trace", blurb: "Reads what past turns in this thread actually did, call by call.", group: "Thinking" },
  { name: "context", label: "Context window", blurb: "Reads how full this thread's context window is, and folds its older turns into one summary.", group: "Thinking" },
  { name: "task_list", label: "Task list", blurb: "Tracks one complex job as a durable Markdown tree of tasks and subtasks.", group: "Threads" },
  { name: "plan", label: "Plan", blurb: "Breaks a job into steps in a markdown file, then runs the ones that can go at once as parallel subagents.", group: "Threads" },
  { name: "goal", label: "Goal", blurb: "Gives a thread an objective it keeps working at across turns, inside a token budget you set.", group: "Threads" },
  { name: "threads", label: "Threads", blurb: "Starts, lists, reads, renames and messages the threads in your sidebar.", group: "Threads" },
  { name: "write_tool", label: "Write tool", blurb: "Writes a script of Emma's own, callable by name in later threads.", group: "Extensions" },
  { name: "write_plugin", label: "Write plugin", blurb: "Packages skills as a ChatGPT and Codex plugin and installs it on the Plugins page.", group: "Extensions" },
  { name: "run_tool", label: "Run tool", blurb: "Lists and runs the tools Emma wrote for herself.", group: "Extensions" },
  { name: "agents", label: "Live agents", blurb: "Lists what is running right now, and sends a message into a run in flight or stops it.", group: "Threads" },
  { name: "install_mcp", label: "Install MCP server", blurb: "Adds an MCP server to Emma's config, for the harness to connect from the next turn.", group: "Extensions" },
  { name: "workflow", label: "Scheduled tasks", blurb: "Builds and runs the workflows in the Scheduled section.", group: "Automation" },
  { name: "autoresearch", label: "Autoresearch", blurb: "Builds and runs the long experiment loops in the Autoresearch section.", group: "Automation" },
  { name: "artifact", label: "Artifacts", blurb: "Writes and edits the documents, pages and drawings kept on the Artifacts page.", group: "Thinking" },
  { name: "component", label: "Build into Emma", blurb: "Builds a widget into the context bar, and reworks it while you watch. Switch one off or delete it from the \u22ef in its header.", group: "Thinking" },
  { name: "visualize", label: "Visualize", blurb: "Draws a picture inline in the conversation — charts, panels, anything it can draw. Nothing is saved until you keep it.", group: "Thinking" },
];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function asPermissionMode(value: unknown): PermissionMode {
  return isPermissionMode(value) ? value : DEFAULT_PERMISSION_MODE;
}
