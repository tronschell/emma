import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BoundedLines } from "./ndjson";
export type { PermissionAsk } from "../shared/agents";
import type { PermissionAsk, ThreadStep } from "../shared/agents";
import type { PermissionMode } from "../shared/permissions";
import type { RunnableHookEvent } from "../shared/plugins";
import { MAX_LOG_BODY, type HarnessFlow, type HarnessLogLine, type HarnessState } from "../shared/harness-log";
import type { HarnessExperiments } from "../shared/settings";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const PROTOCOL_VERSION = 1;

const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

export const MAX_IDLE_MS = 30 * 60 * 1000;
const MAX_STDERR_TAIL = 4 * 1024;

export type StopReason = "end_turn" | "cancelled" | "refused" | "max_output_tokens" | "max_model_turns";

export const failedTurn = (reason: StopReason) => reason === "refused";

export type TurnUsage = { inputTokens: number; outputTokens: number };

const mediaType =(file: string) => `image/${path.extname(file).slice(1).toLowerCase().replace("jpg", "jpeg")}`;

export type TurnExtras = { skillContext?: string; contextWindow?: number; effort?: ThinkingRoute; experiments?: HarnessExperiments; compact?: boolean; images?: string[]; continueRecovery?: boolean };

export type ThinkingRoute = { level: string; published: string[] };

export const effortOption = ({ level, published }: ThinkingRoute) => `${level || "auto"};${published.join(",")}`;

export const experimentOption = (experiments: HarnessExperiments) =>
  [
    `reinject_steps=${experiments.reinjectPromptSteps}`,
    `reinject_percent=${experiments.reinjectPromptPercent}`,
    `prune_steps=${experiments.pruneToolsSteps}`,
    `prune_percent=${experiments.pruneToolsPercent}`,
  ].join(",");

export type HarnessMcpServer = { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };

const wireLabel = (message: Record<string, unknown>) => {
  const id = typeof message.id === "number" ? `#${message.id}` : "";
  if (typeof message.method === "string") return [message.method, id].filter(Boolean).join(" ");
  return [message.error ? "error" : "result", id].filter(Boolean).join(" ") || "message";
};

const streamedChunk = (message: Record<string, unknown>) => {
  if (message.method !== "session/update") return false;
  const update = (message.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update;
  return typeof update?.sessionUpdate === "string" && update.sessionUpdate.endsWith("_chunk");
};

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

export type HarnessToolCall = ThreadStep;

export type ContextExperimentFired = { prunedResults: number; reinjected: boolean; savedTokens: number; addedTokens: number };

export function contextExperimentFired(update: Record<string, unknown>): ContextExperimentFired | undefined {
  const fired = (update._meta as { fx?: { contextExperiment?: unknown } } | undefined)?.fx?.contextExperiment as
    { prunedResults?: unknown; reinjected?: unknown; savedTokens?: unknown; addedTokens?: unknown } | undefined;
  if (!fired || typeof fired !== "object") return undefined;
  const pruned = count(fired.prunedResults);
  const reinjected = fired.reinjected === true;

  return pruned || reinjected
    ? { prunedResults: pruned, reinjected, savedTokens: count(fired.savedTokens), addedTokens: count(fired.addedTokens) }
    : undefined;
}

export type RoutedModel = { model: string; fellBack: boolean };

export function routedModelReported(update: Record<string, unknown>): RoutedModel | undefined {
  const routed = (update._meta as { fx?: { routedModel?: unknown } } | undefined)?.fx?.routedModel as
    { model?: unknown; fellBack?: unknown } | undefined;
  if (!routed || typeof routed !== "object" || typeof routed.model !== "string" || !routed.model) return undefined;
  return { model: routed.model.slice(0, 256), fellBack: routed.fellBack === true };
}

export type ContextBreakdown ={ systemPromptBytes: number; systemToolsBytes: number; mcpToolsBytes: number; skillsBytes: number; memoryBytes: number };

export function contextBreakdownReported(update: Record<string, unknown>): ContextBreakdown | undefined {
  const parts = (update._meta as { fx?: { contextBreakdown?: unknown } } | undefined)?.fx?.contextBreakdown as
    { systemPromptBytes?: unknown; systemToolsBytes?: unknown; mcpToolsBytes?: unknown; skillsBytes?: unknown; memoryBytes?: unknown } | undefined;
  if (!parts || typeof parts !== "object") return undefined;
  return {
    systemPromptBytes: count(parts.systemPromptBytes),
    systemToolsBytes: count(parts.systemToolsBytes),
    mcpToolsBytes: count(parts.mcpToolsBytes),
    skillsBytes: count(parts.skillsBytes),
    memoryBytes: count(parts.memoryBytes),
  };
}

export function turnUsageReported(update: Record<string, unknown>): TurnUsage | undefined {
  const usage = (update._meta as { fx?: { turnUsage?: unknown } } | undefined)?.fx?.turnUsage as
    { inputTokens?: unknown; outputTokens?: unknown } | undefined;
  if (!usage || typeof usage !== "object") return undefined;
  return { inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens) };
}

export type HarnessDeps = {
  binaryPath: string;

  args?: string[];

  home: string;

  cwd: string;
  apiKey?: string;
  chatUrl?: string;

  idleMs?: number;

  mcpServers: (threadId: string) => Promise<HarnessMcpServer[]>;
  onDelta: (threadId: string, delta: string) => void;

  onThought: (threadId: string, delta: string) => void;
  onToolCall: (call: HarnessToolCall) => void;

  onContextExperiment: (threadId: string, fired: ContextExperimentFired) => void;
  onContextBreakdown: (threadId: string, parts: ContextBreakdown) => void;
  onRoutedModel: (threadId: string, routed: RoutedModel) => void;
  onUsage: (threadId: string, usage: TurnUsage) => void;

  onChildStart: (child: { parentThreadId: string; childId: string; title: string }) => Promise<string>;

  onChildEnd: (threadId: string, reason?: string) => void;
  onPlan: (threadId: string, entries: unknown) => void;

  onPermission: (ask: PermissionAsk, options: PermissionOption[], context: PermissionContext) => Promise<string | null>;

  onToolRequest: (threadId: string, name: string, args: Record<string, unknown>) => Promise<string>;
  onLifecycle?: (event: RunnableHookEvent, threadId: string, input: Record<string, unknown>) => Promise<void>;
  onLog?: (line: HarnessLogLine) => void;
};

export type PermissionContext = { outsideWorkspace: boolean; mode: PermissionMode; kind: string };

export type PermissionOption = { optionId: string; name: string; kind: string };

export const HARNESS_MODE_ID = "ask";

export const harnessKey = (cwd: string, nestedThreadId?: string, providerId?: string) =>
  [cwd, ...(nestedThreadId ? [nestedThreadId] : []), ...(providerId ? [`@${providerId}`] : [])].join("\u0000");

const SESSION_INDEX = "emma-sessions.json";

const sessionIndexes = new Map<string, Map<string, string>>();

function sessionIndex(home: string) {
  const loaded = sessionIndexes.get(home);
  if (loaded) return loaded;
  const known = new Map<string, string>();
  try {
    const raw: unknown = JSON.parse(readFileSync(path.join(home, SESSION_INDEX), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [threadId, sessionId] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof sessionId === "string" && sessionId.length > 0) known.set(threadId, sessionId);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Emma: could not read the harness session index", error);
  }
  sessionIndexes.set(home, known);
  return known;
}

function saveSessionIndex(home: string) {
  const known = sessionIndexes.get(home);
  if (!known) return;
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, SESSION_INDEX), JSON.stringify(Object.fromEntries(known)));
  } catch (error) {
    console.error("Emma: could not save the harness session index", error);
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; touch: () => void };

export class Harness {
  private child: ChildProcessWithoutNullStreams | undefined;

  private stderrTail = "";
  private readonly lines = new BoundedLines(MAX_LINE_BYTES);
  private readonly pending = new Map<number, Pending>();
  private readonly threadsBySession = new Map<string, string>();

  private active: string | undefined;

  private turns: Promise<unknown> = Promise.resolve();
  private computerTurn: { id: number; threadId: string; sessionId: string; calls: Set<string> } | undefined;

  private readonly calls = new Map<string, HarnessToolCall>();

  private readonly children = new Map<string, { thread: Promise<string>; ended: boolean }>();

  private readonly modes = new Map<string, PermissionMode>();
  private nextId = 1;
  private rebind = false;

  private cancelled = new Set<string>();
  private failure: Error | undefined;

  private heardAt = 0;

  constructor(private readonly deps: HarnessDeps) {}

  get running() {
    return this.child !== undefined && this.failure === undefined;
  }

  get busy() {
    return this.pending.size > 0 || [...this.children.values()].some((child) => !child.ended);
  }

  get silentFor() {
    return this.heardAt ? Date.now() - this.heardAt : Infinity;
  }

  get state(): HarnessState {
    return {
      cwd: this.deps.cwd,
      running: this.running,
      busy: this.busy,
      silentMs: this.heardAt ? Date.now() - this.heardAt : 0,
      failure: this.failure?.message ?? "",
    };
  }

  private log(flow: HarnessFlow, label: string, body: string) {
    this.deps.onLog?.({ at: Date.now(), flow, label, body: body.slice(0, MAX_LOG_BODY) });
  }

  async start() {
    if (this.child) return;

    const key = this.deps.apiKey ? { AI_GATEWAY_API_KEY: this.deps.apiKey, EMMA_PROVIDER_API_KEY: this.deps.apiKey } : {};
    const route = this.deps.chatUrl ? { EMMA_PROVIDER_CHAT_URL: this.deps.chatUrl } : {};
    const child = spawn(this.deps.binaryPath, this.deps.args ?? ["acp"], {
      cwd: this.deps.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: this.deps.home, ...key, ...route },
    });
    this.child = child;
    child.stdout.on("data", (data: Uint8Array) => {
      try {
        for (const line of this.lines.push(data)) this.receive(line);
      } catch (error) {
        this.fail(error as Error);
      }
    });
    child.stderr.on("data", (data) => {
      const text = String(data).trim();
      this.stderrTail = `${this.stderrTail}\n${text}`.slice(-MAX_STDERR_TAIL);
      console.error(`emma-cli: ${text}`);
      this.log("err", "stderr", text);
    });
    child.stdin.on("error", (error: Error) => this.fail(error));
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code, signal) => this.fail(new Error(this.exitReason(code, signal))));

    try {
      await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
    } catch (error) {
      this.fail(error as Error);
      this.close();
      throw error;
    }
  }

  async prompt(threadId: string, cwd: string, text: string, mode: PermissionMode, model?: string, extra: TurnExtras = {}): Promise<{ stopReason: StopReason; usage: TurnUsage }> {

    if (cwd !== this.deps.cwd) throw new Error(`Harness is bound to ${this.deps.cwd}, not ${cwd}`);
    this.cancelled.delete(threadId);

    const turn = this.turns.catch(() => undefined).then(() => this.runPrompt(threadId, cwd, text, mode, model, extra));
    this.turns = turn.catch(() => undefined);
    return await turn;
  }

  private async runPrompt(threadId: string, cwd: string, text: string, mode: PermissionMode, model?: string, extra: TurnExtras = {}): Promise<{ stopReason: StopReason; usage: TurnUsage }> {
    await this.start();
    const opening = !this.sessions.has(threadId);
    const sessionId = await this.activeSession(threadId, cwd);
    this.modes.set(threadId, mode);
    if (opening) await this.lifecycle("SessionStart", threadId, sessionId, mode, model, { source: "startup" });
    await this.request("session/set_mode", { sessionId, modeId: HARNESS_MODE_ID });

    if (model) await this.request("session/set_config_option", { sessionId, configId: "model", value: model });

    if (extra.contextWindow) {
      await this.request("session/set_config_option", { sessionId, configId: "context_window", value: String(extra.contextWindow) });
    }

    if (extra.effort) {
      await this.request("session/set_config_option", { sessionId, configId: "reasoning_effort", value: effortOption(extra.effort) });
    }

    if (extra.experiments) {
      await this.request("session/set_config_option", { sessionId, configId: "context_experiments", value: experimentOption(extra.experiments) });
    }

    if (extra.compact) {
      await this.request("session/compact", { sessionId }).catch((error: unknown) => console.error("Emma: the harness would not compact", error));
    }
    const prompt = extra.continueRecovery ? [] : [
      ...(extra.skillContext ? [{ type: "text", text: extra.skillContext }] : []),
      { type: "text", text },
      ...(extra.images ?? []).map((file) => ({ type: "image", mimeType: mediaType(file), uri: pathToFileURL(file).href })),
    ];
    if (this.cancelled.delete(threadId)) throw new Error("This turn was stopped before it reached the model.");
    await this.lifecycle("UserPromptSubmit", threadId, sessionId, mode, model, { prompt: text });
    const result = (await this.request("session/prompt", {
      sessionId,
      prompt,
      ...(extra.continueRecovery ? { _meta: { fx: { continueRecovery: true } } } : {}),
    })) as { stopReason?: string; usage?: { inputTokens?: unknown; outputTokens?: unknown } } | null;
    const stopReason = (result?.stopReason ?? "end_turn") as StopReason;
    await this.lifecycle("Stop", threadId, sessionId, mode, model, { stop_hook_active: false, stop_reason: stopReason });
    return {
      stopReason,
      usage: { inputTokens: count(result?.usage?.inputTokens), outputTokens: count(result?.usage?.outputTokens) },
    };
  }

  private async lifecycle(event: RunnableHookEvent, threadId: string, sessionId: string, mode: PermissionMode, model: string | undefined, extra: Record<string, unknown>) {
    if (!this.deps.onLifecycle) return;
    await this.deps.onLifecycle(event, threadId, {
      session_id: sessionId,
      transcript_path: null,
      cwd: this.deps.cwd,
      hook_event_name: event,
      permission_mode: mode,
      model: model ?? "",
      ...extra,
    }).catch((error: unknown) => console.error(`Emma: a ${event} plugin hook could not be run`, error));
  }

  async cancel(threadId: string) {
    this.cancelled.add(threadId);
    if (this.computerTurn?.threadId === threadId) this.computerTurn = undefined;
    const sessionId = this.sessions.get(threadId);

    if (!sessionId || sessionId !== this.active || !this.running) return;

    this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  async steer(threadId: string, content: string) {
    const sessionId = this.sessions.get(threadId);
    if (!sessionId || sessionId !== this.active || !this.running) return false;
    await this.request("session/steer", { sessionId, content });
    return true;
  }

  async steerChild(childId: string, content: string) {
    await this.request("session/steer_child", { childId, content });
  }

  async cancelChild(childId: string) {
    await this.request("session/cancel_child", { childId });
  }

  private exitReason(code: number | null, signal: string | null): string {
    const said = this.stderrTail.split("\n").map((line) => line.trim()).filter(Boolean);
    const detail = said.find((line) => /panic|unreachable|error:/i.test(line)) ?? said.at(-1);
    const how = signal ? `was killed by ${signal}` : `exited with code ${code ?? "unknown"}`;
    return `emma-cli ${how}${detail ? `: ${detail}` : ""}`;
  }

  close() {
    this.fail(new Error("Harness closed"));
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    if (!child.stdin.destroyed) child.stdin.end();
    if (!child.killed) child.kill();
  }

  private get sessions() {
    return sessionIndex(this.deps.home);
  }

  private remember() {
    saveSessionIndex(this.deps.home);
  }

  private async activeSession(threadId: string, cwd: string) {
    const sessionId = await this.session(threadId, cwd);
    if (this.active === sessionId && !this.rebind) return sessionId;
    try {
      await this.request("session/resume", { sessionId, mcpServers: await this.deps.mcpServers(threadId) });
      this.active = sessionId;
      this.rebind = false;
      return sessionId;
    } catch (error) {
      console.error("Emma: could not resume the harness session for this thread, starting a new one", error);
      this.sessions.delete(threadId);
      this.threadsBySession.delete(sessionId);
      this.remember();
      return await this.session(threadId, cwd);
    }
  }

  private async session(threadId: string, cwd: string) {
    const existing = this.sessions.get(threadId);
    if (existing) {
      this.threadsBySession.set(existing, threadId);
      return existing;
    }
    const result = await this.request("session/new", { cwd, mcpServers: await this.deps.mcpServers(threadId) });
    const sessionId = (result as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("Harness returned no session id");
    this.sessions.set(threadId, sessionId);
    this.threadsBySession.set(sessionId, threadId);
    this.remember();
    this.active = sessionId;
    return sessionId;
  }

  forgetSession(threadId: string) {
    this.sessions.delete(threadId);
    this.remember();
  }

  rebindServers() {
    this.rebind = true;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    if (method === "session/prompt") {
      const sessionId = String(params.sessionId ?? "");
      const threadId = this.threadsBySession.get(sessionId);
      if (threadId && !this.cancelled.has(threadId)) this.computerTurn = { id, threadId, sessionId, calls: new Set() };
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        if (this.computerTurn?.id === id) this.computerTurn = undefined;
        reject(new Error(`Harness call ${method} timed out`));
      }, this.deps.idleMs ?? MAX_IDLE_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, touch: () => timer.refresh() });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(message: Record<string, unknown>) {
    const child = this.child;
    if (!child) throw this.failure ?? new Error("Harness is not running");
    this.log("out", wireLabel(message), JSON.stringify(message));
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) this.fail(error);
    });
  }

  private receive(line: string) {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    const message = JSON.parse(trimmed) as Record<string, unknown>;
    if (!streamedChunk(message)) this.log("in", wireLabel(message), trimmed);
    this.heardAt = Date.now();

    for (const call of this.pending.values()) call.touch();

    if (typeof message.method === "string") {
      void this.handleIncoming(message).catch((error: unknown) => this.log("err", "dropped", error instanceof Error ? error.message : String(error)));
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (this.computerTurn?.id === message.id) this.computerTurn = undefined;
    if (message.error) {
      const detail = (message.error as { message?: string }).message ?? "Harness call failed";
      pending.reject(new Error(detail));
      return;
    }
    pending.resolve(message.result ?? null);
  }

  private async handleIncoming(message: Record<string, unknown>) {
    const method = message.method as string;
    const params = (message.params ?? {}) as Record<string, unknown>;

    if (method === "session/update") {
      this.handleUpdate(params);
      return;
    }
    if (method === "session/request_permission" && typeof message.id === "number") {
      await this.handlePermission(message.id, params);
      return;
    }
    if (method === "_emma/callTool" && typeof message.id === "number") {
      await this.handleToolRequest(message.id, params);
      return;
    }

    if (typeof message.id === "number") {
      this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported method ${method}` } });
    }
  }

  private handleUpdate(params: Record<string, unknown>) {
    const threadId = this.threadsBySession.get(String(params.sessionId ?? ""));
    if (!threadId) return;
    const update = (params.update ?? {}) as Record<string, unknown>;

    const child = childTag(update);
    if (child) {
      const owner = this.childThread(threadId, child);
      if (child.ended) this.noteChildEnded(`${threadId}/${child.id}`);

      void owner
        .then((childThreadId) => {
          this.applyUpdate(childThreadId, update);
          if (child.ended) this.deps.onChildEnd(childThreadId);
        })
        .catch(() => undefined);
      return;
    }
    const turn = this.computerTurn;
    if (turn?.threadId === threadId && turn.sessionId === params.sessionId && typeof update.toolCallId === "string" && update.toolCallId) {
      if (update.sessionUpdate === "tool_call") turn.calls.add(update.toolCallId);
      if (update.status === "completed" || update.status === "failed") turn.calls.delete(update.toolCallId);
    }
    this.applyUpdate(threadId, update);
  }

  private childThread(parentThreadId: string, child: ChildTag): Promise<string> {
    const key = `${parentThreadId}/${child.id}`;
    const known = this.children.get(key);
    if (known) return known.thread;
    const created = this.deps.onChildStart({ parentThreadId, childId: child.id, title: child.title });
    this.children.set(key, { thread: created, ended: false });
    return created;
  }

  private noteChildEnded(key: string) {
    const known = this.children.get(key);
    if (known) known.ended = true;
  }

  private applyUpdate(threadId: string, update: Record<string, unknown>) {
    switch (update.sessionUpdate) {

      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const content = (update.content ?? {}) as { text?: unknown };
        if (typeof content.text !== "string") return;
        const to = update.sessionUpdate === "agent_thought_chunk" ? this.deps.onThought : this.deps.onDelta;
        to(threadId, content.text);
        return;
      }
      case "tool_call":
      case "tool_call_update": {

        const toolCallId = String(update.toolCallId ?? "");

        const key = `${threadId}:${toolCallId}`;
        const known = this.calls.get(key);
        const call: HarnessToolCall = {
          threadId,
          toolCallId,
          title: toolCallText(update.title) ?? known?.title ?? "",
          kind: toolCallText(update.kind) ?? known?.kind ?? "other",
          status: (update.status as HarnessToolCall["status"]) ?? known?.status ?? "pending",

          input: rawInput(update.rawInput) ?? known?.input,

          output: toolOutput(update.content) ?? known?.output,
          at: Date.now(),
        };
        this.calls.set(key, call);
        this.deps.onToolCall(call);
        return;
      }
      case "plan":
        this.deps.onPlan(threadId, update.entries);
        return;

      case "session_info_update": {
        const usage = turnUsageReported(update);
        if (usage) {
          this.deps.onUsage(threadId, usage);
          return;
        }
        const fired = contextExperimentFired(update);
        if (fired) {
          this.deps.onContextExperiment(threadId, fired);
          return;
        }
        const breakdown = contextBreakdownReported(update);
        if (breakdown) {
          this.deps.onContextBreakdown(threadId, breakdown);
          return;
        }
        const routed = routedModelReported(update);
        if (routed) {
          this.deps.onRoutedModel(threadId, routed);
          return;
        }
        const recovery =((update._meta as { fx?: { modelResponseRecovery?: unknown } } | undefined)?.fx?.modelResponseRecovery ?? null) as
          { state?: unknown; message?: unknown; attempt?: unknown; attemptLimit?: unknown; delaySeconds?: unknown } | null;
        if (!recovery || typeof recovery.message !== "string") return;
        const attempt = typeof recovery.attempt === "number" && typeof recovery.attemptLimit === "number" && recovery.attemptLimit > 0
          ? ` (attempt ${recovery.attempt} of ${recovery.attemptLimit})`
          : "";
        const wait = typeof recovery.delaySeconds === "number" && recovery.delaySeconds > 0 ? `, retrying in ${recovery.delaySeconds}s` : "";

        this.deps.onThought(threadId, `${recovery.message}${attempt}${wait}\n`);
        return;
      }
      default:
        return;
    }
  }

  private async handlePermission(id: number, params: Record<string, unknown>) {
    const threadId = this.threadsBySession.get(String(params.sessionId ?? ""));
    const options = Array.isArray(params.options) ? (params.options as PermissionOption[]) : [];
    if (!threadId) {
      this.send({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
      return;
    }

    const child = childTag(params);
    const asking = child ? await this.childThread(threadId, child).catch(() => threadId) : threadId;
    const call = (params.toolCall ?? {}) as { toolCallId?: unknown; title?: unknown; kind?: unknown; rawInput?: unknown };

    const title = String(call.title ?? "tool");
    const named = title === "file_mutation" ? describePath(call.rawInput) ?? title : title;
    const ask: PermissionAsk = {
      id: String(call.toolCallId ?? id),
      threadId: asking,
      tool: named,
      summary: named === title ? String(call.title ?? "This run wants to use a tool.") : `writing ${named}`,
      detail: typeof call.rawInput === "string" ? call.rawInput : JSON.stringify(call.rawInput ?? {}, null, 2).slice(0, 4096),
    };
    const context: PermissionContext = {
      outsideWorkspace: callEscapesWorkspace(this.deps.cwd, call.rawInput),
      mode: this.modes.get(threadId) ?? "ask",
      kind: String(call.kind ?? "other"),
    };

    let chosen: string | null;
    try {
      chosen = await this.deps.onPermission(ask, options, context);
    } catch {
      chosen = null;
    }

    this.send({
      jsonrpc: "2.0",
      id,
      result: chosen ? { outcome: { outcome: "selected", optionId: chosen } } : { outcome: { outcome: "cancelled" } },
    });
  }

  private async handleToolRequest(id: number, params: Record<string, unknown>) {
    const threadId = this.threadsBySession.get(String(params.sessionId ?? ""));
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments
      : {}) as Record<string, unknown>;
    if (!threadId || !name) {
      this.send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown session or tool" } });
      return;
    }
    let output: string;
    try {
      if (name === "computer") {
        const turn = this.computerTurn;
        const toolCallId = typeof params.toolCallId === "string" ? params.toolCallId : "";
        if (!turn || turn.threadId !== threadId || turn.sessionId !== params.sessionId || childTag(params) || this.children.has(`${threadId}/${toolCallId}`) || !turn.calls.delete(toolCallId)) {
          throw new Error("Computer use must be performed by the parent turn with a current tool call.");
        }
      }
      output = await this.deps.onToolRequest(threadId, name, args);
    } catch (error) {
      output = error instanceof Error ? error.message : String(error);
    }
    this.send({ jsonrpc: "2.0", id, result: { output: output.slice(0, MAX_TOOL_OUTPUT_BYTES) } });
  }

  private fail(error: Error) {
    if (!this.failure) this.log("err", "stopped", error.message);
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    this.threadsBySession.clear();
    this.active = undefined;
    this.computerTurn = undefined;
    this.calls.clear();

    for (const [key, child] of this.children) {
      if (child.ended) continue;
      this.noteChildEnded(key);
      void child.thread.then((threadId) => this.deps.onChildEnd(threadId, error.message)).catch(() => undefined);
    }
  }
}

const PATH_FIELDS = ["path", "paths", "old_path", "new_path", "source", "destination", "cwd"];

const exists = (candidate: string) => {
  try {
    statSync(candidate);
    return true;
  } catch {
    return false;
  }
};

export function escapesRoot(root: string, value: string): boolean {
  let real: string;
  try { real = realpathSync(root); } catch { return true; }
  const target = path.isAbsolute(value) ? path.resolve(value) : path.resolve(real, value);
  if (target !== real && !target.startsWith(real + path.sep)) return true;
  let existing = target;
  while (existing !== real && existing.startsWith(real + path.sep) && !exists(existing)) {
    existing = path.dirname(existing);
  }
  try {
    const resolved = realpathSync(existing);
    return resolved !== real && !resolved.startsWith(real + path.sep);
  } catch { return true; }
}

export function callEscapesWorkspace(root: string, rawInput: unknown): boolean {
  if (typeof rawInput !== "object" || rawInput === null) return false;
  const args = rawInput as Record<string, unknown>;
  for (const field of PATH_FIELDS) {
    const value = args[field];
    if (typeof value === "string" && value.length > 0 && escapesRoot(root, value)) return true;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.length > 0 && escapesRoot(root, entry)) return true;
      }
    }
  }
  return false;
}

export type ChildTag = { id: string; title: string; ended: boolean };

export function childTag(update: Record<string, unknown>): ChildTag | undefined {
  const child = ((update._meta as { fx?: { child?: unknown } } | undefined)?.fx?.child ?? null) as
    { id?: unknown; title?: unknown; state?: unknown } | null;
  if (!child || typeof child.id !== "string" || child.id.length === 0) return undefined;
  return {
    id: child.id,
    title: typeof child.title === "string" && child.title.trim() ? child.title.trim().slice(0, 120) : "Subagent",
    ended: child.state === "ended",
  };
}

export function rawInput(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.slice(0, 4096);
}

export function describePath(rawInput: unknown): string | undefined {
  if (typeof rawInput !== "object" || rawInput === null) return undefined;
  const args = rawInput as Record<string, unknown>;
  for (const field of ["path", "new_path", "destination", "old_path", "source"]) {
    const value = args[field];
    if (typeof value === "string" && value.length > 0) return value.slice(0, 256);
  }
  return undefined;
}

export function toolCallText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function toolOutput(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    const inner = (block as { content?: { type?: unknown; text?: unknown } }).content;
    if (inner && inner.type === "text" && typeof inner.text === "string") parts.push(inner.text);
  }
  return parts.length ? unwrapMcpResult(parts.join("\n")) : undefined;
}

function mcpText(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const parts: string[] = [];
  for (const block of blocks) {
    const one = block as { type?: unknown; text?: unknown };
    if (one?.type === "text" && typeof one.text === "string") parts.push(one.text);
  }
  return parts.length ? parts.join("\n") : undefined;
}

export function unwrapMcpResult(text: string): string {
  if (!text.startsWith("{")) return text;
  try {
    const envelope = JSON.parse(text) as { tool?: unknown; result?: { content?: unknown } | null };

    if (typeof envelope?.tool !== "string") return text;
    return mcpText(envelope.result?.content) ?? text;
  } catch {
    return cutMcpText(text) ?? text;
  }
}

function cutMcpText(text: string): string | undefined {
  if (!text.startsWith('{"server":"') || !text.includes('"tool":"')) return undefined;
  const opener = text.indexOf('"text":"');
  if (opener < 0) return undefined;
  return text
    .slice(opener + '"text":"'.length)

    .replace(/\\$/, "")
    .replace(/\\(["\\/bfnrt])/g, (_, escape: string) => ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[escape] ?? escape));
}
