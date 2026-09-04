import { decodeSpans, encodeSpans, traceHeader, type TraceSpan } from "./trace";
import { familiesOf, familyLabel, normalizeModel, promptScopeValid, scopeApplies } from "./prompts";
import { defaultHarnessExperiments, validateHarnessExperiments, type HarnessExperiments } from "./settings";

export type Lever = "instructions" | "verifier" | "prompt" | "tools" | "advertise" | "knobs";
export type Metric = "failures" | "blocks" | "steps" | "requests" | "tokens" | "cost" | "ms";
export type Arm = "a" | "b";

export const leverNames: Record<Lever, string> = {
  instructions: "Standing instructions",
  verifier: "Auto verifier rules",
  prompt: "System prompt",
  tools: "Tool descriptions",
  advertise: "Tools offered up front",
  knobs: "Harness knobs",
};

export const levers = Object.keys(leverNames) as Lever[];

export const KNOB_FIELDS = (Object.keys(defaultHarnessExperiments) as (keyof HarnessExperiments)[])
  .filter((field) => typeof defaultHarnessExperiments[field] === "number");

export const metricNames: Record<Metric, string> = {
  failures: "failed tool calls per turn",
  blocks: "verifier blocks per turn",
  steps: "tool calls per turn",
  requests: "model requests per turn",
  tokens: "tokens per turn",
  cost: "micro USD per turn",
  ms: "milliseconds per turn",
};

export type Improvement = {
  id: string;
  title: string;
  lever: Lever;
  addition: string;
  scope?: string;
  metric: Metric;
  startedAt: number;
  look: number;
  state: "trial" | "kept" | "reverted";
  decidedAt?: number;
  result?: string;
  origin?: string;
};

export const MAX_KEPT = 12;
export const MAX_IMPROVEMENTS = 40;
export const MAX_ADDITION_CHARS = 1024;
export const MAX_RESULT_CHARS = 1024;
export const MIN_ARM_TURNS = 6;

export type Improvements = { items: Improvement[] };

export function toolHintsOf(addition: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(addition);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const rows = Object.entries(value as Record<string, unknown>);
    if (!rows.length || rows.some(([name, hint]) => !name.trim() || typeof hint !== "string" || !hint.trim())) return {};
    return Object.fromEntries(rows) as Record<string, string>;
  } catch { return {}; }
}

export const preselectOf = (addition: string): string[] =>
  [...new Set(addition.split(",").map((name) => name.trim()).filter(Boolean))];

export function knobOf(addition: string): Partial<HarnessExperiments> {
  const found = /^\s*([A-Za-z]+)\s*=\s*(-?\d+)\s*$/.exec(addition);
  if (!found || !KNOB_FIELDS.includes(found[1] as keyof HarnessExperiments)) return {};
  const patch = { [found[1]]: Number(found[2]) } as Partial<HarnessExperiments>;
  try { validateHarnessExperiments(patch); } catch { return {}; }
  return patch;
}

export function additionValid(lever: Lever, addition: string, scope = ""): boolean {
  if (!addition.trim() || !promptScopeValid(scope)) return false;
  if (lever === "tools") return Object.keys(toolHintsOf(addition)).length > 0;
  if (lever === "advertise") return preselectOf(addition).length > 0;
  if (lever === "knobs") return Object.keys(knobOf(addition)).length > 0;
  return true;
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value : "").slice(0, max);

const record = (value: unknown): string => {
  const line = typeof value === "string" ? value : "";
  if (line.length <= MAX_RESULT_CHARS) return line;
  const cut = line.slice(0, MAX_RESULT_CHARS + 1);
  return cut.slice(0, Math.max(0, cut.lastIndexOf(" ")));
};

const disposable = (items: readonly Improvement[]): Improvement[] => {
  const cited = new Set(items.filter((item) => item.state !== "reverted").map(lineageOf));
  return items.filter((item) => item.state === "reverted" && !cited.has(lineageOf(item)));
};

export function pruned(items: readonly Improvement[]): Improvement[] {
  const over = items.length - MAX_IMPROVEMENTS;
  if (over <= 0) return [...items];
  const gone = new Set(disposable(items).slice(0, over).map((item) => item.id));
  return items.filter((item) => !gone.has(item.id));
}

export const room = (items: readonly Improvement[]): number => MAX_IMPROVEMENTS - items.length + disposable(items).length;

export function validateImprovements(value: unknown): Improvements {
  const raw = (value && typeof value === "object" ? (value as { items?: unknown }).items : undefined) ?? [];
  if (!Array.isArray(raw)) return { items: [] };
  const items = raw.flatMap((entry): Improvement[] => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const lever: Lever = typeof item.lever === "string" && Object.hasOwn(leverNames, item.lever) ? item.lever as Lever : "instructions";
    const metric: Metric = typeof item.metric === "string" && Object.hasOwn(metricNames, item.metric) ? item.metric as Metric : "failures";
    const state = item.state === "kept" ? "kept" : item.state === "reverted" ? "reverted" : "trial";
    const addition = text(item.addition, MAX_ADDITION_CHARS).trim();
    if (item.scope !== undefined && typeof item.scope !== "string") return [];
    const scope = typeof item.scope === "string" ? item.scope.trim() : "";
    const id = text(item.id, 64);
    const origin = text(item.origin, 64);
    const again = !!origin && origin !== id;
    if (!id || !additionValid(lever, addition, scope)) return [];
    return [{
      id,
      title: text(item.title, 200) || "Untitled change",
      lever,
      addition,
      ...(scope ? { scope } : {}),
      metric,
      startedAt: Number(item.startedAt) || 0,
      look: again ? Math.max(2, Math.round(Number(item.look)) || 0) : 1,
      state,
      ...(Number(item.decidedAt) ? { decidedAt: Number(item.decidedAt) } : {}),
      ...(record(item.result) ? { result: record(item.result) } : {}),
      ...(again ? { origin } : {}),
    }];
  });
  return { items: pruned(items) };
}

export type AppliedImprovements = {
  kept: {
    instructions: string;
    verifier: string;
    prompts: { body: string; scope: string }[];
    toolHints: Record<string, string>;
    preselect: string[];
    knobs: Partial<HarnessExperiments>;
  };
  trial?: { lever: Lever; addition: string; scope?: string }[];
};

export const keptNothing = (): AppliedImprovements["kept"] =>
  ({ instructions: "", verifier: "", prompts: [], toolHints: {}, preselect: [], knobs: {} });

export function lessonBlock(additions: readonly string[]): string {
  const lines = additions.map((item) => item.trim()).filter(Boolean).slice(0, MAX_KEPT);
  if (!lines.length) return "";
  return ["What Emma has learned from its own past runs, and applies unless the user says otherwise:", ...lines.map((line) => `- ${line}`)].join("\n");
}

export function heldBack(items: readonly Improvement[]): string[] {
  const superseded = new Set(items.filter((item) => item.state === "trial").map(lineageOf));
  return levers.flatMap((lever) => {
    const rows = items.filter((item) => item.state === "kept" && item.lever === lever);
    const riding = new Set(rows.filter((item) => !superseded.has(lineageOf(item))).slice(0, MAX_KEPT).map((item) => item.id));
    return rows.filter((item) => !riding.has(item.id)).map((item) => item.id);
  });
}

export function applied(store: Improvements, model = ""): AppliedImprovements {
  const items = store.items.filter((item) => scopeApplies(item.scope ?? "", model))
    .sort((a, b) => Number(!!a.scope) + Number(!!a.scope?.startsWith("model:")) - Number(!!b.scope) - Number(!!b.scope?.startsWith("model:")));
  const trial = items.filter((item) => item.state === "trial");
  const held = new Set(heldBack(items));
  const riding = (lever: Lever) => items.filter((item) => item.state === "kept" && item.lever === lever && !held.has(item.id));
  const kept = keptNothing();
  kept.instructions = lessonBlock(riding("instructions").map((item) => item.addition));
  kept.verifier = lessonBlock(riding("verifier").map((item) => item.addition));
  kept.prompts = riding("prompt").map((item) => ({ body: item.addition, scope: item.scope ?? "" }));
  for (const item of riding("tools")) Object.assign(kept.toolHints, toolHintsOf(item.addition));
  kept.preselect = [...new Set(riding("advertise").flatMap((item) => preselectOf(item.addition)))];
  for (const item of riding("knobs")) Object.assign(kept.knobs, knobOf(item.addition));
  return { kept, ...(trial.length ? { trial: trial.map((item) => ({ lever: item.lever, addition: item.addition, ...(item.scope ? { scope: item.scope } : {}) })) } : {}) };
}

export type Turn = {
  threadId: string;
  thread: string;
  at: number;
  arm: Arm | "";
  model: string;
  family: string;
  failures: number;
  blocks: number;
  steps: number;
  requests: number;
  tokens: number;
  out: number;
  cost: number;
  ms: number;
  discovery: number;
  ok: boolean;
  spans: TraceSpan[];
  context: Record<string, string>;
  trials?: string[];
};

const counted = (header: Record<string, string>, key: string): number => Math.max(0, Math.round(Number(header[key]) || 0));

const isCall = (span: TraceSpan) => span.kind !== "agent" && span.kind !== "model";
const isVerifier = (span: TraceSpan) => span.kind === "verifier";

export function readTurn(trace: { timestamp: string; text: string }, thread: { id: string; title: string }): Turn {
  const spans = decodeSpans(trace.text);
  const header = traceHeader(trace.text);
  const at = Date.parse(trace.timestamp);
  const calls = spans.filter(isCall);
  const model = normalizeModel(header.model ?? "");
  return {
    threadId: thread.id,
    thread: thread.title,
    at: Number.isNaN(at) ? 0 : at,
    arm: header.arm === "a" || header.arm === "b" ? header.arm : "",
    model: model === "unknown" ? "" : model,
    family: familiesOf(model)[0] ?? header.family ?? "",
    failures: calls.filter((span) => !isVerifier(span) && span.status === "failed").length,
    blocks: calls.filter((span) => isVerifier(span) && span.status === "failed").length,
    steps: calls.filter((span) => !isVerifier(span)).length,
    requests: counted(header, "requests"),
    tokens: counted(header, "in") + counted(header, "out"),
    out: counted(header, "out"),
    cost: counted(header, "cost"),
    ms: counted(header, "ms"),
    discovery: counted(header, "discovery"),
    ok: !spans.some((span) => span.kind === "agent" && span.status === "failed"),
    spans,
    context: Object.fromEntries(["systemPrompt", "skillContext", "configuration", "changes"].flatMap((key) => header[key] ? [[key, header[key]]] : [])),
    ...(header.trials !== undefined ? { trials: header.trials.split(",").filter(Boolean) } : {}),
  };
}

export function readTurns(trace: { timestamp: string; text: string }, thread: { id: string; title: string }): Turn[] {
  const spans = decodeSpans(trace.text);
  const header = traceHeader(trace.text);
  const agents = spans.filter((span) => span.kind === "agent");
  if (!agents.length) return [readTurn(trace, thread)];
  const byId = new Map(spans.map((span) => [span.id, span]));
  const owner = (span: TraceSpan) => {
    const seen = new Set<string>();
    let at: TraceSpan | undefined = span;
    while (at && at.kind !== "agent" && !seen.has(at.id)) {
      seen.add(at.id);
      at = byId.get(at.parentId ?? "");
    }
    return at?.kind === "agent" ? at.id : agents[0].id;
  };
  const owners = new Map(spans.map((span) => [span.id, owner(span)]));
  return agents.map((agent, index) => {
    const own = spans.filter((span) => owners.get(span.id) === agent.id);
    const fields = index === 0 ? header : agent.context ?? {};
    return readTurn({
      timestamp: trace.timestamp,
      text: encodeSpans(own, { ...fields, model: fields.model ?? agent.model ?? "", requests: String(own.filter((span) => span.kind === "model").length) }),
    }, { id: fields.thread || (agent.id.startsWith("agent:") ? agent.id.slice(6) : thread.id), title: index === 0 ? thread.title : `${thread.title} · ${agent.name}` });
  });
}

export const sampleOf = (turn: Turn, metric: Metric): number => turn[metric];

export function distinctTurns(turns: readonly Turn[]): Turn[] {
  const found = new Map<string, Turn>();
  for (const turn of turns) {
    const agent = turn.spans.find((span) => span.kind === "agent");
    const key = JSON.stringify([turn.threadId, agent?.startedAt ?? turn.at]);
    const previous = found.get(key);
    if (!previous || previous.at <= turn.at) found.set(key, turn);
  }
  return [...found.values()];
}

export type Friction = {
  key: string;
  kind: "tool" | "verifier";
  tool: string;
  hits: number;
  turns: number;
  unfixable: number;
  lastAt: number;
  scope?: string;
  models: { model: string; hits: number; turns: number }[];
  evidence: { at: number; thread: string; threadId: string; text: string; model: string }[];
};

export const turnsInScope = (turns: readonly Turn[], scope: string): Turn[] =>
  turns.filter((turn) => scope === "unknown" ? !turn.model : scopeApplies(scope, turn.model));

export function scopeOfModels(models: readonly string[]): string {
  if (!models.length || models.some((model) => !model)) return "";
  const unique = [...new Set(models)];
  if (unique.length === 1) return `model:${unique[0]}`;
  const family = familiesOf(unique[0]).find((id) => unique.every((model) => familiesOf(model).includes(id)));
  return family ? `family:${family}` : "";
}

export const lessonShaped = (item: Friction): boolean => item.unfixable * 2 < item.hits;

const MAX_EVIDENCE = 4;
const MAX_EVIDENCE_CHARS = 220;
export const MIN_FRICTION_TURNS = 2;

const clamp = (value: string) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_EVIDENCE_CHARS ? `${flat.slice(0, MAX_EVIDENCE_CHARS)}…` : flat;
};

const CATEGORIES = new Set(["read", "search", "edit", "execute", "delete", "move", "fetch", "other", "tool", ""]);

export function toolOf(span: TraceSpan): string {
  if (span.tool) return span.tool;
  const output = span.output ?? "";
  const named = /"tool_name"\s*:\s*"([^"]{1,40})"/.exec(output)?.[1]
    ?? /Permission target resolution failed for ([a-z_]{2,40})/.exec(output)?.[1]
    ?? /^([a-z_]{2,40}) (?:arguments|requires|failed|pattern|call|field)/.exec(output)?.[1];
  if (named) return named;
  if (!CATEGORIES.has(span.kind)) return span.kind;
  if (/^[a-z][a-z0-9_]*$/.test(span.name)) return span.name;
  if (/"action"\s*:\s*"exec"/.test(span.input ?? "")) return "terminal";
  return span.kind || "tool";
}

export function unfixable(span: TraceSpan): boolean {
  return /tool_permission_denied|"reason"\s*:\s*"user_denied"|non-zero status|^Cancelled:/.test(span.output ?? "");
}

export function reviewedTool(input: string | undefined): string {
  return /^Proposed action:[ \t]*(.+)$/m.exec(input ?? "")?.[1].trim().slice(0, 64) || "a call";
}

export function blockReason(output: string | undefined): string {
  const found = /"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(output ?? "");
  return clamp(found ? found[1].replace(/\\"/g, '"') : (output ?? ""));
}

export function frictionOf(turns: readonly Turn[], scope = ""): Friction[] {
  const found = new Map<string, Friction>();
  const counted = new Map<string, Set<Turn>>();
  const add = (kind: Friction["kind"], tool: string, turn: Turn, detail: string, noLesson = false) => {
    const key = `${kind}:${tool}`;
    const item = found.get(key) ?? { key, kind, tool, hits: 0, turns: 0, unfixable: 0, lastAt: 0, evidence: [], models: [] };
    const seen = counted.get(key) ?? new Set<Turn>();
    counted.set(key, seen);
    item.hits += 1;
    if (noLesson) item.unfixable += 1;
    const model = item.models.find((row) => row.model === turn.model) ?? { model: turn.model, hits: 0, turns: 0 };
    if (!item.models.includes(model)) item.models.push(model);
    model.hits += 1;
    if (!seen.has(turn)) { seen.add(turn); item.turns += 1; model.turns += 1; }
    item.lastAt = Math.max(item.lastAt, turn.at);
    if (detail && item.evidence.length < MAX_EVIDENCE) item.evidence.push({ at: turn.at, thread: turn.thread, threadId: turn.threadId, text: detail, model: turn.model });
    found.set(key, item);
  };
  for (const turn of turnsInScope(turns, scope).sort((left, right) => right.at - left.at)) {
    for (const span of turn.spans) {
      if (!isCall(span) || span.status !== "failed") continue;
      if (isVerifier(span)) add("verifier", reviewedTool(span.input), turn, blockReason(span.output));
      else add("tool", toolOf(span), turn, clamp(span.output ?? ""), unfixable(span));
    }
  }
  return [...found.values()]
    .filter((item) => item.turns >= MIN_FRICTION_TURNS)
    .map((item) => ({ ...item, scope: scope && scope !== "unknown" ? scope : scopeOfModels(item.models.map((row) => row.model)) }))
    .sort((left, right) => right.turns - left.turns || right.hits - left.hits || right.lastAt - left.lastAt);
}

export type Spend = {
  key: string;
  kind: "tool" | "family" | "discovery";
  name: string;
  tokens: number;
  turns: number;
  calls: number;
  requests: number;
  cost: number;
  steps: number;
  picked: string[];
};

const DISCOVERY_TOOLS = new Set(["search_tools", "select_tool", "mcp_search_tools", "mcp_select_tool"]);
const MAX_PICKED = 4;

export const selectedTool = (input: string | undefined): string =>
  /"name"\s*:\s*"([a-z][a-z0-9_]{0,63})"/.exec(input ?? "")?.[1] ?? "";

export function spendOf(turns: readonly Turn[]): Spend[] {
  const tools = new Map<string, { tokens: number; calls: number; turns: Set<Turn> }>();
  const families = new Map<string, { tokens: number; requests: number; cost: number; turns: number }>();
  const picked = new Map<string, number>();
  let steps = 0;
  let discoveryTurns = 0;
  let discoveryTokens = 0;
  for (const turn of turns) {
    if (turn.family) {
      const row = families.get(turn.family) ?? { tokens: 0, requests: 0, cost: 0, turns: 0 };
      row.tokens += turn.tokens;
      row.requests += turn.requests;
      row.cost += turn.cost;
      row.turns += 1;
      families.set(turn.family, row);
    }
    if (turn.discovery > 0) {
      discoveryTurns += 1;
      steps += turn.discovery;
    }
    for (const span of turn.spans) {
      if (!isCall(span) || isVerifier(span)) continue;
      const name = toolOf(span);
      const row = tools.get(name) ?? { tokens: 0, calls: 0, turns: new Set<Turn>() };
      row.tokens += span.tokens ?? 0;
      row.calls += 1;
      row.turns.add(turn);
      tools.set(name, row);
      if (!DISCOVERY_TOOLS.has(span.name)) continue;
      discoveryTokens += span.tokens ?? 0;
      const chosen = selectedTool(span.input);
      if (chosen) picked.set(chosen, (picked.get(chosen) ?? 0) + 1);
    }
  }
  const rows: Spend[] = [
    ...[...tools].filter(([, row]) => row.tokens > 0).map(([name, row]) => ({
      key: `tool:${name}`, kind: "tool" as const, name, tokens: row.tokens, turns: row.turns.size,
      calls: row.calls, requests: 0, cost: 0, steps: 0, picked: [],
    })),
    ...[...families].map(([name, row]) => ({
      key: `family:${name}`, kind: "family" as const, name, tokens: row.tokens / row.turns, turns: row.turns,
      calls: 0, requests: row.requests / row.turns, cost: row.cost / row.turns, steps: 0, picked: [],
    })),
  ];
  if (discoveryTurns) rows.push({
    key: "discovery", kind: "discovery", name: "discovery", tokens: discoveryTokens, turns: discoveryTurns,
    calls: 0, requests: 0, cost: 0, steps: steps / discoveryTurns,
    picked: [...picked].sort((left, right) => right[1] - left[1]).slice(0, MAX_PICKED).map(([name]) => name),
  });
  return rows.sort((left, right) => right.tokens - left.tokens);
}

export type Draft = Pick<Improvement, "title" | "lever" | "metric" | "addition" | "scope" | "look" | "origin">;

const ARGUMENT_SHAPED = /must match the advertised|arguments must be|must be a bare JSON|Invalid arguments/;

const misshapen = (friction: Friction): boolean =>
  friction.evidence.filter((line) => ARGUMENT_SHAPED.test(line.text)).length * 2 > friction.evidence.length;

const round = (value: number) => Math.round(value * 10) / 10;

export function draftProposal(item: Friction): Draft;
export function draftProposal(item: Spend): Draft | null;
export function draftProposal(item: Friction | Spend): Draft | null {
  if (item.kind === "discovery") {
    return {
      title: `Emma spends ${round(item.steps)} steps a turn looking for its own tools`,
      lever: "advertise",
      metric: "requests",
      look: 1,
      addition: item.picked.join(", "),
    };
  }
  if (item.kind === "family") {
    return {
      title: `${familyLabel(item.name)} turns cost ${Math.round(item.tokens)} tokens`,
      lever: "prompt",
      metric: "tokens",
      scope: `family:${item.name}`,
      look: 1,
      addition: `Turns on ${familyLabel(item.name)} average ${Math.round(item.tokens)} tokens over ${round(item.requests)} requests. Say here what this family should do differently to spend fewer: `,
    };
  }
  if (!("evidence" in item)) return null;
  const friction = item;
  const scope = friction.scope ? { scope: friction.scope } : {};
  const worst = friction.evidence[0]?.text ?? "";
  if (friction.kind === "verifier") {
    return {
      title: `The auto verifier keeps blocking ${friction.tool}`,
      lever: "verifier",
      ...scope,
      metric: "blocks",
      look: 1,
      addition: `${friction.tool} was blocked in ${friction.turns} turns. It said: “${worst}”. Clear this when it is what the user asked for — say here exactly which case is allowed, and what still is not.`,
    };
  }
  if (misshapen(friction)) {
    return {
      title: `${friction.tool} keeps being called with the wrong arguments`,
      lever: "tools",
      ...scope,
      metric: "failures",
      look: 1,
      addition: JSON.stringify({ [friction.tool]: "" }),
    };
  }
  return {
    title: `${friction.tool} keeps failing`,
    lever: "instructions",
    ...scope,
    metric: "failures",
    look: 1,
    addition: `${friction.tool} failed in ${friction.turns} turns, most recently with “${worst}”. When that happens, do this instead of trying the same call again: `,
  };
}

export const lineageOf = (item: Improvement): string => item.origin || item.id;

export function attemptIds(items: readonly Improvement[], improvementId: string): string[] {
  const of = items.find((row) => row.id === improvementId);
  if (!of) return improvementId ? [improvementId] : [];
  return items
    .filter((row) => lineageOf(row) === lineageOf(of))
    .sort((left, right) => left.startedAt - right.startedAt)
    .map((row) => row.id);
}

export const retryDraft = (item: Improvement): Draft =>
  ({ title: item.title, lever: item.lever, metric: item.metric, addition: item.addition, ...(item.scope ? { scope: item.scope } : {}), look: item.look + 1, origin: lineageOf(item) });

export type Stat = { n: number; mean: number; sd: number };

export function stat(values: readonly number[]): Stat {
  const n = values.length;
  if (!n) return { n: 0, mean: 0, sd: 0 };
  const mean = values.reduce((total, value) => total + value, 0) / n;
  const sd = n < 2 ? 0 : Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1));
  return { n, mean, sd };
}

export type Comparison = {
  a: Stat;
  b: Stat;
  delta: number | null;
  clear: boolean;
  waiting: string;
};

export function compare(turns: readonly Turn[], trial: Improvement): Comparison {
  const eligible = turnsInScope(turns, trial.scope ?? "");
  const samples = (arm: Arm) => eligible.filter((turn) => turn.arm === arm && turn.at >= trial.startedAt && (!turn.trials || turn.trials.includes(trial.id))).map((turn) => sampleOf(turn, trial.metric));
  const a = stat(samples("a"));
  const b = stat(samples("b"));
  const delta = a.n && b.n && a.mean !== 0 ? ((b.mean - a.mean) / Math.abs(a.mean)) * 100 : null;
  const error = 2 * Math.sqrt((a.n ? a.sd ** 2 / a.n : 0) + (b.n ? b.sd ** 2 / b.n : 0));
  const enough = a.n >= MIN_ARM_TURNS && b.n >= MIN_ARM_TURNS;
  const clear = enough && Math.abs(b.mean - a.mean) > error && (error > 0 || b.mean !== a.mean);
  const short = Math.max(0, MIN_ARM_TURNS - Math.min(a.n, b.n));
  return { a, b, delta, clear, waiting: enough ? "" : `${short} more ${short === 1 ? "turn" : "turns"} needed on the thinner arm` };
}

export function startTrial(items: readonly Improvement[], draft: Draft, at: number): Improvement[] {
  const addition = draft.addition.trim();
  const scope = (draft.scope ?? "").trim();
  if (!additionValid(draft.lever, addition, scope) || room(items) <= 0 || items.some((row) => row.state === "trial" && row.lever === draft.lever)) return [...items];
  const taken = new Set(items.map((row) => row.id));
  let id = `imp-${at.toString(36)}`;
  for (let next = 2; taken.has(id); next += 1) id = `imp-${at.toString(36)}-${next}`;
  return [...items, { id, title: draft.title, lever: draft.lever, addition, ...(scope ? { scope } : {}), metric: draft.metric, startedAt: at, look: draft.look, state: "trial", ...(draft.origin && draft.origin !== id ? { origin: draft.origin } : {}) }];
}

export function revertLine(comparison: Comparison): string {
  const change = comparison.delta === null ? "no comparable turns" : `${comparison.delta > 0 ? "+" : ""}${comparison.delta.toFixed(0)}%`;
  return `Reverted at ${comparison.a.n}/${comparison.b.n} turns · ${change}${comparison.clear ? "" : " · within the noise"}`;
}
