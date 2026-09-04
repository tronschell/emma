import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLI_MODELS_STALE_MS, MAX_CLI_MODELS, terminalText, type CliModels, type CliOptions } from "../shared/cli";
import { spawnCommand, terminateProcessTree } from "./platform";

const CACHE_FILE = "cli-models.json";
const LIST_MS = 30_000;
const MAX_LIST_BYTES = 1024 * 1024;
const CLAUDE_ID = /claude-[a-z0-9]+(?:-[a-z0-9]+)*/g;
const CLAUDE_MODEL = /^claude-[a-z0-9-]*[a-z]-[0-9]+(?:-[0-9]{8})?$|^claude-[0-9]+(?:-[0-9]+)?-[a-z]+(?:-[0-9]{8})?$/;
const CLAUDE_NOT_A_MODEL = /^claude-(code|desktop|instant|api|cli|ai)\b/;
const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku"];

type Catalog = Record<string, Omit<CliModels, "cli">>;

const unique = (values: string[]) => [...new Set(values.filter(Boolean))].slice(0, MAX_CLI_MODELS);

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function run(binary: string, args: string[], path: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawnCommand(binary, args, { env: { ...process.env, PATH: path }, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout?.on("data", (data: Buffer) => { if (out.length < MAX_LIST_BYTES) out += String(data); });
    const timer = setTimeout(() => { if (child.pid !== undefined) terminateProcessTree(child.pid, "SIGKILL", false); }, LIST_MS);
    timer.unref();
    child.once("error", () => { clearTimeout(timer); resolve(""); });
    child.once("close", () => { clearTimeout(timer); resolve(out); });
  });
}

function scan(path: string, pattern: RegExp): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    let tail = "";
    const stream = createReadStream(path, { encoding: "latin1" });
    stream.on("data", (chunk) => {
      const text = tail + String(chunk);
      for (const match of text.matchAll(pattern)) found.add(match[0]);
      tail = text.slice(-64);
    });
    stream.on("error", () => resolve([]));
    stream.on("close", () => resolve([...found]));
  });
}

async function claudeModels(binary: string): Promise<string[]> {
  const bundle = await newestClaudeBundle();
  const ids = await scan(bundle ?? binary, CLAUDE_ID);
  const models = ids.filter((id) => CLAUDE_MODEL.test(id) && !CLAUDE_NOT_A_MODEL.test(id));
  return [...CLAUDE_ALIASES, ...models.filter((id) => !models.some((other) => other !== id && other.startsWith(`${id}-`))).sort()];
}

async function newestClaudeBundle(): Promise<string | undefined> {
  const versions = join(homedir(), ".local", "share", "claude", "versions");
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(versions).catch(() => [] as string[]);
  const newest = names.sort().pop();
  return newest ? join(versions, newest) : undefined;
}

export function codexCachedSlugs(cache: unknown): string[] {
  const models = (cache as { models?: { slug?: string; visibility?: string }[] } | undefined)?.models ?? [];
  return (Array.isArray(models) ? models : []).flatMap((model) => model?.visibility !== "hide" && typeof model?.slug === "string" ? [model.slug] : []);
}

async function codexCache(): Promise<unknown> {
  return json(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json")).catch(() => undefined);
}

export function codexEfforts(cache: unknown): Record<string, string[]> {
  const rows = (cache as { models?: { slug?: string; supported_reasoning_levels?: { effort?: string }[] }[] } | undefined)?.models;
  return Object.fromEntries((Array.isArray(rows) ? rows : []).flatMap((row) => typeof row?.slug === "string" && row.slug && Array.isArray(row.supported_reasoning_levels)
    ? [[row.slug, row.supported_reasoning_levels.flatMap((level) => typeof level?.effort === "string" && /^[a-z]+$/.test(level.effort) ? [level.effort] : [])]] : []));
}

export async function validateCatalogEffort(cli: string, options: CliOptions): Promise<void> {
  if (cli !== "codex" || !options.model || !options.effort) return;
  const supported = codexEfforts(await codexCache())[options.model];
  if (supported && !supported.includes(options.effort)) throw new Error(`${options.model} does not advertise ${options.effort} thinking. Supported: ${supported.join(", ") || "none"}. Choose explicitly; Emma will not downgrade it.`);
}

async function piModels(): Promise<string[]> {
  const store = await json(join(homedir(), ".pi", "agent", "models-store.json")).catch(() => undefined);
  const providers = (store as Record<string, { models?: { id?: string }[] }> | undefined) ?? {};
  return Object.entries(providers).flatMap(([provider, entry]) =>
    (entry?.models ?? []).map((model) => (model.id ? `${provider}/${model.id}` : "")));
}

export function modelTableIds(output: string): string[] {
  return terminalText(output).split("\n").flatMap((line) => {
    const id = line.trim().split(/\s+/)[0] ?? "";
    return /^[a-z0-9][a-z0-9._/:+-]*$/.test(id) && !["model", "models", "id", "name", "provider", "available", "default"].includes(id) ? [id] : [];
  });
}

async function listed(binary: string, args: string[], path: string): Promise<string[]> {
  const out = await run(binary, args, path);
  return out.split("\n").map((line) => line.trim()).filter((line) => line && !line.includes(" "));
}

export async function discoverCliModels(cli: string, binary: string, path: string): Promise<string[]> {
  switch (cli) {
    case "claude": return unique(await claudeModels(binary));
    case "codex": return unique(codexCachedSlugs(await codexCache()));
    case "pi": return unique(await piModels());
    case "opencode": return unique(await listed(binary, ["models"], path));
    case "cursor": return unique(modelTableIds(await run(binary, ["--list-models"], path)));
    case "antigravity": return unique(modelTableIds(await run(binary, ["models"], path)));
    default: return [];
  }
}

export class CliModelCatalog {
  private catalog?: Promise<Catalog>;
  private inflight = new Map<string, Promise<CliModels>>();

  constructor(private readonly userData: string) {}

  async read(cli: string, resolve: (bin: string) => Promise<{ binary: string; path: string } | null>, refresh = false): Promise<CliModels> {
    const catalog = await this.load();
    const known = catalog[cli];
    if (!refresh && known && Date.now() - known.at < CLI_MODELS_STALE_MS && (cli !== "codex" || known.effortByModel)) return { cli, ...known };
    const held = this.inflight.get(cli);
    if (held && !refresh) return held;
    const work = this.fetch(cli, resolve, known);
    this.inflight.set(cli, work);
    return work.finally(() => this.inflight.delete(cli));
  }

  private async fetch(cli: string, resolve: (bin: string) => Promise<{ binary: string; path: string } | null>, known: Omit<CliModels, "cli"> | undefined): Promise<CliModels> {
    const found = await resolve(cli);
    if (!found) return { cli, models: known?.models ?? [], at: known?.at ?? 0, effortByModel: known?.effortByModel };
    const models = await discoverCliModels(cli, found.binary, found.path).catch(() => [] as string[]);
    if (!models.length) return { cli, models: known?.models ?? [], at: known?.at ?? 0, effortByModel: known?.effortByModel };
    const catalog = await this.load();
    catalog[cli] = { at: Date.now(), models, ...(cli === "codex" ? { effortByModel: codexEfforts(await codexCache()) } : {}) };
    this.catalog = Promise.resolve(catalog);
    await writeFile(join(this.userData, CACHE_FILE), JSON.stringify(catalog), "utf8").catch(() => undefined);
    return { cli, ...catalog[cli]! };
  }

  private load(): Promise<Catalog> {
    this.catalog ??= readFile(join(this.userData, CACHE_FILE), "utf8")
      .then((text) => JSON.parse(text) as Catalog)
      .catch(() => ({}) as Catalog);
    return this.catalog;
  }
}
