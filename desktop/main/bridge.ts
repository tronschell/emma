/* Emma's own tools, served to the harness as an MCP server.
 *
 * The harness runs its own loop with its own builtins, so on that path none of
 * Emma's tools existed — no `install_mcp`, no workflows, no threads, no kb. The
 * only door the harness leaves open for tools it does not ship is MCP, so this
 * is that door: one localhost HTTP server, spoken to over the modern MCP
 * protocol, whose tools are whatever `deps.tools` says Emma has this turn.
 *
 * Transport is deliberately the smallest thing the harness's client accepts:
 * POST, one JSON-RPC object in, one JSON object out, no SSE and no session ids.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

/** What the harness announces support for; anything else and it falls back to `initialize`. */
const PROTOCOL = "2026-07-28";
/** The harness re-lists tools after this, which is how a mid-turn `install_mcp` shows up. */
const TTL_MS = 5_000;
/** A tool result the harness would truncate anyway, capped here so a runaway one cannot pin memory. */
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;

export type BridgeTool = { name: string; description: string; inputSchema: Record<string, unknown> };

export type BridgeDeps = {
  /** Emma's tools for this thread, already gated by its mode and grants. */
  tools: (threadId: string) => BridgeTool[] | Promise<BridgeTool[]>;
  /** Runs one; throwing is reported to the model as a failed tool call, not a transport error. */
  call: (threadId: string, name: string, args: Record<string, unknown>) => Promise<string>;
};

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

/** The thread a request is for. One server, one path segment per thread. */
export function threadOf(url: string | undefined): string | undefined {
  const [pathname] = (url ?? "").split("?");
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "mcp") return undefined;
  return decodeURIComponent(parts[1]) || undefined;
}

/**
 * Answers one JSON-RPC message.
 *
 * A tool that throws comes back as `isError` content rather than a JSON-RPC
 * error: the harness hands the first to the model to recover from and treats
 * the second as the server being broken.
 */
export async function handleRpc(deps: BridgeDeps, threadId: string, message: Rpc): Promise<Record<string, unknown> | undefined> {
  const { id, method } = message;
  const reply = (result: Record<string, unknown>) => ({ jsonrpc: "2.0", id, result });
  // A notification carries no id and wants no answer.
  if (id === undefined || id === null) return undefined;

  switch (method) {
    case "server/discover":
      return reply({
        resultType: "complete",
        supportedVersions: [PROTOCOL],
        capabilities: { tools: {} },
        serverInfo: { name: "emma", version: "1" },
        instructions: "Emma's own tools. They reach the app the user is looking at: its threads, knowledge base, scheduled tasks and configuration.",
      });
    case "initialize":
      // The legacy handshake, for a client that skips discovery.
      return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "emma", version: "1" } });
    case "tools/list":
      return reply({ resultType: "complete", ttlMs: TTL_MS, tools: await deps.tools(threadId) });
    case "tools/call": {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? params.arguments
        : {}) as Record<string, unknown>;
      try {
        const text = await deps.call(threadId, name, args);
        return reply({ resultType: "complete", content: [{ type: "text", text: text.slice(0, MAX_RESULT_BYTES) }] });
      } catch (error) {
        return reply({
          resultType: "complete",
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        });
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${String(method)}` } };
  }
}

export type Bridge = {
  /** The URL to hand the harness for one thread. Resolves once the port is known. */
  url: (threadId: string) => Promise<string>;
  /** The shared secret, so a second local process cannot drive Emma's tools. */
  token: string;
  close: () => void;
};

export function startBridge(deps: BridgeDeps): Bridge {
  // Localhost and an ephemeral port already keep this off the network; the token
  // is what keeps every other process on this Mac from calling Emma's tools.
  const token = randomBytes(24).toString("base64url");
  const server: Server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body ?? {});
      response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      response.end(text);
    };
    if (request.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
    const threadId = threadOf(request.url);
    if (!threadId) return send(404, { error: "unknown thread" });

    let body = "";
    let oversize = false;
    request.on("data", (chunk: Buffer) => {
      if (oversize) return;
      if (body.length + chunk.length > MAX_BODY_BYTES) { oversize = true; return; }
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      if (oversize) return send(200, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } });
      let message: Rpc;
      try { message = JSON.parse(body || "{}") as Rpc; }
      catch { return send(200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
      void handleRpc(deps, threadId, message)
        // An empty 200 rather than a 202: the harness's client treats any other
        // status as the server failing, notification or not.
        .then((result) => send(200, result ?? {}))
        .catch((error) => send(200, { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32603, message: String(error) } }));
    });
  });
  const port = new Promise<number>((resolve, reject) => {
    server.once("listening", () => resolve((server.address() as AddressInfo).port));
    server.once("error", reject);
  });
  server.listen(0, "127.0.0.1");
  server.unref();

  return {
    url: async (threadId) => `http://127.0.0.1:${await port}/mcp/${encodeURIComponent(threadId)}`,
    token,
    close: () => server.close(),
  };
}
