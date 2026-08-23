#!/usr/bin/env node
// A stand-in for `emma-cli acp`, so Emma's harness client can be tested without
// the 25 MB binary or a model. It speaks just enough ACP to exercise one full
// turn: initialize, a session, a streamed chunk, a tool call, a permission
// round trip, and a stop reason.

import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (sessionId, update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });

let permissionReply;
// The real harness keeps exactly one session: `session/new` and `session/resume`
// replace it, and `session/prompt` runs against it whatever `sessionId` the call
// names. Modelled here because that is the shape that broke a thread sharing a
// process with another one.
let active;
let sessions = 0;

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  // A reply to the permission question this fixture asked.
  if (message.id === 99 && message.result) {
    permissionReply?.(message.result);
    return;
  }

  const { id, method, params } = message;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (method === "session/new") {
    sessions += 1;
    active = `sess_${sessions}_${params.cwd.split("/").pop()}`;
    send({ jsonrpc: "2.0", id, result: { sessionId: active } });
    return;
  }
  if (method === "session/resume") {
    // Only a session this fixture handed out can be restored; anything else is
    // the pruned-log case the client falls back from.
    if (!/^sess_\d+_/.test(params.sessionId ?? "")) {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown session" } });
      return;
    }
    active = params.sessionId;
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "session/set_mode") {
    // Echo the mode back as a chunk so the test can assert what Emma sent.
    notify(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `mode=${params.modeId} ` } });
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  // Folding the older turns away. Echoed as a chunk, like the mode above, so a
  // test can assert both that Emma asked and that it asked before the prompt.
  if (method === "session/compact") {
    notify(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "compacted " } });
    send({ jsonrpc: "2.0", id, result: { compacted: true, summarizedTurns: 3, remainingTurns: 1 } });
    return;
  }
  // Steering a running subagent. Answered here rather than in the prompt branch
  // because it has to be admitted while that prompt is still in flight.
  if (method === "session/steer_child") {
    if (params.childId !== "child_1" || typeof params.content !== "string" || !params.content) {
      send({ jsonrpc: "2.0", id, error: { code: -32600, message: "child_unavailable" } });
    } else {
      send({ jsonrpc: "2.0", id, result: null });
    }
    return;
  }
  if (method === "session/prompt") {
    // The active session, not the one the call names — the harness reads
    // `state.active_session` and never compares it against the request.
    const sessionId = active;
    // A turn that takes far longer than one idle window, streaming the whole
    // time — the shape of a real multi-subagent build.
    if (params.prompt.some((part) => part.text?.includes("slow"))) {
      for (let i = 0; i < 8; i++) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } });
      }
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: {} } });
      return;
    }
    // A subagent, which has no ACP session of its own: it rides this one tagged
    // with `_meta.fx.child`, and the client fans it back out onto its own thread.
    if (params.prompt.some((part) => part.text?.includes("subagent"))) {
      const tag = (state) => ({ _meta: { fx: { child: { id: "child_1", title: "read the docs", state } } } });
      notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "parent speaks" } });
      notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child speaks" }, ...tag("running") });
      notify(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_1", title: "read", kind: "read", status: "pending", ...tag("running") });
      notify(sessionId, { sessionUpdate: "session_info_update", ...tag("ended") });
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
    // `usage` is Emma's extension on the ACP result: without it a harness turn
    // records zero output tokens and the thread's rate reads as 0 tok/s.
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { inputTokens: 1234, outputTokens: 56 } } });
    return;
  }
  if (method === "session/cancel") return;
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported" } });
});
