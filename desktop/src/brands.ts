import { matchesLocalAlias } from "./brand-data";

export type BrandSurface = "importer" | "provider";
export type ModelSource = "openrouter" | "local";

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
  naver: new URL("../assets/brands/naver.svg", import.meta.url).href,
} as const;

const simpleIcons = (file: keyof typeof simpleIconUrls, commit: string, sourceUrl = `https://raw.githubusercontent.com/simple-icons/simple-icons/${commit}/icons/${file}.svg`): BrandAsset => ({
  src: simpleIconUrls[file],
  sourceUrl,
  retrievedAt: "2026-08-20",
  license: "Simple Icons; CC0 1.0; trademark remains with its owner",
});

const assets = {
  openai: {
    src: new URL("../assets/brands/openai.svg", import.meta.url).href,
    sourceUrl: "https://images.ctfassets.net/kftzwdyauwt9/3hUGLn3ypllZ0oa01qOYVq/28e8188e6f11b84c3e876569d492734f/Blossom_Light.svg?q=90&w=3840",
    retrievedAt: "2026-08-20",
    license: "Official OpenAI 2025 brand asset; use exactly as supplied under OpenAI brand guidelines; OpenAI trademarks remain with OpenAI",
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
  naver: simpleIcons("naver", "77f4c6a0fc80498f8c755ae6a1a9c6e536ac9f83"),
  antigravity: {
    src: new URL("../assets/brands/antigravity.png", import.meta.url).href,
    sourceUrl: "https://www.antigravity.google/press",
    retrievedAt: "2026-08-20",
    license: "Official Google Antigravity press asset; use only to refer to the product",
  },
  claude: {
    src: new URL("../assets/brands/claude.png", import.meta.url).href,
    sourceUrl: "https://claude.ai/images/claude_app_icon.png",
    retrievedAt: "2026-08-20",
    license: "Official Claude product icon; Claude and Anthropic trademarks remain with their owners",
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
    license: "Official Pi coding-agent badge from the Pi press kit; use only to identify Pi; Pi and Earendil marks remain with their owners",
  },
  openrouter: {
    src: new URL("../assets/brands/openrouter.svg", import.meta.url).href,
    sourceUrl: "https://openrouterteam.github.io/sign-in-with-openrouter/",
    retrievedAt: "2026-08-20",
    license: "Official OpenRouter Team logo; use exactly as supplied under OpenRouter brand guidance; OpenRouter trademarks remain with OpenRouter",
  },
} as const;

export const brandAssets = assets;

const definition = (id: string, label: string, fallback: string, asset?: BrandAsset, openRouterNamespaces?: readonly string[], localAliases?: readonly string[]): BrandDefinition => ({ id, label, fallback, asset, openRouterNamespaces, localAliases });

export const importerBrands = {
  codex: definition("codex", "Codex", "◎", assets.openai),
  claude: definition("claude", "Claude", "A", assets.claude),
  antigravity: definition("antigravity", "Antigravity", "G", assets.antigravity),
  pi: definition("pi", "Pi", "π", assets.pi),
  opencode: definition("opencode", "OpenCode", "O", assets.opencode),
  cursor: definition("cursor", "Cursor", "C", assets.cursor),
  windsurf: definition("windsurf", "Windsurf", "W", assets.windsurf),
  devin: definition("devin", "Devin", "D"),
} as const satisfies Record<string, BrandDefinition>;

export type ImporterBrandId = keyof typeof importerBrands;

export const providerBrands: readonly BrandDefinition[] = [
  definition("openai", "OpenAI", "◎", assets.openai, ["openai"], ["openai", "gpt", "o1", "o3", "o4"]),
  definition("anthropic", "Anthropic", "A", assets.anthropic, ["anthropic"], ["anthropic", "claude"]),
  definition("gemini", "Gemini", "✦", assets.gemini, ["google"], ["google", "gemini", "gemma"]),
  definition("xai", "xAI", "X", undefined, ["x-ai"], ["xai", "grok"]),
  definition("openrouter", "OpenRouter", "OR", assets.openrouter, ["openrouter"], ["openrouter"]),
  definition("meta", "Meta", "∞", assets.meta, ["meta-llama"], ["meta", "llama"]),
  definition("mistral", "Mistral", "M", assets.mistralai, ["mistralai"], ["mistral", "mixtral"]),
  definition("cohere", "Cohere", "C", undefined, ["cohere"], ["cohere", "command"]),
  definition("qwen", "Qwen", "Q", assets.qwen, ["qwen"], ["qwen"]),
  definition("deepseek", "DeepSeek", "D", assets.deepseek, ["deepseek"], ["deepseek"]),
  definition("kimi", "Kimi", "K", assets.kimi, ["moonshotai"], ["kimi", "moonshot"]),
  definition("glm", "Z.ai / GLM", "Z", undefined, ["z-ai", "zhipuai"], ["glm", "zhipu"]),
  definition("minimax", "MiniMax", "M", undefined, ["minimax"], ["minimax"]),
  definition("ernie", "ERNIE", "E", undefined, ["baidu"], ["ernie", "baidu"]),
  definition("hunyuan", "Hunyuan", "H", undefined, ["tencent"], ["hunyuan", "tencent"]),
  definition("naver", "HyperCLOVA", "N", assets.naver, ["naver"], ["naver", "hyperclova"]),
  definition("sakana", "Sakana AI", "S", undefined, ["sakana"], ["sakana"]),
];

const providerById = new Map(providerBrands.map((brand) => [brand.id, brand]));

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
