import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createGunzip } from "node:zlib";
import {
  MARKETPLACE_FILES,
  PLUGIN_HOOKS_FILE,
  PLUGIN_MANIFEST,
  parseHooksFile,
  parseHostedApps,
  parseMarketplace,
  parseMarketplaceSource,
  parsePluginInterface,
  parsePluginManifest,
  pluginSlug,
  type HostedApp,
  type InstalledPlugin,
  type Marketplace,
  type MarketplacePlugin,
  type PluginCatalog,
  type PluginDetail,
  type PluginHook,
  type PluginManifest,
  type PluginSource,
  type RunnableHookEvent,
  type WrittenPlugin,
} from "../shared/plugins";
import { findExecutable, isWindows, pathInside, shellArguments, shellBinary, spawnCommand, terminateProcessTree, windowsSystemExecutable } from "./platform";

const DEFAULT_MARKETPLACE = "openai/plugins";
const MAX_JSON_BYTES = 512 * 1024;
const MAX_MARKETPLACES = 32;
const MAX_INSTALLED = 128;
const MAX_SKILLS_PER_PLUGIN = 64;
const MAX_HOSTED_APPS = 16;
const MAX_ICON_BYTES = 512 * 1024;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MAX_CARD_ICONS = 128;
const CARD_ICON_BUDGET_BYTES = 4 * 1024 * 1024;
const CLONE_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 30_000;
const NPM_TIMEOUT_MS = 120_000;
const MAX_NPM_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_HOOKS_PER_PLUGIN = 32;
const MAX_HOOK_OUTPUT_BYTES = 8 * 1024;
const HOOK_SECONDS = 10;
const MAX_HOOK_SECONDS = 60;
const MAX_SESSION_END_SECONDS = 3;
let gitExecutable: { pathValue: string; value: Promise<string | null> } | undefined;
let npmExecutable: { pathValue: string; value: Promise<string | null> } | undefined;
let tarExecutable: { pathValue: string; value: Promise<string | null> } | undefined;

export function marketplaceRoot(userData: string) {
  return path.join(userData, "marketplaces");
}

function sourcesFile(userData: string) {
  return path.join(marketplaceRoot(userData), "sources.json");
}

function defaultMarketplaceMark(userData: string) {
  return path.join(marketplaceRoot(userData), ".default-added");
}

function installedFile(userData: string) {
  return path.join(userData, "installed-plugins.json");
}

function hookTrustFile(userData: string) {
  return path.join(userData, "plugin-hooks.json");
}

export function pluginDataRoot(userData: string, id: string) {
  const [marketplace, name] = id.split("/");
  return path.join(userData, "plugin-data", pluginSlug(marketplace), pluginSlug(name));
}

export function hookHash(hook: PluginHook) {
  return createHash("sha256").update(JSON.stringify([hook.event, hook.matcher, hook.command, hook.statusMessage, hook.timeout])).digest("hex").slice(0, 32);
}

export function authoredMarketplaceRoot(userData: string) {
  return path.join(marketplaceRoot(userData), "emma");
}

type StoredSource = { id: string; origin: string; ref: string; sparse: string[]; local: boolean; path: string };

async function readJson(file: string, max = MAX_JSON_BYTES): Promise<unknown> {
  const handle = await open(file, "r");
  try {
    const information = await handle.stat();
    if (!information.isFile() || information.size > max) throw new Error(`${path.basename(file)} is too large`);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile()));
  } finally {
    await handle.close();
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const MISSING_TOOL: Record<string, string> = {
  git: "Git is not installed — install Git and try again.",
  npm: "npm is not installed — install Node.js and try again, or ask the marketplace for a Git source.",
  tar: "tar is missing, so Emma cannot unpack an npm package.",
};

function execute(command: string, cwd: string, args: string[], timeout: number, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    let settled = false;
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (target === "stdout") stdout += String(chunk);
      else stderr += String(chunk);
      if (Buffer.byteLength(stdout) > 8 * 1024 * 1024 || Buffer.byteLength(stderr) > 8 * 1024 * 1024) {
        overflow = true;
        if (child.pid !== undefined) terminateProcessTree(child.pid, "SIGKILL", false);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) terminateProcessTree(child.pid, "SIGKILL", false);
    }, timeout);
    timer.unref();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const name = path.basename(command).replace(/\.(?:cmd|exe)$/i, "");
        finish(new Error(MISSING_TOOL[name] ?? `Emma cannot find "${name}".`));
      } else {
        finish(error);
      }
    });
    child.once("close", (code) => {
      if (code === 0 && !overflow && !timedOut) return finish();
      if (overflow) return finish(new Error(`${command} produced more than 8 MB of output.`));
      if (timedOut) return finish(new Error(`${command} timed out after ${Math.ceil(timeout / 1000)} seconds.`));
      const line = `${stderr}\n${stdout}`.split("\n")
        .map((each) => each.replace(/^npm (?:error|ERR!)\s*/, "").trim())
        .find((each) => each && !/^(?:code E\w+|\d+)$/.test(each) && !each.startsWith("A complete log of this run"));
      finish(new Error((line ?? "").slice(0, 240) || `${command} failed`));
    });
  });
}

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  const pathValue = process.env.PATH || "";
  if (!gitExecutable || gitExecutable.pathValue !== pathValue) gitExecutable = { pathValue, value: findExecutable(isWindows ? "git.exe" : "git", pathValue) };
  const binary = await gitExecutable.value;
  if (!binary) throw new Error(MISSING_TOOL.git);
  return execute(binary, cwd, args, timeout, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_ASKPASS: "", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" });
}

async function npm(cwd: string, args: string[], timeout = NPM_TIMEOUT_MS): Promise<string> {
  const pathValue = process.env.PATH || "";
  if (!npmExecutable || npmExecutable.pathValue !== pathValue) {
    const value = isWindows
      ? findExecutable(path.join(path.dirname(process.execPath), "npm.cmd")).then((found) => found ?? findExecutable("npm.cmd", pathValue))
      : findExecutable("npm", pathValue);
    npmExecutable = { pathValue, value };
  }
  const binary = await npmExecutable.value;
  if (!binary) throw new Error(MISSING_TOOL.npm);
  return execute(binary, cwd, args, timeout, {
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_progress: "false",
    NO_UPDATE_NOTIFIER: "1",
  });
}

async function exists(value: string) {
  try { await stat(value); return true; } catch { return false; }
}

async function inside(root: string, ...parts: string[]) {
  const target = path.join(root, ...parts);
  if (!await exists(target)) return "";
  const real = await realpath(target);
  const realRoot = await realpath(root);
  return pathInside(realRoot, real) ? real : "";
}

async function cloneRepo(url: string, ref: string, sparse: string[], destination: string) {
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const args = ["-c", "core.symlinks=false", "clone", "--depth", "1", "--no-tags", "--filter=blob:none"];
  if (sparse.length) args.push("--sparse");
  if (ref) args.push("--branch", ref);
  args.push("--", url, destination);
  await git(parent, args, CLONE_TIMEOUT_MS);
  if (sparse.length) await git(destination, ["sparse-checkout", "set", "--", ...sparse]);
}

async function fetchNpmPackage(source: Extract<PluginSource, { kind: "npm" }>, destination: string) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const args = ["pack", "--ignore-scripts", "--pack-destination", destination];
  if (source.registry) args.push("--registry", source.registry);
  args.push("--", source.version ? `${source.package}@${source.version}` : source.package);
  await npm(destination, args);
  const tarball = (await readdir(destination)).find((entry) => entry.endsWith(".tgz"));
  if (!tarball) throw new Error(`npm published no tarball for ${source.package}.`);
  await unpack(path.join(destination, tarball), destination);
  await rm(path.join(destination, tarball), { force: true });
}

export async function unpack(tarball: string, destination: string, cap = MAX_NPM_UNPACKED_BYTES): Promise<void> {
  const pathValue = process.env.PATH || "";
  if (!tarExecutable || tarExecutable.pathValue !== pathValue) tarExecutable = { pathValue, value: findExecutable(isWindows ? windowsSystemExecutable("tar.exe") : "tar", pathValue) };
  const binary = await tarExecutable.value;
  if (!binary) throw new Error(MISSING_TOOL.tar);
  return new Promise((resolve, reject) => {
    const child = spawnCommand(binary, ["-xf", "-", "-C", destination], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    const stream = createReadStream(tarball).pipe(createGunzip());
    const stdin = child.stdin;
    const stderrStream = child.stderr;
    if (!stdin || !stderrStream) {
      stream.destroy();
      child.kill();
      reject(new Error("tar could not open its input and error streams."));
      return;
    }
    let stderr = "";
    let unpacked = 0;
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      if (child.pid !== undefined) terminateProcessTree(child.pid, "SIGKILL", false);
      reject(new Error(message));
    };
    stderrStream.on("data", (chunk) => { if (stderr.length < 4096) stderr += String(chunk); });
    stdin.on("error", () => undefined);
    child.once("error", (error) => fail((error as NodeJS.ErrnoException).code === "ENOENT" ? MISSING_TOOL.tar : error.message));
    stream.on("error", (error) => fail(`the npm package could not be unpacked — ${error.message}`));
    stream.on("data", (chunk: Buffer) => {
      unpacked += chunk.length;
      if (unpacked > cap) fail(`the npm package unpacks to more than ${Math.max(1, cap >> 20)} MB, so Emma stopped before filling the disk.`);
    });
    stream.pipe(stdin);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(firstLine(stderr) || `tar could not unpack the npm package (exit ${code}).`));
    });
  });
}

export function imageType(bytes: Buffer): string {
  if (bytes.length < 12) return "";
  const head = bytes.subarray(0, 12).toString("latin1");
  if (bytes.subarray(0, 8).toString("latin1") === "\x89PNG\r\n\x1a\n") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return "";
}

async function readImage(root: string, relative: string, max: number): Promise<string> {
  if (!relative || max <= 0) return "";
  const file = await inside(root, ...relative.split(/[\\/]/));
  if (!file) return "";
  try {
    const handle = await open(file, "r");
    try {
      const information = await handle.stat();
      if (!information.isFile() || information.size > max) return "";
      const bytes = await handle.readFile();
      const type = imageType(bytes);
      return type ? `data:${type};base64,${bytes.toString("base64")}` : "";
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

async function readHostedApps(root: string, relative: string): Promise<HostedApp[]> {
  if (!relative) return [];
  const file = await inside(root, ...relative.split(/[\\/]/));
  if (!file) return [];
  try { return parseHostedApps(await readJson(file)); } catch { return []; }
}

async function readMarketplaceFile(root: string) {
  for (const candidate of MARKETPLACE_FILES) {
    const file = await inside(root, ...candidate.split(/[\\/]/));
    if (file) return parseMarketplace(await readJson(file));
  }
  throw new Error(`No marketplace.json here — Emma looked for ${MARKETPLACE_FILES.join(", ")}.`);
}

async function readSources(userData: string): Promise<StoredSource[]> {
  let stored: unknown;
  try { stored = await readJson(sourcesFile(userData)); } catch { return []; }
  const raw = stored && typeof stored === "object" ? (stored as { sources?: unknown }).sources : undefined;
  if (!Array.isArray(raw)) return [];
  const sources: StoredSource[] = [];
  for (const entry of raw.slice(0, MAX_MARKETPLACES)) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.origin !== "string" || typeof item.path !== "string" || !path.isAbsolute(item.path)) continue;
    try { pluginSlug(item.id); } catch { continue; }
    sources.push({
      id: item.id,
      origin: item.origin,
      ref: typeof item.ref === "string" ? item.ref : "",
      sparse: Array.isArray(item.sparse) ? item.sparse.filter((value): value is string => typeof value === "string") : [],
      local: item.local === true,
      path: item.path,
    });
  }
  return sources;
}

type StoredPlugin = Omit<InstalledPlugin, "hooks">;

async function readInstalled(userData: string): Promise<StoredPlugin[]> {
  let stored: unknown;
  try { stored = await readJson(installedFile(userData)); } catch { return []; }
  const raw = stored && typeof stored === "object" ? (stored as { installed?: unknown }).installed : undefined;
  if (!Array.isArray(raw)) return [];
  const installed: StoredPlugin[] = [];
  for (const entry of raw.slice(0, MAX_INSTALLED)) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.root !== "string" || !path.isAbsolute(item.root)) continue;
    const strings = (value: unknown) => Array.isArray(value) ? value.filter((each): each is string => typeof each === "string" && path.isAbsolute(each)).slice(0, MAX_SKILLS_PER_PLUGIN) : [];
    const apps = (value: unknown) => Array.isArray(value)
      ? value.slice(0, MAX_HOSTED_APPS)
        .map((each) => (each ?? {}) as Record<string, unknown>)
        .filter((each) => typeof each.id === "string" && each.id.length > 0 && each.id.length <= 256)
        .map((each) => ({ name: String(each.name ?? each.id).slice(0, 128), id: String(each.id), category: String(each.category ?? "").slice(0, 48) }))
      : [];
    installed.push({
      id: item.id,
      marketplace: String(item.marketplace ?? ""),
      name: String(item.name ?? ""),
      displayName: String(item.displayName ?? item.name ?? ""),
      version: String(item.version ?? "0.0.0"),
      description: String(item.description ?? ""),
      category: String(item.category ?? ""),
      root: item.root,
      skills: strings(item.skills),
      mcpServers: strings(item.mcpServers),
      apps: apps(item.apps),
      installedAt: String(item.installedAt ?? ""),
    });
  }
  return installed;
}

async function bundledRoot(marketplaceRootPath: string, plugin: MarketplacePlugin) {
  return plugin.source.kind === "local" ? await inside(marketplaceRootPath, ...plugin.source.path.split(/[\\/]/)) : "";
}

async function readManifestAt(root: string) {
  const manifestFile = await inside(root, ...PLUGIN_MANIFEST.split(/[\\/]/));
  return manifestFile ? parsePluginManifest(await readJson(manifestFile)) : undefined;
}

async function readHooksAt(root: string, manifest: PluginManifest): Promise<PluginHook[]> {
  const named = manifest.hooks.paths.length > 0 || manifest.hooks.inline.length > 0;
  const hooks = named ? [...manifest.hooks.inline] : [];
  for (const relative of named ? manifest.hooks.paths : [PLUGIN_HOOKS_FILE]) {
    const file = await inside(root, ...relative.split(/[\\/]/));
    if (!file) continue;
    try { hooks.push(...parseHooksFile(await readJson(file))); } catch { continue; }
  }
  return hooks.slice(0, MAX_HOOKS_PER_PLUGIN);
}

async function readTrust(userData: string): Promise<Record<string, string[]>> {
  let stored: unknown;
  try { stored = await readJson(hookTrustFile(userData)); } catch { return {}; }
  const raw = stored && typeof stored === "object" ? (stored as { trusted?: unknown }).trusted : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const trusted: Record<string, string[]> = {};
  for (const [id, hashes] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_INSTALLED)) {
    if (!Array.isArray(hashes) || id.length > 256) continue;
    trusted[id] = hashes.filter((each): each is string => typeof each === "string" && /^[0-9a-f]{32}$/.test(each)).slice(0, MAX_HOOKS_PER_PLUGIN);
  }
  return trusted;
}

async function forgetTrust(userData: string, keeping: StoredPlugin[]) {
  const trusted = await readTrust(userData);
  const ids = new Set(keeping.map((entry) => entry.id));
  const gone = Object.keys(trusted).filter((id) => !ids.has(id));
  if (!gone.length) return;
  for (const id of gone) delete trusted[id];
  await writeJson(hookTrustFile(userData), { version: 1, trusted });
}

/** Exported for the phone's audit list, which wants the installed plugins and their hooks and
    nothing else: readCatalog also reads every marketplace listing off disk and base64s up to 4 MB
    of card icons, none of which fits in a frame or is any use to a screen that cannot browse. */
export async function installedHooks(userData: string): Promise<InstalledPlugin[]> {
  const installed = await readInstalled(userData);
  if (!installed.length) return [];
  const trusted = await readTrust(userData);
  return await Promise.all(installed.map(async (plugin): Promise<InstalledPlugin> => {
    const known = trusted[plugin.id] ?? [];
    let hooks: PluginHook[] = [];
    try {
      const manifest = await readManifestAt(plugin.root);
      if (manifest) hooks = await readHooksAt(plugin.root, manifest);
    } catch { hooks = []; }
    return { ...plugin, hooks: hooks.map((hook) => {
      const hash = hookHash(hook);
      return { ...hook, hash, trusted: known.includes(hash) };
    }) };
  }));
}

async function decorateCards(marketplaces: Marketplace[]) {
  let budget = CARD_ICON_BUDGET_BYTES;
  let remaining = MAX_CARD_ICONS;
  for (const marketplace of marketplaces) {
    for (const plugin of marketplace.plugins) {
      if (remaining <= 0 || budget <= 0) return;
      const root = await bundledRoot(marketplace.root, plugin);
      if (!root) continue;
      remaining -= 1;
      try {
        const manifest = await readManifestAt(root);
        if (!manifest) continue;
        if (plugin.displayName === plugin.name) plugin.displayName = manifest.displayName;
        if (!plugin.description) plugin.description = manifest.description;
        if (!plugin.category) plugin.category = manifest.category;
        plugin.brandColor = manifest.interface.brandColor;
        plugin.icon = await readImage(root, manifest.interface.composerIcon || manifest.interface.logo, Math.min(MAX_ICON_BYTES, budget));
        budget -= plugin.icon.length;
      } catch { continue; }
    }
  }
}

export async function readCatalog(userData: string): Promise<PluginCatalog> {
  const sources = await readSources(userData);
  const marketplaces = await Promise.all(sources.map(async (source): Promise<Marketplace> => {
    const shell = { id: source.id, displayName: source.id, origin: source.origin, ref: source.ref, sparse: source.sparse, local: source.local, root: source.path, plugins: [] };
    try {
      const listing = await readMarketplaceFile(source.path);
      return { ...shell, displayName: listing.displayName, plugins: listing.plugins };
    } catch (error) {
      return { ...shell, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  await decorateCards(marketplaces);
  return { marketplaces, installed: await installedHooks(userData) };
}

export async function pluginDetail(userData: string, marketplaceId: unknown, pluginName: unknown): Promise<PluginDetail> {
  const marketplaceSlug = pluginSlug(marketplaceId);
  const name = pluginSlug(pluginName);
  const blank: PluginDetail = { interface: parsePluginInterface({}), icon: "", logo: "", screenshots: [], apps: [] };
  const installed = (await readInstalled(userData)).find((entry) => entry.id === `${marketplaceSlug}/${name}`);
  let root = installed?.root ?? "";
  if (!root) {
    const source = (await readSources(userData)).find((entry) => entry.id === marketplaceSlug);
    if (!source) return blank;
    try {
      const listing = await readMarketplaceFile(source.path);
      const plugin = listing.plugins.find((entry) => entry.name === name);
      if (!plugin) return blank;
      root = await bundledRoot(source.path, plugin);
    } catch { return blank; }
  }
  if (!root) return blank;
  try {
    const manifest = await readManifestAt(root);
    if (!manifest) return blank;
    const screenshots: string[] = [];
    for (const relative of manifest.interface.screenshots) {
      const image = await readImage(root, relative, MAX_SCREENSHOT_BYTES);
      if (image) screenshots.push(image);
    }
    return {
      interface: manifest.interface,
      icon: await readImage(root, manifest.interface.composerIcon, MAX_ICON_BYTES),
      logo: await readImage(root, manifest.interface.logo, MAX_ICON_BYTES),
      screenshots,
      apps: installed?.apps.length ? installed.apps : await readHostedApps(root, manifest.apps),
    };
  } catch {
    return blank;
  }
}

export async function addMarketplace(userData: string, request: { source: unknown; ref?: unknown; sparse?: unknown }): Promise<PluginCatalog> {
  const source = parseMarketplaceSource(request.source, request.ref, request.sparse);
  const sources = await readSources(userData);
  if (sources.length >= MAX_MARKETPLACES) throw new Error(`Emma already tracks ${MAX_MARKETPLACES} marketplaces — remove one first.`);
  const root = marketplaceRoot(userData);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let checkout = "";
  let stored: StoredSource;
  if (source.kind === "local") {
    const directory = source.path.startsWith("~") ? path.resolve(homedir(), source.path.slice(1).replace(/^[\\/]+/, "")) : path.resolve(source.path);
    if (!await exists(directory)) throw new Error(`There is no folder at ${directory}.`);
    const listing = await readMarketplaceFile(directory);
    stored = { id: listing.name, origin: directory, ref: "", sparse: [], local: true, path: directory };
  } else {
    checkout = path.join(root, `.staging-${randomUUID()}`);
    try {
      await cloneRepo(source.url, source.ref, source.sparse, checkout);
      const listing = await readMarketplaceFile(checkout);
      stored = { id: listing.name, origin: source.url, ref: source.ref, sparse: source.sparse, local: false, path: path.join(root, listing.name) };
    } catch (error) {
      await rm(checkout, { recursive: true, force: true });
      throw error;
    }
  }
  if (sources.some((entry) => entry.id === stored.id)) {
    await rm(checkout, { recursive: true, force: true });
    throw new Error(`A marketplace named "${stored.id}" is already added.`);
  }
  if (checkout) {
    await rm(stored.path, { recursive: true, force: true });
    await rename(checkout, stored.path);
  }
  await writeJson(sourcesFile(userData), { version: 1, sources: [...sources, stored] });
  return readCatalog(userData);
}

export async function ensureDefaultMarketplace(userData: string, source: string = DEFAULT_MARKETPLACE): Promise<PluginCatalog> {
  const mark = defaultMarketplaceMark(userData);
  if (await exists(mark) || (await readSources(userData)).length) return readCatalog(userData);
  const catalog = await addMarketplace(userData, { source });
  await writeFile(mark, "", { encoding: "utf8", mode: 0o600 });
  return catalog;
}

export async function removeMarketplace(userData: string, id: unknown): Promise<PluginCatalog> {
  const slug = pluginSlug(id);
  const sources = await readSources(userData);
  const source = sources.find((entry) => entry.id === slug);
  if (!source) throw new Error(`Emma is not tracking a marketplace named "${slug}".`);
  const installed = (await readInstalled(userData)).filter((plugin) => plugin.marketplace !== slug);
  await writeJson(installedFile(userData), { version: 1, installed });
  await forgetTrust(userData, installed);
  await writeJson(sourcesFile(userData), { version: 1, sources: sources.filter((entry) => entry.id !== slug) });
  if (!source.local) await rm(path.join(marketplaceRoot(userData), slug), { recursive: true, force: true });
  return readCatalog(userData);
}

export async function refreshMarketplace(userData: string, id: unknown): Promise<PluginCatalog> {
  const slug = pluginSlug(id);
  const source = (await readSources(userData)).find((entry) => entry.id === slug);
  if (!source) throw new Error(`Emma is not tracking a marketplace named "${slug}".`);
  if (source.local) return readCatalog(userData);
  await git(source.path, ["fetch", "--depth", "1", "origin", source.ref || "HEAD"]);
  await git(source.path, ["reset", "--hard", "FETCH_HEAD"]);
  return readCatalog(userData);
}

async function resolvePluginRoot(userData: string, marketplace: Marketplace, plugin: MarketplacePlugin) {
  if (plugin.source.kind === "unsupported") throw new Error(`Emma cannot install "${plugin.name}": ${plugin.source.reason}.`);
  if (plugin.source.kind === "local") {
    const root = await inside(marketplace.root, ...plugin.source.path.split(/[\\/]/));
    if (!root) throw new Error(`"${plugin.name}" points at ${plugin.source.path}, which is not in this marketplace.`);
    return root;
  }
  const checkout = path.join(marketplaceRoot(userData), ".remote", marketplace.id, plugin.name);
  if (plugin.source.kind === "npm") {
    await fetchNpmPackage(plugin.source, checkout);
    const root = await inside(checkout, "package");
    if (!root) throw new Error(`${plugin.source.package} unpacked without a package/ directory, so Emma cannot read it as a plugin.`);
    return root;
  }
  await rm(checkout, { recursive: true, force: true });
  await cloneRepo(plugin.source.url, plugin.source.ref, plugin.source.path ? [plugin.source.path] : [], checkout);
  const root = plugin.source.path ? await inside(checkout, ...plugin.source.path.split(/[\\/]/)) : checkout;
  if (!root) throw new Error(`"${plugin.name}" is not at ${plugin.source.path} in ${plugin.source.url}.`);
  return root;
}

async function readPluginAt(root: string) {
  const manifestFile = await inside(root, ...PLUGIN_MANIFEST.split(/[\\/]/));
  if (!manifestFile) throw new Error(`There is no ${PLUGIN_MANIFEST} in ${root} — that folder is not a plugin.`);
  const manifest = parsePluginManifest(await readJson(manifestFile));
  const skills = manifest.skills ? await inside(root, ...manifest.skills.split(/[\\/]/)) : "";
  const mcp = manifest.mcpServers ? await inside(root, ...manifest.mcpServers.split(/[\\/]/)) : "";
  const apps = await readHostedApps(root, manifest.apps);
  const hooks = await readHooksAt(root, manifest);
  if (!skills && !mcp && !apps.length && !hooks.length) throw new Error(`"${manifest.name}" carries no skills and no MCP servers Emma can use.`);
  return { manifest, skills, mcp, apps };
}

export async function installPlugin(userData: string, marketplaceId: unknown, pluginName: unknown): Promise<PluginCatalog> {
  const marketplaceSlug = pluginSlug(marketplaceId);
  const pluginSlugName = pluginSlug(pluginName);
  const catalog = await readCatalog(userData);
  const marketplace = catalog.marketplaces.find((entry) => entry.id === marketplaceSlug);
  if (!marketplace) throw new Error(`Emma is not tracking a marketplace named "${marketplaceSlug}".`);
  const plugin = marketplace.plugins.find((entry) => entry.name === pluginSlugName);
  if (!plugin) throw new Error(`"${marketplaceSlug}" does not list a plugin named "${pluginSlugName}".`);
  if (plugin.installation === "NOT_AVAILABLE") throw new Error(`"${plugin.displayName}" is marked unavailable by its marketplace.`);
  if (catalog.installed.length >= MAX_INSTALLED) throw new Error(`Emma already has ${MAX_INSTALLED} plugins installed — remove one first.`);
  const root = await resolvePluginRoot(userData, marketplace, plugin);
  const { manifest, skills, mcp, apps } = await readPluginAt(root);
  const id = `${marketplaceSlug}/${pluginSlugName}`;
  const record: StoredPlugin = {
    id,
    marketplace: marketplaceSlug,
    name: pluginSlugName,
    displayName: plugin.displayName || manifest.displayName,
    version: manifest.version,
    description: plugin.description || manifest.description,
    category: plugin.category || manifest.category,
    root,
    skills: skills ? [skills] : [],
    mcpServers: mcp ? [mcp] : [],
    apps,
    installedAt: new Date().toISOString(),
  };
  const stored = (await readInstalled(userData)).filter((entry) => entry.id !== id);
  await writeJson(installedFile(userData), { version: 1, installed: [...stored, record] });
  return readCatalog(userData);
}

export async function uninstallPlugin(userData: string, id: unknown): Promise<PluginCatalog> {
  if (typeof id !== "string" || id.length > 256) throw new Error("Plugin id is invalid");
  const installed = await readInstalled(userData);
  const plugin = installed.find((entry) => entry.id === id);
  if (!plugin) throw new Error(`No plugin called "${id}" is installed.`);
  const kept = installed.filter((entry) => entry.id !== id);
  await writeJson(installedFile(userData), { version: 1, installed: kept });
  await forgetTrust(userData, kept);
  return readCatalog(userData);
}

/** The write on its own, for the phone, which already holds the plugin it just put in front of a
    person and has no use for the catalogue readCatalog would read back — every marketplace listing
    off disk and up to 4 MB of base64 card icons, none of which fits in a frame. Passing null
    withdraws trust. */
export async function setHookTrust(userData: string, id: unknown, hashes: string[] | null): Promise<void> {
  if (typeof id !== "string" || id.length > 256) throw new Error("Plugin id is invalid");
  const trusted = await readTrust(userData);
  if (hashes) trusted[id] = hashes;
  else delete trusted[id];
  await writeJson(hookTrustFile(userData), { version: 1, trusted });
}

export async function trustPluginHooks(userData: string, id: unknown, trust: unknown): Promise<PluginCatalog> {
  if (typeof id !== "string" || id.length > 256) throw new Error("Plugin id is invalid");
  const plugin = (await installedHooks(userData)).find((entry) => entry.id === id);
  if (!plugin) throw new Error(`No plugin called "${id}" is installed.`);
  await setHookTrust(userData, id, trust === true ? plugin.hooks.map((hook) => hook.hash) : null);
  return readCatalog(userData);
}

function hookMatches(hook: PluginHook, subject: string) {
  if (!hook.matcher || !subject) return true;
  try { return new RegExp(hook.matcher).test(subject); } catch { return false; }
}

function firstLine(output: string) {
  return output.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 200) ?? "";
}

function runHook(hook: PluginHook, root: string, data: string, cwd: string, input: unknown, seconds: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(isWindows ? shellBinary() : "/bin/sh", isWindows ? shellArguments(hook.command, false) : ["-c", hook.command], {
      cwd,
      detached: !isWindows,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? homedir(),
        ...(isWindows ? {
          USERPROFILE: process.env.USERPROFILE ?? homedir(),
          APPDATA: process.env.APPDATA ?? "",
          LOCALAPPDATA: process.env.LOCALAPPDATA ?? "",
          ComSpec: process.env.ComSpec ?? "cmd.exe",
          PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
        } : {}),
        PLUGIN_ROOT: root,
        PLUGIN_DATA: data,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PLUGIN_DATA: data,
      },
    });
    let output = "";
    const keep = (chunk: unknown) => {
      if (output.length < MAX_HOOK_OUTPUT_BYTES) output += String(chunk).slice(0, MAX_HOOK_OUTPUT_BYTES - output.length);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.stdin.on("error", () => undefined);
    let settled = false;
    const settle = (failure: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(failure);
    };
    const timer = setTimeout(() => {
      if (child.pid) terminateProcessTree(child.pid, "SIGKILL");
      settle(`ran past ${seconds}s and was stopped`);
    }, seconds * 1000);
    child.once("error", (error) => settle(`could not start — ${error.message}`));
    child.once("close", (code) => {
      const line = firstLine(output);
      settle(code === 0 ? "" : `exited ${code ?? 0}${line ? ` — ${line}` : ""}`);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function runPluginHooks(userData: string, event: RunnableHookEvent, input: Record<string, unknown>): Promise<string[]> {
  const subject = event === "SessionStart" ? String(input.source ?? "") : event === "SessionEnd" ? String(input.reason ?? "") : "";
  const cwd = typeof input.cwd === "string" ? input.cwd : homedir();
  const ceiling = event === "SessionEnd" ? MAX_SESSION_END_SECONDS : MAX_HOOK_SECONDS;
  const running: Promise<string>[] = [];
  for (const plugin of await installedHooks(userData)) {
    const matched = plugin.hooks.filter((hook) => hook.event === event && hook.trusted && hookMatches(hook, subject));
    if (!matched.length) continue;
    const data = pluginDataRoot(userData, plugin.id);
    await mkdir(data, { recursive: true, mode: 0o700 });
    for (const hook of matched) {
      const seconds = Math.min(hook.timeout || HOOK_SECONDS, ceiling);
      running.push(runHook(hook, plugin.root, data, cwd, input, seconds)
        .then((failure) => (failure ? `${plugin.displayName || plugin.name} · ${event} hook ${failure}` : "")));
    }
  }
  return (await Promise.all(running)).filter(Boolean);
}

export async function installedCapabilitySources(userData: string) {
  return (await readInstalled(userData)).map((plugin) => ({ id: `plugin:${plugin.id}`, skillRoots: plugin.skills, mcpFiles: plugin.mcpServers }));
}

export async function writePlugin(userData: string, request: unknown): Promise<{ catalog: PluginCatalog; plugin: WrittenPlugin & { root: string } }> {
  if (!request || typeof request !== "object") throw new Error("Plugin definition is invalid");
  const raw = request as Record<string, unknown>;
  const name = pluginSlug(raw.name);
  const description = typeof raw.description === "string" ? raw.description.slice(0, 512).trim() : "";
  if (!description) throw new Error("A plugin needs a one-line description.");
  const listed = Array.isArray(raw.skills) ? raw.skills.slice(0, MAX_SKILLS_PER_PLUGIN) : [];
  const skills = listed.map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const instructions = typeof item.instructions === "string" ? item.instructions : "";
    if (!instructions.trim() || instructions.length > 64 * 1024) throw new Error("Every skill needs instructions, under 64KB.");
    return {
      name: pluginSlug(item.name),
      description: typeof item.description === "string" ? item.description.slice(0, 512).trim() : "",
      instructions,
    };
  });
  if (!skills.length) throw new Error("A plugin needs at least one skill.");
  const category = typeof raw.category === "string" ? raw.category : "";
  const home = authoredMarketplaceRoot(userData);
  const root = path.join(home, "plugins", name);
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, ".codex-plugin"), { recursive: true, mode: 0o700 });
  await writeJson(path.join(root, PLUGIN_MANIFEST), {
    name,
    version: "0.1.0",
    description,
    skills: "./skills/",
    interface: { displayName: name, shortDescription: description, developerName: "Emma", category: category || "Productivity" },
  });
  for (const skill of skills) {
    await mkdir(path.join(root, "skills", skill.name), { recursive: true, mode: 0o700 });
    const frontmatter = `---\nname: ${skill.name}\ndescription: "${(skill.description || description).replace(/"/g, "'")}"\n---\n\n`;
    await writeFile(path.join(root, "skills", skill.name, "SKILL.md"), skill.instructions.startsWith("---\n") ? skill.instructions : frontmatter + skill.instructions, { encoding: "utf8", mode: 0o600 });
  }
  const listing = path.join(home, ".agents", "plugins", "marketplace.json");
  let entries: unknown[] = [];
  try {
    const current = await readJson(listing) as { plugins?: unknown };
    if (Array.isArray(current.plugins)) entries = current.plugins.filter((entry) => (entry as { name?: unknown })?.name !== name);
  } catch { entries = []; }
  await writeJson(listing, {
    name: "emma",
    interface: { displayName: "Written by Emma" },
    plugins: [...entries, { name, description, source: { source: "local", path: `./plugins/${name}` }, policy: { installation: "AVAILABLE" }, category: category || "Productivity" }],
  });
  const sources = await readSources(userData);
  if (!sources.some((entry) => entry.id === "emma")) {
    await writeJson(sourcesFile(userData), { version: 1, sources: [...sources, { id: "emma", origin: home, ref: "", sparse: [], local: true, path: home }] });
  }
  return { catalog: await installPlugin(userData, "emma", name), plugin: { name, description, category, skills, root } };
}
