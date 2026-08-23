import { matchesLocalAlias } from "./brand-data";

export type BrandSurface = "importer" | "provider";
export type ModelSource = "openrouter" | "local";

/** Every mark is normalised on the same 24-unit grid — glyph ink fitted to the
 *  full box, monochrome marks recoloured #fff for the dark UI — so the mark
 *  column renders at one size with one margin regardless of source. */
export type BrandAsset = {
  src: string;
  sourceUrl: string;
  retrievedAt: "2026-08-20";
  license: string;
};

export type BrandDefinition = {
  id: string;
  label: string;
  fallback: string;
  asset?: BrandAsset;
  openRouterNamespaces?: readonly string[];
  localAliases?: readonly string[];
};

const simpleIconUrls = {
  anthropic: new URL("../assets/brands/anthropic.svg", import.meta.url).href,
  meta: new URL("../assets/brands/meta.svg", import.meta.url).href,
  cursor: new URL("../assets/brands/cursor.svg", import.meta.url).href,
  windsurf: new URL("../assets/brands/windsurf.svg", import.meta.url).href,
  opencode: new URL("../assets/brands/opencode.svg", import.meta.url).href,
  mistralai: new URL("../assets/brands/mistralai.svg", import.meta.url).href,
  deepseek: new URL("../assets/brands/deepseek.svg", import.meta.url).href,
  qwen: new URL("../assets/brands/qwen.svg", import.meta.url).href,
  kimi: new URL("../assets/brands/kimi.svg", import.meta.url).href,
  nvidia: new URL("../assets/brands/nvidia.svg", import.meta.url).href,
  naver: new URL("../assets/brands/naver.svg", import.meta.url).href,
  obsidian: new URL("../assets/brands/obsidian.svg", import.meta.url).href,
  github: new URL("../assets/brands/github.svg", import.meta.url).href,
  gitlab: new URL("../assets/brands/gitlab.svg", import.meta.url).href,
  jira: new URL("../assets/brands/jira.svg", import.meta.url).href,
  todoist: new URL("../assets/brands/todoist.svg", import.meta.url).href,
  xiaomi: new URL("../assets/brands/xiaomi.svg", import.meta.url).href,
} as const;

const simpleIcons = (file: keyof typeof simpleIconUrls, commit: string, sourceUrl = `https://raw.githubusercontent.com/simple-icons/simple-icons/${commit}/icons/${file}.svg`): BrandAsset => ({
  src: simpleIconUrls[file],
  sourceUrl,
  retrievedAt: "2026-08-20",
  license: "Simple Icons; CC0 1.0; recoloured (#fff, or the brand colour where the mark has one); trademark remains with its owner",
});

const lobeIconUrls = {
  xai: new URL("../assets/brands/xai.svg", import.meta.url).href,
  zai: new URL("../assets/brands/zai.svg", import.meta.url).href,
  minimax: new URL("../assets/brands/minimax.svg", import.meta.url).href,
  cohere: new URL("../assets/brands/cohere.svg", import.meta.url).href,
  liquid: new URL("../assets/brands/liquid.svg", import.meta.url).href,
  poolside: new URL("../assets/brands/poolside.svg", import.meta.url).href,
  bytedance: new URL("../assets/brands/bytedance.svg", import.meta.url).href,
} as const;

/** lobehub/lobe-icons is MIT for the packaging; each mark stays its owner's. */
const lobeIcon = (file: keyof typeof lobeIconUrls, owner: string): BrandAsset => ({
  src: lobeIconUrls[file],
  sourceUrl: `https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons/${file}.svg`,
  retrievedAt: "2026-08-20",
  license: `Lobe Icons; MIT; ${owner} trademarks remain with ${owner}`,
});

const assets = {
  openai: {
    src: new URL("../assets/brands/openai.svg", import.meta.url).href,
    sourceUrl: "https://images.ctfassets.net/kftzwdyauwt9/3hUGLn3ypllZ0oa01qOYVq/28e8188e6f11b84c3e876569d492734f/Blossom_Light.svg?q=90&w=3840",
    retrievedAt: "2026-08-20",
    license: "Official OpenAI 2025 brand asset; blossom mark extracted from the supplied construction sheet and recoloured #fff; OpenAI trademarks remain with OpenAI",
  },
  anthropic: simpleIcons("anthropic", "ec4aa60b3920e75e7467b611023d2568a292beb4"),
  meta: simpleIcons("meta", "a25b1592b80578fbb024b2e5562459c8075019d1"),
  cursor: simpleIcons("cursor", "be23679deda9e227ded614e94a1dc262ff930cf1"),
  windsurf: simpleIcons("windsurf", "513d314f959cf952d8dde4509b3abed1c2ee5f6b"),
  opencode: simpleIcons("opencode", "3237c86aca8e54fdf55b6a33de8b64014b1ff47a"),
  mistralai: simpleIcons("mistralai", "2a0db0df5d5f7fd5ccda9dd8151c6b6c485b81bf"),
  deepseek: simpleIcons("deepseek", "8f56a0b75ca568d873cde654c11728507621c689"),
  qwen: simpleIcons("qwen", "6e41e4e2f46bb4418837b6a8c6e5e4f5e02362a7"),
  kimi: simpleIcons("kimi", "c53db5666567f6469e4cc14750bb6a43a8f50964"),
  nvidia: simpleIcons("nvidia", "521c96fd04b0ea93034db8715eda5a4de27a58bb"),
  naver: simpleIcons("naver", "77f4c6a0fc80498f8c755ae6a1a9c6e536ac9f83"),
  obsidian: simpleIcons("obsidian", "c956d67dfa7c37ae65206fc0775b0c02d1e695c2"),
  github: simpleIcons("github", "c956d67dfa7c37ae65206fc0775b0c02d1e695c2"),
  gitlab: simpleIcons("gitlab", "c956d67dfa7c37ae65206fc0775b0c02d1e695c2"),
  jira: simpleIcons("jira", "c956d67dfa7c37ae65206fc0775b0c02d1e695c2"),
  todoist: simpleIcons("todoist", "c956d67dfa7c37ae65206fc0775b0c02d1e695c2"),
  xiaomi: simpleIcons("xiaomi", "34c22501f9ac9f22b12f825677ccbab1fb22e14b"),
  xai: lobeIcon("xai", "xAI"),
  zai: lobeIcon("zai", "Z.ai"),
  minimax: lobeIcon("minimax", "MiniMax"),
  cohere: lobeIcon("cohere", "Cohere"),
  liquid: lobeIcon("liquid", "Liquid AI"),
  poolside: lobeIcon("poolside", "poolside"),
  bytedance: lobeIcon("bytedance", "ByteDance"),
  antigravity: {
    src: new URL("../assets/brands/antigravity.png", import.meta.url).href,
    sourceUrl: "https://www.antigravity.google/press",
    retrievedAt: "2026-08-20",
    license: "Official Google Antigravity press asset; use only to refer to the product",
  },
  gemini: {
    src: new URL("../assets/brands/gemini.png", import.meta.url).href,
    sourceUrl: "https://storage.googleapis.com/gweb-uniblog-publish-prod/images/Gemini_SparkIcon_4C.original.png",
    retrievedAt: "2026-08-20",
    license: "Official Google Press Corner asset; use only to identify Gemini; Google and Gemini trademarks remain with Google",
  },
  pi: {
    src: new URL("../assets/brands/pi.svg", import.meta.url).href,
    sourceUrl: "https://pi.dev/favicon.svg",
    retrievedAt: "2026-08-20",
    license: "Official Pi coding-agent badge from the Pi press kit; tile dropped, glyph kept white; use only to identify Pi; Pi and Earendil marks remain with their owners",
  },
  openrouter: {
    src: new URL("../assets/brands/openrouter.svg", import.meta.url).href,
    sourceUrl: "https://openrouter.ai/brand/v2/openrouter-dark.svg",
    retrievedAt: "2026-08-20",
    license: "Official OpenRouter v2 brand asset; glyph lifted from the lockup, brand #C8FF00 kept; OpenRouter trademarks remain with OpenRouter",
  },
} as const;

export const brandAssets = assets;

const definition = (id: string, label: string, fallback: string, asset?: BrandAsset, openRouterNamespaces?: readonly string[], localAliases?: readonly string[]): BrandDefinition => ({ id, label, fallback, asset, openRouterNamespaces, localAliases });

export const importerBrands = {
  codex: definition("codex", "Codex", "◎", assets.openai),
  claude: definition("claude", "Claude", "A", assets.anthropic),
  antigravity: definition("antigravity", "Antigravity", "G", assets.antigravity),
  pi: definition("pi", "Pi", "π", assets.pi),
  opencode: definition("opencode", "OpenCode", "O", assets.opencode),
  cursor: definition("cursor", "Cursor", "C", assets.cursor),
  windsurf: definition("windsurf", "Windsurf", "W", assets.windsurf),
  devin: definition("devin", "Devin", "D"),
} as const satisfies Record<string, BrandDefinition>;

export type ImporterBrandId = keyof typeof importerBrands;

/** Keyed by connection id from main's catalog. */
export const connectionBrands: Record<string, BrandDefinition> = {
  obsidian: definition("obsidian", "Obsidian", "◈", assets.obsidian),
  github: definition("github", "GitHub", "G", assets.github),
  gitlab: definition("gitlab", "GitLab", "L", assets.gitlab),
  jira: definition("jira", "Jira", "J", assets.jira),
  todoist: definition("todoist", "Todoist", "T", assets.todoist),
};

export function brandForConnection(id: string): BrandDefinition | undefined {
  return connectionBrands[id];
}

export const providerBrands: readonly BrandDefinition[] = [
  definition("openai", "OpenAI", "◎", assets.openai, ["openai"], ["openai", "gpt", "o1", "o3", "o4"]),
  definition("anthropic", "Anthropic", "A", assets.anthropic, ["anthropic"], ["anthropic", "claude"]),
  definition("gemini", "Gemini", "✦", assets.gemini, ["google"], ["google", "gemini", "gemma"]),
  definition("xai", "xAI", "X", assets.xai, ["x-ai"], ["xai", "grok"]),
  definition("openrouter", "OpenRouter", "OR", assets.openrouter, ["openrouter"], ["openrouter"]),
  definition("meta", "Meta", "∞", assets.meta, ["meta-llama"], ["meta", "llama"]),
  definition("mistral", "Mistral", "M", assets.mistralai, ["mistralai"], ["mistral", "mixtral"]),
  definition("cohere", "Cohere", "C", assets.cohere, ["cohere"], ["cohere", "command"]),
  definition("qwen", "Qwen", "Q", assets.qwen, ["qwen"], ["qwen"]),
  definition("deepseek", "DeepSeek", "D", assets.deepseek, ["deepseek"], ["deepseek"]),
  definition("kimi", "Kimi", "K", assets.kimi, ["moonshotai"], ["kimi", "moonshot"]),
  definition("glm", "Z.ai / GLM", "Z", assets.zai, ["z-ai", "zhipuai"], ["glm", "zhipu"]),
  definition("minimax", "MiniMax", "M", assets.minimax, ["minimax"], ["minimax"]),
  definition("bytedance", "ByteDance Seed", "B", assets.bytedance, ["bytedance", "bytedance-seed"], ["bytedance", "seed", "doubao"]),
  definition("xiaomi", "Xiaomi", "Mi", assets.xiaomi, ["xiaomi"], ["xiaomi", "mimo"]),
  definition("thinkingmachines", "Thinking Machines", "T", undefined, ["thinkingmachines"], ["thinkingmachines", "inkling", "tinker"]),
  definition("ernie", "ERNIE", "E", undefined, ["baidu"], ["ernie", "baidu"]),
  definition("hunyuan", "Hunyuan", "H", undefined, ["tencent"], ["hunyuan", "tencent"]),
  definition("naver", "HyperCLOVA", "N", assets.naver, ["naver"], ["naver", "hyperclova"]),
  definition("sakana", "Sakana AI", "S", undefined, ["sakana"], ["sakana"]),
  definition("nvidia", "NVIDIA", "N", assets.nvidia, ["nvidia"], ["nemotron", "nvidia"]),
  definition("poolside", "Poolside", "P", assets.poolside, ["poolside"], ["poolside", "malibu"]),
  definition("liquid", "Liquid AI", "L", assets.liquid, ["liquid"], ["lfm", "liquid"]),
];

const providerById = new Map(providerBrands.map((brand) => [brand.id, brand]));
/* A repeated id is silent: the Map keeps the last entry, so a duplicate added
   below one that carries an asset drops that asset back to the fallback glyph
   and nothing anywhere says so. Dev-only — the list is static, so this can only
   ever catch an editing mistake, never anything a user does. */
if (import.meta.env.DEV && providerById.size !== providerBrands.length) {
  throw new Error(`duplicate provider brand id in providerBrands (${providerBrands.length} entries, ${providerById.size} unique)`);
}

export function brandForImporter(id: string): BrandDefinition | undefined {
  return importerBrands[id as ImporterBrandId];
}

export function brandForProvider(id: string): BrandDefinition | undefined {
  return providerById.get(id.trim().toLowerCase());
}

/** OpenRouter namespaces are authoritative; aliases apply only to local/custom IDs. */
export function brandForModel(modelId: string, source?: ModelSource): BrandDefinition | undefined {
  const value = modelId.trim().toLowerCase().replace(/^openrouter:/, "");
  if (!value) return undefined;
  const openRouterBrand = providerBrands.find((brand) => brand.openRouterNamespaces?.some((namespace) => value.startsWith(`${namespace}/`)));
  if (openRouterBrand) return openRouterBrand;
  if (source === "openrouter" || (!source && value.includes("/"))) return undefined;
  return providerBrands.find((brand) => brand.localAliases?.some((alias) => matchesLocalAlias(value, alias)));
}
