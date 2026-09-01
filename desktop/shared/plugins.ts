export const MARKETPLACE_FILES = [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json", "marketplace.json"] as const;

export const PLUGIN_MANIFEST = ".codex-plugin/plugin.json";

export const PLUGIN_HOOKS_FILE = "hooks/hooks.json";

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export const RUNNABLE_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] as const;

export type RunnableHookEvent = (typeof RUNNABLE_HOOK_EVENTS)[number];

export const hookRuns = (event: HookEvent): event is RunnableHookEvent => (RUNNABLE_HOOK_EVENTS as readonly string[]).includes(event);

export type PluginHook = { event: HookEvent; matcher: string; command: string; statusMessage: string; timeout: number };

export type PluginHookState = PluginHook & { hash: string; trusted: boolean };

export type PluginHooks = { paths: string[]; inline: PluginHook[] };

export type MarketplaceSource =
  | { kind: "git"; url: string; ref: string; sparse: string[] }
  | { kind: "local"; path: string };

export type PluginSource =
  | { kind: "local"; path: string }
  | { kind: "git"; url: string; ref: string; path: string }
  | { kind: "npm"; package: string; version: string; registry: string }
  | { kind: "unsupported"; reason: string };

export type PluginInterface = {
  longDescription: string;
  developerName: string;
  capabilities: string[];
  websiteURL: string;
  privacyPolicyURL: string;
  termsOfServiceURL: string;
  defaultPrompt: string[];
  brandColor: string;
  composerIcon: string;
  logo: string;
  screenshots: string[];
};

export type HostedApp = { name: string; id: string; category: string };

export type MarketplacePlugin = {
  name: string;
  displayName: string;
  description: string;
  category: string;
  keywords: string[];
  installation: string;
  authentication: string;
  source: PluginSource;
  icon: string;
  brandColor: string;
};

export type Marketplace = {
  id: string;
  displayName: string;
  origin: string;
  ref: string;
  sparse: string[];
  local: boolean;
  root: string;
  plugins: MarketplacePlugin[];
  error?: string;
};

export type PluginManifest = {
  name: string;
  version: string;
  description: string;
  displayName: string;
  category: string;
  keywords: string[];
  skills: string;
  mcpServers: string;
  apps: string;
  hooks: PluginHooks;
  interface: PluginInterface;
};

export type InstalledPlugin = {
  id: string;
  marketplace: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  category: string;
  root: string;
  skills: string[];
  mcpServers: string[];
  apps: HostedApp[];
  installedAt: string;
  hooks: PluginHookState[];
};

export type PluginDetail = {
  interface: PluginInterface;
  icon: string;
  logo: string;
  screenshots: string[];
  apps: HostedApp[];
};

export type PluginCatalog = { marketplaces: Marketplace[]; installed: InstalledPlugin[] };

export type WrittenPlugin = { name: string; description: string; category?: string; skills: { name: string; description: string; instructions: string }[] };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

export function pluginSlug(value: unknown): string {
  if (typeof value !== "string") throw new Error("Plugin name is invalid");
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) throw new Error(`"${value}" is not a usable plugin or marketplace name`);
  return slug;
}

export function normalizeCategory(value: unknown): string {
  if (typeof value !== "string") return "";
  const words = value.replace(CONTROL, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 48);
  if (!words) return "";
  return words[0].toUpperCase() + words.slice(1);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" && value.length <= max ? value.replace(CONTROL, " ").trim() : "";
}

function relativePath(value: unknown, fallback = ""): string {
  const raw = text(value, 512) || fallback;
  if (!raw) return "";
  const cleaned = raw.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!cleaned || cleaned.startsWith("/") || cleaned.startsWith("~") || /^[A-Za-z]:/.test(cleaned) || cleaned.split("/").includes("..")) throw new Error(`"${raw}" is not a path inside the plugin`);
  return cleaned;
}

export function parseSparsePaths(value: unknown): string[] {
  const lines = typeof value === "string" ? value.split(/[\n,]/) : Array.isArray(value) ? value : [];
  return lines.map((line) => relativePath(typeof line === "string" ? line.trim() : "", "")).filter(Boolean).slice(0, 16);
}

export function parseMarketplaceSource(raw: unknown, ref: unknown = "", sparse: unknown = []): MarketplaceSource {
  const value = text(raw, 1024);
  if (!value) throw new Error("Give a GitHub repo, a Git URL, or a folder on this computer.");
  const paths = parseSparsePaths(sparse);
  const pinned = text(ref, 128);
  if (pinned && (pinned.startsWith("-") || /[\s~^:?*[\\]/.test(pinned))) throw new Error(`"${pinned}" is not a Git ref.`);
  if (value.startsWith(".")) throw new Error("Give the folder's full path, starting with /, ~, or a Windows drive or UNC path.");
  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    if (paths.length) throw new Error("Sparse paths only apply to Git marketplaces.");
    return { kind: "local", path: value };
  }
  if (/^https?:\/\//.test(value) || /^ssh:\/\//.test(value) || /^git@[^\s:]+:.+/.test(value)) return { kind: "git", url: value, ref: pinned, sparse: paths };
  const shorthand = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\/([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:@(.+))?$/.exec(value);
  if (!shorthand) throw new Error(`Emma cannot read "${value}" as a repo, a Git URL, or a folder.`);
  const branch = text(shorthand[3], 128);
  if (branch && (branch.startsWith("-") || /[\s~^:?*[\\]/.test(branch))) throw new Error(`"${branch}" is not a Git ref.`);
  return { kind: "git", url: `https://github.com/${shorthand[1]}/${shorthand[2]}.git`, ref: pinned || branch, sparse: paths };
}

const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const NPM_VERSION = /^[A-Za-z0-9._+^~><=| *-]+$/;

function parseNpmSource(raw: Record<string, unknown>): PluginSource {
  const name = text(raw.package, 214);
  if (!NPM_PACKAGE.test(name)) throw new Error(`"${text(raw.package, 214) || raw.package}" is not an npm package name`);
  const version = text(raw.version, 128);
  if (version && (version.startsWith("-") || !NPM_VERSION.test(version))) throw new Error(`"${version}" is not an npm version, tag, or range`);
  const registry = text(raw.registry, 1024);
  if (registry) {
    let url: URL;
    try { url = new URL(registry); } catch { throw new Error(`"${registry}" is not an npm registry URL`); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(`"${registry}" is not an npm registry URL`);
  }
  return { kind: "npm", package: name, version, registry };
}

function parsePluginSource(value: unknown): PluginSource {
  if (typeof value === "string") return { kind: "local", path: relativePath(value) };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plugin source is invalid");
  const raw = value as Record<string, unknown>;
  const kind = text(raw.source, 32) || "local";
  if (kind === "local") return { kind: "local", path: relativePath(raw.path) };
  if (kind === "npm") return parseNpmSource(raw);
  if (kind === "url" || kind === "git-subdir") {
    const url = text(raw.url, 1024);
    if (!/^https?:\/\//.test(url) && !/^ssh:\/\//.test(url) && !/^git@[^\s:]+:.+/.test(url)) throw new Error("plugin source URL is invalid");
    return { kind: "git", url, ref: text(raw.ref, 128) || text(raw.sha, 64), path: kind === "url" ? "" : relativePath(raw.path) };
  }
  return { kind: "unsupported", reason: `"${kind}" plugin sources are not supported` };
}

function httpsUrl(value: unknown): string {
  const raw = text(value, 1024);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : "";
  } catch { return ""; }
}

function strings(value: unknown, max: number, count: number): string[] {
  return Array.isArray(value) ? value.map((entry) => text(entry, max)).filter(Boolean).slice(0, count) : [];
}

export function parsePluginInterface(value: unknown): PluginInterface {
  const face = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const color = text(face.brandColor, 16).toLowerCase();
  return {
    longDescription: text(face.longDescription, 4096),
    developerName: text(face.developerName, 128),
    capabilities: strings(face.capabilities, 48, 8),
    websiteURL: httpsUrl(face.websiteURL),
    privacyPolicyURL: httpsUrl(face.privacyPolicyURL),
    termsOfServiceURL: httpsUrl(face.termsOfServiceURL),
    defaultPrompt: strings(face.defaultPrompt, 128, 3),
    brandColor: /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(color) ? color : "",
    composerIcon: relativePath(face.composerIcon),
    logo: relativePath(face.logo),
    screenshots: strings(face.screenshots, 512, 6).map((entry) => relativePath(entry)).filter(Boolean),
  };
}

export function parseHostedApps(value: unknown): HostedApp[] {
  const file = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const listed = file.apps && typeof file.apps === "object" && !Array.isArray(file.apps) ? file.apps as Record<string, unknown> : {};
  const apps: HostedApp[] = [];
  const seen = new Set<string>();
  for (const [name, entry] of Object.entries(listed).slice(0, 32)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const app = entry as Record<string, unknown>;
    const id = text(app.id, 256);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    apps.push({ name: text(name, 128) || id, id, category: normalizeCategory(app.category) });
    if (apps.length >= 16) break;
  }
  return apps;
}

const MAX_HOOKS = 32;
const MAX_HOOK_SECONDS = 3600;

function hookSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_HOOK_SECONDS);
}

export function parseHooksFile(value: unknown): PluginHook[] {
  const file = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const listed = file.hooks && typeof file.hooks === "object" && !Array.isArray(file.hooks) ? file.hooks as Record<string, unknown> : {};
  const hooks: PluginHook[] = [];
  for (const [name, groups] of Object.entries(listed)) {
    const event = HOOK_EVENTS.find((known) => known === name);
    if (!event || !Array.isArray(groups)) continue;
    for (const group of groups.slice(0, MAX_HOOKS)) {
      if (!group || typeof group !== "object" || Array.isArray(group)) continue;
      const matched = group as Record<string, unknown>;
      const matcher = text(matched.matcher, 128);
      const handlers = Array.isArray(matched.hooks) ? matched.hooks.slice(0, MAX_HOOKS) : [];
      for (const handler of handlers) {
        if (!handler || typeof handler !== "object" || Array.isArray(handler)) continue;
        const one = handler as Record<string, unknown>;
        const command = text(one.command, 4096);
        if (text(one.type, 32) !== "command" || !command) continue;
        hooks.push({ event, matcher, command, statusMessage: text(one.statusMessage, 128), timeout: hookSeconds(one.timeout) });
        if (hooks.length >= MAX_HOOKS) return hooks;
      }
    }
  }
  return hooks;
}

export function parseManifestHooks(value: unknown): PluginHooks {
  if (value === undefined || value === null) return { paths: [], inline: [] };
  const entries = Array.isArray(value) ? value.slice(0, MAX_HOOKS) : [value];
  const paths: string[] = [];
  const inline: PluginHook[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      const found = relativePath(entry);
      if (found) paths.push(found);
      continue;
    }
    inline.push(...parseHooksFile(entry));
  }
  return { paths, inline: inline.slice(0, MAX_HOOKS) };
}

export function parseMarketplace(value: unknown): { name: string; displayName: string; plugins: MarketplacePlugin[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("marketplace.json is not an object");
  const raw = value as Record<string, unknown>;
  const name = pluginSlug(text(raw.name, 128) || "marketplace");
  const face = raw.interface && typeof raw.interface === "object" ? raw.interface as Record<string, unknown> : {};
  const listed = Array.isArray(raw.plugins) ? raw.plugins.slice(0, 256) : [];
  const plugins: MarketplacePlugin[] = [];
  const seen = new Set<string>();
  for (const entry of listed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const face2 = item.interface && typeof item.interface === "object" ? item.interface as Record<string, unknown> : {};
    let slug: string;
    let source: PluginSource;
    try {
      slug = pluginSlug(text(item.name, 128));
      source = parsePluginSource(item.source);
    } catch { continue; }
    if (seen.has(slug)) continue;
    seen.add(slug);
    const policy = item.policy && typeof item.policy === "object" ? item.policy as Record<string, unknown> : {};
    plugins.push({
      name: slug,
      displayName: text(face2.displayName, 128) || slug,
      description: text(face2.shortDescription, 512) || text(item.description, 512),
      category: normalizeCategory(item.category ?? face2.category),
      keywords: Array.isArray(item.keywords) ? item.keywords.map((word) => text(word, 48)).filter(Boolean).slice(0, 12) : [],
      installation: text(policy.installation, 32).toUpperCase() || "AVAILABLE",
      authentication: text(policy.authentication, 32).toUpperCase(),
      source,
      icon: "",
      brandColor: "",
    });
  }
  return { name, displayName: text(face.displayName, 128) || name, plugins };
}

export function parsePluginManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plugin.json is not an object");
  const raw = value as Record<string, unknown>;
  const face = raw.interface && typeof raw.interface === "object" ? raw.interface as Record<string, unknown> : {};
  const name = pluginSlug(text(raw.name, 128));
  return {
    name,
    version: text(raw.version, 64) || "0.0.0",
    description: text(face.shortDescription, 512) || text(raw.description, 512) || text(face.longDescription, 512).slice(0, 512),
    displayName: text(face.displayName, 128) || name,
    category: normalizeCategory(face.category),
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map((word) => text(word, 48)).filter(Boolean).slice(0, 12) : [],
    skills: relativePath(raw.skills, "skills"),
    mcpServers: relativePath(raw.mcpServers, ".mcp.json"),
    apps: relativePath(raw.apps),
    hooks: parseManifestHooks(raw.hooks),
    interface: parsePluginInterface(face),
  };
}

export function pluginCategories(catalog: PluginCatalog): string[] {
  const found = new Set<string>();
  for (const marketplace of catalog.marketplaces) for (const plugin of marketplace.plugins) if (plugin.category) found.add(plugin.category);
  for (const plugin of catalog.installed) if (plugin.category) found.add(plugin.category);
  return [...found].sort((left, right) => left.localeCompare(right));
}

export function matchesPluginQuery(plugin: MarketplacePlugin, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [plugin.name, plugin.displayName, plugin.description, plugin.category, ...plugin.keywords].some((value) => value.toLowerCase().includes(needle));
}
