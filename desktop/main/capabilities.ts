import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { open, readdir, realpath } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { BoundedLines } from "./ndjson";

const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_SKILL_ROOTS = 16;
const MAX_SKILLS_PER_ROOT = 128;
const MAX_SKILL_RESULTS = 32;
const MAX_MCP_FILES = 16;
const MAX_MCP_SERVERS = 32;
const MAX_MCP_TOOLS = 256;
const MAX_MCP_LINE_BYTES = 64 * 1024;
const MAX_MCP_RESPONSE_BYTES = 256 * 1024;
const MAX_MCP_SCHEMA_BYTES = 64 * 1024;
const MAX_MCP_ARGUMENT_BYTES = 64 * 1024;
const MCP_TIMEOUT_MS = 10_000;

type ImportedSource = {
  id: string;
  skillRoots: string[];
  mcpFiles: string[];
};

type ImportManifest = {
  version: number;
  sources: ImportedSource[];
};

type InternalMcpServer = {
  id: string;
  source: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type ImportedSkill = {
  id: string;
  source: string;
  name: string;
};

export type McpServer = {
  id: string;
  source: string;
  name: string;
  command: string;
  args: string[];
  argCount: number;
  environmentKeys: string[];
};

export type McpPermissionReview = McpServer & {
  token: string;
  warning: string;
  capabilities: string[];
};

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolSummary = Omit<McpTool, "inputSchema">;

export type McpCallResult = {
  content?: unknown;
  isError?: boolean;
  [key: string]: unknown;
};

function boundedString(value: unknown, max: number, label: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || Buffer.byteLength(value, "utf8") > max) throw new Error(`${label} is invalid`);
  return value;
}

async function readBounded(file: string, max: number) {
  const handle = await open(file, "r");
  try {
    const information = await handle.stat();
    if (!information.isFile() || information.size > max) throw new Error("file is too large");
    return new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile());
  } finally {
    await handle.close();
  }
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && path.isAbsolute(value) && !value.includes("\0");
}

function parseManifest(value: unknown): ImportManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Imported manifest is invalid");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.sources) || raw.sources.length > 8) throw new Error("Imported manifest is invalid");
  const sourceIds = new Set<string>();
  const sources = raw.sources.map((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Imported manifest is invalid");
    const candidate = source as Record<string, unknown>;
    if (typeof candidate.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(candidate.id) || !Array.isArray(candidate.skillRoots) || !Array.isArray(candidate.mcpFiles)) throw new Error("Imported manifest is invalid");
    if (sourceIds.has(candidate.id)) throw new Error("Imported manifest is invalid");
    sourceIds.add(candidate.id);
    const skillRoots = candidate.skillRoots.filter(validPath);
    const mcpFiles = candidate.mcpFiles.filter(validPath);
    if (skillRoots.length !== candidate.skillRoots.length || mcpFiles.length !== candidate.mcpFiles.length || skillRoots.length > MAX_SKILL_ROOTS || mcpFiles.length > MAX_MCP_FILES) throw new Error("Imported manifest is invalid");
    return { id: candidate.id, skillRoots, mcpFiles };
  });
  return { version: 1, sources };
}

async function loadManifest(userData: string) {
  try {
    const text = await readBounded(path.join(userData, "imports.json"), MAX_MANIFEST_BYTES);
    return parseManifest(JSON.parse(text));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sources: [] };
    throw new Error("Imported manifest is invalid", { cause: error });
  }
}

function skillId(source: string, rootIndex: number, name: string) {
  return `skill:${source}:${rootIndex}:${name}`;
}

async function enumerateSkills(manifest: ImportManifest) {
  const skills: Array<ImportedSkill & { root: string }> = [];
  for (const source of manifest.sources) {
    for (const [rootIndex, root] of source.skillRoots.slice(0, MAX_SKILL_ROOTS).entries()) {
      let entries;
      try { entries = (await readdir(root, { withFileTypes: true })).slice(0, MAX_SKILLS_PER_ROOT); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink() || !/^[a-zA-Z0-9._-]{1,96}$/.test(entry.name)) continue;
        try {
          const skillPath = path.join(root, entry.name, "SKILL.md");
          const handle = await open(skillPath, "r");
          try {
            const information = await handle.stat();
            if (!information.isFile() || information.size > MAX_SKILL_BYTES) continue;
          } finally {
            await handle.close();
          }
          skills.push({ id: skillId(source.id, rootIndex, entry.name), source: source.id, name: entry.name, root });
        } catch { /* a disappearing imported file is not a renderer error */ }
      }
    }
  }
  return skills;
}

function toSkillMetadata(skill: ImportedSkill & { root?: string }): ImportedSkill {
  return { id: skill.id, source: skill.source, name: skill.name };
}

function searchText(query: string, ...values: string[]) {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || values.some((value) => value.toLocaleLowerCase().includes(needle));
}

export async function searchImportedSkills(userData: string, query: string, limit = 16) {
  boundedString(query, 256, "skill search");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SKILL_RESULTS) throw new Error("skill result limit is invalid");
  const skills = await enumerateSkills(await loadManifest(userData));
  return skills.filter((skill) => searchText(query, skill.name, skill.source)).slice(0, limit).map(toSkillMetadata);
}

export async function loadImportedSkill(userData: string, id: string) {
  boundedString(id, 256, "skill selection");
  const skill = (await enumerateSkills(await loadManifest(userData))).find((candidate) => candidate.id === id);
  if (!skill) throw new Error("Selected skill is unavailable");
  const root = await realpath(skill.root);
  const directory = await realpath(path.join(skill.root, skill.name));
  if (!directory.startsWith(`${root}${path.sep}`)) throw new Error("Selected skill is outside its imported root");
  const instructions = await readBounded(path.join(directory, "SKILL.md"), MAX_SKILL_BYTES);
  if (!instructions.trim()) throw new Error("Selected skill is empty");
  return { ...toSkillMetadata(skill), instructions };
}

function stripJsonComments(text: string) {
  let output = "";
  let quote = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') { quote = true; output += character; continue; }
    if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += character;
  }
  let cleaned = "";
  quote = false;
  escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index];
    if (quote) {
      cleaned += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') { quote = true; cleaned += character; continue; }
    if (character === ",") {
      let next = index + 1;
      while (/\s/.test(output[next] ?? "")) next += 1;
      if (output[next] === "}" || output[next] === "]") continue;
    }
    cleaned += character;
  }
  return cleaned;
}

function parseString(value: string) {
  const parsed = JSON.parse(value);
  return boundedString(parsed, 8192, "MCP value");
}

function splitTomlList(value: string) {
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  const values: string[] = [];
  let start = 0;
  let quote = false;
  let escaped = false;
  for (let index = 0; index <= inner.length; index += 1) {
    const character = inner[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
    } else if (character === '"') quote = true;
    if ((character === "," && !quote) || index === inner.length) {
      const part = inner.slice(start, index).trim();
      if (!part) throw new Error("MCP TOML array is invalid");
      values.push(parseString(part));
      start = index + 1;
    }
  }
  return values;
}

function parseTomlTable(value: string) {
  const inner = value.slice(1, -1).trim();
  const env: Record<string, string> = {};
  if (!inner) return env;
  let quote = false;
  let escaped = false;
  let start = 0;
  const pairs: string[] = [];
  for (let index = 0; index <= inner.length; index += 1) {
    const character = inner[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
    } else if (character === '"') quote = true;
    if ((character === "," && !quote) || index === inner.length) {
      pairs.push(inner.slice(start, index).trim());
      start = index + 1;
    }
  }
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator < 1) throw new Error("MCP TOML table is invalid");
    env[pair.slice(0, separator).trim()] = parseString(pair.slice(separator + 1).trim());
  }
  return env;
}

function parseToml(text: string) {
  const servers: Record<string, Record<string, unknown>> = {};
  let current: Record<string, unknown> | undefined;
  for (const rawLine of text.split(/\r?\n/).slice(0, 4096)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const section = line.match(/^\[mcp_servers\.([^\]]+)\]$/);
    if (section) {
      const name = section[1].replace(/^"|"$/g, "");
      current = servers[name] ??= {};
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (value.startsWith('"')) current[key] = parseString(value);
    else if (value.startsWith("[")) current[key] = splitTomlList(value);
    else if (value.startsWith("{")) current[key] = parseTomlTable(value);
  }
  return { mcpServers: servers };
}

function configRoots(value: Record<string, unknown>) {
  for (const key of ["mcpServers", "mcp_servers", "servers", "mcp"]) {
    const candidate = value[key];
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate as Record<string, unknown>;
  }
  return {};
}

function parseMcpServer(source: string, fileIndex: number, name: string, raw: unknown): InternalMcpServer | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  let command: string | undefined;
  let args: unknown = value.args;
  if (typeof value.command === "string") command = value.command;
  else if (Array.isArray(value.command) && value.command.every((item) => typeof item === "string") && value.command.length > 0) {
    command = value.command[0];
    args = [...value.command.slice(1), ...(Array.isArray(args) ? args : [])];
  }
  if (!command || command.length > 256) return undefined;
  if (!Array.isArray(args) || args.length > 32 || args.some((item) => typeof item !== "string" || item.length > 4096)) return undefined;
  const environment = value.env ?? value.environment ?? {};
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) return undefined;
  const env = Object.fromEntries(Object.entries(environment).filter(([key, item]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === "string" && item.length <= 8192));
  if (Object.keys(env).length !== Object.keys(environment).length || Object.keys(env).length > 32) return undefined;
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(name)) return undefined;
  return { id: `mcp:${source}:${fileIndex}:${name}`, source, name, command, args: args as string[], env };
}

export function parseMcpConfig(text: string, fileName = "config.json", source = "import", fileIndex = 0) {
  if (text.length > MAX_CONFIG_BYTES) throw new Error("MCP config is too large");
  const value = fileName.endsWith(".toml") ? parseToml(text) : JSON.parse(stripJsonComments(text));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP config is invalid");
  const servers: InternalMcpServer[] = [];
  for (const [name, raw] of Object.entries(configRoots(value as Record<string, unknown>))) {
    const server = parseMcpServer(source, fileIndex, name, raw);
    if (server) servers.push(server);
    if (servers.length > MAX_MCP_SERVERS) throw new Error("MCP config has too many servers");
  }
  return servers;
}

async function enumerateMcpServers(manifest: ImportManifest) {
  const servers: InternalMcpServer[] = [];
  for (const source of manifest.sources) {
    for (const [fileIndex, file] of source.mcpFiles.slice(0, MAX_MCP_FILES).entries()) {
      try {
        const parsed = parseMcpConfig(await readBounded(file, MAX_CONFIG_BYTES), path.basename(file), source.id, fileIndex);
        servers.push(...parsed);
      } catch { /* invalid imported config stays invisible and never reaches the renderer */ }
      if (servers.length > MAX_MCP_SERVERS) return servers.slice(0, MAX_MCP_SERVERS);
    }
  }
  return servers;
}

function serverMetadata(server: InternalMcpServer): McpServer {
  const args = server.args.map((value, index) => {
    if (/^(?:--?(?:api[-_]?key|auth|credential|password|secret|token))(?:=|$)/i.test(value) || /^(?:sk-|gh[pousr]_|xox[baprs]-|eyJ)/.test(value)) {
      return value.includes("=") ? `${value.slice(0, value.indexOf("=") + 1)}[redacted]` : value;
    }
    if (value.startsWith("-") && !value.includes("=")) return value;
    if (/^@?[a-z0-9][a-z0-9._/-]*$/i.test(value) && (value.includes("/") || /\.(?:cjs|js|mjs|py|rb|sh)$/i.test(value))) return value;
    return `[argument ${index + 1} redacted]`;
  });
  return {
    id: server.id,
    source: server.source,
    name: server.name,
    command: server.command,
    args,
    argCount: server.args.length,
    environmentKeys: Object.keys(server.env).sort(),
  };
}

export async function listImportedMcpServers(userData: string) {
  return (await enumerateMcpServers(await loadManifest(userData))).map(serverMetadata);
}

function validRpcObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jsonSize(value: unknown, max: number, label: string) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > max) throw new Error(`${label} is too large`);
  return text;
}

class McpStdio {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines = new BoundedLines(MAX_MCP_LINE_BYTES);
  private readonly queued: string[] = [];
  private readonly waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  private nextId = 1;
  private failure: Error | undefined;
  private closed = false;

  constructor(server: InternalMcpServer) {
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...server.env };
    this.child = spawn(server.command, server.args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (data: Buffer) => {
      try {
        for (const line of this.lines.push(data)) this.push(line);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("MCP output is invalid"));
      }
    });
    this.child.stdout.once("end", () => {
      try { this.lines.end(); this.fail(new Error("MCP server closed stdout")); } catch (error) { this.fail(error as Error); }
    });
    this.child.stderr.on("data", () => undefined);
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", () => this.fail(new Error("MCP server stopped")));
  }

  private push(line: string) {
    if (line.length > MAX_MCP_RESPONSE_BYTES) throw new Error("MCP response is too large");
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(line);
    else {
      if (this.queued.length >= 32) throw new Error("MCP output queue is full");
      this.queued.push(line);
    }
  }

  private fail(error: Error) {
    this.failure ??= error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure);
    if (!this.closed && !this.child.killed) this.child.kill();
  }

  private async line(timeout = MCP_TIMEOUT_MS) {
    if (this.failure) throw this.failure;
    const queued = this.queued.shift();
    if (queued !== undefined) return queued;
    return new Promise<string>((resolve, reject) => {
      const onResolve = (value: string) => { clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === onResolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("MCP request timed out"));
        this.fail(new Error("MCP request timed out"));
      }, timeout);
      this.waiters.push({ resolve: onResolve, reject });
    });
  }

  private async write(value: string) {
    if (this.failure || this.closed) throw this.failure ?? new Error("MCP server is closed");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("MCP write timed out");
        this.fail(error);
        reject(error);
      }, MCP_TIMEOUT_MS);
      this.child.stdin.write(`${value}\n`, (error) => {
        clearTimeout(timer);
        if (error) { this.fail(error); reject(error); } else resolve();
      });
    });
  }

  async notify(method: string, params: Record<string, unknown>) {
    await this.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  async request(method: string, params: Record<string, unknown>) {
    const id = this.nextId++;
    try {
      await this.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      while (true) {
        const line = await this.line();
        let value: unknown;
        try { value = JSON.parse(line); } catch { throw new Error("MCP response is not JSON"); }
        if (!validRpcObject(value) || value.jsonrpc !== "2.0") throw new Error("MCP response is not JSON-RPC 2.0");
        if (!Object.hasOwn(value, "id")) continue;
        if (value.id !== id) throw new Error("MCP response ID does not match the request");
        if (Object.hasOwn(value, "error")) {
          const error = value.error;
          const message = validRpcObject(error) && typeof error.message === "string" ? error.message.slice(0, 512) : "MCP request failed";
          throw new Error(message);
        }
        if (!Object.hasOwn(value, "result")) throw new Error("MCP response has no result");
        jsonSize(value.result, MAX_MCP_RESPONSE_BYTES, "MCP response");
        return value.result;
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("MCP request failed");
      this.fail(failure);
      throw failure;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("MCP session closed"));
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (!this.child.killed) this.child.kill();
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(resolve, 500);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

function parseTools(value: unknown) {
  if (!validRpcObject(value) || !Array.isArray(value.tools) || value.tools.length > MAX_MCP_TOOLS) throw new Error("MCP tools/list result is invalid");
  const names = new Set<string>();
  return value.tools.map((raw): McpTool => {
    if (!validRpcObject(raw) || typeof raw.name !== "string" || raw.name.length < 1 || raw.name.length > 128 || (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 4096)) || !validRpcObject(raw.inputSchema)) throw new Error("MCP tool metadata is invalid");
    if (names.has(raw.name)) throw new Error("MCP tool names must be unique");
    names.add(raw.name);
    jsonSize(raw.inputSchema, MAX_MCP_SCHEMA_BYTES, "MCP tool schema");
    return { name: raw.name, description: raw.description ?? "", inputSchema: raw.inputSchema };
  });
}

class McpSession {
  readonly server: McpServer;
  readonly tools: McpTool[];
  private readonly io: McpStdio;
  private searched: string[] = [];
  private selected: McpTool | undefined;

  private constructor(server: InternalMcpServer, io: McpStdio, tools: McpTool[]) {
    this.server = serverMetadata(server);
    this.io = io;
    this.tools = tools;
  }

  static async start(server: InternalMcpServer) {
    const io = new McpStdio(server);
    try {
      const initialized = await io.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "emma", version: "0.1.0" } });
      if (!validRpcObject(initialized)) throw new Error("MCP initialize result is invalid");
      await io.notify("notifications/initialized", {});
      const tools = parseTools(await io.request("tools/list", {}));
      return new McpSession(server, io, tools);
    } catch (error) {
      await io.close();
      throw error;
    }
  }

  search(query: string, limit: number) {
    boundedString(query, 256, "MCP tool search");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error("MCP tool result limit is invalid");
    this.searched = this.tools.filter((tool) => searchText(query, tool.name, tool.description)).slice(0, limit).map((tool) => tool.name);
    this.selected = undefined;
    return this.searched.map((name) => {
      const tool = this.tools.find((candidate) => candidate.name === name)!;
      return { name: tool.name, description: tool.description } satisfies McpToolSummary;
    });
  }

  select(name: string) {
    boundedString(name, 128, "MCP tool selection");
    if (!this.searched.includes(name)) throw new Error("Select a tool from the latest MCP search");
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error("Selected MCP tool is unavailable");
    this.selected = tool;
    return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  }

  async call(args: unknown) {
    if (!this.selected) throw new Error("Select an MCP tool before calling it");
    if (!validRpcObject(args)) throw new Error("MCP tool arguments must be an object");
    jsonSize(args, MAX_MCP_ARGUMENT_BYTES, "MCP tool arguments");
    const result = await this.io.request("tools/call", { name: this.selected.name, arguments: args });
    if (!validRpcObject(result)) throw new Error("MCP tools/call result is invalid");
    jsonSize(result, MAX_MCP_RESPONSE_BYTES, "MCP tool output");
    return result as McpCallResult;
  }

  close() { return this.io.close(); }
}

export class ImportedCapabilityRuntime {
  private session: McpSession | undefined;
  private readonly reviews = new Map<string, { serverId: string; expiresAt: number }>();

  constructor(private readonly userData: string) {}

  searchSkills(query: string, limit = 16) { return searchImportedSkills(this.userData, query, limit); }
  selectSkill(id: string) { return loadImportedSkill(this.userData, id); }
  listMcpServers() { return listImportedMcpServers(this.userData); }

  async permissionReview(serverId: string): Promise<McpPermissionReview> {
    const server = await this.findServer(serverId);
    const now = Date.now();
    for (const [token, review] of this.reviews) if (review.expiresAt < now) this.reviews.delete(token);
    if (this.reviews.size >= 32) throw new Error("Too many pending MCP permission reviews");
    const token = randomUUID();
    this.reviews.set(token, { serverId, expiresAt: Date.now() + 5 * 60_000 });
    return {
      ...serverMetadata(server),
      token,
      warning: "This starts one imported stdio process with its configured environment. Emma sends only the selected tool call and keeps configuration values in the main process.",
      capabilities: ["start one local stdio process", "read bounded tool metadata", "send one user-invoked selected tool call"],
    };
  }

  async connect(serverId: string, token: string) {
    boundedString(token, 128, "MCP permission token");
    const review = this.reviews.get(token);
    this.reviews.delete(token);
    if (!review || review.serverId !== serverId || review.expiresAt < Date.now()) throw new Error("MCP permission review is invalid or expired");
    const server = await this.findServer(serverId);
    if (this.session && this.session.server.id !== server.id) throw new Error("Close the active MCP server before selecting another");
    if (!this.session) this.session = await McpSession.start(server);
    return { server: this.session.server, tools: this.session.tools.length };
  }

  searchTools(query: string, limit = 16) {
    if (!this.session) throw new Error("Review and connect one MCP server first");
    return this.session.search(query, limit);
  }

  selectTool(name: string) {
    if (!this.session) throw new Error("Review and connect one MCP server first");
    return this.session.select(name);
  }

  callTool(args: unknown) {
    if (!this.session) throw new Error("Review and connect one MCP server first");
    return this.session.call(args);
  }

  async close() {
    const session = this.session;
    this.session = undefined;
    this.reviews.clear();
    await session?.close();
  }

  private async findServer(id: string) {
    boundedString(id, 256, "MCP server selection");
    const server = (await enumerateMcpServers(await loadManifest(this.userData))).find((candidate) => candidate.id === id);
    if (!server) throw new Error("Selected MCP server is unavailable");
    return server;
  }
}

export type SkillAttachment = {
  id: string;
  source: string;
  name: string;
  instructions: string;
};

type StoredSkillAttachment = SkillAttachment & { threadId: string };

export class SkillAttachmentStore {
  private attachment: StoredSkillAttachment | undefined;
  private claimedId: string | undefined;

  put(attachment: SkillAttachment, threadId: string) {
    if (!/^skill:[a-z0-9-]{1,64}:\d+:[a-zA-Z0-9._-]{1,96}$/.test(attachment.id)) throw new Error("Skill attachment ID is invalid");
    if (!/^thread-[a-z0-9-]{1,128}$/.test(threadId)) throw new Error("Skill attachment thread is invalid");
    this.attachment = { ...attachment, threadId };
    this.claimedId = undefined;
  }

  status() {
    return this.attachment ? { id: this.attachment.id, source: this.attachment.source, name: this.attachment.name, threadId: this.attachment.threadId } : null;
  }

  claim(id: string, threadId: string) {
    if (this.claimedId || this.attachment?.id !== id || this.attachment.threadId !== threadId) throw new Error("Skill attachment is unavailable");
    this.claimedId = id;
    return this.attachment;
  }

  finish(id: string, delivered: boolean) {
    if (this.claimedId !== id) throw new Error("Skill attachment delivery is invalid");
    this.claimedId = undefined;
    if (delivered && this.attachment?.id === id) this.attachment = undefined;
  }

  clear(id: string) {
    if (this.claimedId === id) throw new Error("Skill attachment is being sent");
    if (this.attachment?.id === id) this.attachment = undefined;
  }

  clearAll() {
    this.attachment = undefined;
    this.claimedId = undefined;
  }
}
