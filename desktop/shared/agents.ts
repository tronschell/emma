/* The live agent tree. Main owns the running loops; the renderer only ever reads
   these records, so everything here is plain data with no handles in it. */

import type { PermissionMode } from "./permissions";

export const MAX_LIVE_SUBAGENTS = 8;
/**
 * Threads that may have an agent working in them at once. A spawned thread's
 * agent can spawn threads of its own, so the ceiling is counted across the whole
 * process rather than per thread.
 */
export const MAX_LIVE_THREADS = 8;

/**
 * What a `threads` spawn prints at the end of its first line, so the transcript
 * can draw the thread it started instead of a sentence saying that it did — the
 * same trick `ARTIFACT_MARKER` plays. The title rides along because a card is
 * drawn from the tool result alone, with no second lookup.
 */
export const THREADS_MARKER = /\[threads:([a-z0-9-]{1,96}):([^\]\n]{1,128})]$/;

/** One spawned thread, as the transcript's card reads it back off a tool result. */
export function spawnedThread(output: string | undefined): { id: string; title: string } | undefined {
  const found = THREADS_MARKER.exec((output ?? "").split("\n", 1)[0].trim());
  return found ? { id: found[1], title: found[2] } : undefined;
}

/**
 * A turn one thread sent into another, marked at the head of the message itself.
 *
 * Sender travels in the text because a stored message is a role and a string and
 * nothing else. It earns its place twice over: the transcript names the thread
 * instead of calling it "You", and the agent reading it knows it is being talked
 * to by another agent rather than by the user.
 */
const FROM_THREAD_MARKER = /^\[thread ([a-z0-9-]{1,96}) messaged]\n/;

export function fromThread(sender: string, text: string): string {
  return `[thread ${sender} messaged]\n${text}`;
}

/** Who sent a stored turn, and its text with the marker taken back off. */
export function sentByThread(content: string): { from?: string; body: string } {
  const found = FROM_THREAD_MARKER.exec(content);
  return found ? { from: found[1], body: content.slice(found[0].length) } : { body: content };
}

/* Stable, distinguishable at a 8px dot, and readable on both themes. Assigned by
   spawn order and never reused while the parent turn is alive. */
export const AGENT_COLORS = [
  "#4f9dff",
  "#f2a13c",
  "#57c785",
  "#c77dff",
  "#ff6b81",
  "#3fc7d4",
  "#e0c341",
  "#8f9bff",
] as const;

export function agentColor(index: number): string {
  return AGENT_COLORS[index % AGENT_COLORS.length];
}

/**
 * What a subagent is called. A child arrives named by the sentence it was handed,
 * so a fanned-out plan renders as eight rows of the same truncated paragraph. A
 * name is shorter, tells them apart at a glance, and gives the user something to
 * say out loud.
 */
export const AGENT_NAMES = [
  "Ada", "Aiden", "Alba", "Alex", "Alice", "Amara", "Amos", "Anders", "Andre", "Angie",
  "Anita", "Anton", "Archie", "Aria", "Arlo", "Asa", "Ashe", "Astrid", "Aubrey", "August",
  "Aurora", "Avery", "Axel", "Baker", "Basil", "Bea", "Beau", "Bell", "Benji", "Bianca",
  "Birdie", "Blaise", "Bo", "Bodhi", "Boone", "Bram", "Bree", "Brooks", "Bruno", "Cal",
  "Callum", "Calvin", "Camila", "Carter", "Casey", "Cass", "Cato", "Cedar", "Celia", "Cleo",
  "Clyde", "Cody", "Cora", "Cosmo", "Cyrus", "Dahlia", "Dane", "Dario", "Dashiell", "Davi",
  "Delia", "Dev", "Dexter", "Dinah", "Dmitri", "Dora", "Dorian", "Dove", "Drew", "Duke",
  "Eamon", "Eden", "Edie", "Elias", "Ellis", "Eloise", "Elsie", "Emma", "Enzo", "Esme",
  "Etta", "Ewan", "Ezra", "Fable", "Faye", "Felix", "Fern", "Finn", "Flora", "Floyd",
  "Forrest", "Frank", "Freya", "Gabe", "Gable", "Gia", "Gideon", "Gil", "Gloria", "Grady",
  "Greta", "Gus", "Hal", "Hana", "Harlan", "Harper", "Hattie", "Hazel", "Heath", "Hector",
  "Hollis", "Hugo", "Ida", "Idris", "Ines", "Ira", "Iris", "Isla", "Ivan", "Ivy",
  "Jace", "Jada", "Jasper", "Javi", "Jeanie", "Jem", "Jonah", "John", "Jules", "June",
  "Juniper", "Kai", "Kalindi", "Karim", "Kasper", "Katy", "Keira", "Kenji", "Kit", "Knox",
  "Kyra", "Lachlan", "Lana", "Lars", "Lear", "Leif", "Lena", "Leo", "Levi", "Lila",
  "Linus", "Livia", "Logan", "Lola", "Lorne", "Lou", "Luca", "Lucia", "Luka", "Lyle",
  "Lyra", "Mabel", "Mack", "Maeve", "Magnus", "Maia", "Malik", "Mara", "Marco", "Margot",
  "Mateo", "Maude", "Mavis", "Maya", "Mercer", "Milo", "Mira", "Mirek", "Mona", "Moss",
  "Murray", "Nadia", "Nash", "Nell", "Neo", "Nico", "Nina", "Noa", "Noel", "Nora",
  "Nova", "Oakley", "Odessa", "Odin", "Olive", "Omar", "Oona", "Opal", "Orson", "Oscar",
  "Otis", "Otto", "Owen", "Ozzy", "Pablo", "Paloma", "Paz", "Pearl", "Pedro", "Percy",
  "Petra", "Phoebe", "Pilar", "Pip", "Piper", "Quill", "Quinn", "Rafa", "Ramona", "Raven",
  "Rex", "Rhea", "Rhys", "Rico", "Rilke", "Rio", "Rita", "River", "Roan", "Robin",
  "Roma", "Romy", "Roscoe", "Rosa", "Rowan", "Roy", "Ruby", "Rufus", "Russ", "Ruth",
  "Ryder", "Sable", "Sadie", "Saga", "Sana", "Sasha", "Saul", "Scout", "Sebastian", "Selma",
  "Senna", "Shai", "Shane", "Shiloh", "Sid", "Sigrid", "Silas", "Simone", "Sloane", "Sol",
  "Solveig", "Sonny", "Soren", "Stella", "Sten", "Sunny", "Sylvie", "Tadeo", "Talia", "Tam",
  "Tao", "Tara", "Tate", "Teddy", "Tess", "Thea", "Theo", "Tilda", "Tobin", "Tom",
  "Tomas", "Tova", "Tris", "Tron", "Truman", "Tully", "Uma", "Vada", "Val", "Vera",
  "Vero", "Vidal", "Vince", "Viola", "Vivi", "Wade", "Walker", "Wanda", "Warren", "Wells",
  "Wesley", "Whit", "Wilder", "Willa", "Winnie", "Wren", "Wyatt", "Xander", "Yara", "Yuri",
  "Zadie", "Zane", "Zara", "Zeke", "Zelda", "Zia", "Zoe", "Zuri",
] as const;

/**
 * A name for one subagent, picked off `seed` so every update about the same
 * child answers the same, with `taken` skipped so two live siblings never share.
 */
export function agentName(seed: string, taken: ReadonlySet<string> = new Set()): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (Math.imul(hash, 31) + seed.charCodeAt(i)) >>> 0;
  for (let i = 0; i < AGENT_NAMES.length; i += 1) {
    const name = AGENT_NAMES[(hash + i) % AGENT_NAMES.length];
    if (!taken.has(name)) return name;
  }
  return AGENT_NAMES[hash % AGENT_NAMES.length];
}

export type AgentStatus = "running" | "waiting" | "done" | "failed" | "stopped";

export type LiveAgent = {
  threadId: string;
  /** Absent on the root agent of a turn. */
  parentThreadId?: string;
  title: string;
  color: string;
  status: AgentStatus;
  mode: PermissionMode;
  model: string;
  /** What it is doing right now, in the user's words — "reading src/main.ts", "bash". */
  activity: string;
  prompt: string;
  /** A tool call is open right now, as opposed to the model thinking. */
  tool: boolean;
  startedAt: number;
  endedAt?: number;
  steps: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Milliseconds of model generation, so tokens per second is honest about wall time. */
  generationMs: number;
  effort?: string;
  /** Set when the loop ended badly, for the tab to show instead of a blank transcript. */
  error?: string;
};

type RunRecord = "mode" | "model" | "prompt" | "tool" | "startedAt" | "steps" | "toolCalls" | "inputTokens" | "outputTokens" | "generationMs";

export type AgentRow = Omit<LiveAgent, RunRecord> & Partial<Pick<LiveAgent, RunRecord>>;

export function tokensPerSecond(agent: Pick<LiveAgent, "outputTokens" | "generationMs">): number {
  return agent.generationMs > 0 ? agent.outputTokens / (agent.generationMs / 1000) : 0;
}

export type ThreadStep = {
  threadId: string;
  toolCallId: string;
  title: string;
  kind: string;
  toolName?: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  input?: string;
  output?: string;
  at: number;
  edit?: { path: string; added: number; removed: number; hunks?: DiffHunkLine[] };
};

/**
 * What a thread's subagents run on, as the inspector set it: an OpenRouter model ID
 * and the thinking effort to ask it for. Set on the child thread before its first
 * step, so a subagent runs its whole life on one model.
 */
export type SubagentRoute = { model: string; effort: string };

/** A pending question from the loop. Lives here because both main and the renderer name it. */
export type PermissionAsk = {
  id: string;
  threadId: string;
  tool: string;
  summary: string;
  /** The argument worth reading before approving: a command line, a path. */
  detail: string;
};

/** One file the agent rewrote, kept so the changes tab can show a diff and revert it. */
export type FileChange = {
  folderId: string;
  path: string;
  /** Null when the tool created the file. */
  before: string | null;
  after: string;
  at: number;
};

/** A command still running after the tool call that started it returned. */
export type BackgroundTask = {
  id: string;
  command: string;
  /** Name of the folder it was started in, for the sidebar row. */
  folder: string;
  status: "running" | "exited";
  /** Null while running, and for a command that never started. */
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
};

export type DiffStat = { added: number; removed: number; files: number };

/* ponytail: line-level LCS on files bounded to MAX_FILE_BYTES. A word-level diff
   reads better on prose; swap the unit if the changes tab is used for writing. */
export function diffLines(before: string, after: string): { kind: " " | "+" | "-"; text: string }[] {
  const left = before.length ? before.split("\n") : [];
  const right = after.length ? after.split("\n") : [];
  // Trim the matching head and tail first: edits are local, and this keeps the
  // quadratic table off whole-file rewrites of otherwise identical content.
  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1;
  let tail = 0;
  while (tail < left.length - head && tail < right.length - head && left[left.length - 1 - tail] === right[right.length - 1 - tail]) tail += 1;
  const a = left.slice(head, left.length - tail);
  const b = right.slice(head, right.length - tail);
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: { kind: " " | "+" | "-"; text: string }[] = left.slice(0, head).map((text) => ({ kind: " " as const, text }));
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: " ", text: a[i] }); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { out.push({ kind: "-", text: a[i] }); i += 1; }
    else { out.push({ kind: "+", text: b[j] }); j += 1; }
  }
  for (; i < a.length; i += 1) out.push({ kind: "-", text: a[i] });
  for (; j < b.length; j += 1) out.push({ kind: "+", text: b[j] });
  for (const text of left.slice(left.length - tail)) out.push({ kind: " ", text });
  return out;
}

export type DiffHunkLine = { kind: " " | "+" | "-"; text: string; line: number };

const HUNK_CONTEXT = 2;
/* ponytail: a long rewrite is cut here rather than paged — the step row shows the
   whole count, and the changes tab still has the full diff. */
const HUNK_LINES = 200;

/** Changed lines plus a little context, numbered, so a step can show its edit inline. */
export function diffHunks(before: string, after: string, context = HUNK_CONTEXT): DiffHunkLine[] {
  const lines = diffLines(before, after);
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === " ") return;
    for (let near = Math.max(0, index - context); near <= Math.min(lines.length - 1, index + context); near += 1) keep.add(near);
  });
  const out: DiffHunkLine[] = [];
  let at = 0;
  for (const [index, line] of lines.entries()) {
    if (line.kind !== "-") at += 1;
    if (keep.has(index) && out.length < HUNK_LINES) out.push({ ...line, line: line.kind === "-" ? at + 1 : at });
  }
  return out;
}

/** One write, as the step that made it reports it. */
export function editStat(change: FileChange): NonNullable<ThreadStep["edit"]> {
  const { added, removed } = diffStat([change]);
  return { path: change.path, added, removed, hunks: diffHunks(change.before ?? "", change.after) };
}

export function diffStat(changes: FileChange[]): DiffStat {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    for (const line of diffLines(change.before ?? "", change.after)) {
      if (line.kind === "+") added += 1;
      else if (line.kind === "-") removed += 1;
    }
  }
  return { added, removed, files: changes.length };
}

/** Latest write per file wins, so the tab diffs against what was there before the turn. */
export function collapseChanges(changes: FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const change of changes) {
    const key = `${change.folderId}:${change.path}`;
    const first = byPath.get(key);
    byPath.set(key, first ? { ...change, before: first.before } : change);
  }
  return [...byPath.values()].filter((change) => change.before !== change.after);
}
