import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLI_MODELS_STALE_MS, MAX_CLI_MODELS, type CliModels } from "../shared/cli";
import { spawnCommand, terminateProcessTree } from "./platform";

const CACHE_FILE = "cli-models.json";
const LIST_MS = 30_000;
const MAX_LIST_BYTES = 1024 * 1024;
const CLAUDE_ID = /claude-[a-z0-9]+(?:-[a-z0-9]+)*/g;
const CLAUDE_MODEL = /^claude-[a-z0-9-]*[a-z]-[0-9]+(?:-[0-9]{8})?$|^claude-[0-9]+(?:-[0-9]+)?-[a-z]+(?:-[0-9]{8})?$/;
const CLAUDE_NOT_A_MODEL = /^claude-(code|desktop|instant|api|cli|ai)\b/;
const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku"];

type Catalog = Record<string, { at: number; models: string[] }>;

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

async function codexModels(): Promise<string[]> {
  const cache = await json(join(homedir(), ".codex", "models_cache.json")).catch(() => undefined);
  const models = (cache as { models?: { slug?: string }[] } | undefined)?.models ?? [];
  return models.map((model) => model.slug ?? "");
}

async function piModels(): Promise<string[]> {
  const store = await json(join(homedir(), ".pi", "agent", "models-store.json")).catch(() => undefined);
  const providers = (store as Record<string, { models?: { id?: string }[] }> | undefined) ?? {};
  return Object.entries(providers).flatMap(([provider, entry]) =>
    (entry?.models ?? []).map((model) => (model.id ? `${provider}/${model.id}` : "")));
}

async function listed(binary: string, args: string[], path: string): Promise<string[]> {
  const out = await run(binary, args, path);
  return out.split("\n").map((line) => line.trim()).filter((line) => line && !line.includes(" "));
}

export async function discoverCliModels(cli: string, binary: string, path: string): Promise<string[]> {
  switch (cli) {
    case "claude": return unique(await claudeModels(binary));
    case "codex": return unique(await codexModels());
    case "pi": return unique(await piModels());
    case "opencode": return unique(await listed(binary, ["models"], path));
    case "cursor": return unique(await listed(binary, ["--list-models"], path));
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
    if (!refresh && known && Date.now() - known.at < CLI_MODELS_STALE_MS) return { cli, ...known };
    const held = this.inflight.get(cli);
    if (held && !refresh) return held;
    const work = this.fetch(cli, resolve, known);
    this.inflight.set(cli, work);
    return work.finally(() => this.inflight.delete(cli));
  }

  private async fetch(cli: string, resolve: (bin: string) => Promise<{ binary: string; path: string } | null>, known: { at: number; models: string[] } | undefined): Promise<CliModels> {
    const found = await resolve(cli);
    if (!found) return { cli, models: known?.models ?? [], at: known?.at ?? 0 };
    const models = await discoverCliModels(cli, found.binary, found.path).catch(() => [] as string[]);
    if (!models.length) return { cli, models: known?.models ?? [], at: known?.at ?? 0 };
    const catalog = await this.load();
    catalog[cli] = { at: Date.now(), models };
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
