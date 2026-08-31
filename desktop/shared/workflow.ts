export const MAX_WORKFLOW_NODES = 24;
export const MAX_WORKFLOW_STEPS = 32;
export const MAX_VARIABLE_CHARS = 8192;

export type WorkflowKind = "agent" | "script" | "set" | "if";

export type WorkflowNode = {
  id: string;
  kind: WorkflowKind;
  text: string;
  input?: string;
  saveAs?: string;
  next?: string;
  otherwise?: string;
};

export type WorkflowStep = { nodeId: string; kind: WorkflowKind; detail: string; output?: string };

export const END = "end";
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const VARIABLE = /^[a-z][a-z0-9_]{0,31}$/;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/;
const KINDS: WorkflowKind[] = ["agent", "script", "set", "if"];

export function parseWorkflow(nodes: string, prompt = ""): { nodes: WorkflowNode[]; errors: string[] } {
  if (!nodes.trim()) return { nodes: prompt.trim() ? [{ id: "step-1", kind: "agent", text: prompt }] : [], errors: [] };
  let value: unknown;
  try { value = JSON.parse(nodes); } catch { return { nodes: [], errors: ["The graph is not valid JSON."] }; }
  if (!Array.isArray(value)) return { nodes: [], errors: ["The graph must be a JSON array of nodes."] };
  if (!value.length) return { nodes: [], errors: ["The graph has no nodes."] };
  if (value.length > MAX_WORKFLOW_NODES) return { nodes: [], errors: [`A task cannot have more than ${MAX_WORKFLOW_NODES} nodes.`] };
  const errors: string[] = [];
  const parsed: WorkflowNode[] = [];
  for (const [index, raw] of value.entries()) {
    const at = `Node ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push(`${at} is not an object.`); continue; }
    const node = raw as Record<string, unknown>;
    const id = typeof node.id === "string" ? node.id : "";
    if (!ID.test(id)) { errors.push(`${at} needs an id of lowercase letters, digits and dashes.`); continue; }
    if (parsed.some((item) => item.id === id)) { errors.push(`${at} repeats the id "${id}".`); continue; }
    const kind = KINDS.find((candidate) => candidate === node.kind);
    if (!kind) { errors.push(`Node "${id}" needs a kind of agent, script, set or if.`); continue; }
    const text = typeof node.text === "string" ? node.text.trim() : "";
    if (!text) errors.push(`Node "${id}" needs text: a prompt, script path, value, or condition.`);
    if (text.length > MAX_VARIABLE_CHARS) errors.push(`Node "${id}" is longer than ${MAX_VARIABLE_CHARS} characters.`);
    const input = typeof node.input === "string" ? node.input : undefined;
    if (node.input !== undefined && input === undefined) errors.push(`Node "${id}" has input that is not text.`);
    if (input !== undefined && input.length > MAX_VARIABLE_CHARS) errors.push(`Node "${id}" has input longer than ${MAX_VARIABLE_CHARS} characters.`);
    if (kind === "script" && (!ABSOLUTE_PATH.test(text) || text.includes("{{"))) errors.push(`Node "${id}" needs a fixed absolute script path.`);
    if (kind !== "script" && input !== undefined) errors.push(`Node "${id}" is not a script, so it has no input.`);
    const saveAs = typeof node.saveAs === "string" ? node.saveAs : undefined;
    if (saveAs !== undefined && !VARIABLE.test(saveAs)) errors.push(`Node "${id}" saves into "${saveAs}", which is not a variable name.`);
    if (kind === "if") {
      if (saveAs) errors.push(`Node "${id}" is a branch, so it has nothing to save.`);
      if (!parseCondition(text)) errors.push(`Node "${id}" has a condition Emma cannot read: ${text}`);
    }
    if (kind === "set" && !saveAs) errors.push(`Node "${id}" sets a value but says no variable to save it in.`);
    if (kind !== "if" && node.otherwise !== undefined) errors.push(`Node "${id}" is not a branch, so it has no otherwise.`);
    parsed.push({
      id,
      kind,
      text,
      ...(input !== undefined ? { input } : {}),
      ...(saveAs ? { saveAs } : {}),
      ...(typeof node.next === "string" ? { next: node.next } : {}),
      ...(typeof node.otherwise === "string" ? { otherwise: node.otherwise } : {}),
    });
  }
  for (const node of parsed) {
    for (const [field, target] of [["next", node.next], ["otherwise", node.otherwise]] as const) {
      if (target && target !== END && !parsed.some((item) => item.id === target)) errors.push(`Node "${node.id}" points its ${field} at "${target}", which is not a node.`);
    }
  }
  return { nodes: parsed, errors };
}

export function expand(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_, name: string) => variables[name] ?? "");
}

type Condition = { left: string; operator: string; right: string };

const OPERATORS = ["is not empty", "is empty", "does not contain", "contains", "is not", "is", ">=", "<=", ">", "<"];

export function parseCondition(text: string): Condition | null {
  for (const operator of OPERATORS) {
    const pattern = /^[a-z]/.test(operator) ? new RegExp(`\\s${operator}\\s|\\s${operator}$`, "i") : new RegExp(`\\s*${operator}\\s*`);
    const match = pattern.exec(text);
    if (!match) continue;
    const left = text.slice(0, match.index).trim();
    const right = text.slice(match.index + match[0].length).trim();
    if (!left) return null;
    if (operator.endsWith("empty") ? right !== "" : right === "") return null;
    return { left, operator, right };
  }
  return null;
}

export function evaluate(text: string, variables: Record<string, string>): boolean {
  const condition = parseCondition(text);
  if (!condition) return false;
  const left = expand(condition.left, variables).trim();
  const right = expand(condition.right, variables).trim();
  const numbers = [Number(left), Number(right)];
  switch (condition.operator) {
    case "is empty": return left === "";
    case "is not empty": return left !== "";
    case "contains": return left.toLowerCase().includes(right.toLowerCase());
    case "does not contain": return !left.toLowerCase().includes(right.toLowerCase());
    case "is": return left.toLowerCase() === right.toLowerCase();
    case "is not": return left.toLowerCase() !== right.toLowerCase();
    default:
      if (numbers.some((value) => !Number.isFinite(value))) return false;
      return condition.operator === ">" ? numbers[0] > numbers[1]
        : condition.operator === "<" ? numbers[0] < numbers[1]
        : condition.operator === ">=" ? numbers[0] >= numbers[1]
        : numbers[0] <= numbers[1];
  }
}

export async function runWorkflow(
  nodes: WorkflowNode[],
  variables: Record<string, string>,
  run: (text: string, node: WorkflowNode, input: string) => Promise<string>,
): Promise<{ variables: Record<string, string>; steps: WorkflowStep[] }> {
  const state = { ...variables };
  const steps: WorkflowStep[] = [];
  let index = 0;
  while (index >= 0 && index < nodes.length && steps.length < MAX_WORKFLOW_STEPS) {
    const node = nodes[index];
    if (node.kind === "if") {
      const taken = evaluate(node.text, state);
      steps.push({ nodeId: node.id, kind: node.kind, detail: `${expand(node.text, state)} → ${taken}` });
      index = jump(nodes, taken ? node.next : node.otherwise, -1);
      continue;
    }
    const text = expand(node.text, state);
    const output = (node.kind === "agent" || node.kind === "script" ? await run(text, node, expand(node.input ?? "", state)) : text).slice(0, MAX_VARIABLE_CHARS);
    if (node.saveAs) state[node.saveAs] = output;
    if (node.kind === "agent") state.last = output;
    steps.push({ nodeId: node.id, kind: node.kind, detail: text, output });
    index = jump(nodes, node.next, index + 1);
  }
  return { variables: state, steps };
}

function jump(nodes: WorkflowNode[], target: string | undefined, fallthrough: number): number {
  if (!target) return fallthrough;
  return target === END ? -1 : nodes.findIndex((item) => item.id === target);
}

export function parseVariables(value: string): Record<string, string> {
  if (!value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, item]) => typeof item === "string").slice(0, 64)) as Record<string, string>;
  } catch {
    return {};
  }
}

export function triggerProblem(trigger: string): string | null {
  const value = trigger.trim();
  if (!value) return "A task needs a trigger.";
  if (value === "manual" || /^after [a-z0-9-]{16,96}$/.test(value) || /^on [a-z0-9-]{1,64}$/.test(value)) return null;
  if (value.split(/\s+/).length === 5) return null;
  return 'A trigger is five cron fields in UTC ("0 9 * * 1"), "manual", "after <task-id>", or "on <event>".';
}

export type WorkflowEdge = { from: string; to: string; label?: "yes" | "no" };

export function workflowEdges(nodes: WorkflowNode[]): WorkflowEdge[] {
  return nodes.flatMap((node, index) => node.kind === "if"
    ? [{ from: node.id, to: node.next ?? END, label: "yes" as const }, { from: node.id, to: node.otherwise ?? END, label: "no" as const }]
    : [{ from: node.id, to: node.next ?? nodes[index + 1]?.id ?? END }]);
}

export function workflowRows(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[][] {
  const level = new Map<string, number>();
  if (nodes.length) level.set(nodes[0].id, 0);
  for (let frontier = [nodes[0]?.id].filter(Boolean) as string[], depth = 0; frontier.length && depth < nodes.length; depth += 1) {
    const next: string[] = [];
    for (const from of frontier) {
      for (const edge of edges.filter((item) => item.from === from && item.to !== END)) {
        if (level.has(edge.to)) continue;
        level.set(edge.to, depth + 1);
        next.push(edge.to);
      }
    }
    frontier = next;
  }
  const orphans = nodes.filter((node) => !level.has(node.id));
  const depth = Math.max(-1, ...level.values());
  for (const node of orphans) level.set(node.id, depth + 1);
  const rows: string[][] = [];
  for (const node of nodes) {
    const row = level.get(node.id) ?? 0;
    (rows[row] ??= []).push(node.id);
  }
  return rows.map((row) => row ?? []);
}

export type TriggerKind = "minutes" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "manual" | "cron";

export type Trigger = {
  kind: TriggerKind;
  every: number;
  minute: number;
  hour: number;
  weekdays: number[];
  day: number;
  month: number;
  cron: string;
};

export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const DEFAULT_TRIGGER: Trigger = { kind: "daily", every: 1, minute: 0, hour: 9, weekdays: [1], day: 1, month: 1, cron: "0 9 * * *" };

const whole = (value: string, min: number, max: number): number | null => {
  const parsed = Number(value);
  return /^\d+$/.test(value) && parsed >= min && parsed <= max ? parsed : null;
};
const stepOf = (field: string): number | null => field === "*" ? 1 : /^\*\/\d+$/.test(field) ? Number(field.slice(2)) || null : null;
const step = (count: number) => count > 1 ? `*/${count}` : "*";
const two = (value: number) => String(value).padStart(2, "0");

export function buildTrigger(trigger: Trigger): string {
  const every = Math.max(1, Math.round(trigger.every) || 1);
  const minute = Math.min(59, Math.max(0, Math.round(trigger.minute) || 0));
  const hour = Math.min(23, Math.max(0, Math.round(trigger.hour) || 0));
  const day = Math.min(31, Math.max(1, Math.round(trigger.day) || 1));
  switch (trigger.kind) {
    case "manual": return "manual";
    case "cron": return trigger.cron.trim();
    case "minutes": return `${step(every)} * * * *`;
    case "hourly": return `${minute} ${step(every)} * * *`;
    case "daily": return `${minute} ${hour} ${step(every)} * *`;
    case "weekly": return `${minute} ${hour} * * ${trigger.weekdays.length ? [...new Set(trigger.weekdays)].sort((left, right) => left - right).join(",") : "*"}`;
    case "monthly": return `${minute} ${hour} ${day} * *`;
    case "yearly": return `${minute} ${hour} ${day} ${Math.min(12, Math.max(1, Math.round(trigger.month) || 1))} *`;
  }
}

export function parseTrigger(value: string): Trigger {
  const text = value.trim();
  const raw = { ...DEFAULT_TRIGGER, cron: text };
  if (text === "manual") return { ...raw, kind: "manual" };
  const fields = text.split(/\s+/);
  if (fields.length !== 5) return { ...raw, kind: "cron" };
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
  const minute = whole(minuteField, 0, 59);
  const hour = whole(hourField, 0, 23);
  const day = whole(dayField, 1, 31);
  const month = whole(monthField, 1, 12);
  const anyDay = dayField === "*" && monthField === "*" && weekdayField === "*";
  const minuteStep = stepOf(minuteField);
  if (minuteStep !== null && hourField === "*" && anyDay) return { ...raw, kind: "minutes", every: minuteStep };
  if (minute === null) return { ...raw, kind: "cron" };
  const hourStep = stepOf(hourField);
  if (hourStep !== null && anyDay) return { ...raw, kind: "hourly", every: hourStep, minute };
  if (hour === null) return { ...raw, kind: "cron" };
  const dayStep = stepOf(dayField);
  if (dayStep !== null && monthField === "*" && weekdayField === "*") return { ...raw, kind: "daily", every: dayStep, minute, hour };
  if (dayField === "*" && monthField === "*" && /^[0-7](,[0-7])*$/.test(weekdayField)) {
    const weekdays = [...new Set(weekdayField.split(",").map((item) => Number(item) % 7))].sort((left, right) => left - right);
    return { ...raw, kind: "weekly", minute, hour, weekdays };
  }
  if (day !== null && monthField === "*" && weekdayField === "*") return { ...raw, kind: "monthly", minute, hour, day };
  if (day !== null && month !== null && weekdayField === "*") return { ...raw, kind: "yearly", minute, hour, day, month };
  return { ...raw, kind: "cron" };
}

export function describeTrigger(value: string): string {
  const text = value.trim();
  if (text === "manual") return "Only when you run it";
  if (text.startsWith("after ")) return `After the task ${text.slice(6).trim()} finishes`;
  if (text.startsWith("on ")) return `On the "${text.slice(3).trim()}" event`;
  const trigger = parseTrigger(text);
  const at = `${two(trigger.hour)}:${two(trigger.minute)} UTC`;
  const plural = (count: number, unit: string) => count === 1 ? unit : `${count} ${unit}s`;
  switch (trigger.kind) {
    case "minutes": return `Every ${plural(trigger.every, "minute")}`;
    case "hourly": return `Every ${plural(trigger.every, "hour")} at :${two(trigger.minute)}`;
    case "daily": return trigger.every === 1 ? `Every day at ${at}` : `Every ${trigger.every} days at ${at}`;
    case "weekly": return `${trigger.weekdays.length ? trigger.weekdays.map((day) => WEEKDAY_NAMES[day]).join(", ") : "Every day"} at ${at}`;
    case "monthly": return `Day ${trigger.day} of every month at ${at}`;
    case "yearly": return `Every ${trigger.day} ${MONTH_NAMES[trigger.month - 1]} at ${at}`;
    default: return text;
  }
}

export const MAX_VARIABLES_BYTES = 16 * 1024;

export function packVariables(variables: Record<string, string>): string {
  const kept = { ...variables };
  let json = JSON.stringify(kept);
  const size = (value: string) => new TextEncoder().encode(value).length;
  while (size(json) > MAX_VARIABLES_BYTES) {
    const [name, value] = Object.entries(kept).sort((left, right) => right[1].length - left[1].length)[0] ?? [];
    if (!name || !value) return "{}";
    kept[name] = value.slice(0, Math.floor(value.length / 2));
    json = JSON.stringify(kept);
  }
  return json;
}

export function describeRun(steps: WorkflowStep[]): string {
  if (!steps.length) return "The task has no steps to run.";
  return steps.map((step) => `${step.nodeId} · ${step.kind} · ${(step.output ?? step.detail).replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
}
