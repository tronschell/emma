import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { installedCapabilitySources } from "./marketplace";
import { findExecutable, isWindows, pathInside } from "./platform";

const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_SKILL_ROOTS = 16;
const MAX_SKILLS_PER_ROOT = 128;
export const MAX_SKILL_RESULTS = 64;
const MAX_TOOL_BYTES = 64 * 1024;
const MAX_TOOL_DESCRIPTION_BYTES = 1024;
const MAX_EMMA_TOOLS = 64;
const MAX_MCP_FILES = 16;
const MAX_MCP_SERVERS = 32;
const MIRRORED_SKILL_MARKER = ".emma-mirrored";
const INSTALLED_SKILL_SOURCE = "installed";

type ImportedSource = {
  id: string;
  skillRoots: string[];
  mcpFiles: string[];
};

type ImportManifest = {
  version: number;
  sources: ImportedSource[];
};

export type McpTransport = "http" | "sse";

type InternalMcpServer = {
  id: string;
  source: string;
  name: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  type?: McpTransport;
  url?: string;
  headers?: Array<{ name: string; value: string }>;
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
  type?: McpTransport;
  url?: string;
  headerNames?: string[];
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

export function learnedSkillRoot(userData: string) {
  return path.join(userData, "skills");
}

export function learnedMcpFile(userData: string) {
  return path.join(userData, "mcp.json");
}

function withEmmaSource(userData: string, manifest: ImportManifest): ImportManifest {
  return {
    version: 1,
    sources: [...manifest.sources.filter((source) => source.id !== "emma"), { id: "emma", skillRoots: [learnedSkillRoot(userData)], mcpFiles: [learnedMcpFile(userData)] }],
  };
}

async function withPluginSources(userData: string, manifest: ImportManifest): Promise<ImportManifest> {
  const plugins = await installedCapabilitySources(userData).catch(() => []);
  return { version: 1, sources: [...manifest.sources, ...plugins] };
}

async function loadManifest(userData: string) {
  try {
    const text = await readBounded(path.join(userData, "imports.json"), MAX_MANIFEST_BYTES);
    return await withPluginSources(userData, withEmmaSource(userData, parseManifest(JSON.parse(text))));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return await withPluginSources(userData, withEmmaSource(userData, { version: 1, sources: [] }));
    throw new Error("Emma's imported-skill list (imports.json) could not be read — run /import again to rebuild it.", { cause: error });
  }
}

export function learnedSkillSlug(value: unknown) {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) throw new Error("Skill name is invalid");
  return value;
}

export async function writeLearnedSkill(userData: string, name: unknown, instructions: unknown) {
  const slug = learnedSkillSlug(name);
  const content = boundedString(instructions, MAX_SKILL_BYTES, "Skill content");
  if (!content.trim()) throw new Error("Skill content is invalid");
  const root = learnedSkillRoot(userData);
  const directory = path.join(root, slug);
  let existing: string[];
  try { existing = (await readdir(root)).slice(0, MAX_SKILLS_PER_ROOT + 1); } catch { existing = []; }
  if (!existing.includes(slug) && existing.length >= MAX_SKILLS_PER_ROOT) throw new Error("Emma already holds the maximum number of learned skills");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.SKILL.md.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path.join(directory, "SKILL.md"));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { id: skillId("emma", 0, slug), source: "emma", name: slug } satisfies ImportedSkill;
}

export type EmmaTool = { name: string; description: string; run: string };

export function emmaToolRoot(userData: string) {
  return path.join(userData, "tools");
}

export async function writeEmmaTool(userData: string, name: unknown, description: unknown, code: unknown): Promise<EmmaTool> {
  const slug = learnedSkillSlug(name);
  const about = boundedString(description, MAX_TOOL_DESCRIPTION_BYTES, "Tool description");
  const body = boundedString(code, MAX_TOOL_BYTES, "Tool code");
  if (!body.startsWith("#!")) throw new Error("Tool code must start with a #! line naming its interpreter");
  const root = emmaToolRoot(userData);
  let existing: string[];
  try { existing = (await readdir(root)).slice(0, MAX_EMMA_TOOLS + 1); } catch { existing = []; }
  if (!existing.includes(slug) && existing.length >= MAX_EMMA_TOOLS) throw new Error("Emma already holds the maximum number of tools");
  const directory = path.join(root, slug);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.run.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o700 });
    await rename(temporary, path.join(directory, "run"));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await writeFile(path.join(directory, "about.txt"), about, { encoding: "utf8", mode: 0o600 });
  return { name: slug, description: about, run: path.join(directory, "run") };
}

export async function listEmmaTools(userData: string): Promise<EmmaTool[]> {
  const root = emmaToolRoot(userData);
  let entries: string[];
  try { entries = (await readdir(root)).slice(0, MAX_EMMA_TOOLS); } catch { return []; }
  const tools: EmmaTool[] = [];
  for (const name of entries) {
    try {
      const description = await readBounded(path.join(root, name, "about.txt"), MAX_TOOL_DESCRIPTION_BYTES);
      tools.push({ name, description, run: path.join(root, name, "run") });
    } catch { continue; }
  }
  return tools;
}

export async function seedBuiltinSkills(builtinRoot: string, userData: string, harnessHome: string, preserve: readonly string[] = []) {
  let names: string[];
  try { names = (await readdir(builtinRoot)).slice(0, MAX_SKILLS_PER_ROOT); } catch { return []; }
  const seeded: string[] = [];
  for (const name of names) {
    try {
      const mine = preserve.includes(name) ? await readBounded(path.join(learnedSkillRoot(userData), name, "SKILL.md"), MAX_SKILL_BYTES).catch(() => "") : "";
      const content = mine.trim() ? mine : await readBounded(path.join(builtinRoot, name, "SKILL.md"), MAX_SKILL_BYTES);
      const slug = mine.trim() ? learnedSkillSlug(name) : (await writeLearnedSkill(userData, name, content)).name;
      const directory = path.join(harnessHome, ".fx", "skills", slug);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, "SKILL.md"), content, { encoding: "utf8", mode: 0o600 });
      seeded.push(slug);
    } catch (error) {
      console.warn(`Emma skipped the built-in skill ${name}:`, error instanceof Error ? error.message : error);
    }
  }
  return seeded;
}

export async function mirrorSkillsToHarness(userData: string, harnessHome: string, disabled: string[] = []) {
  const root = path.join(harnessHome, ".fx", "skills");
  const skills = await enumerateSkills(await loadManifest(userData), root);
  const blocked = new Set(disabled);
  const mirrored: string[] = [];
  const managed = new Set(skills.filter((skill) => skill.managed).map((skill) => skill.name));
  for (const skill of skills) {
    if (skill.managed && (blocked.has(skill.id) || blocked.has(skill.name)) || mirrored.includes(skill.name)) continue;
    try {
      const content = await readBounded(path.join(skill.root, skill.name, "SKILL.md"), MAX_SKILL_BYTES);
      if (!content.trim()) continue;
      if (skill.managed) {
        const directory = path.join(root, skill.name);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(path.join(directory, "SKILL.md"), withFrontmatter(skill.name, content), { encoding: "utf8", mode: 0o600 });
        await writeFile(path.join(directory, MIRRORED_SKILL_MARKER), "", { encoding: "utf8", mode: 0o600 });
      }
      mirrored.push(skill.name);
    } catch { continue; }
  }
  const kept = new Set(mirrored);
  for (const entry of await readdir(root).catch(() => [])) {
    if (!kept.has(entry) && (managed.has(entry) || await isMirroredSkill(root, entry))) await rm(path.join(root, entry), { recursive: true, force: true }).catch(() => {});
  }
  return mirrored;
}

function withFrontmatter(name: string, content: string) {
  if (content.startsWith("---\n")) return content;
  const summary = content.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#")) ?? name;
  const description = summary.replace(/"/g, "'").slice(0, 200);
  return `---\nname: ${name}\ndescription: "${description}"\n---\n\n${content}`;
}

function skillId(source: string, rootIndex: number, name: string) {
  return `skill:${source}:${rootIndex}:${name}`;
}

type LocatedSkill = ImportedSkill & { root: string; managed: boolean };

async function skillsAtRoot(source: string, rootIndex: number, root: string, managed: boolean) {
  const skills: LocatedSkill[] = [];
  let entries;
  try { entries = (await readdir(root, { withFileTypes: true })).slice(0, MAX_SKILLS_PER_ROOT); } catch { return skills; }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink() || !/^[a-zA-Z0-9._-]{1,96}$/.test(entry.name)) continue;
    try {
      const handle = await open(path.join(root, entry.name, "SKILL.md"), "r");
      try {
        const information = await handle.stat();
        if (!information.isFile() || information.size > MAX_SKILL_BYTES) continue;
      } finally {
        await handle.close();
      }
      skills.push({ id: skillId(source, rootIndex, entry.name), source, name: entry.name, root, managed });
    } catch { continue; }
  }
  return skills;
}

async function isMirroredSkill(root: string, name: string) {
  try {
    const marker = await open(path.join(root, name, MIRRORED_SKILL_MARKER), "r");
    try { return (await marker.stat()).isFile(); }
    finally { await marker.close(); }
  } catch { return false; }
}

async function enumerateSkills(manifest: ImportManifest, installedRoot?: string) {
  const skills: LocatedSkill[] = [];
  for (const source of manifest.sources) {
    for (const [rootIndex, root] of source.skillRoots.slice(0, MAX_SKILL_ROOTS).entries()) {
      skills.push(...await skillsAtRoot(source.id, rootIndex, root, true));
    }
  }
  if (installedRoot) {
    const known = new Set(skills.map((skill) => skill.name));
    for (const skill of await skillsAtRoot(INSTALLED_SKILL_SOURCE, 0, installedRoot, false)) {
      if (!known.has(skill.name) && !await isMirroredSkill(installedRoot, skill.name)) skills.push(skill);
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
  if (typeof query !== "string" || query.length > 256 || Buffer.byteLength(query, "utf8") > 256) throw new Error("skill search is invalid");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SKILL_RESULTS) throw new Error("skill result limit is invalid");
  const skills = await enumerateSkills(await loadManifest(userData), path.join(userData, "harness", ".fx", "skills"));
  return skills.filter((skill) => searchText(query, skill.name, skill.source)).slice(0, limit).map(toSkillMetadata);
}

export async function loadImportedSkill(userData: string, id: string) {
  boundedString(id, 256, "skill selection");
  const skill = (await enumerateSkills(await loadManifest(userData), path.join(userData, "harness", ".fx", "skills"))).find((candidate) => candidate.id === id);
  if (!skill) throw new Error("That skill is no longer installed — run /import again to bring it back.");
  const root = await realpath(skill.root);
  const directory = await realpath(path.join(skill.root, skill.name));
  if (!pathInside(root, directory)) throw new Error("Selected skill is outside its imported root");
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
  const entries = Object.entries(value);
  if (entries.length && entries.every(([, item]) => item && typeof item === "object" && !Array.isArray(item) && ("command" in (item as object) || "url" in (item as object)))) return value;
  return {};
}

function parseMcpServer(source: string, fileIndex: number, name: string, raw: unknown): InternalMcpServer | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(name)) return undefined;
  const value = raw as Record<string, unknown>;
  const id = `mcp:${source}:${fileIndex}:${name}`;
  if (typeof value.url === "string") {
    // https only. A remote entry's headers are how it authenticates, so plaintext http would
    // put the user's bearer token on the wire; the harness would take loopback http, we do not.
    if (value.url.length > 4096 || !URL.canParse(value.url) || new URL(value.url).protocol !== "https:") return undefined;
    const supplied = value.headers ?? {};
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) return undefined;
    const headers = Object.entries(supplied).filter(([key, item]) => /^[A-Za-z0-9-]{1,128}$/.test(key) && typeof item === "string" && item.length <= 8192);
    if (headers.length !== Object.keys(supplied).length || headers.length > 32) return undefined;
    const type = value.type === "sse" ? "sse" : "http";
    return { id, source, name, args: [], env: {}, type, url: value.url, headers: headers.map(([key, item]) => ({ name: key, value: item as string })) };
  }
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
  return { id, source, name, command, args: args as string[], env };
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

export type McpServerDefinition = { name: string; command?: string; args?: string[]; env?: Record<string, string>; type?: McpTransport; url?: string; headers?: Record<string, string> };

export async function writeLearnedMcpServer(userData: string, server: McpServerDefinition) {
  const file = learnedMcpFile(userData);
  let servers: Record<string, unknown> = {};
  try {
    const existing: unknown = JSON.parse(await readBounded(file, MAX_CONFIG_BYTES));
    if (existing && typeof existing === "object" && !Array.isArray(existing)) servers = { ...configRoots(existing as Record<string, unknown>) };
  } catch { servers = {}; }
  servers[server.name] = server.url
    ? { type: server.type ?? "http", url: server.url, headers: server.headers ?? {} }
    : { command: server.command, args: server.args ?? [], env: server.env ?? {} };
  const text = `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
  const written = parseMcpConfig(text, "mcp.json", "emma", 0).find((candidate) => candidate.name === server.name);
  if (!written) throw new Error("That MCP server definition is not valid.");
  await mkdir(userData, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return written.id;
}

async function enumerateMcpServers(manifest: ImportManifest) {
  const servers: InternalMcpServer[] = [];
  for (const source of manifest.sources) {
    for (const [fileIndex, file] of source.mcpFiles.slice(0, MAX_MCP_FILES).entries()) {
      try {
        const parsed = parseMcpConfig(await readBounded(file, MAX_CONFIG_BYTES), path.basename(file), source.id, fileIndex);
        servers.push(...parsed);
      } catch { continue; }
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
    // A remote server has no command; its endpoint stands in so a row still names
    // something the user recognises. Header *values* are credentials and stay main-side.
    command: server.command ?? server.url ?? "",
    args,
    argCount: server.args.length,
    environmentKeys: Object.keys(server.env).sort(),
    type: server.type,
    url: server.url,
    headerNames: server.headers?.map((header) => header.name).sort(),
  };
}

export async function listImportedMcpServers(userData: string) {
  return (await enumerateMcpServers(await loadManifest(userData))).map(serverMetadata);
}

export async function harnessMcpServers(userData: string, disabled: readonly string[] = []) {
  const blocked = new Set(disabled);
  const servers = (await enumerateMcpServers(await loadManifest(userData))).filter((server) => !blocked.has(server.id));
  const resolved = await Promise.all(servers.map(async (server) => {
    // The harness answers MissingHeaders when the key is absent, so a remote entry always
    // carries one even with nothing in it. Its url is validated harness-side on the way in.
    if (server.url) return { name: server.name, type: server.type, url: server.url, headers: server.headers ?? [] };
    const command = server.command ? await absoluteCommand(server.command) : undefined;
    if (!command) return undefined;
    const env = Object.entries(server.env);
    const inherited = env.length === 0 ? [] : Object.entries({
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...(isWindows ? {
        USERPROFILE: process.env.USERPROFILE ?? "",
        APPDATA: process.env.APPDATA ?? "",
        LOCALAPPDATA: process.env.LOCALAPPDATA ?? "",
        ComSpec: process.env.ComSpec ?? "",
        PATHEXT: process.env.PATHEXT ?? "",
      } : {}),
    });
    return {
      name: server.name,
      command,
      args: server.args,
      env: [...inherited, ...env].map(([name, value]) => ({ name, value })),
    };
  }));
  return resolved.filter((server): server is NonNullable<typeof server> => server !== undefined);
}

async function absoluteCommand(command: string) {
  if (path.isAbsolute(command)) return command;
  return await findExecutable(command, process.env.PATH ?? "");
}

export class ImportedCapabilityRuntime {
  constructor(private readonly userData: string) {}

  searchSkills(query: string, limit = 16) { return searchImportedSkills(this.userData, query, limit); }
  selectSkill(id: string) { return loadImportedSkill(this.userData, id); }
  listMcpServers() { return listImportedMcpServers(this.userData); }

  async installMcpServer(definition: McpServerDefinition) {
    return { id: await writeLearnedMcpServer(this.userData, definition) };
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
    if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(threadId)) throw new Error("Skill attachment thread is invalid");
    this.attachment = { ...attachment, threadId };
    this.claimedId = undefined;
  }

  status() {
    return this.attachment ? { id: this.attachment.id, source: this.attachment.source, name: this.attachment.name, threadId: this.attachment.threadId, chars: this.attachment.instructions.length } : null;
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
