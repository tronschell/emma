import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const AUTH_FILE = join(homedir(), ".codex", "auth.json");
const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

const SIGN_IN = "Emma could not read a ChatGPT sign-in at ~/.codex/auth.json. Run `codex login` in a terminal and pick Sign in with ChatGPT, then send this again.";
const NOT_A_PLAN = "That sign-in stores an API key, not a ChatGPT plan. Run `codex logout` then `codex login` and pick Sign in with ChatGPT.";

export type ChatgptAuth = { accessToken: string; accountId: string };

type ChatMessage = {
  role?: string;
  content?: unknown;
  reasoning_details?: unknown;
  tool_call_id?: string;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
};

function claimedAccount(token: string): string {
  try {
    const body = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
    const auth = body["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined;
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : "";
  } catch {
    return "";
  }
}

export function readChatgptAuth(stored: unknown): ChatgptAuth {
  const tokens = (stored as { tokens?: { access_token?: unknown; account_id?: unknown } } | null)?.tokens;
  const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : "";
  if (!accessToken) throw new Error(NOT_A_PLAN);
  const accountId = typeof tokens?.account_id === "string" && tokens.account_id ? tokens.account_id : claimedAccount(accessToken);
  if (!accountId) throw new Error(NOT_A_PLAN);
  return { accessToken, accountId };
}

export async function chatgptAuth(): Promise<ChatgptAuth> {
  let stored: unknown;
  try {
    stored = JSON.parse(await readFile(AUTH_FILE, "utf8"));
  } catch {
    throw new Error(SIGN_IN);
  }
  return readChatgptAuth(stored);
}

const parts = (content: unknown) => Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];

const flatText = (content: unknown) => parts(content).map((part) => typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join("");

function inputContent(content: unknown): Record<string, string>[] {
  return parts(content).flatMap((raw): Record<string, string>[] => {
    const part = raw as { type?: string; text?: string; image_url?: { url?: string } };
    if (part.type === "image_url" && part.image_url?.url) return [{ type: "input_image", image_url: part.image_url.url }];
    return typeof part.text === "string" && part.text ? [{ type: "input_text", text: part.text }] : [];
  });
}

const isInstruction = (message: ChatMessage) => message.role === "system" || message.role === "developer";

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

export const retainsPromptCache = (model: string) => {
  const family = /^gpt-5(?:\.(\d+))?\b/.exec(model);
  return family ? Number(family[1] ?? 0) < 6 : false;
};

export function responsesRequest(body: Record<string, unknown>, withoutRetention = false): Record<string, unknown> {
  const messages = (Array.isArray(body.messages) ? body.messages : []) as ChatMessage[];
  let leading = 0;
  while (leading < messages.length && isInstruction(messages[leading])) leading += 1;
  const instructions = messages.slice(0, leading).map((message) => flatText(message.content)).join("\n\n");
  const input: unknown[] = [];
  for (const message of messages.slice(leading)) {
    if (isInstruction(message)) {
      const text = flatText(message.content);
      if (text) input.push({ type: "message", role: "developer", content: [{ type: "input_text", text }] });
      continue;
    }
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id ?? "", output: flatText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const text = flatText(message.content);
      const calls = message.tool_calls ?? [];
      const replayed = Array.isArray(message.reasoning_details) ? message.reasoning_details : [];
      if (!calls.length) input.push(...replayed);
      if (text) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      if (calls.length) input.push(...replayed);
      for (const call of calls) {
        input.push({ type: "function_call", call_id: call.id ?? "", name: call.function?.name ?? "", arguments: call.function?.arguments || "{}" });
      }
      continue;
    }
    const content = inputContent(message.content);
    if (content.length) input.push({ type: "message", role: "user", content });
  }
  const tools = (Array.isArray(body.tools) ? body.tools : []).flatMap((raw) => {
    const declared = (raw as { function?: { name?: string; description?: string; parameters?: unknown } }).function;
    if (!declared?.name) return [];
    return [{ type: "function", name: declared.name, description: declared.description ?? "", parameters: declared.parameters ?? { type: "object", properties: {} }, strict: false }];
  });
  const effort = typeof body.reasoning_effort === "string" ? body.reasoning_effort : "";
  const model = typeof body.model === "string" ? body.model : "";
  const maxOutput = count(body.max_output_tokens) || count(body.max_tokens);
  return {
    model,
    instructions,
    input,
    ...(maxOutput ? { max_output_tokens: maxOutput } : {}),
    ...(!withoutRetention && retainsPromptCache(model) ? { prompt_cache_retention: "24h" } : {}),
    ...(tools.length ? { tools, tool_choice: body.tool_choice ?? "auto", parallel_tool_calls: body.parallel_tool_calls === true } : {}),
    ...(effort ? { reasoning: { effort, summary: "auto" } } : {}),
    ...(typeof body.prompt_cache_key === "string" && body.prompt_cache_key ? { prompt_cache_key: body.prompt_cache_key } : {}),
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
  };
}

const uuidShaped = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

export const sessionIdFor = (body: Record<string, unknown>) =>
  typeof body.prompt_cache_key === "string" && body.prompt_cache_key ? uuidShaped(createHash("sha256").update(body.prompt_cache_key).digest("hex")) : randomUUID();

export function relayHeaders(auth: ChatgptAuth, body: Record<string, unknown>): Record<string, string> {
  const session = sessionIdFor(body);
  const keyed = typeof body.prompt_cache_key === "string" && body.prompt_cache_key !== "";
  return {
    authorization: `Bearer ${auth.accessToken}`,
    "chatgpt-account-id": auth.accountId,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    session_id: session,
    ...(keyed ? { "session-id": session, "thread-id": session } : {}),
    "content-type": "application/json",
    accept: "text/event-stream",
  };
}

export type ChunkState = { id: string; model: string; calls: Map<string, number>; calledTools: boolean; reasoning: unknown[] };

export const chunkState = (model: string): ChunkState => ({ id: `chatcmpl-${randomUUID()}`, model, calls: new Map(), calledTools: false, reasoning: [] });

function chatUsage(usage: unknown) {
  const totals = (usage ?? {}) as Record<string, unknown>;
  const details = (totals.input_tokens_details ?? {}) as Record<string, unknown>;
  return {
    prompt_tokens: count(totals.input_tokens),
    completion_tokens: count(totals.output_tokens),
    total_tokens: count(totals.total_tokens),
    prompt_tokens_details: { cached_tokens: count(details.cached_tokens), cache_creation_tokens: count(details.cache_write_tokens) },
  };
}

export function chatChunks(event: Record<string, unknown>, state: ChunkState): Record<string, unknown>[] {
  const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) => ({
    id: state.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });
  const replay = () => state.reasoning.length ? [chunk({ reasoning_details: state.reasoning.splice(0) })] : [];
  switch (event.type) {
    case "response.output_text.delta":
      return [chunk({ content: String(event.delta ?? "") })];
    case "response.reasoning_summary_text.delta":
      return [chunk({ reasoning: String(event.delta ?? "") })];
    case "response.output_item.done": {
      const item = event.item as { type?: string } | undefined;
      if (item?.type === "reasoning") state.reasoning.push(item);
      return [];
    }
    case "response.output_item.added": {
      const item = event.item as { type?: string; name?: string; call_id?: string; id?: string } | undefined;
      if (item?.type !== "function_call") return [];
      const index = state.calls.size;
      state.calls.set(String(event.item_id ?? item.id ?? index), index);
      state.calledTools = true;
      return [...replay(), chunk({ tool_calls: [{ index, id: item.call_id || item.id || `call_${index}`, type: "function", function: { name: item.name ?? "", arguments: "" } }] })];
    }
    case "response.function_call_arguments.delta": {
      const index = state.calls.get(String(event.item_id ?? ""));
      if (index === undefined) return [];
      return [chunk({ tool_calls: [{ index, function: { arguments: String(event.delta ?? "") } }] })];
    }
    case "response.completed":
      return [...replay(), chunk({}, state.calledTools ? "tool_calls" : "stop", chatUsage((event.response as { usage?: unknown } | undefined)?.usage))];
    case "response.incomplete": {
      const response = (event.response ?? {}) as { usage?: unknown; incomplete_details?: { reason?: unknown } };
      if (response.incomplete_details?.reason !== "max_output_tokens") return [];
      return [...replay(), chunk({}, "length", chatUsage(response.usage))];
    }
    default:
      return [];
  }
}

type ChatToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

function chatCompletion(chunks: Record<string, unknown>[], state: ChunkState): Record<string, unknown> {
  let content = "";
  let finish = "stop";
  let usage: unknown;
  const reasoning: unknown[] = [];
  const calls: ChatToolCall[] = [];
  for (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    const choice = (chunk.choices as { delta?: Record<string, unknown>; finish_reason?: string | null }[] | undefined)?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;
    const delta = choice?.delta ?? {};
    if (typeof delta.content === "string") content += delta.content;
    if (Array.isArray(delta.reasoning_details)) reasoning.push(...delta.reasoning_details);
    for (const raw of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []) as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
      const index = raw.index ?? calls.length;
      const call = calls[index] ??= { id: raw.id ?? `call_${index}`, type: "function", function: { name: "", arguments: "" } };
      if (raw.id) call.id = raw.id;
      if (raw.function?.name) call.function.name = raw.function.name;
      call.function.arguments += raw.function?.arguments ?? "";
    }
  }
  return {
    id: state.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{ index: 0, message: { role: "assistant", content, ...(reasoning.length ? { reasoning_details: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

export function upstreamFailure(event: Record<string, unknown>): string {
  if (event.type === "error") return String((event as { message?: unknown }).message ?? "The ChatGPT endpoint refused the request.");
  if (event.type !== "response.failed" && event.type !== "response.incomplete") return "";
  const response = (event.response ?? {}) as { error?: { message?: unknown }; incomplete_details?: { reason?: unknown } };
  return String(response.error?.message ?? response.incomplete_details?.reason ?? "The ChatGPT run stopped early.");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const pieces: Buffer[] = [];
  let size = 0;
  for await (const piece of request) {
    size += (piece as Buffer).length;
    if (size > MAX_REQUEST_BYTES) throw new Error("That request is too large for the ChatGPT endpoint.");
    pieces.push(piece as Buffer);
  }
  return Buffer.concat(pieces).toString("utf8");
}

let retentionRefused = false;

async function relay(request: IncomingMessage, response: ServerResponse, token: string) {
  const fail = (status: number, message: string) => {
    if (!response.headersSent) response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message } }));
  };
  try {
    if (request.headers.authorization !== `Bearer ${token}`) return fail(401, "This endpoint is Emma's own.");
    if (request.method !== "POST") return fail(405, "Post a chat completion here.");
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    const auth = await chatgptAuth();
    const headers = relayHeaders(auth, body);
    const send = (withoutRetention: boolean) => fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(responsesRequest(body, withoutRetention)) });
    let upstream = await send(retentionRefused);
    let refusal = upstream.ok && upstream.body ? "" : (await upstream.text()).slice(0, 2048);
    if (!upstream.ok && upstream.status === 400 && !retentionRefused && refusal.includes("prompt_cache_retention")) {
      retentionRefused = true;
      upstream = await send(true);
      refusal = upstream.ok && upstream.body ? "" : (await upstream.text()).slice(0, 2048);
    }
    if (!upstream.ok || !upstream.body) return fail(upstream.status, refusal || "The ChatGPT endpoint refused the request.");
    const buffered = body.stream === false;
    const collected: Record<string, unknown>[] = [];
    if (!buffered) response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const state = chunkState(typeof body.model === "string" ? body.model : "");
    const answer = () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(chatCompletion(collected, state)));
    };
    const decoder = new TextDecoder();
    let carry = "";
    for await (const piece of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      if (!buffered) response.write(":\n\n");
      carry += decoder.decode(piece, { stream: true });
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        const failure = upstreamFailure(event);
        if (failure) {
          const ending = chatChunks(event, state);
          if (buffered) {
            if (!ending.length) return fail(502, failure);
            collected.push(...ending);
            return answer();
          }
          for (const chunk of ending) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
          if (!ending.length) response.write(`data: ${JSON.stringify({ error: { message: failure } })}\n\n`);
          response.write("data: [DONE]\n\n");
          response.end();
          return;
        }
        for (const chunk of chatChunks(event, state)) {
          if (buffered) collected.push(chunk);
          else response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      }
    }
    if (buffered) return answer();
    response.write("data: [DONE]\n\n");
    response.end();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (response.headersSent) response.destroy();
    else fail(502, detail);
  }
}

let listening: Promise<{ id: string; chatUrl: string; apiKey: string }> | undefined;

export function chatgptRoute(): Promise<{ id: string; chatUrl: string; apiKey: string }> {
  listening ??= listen().catch((error: unknown) => {
    listening = undefined;
    throw error;
  });
  return listening;
}

async function listen() {
  await chatgptAuth();
  const token = randomBytes(24).toString("hex");
  const server = createServer((request, response) => void relay(request, response, token));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.unref();
  const { port } = server.address() as AddressInfo;
  return { id: "chatgpt", chatUrl: `http://127.0.0.1:${port}/v1/chat/completions`, apiKey: token };
}
