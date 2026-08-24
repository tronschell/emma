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
  ask: "Every write, command, and click asks first.",
  acceptEdits: "File edits go through; commands and the pointer still ask.",
  auto: "A separate verifier model reads each gated call; anything it will not clear still asks you.",
  full: "Nothing asks. Escape still stops a run.",
};

/** Every tool the agent loop can advertise. `computer` and `write_skill` predate this table. */
export const AGENT_TOOLS = [
  "browser",
  "cli",
  "cli_runs",
  "computer",
  "write_skill",
  "write_tool",
  "write_plugin",
  "run_tool",
  "memory",
  "advisor",
  "vision",
  "web_search",
  "plan",
  "threads",
  "read_trace",
  "context",
  "save_page",
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

const GATES: Record<AgentToolName, Record<GatedMode, ToolGate>> = {
  plan: { ask: "auto", acceptEdits: "auto", full: "auto" },
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
  web_search: { ask: "auto", acceptEdits: "auto", full: "auto" },
  save_page: { ask: "auto", acceptEdits: "auto", full: "auto" },
  cli: { ask: "ask", acceptEdits: "ask", full: "auto" },
  cli_runs: { ask: "auto", acceptEdits: "auto", full: "auto" },
  computer: { ask: "ask", acceptEdits: "ask", full: "auto" },
  browser: { ask: "ask", acceptEdits: "ask", full: "auto" },
  agents: { ask: "auto", acceptEdits: "auto", full: "auto" },
  install_mcp: { ask: "ask", acceptEdits: "ask", full: "auto" },
  workflow: { ask: "ask", acceptEdits: "ask", full: "auto" },
  autoresearch: { ask: "ask", acceptEdits: "ask", full: "auto" },
  artifact: { ask: "auto", acceptEdits: "auto", full: "auto" },
  visualize: { ask: "auto", acceptEdits: "auto", full: "auto" },
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
  { name: "web_search", label: "Web search", blurb: "Searches the web through the provider configured below.", group: "Web" },
  { name: "save_page", label: "Save page", blurb: "Clips a web page into your knowledge base and files it.", group: "Web" },
  { name: "browser", label: "Browser", blurb: "Drives a real Chrome browser, mirrored in the browser pane so you can watch it and take the wheel.", group: "Web" },
  { name: "computer", label: "Control this Mac", blurb: "Takes the real pointer and keyboard, and looks at the screen.", group: "This Mac" },
  { name: "cli", label: "Run another CLI", blurb: "Runs Claude Code, Codex, Pi, OpenCode or Cursor in a folder.", group: "This Mac" },
  { name: "cli_runs", label: "CLI runs", blurb: "Lists the installed CLIs and watches the runs already going.", group: "This Mac" },
  { name: "advisor", label: "Advisor", blurb: "Consults a stronger model with this thread's transcript for a plan.", group: "Thinking" },
  { name: "vision", label: "Vision", blurb: "Asks a model that can see about an image, for one that cannot.", group: "Thinking" },
  { name: "memory", label: "Memory", blurb: "Emma's own notes directory, carried between conversations.", group: "Thinking" },
  { name: "write_skill", label: "Write skill", blurb: "Records a durable lesson so later runs do not repeat a mistake.", group: "Thinking" },
  { name: "read_trace", label: "Read trace", blurb: "Reads what past turns in this thread actually did, call by call.", group: "Thinking" },
  { name: "context", label: "Context window", blurb: "Reads how full this thread's context window is, and folds its older turns into one summary.", group: "Thinking" },
  { name: "plan", label: "Plan", blurb: "Breaks a job into steps in a markdown file, then runs the ones that can go at once as parallel subagents.", group: "Threads" },
  { name: "threads", label: "Threads", blurb: "Starts, lists, reads, renames and messages the threads in your sidebar.", group: "Threads" },
  { name: "write_tool", label: "Write tool", blurb: "Writes a script of Emma's own, callable by name in later threads.", group: "Extensions" },
  { name: "write_plugin", label: "Write plugin", blurb: "Packages skills as a ChatGPT and Codex plugin and installs it on the Plugins page.", group: "Extensions" },
  { name: "run_tool", label: "Run tool", blurb: "Lists and runs the tools Emma wrote for herself.", group: "Extensions" },
  { name: "agents", label: "Live agents", blurb: "Lists what is running right now, and sends a message into a run in flight or stops it.", group: "Threads" },
  { name: "install_mcp", label: "Install MCP server", blurb: "Adds an MCP server to Emma's config, for the harness to connect from the next turn.", group: "Extensions" },
  { name: "workflow", label: "Scheduled tasks", blurb: "Builds and runs the workflows in the Scheduled section.", group: "Automation" },
  { name: "autoresearch", label: "Autoresearch", blurb: "Builds and runs the long experiment loops in the Autoresearch section.", group: "Automation" },
  { name: "artifact", label: "Artifacts", blurb: "Writes and edits the documents, pages and drawings kept on the Artifacts page.", group: "Thinking" },
  { name: "visualize", label: "Visualize", blurb: "Draws a chart inline in the conversation. Nothing is saved — it belongs to the answer it explains.", group: "Thinking" },
];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function asPermissionMode(value: unknown): PermissionMode {
  return isPermissionMode(value) ? value : DEFAULT_PERMISSION_MODE;
}
