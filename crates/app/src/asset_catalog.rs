#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LocalAsset {
    pub id: &'static str,
    pub path: &'static str,
}

pub const BRAND_ASSETS: &[LocalAsset] = &[
    LocalAsset {
        id: "openai",
        path: "desktop/assets/brands/openai.svg",
    },
    LocalAsset {
        id: "anthropic",
        path: "desktop/assets/brands/anthropic.svg",
    },
    LocalAsset {
        id: "claude",
        path: "desktop/assets/brands/claude.svg",
    },
    LocalAsset {
        id: "meta",
        path: "desktop/assets/brands/meta.svg",
    },
    LocalAsset {
        id: "cursor",
        path: "desktop/assets/brands/cursor.svg",
    },
    LocalAsset {
        id: "windsurf",
        path: "desktop/assets/brands/windsurf.svg",
    },
    LocalAsset {
        id: "opencode",
        path: "desktop/assets/brands/opencode.svg",
    },
    LocalAsset {
        id: "mistralai",
        path: "desktop/assets/brands/mistralai.svg",
    },
    LocalAsset {
        id: "deepseek",
        path: "desktop/assets/brands/deepseek.svg",
    },
    LocalAsset {
        id: "qwen",
        path: "desktop/assets/brands/qwen.svg",
    },
    LocalAsset {
        id: "kimi",
        path: "desktop/assets/brands/kimi.svg",
    },
    LocalAsset {
        id: "nvidia",
        path: "desktop/assets/brands/nvidia.svg",
    },
    LocalAsset {
        id: "naver",
        path: "desktop/assets/brands/naver.svg",
    },
    LocalAsset {
        id: "obsidian",
        path: "desktop/assets/brands/obsidian.svg",
    },
    LocalAsset {
        id: "github",
        path: "desktop/assets/brands/github.svg",
    },
    LocalAsset {
        id: "gitlab",
        path: "desktop/assets/brands/gitlab.svg",
    },
    LocalAsset {
        id: "jira",
        path: "desktop/assets/brands/jira.svg",
    },
    LocalAsset {
        id: "todoist",
        path: "desktop/assets/brands/todoist.svg",
    },
    LocalAsset {
        id: "xiaomi",
        path: "desktop/assets/brands/xiaomi.svg",
    },
    LocalAsset {
        id: "xai",
        path: "desktop/assets/brands/xai.svg",
    },
    LocalAsset {
        id: "zai",
        path: "desktop/assets/brands/zai.svg",
    },
    LocalAsset {
        id: "minimax",
        path: "desktop/assets/brands/minimax.svg",
    },
    LocalAsset {
        id: "cohere",
        path: "desktop/assets/brands/cohere.svg",
    },
    LocalAsset {
        id: "liquid",
        path: "desktop/assets/brands/liquid.svg",
    },
    LocalAsset {
        id: "poolside",
        path: "desktop/assets/brands/poolside.svg",
    },
    LocalAsset {
        id: "bytedance",
        path: "desktop/assets/brands/bytedance.svg",
    },
    LocalAsset {
        id: "hunyuan",
        path: "desktop/assets/brands/hunyuan.svg",
    },
    LocalAsset {
        id: "ernie",
        path: "desktop/assets/brands/ernie.svg",
    },
    LocalAsset {
        id: "sakana",
        path: "desktop/assets/brands/sakana.png",
    },
    LocalAsset {
        id: "thinkingmachines",
        path: "desktop/assets/brands/thinkingmachines.svg",
    },
    LocalAsset {
        id: "antigravity",
        path: "desktop/assets/brands/antigravity.png",
    },
    LocalAsset {
        id: "gemini",
        path: "desktop/assets/brands/gemini.png",
    },
    LocalAsset {
        id: "pi",
        path: "desktop/assets/brands/pi.svg",
    },
    LocalAsset {
        id: "openrouter",
        path: "desktop/assets/brands/openrouter.svg",
    },
];

pub fn brand_asset(id: &str) -> Option<&'static LocalAsset> {
    BRAND_ASSETS.iter().find(|asset| asset.id == id)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BrandDefinition {
    pub id: &'static str,
    pub label: &'static str,
    pub fallback: &'static str,
    pub asset_id: Option<&'static str>,
    pub open_router_namespaces: &'static [&'static str],
    pub local_aliases: &'static [&'static str],
}

impl BrandDefinition {
    pub fn asset(self) -> Option<&'static LocalAsset> {
        self.asset_id.and_then(brand_asset)
    }

    pub fn asset_path(self) -> Option<&'static str> {
        self.asset().map(|asset| asset.path)
    }
}

pub const IMPORTER_BRANDS: &[BrandDefinition] = &[
    BrandDefinition {
        id: "codex",
        label: "Codex",
        fallback: "◎",
        asset_id: Some("openai"),
        open_router_namespaces: &[],
        local_aliases: &[],
    },
    BrandDefinition {
        id: "claude",
        label: "Claude",
        fallback: "✳",
        asset_id: Some("claude"),
        open_router_namespaces: &[],
        local_aliases: &[],
    },
    BrandDefinition {
        id: "antigravity",
        label: "Antigravity",
        fallback: "G",
        asset_id: Some("antigravity"),
        open_router_namespaces: &[],
        local_aliases: &[],
    },
    BrandDefinition {
        id: "pi",
        label: "Pi",
        fallback: "π",
        asset_id: Some("pi"),
        open_router_namespaces: &[],
        local_aliases: &[],
    },
    BrandDefinition {
        id: "opencode",
        label: "OpenCode",
        fallback: "O",
        asset_id: Some("opencode"),
        open_router_namespaces: &[],
        local_aliases: &[],
    },
    BrandDefinition {
        id: "cursor",
        label: "Cursor",
        fallback: "C",
        asset_id: Some("cursor"),
        open_router_namespaces: &[],
        local_aliases: &[],
    },
    BrandDefinition {
        id: "windsurf",
        label: "Windsurf",
        fallback: "W",
        asset_id: Some("windsurf"),
        open_router_namespaces: &[],
        local_aliases: &[],
    },
    BrandDefinition {
        id: "devin",
        label: "Devin",
        fallback: "D",
        asset_id: None,
        open_router_namespaces: &[],
        local_aliases: &[],
    },
];

pub const OBSIDIAN_BRAND: BrandDefinition = BrandDefinition {
    id: "obsidian",
    label: "Obsidian",
    fallback: "◈",
    asset_id: Some("obsidian"),
    open_router_namespaces: &[],
    local_aliases: &[],
};

pub const ROUTER_BRAND: BrandDefinition = BrandDefinition {
    id: "router",
    label: "Emma",
    fallback: "∞",
    asset_id: None,
    open_router_namespaces: &[],
    local_aliases: &[],
};

pub const PROVIDER_BRANDS: &[BrandDefinition] = &[
    BrandDefinition {
        id: "openai",
        label: "OpenAI",
        fallback: "◎",
        asset_id: Some("openai"),
        open_router_namespaces: &["openai"],
        local_aliases: &["openai", "gpt", "o1", "o3", "o4"],
    },
    BrandDefinition {
        id: "anthropic",
        label: "Anthropic",
        fallback: "A",
        asset_id: Some("anthropic"),
        open_router_namespaces: &["anthropic"],
        local_aliases: &["anthropic", "claude"],
    },
    BrandDefinition {
        id: "gemini",
        label: "Gemini",
        fallback: "✦",
        asset_id: Some("gemini"),
        open_router_namespaces: &["google"],
        local_aliases: &["google", "gemini", "gemma"],
    },
    BrandDefinition {
        id: "xai",
        label: "xAI",
        fallback: "X",
        asset_id: Some("xai"),
        open_router_namespaces: &["x-ai"],
        local_aliases: &["xai", "grok"],
    },
    BrandDefinition {
        id: "openrouter",
        label: "OpenRouter",
        fallback: "OR",
        asset_id: Some("openrouter"),
        open_router_namespaces: &["openrouter"],
        local_aliases: &["openrouter"],
    },
    BrandDefinition {
        id: "meta",
        label: "Meta",
        fallback: "∞",
        asset_id: Some("meta"),
        open_router_namespaces: &["meta-llama"],
        local_aliases: &["meta", "llama"],
    },
    BrandDefinition {
        id: "mistral",
        label: "Mistral",
        fallback: "M",
        asset_id: Some("mistralai"),
        open_router_namespaces: &["mistralai"],
        local_aliases: &["mistral", "mixtral"],
    },
    BrandDefinition {
        id: "cohere",
        label: "Cohere",
        fallback: "C",
        asset_id: Some("cohere"),
        open_router_namespaces: &["cohere"],
        local_aliases: &["cohere", "command"],
    },
    BrandDefinition {
        id: "qwen",
        label: "Qwen",
        fallback: "Q",
        asset_id: Some("qwen"),
        open_router_namespaces: &["qwen"],
        local_aliases: &["qwen"],
    },
    BrandDefinition {
        id: "deepseek",
        label: "DeepSeek",
        fallback: "D",
        asset_id: Some("deepseek"),
        open_router_namespaces: &["deepseek"],
        local_aliases: &["deepseek"],
    },
    BrandDefinition {
        id: "kimi",
        label: "Kimi",
        fallback: "K",
        asset_id: Some("kimi"),
        open_router_namespaces: &["moonshotai"],
        local_aliases: &["kimi", "moonshot"],
    },
    BrandDefinition {
        id: "glm",
        label: "Z.ai / GLM",
        fallback: "Z",
        asset_id: Some("zai"),
        open_router_namespaces: &["z-ai", "zhipuai"],
        local_aliases: &["glm", "zhipu"],
    },
    BrandDefinition {
        id: "minimax",
        label: "MiniMax",
        fallback: "M",
        asset_id: Some("minimax"),
        open_router_namespaces: &["minimax"],
        local_aliases: &["minimax"],
    },
    BrandDefinition {
        id: "bytedance",
        label: "ByteDance Seed",
        fallback: "B",
        asset_id: Some("bytedance"),
        open_router_namespaces: &["bytedance", "bytedance-seed"],
        local_aliases: &["bytedance", "seed", "doubao"],
    },
    BrandDefinition {
        id: "xiaomi",
        label: "Xiaomi",
        fallback: "Mi",
        asset_id: Some("xiaomi"),
        open_router_namespaces: &["xiaomi"],
        local_aliases: &["xiaomi", "mimo"],
    },
    BrandDefinition {
        id: "thinkingmachines",
        label: "Thinking Machines",
        fallback: "T",
        asset_id: Some("thinkingmachines"),
        open_router_namespaces: &["thinkingmachines"],
        local_aliases: &["thinkingmachines", "inkling", "tinker"],
    },
    BrandDefinition {
        id: "ernie",
        label: "ERNIE",
        fallback: "E",
        asset_id: Some("ernie"),
        open_router_namespaces: &["baidu"],
        local_aliases: &["ernie", "baidu"],
    },
    BrandDefinition {
        id: "hunyuan",
        label: "Hunyuan",
        fallback: "H",
        asset_id: Some("hunyuan"),
        open_router_namespaces: &["tencent"],
        local_aliases: &["hunyuan", "tencent"],
    },
    BrandDefinition {
        id: "naver",
        label: "HyperCLOVA",
        fallback: "N",
        asset_id: Some("naver"),
        open_router_namespaces: &["naver"],
        local_aliases: &["naver", "hyperclova"],
    },
    BrandDefinition {
        id: "sakana",
        label: "Sakana AI",
        fallback: "S",
        asset_id: Some("sakana"),
        open_router_namespaces: &["sakana"],
        local_aliases: &["sakana"],
    },
    BrandDefinition {
        id: "nvidia",
        label: "NVIDIA",
        fallback: "N",
        asset_id: Some("nvidia"),
        open_router_namespaces: &["nvidia"],
        local_aliases: &["nemotron", "nvidia"],
    },
    BrandDefinition {
        id: "poolside",
        label: "Poolside",
        fallback: "P",
        asset_id: Some("poolside"),
        open_router_namespaces: &["poolside"],
        local_aliases: &["poolside", "malibu"],
    },
    BrandDefinition {
        id: "liquid",
        label: "Liquid AI",
        fallback: "L",
        asset_id: Some("liquid"),
        open_router_namespaces: &["liquid"],
        local_aliases: &["lfm", "liquid"],
    },
];

pub fn brand_for_importer(id: &str) -> Option<&'static BrandDefinition> {
    IMPORTER_BRANDS.iter().find(|brand| brand.id == id)
}

pub fn brand_for_provider(id: &str) -> Option<&'static BrandDefinition> {
    let id = id.trim();
    PROVIDER_BRANDS
        .iter()
        .find(|brand| brand.id.eq_ignore_ascii_case(id))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModelSource {
    OpenRouter,
    Local,
}

pub fn matches_local_alias(value: &str, alias: &str) -> bool {
    if value == alias {
        return true;
    }
    if !value.starts_with(alias) {
        return false;
    }
    matches!(
        value[alias.len()..].chars().next(),
        Some('0'..='9' | '-' | ':' | '.' | '_')
    )
}

pub fn brand_for_model(
    model_id: &str,
    source: Option<ModelSource>,
) -> Option<&'static BrandDefinition> {
    let value = model_id.trim().to_ascii_lowercase();
    let value = value.strip_prefix("openrouter:").unwrap_or(&value);
    let open_router_brand = PROVIDER_BRANDS.iter().find(|brand| {
        brand.open_router_namespaces.iter().any(|namespace| {
            value.starts_with(namespace) && value.as_bytes().get(namespace.len()) == Some(&b'/')
        })
    });
    if open_router_brand.is_some() {
        return open_router_brand;
    }
    if source == Some(ModelSource::OpenRouter) || (source.is_none() && value.contains('/')) {
        return None;
    }
    PROVIDER_BRANDS.iter().find(|brand| {
        brand
            .local_aliases
            .iter()
            .any(|alias| matches_local_alias(value, alias))
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BrandRenderData {
    pub path: Option<&'static str>,
    pub fallback: &'static str,
}

pub fn brand_render_data(brand: Option<&BrandDefinition>) -> BrandRenderData {
    match brand {
        Some(brand) => BrandRenderData {
            path: brand.asset_path(),
            fallback: brand.fallback,
        },
        None => BrandRenderData {
            path: None,
            fallback: "◇",
        },
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FiletypeGroup {
    pub id: &'static str,
    pub extensions: &'static str,
}

pub const FILETYPE_GROUPS: &[FiletypeGroup] = &[
    FiletypeGroup {
        id: "rust",
        extensions: "rs",
    },
    FiletypeGroup {
        id: "js",
        extensions: "mjs cjs",
    },
    FiletypeGroup {
        id: "ts",
        extensions: "mts cts",
    },
    FiletypeGroup {
        id: "react",
        extensions: "jsx tsx",
    },
    FiletypeGroup {
        id: "py",
        extensions: "pyi pyw ipynb",
    },
    FiletypeGroup {
        id: "md",
        extensions: "markdown mdx",
    },
    FiletypeGroup {
        id: "julia",
        extensions: "jl",
    },
    FiletypeGroup {
        id: "crystal",
        extensions: "cr",
    },
    FiletypeGroup {
        id: "sass",
        extensions: "scss",
    },
    FiletypeGroup {
        id: "yaml",
        extensions: "yml",
    },
    FiletypeGroup {
        id: "html",
        extensions: "htm xhtml",
    },
    FiletypeGroup {
        id: "sh",
        extensions: "bash zsh fish ksh",
    },
    FiletypeGroup {
        id: "cpp",
        extensions: "cc cxx hpp hh hxx",
    },
    FiletypeGroup {
        id: "c",
        extensions: "h",
    },
    FiletypeGroup {
        id: "csharp",
        extensions: "cs csx cshtml csproj",
    },
    FiletypeGroup {
        id: "elixir",
        extensions: "ex exs heex",
    },
    FiletypeGroup {
        id: "erlang",
        extensions: "erl hrl",
    },
    FiletypeGroup {
        id: "haskell",
        extensions: "hs lhs",
    },
    FiletypeGroup {
        id: "clojure",
        extensions: "clj cljs cljc edn",
    },
    FiletypeGroup {
        id: "ocaml",
        extensions: "ml mli",
    },
    FiletypeGroup {
        id: "perl",
        extensions: "pl pm",
    },
    FiletypeGroup {
        id: "ruby",
        extensions: "rb erb rake gemspec",
    },
    FiletypeGroup {
        id: "fsharp",
        extensions: "fs fsx fsi fsproj",
    },
    FiletypeGroup {
        id: "kotlin",
        extensions: "kt kts",
    },
    FiletypeGroup {
        id: "java",
        extensions: "class jar",
    },
    FiletypeGroup {
        id: "scala",
        extensions: "sc",
    },
    FiletypeGroup {
        id: "graphql",
        extensions: "gql",
    },
    FiletypeGroup {
        id: "tex",
        extensions: "latex bib",
    },
    FiletypeGroup {
        id: "wasm",
        extensions: "wat",
    },
    FiletypeGroup {
        id: "groovy",
        extensions: "gvy",
    },
    FiletypeGroup {
        id: "racket",
        extensions: "rkt",
    },
    FiletypeGroup {
        id: "solidity",
        extensions: "sol",
    },
    FiletypeGroup {
        id: "terraform",
        extensions: "tf tfvars hcl",
    },
    FiletypeGroup {
        id: "vim",
        extensions: "vimrc nvim",
    },
    FiletypeGroup {
        id: "db",
        extensions: "sql sqlite3",
    },
    FiletypeGroup {
        id: "fortran",
        extensions: "f f90 f95 for",
    },
    FiletypeGroup {
        id: "image",
        extensions: "png jpg jpeg webp gif avif tiff tif bmp ico heic heif dng raw cr2 nef arw psd icns",
    },
    FiletypeGroup {
        id: "font",
        extensions: "woff woff2 ttf otf eot",
    },
    FiletypeGroup {
        id: "audio",
        extensions: "mp3 wav flac aac ogg oga m4a opus aiff",
    },
    FiletypeGroup {
        id: "video",
        extensions: "mp4 mov avi mkv webm m4v mpg mpeg",
    },
    FiletypeGroup {
        id: "archive",
        extensions: "zip tar gz tgz bz2 xz zst 7z rar dmg pkg",
    },
    FiletypeGroup {
        id: "config",
        extensions: "ini conf cfg properties plist editorconfig",
    },
    FiletypeGroup {
        id: "binary",
        extensions: "o a so dylib exe bin node",
    },
    FiletypeGroup {
        id: "doc",
        extensions: "txt log pdf rtf csv tsv",
    },
];

pub const FILETYPE_NAME_OVERRIDES: &[(&str, &str)] = &[
    ("dockerfile", "docker"),
    ("containerfile", "docker"),
    ("makefile", "c"),
    ("cmakelists", "c"),
    ("justfile", "sh"),
    ("brewfile", "sh"),
    ("rakefile", "ruby"),
    ("gemfile", "ruby"),
    ("podfile", "ruby"),
    ("cargo", "rust"),
];

pub const FILETYPE_ASSETS: &[LocalAsset] = &[
    LocalAsset {
        id: "archive",
        path: "desktop/assets/filetypes/archive.svg",
    },
    LocalAsset {
        id: "astro",
        path: "desktop/assets/filetypes/astro.svg",
    },
    LocalAsset {
        id: "audio",
        path: "desktop/assets/filetypes/audio.svg",
    },
    LocalAsset {
        id: "binary",
        path: "desktop/assets/filetypes/binary.svg",
    },
    LocalAsset {
        id: "c",
        path: "desktop/assets/filetypes/c.svg",
    },
    LocalAsset {
        id: "clojure",
        path: "desktop/assets/filetypes/clojure.svg",
    },
    LocalAsset {
        id: "coffee",
        path: "desktop/assets/filetypes/coffee.svg",
    },
    LocalAsset {
        id: "config",
        path: "desktop/assets/filetypes/config.svg",
    },
    LocalAsset {
        id: "cpp",
        path: "desktop/assets/filetypes/cpp.svg",
    },
    LocalAsset {
        id: "crystal",
        path: "desktop/assets/filetypes/crystal.svg",
    },
    LocalAsset {
        id: "csharp",
        path: "desktop/assets/filetypes/csharp.svg",
    },
    LocalAsset {
        id: "css",
        path: "desktop/assets/filetypes/css.svg",
    },
    LocalAsset {
        id: "dart",
        path: "desktop/assets/filetypes/dart.svg",
    },
    LocalAsset {
        id: "db",
        path: "desktop/assets/filetypes/db.svg",
    },
    LocalAsset {
        id: "doc",
        path: "desktop/assets/filetypes/doc.svg",
    },
    LocalAsset {
        id: "docker",
        path: "desktop/assets/filetypes/docker.svg",
    },
    LocalAsset {
        id: "elixir",
        path: "desktop/assets/filetypes/elixir.svg",
    },
    LocalAsset {
        id: "erlang",
        path: "desktop/assets/filetypes/erlang.svg",
    },
    LocalAsset {
        id: "font",
        path: "desktop/assets/filetypes/font.svg",
    },
    LocalAsset {
        id: "fortran",
        path: "desktop/assets/filetypes/fortran.svg",
    },
    LocalAsset {
        id: "fsharp",
        path: "desktop/assets/filetypes/fsharp.svg",
    },
    LocalAsset {
        id: "git",
        path: "desktop/assets/filetypes/git.svg",
    },
    LocalAsset {
        id: "go",
        path: "desktop/assets/filetypes/go.svg",
    },
    LocalAsset {
        id: "gradle",
        path: "desktop/assets/filetypes/gradle.svg",
    },
    LocalAsset {
        id: "graphql",
        path: "desktop/assets/filetypes/graphql.svg",
    },
    LocalAsset {
        id: "groovy",
        path: "desktop/assets/filetypes/groovy.svg",
    },
    LocalAsset {
        id: "haskell",
        path: "desktop/assets/filetypes/haskell.svg",
    },
    LocalAsset {
        id: "html",
        path: "desktop/assets/filetypes/html.svg",
    },
    LocalAsset {
        id: "image",
        path: "desktop/assets/filetypes/image.svg",
    },
    LocalAsset {
        id: "java",
        path: "desktop/assets/filetypes/java.svg",
    },
    LocalAsset {
        id: "js",
        path: "desktop/assets/filetypes/js.svg",
    },
    LocalAsset {
        id: "json",
        path: "desktop/assets/filetypes/json.svg",
    },
    LocalAsset {
        id: "julia",
        path: "desktop/assets/filetypes/julia.svg",
    },
    LocalAsset {
        id: "k8s",
        path: "desktop/assets/filetypes/k8s.svg",
    },
    LocalAsset {
        id: "kotlin",
        path: "desktop/assets/filetypes/kotlin.svg",
    },
    LocalAsset {
        id: "less",
        path: "desktop/assets/filetypes/less.svg",
    },
    LocalAsset {
        id: "lock",
        path: "desktop/assets/filetypes/lock.svg",
    },
    LocalAsset {
        id: "lua",
        path: "desktop/assets/filetypes/lua.svg",
    },
    LocalAsset {
        id: "md",
        path: "desktop/assets/filetypes/md.svg",
    },
    LocalAsset {
        id: "nginx",
        path: "desktop/assets/filetypes/nginx.svg",
    },
    LocalAsset {
        id: "nim",
        path: "desktop/assets/filetypes/nim.svg",
    },
    LocalAsset {
        id: "ocaml",
        path: "desktop/assets/filetypes/ocaml.svg",
    },
    LocalAsset {
        id: "perl",
        path: "desktop/assets/filetypes/perl.svg",
    },
    LocalAsset {
        id: "php",
        path: "desktop/assets/filetypes/php.svg",
    },
    LocalAsset {
        id: "py",
        path: "desktop/assets/filetypes/py.svg",
    },
    LocalAsset {
        id: "r",
        path: "desktop/assets/filetypes/r.svg",
    },
    LocalAsset {
        id: "racket",
        path: "desktop/assets/filetypes/racket.svg",
    },
    LocalAsset {
        id: "react",
        path: "desktop/assets/filetypes/react.svg",
    },
    LocalAsset {
        id: "ruby",
        path: "desktop/assets/filetypes/ruby.svg",
    },
    LocalAsset {
        id: "rust",
        path: "desktop/assets/filetypes/rust.svg",
    },
    LocalAsset {
        id: "sass",
        path: "desktop/assets/filetypes/sass.svg",
    },
    LocalAsset {
        id: "scala",
        path: "desktop/assets/filetypes/scala.svg",
    },
    LocalAsset {
        id: "sh",
        path: "desktop/assets/filetypes/sh.svg",
    },
    LocalAsset {
        id: "solidity",
        path: "desktop/assets/filetypes/solidity.svg",
    },
    LocalAsset {
        id: "sqlite",
        path: "desktop/assets/filetypes/sqlite.svg",
    },
    LocalAsset {
        id: "svelte",
        path: "desktop/assets/filetypes/svelte.svg",
    },
    LocalAsset {
        id: "svg",
        path: "desktop/assets/filetypes/svg.svg",
    },
    LocalAsset {
        id: "swift",
        path: "desktop/assets/filetypes/swift.svg",
    },
    LocalAsset {
        id: "terraform",
        path: "desktop/assets/filetypes/terraform.svg",
    },
    LocalAsset {
        id: "tex",
        path: "desktop/assets/filetypes/tex.svg",
    },
    LocalAsset {
        id: "toml",
        path: "desktop/assets/filetypes/toml.svg",
    },
    LocalAsset {
        id: "ts",
        path: "desktop/assets/filetypes/ts.svg",
    },
    LocalAsset {
        id: "video",
        path: "desktop/assets/filetypes/video.svg",
    },
    LocalAsset {
        id: "vim",
        path: "desktop/assets/filetypes/vim.svg",
    },
    LocalAsset {
        id: "vue",
        path: "desktop/assets/filetypes/vue.svg",
    },
    LocalAsset {
        id: "wasm",
        path: "desktop/assets/filetypes/wasm.svg",
    },
    LocalAsset {
        id: "xml",
        path: "desktop/assets/filetypes/xml.svg",
    },
    LocalAsset {
        id: "yaml",
        path: "desktop/assets/filetypes/yaml.svg",
    },
    LocalAsset {
        id: "zig",
        path: "desktop/assets/filetypes/zig.svg",
    },
];

pub fn filetype_asset(id: &str) -> Option<&'static LocalAsset> {
    FILETYPE_ASSETS.iter().find(|asset| asset.id == id)
}

fn filetype_group_for_extension(extension: &str) -> Option<&'static str> {
    FILETYPE_GROUPS.iter().find_map(|group| {
        group
            .extensions
            .split_whitespace()
            .find(|item| *item == extension)
            .map(|_| group.id)
    })
}

fn lock_name(name: &str) -> bool {
    name.ends_with(".lock")
        || name.ends_with("-lock.json")
        || name.ends_with("-lock.yml")
        || name.ends_with("-lock.yaml")
}

pub fn filetype_key_for_path(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let extension = name.rsplit_once('.').map_or("", |(_, extension)| extension);
    let stem = name.split_once('.').map_or(name.as_str(), |(stem, _)| stem);
    let key = if name.starts_with(".env") {
        "config"
    } else if name.starts_with(".git") {
        "git"
    } else if lock_name(&name) {
        "lock"
    } else if let Some((_, key)) = FILETYPE_NAME_OVERRIDES
        .iter()
        .find(|(name_override, _)| *name_override == stem)
    {
        *key
    } else if let Some(key) = filetype_group_for_extension(extension) {
        key
    } else {
        extension
    };
    filetype_asset(key).map(|asset| asset.id)
}

pub fn filetype_asset_for_path(path: &str) -> Option<&'static LocalAsset> {
    filetype_key_for_path(path).and_then(filetype_asset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_brand_assets_are_complete_and_unique() {
        assert_eq!(BRAND_ASSETS.len(), 34);
        for (index, asset) in BRAND_ASSETS.iter().enumerate() {
            assert!(
                BRAND_ASSETS[index + 1..]
                    .iter()
                    .all(|other| other.id != asset.id)
            );
            assert!(asset.path.starts_with("desktop/assets/brands/"));
        }
        assert_eq!(
            brand_asset("openai").map(|asset| asset.path),
            Some("desktop/assets/brands/openai.svg")
        );
        assert_eq!(
            brand_asset("sakana").map(|asset| asset.path),
            Some("desktop/assets/brands/sakana.png")
        );
    }

    #[test]
    fn importer_and_provider_definitions_preserve_ids_and_assets() {
        assert_eq!(
            IMPORTER_BRANDS
                .iter()
                .map(|brand| brand.id)
                .collect::<Vec<_>>(),
            [
                "codex",
                "claude",
                "antigravity",
                "pi",
                "opencode",
                "cursor",
                "windsurf",
                "devin"
            ]
        );
        assert_eq!(PROVIDER_BRANDS.len(), 23);
        assert_eq!(
            brand_for_importer("codex").and_then(|brand| brand.asset_path()),
            Some("desktop/assets/brands/openai.svg")
        );
        assert_eq!(
            brand_for_importer("devin").and_then(|brand| brand.asset_path()),
            None
        );
        assert_eq!(
            brand_for_provider(" OpenAI ").map(|brand| brand.id),
            Some("openai")
        );
        assert_eq!(brand_for_provider("missing"), None);
        assert_eq!(
            OBSIDIAN_BRAND.asset_path(),
            Some("desktop/assets/brands/obsidian.svg")
        );
    }

    #[test]
    fn model_brand_resolution_matches_openrouter_and_local_rules() {
        assert_eq!(
            brand_for_model("openrouter:anthropic/claude-3", None).map(|brand| brand.id),
            Some("anthropic")
        );
        assert_eq!(
            brand_for_model("google/gemini-2.5", Some(ModelSource::OpenRouter))
                .map(|brand| brand.id),
            Some("gemini")
        );
        assert_eq!(
            brand_for_model("unknown/vendor-model", Some(ModelSource::OpenRouter)),
            None
        );
        assert_eq!(
            brand_for_model("gpt-5", Some(ModelSource::Local)).map(|brand| brand.id),
            Some("openai")
        );
        assert_eq!(brand_for_model("claudex", Some(ModelSource::Local)), None);
        assert!(matches_local_alias("o4-mini", "o4"));
        assert!(!matches_local_alias("o4mini", "o4"));
        assert_eq!(
            brand_render_data(None),
            BrandRenderData {
                path: None,
                fallback: "◇"
            }
        );
    }

    #[test]
    fn filetype_assets_cover_every_bundled_mark_and_path_rules() {
        assert_eq!(FILETYPE_ASSETS.len(), 69);
        for (index, asset) in FILETYPE_ASSETS.iter().enumerate() {
            assert!(
                FILETYPE_ASSETS[index + 1..]
                    .iter()
                    .all(|other| other.id != asset.id)
            );
            assert!(asset.path.starts_with("desktop/assets/filetypes/"));
        }
        assert_eq!(
            filetype_asset_for_path("src/main.rs").map(|asset| asset.id),
            Some("rust")
        );
        assert_eq!(
            filetype_asset_for_path("src/view.tsx").map(|asset| asset.id),
            Some("react")
        );
        assert_eq!(
            filetype_asset_for_path("Dockerfile").map(|asset| asset.id),
            Some("docker")
        );
        assert_eq!(
            filetype_asset_for_path(".env.local").map(|asset| asset.id),
            Some("config")
        );
        assert_eq!(
            filetype_asset_for_path(".gitignore").map(|asset| asset.id),
            Some("git")
        );
        assert_eq!(
            filetype_asset_for_path("package-lock.json").map(|asset| asset.id),
            Some("lock")
        );
        assert_eq!(
            filetype_asset_for_path("config-lock.yaml").map(|asset| asset.id),
            Some("lock")
        );
        assert_eq!(filetype_asset_for_path("notes.unknown"), None);
    }
}
