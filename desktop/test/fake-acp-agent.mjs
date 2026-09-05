#!/usr/bin/env node

import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (sessionId, update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });

let permissionReply;
let toolReply;

let active;
let sessions = 0;

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (message.id === 99 && message.result) {
    permissionReply?.(message.result);
    return;
  }

  if (message.id === 98 && (message.result || message.error)) {
    toolReply?.(message);
    return;
  }

  const { id, method, params } = message;
  if (method === "initialize") {
    if ((process.env.HOME ?? "").includes("refused")) {
      send({ jsonrpc: "2.0", id, error: { code: -32600, message: "no credential" } });
      return;
    }
    send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (method === "session/new") {
    sessions += 1;
    active = `sess_${sessions}_${params.cwd.split("/").pop()}`;
    send({ jsonrpc: "2.0", id, result: { sessionId: active } });
    if ((process.env.HOME ?? "").includes("stale-recovery")) {
      notify(active, {
        sessionUpdate: "session_info_update",
        _meta: { fx: { modelResponseRecovery: { state: "paused", message: "⚠ Network interrupted · NetworkInterrupted · recovery paused after 1/10 attempts", attempt: 1, attemptLimit: 10 } } },
      });
    }
    return;
  }
  if (method === "session/resume") {

    if (!/^sess_\d+_/.test(params.sessionId ?? "")) {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown session" } });
      return;
    }
    active = params.sessionId;
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "session/set_mode") {

    notify(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `mode=${params.modeId} ` } });
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "session/set_config_option") {
    notify(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `cfg:${params.configId}=${params.value} ` } });
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "session/compact") {
    notify(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "compacted " } });
    send({ jsonrpc: "2.0", id, result: { compacted: true, summarizedTurns: 3, remainingTurns: 1 } });
    return;
  }

  if (method === "session/steer_child") {
    if (params.childId !== "child_1" || typeof params.content !== "string" || !params.content) {
      send({ jsonrpc: "2.0", id, error: { code: -32600, message: "child_unavailable" } });
    } else {
      send({ jsonrpc: "2.0", id, result: null });
    }
    return;
  }
  if (method === "session/prompt") {

    const sessionId = active;

    if (params.prompt.some((part) => part.text?.includes("slow"))) {
      for (let i = 0; i < 8; i++) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } });
      }
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: {} } });
      return;
    }

    if (params.prompt.some((part) => part.text?.includes("longtool"))) {
      notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_1", title: "bash", kind: "execute", status: "in_progress" });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed", content: [{ type: "content", content: { type: "text", text: "slept" } }] });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: {} } });
      return;
    }

    if (params.prompt.some((part) => part.text?.includes("filtered"))) {
      notify(sessionId, {
        sessionUpdate: "session_info_update",
        _meta: { fx: { modelResponseRecovery: { state: "paused", kind: "content_filter", requiredAction: "change_request", message: "⚠ blocked · content filter · change the request" } } },
      });
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: "ModelError" } });
      return;
    }

    if (params.prompt.some((part) => part.text?.includes("wedge"))) {
      notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wedged" } });
      return;
    }
    if (params.prompt.some((part) => part.text?.startsWith("computer "))) {
      const scenario = params.prompt.find((part) => part.text?.startsWith("computer ")).text.slice("computer ".length);
      const childTag = { _meta: { fx: { child: { id: "child_1", title: "read the docs", state: "running" } } } };
      if (scenario !== "unknown" && scenario !== "stale") {
        notify(sessionId, {
          sessionUpdate: "tool_call", toolCallId: "computer_call", title: "Using computer", kind: "other", status: "pending",
          ...(scenario === "child" ? childTag : {}),
        });
      }
      if (scenario === "completed") notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "computer_call", status: "completed" });
      const callIds = scenario === "prime" ? []
        : scenario === "child" ? ["child_1"]
        : scenario === "oldchild" ? ["child_1", "computer_call"]
        : scenario === "replay" ? ["computer_call", "computer_call"]
        : scenario === "unknown" ? ["unknown_call"]
        : ["computer_call"];
      for (const toolCallId of callIds) {
        const reply = await new Promise((resolve) => {
          toolReply = resolve;
          send({ jsonrpc: "2.0", id: 98, method: "_emma/callTool", params: { sessionId, toolCallId, name: "computer", arguments: { action: "list_apps" } } });
        });
        notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `computer:${reply.result?.output ?? reply.error?.message}` } });
      }
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: {} } });
      return;
    }

    if (params.prompt.some((part) => part.text?.includes("orphan"))) {
      const tag = { _meta: { fx: { child: { id: "child_1", title: "read the docs", state: "running" } } } };
      notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still reading" }, ...tag });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: {} } });
      return;
    }

    if (params.prompt.some((part) => part.text?.includes("subagent"))) {
      const tag = (state) => ({ _meta: { fx: { child: { id: "child_1", title: "read the docs", state } } } });
      notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "parent speaks" } });
      notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child speaks" }, ...tag("running") });
      notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_1", title: "read", kind: "read", status: "pending", ...tag("running") });
      notify(sessionId, { sessionUpdate: "session_info_update", _meta: { fx: { turnUsage: { inputTokens: 777, outputTokens: 42 }, child: { id: "child_1", title: "read the docs", state: "running" } } } });
      notify(sessionId, { sessionUpdate: "session_info_update", ...tag("ended") });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: {} } });
      return;
    }

    if (params.prompt.some((part) => part.text?.includes("childask"))) {
      const tag = (state) => ({ _meta: { fx: { child: { id: "child_1", title: "read the docs", state } } } });
      notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_1", title: "file_mutation", kind: "edit", status: "pending", ...tag("running") });
      const outcome = await new Promise((resolve) => {
        permissionReply = resolve;
        send({
          jsonrpc: "2.0",
          id: 99,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId: "call_1", title: "file_mutation", kind: "edit", rawInput: { path: "index.html" } },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject_once", name: "Reject", kind: "reject_once" },
            ],
            ...tag("running"),
          },
        });
      });
      const allowed = outcome?.outcome?.outcome === "selected";
      notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: allowed ? "child wrote it" : "child denied" }, ...tag("running") });
      notify(sessionId, { sessionUpdate: "session_info_update", ...tag("ended") });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: {} } });
      return;
    }

    if (params.prompt.some((part) => part.text?.includes("emmatool"))) {
      const reply = await new Promise((resolve) => {
        toolReply = resolve;
        send({
          jsonrpc: "2.0",
          id: 98,
          method: "_emma/callTool",
          params: {

            sessionId: params.prompt.some((part) => part.text?.includes("nosession")) ? "sess_nobody" : sessionId,
            toolCallId: "call_1",
            name: "threads",
            arguments: { action: "list", limit: 5 },
          },
        });
      });
      const text = reply.error ? `error:${reply.error.message}` : `output:${reply.result.output.length}:${reply.result.output.slice(0, 12)}`;
      notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: {} } });
      return;
    }

    notify(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "weighing it up" } });
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "thinking " } });
    notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_1", title: "bash", kind: "execute", status: "pending" });

    const outcome = await new Promise((resolve) => {
      permissionReply = resolve;
      send({
        jsonrpc: "2.0",
        id: 99,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "call_1", title: "bash", rawInput: { command: "echo hi" } },
          options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject_once", name: "Reject", kind: "reject_once" },
          ],
        },
      });
    });

    const allowed = outcome?.outcome?.outcome === "selected" && outcome.outcome.optionId === "allow_once";
    notify(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: allowed ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: allowed ? "hi" : "denied" } }],
    });
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });

    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { inputTokens: 1234, outputTokens: 56 } } });
    return;
  }
  if (method === "session/cancel") return;
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported" } });
});
