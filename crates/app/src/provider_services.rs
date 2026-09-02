use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::preferences::{CATALOG_FILE, PreferenceError, PreferenceStore};

pub const MAX_PROVIDERS: usize = 24;
pub const MAX_CONTEXT_WINDOW: u64 = 100_000_000;
pub const MAX_PROVIDER_MODELS: usize = 512;
pub const MAX_CATALOG_MODELS: usize = 2_048;
pub const MAX_CATALOG_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_SECRET_CHARS: usize = 512;
pub const OPENROUTER_MODELS_URL: &str =
    "https://openrouter.ai/api/v1/models?supported_parameters=tools&sort=most-popular";
pub const OPENROUTER_KEY_URL: &str = "https://openrouter.ai/api/v1/key";
pub const OPENROUTER_KEYS_URL: &str = "https://openrouter.ai/keys";
pub const OPENROUTER_CREDITS_URL: &str = "https://openrouter.ai/settings/credits";
pub const DEEPSEEK_BALANCE_URL: &str = "https://api.deepseek.com/user/balance";
pub const KEYCHAIN_SERVICE: &str = "Emma provider credentials";
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
pub const BALANCE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProviderPreset {
    pub id: &'static str,
    pub name: &'static str,
    pub base_url: &'static str,
    pub credential_env: &'static str,
    pub detail: &'static str,
}

pub const PROVIDER_PRESETS: &[ProviderPreset] = &[
    ProviderPreset {
        id: "openrouter",
        name: "OpenRouter",
        base_url: "https://openrouter.ai/api/v1",
        credential_env: "OPENROUTER_API_KEY",
        detail: "Every maker, one key",
    },
    ProviderPreset {
        id: "zai",
        name: "Z.AI",
        base_url: "https://api.z.ai/api/paas/v4",
        credential_env: "ZAI_API_KEY",
        detail: "GLM, direct",
    },
    ProviderPreset {
        id: "deepseek",
        name: "DeepSeek",
        base_url: "https://api.deepseek.com",
        credential_env: "DEEPSEEK_API_KEY",
        detail: "DeepSeek, direct",
    },
    ProviderPreset {
        id: "opencode-zen",
        name: "OpenCode Zen",
        base_url: "https://opencode.ai/zen/v1",
        credential_env: "OPENCODE_API_KEY",
        detail: "Curated gateway, prepaid",
    },
    ProviderPreset {
        id: "opencode-go",
        name: "OpenCode Go",
        base_url: "https://opencode.ai/zen/go/v1",
        credential_env: "OPENCODE_API_KEY",
        detail: "Open models, flat monthly",
    },
    ProviderPreset {
        id: "lmstudio",
        name: "LM Studio",
        base_url: "http://127.0.0.1:1234/v1",
        credential_env: "",
        detail: "On this computer",
    },
    ProviderPreset {
        id: "ollama",
        name: "Ollama",
        base_url: "http://127.0.0.1:11434/v1",
        credential_env: "",
        detail: "On this computer",
    },
    ProviderPreset {
        id: "llamacpp",
        name: "llama.cpp",
        base_url: "http://127.0.0.1:8080/v1",
        credential_env: "",
        detail: "On this computer",
    },
    ProviderPreset {
        id: "custom",
        name: "",
        base_url: "",
        credential_env: "",
        detail: "Any OpenAI-compatible endpoint",
    },
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ModelPlan {
    pub id: &'static str,
    pub label: &'static str,
    pub brand: &'static str,
    pub namespace: &'static str,
    pub detail: &'static str,
    pub base_url: &'static str,
    pub credential_env: &'static str,
    pub context_window: u64,
    pub keys_url: &'static str,
    pub hint: &'static str,
    pub billing: BillingMode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BillingMode {
    Subscription,
    Metered,
}

pub const MODEL_PLANS: &[ModelPlan] = &[
    ModelPlan {
        id: "openai",
        label: "OpenAI",
        brand: "openai",
        namespace: "openai",
        detail: "GPT, billed per token",
        base_url: "https://api.openai.com/v1",
        credential_env: "OPENAI_API_KEY",
        context_window: 0,
        keys_url: "https://platform.openai.com/api-keys",
        hint: "sk-…",
        billing: BillingMode::Metered,
    },
    ModelPlan {
        id: "anthropic",
        label: "Anthropic",
        brand: "anthropic",
        namespace: "anthropic",
        detail: "Claude, billed per token",
        base_url: "https://api.anthropic.com/v1",
        credential_env: "ANTHROPIC_API_KEY",
        context_window: 0,
        keys_url: "https://platform.claude.com/settings/keys",
        hint: "sk-ant-…",
        billing: BillingMode::Metered,
    },
    ModelPlan {
        id: "deepseek",
        label: "DeepSeek",
        brand: "deepseek",
        namespace: "deepseek",
        detail: "DeepSeek, billed per token",
        base_url: "https://api.deepseek.com",
        credential_env: "DEEPSEEK_API_KEY",
        context_window: 0,
        keys_url: "https://platform.deepseek.com/api_keys",
        hint: "sk-…",
        billing: BillingMode::Metered,
    },
    ModelPlan {
        id: "qwen",
        label: "Qwen Coding Plan",
        brand: "qwen",
        namespace: "qwen",
        detail: "Alibaba Model Studio, flat monthly",
        base_url: "https://coding-intl.dashscope.aliyuncs.com/v1",
        credential_env: "BAILIAN_CODING_PLAN_API_KEY",
        context_window: 0,
        keys_url: "https://www.alibabacloud.com/help/en/model-studio/coding-plan",
        hint: "sk-sp-…",
        billing: BillingMode::Subscription,
    },
    ModelPlan {
        id: "zai",
        label: "GLM Coding Plan",
        brand: "glm",
        namespace: "z-ai",
        detail: "Z.AI, flat monthly",
        base_url: "https://api.z.ai/api/coding/paas/v4",
        credential_env: "ZAI_API_KEY",
        context_window: 0,
        keys_url: "https://z.ai/manage-apikey/apikey-list",
        hint: "Z.AI key",
        billing: BillingMode::Subscription,
    },
    ModelPlan {
        id: "kimi",
        label: "Kimi Code",
        brand: "kimi",
        namespace: "moonshotai",
        detail: "Moonshot, flat monthly",
        base_url: "https://api.kimi.com/coding/v1",
        credential_env: "KIMI_CODE_API_KEY",
        context_window: 0,
        keys_url: "https://www.kimi.com/code/console",
        hint: "Kimi Code key",
        billing: BillingMode::Subscription,
    },
    ModelPlan {
        id: "minimax",
        label: "MiniMax Token Plan",
        brand: "minimax",
        namespace: "minimax",
        detail: "MiniMax, flat monthly",
        base_url: "https://api.minimax.io/v1",
        credential_env: "MINIMAX_API_KEY",
        context_window: 0,
        keys_url: "https://platform.minimax.io/user-center/payment/token-plan",
        hint: "Subscription key",
        billing: BillingMode::Subscription,
    },
    ModelPlan {
        id: "gemini",
        label: "Gemini",
        brand: "gemini",
        namespace: "google",
        detail: "Gemini, billed per token",
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        credential_env: "GEMINI_API_KEY",
        context_window: 0,
        keys_url: "https://aistudio.google.com/apikey",
        hint: "AIza…",
        billing: BillingMode::Metered,
    },
    ModelPlan {
        id: "mistral",
        label: "Mistral",
        brand: "mistral",
        namespace: "mistralai",
        detail: "Mistral, plan credits then per token",
        base_url: "https://api.mistral.ai/v1",
        credential_env: "MISTRAL_API_KEY",
        context_window: 0,
        keys_url: "https://console.mistral.ai/api-keys",
        hint: "Mistral key",
        billing: BillingMode::Metered,
    },
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SearchProviderPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub endpoint: &'static str,
    pub detail: &'static str,
    pub keyless: bool,
    pub free: bool,
    pub credential_env: &'static str,
}

pub const SEARCH_PROVIDER_PRESETS: &[SearchProviderPreset] = &[
    SearchProviderPreset {
        id: "tinyfish",
        label: "TinyFish",
        endpoint: "https://api.search.tinyfish.ai",
        detail: "Free: 30 searches/minute and 150 fetched URLs/minute. Needs a TinyFish API key.",
        keyless: false,
        free: true,
        credential_env: "TINYFISH_API_KEY",
    },
    SearchProviderPreset {
        id: "fourget",
        label: "4get",
        endpoint: "https://4get.canine.tools",
        detail: "No key, no account. A metasearch front end that asks several engines and answers JSON.",
        keyless: true,
        free: true,
        credential_env: "",
    },
    SearchProviderPreset {
        id: "searxng",
        label: "SearXNG",
        endpoint: "http://127.0.0.1:8888",
        detail: "Your own metasearch instance. Needs json in its search.formats.",
        keyless: true,
        free: true,
        credential_env: "",
    },
    SearchProviderPreset {
        id: "brave",
        label: "Brave Search",
        endpoint: "https://api.search.brave.com",
        detail: "Independent index. Needs a key and may bill its account.",
        keyless: false,
        free: false,
        credential_env: "BRAVE_SEARCH_API_KEY",
    },
    SearchProviderPreset {
        id: "tavily",
        label: "Tavily",
        endpoint: "https://api.tavily.com",
        detail: "Search built for agents; returns extracted content. Needs a key and may bill its account.",
        keyless: false,
        free: false,
        credential_env: "TAVILY_API_KEY",
    },
    SearchProviderPreset {
        id: "exa",
        label: "Exa",
        endpoint: "https://api.exa.ai",
        detail: "Neural search over pages by meaning rather than keywords. Needs a key and may bill its account.",
        keyless: false,
        free: false,
        credential_env: "EXA_API_KEY",
    },
];

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    pub model_id: String,
    pub base_url: String,
    pub credential_env: String,
    pub context_window: u64,
    #[serde(default)]
    pub insecure: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderReach {
    ThisMac,
    Network,
    Internet,
    Unreachable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderError {
    Invalid {
        field: &'static str,
        message: String,
    },
    TooMany {
        kind: &'static str,
        limit: usize,
    },
    Duplicate {
        kind: &'static str,
        id: String,
    },
    Unsupported {
        capability: &'static str,
    },
    CredentialUnavailable,
    CredentialRejected,
    Network {
        endpoint: String,
        message: String,
    },
    Process {
        program: &'static str,
        message: String,
    },
    TimedOut {
        program: &'static str,
    },
    Decode {
        endpoint: String,
        message: String,
    },
    Preference(PreferenceError),
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid { field, message } => write!(formatter, "{field}: {message}"),
            Self::TooMany { kind, limit } => {
                write!(formatter, "at most {limit} {kind} are supported")
            }
            Self::Duplicate { kind, id } => write!(formatter, "duplicate {kind} id: {id}"),
            Self::Unsupported { capability } => {
                write!(formatter, "{capability} is unavailable on this platform")
            }
            Self::CredentialUnavailable => {
                formatter.write_str("the secure credential store is unavailable")
            }
            Self::CredentialRejected => {
                formatter.write_str("the credential was rejected by the secure credential store")
            }
            Self::Network { endpoint, message } => write!(formatter, "{endpoint}: {message}"),
            Self::Process { program, message } => write!(formatter, "{program}: {message}"),
            Self::TimedOut { program } => write!(formatter, "{program} timed out"),
            Self::Decode { endpoint, message } => write!(formatter, "{endpoint}: {message}"),
            Self::Preference(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for ProviderError {}

impl From<PreferenceError> for ProviderError {
    fn from(error: PreferenceError) -> Self {
        Self::Preference(error)
    }
}

pub type ProviderResult<T> = Result<T, ProviderError>;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
    pub context_length: u64,
    pub input_modalities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reasoning_efforts: Vec<String>,
    #[serde(default)]
    pub reasoning_mandatory: bool,
    pub free: bool,
    #[serde(default)]
    pub prompt_micro_usd_per_mtok: u64,
    #[serde(default)]
    pub completion_micro_usd_per_mtok: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_model: Option<String>,
    pub models: Vec<CatalogModel>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCache {
    pub fetched_at: String,
    pub models: Vec<CatalogModel>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderProbe {
    pub models: Vec<String>,
    pub tools: bool,
    pub error: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyBalance {
    pub keyed: bool,
    pub free_tier: bool,
    pub remaining: Option<f64>,
    pub usage: f64,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialSummary {
    pub env: String,
    pub masked: Option<String>,
}

pub enum CredentialOperation {
    Read { env: String },
    Save { env: String, secret: String },
    Remove { env: String },
}

pub enum ProviderRequest {
    ListModels(ProviderProfile),
    Probe(ProviderProfile),
    OpenRouterCatalog,
    OpenRouterBalance,
    DeepSeekBalance,
    Credential(CredentialOperation),
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProviderResponse {
    Models(Vec<String>),
    Probe(ProviderProbe),
    Catalog(Catalog),
    Balance(KeyBalance),
    Credential(CredentialSummary),
    Removed(bool),
}

#[derive(Clone)]
pub struct KeychainStore {
    service: String,
    timeout: Duration,
}

impl Default for KeychainStore {
    fn default() -> Self {
        Self {
            service: KEYCHAIN_SERVICE.into(),
            timeout: PROBE_TIMEOUT,
        }
    }
}

impl KeychainStore {
    pub fn new(service: impl Into<String>, timeout: Duration) -> ProviderResult<Self> {
        let service = service.into();
        if service.is_empty() || service.chars().count() > 128 {
            return Err(ProviderError::Invalid {
                field: "service",
                message: "must contain 1 to 128 characters".into(),
            });
        }
        Ok(Self { service, timeout })
    }

    pub fn summary(&self, env: &str) -> ProviderResult<CredentialSummary> {
        validate_env_name(env)?;
        Ok(CredentialSummary {
            env: env.into(),
            masked: self.read(env)?.map(|secret| mask_secret(&secret)),
        })
    }

    pub fn save(&self, env: &str, secret: &str) -> ProviderResult<CredentialSummary> {
        validate_env_name(env)?;
        let secret = validate_secret(secret)?;
        #[cfg(not(target_os = "macos"))]
        {
            let _ = secret;
            return Err(ProviderError::Unsupported {
                capability: "macOS Keychain",
            });
        }
        #[cfg(target_os = "macos")]
        {
            let masked = mask_secret(&secret);
            let args = [
                OsString::from("add-generic-password"),
                OsString::from("-a"),
                OsString::from(env),
                OsString::from("-s"),
                OsString::from(&self.service),
                OsString::from("-w"),
                OsString::from(secret),
                OsString::from("-U"),
            ];
            let output = run_security(&args, self.timeout)?;
            if !output.status.success() {
                return Err(ProviderError::CredentialRejected);
            }
            Ok(CredentialSummary {
                env: env.into(),
                masked: Some(masked),
            })
        }
    }

    pub fn remove(&self, env: &str) -> ProviderResult<bool> {
        validate_env_name(env)?;
        #[cfg(not(target_os = "macos"))]
        {
            return Err(ProviderError::Unsupported {
                capability: "macOS Keychain",
            });
        }
        #[cfg(target_os = "macos")]
        {
            let args = [
                OsString::from("delete-generic-password"),
                OsString::from("-a"),
                OsString::from(env),
                OsString::from("-s"),
                OsString::from(&self.service),
            ];
            let output = run_security(&args, self.timeout)?;
            if output.status.success() {
                Ok(true)
            } else if output.status.code() == Some(44) {
                Ok(false)
            } else {
                Err(ProviderError::CredentialRejected)
            }
        }
    }

    fn read(&self, env: &str) -> ProviderResult<Option<String>> {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = env;
            return Err(ProviderError::Unsupported {
                capability: "macOS Keychain",
            });
        }
        #[cfg(target_os = "macos")]
        {
            let args = [
                OsString::from("find-generic-password"),
                OsString::from("-a"),
                OsString::from(env),
                OsString::from("-s"),
                OsString::from(&self.service),
                OsString::from("-w"),
            ];
            let output = run_security(&args, self.timeout)?;
            if output.status.code() == Some(44) {
                return Ok(None);
            }
            if !output.status.success() {
                return Err(ProviderError::CredentialRejected);
            }
            let secret =
                String::from_utf8(output.stdout).map_err(|_| ProviderError::CredentialRejected)?;
            let secret = secret.trim_end_matches(['\r', '\n']).trim();
            if secret.is_empty() {
                return Ok(None);
            }
            Ok(Some(validate_secret(secret)?))
        }
    }
}

pub struct ProviderServices {
    preferences: PreferenceStore,
    keychain: KeychainStore,
    network_timeout: Duration,
    probe_timeout: Duration,
    balance_timeout: Duration,
}

impl ProviderServices {
    pub fn new(preferences: PreferenceStore) -> Self {
        Self {
            preferences,
            keychain: KeychainStore::default(),
            network_timeout: NETWORK_TIMEOUT,
            probe_timeout: PROBE_TIMEOUT,
            balance_timeout: BALANCE_TIMEOUT,
        }
    }

    pub fn with_keychain(preferences: PreferenceStore, keychain: KeychainStore) -> Self {
        Self {
            preferences,
            keychain,
            network_timeout: NETWORK_TIMEOUT,
            probe_timeout: PROBE_TIMEOUT,
            balance_timeout: BALANCE_TIMEOUT,
        }
    }

    pub fn preferences(&self) -> &PreferenceStore {
        &self.preferences
    }

    pub fn keychain(&self) -> &KeychainStore {
        &self.keychain
    }

    pub fn execute(&self, request: ProviderRequest) -> ProviderResult<ProviderResponse> {
        match request {
            ProviderRequest::ListModels(profile) => {
                self.list_models(&profile).map(ProviderResponse::Models)
            }
            ProviderRequest::Probe(profile) => self.probe(&profile).map(ProviderResponse::Probe),
            ProviderRequest::OpenRouterCatalog => self
                .fetch_openrouter_catalog()
                .map(ProviderResponse::Catalog),
            ProviderRequest::OpenRouterBalance => self
                .fetch_openrouter_balance()
                .map(ProviderResponse::Balance),
            ProviderRequest::DeepSeekBalance => {
                self.fetch_deepseek_balance().map(ProviderResponse::Balance)
            }
            ProviderRequest::Credential(operation) => match operation {
                CredentialOperation::Read { env } => self
                    .keychain
                    .summary(&env)
                    .map(ProviderResponse::Credential),
                CredentialOperation::Save { env, secret } => self
                    .keychain
                    .save(&env, &secret)
                    .map(ProviderResponse::Credential),
                CredentialOperation::Remove { env } => {
                    self.keychain.remove(&env).map(ProviderResponse::Removed)
                }
            },
        }
    }

    pub fn load_profiles(&self) -> ProviderResult<Vec<ProviderProfile>> {
        let settings = self.preferences.read_settings_or_default(None)?;
        let Some(providers) = settings.get("providers") else {
            return Ok(Vec::new());
        };
        let profiles: Vec<ProviderProfile> =
            serde_json::from_value(providers.clone()).map_err(|_| ProviderError::Invalid {
                field: "providers",
                message: "the saved provider list is invalid".into(),
            })?;
        validate_profiles(&profiles)
    }

    pub fn save_profiles(
        &self,
        profiles: &[ProviderProfile],
    ) -> ProviderResult<Vec<ProviderProfile>> {
        let profiles = validate_profiles(profiles)?;
        let mut settings = self.preferences.read_settings_or_default(None)?;
        let object = settings
            .as_object_mut()
            .ok_or_else(|| ProviderError::Invalid {
                field: "settings",
                message: "the saved settings are not an object".into(),
            })?;
        object.insert(
            "providers".into(),
            serde_json::to_value(&profiles).map_err(|_| ProviderError::Invalid {
                field: "providers",
                message: "the provider list could not be encoded".into(),
            })?,
        );
        self.preferences.write_settings(&settings)?;
        Ok(profiles)
    }

    pub fn load_catalog(&self) -> ProviderResult<Option<CatalogCache>> {
        self.preferences
            .read_named_json(CATALOG_FILE)
            .map_err(ProviderError::from)
    }

    pub fn save_catalog(
        &self,
        catalog: &Catalog,
        fetched_at: &str,
    ) -> ProviderResult<CatalogCache> {
        validate_catalog(catalog)?;
        if fetched_at.is_empty() || fetched_at.chars().count() > 128 {
            return Err(ProviderError::Invalid {
                field: "fetchedAt",
                message: "must contain 1 to 128 characters".into(),
            });
        }
        let cache = CatalogCache {
            fetched_at: fetched_at.into(),
            models: catalog.models.clone(),
        };
        self.preferences.write_named_json(CATALOG_FILE, &cache)?;
        Ok(cache)
    }

    pub fn list_models(&self, profile: &ProviderProfile) -> ProviderResult<Vec<String>> {
        let profile = validate_profile(profile)?;
        let key = self.credential(&profile.credential_env)?;
        let url = provider_models_url(&profile.base_url)?;
        let body = self.curl(&url, "GET", None, key.as_deref(), self.probe_timeout)?;
        parse_provider_models(&body, &url)
    }

    pub fn probe(&self, profile: &ProviderProfile) -> ProviderResult<ProviderProbe> {
        let profile = validate_profile(profile)?;
        let key = self.credential(&profile.credential_env)?;
        let url = provider_models_url(&profile.base_url)?;
        let mut result = ProviderProbe {
            models: Vec::new(),
            tools: false,
            error: String::new(),
        };
        match self.curl(&url, "GET", None, key.as_deref(), self.probe_timeout) {
            Ok(body) => match parse_provider_models(&body, &url) {
                Ok(models) => result.models = models,
                Err(error) => result.error = error.to_string(),
            },
            Err(error) => result.error = error.to_string(),
        }
        if profile.model_id.is_empty() {
            return Ok(result);
        }
        let url = provider_chat_url(&profile.base_url)?;
        let body = serde_json::json!({
            "model": profile.model_id,
            "messages": [{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "emma_probe",
                    "description": "Report the weather. Call this tool to answer.",
                    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
                }
            }],
            "max_tokens": 64,
            "stream": false
        });
        match self.curl(
            &url,
            "POST",
            Some(&body.to_string()),
            key.as_deref(),
            self.probe_timeout,
        ) {
            Ok(response) => match parse_tool_probe(&response, &url) {
                Ok(tools) => result.tools = tools,
                Err(error) => {
                    if result.error.is_empty() {
                        result.error = error.to_string();
                    }
                }
            },
            Err(error) => {
                if result.error.is_empty() {
                    result.error = error.to_string();
                }
            }
        }
        Ok(result)
    }

    pub fn fetch_openrouter_catalog(&self) -> ProviderResult<Catalog> {
        let body = self.curl(
            OPENROUTER_MODELS_URL,
            "GET",
            None,
            None,
            self.network_timeout,
        )?;
        parse_openrouter_catalog(&body)
    }

    pub fn fetch_openrouter_balance(&self) -> ProviderResult<KeyBalance> {
        let key = self.credential("OPENROUTER_API_KEY")?;
        let Some(key) = key else {
            return Ok(blank_balance(false));
        };
        let body = self.curl(
            OPENROUTER_KEY_URL,
            "GET",
            None,
            Some(&key),
            self.balance_timeout,
        )?;
        parse_openrouter_balance(&body)
    }

    pub fn fetch_deepseek_balance(&self) -> ProviderResult<KeyBalance> {
        let key = self.credential("DEEPSEEK_API_KEY")?;
        let Some(key) = key else {
            return Ok(blank_balance(false));
        };
        let body = self.curl(
            DEEPSEEK_BALANCE_URL,
            "GET",
            None,
            Some(&key),
            self.balance_timeout,
        )?;
        parse_deepseek_balance(&body)
    }

    fn credential(&self, env: &str) -> ProviderResult<Option<String>> {
        if env.is_empty() {
            return Ok(None);
        }
        validate_env_name(env)?;
        #[cfg(not(target_os = "macos"))]
        {
            let _ = env;
            Ok(None)
        }
        #[cfg(target_os = "macos")]
        {
            self.keychain.read(env)
        }
    }

    fn curl(
        &self,
        endpoint: &str,
        method: &str,
        body: Option<&str>,
        key: Option<&str>,
        timeout: Duration,
    ) -> ProviderResult<Vec<u8>> {
        validate_http_url(endpoint, false)?;
        if !matches!(method, "GET" | "POST") {
            return Err(ProviderError::Invalid {
                field: "method",
                message: "only GET and POST are supported".into(),
            });
        }
        let seconds = timeout.as_secs().max(1).to_string();
        let connect_seconds = timeout.as_secs().min(10).max(1).to_string();
        let mut args = vec![
            OsString::from("--silent"),
            OsString::from("--show-error"),
            OsString::from("--fail-with-body"),
            OsString::from("--location"),
            OsString::from("--max-time"),
            OsString::from(&seconds),
            OsString::from("--connect-timeout"),
            OsString::from(&connect_seconds),
            OsString::from("--request"),
            OsString::from(method),
            OsString::from("--url"),
            OsString::from(endpoint),
        ];
        if let Some(body) = body {
            if body.len() > MAX_CATALOG_BYTES {
                return Err(ProviderError::Invalid {
                    field: "body",
                    message: "request body exceeds the provider limit".into(),
                });
            }
            args.push(OsString::from("--header"));
            args.push(OsString::from("content-type: application/json"));
            args.push(OsString::from("--data-raw"));
            args.push(OsString::from(body));
        }
        args.push(OsString::from("--config"));
        args.push(OsString::from("-"));
        let config =
            key.map(|key| format!("header = \"Authorization: Bearer {}\"\n", curl_escape(key)));
        let output = run_process(
            "/usr/bin/curl",
            &args,
            config.as_deref().map(str::as_bytes),
            timeout,
        )?;
        if !output.status.success() {
            return Err(ProviderError::Network {
                endpoint: endpoint.into(),
                message: String::from("the endpoint did not return a successful response"),
            });
        }
        if output.stdout.len() > MAX_CATALOG_BYTES {
            return Err(ProviderError::Network {
                endpoint: endpoint.into(),
                message: String::from("the endpoint response is too large"),
            });
        }
        Ok(output.stdout)
    }
}

pub fn validate_profiles(profiles: &[ProviderProfile]) -> ProviderResult<Vec<ProviderProfile>> {
    if profiles.len() > MAX_PROVIDERS {
        return Err(ProviderError::TooMany {
            kind: "providers",
            limit: MAX_PROVIDERS,
        });
    }
    let mut result = Vec::with_capacity(profiles.len());
    for profile in profiles {
        let validated = validate_profile(profile)?;
        if result
            .iter()
            .any(|item: &ProviderProfile| item.id == validated.id)
        {
            return Err(ProviderError::Duplicate {
                kind: "provider",
                id: validated.id,
            });
        }
        result.push(validated);
    }
    Ok(result)
}

pub fn validate_profile(profile: &ProviderProfile) -> ProviderResult<ProviderProfile> {
    if !valid_id(&profile.id, 64) {
        return Err(invalid(
            "id",
            "must contain 1 to 64 ASCII letters, digits, _ or -",
        ));
    }
    let name = profile.name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err(invalid("name", "must contain 1 to 64 characters"));
    }
    let model_id = profile.model_id.trim();
    if model_id.is_empty() || model_id.chars().count() > 128 {
        return Err(invalid("modelId", "must contain 1 to 128 characters"));
    }
    validate_env_name(&profile.credential_env)?;
    if profile.context_window > MAX_CONTEXT_WINDOW {
        return Err(invalid("contextWindow", "exceeds the provider limit"));
    }
    let base_url = normalize_provider_endpoint(&profile.base_url, profile.insecure)?;
    Ok(ProviderProfile {
        id: profile.id.clone(),
        name: name.into(),
        model_id: model_id.into(),
        base_url,
        credential_env: profile.credential_env.clone(),
        context_window: profile.context_window,
        insecure: profile.insecure,
    })
}

pub fn validate_env_name(value: &str) -> ProviderResult<()> {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return Ok(());
    };
    if value.len() > 64
        || !(first == b'_' || first.is_ascii_alphabetic())
        || !bytes.all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
    {
        return Err(invalid(
            "credentialEnv",
            "must be an environment variable name",
        ));
    }
    Ok(())
}

pub fn validate_secret(value: &str) -> ProviderResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > MAX_SECRET_CHARS {
        return Err(invalid(
            "secret",
            "must contain 1 to 512 printable characters",
        ));
    }
    if !value.bytes().all(|byte| (b'!'..=b'~').contains(&byte)) {
        return Err(invalid("secret", "must contain printable ASCII only"));
    }
    Ok(value.into())
}

pub fn mask_secret(value: &str) -> String {
    let value = value.trim();
    if value.len() < 12 {
        return "•".repeat(8);
    }
    format!(
        "{}{}{}",
        &value[..6],
        "•".repeat(10),
        &value[value.len() - 4..]
    )
}

pub fn normalize_provider_endpoint(value: &str, insecure: bool) -> ProviderResult<String> {
    let (scheme, host, authority, path) = split_http_url(value)?;
    if scheme == "http" && !is_loopback_host(&host) && !(insecure && is_private_host(&host)) {
        return Err(invalid(
            "baseUrl",
            "plain http is limited to this computer or an explicitly trusted private network",
        ));
    }
    let path = path.trim_end_matches('/');
    Ok(format!("{scheme}://{authority}{path}"))
}

pub fn provider_reach(value: &str) -> ProviderReach {
    let Ok((scheme, host, _, _)) = split_http_url(value) else {
        return ProviderReach::Unreachable;
    };
    if is_loopback_host(&host) {
        ProviderReach::ThisMac
    } else if is_private_host(&host) {
        ProviderReach::Network
    } else if scheme == "https" {
        ProviderReach::Internet
    } else {
        ProviderReach::Unreachable
    }
}

pub fn provider_chat_url(base_url: &str) -> ProviderResult<String> {
    let base_url = normalize_provider_endpoint(base_url, true)?;
    Ok(format!("{base_url}/chat/completions"))
}

pub fn provider_models_url(base_url: &str) -> ProviderResult<String> {
    let base_url = normalize_provider_endpoint(base_url, true)?;
    Ok(format!("{base_url}/models"))
}

pub fn parse_openrouter_catalog(body: &[u8]) -> ProviderResult<Catalog> {
    if body.len() > MAX_CATALOG_BYTES {
        return Err(ProviderError::Decode {
            endpoint: OPENROUTER_MODELS_URL.into(),
            message: "response exceeds the catalog limit".into(),
        });
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| ProviderError::Decode {
        endpoint: OPENROUTER_MODELS_URL.into(),
        message: "response is not JSON".into(),
    })?;
    let rows =
        value
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| ProviderError::Decode {
                endpoint: OPENROUTER_MODELS_URL.into(),
                message: "response has no model list".into(),
            })?;
    let mut models = Vec::new();
    for row in rows {
        if models.len() == MAX_CATALOG_MODELS {
            break;
        }
        let Some(row) = row.as_object() else {
            continue;
        };
        let Some(pricing) = row.get("pricing").and_then(Value::as_object) else {
            continue;
        };
        let supported = row
            .get("supported_parameters")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().any(|item| item.as_str() == Some("tools")));
        if !supported {
            continue;
        }
        let Some(id) = row.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(name) = row.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(context_length) = row.get("context_length").and_then(Value::as_u64) else {
            continue;
        };
        let modalities = row
            .get("architecture")
            .and_then(Value::as_object)
            .and_then(|architecture| architecture.get("input_modalities"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|item| matches!(*item, "image" | "file" | "audio"))
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !readable_model(id, name, context_length) {
            continue;
        }
        let reasoning = row.get("reasoning").and_then(Value::as_object);
        let efforts = reasoning
            .and_then(|reasoning| reasoning.get("supported_efforts"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|item| valid_effort(item))
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let efforts = if efforts.is_empty()
            && row
                .get("supported_parameters")
                .and_then(Value::as_array)
                .is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item.as_str() == Some("reasoning_effort"))
                }) {
            vec!["low".into(), "medium".into(), "high".into()]
        } else {
            efforts
        };
        let prompt = micro_usd_per_mtok(pricing.get("prompt"));
        let completion = micro_usd_per_mtok(pricing.get("completion"));
        models.push(CatalogModel {
            id: id.into(),
            name: name.into(),
            context_length,
            input_modalities: modalities,
            reasoning_efforts: efforts,
            reasoning_mandatory: reasoning
                .and_then(|item| item.get("mandatory"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            free: is_zero_price(pricing.get("prompt")) && is_zero_price(pricing.get("completion")),
            prompt_micro_usd_per_mtok: prompt,
            completion_micro_usd_per_mtok: completion,
        });
    }
    if models.is_empty() {
        return Err(ProviderError::Decode {
            endpoint: OPENROUTER_MODELS_URL.into(),
            message: "the catalog has no tool-capable models".into(),
        });
    }
    models.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(Catalog {
        selected_model: None,
        models,
    })
}

pub fn parse_provider_models(body: &[u8], endpoint: &str) -> ProviderResult<Vec<String>> {
    let value: Value =
        serde_json::from_slice(body).map_err(|_| decode_error(endpoint, "response is not JSON"))?;
    let rows = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| decode_error(endpoint, "response has no model list"))?;
    Ok(rows
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .filter(|id| {
            !id.trim().is_empty()
                && id.chars().count() <= 128
                && id.chars().all(|character| !character.is_control())
        })
        .take(MAX_PROVIDER_MODELS)
        .map(str::to_owned)
        .collect())
}

pub fn parse_tool_probe(body: &[u8], endpoint: &str) -> ProviderResult<bool> {
    let value: Value =
        serde_json::from_slice(body).map_err(|_| decode_error(endpoint, "response is not JSON"))?;
    Ok(value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("tool_calls"))
        .and_then(Value::as_array)
        .is_some_and(|calls| !calls.is_empty()))
}

pub fn parse_openrouter_balance(body: &[u8]) -> ProviderResult<KeyBalance> {
    let value: Value = serde_json::from_slice(body)
        .map_err(|_| decode_error(OPENROUTER_KEY_URL, "response is not JSON"))?;
    let data = value.get("data").and_then(Value::as_object);
    Ok(KeyBalance {
        keyed: true,
        free_tier: data
            .and_then(|item| item.get("is_free_tier"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        remaining: data
            .and_then(|item| item.get("limit_remaining"))
            .and_then(number),
        usage: data
            .and_then(|item| item.get("usage"))
            .and_then(number)
            .unwrap_or(0.),
        error: String::new(),
        currency: None,
    })
}

pub fn parse_deepseek_balance(body: &[u8]) -> ProviderResult<KeyBalance> {
    let value: Value = serde_json::from_slice(body)
        .map_err(|_| decode_error(DEEPSEEK_BALANCE_URL, "response is not JSON"))?;
    let infos = value
        .get("balance_infos")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let selected = infos
        .iter()
        .find(|item| item.get("currency").and_then(Value::as_str) == Some("USD"))
        .or_else(|| infos.first());
    let remaining = selected
        .and_then(|item| item.get("total_balance"))
        .and_then(number);
    let currency = selected
        .and_then(|item| item.get("currency"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let unavailable = value.get("is_available").and_then(Value::as_bool) == Some(false)
        && remaining.unwrap_or(0.) <= 0.;
    Ok(KeyBalance {
        keyed: true,
        free_tier: false,
        remaining,
        usage: 0.,
        error: if unavailable {
            "DeepSeek reports this key cannot be used.".into()
        } else {
            String::new()
        },
        currency,
    })
}

pub fn validate_catalog(catalog: &Catalog) -> ProviderResult<()> {
    if catalog.models.is_empty() || catalog.models.len() > MAX_CATALOG_MODELS {
        return Err(ProviderError::Invalid {
            field: "models",
            message: "catalog model count is outside its bounds".into(),
        });
    }
    let mut ids = Vec::with_capacity(catalog.models.len());
    for model in &catalog.models {
        if !readable_model(&model.id, &model.name, model.context_length) {
            return Err(invalid("model", "catalog model metadata is invalid"));
        }
        if model
            .input_modalities
            .iter()
            .any(|item| !matches!(item.as_str(), "image" | "file" | "audio"))
        {
            return Err(invalid("model", "catalog modality is invalid"));
        }
        if ids.iter().any(|id| id == &model.id) {
            return Err(ProviderError::Duplicate {
                kind: "catalog model",
                id: model.id.clone(),
            });
        }
        ids.push(model.id.clone());
    }
    Ok(())
}

fn split_http_url(value: &str) -> ProviderResult<(&'static str, String, String, String)> {
    let value = value.trim();
    if value.is_empty()
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(invalid("baseUrl", "must be an http or https URL"));
    }
    let (scheme, rest) = if let Some(rest) = value.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = value.strip_prefix("http://") {
        ("http", rest)
    } else if let Some(rest) = value.strip_prefix("HTTPS://") {
        ("https", rest)
    } else if let Some(rest) = value.strip_prefix("HTTP://") {
        ("http", rest)
    } else {
        return Err(invalid("baseUrl", "must be an http or https URL"));
    };
    if rest.contains('@') || rest.contains('?') || rest.contains('#') {
        return Err(invalid(
            "baseUrl",
            "credentials, queries, and fragments are not allowed",
        ));
    }
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let path = &rest[authority_end..];
    if authority.is_empty() {
        return Err(invalid("baseUrl", "must include a host"));
    }
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        let Some(end) = stripped.find(']') else {
            return Err(invalid("baseUrl", "the IPv6 host is invalid"));
        };
        stripped[..end].to_ascii_lowercase()
    } else {
        authority
            .split(':')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
    };
    if host.is_empty()
        || host
            .chars()
            .any(|character| !(character.is_ascii_alphanumeric() || ".-_:%".contains(character)))
    {
        return Err(invalid("baseUrl", "the host is invalid"));
    }
    let port = if authority.starts_with('[') {
        authority
            .split_once(']')
            .and_then(|(_, suffix)| suffix.strip_prefix(':'))
    } else {
        authority.split_once(':').map(|(_, port)| port)
    };
    if port.is_some_and(|port| port.is_empty() || port.parse::<u16>().is_err()) {
        return Err(invalid("baseUrl", "the port is invalid"));
    }
    let normalized_authority = if authority.starts_with('[') {
        format!(
            "[{}]{}",
            host,
            port.map_or(String::new(), |port| format!(":{port}"))
        )
    } else {
        format!(
            "{host}{}",
            port.map_or(String::new(), |port| format!(":{port}"))
        )
    };
    Ok((scheme, host, normalized_authority, path.into()))
}

fn validate_http_url(value: &str, insecure: bool) -> ProviderResult<()> {
    let (scheme, host, _, _) = split_http_url(value)?;
    if scheme == "http" && !is_loopback_host(&host) && !(insecure && is_private_host(&host)) {
        return Err(invalid(
            "endpoint",
            "plain http is not allowed for this host",
        ));
    }
    Ok(())
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1"
}

fn is_private_host(host: &str) -> bool {
    if host.ends_with(".local") && host.len() > 6 {
        return host[..host.len() - 6].split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        });
    }
    let parts = host.split('.').collect::<Vec<_>>();
    if parts.len() != 4 || parts.iter().any(|part| part.parse::<u8>().is_err()) {
        return false;
    }
    let first = parts[0].parse::<u8>().unwrap_or_default();
    let second = parts[1].parse::<u8>().unwrap_or_default();
    first == 10
        || first == 192 && second == 168
        || first == 172 && (16..=31).contains(&second)
        || first == 100 && (64..=127).contains(&second)
        || first == 127
}

fn readable_model(id: &str, name: &str, context_length: u64) -> bool {
    !id.is_empty()
        && id.chars().count() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:/".contains(&byte))
        && !name.trim().is_empty()
        && name.chars().count() <= 256
        && name.chars().all(|character| !character.is_control())
        && (1..=MAX_CONTEXT_WINDOW).contains(&context_length)
}

fn valid_id(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_effort(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= 32
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
}

fn micro_usd_per_mtok(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.)
        .map(|value| (value * 1e12).round() as u64)
        .unwrap_or(0)
}

fn is_zero_price(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .is_some_and(|value| value.is_finite() && value == 0.)
}

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|value| value.parse::<f64>().ok()))
        .filter(|value| value.is_finite())
}

fn blank_balance(keyed: bool) -> KeyBalance {
    KeyBalance {
        keyed,
        free_tier: false,
        remaining: None,
        usage: 0.,
        error: String::new(),
        currency: None,
    }
}

fn curl_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn invalid(field: &'static str, message: &str) -> ProviderError {
    ProviderError::Invalid {
        field,
        message: message.into(),
    }
}

fn decode_error(endpoint: &str, message: &str) -> ProviderError {
    ProviderError::Decode {
        endpoint: endpoint.into(),
        message: message.into(),
    }
}

struct ProcessOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
}

fn run_process(
    program: &'static str,
    args: &[OsString],
    input: Option<&[u8]>,
    timeout: Duration,
) -> ProviderResult<ProcessOutput> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            ProviderError::Process {
                program,
                message: String::from("is not installed"),
            }
        } else {
            ProviderError::Process {
                program,
                message: String::from("could not start"),
            }
        }
    })?;
    if let Some(input) = input {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(input).map_err(|_| ProviderError::Process {
                program,
                message: String::from("could not send the request"),
            })?;
        }
    }
    let stdout = child.stdout.take().ok_or_else(|| ProviderError::Process {
        program,
        message: String::from("stdout was unavailable"),
    })?;
    let stderr = child.stderr.take().ok_or_else(|| ProviderError::Process {
        program,
        message: String::from("stderr was unavailable"),
    })?;
    let out_thread = thread::spawn(|| read_bounded(stdout, MAX_CATALOG_BYTES));
    let err_thread = thread::spawn(|| read_bounded(stderr, 16 * 1024));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ProviderError::TimedOut { program });
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                return Err(ProviderError::Process {
                    program,
                    message: String::from("could not read process status"),
                });
            }
        }
    };
    let stdout = out_thread.join().map_err(|_| ProviderError::Process {
        program,
        message: String::from("stdout reader failed"),
    })?;
    err_thread.join().map_err(|_| ProviderError::Process {
        program,
        message: String::from("stderr reader failed"),
    })?;
    Ok(ProcessOutput { status, stdout })
}

fn read_bounded<R: Read>(mut reader: R, limit: usize) -> Vec<u8> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => {
                if output.len() < limit {
                    output.extend_from_slice(&buffer[..length.min(limit - output.len())]);
                }
            }
            Err(_) => break,
        }
    }
    output
}

#[cfg(target_os = "macos")]
fn run_security(args: &[OsString], timeout: Duration) -> ProviderResult<ProcessOutput> {
    run_process("/usr/bin/security", args, None, timeout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preferences::PreferenceStore;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root(label: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "emma-providers-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn endpoints_match_electron_trust_boundary() {
        assert_eq!(
            provider_reach("https://api.deepseek.com"),
            ProviderReach::Internet
        );
        assert_eq!(
            provider_reach("http://127.0.0.1:8080/v1"),
            ProviderReach::ThisMac
        );
        assert_eq!(provider_reach("http://10.0.0.4/v1"), ProviderReach::Network);
        assert!(normalize_provider_endpoint("http://10.0.0.4/v1", false).is_err());
        assert_eq!(
            normalize_provider_endpoint("https://api.deepseek.com/", false).unwrap(),
            "https://api.deepseek.com"
        );
        assert!(normalize_provider_endpoint("https://user:pass@example.com", false).is_err());
        assert!(normalize_provider_endpoint("https://example.com/?token=x", false).is_err());
    }

    #[test]
    fn provider_profiles_round_trip_with_exact_wire_names() {
        let profile = ProviderProfile {
            id: "deepseek".into(),
            name: "DeepSeek".into(),
            model_id: "deepseek-chat".into(),
            base_url: "https://api.deepseek.com/".into(),
            credential_env: "DEEPSEEK_API_KEY".into(),
            context_window: 64_000,
            insecure: false,
        };
        let value = serde_json::to_value(validate_profile(&profile).unwrap()).unwrap();
        assert_eq!(value["modelId"], "deepseek-chat");
        assert_eq!(value["baseUrl"], "https://api.deepseek.com");
        assert_eq!(value["credentialEnv"], "DEEPSEEK_API_KEY");
    }

    #[test]
    fn openrouter_catalog_filters_toolless_rows_and_reads_prices() {
        let body = json!({"data": [
            {"id":"maker/model","name":"Maker Model","context_length":8192,"architecture":{"input_modalities":["text","image"]},"supported_parameters":["tools"],"pricing":{"prompt":"0.000001","completion":"0"}},
            {"id":"maker/no-tools","name":"No Tools","context_length":8192,"architecture":{"input_modalities":["text"]},"supported_parameters":[],"pricing":{"prompt":"0","completion":"0"}}
        ]});
        let catalog = parse_openrouter_catalog(body.to_string().as_bytes()).unwrap();
        assert_eq!(catalog.models.len(), 1);
        assert_eq!(catalog.models[0].prompt_micro_usd_per_mtok, 1_000_000);
        assert_eq!(catalog.models[0].completion_micro_usd_per_mtok, 0);
        assert_eq!(catalog.models[0].input_modalities, ["image"]);
    }

    #[test]
    fn balance_shapes_match_openrouter_and_deepseek_wire() {
        let openrouter = parse_openrouter_balance(
            br#"{"data":{"is_free_tier":true,"limit_remaining":3.5,"usage":1.25}}"#,
        )
        .unwrap();
        assert_eq!(
            openrouter,
            KeyBalance {
                keyed: true,
                free_tier: true,
                remaining: Some(3.5),
                usage: 1.25,
                error: String::new(),
                currency: None
            }
        );
        let deepseek = parse_deepseek_balance(br#"{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"10"},{"currency":"USD","total_balance":"2.25"}]}"#).unwrap();
        assert_eq!(deepseek.remaining, Some(2.25));
        assert_eq!(deepseek.currency.as_deref(), Some("USD"));
    }

    #[test]
    fn secrets_are_trimmed_validated_and_redacted() {
        let secret = validate_secret("  sk-1234567890  ").unwrap();
        assert_eq!(secret, "sk-1234567890");
        assert_eq!(mask_secret(&secret), "sk-123••••••••••7890");
        assert!(validate_secret("line\nfeed").is_err());
        assert!(validate_secret(&"x".repeat(MAX_SECRET_CHARS + 1)).is_err());
    }

    #[test]
    fn provider_profiles_persist_inside_settings_without_dropping_other_fields() {
        let root = temp_root("profiles");
        let preferences = PreferenceStore::new(&root);
        let services = ProviderServices::new(preferences);
        let profile = ProviderProfile {
            id: "p-deepseek".into(),
            name: "DeepSeek".into(),
            model_id: "deepseek-chat".into(),
            base_url: "https://api.deepseek.com".into(),
            credential_env: "DEEPSEEK_API_KEY".into(),
            context_window: 0,
            insecure: false,
        };
        let mut settings = crate::preferences::default_settings_value();
        settings["accent"] = json!("teal");
        services.preferences().write_settings(&settings).unwrap();
        services.save_profiles(&[profile.clone()]).unwrap();
        assert_eq!(services.load_profiles().unwrap(), [profile]);
        let persisted = services
            .preferences()
            .read_settings_or_default(None)
            .unwrap();
        assert_eq!(persisted["accent"], "teal");
        std::fs::remove_dir_all(root).unwrap();
    }
}
