"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Harness = exports.harnessKey = exports.HARNESS_MODE_ID = exports.experimentOption = exports.effortOption = exports.failedTurn = exports.MAX_IDLE_MS = void 0;
exports.contextExperimentFired = contextExperimentFired;
exports.routedModelReported = routedModelReported;
exports.contextBreakdownReported = contextBreakdownReported;
exports.turnUsageReported = turnUsageReported;
exports.escapesRoot = escapesRoot;
exports.callEscapesWorkspace = callEscapesWorkspace;
exports.childTag = childTag;
exports.rawInput = rawInput;
exports.describePath = describePath;
exports.toolCallText = toolCallText;
exports.toolOutput = toolOutput;
exports.unwrapMcpResult = unwrapMcpResult;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_url_1 = require("node:url");
const ndjson_1 = require("./ndjson");
const harness_log_1 = require("../shared/harness-log");
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const PROTOCOL_VERSION = 1;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
exports.MAX_IDLE_MS = 30 * 60 * 1000;
const MAX_STDERR_TAIL = 4 * 1024;
const failedTurn = (reason) => reason === "refused";
exports.failedTurn = failedTurn;
const mediaType = (file) => `image/${node_path_1.default.extname(file).slice(1).toLowerCase().replace("jpg", "jpeg")}`;
const effortOption = ({ level, published }) => `${level || "auto"};${published.join(",")}`;
exports.effortOption = effortOption;
const experimentOption = (experiments) => [
    `reinject_steps=${experiments.reinjectPromptSteps}`,
    `reinject_percent=${experiments.reinjectPromptPercent}`,
    `prune_steps=${experiments.pruneToolsSteps}`,
    `prune_percent=${experiments.pruneToolsPercent}`,
].join(",");
exports.experimentOption = experimentOption;
const wireLabel = (message) => {
    const id = typeof message.id === "number" ? `#${message.id}` : "";
    if (typeof message.method === "string")
        return [message.method, id].filter(Boolean).join(" ");
    return [message.error ? "error" : "result", id].filter(Boolean).join(" ") || "message";
};
const streamedChunk = (message) => {
    if (message.method !== "session/update")
        return false;
    const update = message.params?.update;
    return typeof update?.sessionUpdate === "string" && update.sessionUpdate.endsWith("_chunk");
};
const count = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
function contextExperimentFired(update) {
    const fired = update._meta?.fx?.contextExperiment;
    if (!fired || typeof fired !== "object")
        return undefined;
    const pruned = count(fired.prunedResults);
    const reinjected = fired.reinjected === true;
    return pruned || reinjected
        ? { prunedResults: pruned, reinjected, savedTokens: count(fired.savedTokens), addedTokens: count(fired.addedTokens) }
        : undefined;
}
function routedModelReported(update) {
    const routed = update._meta?.fx?.routedModel;
    if (!routed || typeof routed !== "object" || typeof routed.model !== "string" || !routed.model)
        return undefined;
    return { model: routed.model.slice(0, 256), fellBack: routed.fellBack === true };
}
function contextBreakdownReported(update) {
    const parts = update._meta?.fx?.contextBreakdown;
    if (!parts || typeof parts !== "object")
        return undefined;
    return {
        systemPromptBytes: count(parts.systemPromptBytes),
        systemToolsBytes: count(parts.systemToolsBytes),
        mcpToolsBytes: count(parts.mcpToolsBytes),
        skillsBytes: count(parts.skillsBytes),
        memoryBytes: count(parts.memoryBytes),
    };
}
function turnUsageReported(update) {
    const usage = update._meta?.fx?.turnUsage;
    if (!usage || typeof usage !== "object")
        return undefined;
    return { inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens) };
}
exports.HARNESS_MODE_ID = "ask";
const harnessKey = (cwd, nestedThreadId, providerId) => [cwd, ...(nestedThreadId ? [nestedThreadId] : []), ...(providerId ? [`@${providerId}`] : [])].join("\u0000");
exports.harnessKey = harnessKey;
const SESSION_INDEX = "emma-sessions.json";
const sessionIndexes = new Map();
function sessionIndex(home) {
    const loaded = sessionIndexes.get(home);
    if (loaded)
        return loaded;
    const known = new Map();
    try {
        const raw = JSON.parse((0, node_fs_1.readFileSync)(node_path_1.default.join(home, SESSION_INDEX), "utf8"));
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            for (const [threadId, sessionId] of Object.entries(raw)) {
                if (typeof sessionId === "string" && sessionId.length > 0)
                    known.set(threadId, sessionId);
            }
        }
    }
    catch (error) {
        if (error.code !== "ENOENT")
            console.error("Emma: could not read the harness session index", error);
    }
    sessionIndexes.set(home, known);
    return known;
}
function saveSessionIndex(home) {
    const known = sessionIndexes.get(home);
    if (!known)
        return;
    try {
        (0, node_fs_1.mkdirSync)(home, { recursive: true });
        (0, node_fs_1.writeFileSync)(node_path_1.default.join(home, SESSION_INDEX), JSON.stringify(Object.fromEntries(known)));
    }
    catch (error) {
        console.error("Emma: could not save the harness session index", error);
    }
}
class Harness {
    deps;
    child;
    stderrTail = "";
    lines = new ndjson_1.BoundedLines(MAX_LINE_BYTES);
    pending = new Map();
    threadsBySession = new Map();
    active;
    turns = Promise.resolve();
    calls = new Map();
    children = new Map();
    modes = new Map();
    nextId = 1;
    rebind = false;
    cancelled = new Set();
    failure;
    heardAt = 0;
    constructor(deps) {
        this.deps = deps;
    }
    get running() {
        return this.child !== undefined && this.failure === undefined;
    }
    get busy() {
        return this.pending.size > 0 || [...this.children.values()].some((child) => !child.ended);
    }
    get silentFor() {
        return this.heardAt ? Date.now() - this.heardAt : Infinity;
    }
    get state() {
        return {
            cwd: this.deps.cwd,
            running: this.running,
            busy: this.busy,
            silentMs: this.heardAt ? Date.now() - this.heardAt : 0,
            failure: this.failure?.message ?? "",
        };
    }
    log(flow, label, body) {
        this.deps.onLog?.({ at: Date.now(), flow, label, body: body.slice(0, harness_log_1.MAX_LOG_BODY) });
    }
    async start() {
        if (this.child)
            return;
        const key = this.deps.apiKey ? { AI_GATEWAY_API_KEY: this.deps.apiKey, EMMA_PROVIDER_API_KEY: this.deps.apiKey } : {};
        const route = this.deps.chatUrl ? { EMMA_PROVIDER_CHAT_URL: this.deps.chatUrl } : {};
        const child = (0, node_child_process_1.spawn)(this.deps.binaryPath, this.deps.args ?? ["acp"], {
            cwd: this.deps.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, HOME: this.deps.home, ...key, ...route },
        });
        this.child = child;
        child.stdout.on("data", (data) => {
            try {
                for (const line of this.lines.push(data))
                    this.receive(line);
            }
            catch (error) {
                this.fail(error);
            }
        });
        child.stderr.on("data", (data) => {
            const text = String(data).trim();
            this.stderrTail = `${this.stderrTail}\n${text}`.slice(-MAX_STDERR_TAIL);
            console.error(`emma-cli: ${text}`);
            this.log("err", "stderr", text);
        });
        child.once("error", (error) => this.fail(error));
        child.once("exit", (code, signal) => this.fail(new Error(this.exitReason(code, signal))));
        try {
            await this.request("initialize", {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
            });
        }
        catch (error) {
            this.fail(error);
            this.close();
            throw error;
        }
    }
    async prompt(threadId, cwd, text, mode, model, extra = {}) {
        if (cwd !== this.deps.cwd)
            throw new Error(`Harness is bound to ${this.deps.cwd}, not ${cwd}`);
        this.cancelled.delete(threadId);
        const turn = this.turns.catch(() => undefined).then(() => this.runPrompt(threadId, cwd, text, mode, model, extra));
        this.turns = turn.catch(() => undefined);
        return await turn;
    }
    async runPrompt(threadId, cwd, text, mode, model, extra = {}) {
        await this.start();
        const opening = !this.sessions.has(threadId);
        const sessionId = await this.activeSession(threadId, cwd);
        this.modes.set(threadId, mode);
        if (opening)
            await this.lifecycle("SessionStart", threadId, sessionId, mode, model, { source: "startup" });
        await this.request("session/set_mode", { sessionId, modeId: exports.HARNESS_MODE_ID });
        if (model)
            await this.request("session/set_config_option", { sessionId, configId: "model", value: model });
        if (extra.contextWindow) {
            await this.request("session/set_config_option", { sessionId, configId: "context_window", value: String(extra.contextWindow) });
        }
        if (extra.effort) {
            await this.request("session/set_config_option", { sessionId, configId: "reasoning_effort", value: (0, exports.effortOption)(extra.effort) });
        }
        if (extra.experiments) {
            await this.request("session/set_config_option", { sessionId, configId: "context_experiments", value: (0, exports.experimentOption)(extra.experiments) });
        }
        if (extra.compact) {
            await this.request("session/compact", { sessionId }).catch((error) => console.error("Emma: the harness would not compact", error));
        }
        const prompt = extra.continueRecovery ? [] : [
            ...(extra.skillContext ? [{ type: "text", text: extra.skillContext }] : []),
            { type: "text", text },
            ...(extra.images ?? []).map((file) => ({ type: "image", mimeType: mediaType(file), uri: (0, node_url_1.pathToFileURL)(file).href })),
        ];
        if (this.cancelled.delete(threadId))
            throw new Error("This turn was stopped before it reached the model.");
        await this.lifecycle("UserPromptSubmit", threadId, sessionId, mode, model, { prompt: text });
        const result = (await this.request("session/prompt", {
            sessionId,
            prompt,
            ...(extra.continueRecovery ? { _meta: { fx: { continueRecovery: true } } } : {}),
        }));
        const stopReason = (result?.stopReason ?? "end_turn");
        await this.lifecycle("Stop", threadId, sessionId, mode, model, { stop_hook_active: false, stop_reason: stopReason });
        return {
            stopReason,
            usage: { inputTokens: count(result?.usage?.inputTokens), outputTokens: count(result?.usage?.outputTokens) },
        };
    }
    async lifecycle(event, threadId, sessionId, mode, model, extra) {
        if (!this.deps.onLifecycle)
            return;
        await this.deps.onLifecycle(event, threadId, {
            session_id: sessionId,
            transcript_path: null,
            cwd: this.deps.cwd,
            hook_event_name: event,
            permission_mode: mode,
            model: model ?? "",
            ...extra,
        }).catch((error) => console.error(`Emma: a ${event} plugin hook could not be run`, error));
    }
    async cancel(threadId) {
        this.cancelled.add(threadId);
        const sessionId = this.sessions.get(threadId);
        if (!sessionId || sessionId !== this.active || !this.running)
            return;
        this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    }
    async steer(threadId, content) {
        const sessionId = this.sessions.get(threadId);
        if (!sessionId || sessionId !== this.active || !this.running)
            return false;
        await this.request("session/steer", { sessionId, content });
        return true;
    }
    async steerChild(childId, content) {
        await this.request("session/steer_child", { childId, content });
    }
    async cancelChild(childId) {
        await this.request("session/cancel_child", { childId });
    }
    exitReason(code, signal) {
        const said = this.stderrTail.split("\n").map((line) => line.trim()).filter(Boolean);
        const detail = said.find((line) => /panic|unreachable|error:/i.test(line)) ?? said.at(-1);
        const how = signal ? `was killed by ${signal}` : `exited with code ${code ?? "unknown"}`;
        return `emma-cli ${how}${detail ? `: ${detail}` : ""}`;
    }
    close() {
        this.fail(new Error("Harness closed"));
        const child = this.child;
        this.child = undefined;
        if (!child)
            return;
        if (!child.stdin.destroyed)
            child.stdin.end();
        if (!child.killed)
            child.kill();
    }
    get sessions() {
        return sessionIndex(this.deps.home);
    }
    remember() {
        saveSessionIndex(this.deps.home);
    }
    async activeSession(threadId, cwd) {
        const sessionId = await this.session(threadId, cwd);
        if (this.active === sessionId && !this.rebind)
            return sessionId;
        try {
            await this.request("session/resume", { sessionId, mcpServers: await this.deps.mcpServers(threadId) });
            this.active = sessionId;
            this.rebind = false;
            return sessionId;
        }
        catch (error) {
            console.error("Emma: could not resume the harness session for this thread, starting a new one", error);
            this.sessions.delete(threadId);
            this.threadsBySession.delete(sessionId);
            this.remember();
            return await this.session(threadId, cwd);
        }
    }
    async session(threadId, cwd) {
        const existing = this.sessions.get(threadId);
        if (existing) {
            this.threadsBySession.set(existing, threadId);
            return existing;
        }
        const result = await this.request("session/new", { cwd, mcpServers: await this.deps.mcpServers(threadId) });
        const sessionId = result?.sessionId;
        if (typeof sessionId !== "string" || sessionId.length === 0)
            throw new Error("Harness returned no session id");
        this.sessions.set(threadId, sessionId);
        this.threadsBySession.set(sessionId, threadId);
        this.remember();
        this.active = sessionId;
        return sessionId;
    }
    forgetSession(threadId) {
        this.sessions.delete(threadId);
        this.remember();
    }
    rebindServers() {
        this.rebind = true;
    }
    request(method, params) {
        if (this.failure)
            return Promise.reject(this.failure);
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!this.pending.delete(id))
                    return;
                reject(new Error(`Harness call ${method} timed out`));
            }, this.deps.idleMs ?? exports.MAX_IDLE_MS);
            timer.unref?.();
            this.pending.set(id, { resolve, reject, touch: () => timer.refresh() });
            this.send({ jsonrpc: "2.0", id, method, params });
        });
    }
    send(message) {
        const child = this.child;
        if (!child)
            throw this.failure ?? new Error("Harness is not running");
        this.log("out", wireLabel(message), JSON.stringify(message));
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
            if (error)
                this.fail(error);
        });
    }
    receive(line) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            return;
        const message = JSON.parse(trimmed);
        if (!streamedChunk(message))
            this.log("in", wireLabel(message), trimmed);
        this.heardAt = Date.now();
        for (const call of this.pending.values())
            call.touch();
        if (typeof message.method === "string") {
            void this.handleIncoming(message);
            return;
        }
        if (typeof message.id !== "number")
            return;
        const pending = this.pending.get(message.id);
        if (!pending)
            return;
        this.pending.delete(message.id);
        if (message.error) {
            const detail = message.error.message ?? "Harness call failed";
            pending.reject(new Error(detail));
            return;
        }
        pending.resolve(message.result ?? null);
    }
    async handleIncoming(message) {
        const method = message.method;
        const params = (message.params ?? {});
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
    handleUpdate(params) {
        const threadId = this.threadsBySession.get(String(params.sessionId ?? ""));
        if (!threadId)
            return;
        const update = (params.update ?? {});
        const child = childTag(update);
        if (child) {
            const owner = this.childThread(threadId, child);
            if (child.ended)
                this.noteChildEnded(`${threadId}/${child.id}`);
            void owner
                .then((childThreadId) => {
                this.applyUpdate(childThreadId, update);
                if (child.ended)
                    this.deps.onChildEnd(childThreadId);
            })
                .catch(() => undefined);
            return;
        }
        this.applyUpdate(threadId, update);
    }
    childThread(parentThreadId, child) {
        const key = `${parentThreadId}/${child.id}`;
        const known = this.children.get(key);
        if (known)
            return known.thread;
        const created = this.deps.onChildStart({ parentThreadId, childId: child.id, title: child.title });
        this.children.set(key, { thread: created, ended: false });
        return created;
    }
    noteChildEnded(key) {
        const known = this.children.get(key);
        if (known)
            known.ended = true;
    }
    applyUpdate(threadId, update) {
        switch (update.sessionUpdate) {
            case "agent_message_chunk":
            case "agent_thought_chunk": {
                const content = (update.content ?? {});
                if (typeof content.text !== "string")
                    return;
                const to = update.sessionUpdate === "agent_thought_chunk" ? this.deps.onThought : this.deps.onDelta;
                to(threadId, content.text);
                return;
            }
            case "tool_call":
            case "tool_call_update": {
                const toolCallId = String(update.toolCallId ?? "");
                const key = `${threadId}:${toolCallId}`;
                const known = this.calls.get(key);
                const call = {
                    threadId,
                    toolCallId,
                    title: toolCallText(update.title) ?? known?.title ?? "",
                    kind: toolCallText(update.kind) ?? known?.kind ?? "other",
                    status: update.status ?? known?.status ?? "pending",
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
                const recovery = (update._meta?.fx?.modelResponseRecovery ?? null);
                if (!recovery || typeof recovery.message !== "string")
                    return;
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
    async handlePermission(id, params) {
        const threadId = this.threadsBySession.get(String(params.sessionId ?? ""));
        const options = Array.isArray(params.options) ? params.options : [];
        if (!threadId) {
            this.send({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
            return;
        }
        const child = childTag(params);
        const asking = child ? await this.childThread(threadId, child).catch(() => threadId) : threadId;
        const call = (params.toolCall ?? {});
        const title = String(call.title ?? "tool");
        const named = title === "file_mutation" ? describePath(call.rawInput) ?? title : title;
        const ask = {
            id: String(call.toolCallId ?? id),
            threadId: asking,
            tool: named,
            summary: named === title ? String(call.title ?? "This run wants to use a tool.") : `writing ${named}`,
            detail: typeof call.rawInput === "string" ? call.rawInput : JSON.stringify(call.rawInput ?? {}, null, 2).slice(0, 4096),
        };
        const context = {
            outsideWorkspace: callEscapesWorkspace(this.deps.cwd, call.rawInput),
            mode: this.modes.get(threadId) ?? "ask",
            kind: String(call.kind ?? "other"),
        };
        let chosen;
        try {
            chosen = await this.deps.onPermission(ask, options, context);
        }
        catch {
            chosen = null;
        }
        this.send({
            jsonrpc: "2.0",
            id,
            result: chosen ? { outcome: { outcome: "selected", optionId: chosen } } : { outcome: { outcome: "cancelled" } },
        });
    }
    async handleToolRequest(id, params) {
        const threadId = this.threadsBySession.get(String(params.sessionId ?? ""));
        const name = typeof params.name === "string" ? params.name : "";
        const args = (params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
            ? params.arguments
            : {});
        if (!threadId || !name) {
            this.send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown session or tool" } });
            return;
        }
        let output;
        try {
            output = await this.deps.onToolRequest(threadId, name, args);
        }
        catch (error) {
            output = error instanceof Error ? error.message : String(error);
        }
        this.send({ jsonrpc: "2.0", id, result: { output: output.slice(0, MAX_TOOL_OUTPUT_BYTES) } });
    }
    fail(error) {
        if (!this.failure)
            this.log("err", "stopped", error.message);
        this.failure ??= error;
        for (const pending of this.pending.values())
            pending.reject(this.failure);
        this.pending.clear();
        this.threadsBySession.clear();
        this.active = undefined;
        this.calls.clear();
        for (const [key, child] of this.children) {
            if (child.ended)
                continue;
            this.noteChildEnded(key);
            void child.thread.then((threadId) => this.deps.onChildEnd(threadId, error.message)).catch(() => undefined);
        }
    }
}
exports.Harness = Harness;
const PATH_FIELDS = ["path", "paths", "old_path", "new_path", "source", "destination", "cwd"];
const exists = (candidate) => {
    try {
        (0, node_fs_1.statSync)(candidate);
        return true;
    }
    catch {
        return false;
    }
};
function escapesRoot(root, value) {
    let real;
    try {
        real = (0, node_fs_1.realpathSync)(root);
    }
    catch {
        return true;
    }
    const target = node_path_1.default.isAbsolute(value) ? node_path_1.default.resolve(value) : node_path_1.default.resolve(real, value);
    if (target !== real && !target.startsWith(real + node_path_1.default.sep))
        return true;
    let existing = target;
    while (existing !== real && existing.startsWith(real + node_path_1.default.sep) && !exists(existing)) {
        existing = node_path_1.default.dirname(existing);
    }
    try {
        const resolved = (0, node_fs_1.realpathSync)(existing);
        return resolved !== real && !resolved.startsWith(real + node_path_1.default.sep);
    }
    catch {
        return true;
    }
}
function callEscapesWorkspace(root, rawInput) {
    if (typeof rawInput !== "object" || rawInput === null)
        return false;
    const args = rawInput;
    for (const field of PATH_FIELDS) {
        const value = args[field];
        if (typeof value === "string" && value.length > 0 && escapesRoot(root, value))
            return true;
        if (Array.isArray(value)) {
            for (const entry of value) {
                if (typeof entry === "string" && entry.length > 0 && escapesRoot(root, entry))
                    return true;
            }
        }
    }
    return false;
}
function childTag(update) {
    const child = (update._meta?.fx?.child ?? null);
    if (!child || typeof child.id !== "string" || child.id.length === 0)
        return undefined;
    return {
        id: child.id,
        title: typeof child.title === "string" && child.title.trim() ? child.title.trim().slice(0, 120) : "Subagent",
        ended: child.state === "ended",
    };
}
function rawInput(value) {
    if (value === undefined || value === null)
        return undefined;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.slice(0, 4096);
}
function describePath(rawInput) {
    if (typeof rawInput !== "object" || rawInput === null)
        return undefined;
    const args = rawInput;
    for (const field of ["path", "new_path", "destination", "old_path", "source"]) {
        const value = args[field];
        if (typeof value === "string" && value.length > 0)
            return value.slice(0, 256);
    }
    return undefined;
}
function toolCallText(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
function toolOutput(content) {
    if (!Array.isArray(content))
        return undefined;
    const parts = [];
    for (const block of content) {
        const inner = block.content;
        if (inner && inner.type === "text" && typeof inner.text === "string")
            parts.push(inner.text);
    }
    return parts.length ? unwrapMcpResult(parts.join("\n")) : undefined;
}
function mcpText(blocks) {
    if (!Array.isArray(blocks))
        return undefined;
    const parts = [];
    for (const block of blocks) {
        const one = block;
        if (one?.type === "text" && typeof one.text === "string")
            parts.push(one.text);
    }
    return parts.length ? parts.join("\n") : undefined;
}
function unwrapMcpResult(text) {
    if (!text.startsWith("{"))
        return text;
    try {
        const envelope = JSON.parse(text);
        if (typeof envelope?.tool !== "string")
            return text;
        return mcpText(envelope.result?.content) ?? text;
    }
    catch {
        return cutMcpText(text) ?? text;
    }
}
function cutMcpText(text) {
    if (!text.startsWith('{"server":"') || !text.includes('"tool":"'))
        return undefined;
    const opener = text.indexOf('"text":"');
    if (opener < 0)
        return undefined;
    return text
        .slice(opener + '"text":"'.length)
        .replace(/\\$/, "")
        .replace(/\\(["\\/bfnrt])/g, (_, escape) => ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[escape] ?? escape));
}
