import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { BoundedLines } from "./ndjson";
export type { PermissionAsk } from "../shared/agents";
import type { PermissionAsk, ThreadStep } from "../shared/agents";
import type { PermissionMode } from "../shared/permissions";
import type { HarnessExperiments } from "../shared/settings";

/**
 * Emma's client for `emma-cli acp` — the forked fx harness driven over the
 * Agent Client Protocol (newline-delimited JSON-RPC on stdio).
 *
 * The harness owns the agent loop, tool execution, permission gating, hooks,
 * skills and subagents. Emma owns the window, the durable Markdown stores, and
 * the answer to every permission question. That split is why this is a client
 * and not a second loop: `driveTurn` used to run Emma's own loop, and now hands
 * the turn here instead.
 */

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const PROTOCOL_VERSION = 1;

/**
 * How long the harness may go *silent* before Emma stops waiting on it.
 *
 * Idle, not wall clock: a long build — subagents, dozens of tool calls — runs
 * well past half an hour while streaming the whole time, and killing it at a
 * fixed deadline threw away work that was visibly progressing. Any inbound
 * message resets the clock, so this now only fires on a genuinely wedged peer.
 */
export const MAX_IDLE_MS = 30 * 60 * 1000;

/** The wire values, from `harness/src/acp/types.zig`. Three of these were wrong
 *  here — `refusal`/`max_tokens`/`max_turn_requests` are not what the harness
 *  sends, and the mismatch is invisible because the value is cast, not parsed. */
export type StopReason = "end_turn" | "cancelled" | "refused" | "max_output_tokens" | "max_model_turns";

/** A stop reason that means the turn did not produce an answer. `refused` is the
 *  one that matters: the harness reports a provider or auth failure as ordinary
 *  assistant text and still resolves the call, so without this check the error
 *  string gets written into the thread as though Emma had said it. */
export const failedTurn = (reason: StopReason) => reason === "refused";

/**
 * What one turn cost. Upstream ACP has no usage field; this is an Emma extension
 * the fork puts on the `session/prompt` result, and it is the only place a
 * harness turn's real token counts exist on this side.
 */
export type TurnUsage = { inputTokens: number; outputTokens: number };

/**
 * Everything a turn carries besides its words.
 *
 * `skillContext` is the merged skill, folder, file and knowledge attachment that
 * Emma's own loop spreads into its first message. It was being dropped: the
 * composer chip cleared and the attachment was marked delivered while the
 * instructions never left this process.
 */
export type TurnExtras = { skillContext?: string; contextWindow?: number; experiments?: HarnessExperiments; compact?: boolean };

/**
 * The experimental context hooks, in the one string `session/set_config_option`
 * takes. Sent every turn, including when everything is off: the harness holds
 * these per session, so a lever switched off in Settings has to be switched off
 * there too.
 */
export const experimentOption = (experiments: HarnessExperiments) =>
  [
    `reinject_steps=${experiments.reinjectPromptSteps}`,
    `reinject_percent=${experiments.reinjectPromptPercent}`,
    `prune_steps=${experiments.pruneToolsSteps}`,
    `prune_percent=${experiments.pruneToolsPercent}`,
  ].join(",");

/** An MCP server, in the shape `session/new` wants it. */
export type HarnessMcpServer =
  | { type: "stdio"; name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  /** Emma's own tools, served over localhost; see `bridge.ts`. */
  | { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> };

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

/** The renderer shows these, so the shape lives where both sides can name it. */
export type HarnessToolCall = ThreadStep;

/** What one step's context experiment actually did, off `_meta.fx.contextExperiment`.
    The token figures are the harness's own ~4-chars-a-token estimate of what the
    rewrite took out of that step's request and what it put back in. */
export type ContextExperimentFired = { prunedResults: number; reinjected: boolean; savedTokens: number; addedTokens: number };

/**
 * The harness reports a fired lever on the same info channel the retry status
 * uses. Returns undefined for every other `session_info_update`, which is what
 * keeps this off the recovery path below it.
 */
export function contextExperimentFired(update: Record<string, unknown>): ContextExperimentFired | undefined {
  const fired = (update._meta as { fx?: { contextExperiment?: unknown } } | undefined)?.fx?.contextExperiment as
    { prunedResults?: unknown; reinjected?: unknown; savedTokens?: unknown; addedTokens?: unknown } | undefined;
  if (!fired || typeof fired !== "object") return undefined;
  const pruned = count(fired.prunedResults);
  const reinjected = fired.reinjected === true;
  // Both levers can be off on a step that fired neither; nothing to say then.
  return pruned || reinjected
    ? { prunedResults: pruned, reinjected, savedTokens: count(fired.savedTokens), addedTokens: count(fired.addedTokens) }
    : undefined;
}

export type HarnessDeps = {
  binaryPath: string;
  /** Defaults to the ACP subcommand; tests point this at a fake peer instead. */
  args?: string[];
  /** A profile directory of Emma's own, so the harness never shares `~/.fx`. */
  home: string;
  /**
   * The directory this harness may work in.
   *
   * It is the process's working directory, not just a value sent with
   * `session/new`: the harness resolves its workspace root from its own cwd once
   * at startup and ignores the per-session `cwd`, so a shared process would
   * write every thread's files into whatever directory Emma happened to launch
   * from. One process per workspace is what actually contains a run.
   */
  cwd: string;
  /** The provider key, from Emma's credential store rather than the harness's. */
  apiKey?: string;
  /** Overrides `MAX_IDLE_MS`, so a test can watch a long turn survive on its
      streamed updates without waiting half an hour to find out. */
  idleMs?: number;
  /** The user's configured MCP servers, read fresh so one installed mid-session
      is picked up by the next session rather than the next launch. */
  mcpServers: (threadId: string) => Promise<HarnessMcpServer[]>;
  onDelta: (threadId: string, delta: string) => void;
  /** Reasoning, which arrives on its own ACP channel rather than inline in the answer. */
  onThought: (threadId: string, delta: string) => void;
  onToolCall: (call: HarnessToolCall) => void;
  /**
   * One of the Harness settings levers fired on a step of this turn. The user
   * switched it on, so the turn it silently rewrites has to say that it did.
   */
  onContextExperiment: (threadId: string, fired: ContextExperimentFired) => void;
  /**
   * A subagent seen for the first time. Resolves with the Emma thread its
   * transcript belongs on; everything the child says and does is reported against
   * that thread through the callbacks above, exactly as the parent's turn is.
   */
  onChildStart: (child: { parentThreadId: string; childId: string; title: string }) => Promise<string>;
  /** That child's run ended — it will send nothing more. */
  onChildEnd: (threadId: string) => void;
  onPlan: (threadId: string, entries: unknown) => void;
  /** Resolves with the chosen ACP option id, or null to cancel the request. */
  onPermission: (ask: PermissionAsk, options: PermissionOption[], context: PermissionContext) => Promise<string | null>;
};

/**
 * What Emma needs to answer a permission question without asking the user twice.
 *
 * `outsideWorkspace` is the grant check, and it is decided here rather than by
 * the harness because the harness has no idea a grant exists.
 */
export type PermissionContext = { outsideWorkspace: boolean; mode: PermissionMode; kind: string };

export type PermissionOption = { optionId: string; name: string; kind: string };

/**
 * Emma's four picker modes onto the harness's mode ids.
 *
 * The mapping is the identity because `harness/src/builtins/modes.zig` was made
 * to match: upstream shipped only `ask` and `code`, and `code` is `acceptEdits`
 * under its real behaviour since it still gates commands. Mapping `full` onto it
 * would have left an unattended run prompting for approval nobody was there to
 * give.
 */
const MODE_IDS: Record<PermissionMode, string> = {
  plan: "plan",
  // Every mode that can change something maps to `ask`, so every decision comes
  // back to Emma. This is not the identity mapping it looks like it should be,
  // and the two modes that used to map straight through were both unsafe:
  //
  // `acceptEdits` became the harness's `auto`, which does not check the granted
  // folder at all (its own trace says `outside_workspace=unknown`) and which
  // hands every shell command to a hardcoded in-harness reviewer model. Emma's
  // picker promises the user that commands still ask, and they did not.
  //
  // `full` became `yolo`, evaluated before the config rule loop, so it kept no
  // floor whatsoever — where Emma's own `full` still enforces the sandbox.
  //
  // Routing everything here costs one local round trip per tool call and puts
  // the decision where the grant is actually known. `handlePermission` answers
  // without troubling the user in the modes that should not prompt.
  ask: "ask",
  acceptEdits: "ask",
  // The harness has no verifier of its own, and must not: the question it raises
  // is answered by Emma's verifier on the way through `AgentRuntime.question`
  // rather than by the user.
  auto: "ask",
  full: "ask",
};

export const harnessModeId = (mode: PermissionMode) => MODE_IDS[mode];

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; touch: () => void };

export class Harness {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly lines = new BoundedLines(MAX_LINE_BYTES);
  private readonly pending = new Map<number, Pending>();
  /** One harness session per Emma thread, so history and cwd stay per project. */
  private readonly sessions = new Map<string, string>();
  private readonly threadsBySession = new Map<string, string>();
  /**
   * The one session this process has active.
   *
   * The harness holds exactly one — `session/prompt` runs against
   * `state.active_session` and ignores the `sessionId` the call names, and
   * `session/new` swaps it without waiting for a running prompt. One process
   * serves every thread in a workspace, so a second thread's first turn used to
   * silently steal the first thread's session: the next prompt on the original
   * thread ran in the other thread's history, every update arrived tagged with
   * the other session and was routed to the other thread, and this one recorded
   * a turn with no text and a stop reason. Tracked here so a displaced session
   * is resumed before its thread is prompted again.
   */
  private active: string | undefined;
  /** One turn at a time per process, for that same reason: the session swap a
   *  second thread's turn performs is not gated on the first one finishing. */
  private turns: Promise<unknown> = Promise.resolve();
  /** Last full state per tool call, so an update that omits a field keeps it.
      ponytail: never pruned — one turn's worth of small records per process. */
  private readonly calls = new Map<string, HarnessToolCall>();
  /** `parentThreadId/childId` → the Emma thread that subagent's transcript is on. */
  private readonly children = new Map<string, Promise<string>>();
  /** The mode each thread's current turn is running under, so a permission
      question can be answered the way that mode promises. */
  private readonly modes = new Map<string, PermissionMode>();
  private nextId = 1;
  private failure: Error | undefined;

  constructor(private readonly deps: HarnessDeps) {}

  get running() {
    return this.child !== undefined && this.failure === undefined;
  }

  /** Whether a call is in flight, so a reaper does not close a process mid-turn. */
  get busy() {
    return this.pending.size > 0;
  }

  async start() {
    if (this.child) return;
    // Emma owns the credential, so the harness is handed one rather than left to
    // find its own. Both names are set: the fork still reads upstream's while the
    // Vercel vocabulary is being removed from it.
    const key = this.deps.apiKey ? { AI_GATEWAY_API_KEY: this.deps.apiKey, EMMA_PROVIDER_API_KEY: this.deps.apiKey } : {};
    const child = spawn(this.deps.binaryPath, this.deps.args ?? ["acp"], {
      cwd: this.deps.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: this.deps.home, ...key },
    });
    this.child = child;
    child.stdout.on("data", (data: Uint8Array) => {
      try {
        for (const line of this.lines.push(data)) this.receive(line);
      } catch (error) {
        this.fail(error as Error);
      }
    });
    child.stderr.on("data", (data) => console.error(`emma-cli: ${String(data).trim()}`));
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code) => this.fail(new Error(`emma-cli exited with code ${code ?? "unknown"}`)));

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
  }

  /**
   * Runs one turn to completion and resolves with why it stopped and what it cost.
   *
   * Queued behind whatever this process is already running. Two threads sharing
   * a workspace share this harness, and it can only hold one session, so a turn
   * that starts while another is in flight does not run beside it — it runs
   * *instead of* it.
   */
  async prompt(threadId: string, cwd: string, text: string, mode: PermissionMode, model?: string, extra: TurnExtras = {}): Promise<{ stopReason: StopReason; usage: TurnUsage }> {
    // Refuse rather than write somewhere the caller did not intend. The harness
    // takes its workspace from this process's cwd, so a turn asking for a
    // different directory cannot be honoured by this client.
    if (cwd !== this.deps.cwd) throw new Error(`Harness is bound to ${this.deps.cwd}, not ${cwd}`);
    // A failed turn must not poison the queue behind it, hence the catch on the
    // link rather than on the turn this caller is waiting for.
    const turn = this.turns.catch(() => undefined).then(() => this.runPrompt(threadId, cwd, text, mode, model, extra));
    this.turns = turn.catch(() => undefined);
    return await turn;
  }

  private async runPrompt(threadId: string, cwd: string, text: string, mode: PermissionMode, model?: string, extra: TurnExtras = {}): Promise<{ stopReason: StopReason; usage: TurnUsage }> {
    await this.start();
    const sessionId = await this.activeSession(threadId, cwd);
    this.modes.set(threadId, mode);
    await this.request("session/set_mode", { sessionId, modeId: MODE_IDS[mode] });
    // Emma's picker is the source of truth for the model, so it is re-applied
    // per turn rather than trusted to persist in the harness's own settings.
    if (model) await this.request("session/set_config_option", { sessionId, configId: "model", value: model });
    // The harness only recognises a handful of model prefixes, so left to itself
    // its context window is unknown and both its history budget and its
    // token-pressure compaction trigger fall back to defaults. Emma has the real
    // number from the OpenRouter catalog.
    if (extra.contextWindow) {
      await this.request("session/set_config_option", { sessionId, configId: "context_window", value: String(extra.contextWindow) });
    }
    // Settings → Harness. Sent whether or not anything is on, so switching a
    // lever off reaches the session that was running with it on.
    if (extra.experiments) {
      await this.request("session/set_config_option", { sessionId, configId: "context_experiments", value: experimentOption(extra.experiments) });
    }
    // A compaction Emma asked for last turn. Here rather than at the call site
    // because this is the one moment it is safe: the session is loaded, the
    // queue is ours, and no prompt is in flight for the harness to refuse it
    // over. Best effort — a thread whose history would not fold is still a
    // thread whose next prompt should go out.
    if (extra.compact) {
      await this.request("session/compact", { sessionId }).catch((error: unknown) => console.error("Emma: the harness would not compact", error));
    }
    // Skills, attached folders, files and knowledge all ride this one channel.
    // It is a second block rather than a prefix on the prompt so the harness's
    // own transcript keeps the user's words separate from Emma's context.
    const prompt = extra.skillContext
      ? [{ type: "text", text: extra.skillContext }, { type: "text", text }]
      : [{ type: "text", text }];
    const result = (await this.request("session/prompt", {
      sessionId,
      prompt,
    })) as { stopReason?: string; usage?: { inputTokens?: unknown; outputTokens?: unknown } } | null;
    return {
      stopReason: (result?.stopReason ?? "end_turn") as StopReason,
      usage: { inputTokens: count(result?.usage?.inputTokens), outputTokens: count(result?.usage?.outputTokens) },
    };
  }

  async cancel(threadId: string) {
    const sessionId = this.sessions.get(threadId);
    // Only when this thread is the one running: `session/cancel` names a session
    // the harness does not read, so cancelling a thread whose turn is still
    // queued would stop whichever thread's turn is actually in flight.
    if (!sessionId || sessionId !== this.active || !this.running) return;
    // Notification, not a request: cancellation has no reply and must not be
    // able to hang on a harness that is already wedged.
    this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  /**
   * A message for one running subagent. It is queued on the child rather than
   * injected, so it lands with that child's next turn and never interrupts the
   * tool call it is in the middle of — the same thing steering means everywhere
   * else in Emma.
   */
  async steerChild(childId: string, content: string) {
    await this.request("session/steer_child", { childId, content });
  }

  close() {
    this.fail(new Error("Harness closed"));
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    if (!child.stdin.destroyed) child.stdin.end();
    if (!child.killed) child.kill();
  }

  /**
   * This thread's session, made active before it is prompted.
   *
   * A session another thread displaced is resumed rather than replaced: the
   * harness restores it from its own durable log, so the thread keeps the
   * history it had. Only when that restore fails — a pruned log, an older
   * binary — does the thread start over on a new session, which costs it its
   * history but still answers the prompt.
   */
  private async activeSession(threadId: string, cwd: string) {
    const sessionId = await this.session(threadId, cwd);
    if (this.active === sessionId) return sessionId;
    try {
      await this.request("session/resume", { sessionId, mcpServers: await this.deps.mcpServers(threadId) });
      this.active = sessionId;
      return sessionId;
    } catch (error) {
      console.error("Emma: could not resume the harness session for this thread, starting a new one", error);
      this.sessions.delete(threadId);
      this.threadsBySession.delete(sessionId);
      return await this.session(threadId, cwd);
    }
  }

  private async session(threadId: string, cwd: string) {
    const existing = this.sessions.get(threadId);
    if (existing) return existing;
    // Every MCP server the user configured. This was an empty array, so their
    // servers silently did not exist on this path — no error, no warning, the
    // tools simply were not there.
    const result = await this.request("session/new", { cwd, mcpServers: await this.deps.mcpServers(threadId) });
    const sessionId = (result as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("Harness returned no session id");
    this.sessions.set(threadId, sessionId);
    this.threadsBySession.set(sessionId, threadId);
    // `session/new` is what makes it active, here as in the harness.
    this.active = sessionId;
    return sessionId;
  }

  /**
   * Drops a thread's session so the next turn builds a new one.
   *
   * The harness takes MCP servers only at `session/new`, so a server installed
   * mid-turn cannot appear in the session that installed it. Restarting is what
   * makes `install_mcp` mean anything here.
   *
   * Only the forward map: `install_mcp` is called from inside a running turn, and
   * dropping the reverse routing would silence the rest of it — every update and
   * every permission request for the live session would arrive with no thread to
   * belong to. The stale reverse entry is one small record per session.
   */
  forgetSession(threadId: string) {
    this.sessions.delete(threadId);
  }

  /** The same, for every thread, after the set of configured servers changes. */
  forgetAllSessions() {
    this.sessions.clear();
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
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
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) this.fail(error);
    });
  }

  private receive(line: string) {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    const message = JSON.parse(trimmed) as Record<string, unknown>;
    // Anything at all from the harness — a token, a tool call, a permission
    // question — means it is alive, so every call in flight gets its idle clock
    // back. A `session/prompt` outlives its own updates only if nothing arrives.
    for (const call of this.pending.values()) call.touch();

    // A message carrying a method is the harness talking to Emma; one carrying
    // only an id is Emma's own call coming back.
    if (typeof message.method === "string") {
      void this.handleIncoming(message);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
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
    // Unknown request: answer rather than leave the harness waiting forever.
    if (typeof message.id === "number") {
      this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported method ${method}` } });
    }
  }

  private handleUpdate(params: Record<string, unknown>) {
    const threadId = this.threadsBySession.get(String(params.sessionId ?? ""));
    if (!threadId) return;
    const update = (params.update ?? {}) as Record<string, unknown>;

    // A subagent runs inside the harness and has no ACP session of its own, so
    // its updates ride its parent's tagged with which child they came from. Fanned
    // back out here onto a thread of the child's own — untagged, a subagent's
    // words would land in the parent's durable answer as if the parent said them.
    const child = childTag(update);
    if (child) {
      const owner = this.childThread(threadId, child);
      // Chained rather than awaited: every update for one child registers on the
      // same promise, and those run in the order they were registered, so the
      // transcript cannot arrive out of order behind the thread that holds it.
      void owner
        .then((childThreadId) => {
          this.applyUpdate(childThreadId, update);
          if (child.ended) this.deps.onChildEnd(childThreadId);
        })
        .catch(() => undefined);
      return;
    }
    this.applyUpdate(threadId, update);
  }

  /**
   * The Emma thread one harness subagent lives on, made on first sight of it.
   *
   * Memoised as the promise rather than the id, so the updates that arrive while
   * the thread is still being created queue behind it instead of racing into a
   * second one.
   */
  private childThread(parentThreadId: string, child: ChildTag): Promise<string> {
    const key = `${parentThreadId}/${child.id}`;
    const known = this.children.get(key);
    if (known) return known;
    const created = this.deps.onChildStart({ parentThreadId, childId: child.id, title: child.title });
    this.children.set(key, created);
    return created;
  }

  private applyUpdate(threadId: string, update: Record<string, unknown>) {
    switch (update.sessionUpdate) {
      // Two channels, not one: a reasoning model's scratchpad arrives separately
      // from its answer, and folding them into a single stream is what made the
      // harness look like it was thinking silently and then blurting a result.
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
        // `tool_call` is the whole call; `tool_call_update` carries only what
        // changed. Merging rather than rebuilding is what keeps a call's title
        // and kind once it starts running — otherwise every step in the
        // transcript reverted to an untitled "other" the moment it progressed.
        const toolCallId = String(update.toolCallId ?? "");
        // Keyed by the thread too: a subagent's call ids come off its own model
        // stream and nothing stops one from matching a call on the parent.
        const key = `${threadId}:${toolCallId}`;
        const known = this.calls.get(key);
        const call: HarnessToolCall = {
          threadId,
          toolCallId,
          title: typeof update.title === "string" ? update.title : known?.title ?? "",
          kind: typeof update.kind === "string" ? update.kind : known?.kind ?? "other",
          status: (update.status as HarnessToolCall["status"]) ?? known?.status ?? "pending",
          // Only the opening `tool_call` carries the arguments, so the merge is
          // what keeps them for the rest of the call's life.
          input: rawInput(update.rawInput) ?? known?.input,
          // `command_result` carries the same exit code the content text already
          // starts with (`exit_code=0\n<stdout>…`), so nothing is lost by
          // showing the text alone.
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
      // Retry and pause state, which the harness reports while it works through
      // a provider that is failing. Dropped, a run waiting out a 503 with a
      // sixty-second backoff was indistinguishable from one that had hung.
      case "session_info_update": {
        const fired = contextExperimentFired(update);
        if (fired) {
          this.deps.onContextExperiment(threadId, fired);
          return;
        }
        const recovery =((update._meta as { fx?: { modelResponseRecovery?: unknown } } | undefined)?.fx?.modelResponseRecovery ?? null) as
          { state?: unknown; message?: unknown; attempt?: unknown; attemptLimit?: unknown; delaySeconds?: unknown } | null;
        if (!recovery || typeof recovery.message !== "string") return;
        const attempt = typeof recovery.attempt === "number" && typeof recovery.attemptLimit === "number" && recovery.attemptLimit > 0
          ? ` (attempt ${recovery.attempt} of ${recovery.attemptLimit})`
          : "";
        const wait = typeof recovery.delaySeconds === "number" && recovery.delaySeconds > 0 ? `, retrying in ${recovery.delaySeconds}s` : "";
        // On the thinking channel rather than the answer: it is status, not
        // something the model said, and it must not land in the durable reply.
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
    const call = (params.toolCall ?? {}) as { toolCallId?: unknown; title?: unknown; kind?: unknown; rawInput?: unknown };
    // A file mutation arrives titled `file_mutation`, which is the kind rather
    // than anything a person would recognise. The path is the useful part.
    const title = String(call.title ?? "tool");
    const named = title === "file_mutation" ? describePath(call.rawInput) ?? title : title;
    const ask: PermissionAsk = {
      id: String(call.toolCallId ?? id),
      threadId,
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
    // A refused or unanswered question is a denial, never a silent allow.
    this.send({
      jsonrpc: "2.0",
      id,
      result: chosen ? { outcome: { outcome: "selected", optionId: chosen } } : { outcome: { outcome: "cancelled" } },
    });
  }

  private fail(error: Error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    this.sessions.clear();
    this.threadsBySession.clear();
    this.active = undefined;
    this.calls.clear();
    this.children.clear();
  }
}

/**
 * Every path-shaped argument the harness's file and terminal tools take, from
 * the schemas in `harness/src/builtins/tools.zig`.
 */
const PATH_FIELDS = ["path", "paths", "old_path", "new_path", "source", "destination", "cwd"];

const exists = (candidate: string) => {
  try {
    statSync(candidate);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether one path argument lands outside the workspace root.
 *
 * The root is realpath'd because a granted folder is routinely reached through a
 * symlink — `/tmp` is `/private/tmp` on a Mac, and comparing the two as strings
 * calls every write an escape. The target is resolved down to its deepest
 * *existing* ancestor before being realpath'd, since the leaf of a write usually
 * does not exist yet, and a symlink partway up is the thing being guarded
 * against. Unresolvable is treated as an escape: this decides whether to let a
 * write through, so the unknown case has to be the closed one.
 */
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

/**
 * Whether a tool call reaches outside the workspace.
 *
 * The harness resolves `../` and `~` itself and will happily mutate anything its
 * permission policy allows, which in its `auto` and `yolo` modes is the whole
 * filesystem. Emma's grant is the only record of what the user actually agreed
 * to, so the check has to happen on this side of the protocol.
 */
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

/** Which subagent an update came from, when it came from one. */
export type ChildTag = { id: string; title: string; ended: boolean };

/**
 * The `_meta.fx.child` tag the harness puts on a subagent's updates.
 *
 * ACP has no nested sessions, so a child rides its parent's stream and says who
 * it is here; see `writeChildTaggedUpdate` in `harness/src/acp/types.zig`.
 * Untagged updates are the session's own and read exactly as they always did.
 */
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

/** A tool call's arguments, bounded: a `write_file` call carries a whole file in them. */
export function rawInput(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.slice(0, 4096);
}

/** The path a tool call is about, for a permission dialog that would otherwise
 *  be headlined with the bare word `file_mutation`. */
export function describePath(rawInput: unknown): string | undefined {
  if (typeof rawInput !== "object" || rawInput === null) return undefined;
  const args = rawInput as Record<string, unknown>;
  for (const field of ["path", "new_path", "destination", "old_path", "source"]) {
    const value = args[field];
    if (typeof value === "string" && value.length > 0) return value.slice(0, 256);
  }
  return undefined;
}

/** ACP tool output is a list of content blocks; Emma shows the text ones. */
export function toolOutput(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    const inner = (block as { content?: { type?: unknown; text?: unknown } }).content;
    if (inner && inner.type === "text" && typeof inner.text === "string") parts.push(inner.text);
  }
  return parts.length ? unwrapMcpResult(parts.join("\n")) : undefined;
}

/** The `[{type:"text",text}]` list an MCP result carries, flattened. */
function mcpText(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const parts: string[] = [];
  for (const block of blocks) {
    const one = block as { type?: unknown; text?: unknown };
    if (one?.type === "text" && typeof one.text === "string") parts.push(one.text);
  }
  return parts.length ? parts.join("\n") : undefined;
}

/**
 * An MCP tool's answer, taken out of the envelope the harness reports it in.
 *
 * Every one of Emma's own tools reaches the harness over the MCP bridge, and
 * comes back as `{"server":…,"tool":…,"result":{"content":[…]}}` rather than as
 * the text the tool wrote. Unwrapped here, at the one place tool output is read,
 * because two things downstream want the text and not the wrapper: the
 * transcript, which was showing a line of raw JSON for every Emma tool, and the
 * `[artifact:…]` marker, which is read off the end of the first line and was
 * finding the envelope instead — so no artifact card ever drew on this path.
 *
 * Anything that is not one of these envelopes is returned untouched.
 */
export function unwrapMcpResult(text: string): string {
  if (!text.startsWith("{")) return text;
  try {
    const envelope = JSON.parse(text) as { tool?: unknown; result?: { content?: unknown } | null };
    // `tool` is what tells an MCP envelope from a tool that simply answered in
    // JSON; without it, any JSON-returning tool with a `result` key would be
    // silently rewritten to whatever was inside it.
    if (typeof envelope?.tool !== "string") return text;
    return mcpText(envelope.result?.content) ?? text;
  } catch {
    return cutMcpText(text) ?? text;
  }
}

/**
 * The words inside an envelope that arrived cut off mid-string.
 *
 * `toolUpdateContentText` in the harness reports a 200-byte prefix of any tool's
 * output, and the envelope's own header eats about 110 of those — so a bridged
 * tool's result is nearly always unparseable JSON, and the usual path above
 * cannot help. Without this the transcript shows a broken brace-and-quote
 * fragment for every one of Emma's tools.
 *
 * ponytail: matches the harness's key order (`server` then `tool`) rather than
 * parsing; if that wire format changes this stops firing and the raw text comes
 * back, which is what it did before.
 */
function cutMcpText(text: string): string | undefined {
  if (!text.startsWith('{"server":"') || !text.includes('"tool":"')) return undefined;
  const opener = text.indexOf('"text":"');
  if (opener < 0) return undefined;
  return text
    .slice(opener + '"text":"'.length)
    // A backslash left dangling by the cut is dropped rather than shown.
    .replace(/\\$/, "")
    .replace(/\\(["\\/bfnrt])/g, (_, escape: string) => ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[escape] ?? escape));
}
