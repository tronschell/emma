import test from "node:test";
import assert from "node:assert/strict";
import { handleRpc, startBridge, threadOf, type BridgeDeps } from "../main/bridge";

const deps = (call: BridgeDeps["call"] = async () => "ok"): BridgeDeps => ({
  tools: () => [{ name: "install_mcp", description: "Install an MCP server.", inputSchema: { type: "object", properties: {}, required: [] } }],
  call,
});

test("a request names the thread it is for", () => {
  assert.equal(threadOf("/mcp/thread-1"), "thread-1");
  assert.equal(threadOf("/mcp/thread%201?x=1"), "thread 1");
  // Nothing else is a valid door: no thread means no turn to run a tool against.
  assert.equal(threadOf("/mcp"), undefined);
  assert.equal(threadOf("/mcp/a/b"), undefined);
  assert.equal(threadOf("/"), undefined);
  assert.equal(threadOf(undefined), undefined);
});

test("discovery answers with the version the harness looks for", async () => {
  const result = await handleRpc(deps(), "t", { id: 1, method: "server/discover" }) as { result: Record<string, unknown> };
  // The harness falls back to the legacy `initialize` handshake unless it sees
  // its own protocol version here, and only the modern path skips the
  // `notifications/initialized` round trip this server does not answer.
  assert.deepEqual(result.result.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(result.result.capabilities, { tools: {} });
});

test("the tool list is whatever Emma has for that thread, not a fixed table", async () => {
  const seen: string[] = [];
  const result = await handleRpc(
    { tools: (threadId) => { seen.push(threadId); return [{ name: "workflow", description: "d", inputSchema: {} }]; }, call: async () => "" },
    "thread-9",
    { id: 2, method: "tools/list" },
  ) as { result: { tools: { name: string }[]; ttlMs: number } };
  assert.deepEqual(seen, ["thread-9"]);
  assert.deepEqual(result.result.tools.map((tool) => tool.name), ["workflow"]);
  // A finite TTL is what lets a server installed mid-turn show up: the harness
  // re-lists after it, and never otherwise.
  assert.ok(result.result.ttlMs > 0);
});

test("a tool that throws comes back as a result the model can read, not a transport error", async () => {
  const result = await handleRpc(deps(async () => { throw new Error("that server is already installed"); }), "t", {
    id: 3,
    method: "tools/call",
    params: { name: "install_mcp", arguments: { name: "notes" } },
  }) as { result: { isError?: boolean; content: { text: string }[] }; error?: unknown };
  // A JSON-RPC error would read as the whole server being broken and take every
  // other Emma tool down with it for the rest of the session.
  assert.equal(result.error, undefined);
  assert.equal(result.result.isError, true);
  assert.equal(result.result.content[0].text, "that server is already installed");
});

test("arguments reach the tool, and a missing object is not a crash", async () => {
  const calls: unknown[] = [];
  const run = (params: unknown) => handleRpc(deps(async (_t, name, args) => { calls.push([name, args]); return "done"; }), "t", { id: 4, method: "tools/call", params });
  await run({ name: "install_mcp", arguments: { name: "notes", command: "npx" } });
  await run({ name: "install_mcp" });
  await run({ name: "install_mcp", arguments: ["not", "an", "object"] });
  assert.deepEqual(calls, [
    ["install_mcp", { name: "notes", command: "npx" }],
    ["install_mcp", {}],
    ["install_mcp", {}],
  ]);
});

test("a notification wants no answer", async () => {
  assert.equal(await handleRpc(deps(), "t", { method: "notifications/initialized" }), undefined);
});

test("a request without the token never reaches a tool", async () => {
  let ran = 0;
  const bridge = startBridge(deps(async () => { ran += 1; return "ok"; }));
  try {
    const url = await bridge.url("thread-1");
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "install_mcp", arguments: {} } });

    const anonymous = await fetch(url, { method: "POST", body });
    assert.equal(anonymous.status, 401);
    assert.equal(ran, 0);

    const wrong = await fetch(url, { method: "POST", body, headers: { authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
    assert.equal(ran, 0);

    // Localhost is not a boundary: every other process on this Mac can reach an
    // ephemeral port, and Emma's tools install servers and edit files.
    const allowed = await fetch(url, { method: "POST", body, headers: { authorization: `Bearer ${bridge.token}` } });
    assert.equal(allowed.status, 200);
    assert.equal(ran, 1);
  } finally {
    bridge.close();
  }
});

test("a URL for an unknown path is refused rather than served the first thread", async () => {
  const bridge = startBridge(deps());
  try {
    const url = new URL(await bridge.url("thread-1"));
    const response = await fetch(`${url.origin}/mcp`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${bridge.token}` } });
    assert.equal(response.status, 404);
  } finally {
    bridge.close();
  }
});
