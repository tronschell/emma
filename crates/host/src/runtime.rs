use std::{
    collections::HashMap,
    env,
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    time::Instant,
};

use emma_core::{
    AgentAnalysis, AgentMessage, AgentRequest, AgentResponse, AgentSource, LiveClient, LiveError,
    OpenRouterCatalog, OpenRouterModel, Thread, ThreadId, ThreadRole, start_live_runtime,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

const MAX_SIDECAR_TITLE_BYTES: usize = 256;
const MAX_SIDECAR_MESSAGES: usize = 256;
const MAX_SIDECAR_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_SIDECAR_HISTORY_BYTES: usize = 96 * 1024;
const MAX_OPENROUTER_MODELS: usize = 64;
const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
const OPENROUTER_CREDENTIAL_ENV: &str = "OPENROUTER_API_KEY";

pub fn start() -> Result<LiveClient, LiveError> {
    let data_root = match env::var_os("EMMA_DATA_DIR") {
        Some(path) => PathBuf::from(path),
        None => default_data_root()?,
    };
    let agent_path = env::var_os("EMMA_AGENT_BIN").map_or_else(default_agent_path, PathBuf::from);
    let mut sidecar = Sidecar::new(agent_path, provider_config()?);
    start_live_runtime(
        data_root.join("threads"),
        data_root.join("knowledge"),
        data_root.join("scheduled"),
        move |request| sidecar.call(request),
    )
}

fn provider_config() -> Result<Option<ProviderConfig>, LiveError> {
    provider_config_from_values(
        optional_env("EMMA_PROVIDER_BASE_URL")?,
        optional_env("EMMA_PROVIDER_MODEL")?,
        optional_env("EMMA_PROVIDER_CREDENTIAL_ENV")?,
    )
}

fn optional_env(name: &str) -> Result<Option<String>, LiveError> {
    match env::var(name) {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) => Err(LiveError::new(format!("{name} must not be empty"))),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => {
            Err(LiveError::new(format!("{name} must be valid Unicode")))
        }
    }
}

fn provider_config_from_values(
    base_url: Option<String>,
    model: Option<String>,
    credential_env: Option<String>,
) -> Result<Option<ProviderConfig>, LiveError> {
    match (base_url, model, credential_env) {
        (None, None, None) => Ok(None),
        (Some(base_url), Some(model), Some(credential_env)) => Ok(Some(ProviderConfig {
            protect_data: is_openrouter_base_url(&base_url),
            base_url,
            model,
            credential_env,
        })),
        _ => Err(LiveError::new(
            "set all of EMMA_PROVIDER_BASE_URL, EMMA_PROVIDER_MODEL, and EMMA_PROVIDER_CREDENTIAL_ENV",
        )),
    }
}

fn default_data_root() -> Result<PathBuf, LiveError> {
    let home = env::var_os("HOME")
        .ok_or_else(|| LiveError::new("HOME is unset; set EMMA_DATA_DIR to a writable folder"))?;
    Ok(PathBuf::from(home).join("Library/Application Support/Emma"))
}

fn default_agent_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../agent/zig-out/bin/emma-agent")
}

struct Sidecar {
    path: PathBuf,
    provider: Option<ProviderConfig>,
    io: Option<SidecarIo>,
    thread_ids: HashMap<ThreadId, String>,
    openrouter_models: Vec<OpenRouterModel>,
    next_request_id: u64,
}

impl Sidecar {
    fn new(path: PathBuf, provider: Option<ProviderConfig>) -> Self {
        Self {
            path,
            provider,
            io: None,
            thread_ids: HashMap::new(),
            openrouter_models: Vec::new(),
            next_request_id: 1,
        }
    }

    fn call(&mut self, request: AgentRequest) -> Result<AgentResponse, LiveError> {
        match request {
            AgentRequest::ThreadMessage {
                mut thread,
                content,
                knowledge,
            } => {
                if thread.messages.last().is_some_and(|message| {
                    message.role == ThreadRole::User && message.content == content
                }) {
                    thread.messages.pop();
                }
                let thread_id = self.sidecar_thread(&thread)?;
                let id = self.request_id();
                let provider = self.provider.clone();
                let knowledge = knowledge
                    .iter()
                    .map(|page| WireKnowledgePage {
                        id: &page.id,
                        title: &page.title,
                        summary: &page.summary,
                        body: &page.body,
                    })
                    .collect::<Vec<_>>();
                let request = ThreadMessageRequest {
                    id: &id,
                    kind: "thread_message",
                    thread_id: &thread_id,
                    content: &content,
                    knowledge: &knowledge,
                    provider: provider.as_ref(),
                };
                let started = Instant::now();
                let response: ThreadMessageResult = self.exchange(&id, &request)?;
                Ok(AgentResponse::Message(AgentMessage {
                    content: response.message.content,
                    model: response.model,
                    input_tokens: response.input_tokens,
                    output_tokens: response.output_tokens,
                    duration_milliseconds: started
                        .elapsed()
                        .as_millis()
                        .max(1)
                        .try_into()
                        .unwrap_or(u64::MAX),
                }))
            }
            AgentRequest::Analyze { thread, text } => {
                let thread_id = self.sidecar_thread(&thread)?;
                let id = self.request_id();
                let request = AnalyzeRequest {
                    id: &id,
                    kind: "analyze",
                    thread_id: &thread_id,
                    text: bounded_prefix(&text, MAX_SIDECAR_MESSAGE_BYTES),
                    sources: &[],
                };
                let response: AnalyzeResult = self.exchange(&id, &request)?;
                if response.destination != "knowledge" {
                    return Err(LiveError::new(format!(
                        "agent returned unexpected destination {:?}",
                        response.destination
                    )));
                }
                let artifact = response.artifact;
                let mut sections = Vec::new();
                if !artifact.interesting_points.is_empty() {
                    sections.push(format!(
                        "Interesting points\n\n{}",
                        bullets(&artifact.interesting_points)
                    ));
                }
                if !artifact.counterarguments.is_empty() {
                    sections.push(format!(
                        "Counterarguments\n\n{}",
                        bullets(&artifact.counterarguments)
                    ));
                }
                let body = if sections.is_empty() {
                    artifact.summary.clone()
                } else {
                    sections.join("\n\n")
                };
                let sources = artifact
                    .cited_sources
                    .into_iter()
                    .map(|url| AgentSource {
                        title: url.clone(),
                        url,
                    })
                    .collect();
                Ok(AgentResponse::Analysis(AgentAnalysis {
                    title: artifact.title,
                    category: artifact.category,
                    summary: artifact.summary,
                    body,
                    sources,
                    model: artifact.model,
                    input_tokens: artifact.input_tokens,
                    output_tokens: artifact.output_tokens,
                    subagent_count: artifact.subagent_count,
                }))
            }
            AgentRequest::ListOpenRouterModels => self
                .list_openrouter_models()
                .map(AgentResponse::OpenRouterCatalog),
            AgentRequest::SelectOpenRouterModel { model_id } => self
                .select_openrouter_model(model_id)
                .map(AgentResponse::OpenRouterModelSelected),
            AgentRequest::SelectLocalModel {
                base_url,
                model_id,
                credential_env,
            } => self
                .select_local_model(base_url, model_id, credential_env)
                .map(AgentResponse::LocalModelSelected),
            AgentRequest::SelectFallbackModel => {
                self.provider = None;
                Ok(AgentResponse::FallbackModelSelected)
            }
        }
    }

    fn list_openrouter_models(&mut self) -> Result<OpenRouterCatalog, LiveError> {
        let id = self.request_id();
        let mut provider = ProviderConfig::openrouter("openrouter/free");
        if let Some(configured) = self
            .provider
            .as_ref()
            .filter(|provider| provider.is_openrouter())
        {
            provider
                .credential_env
                .clone_from(&configured.credential_env);
        }
        let request = OpenRouterModelsRequest {
            id: &id,
            kind: "openrouter_models",
            provider: &provider,
        };
        let response: OpenRouterModelsResult = self.exchange(&id, &request)?;
        if response.models.len() > MAX_OPENROUTER_MODELS {
            return Err(LiveError::new(
                "OpenRouter returned more free models than Emma accepts",
            ));
        }
        let mut models = Vec::with_capacity(response.models.len());
        for model in response.models {
            validate_openrouter_model(&model)?;
            if models
                .iter()
                .any(|existing: &OpenRouterModel| existing.id == model.id)
            {
                return Err(LiveError::new(
                    "OpenRouter returned a duplicate free model ID",
                ));
            }
            models.push(OpenRouterModel {
                id: model.id,
                name: model.name,
                context_length: model.context_length,
            });
        }
        models.sort_by(|left, right| left.name.cmp(&right.name));
        self.openrouter_models.clone_from(&models);
        Ok(OpenRouterCatalog {
            selected_model: self
                .provider
                .as_ref()
                .and_then(|provider| provider.is_openrouter().then(|| provider.model.clone())),
            models,
        })
    }

    fn select_openrouter_model(&mut self, model_id: String) -> Result<String, LiveError> {
        if !self
            .openrouter_models
            .iter()
            .any(|model| model.id == model_id)
        {
            return Err(LiveError::new(
                "reload the OpenRouter catalog before selecting that model",
            ));
        }
        if let Some(provider) = self
            .provider
            .as_mut()
            .filter(|provider| provider.is_openrouter())
        {
            provider.model.clone_from(&model_id);
            provider.protect_data = true;
        } else {
            self.provider = Some(ProviderConfig::openrouter(model_id.clone()));
        }
        Ok(model_id)
    }

    fn select_local_model(
        &mut self,
        base_url: String,
        model_id: String,
        credential_env: String,
    ) -> Result<String, LiveError> {
        let provider = ProviderConfig::local(base_url, model_id, credential_env)?;
        let model_id = provider.model.clone();
        self.provider = Some(provider);
        Ok(model_id)
    }

    fn sidecar_thread(&mut self, thread: &Thread) -> Result<String, LiveError> {
        if let Some(id) = self.thread_ids.get(&thread.id) {
            return Ok(id.clone());
        }
        let id = self.request_id();
        let messages = sidecar_messages(thread);
        let request = ThreadCreateRequest {
            id: &id,
            kind: "thread_create",
            title: bounded_prefix(&thread.title, MAX_SIDECAR_TITLE_BYTES),
            messages: &messages,
        };
        let response: ThreadSummary = self.exchange(&id, &request)?;
        self.thread_ids
            .insert(thread.id.clone(), response.id.clone());
        Ok(response.id)
    }

    fn request_id(&mut self) -> String {
        let id = format!("host-{}", self.next_request_id);
        self.next_request_id += 1;
        id
    }

    fn exchange<Q, R>(&mut self, request_id: &str, request: &Q) -> Result<R, LiveError>
    where
        Q: Serialize,
        R: DeserializeOwned,
    {
        let result = exchange_once(self.io()?, request_id, request);
        if result.is_err() {
            self.io = None;
            self.thread_ids.clear();
        }
        result
    }

    fn io(&mut self) -> Result<&mut SidecarIo, LiveError> {
        if self.io.is_none() {
            self.io = Some(SidecarIo::spawn(&self.path)?);
        }
        Ok(self.io.as_mut().expect("sidecar initialized"))
    }
}

fn sidecar_messages(thread: &Thread) -> Vec<ImportedMessage<'_>> {
    let mut remaining = MAX_SIDECAR_HISTORY_BYTES;
    let mut messages = Vec::new();
    for message in thread.messages.iter().rev().take(MAX_SIDECAR_MESSAGES) {
        let content = bounded_suffix(&message.content, remaining.min(MAX_SIDECAR_MESSAGE_BYTES));
        if content.is_empty() {
            break;
        }
        remaining -= content.len();
        messages.push(ImportedMessage {
            role: match message.role {
                ThreadRole::User => "user",
                ThreadRole::Assistant => "assistant",
                ThreadRole::System => "system",
            },
            content,
        });
        if remaining == 0 {
            break;
        }
    }
    messages.reverse();
    messages
}

fn bounded_prefix(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn bounded_suffix(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut start = value.len() - max_bytes;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

#[derive(Clone, Serialize)]
struct ProviderConfig {
    base_url: String,
    model: String,
    credential_env: String,
    protect_data: bool,
}

impl ProviderConfig {
    fn openrouter(model: impl Into<String>) -> Self {
        Self {
            base_url: OPENROUTER_BASE_URL.into(),
            model: model.into(),
            credential_env: OPENROUTER_CREDENTIAL_ENV.into(),
            protect_data: true,
        }
    }

    fn is_openrouter(&self) -> bool {
        is_openrouter_base_url(&self.base_url)
    }

    fn local(base_url: String, model: String, credential_env: String) -> Result<Self, LiveError> {
        if !is_local_base_url(&base_url)
            || model.trim().is_empty()
            || model.len() > 128
            || (!credential_env.is_empty() && !valid_env_name(&credential_env))
        {
            return Err(LiveError::new(
                "local models must use an HTTP localhost endpoint and a model ID; credentials are optional but the environment variable name must be valid",
            ));
        }
        Ok(Self {
            base_url,
            model,
            credential_env,
            protect_data: false,
        })
    }
}

fn is_openrouter_base_url(base_url: &str) -> bool {
    let base_url = base_url.trim_end_matches('/');
    [
        "https://openrouter.ai/api/v1",
        "https://eu.openrouter.ai/api/v1",
        "https://us.openrouter.ai/api/v1",
    ]
    .iter()
    .any(|known| base_url.eq_ignore_ascii_case(known))
}

fn is_local_base_url(base_url: &str) -> bool {
    let normalized = base_url.to_ascii_lowercase();
    let Some(rest) = normalized.strip_prefix("http://") else {
        return false;
    };
    if rest.is_empty()
        || ['@', '?', '#']
            .iter()
            .any(|character| rest.contains(*character))
        || rest.chars().any(char::is_control)
    {
        return false;
    }
    let authority = rest.split('/').next().unwrap_or_default();
    let host = authority
        .strip_prefix('[')
        .and_then(|value| value.split_once(']'))
        .map_or(
            authority.split(':').next().unwrap_or_default(),
            |(host, _)| host,
        );
    matches!(host, "localhost" | "localhost." | "127.0.0.1" | "::1")
}

fn valid_env_name(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some('_' | 'a'..='z' | 'A'..='Z'))
        && chars.all(|char| char == '_' || char.is_ascii_alphanumeric())
}

fn validate_openrouter_model(model: &WireOpenRouterModel) -> Result<(), LiveError> {
    let valid_id = model.id.len() <= 128
        && model.id.split_once('/').is_some_and(|(author, slug)| {
            !author.is_empty()
                && !slug.is_empty()
                && !slug.contains('/')
                && model.id.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/' | b':')
                })
        })
        && (model.id.ends_with(":free") || model.id == "openrouter/free");
    if !valid_id
        || model.name.trim().is_empty()
        || model.name.len() > 256
        || model.name.chars().any(char::is_control)
        || !(1..=100_000_000).contains(&model.context_length)
    {
        return Err(LiveError::new(
            "OpenRouter returned invalid free model metadata",
        ));
    }
    Ok(())
}

fn bullets(items: &[String]) -> String {
    items
        .iter()
        .map(|item| format!("- {item}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn exchange_once<Q, R>(io: &mut SidecarIo, request_id: &str, request: &Q) -> Result<R, LiveError>
where
    Q: Serialize,
    R: DeserializeOwned,
{
    serde_json::to_writer(&mut io.stdin, request)
        .map_err(|error| LiveError::new(format!("could not encode agent request: {error}")))?;
    io.stdin
        .write_all(b"\n")
        .and_then(|()| io.stdin.flush())
        .map_err(|error| LiveError::new(format!("could not write to Emma agent: {error}")))?;

    const MAX_RESPONSE_BYTES: u64 = 256 * 1024;
    let mut line = String::new();
    let read = (&mut io.stdout)
        .take(MAX_RESPONSE_BYTES + 1)
        .read_line(&mut line)
        .map_err(|error| LiveError::new(format!("could not read from Emma agent: {error}")))?;
    if read == 0 {
        let status = io
            .child
            .try_wait()
            .ok()
            .flatten()
            .map_or_else(|| "without a status".into(), |status| status.to_string());
        return Err(LiveError::new(format!(
            "Emma agent exited {status}; rebuild it with `zig build --build-file agent/build.zig`"
        )));
    }
    if read as u64 > MAX_RESPONSE_BYTES || !line.ends_with('\n') {
        return Err(LiveError::new(
            "Emma agent response exceeded 256 KiB or was not newline terminated",
        ));
    }
    let envelope: Envelope<R> = serde_json::from_str(&line)
        .map_err(|error| LiveError::new(format!("Emma agent returned invalid JSON: {error}")))?;
    if envelope.id.as_deref() != Some(request_id) {
        return Err(LiveError::new(
            "Emma agent response ID did not match the request",
        ));
    }
    if envelope.ok {
        envelope
            .result
            .ok_or_else(|| LiveError::new("Emma agent omitted a successful result"))
    } else if let Some(error) = envelope.error {
        Err(LiveError::new(format!(
            "Emma agent {}: {}",
            error.code, error.message
        )))
    } else {
        Err(LiveError::new("Emma agent returned an unspecified error"))
    }
}

struct SidecarIo {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl SidecarIo {
    fn spawn(path: &PathBuf) -> Result<Self, LiveError> {
        let mut child = Command::new(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| {
                LiveError::new(format!(
                    "could not start Emma agent at {}: {error}; build it with `zig build --build-file agent/build.zig` or set EMMA_AGENT_BIN",
                    path.display()
                ))
            })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| LiveError::new("Emma agent stdin was unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| LiveError::new("Emma agent stdout was unavailable"))?;
        Ok(Self {
            child,
            stdin: BufWriter::new(stdin),
            stdout: BufReader::new(stdout),
        })
    }
}

impl Drop for SidecarIo {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Serialize)]
struct ThreadCreateRequest<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    title: &'a str,
    messages: &'a [ImportedMessage<'a>],
}

#[derive(Serialize)]
struct ImportedMessage<'a> {
    role: &'static str,
    content: &'a str,
}

#[derive(Serialize)]
struct ThreadMessageRequest<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    thread_id: &'a str,
    content: &'a str,
    knowledge: &'a [WireKnowledgePage<'a>],
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<&'a ProviderConfig>,
}

#[derive(Serialize)]
struct WireKnowledgePage<'a> {
    id: &'a str,
    title: &'a str,
    summary: &'a str,
    body: &'a str,
}

#[derive(Serialize)]
struct AnalyzeRequest<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    thread_id: &'a str,
    text: &'a str,
    sources: &'a [&'a str],
}

#[derive(Serialize)]
struct OpenRouterModelsRequest<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    provider: &'a ProviderConfig,
}

#[derive(Deserialize)]
struct Envelope<T> {
    id: Option<String>,
    ok: bool,
    result: Option<T>,
    error: Option<WireError>,
}

#[derive(Deserialize)]
struct WireError {
    code: String,
    message: String,
}

#[derive(Deserialize)]
struct ThreadSummary {
    id: String,
}

#[derive(Deserialize)]
struct OpenRouterModelsResult {
    models: Vec<WireOpenRouterModel>,
}

#[derive(Deserialize)]
struct WireOpenRouterModel {
    id: String,
    name: String,
    context_length: u64,
}

#[derive(Deserialize)]
struct ThreadMessageResult {
    message: WireMessage,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
}

#[derive(Deserialize)]
struct WireMessage {
    content: String,
}

#[derive(Deserialize)]
struct AnalyzeResult {
    destination: String,
    artifact: WireArtifact,
}

#[derive(Deserialize)]
struct WireArtifact {
    title: String,
    category: String,
    summary: String,
    interesting_points: Vec<String>,
    counterarguments: Vec<String>,
    cited_sources: Vec<String>,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    subagent_count: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use emma_core::{ThreadMessage, Timestamp};

    #[test]
    fn provider_profile_is_optional_but_not_partial() {
        assert!(
            provider_config_from_values(None, None, None)
                .unwrap()
                .is_none()
        );
        assert!(
            provider_config_from_values(Some("http://localhost:1234/v1".into()), None, None)
                .is_err()
        );
        let provider = provider_config_from_values(
            Some("https://api.example.test/v1".into()),
            Some("model".into()),
            Some("EMMA_API_KEY".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(provider.credential_env, "EMMA_API_KEY");
        assert!(!provider.protect_data);
        let request = ThreadMessageRequest {
            id: "test",
            kind: "thread_message",
            thread_id: "thread-1",
            content: "hello",
            knowledge: &[],
            provider: Some(&provider),
        };
        let json = serde_json::to_value(request).unwrap();
        assert_eq!(json["provider"]["model"], "model");
        assert_eq!(json["provider"]["credential_env"], "EMMA_API_KEY");

        let openrouter = provider_config_from_values(
            Some("https://openrouter.ai/api/v1/".into()),
            Some("openai/gpt-oss-20b:free".into()),
            Some("OPENROUTER_API_KEY".into()),
        )
        .unwrap()
        .unwrap();
        assert!(openrouter.protect_data);
        assert!(is_openrouter_base_url("https://OPENROUTER.AI/api/v1"));
    }

    #[test]
    fn local_model_profiles_are_loopback_only() {
        let provider = ProviderConfig::local(
            "http://127.0.0.1:1234/v1".into(),
            "qwen".into(),
            "LOCAL_API_KEY".into(),
        )
        .unwrap();
        assert!(!provider.protect_data);
        assert!(
            ProviderConfig::local(
                "https://api.example.test/v1".into(),
                "qwen".into(),
                "LOCAL_API_KEY".into(),
            )
            .is_err()
        );
        assert!(
            ProviderConfig::local(
                "http://localhost.evil/v1".into(),
                "qwen".into(),
                "LOCAL_API_KEY".into(),
            )
            .is_err()
        );
        assert!(
            ProviderConfig::local(
                "http://localhost:1234/v1".into(),
                "qwen".into(),
                "bad-key".into(),
            )
            .is_err()
        );
    }

    #[test]
    fn fallback_selection_clears_the_active_runtime_provider() {
        let mut sidecar = Sidecar::new(
            PathBuf::from("unused"),
            Some(
                ProviderConfig::local("http://localhost:1234/v1".into(), "qwen".into(), "".into())
                    .unwrap(),
            ),
        );

        assert!(matches!(
            sidecar.call(AgentRequest::SelectFallbackModel).unwrap(),
            AgentResponse::FallbackModelSelected
        ));
        assert!(sidecar.provider.is_none());
    }

    #[test]
    fn only_catalogued_free_openrouter_models_can_be_selected() {
        let mut sidecar = Sidecar::new(PathBuf::from("unused"), None);
        assert!(
            sidecar
                .select_openrouter_model("vendor/paid".into())
                .is_err()
        );
        let model = OpenRouterModel {
            id: "openai/gpt-oss-20b:free".into(),
            name: "OpenAI: gpt-oss-20b (free)".into(),
            context_length: 131_072,
        };
        sidecar.openrouter_models.push(model.clone());
        assert_eq!(
            sidecar.select_openrouter_model(model.id.clone()).unwrap(),
            model.id
        );
        let provider = sidecar.provider.unwrap();
        assert!(provider.protect_data);
        assert_eq!(provider.base_url, OPENROUTER_BASE_URL);
        assert_eq!(provider.credential_env, OPENROUTER_CREDENTIAL_ENV);

        let mut regional = Sidecar::new(
            PathBuf::from("unused"),
            Some(ProviderConfig {
                base_url: "https://eu.openrouter.ai/api/v1".into(),
                model: "vendor/old:free".into(),
                credential_env: "EMMA_EU_OPENROUTER_KEY".into(),
                protect_data: true,
            }),
        );
        regional.openrouter_models.push(model.clone());
        regional.select_openrouter_model(model.id).unwrap();
        let provider = regional.provider.unwrap();
        assert_eq!(provider.base_url, "https://eu.openrouter.ai/api/v1");
        assert_eq!(provider.credential_env, "EMMA_EU_OPENROUTER_KEY");

        assert!(
            validate_openrouter_model(&WireOpenRouterModel {
                id: "vendor/model".into(),
                name: "Paid".into(),
                context_length: 1,
            })
            .is_err()
        );
    }

    #[test]
    fn sidecar_rehydration_keeps_a_bounded_recent_history() {
        let mut thread = Thread::new("x".repeat(300), Timestamp::from_unix_seconds(1)).unwrap();
        for index in 0..299 {
            thread
                .push(
                    ThreadMessage::new(
                        ThreadRole::User,
                        format!("{index:03}-{}", "x".repeat(508)),
                        Timestamp::from_unix_seconds(index + 2),
                    )
                    .unwrap(),
                )
                .unwrap();
        }
        thread
            .push(
                ThreadMessage::new(
                    ThreadRole::Assistant,
                    "y".repeat(MAX_SIDECAR_MESSAGE_BYTES + 1),
                    Timestamp::from_unix_seconds(301),
                )
                .unwrap(),
            )
            .unwrap();

        let messages = sidecar_messages(&thread);
        assert!(messages.len() <= MAX_SIDECAR_MESSAGES);
        assert!(
            messages
                .iter()
                .map(|message| message.content.len())
                .sum::<usize>()
                <= MAX_SIDECAR_HISTORY_BYTES
        );
        assert!(
            messages
                .iter()
                .all(|message| message.content.len() <= MAX_SIDECAR_MESSAGE_BYTES)
        );
        assert_eq!(
            messages.last().unwrap().content.len(),
            MAX_SIDECAR_MESSAGE_BYTES
        );
        assert_eq!(
            bounded_prefix(&thread.title, MAX_SIDECAR_TITLE_BYTES).len(),
            256
        );
    }

    #[test]
    fn sidecar_bounds_analysis_prefix_and_history_suffix_on_utf8_boundaries() {
        let analysis = format!("{}tail", "é".repeat(MAX_SIDECAR_MESSAGE_BYTES / 2 + 1));
        let analysis = bounded_prefix(&analysis, MAX_SIDECAR_MESSAGE_BYTES);
        assert!(analysis.len() <= MAX_SIDECAR_MESSAGE_BYTES);
        assert!(analysis.starts_with('é'));
        assert!(!analysis.ends_with("tail"));

        let mut thread = Thread::new("history", Timestamp::from_unix_seconds(1)).unwrap();
        thread
            .push(
                ThreadMessage::new(
                    ThreadRole::User,
                    format!("head-{}-tail", "é".repeat(40_000)),
                    Timestamp::from_unix_seconds(2),
                )
                .unwrap(),
            )
            .unwrap();
        thread
            .push(
                ThreadMessage::new(
                    ThreadRole::Assistant,
                    "z".repeat(MAX_SIDECAR_MESSAGE_BYTES),
                    Timestamp::from_unix_seconds(3),
                )
                .unwrap(),
            )
            .unwrap();

        let messages = sidecar_messages(&thread);
        assert_eq!(messages.len(), 2);
        assert!(messages[0].content.len() <= 32 * 1024);
        assert!(messages[0].content.ends_with("-tail"));
        assert!(!messages[0].content.starts_with("head-"));
    }
}
