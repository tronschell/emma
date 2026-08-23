use std::{
    collections::HashMap,
    env,
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::Arc,
    time::Instant,
};

use emma_core::{
    AgentAnalysis, AgentBlock, AgentMessage, AgentRequest, AgentResponse, AgentSource, AgentTool,
    AgentToolCall, JobSink, LiveClient, LiveError, MAX_AGENT_TOOLS, OpenRouterCatalog,
    OpenRouterModel, Thread, ThreadId, ThreadRole, start_live_runtime,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

const MAX_SIDECAR_TITLE_BYTES: usize = 256;
const MAX_SIDECAR_MESSAGES: usize = 256;
const MAX_SIDECAR_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_SIDECAR_HISTORY_BYTES: usize = 96 * 1024;
const MAX_OPENROUTER_MODELS: usize = 2048;
/// Threads that may be pinned to a model of their own at once — one per subagent
/// a session has spawned, which no real session comes near.
const MAX_PINNED_THREADS: usize = 512;
const MAX_SIDECAR_CATEGORIES: usize = 64;
const MAX_SIDECAR_DOCUMENT_BLOCKS: usize = 64;
/// Mirrors `MAX_AGENT_TOOLS` and the sidecar's own `max_advertised_tools`, both 32.
/// Anything lower silently drops the tail of the table — every tool past the cut
/// is a tool the model is never told it has.
const MAX_SIDECAR_TOOLS: usize = MAX_AGENT_TOOLS;
/// What one response may ask for at once. Mirrors `MAX_CALLS_PER_STEP` in the
/// desktop loop, which refuses a turn carrying more.
const MAX_SIDECAR_TOOL_CALLS: usize = 8;
/// Mirrors core's own description ceiling, which `AgentTool::new` already refuses past.
const MAX_SIDECAR_TOOL_DESCRIPTION_BYTES: usize = 4 * 1024;
const MAX_SIDECAR_TOOL_RESULT_BYTES: usize = 16 * 1024;
const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
const OPENROUTER_CREDENTIAL_ENV: &str = "OPENROUTER_API_KEY";

/// Called with `(thread_id, text)` for each chunk of assistant text the sidecar
/// streams, while the turn that produced it is still in flight. Runs on the live
/// runtime thread, so it must not block on anything the runtime itself drives.
pub type DeltaSink = Arc<dyn Fn(&str, &str) + Send + Sync>;

pub fn start(delta_sink: DeltaSink, job_sink: JobSink) -> Result<LiveClient, LiveError> {
    let data_root = match env::var_os("EMMA_DATA_DIR") {
        Some(path) => PathBuf::from(path),
        None => default_data_root()?,
    };
    let agent_path = env::var_os("EMMA_AGENT_BIN").map_or_else(default_agent_path, PathBuf::from);
    let mut sidecar = Sidecar::new(agent_path, provider_config()?, delta_sink);
    start_live_runtime(
        data_root.join("threads"),
        data_root.join("knowledge"),
        knowledge_export_root(),
        data_root.join("scheduled"),
        data_root.join("research"),
        job_sink,
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
            zero_retention: env::var_os("EMMA_OPENROUTER_ZDR").is_some(),
            base_url,
            model,
            credential_env,
            reasoning_effort: String::new(),
            context_length: 0,
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

/// Where the knowledge base is readable by everything else on this Mac: a plain
/// folder of Markdown, not the app's own storage. `EMMA_KNOWLEDGE_DIR` moves it;
/// an empty value turns the mirror off.
fn knowledge_export_root() -> Option<PathBuf> {
    match env::var_os("EMMA_KNOWLEDGE_DIR") {
        Some(path) if path.is_empty() => None,
        Some(path) => Some(PathBuf::from(path)),
        None => {
            env::var_os("HOME").map(|home| PathBuf::from(home).join("Documents/Emma Knowledge"))
        }
    }
}

fn default_agent_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../agent/zig-out/bin/emma-agent")
}

struct Sidecar {
    path: PathBuf,
    provider: Option<ProviderConfig>,
    io: Option<SidecarIo>,
    thread_ids: HashMap<ThreadId, String>,
    /// Threads pinned to a model of their own — a subagent runs its whole life on
    /// the one its parent chose, whatever the app's selection does meanwhile.
    thread_providers: HashMap<ThreadId, ProviderConfig>,
    openrouter_models: Vec<OpenRouterModel>,
    next_request_id: u64,
    delta_sink: DeltaSink,
    /// The thread whose turn is on the wire. The sidecar tags its deltas with
    /// its own request id, which means nothing outside this process; this is
    /// what turns them into something a window can route. `None` for every
    /// request that is not a model turn, which is what drops their deltas.
    streaming_thread: Option<String>,
}

impl Sidecar {
    fn new(path: PathBuf, provider: Option<ProviderConfig>, delta_sink: DeltaSink) -> Self {
        Self {
            path,
            provider,
            io: None,
            thread_ids: HashMap::new(),
            thread_providers: HashMap::new(),
            openrouter_models: Vec::new(),
            next_request_id: 1,
            delta_sink,
            streaming_thread: None,
        }
    }

    fn call(&mut self, request: AgentRequest) -> Result<AgentResponse, LiveError> {
        // Set once, here, rather than per branch: the turn arms have several
        // early returns each, and a tag left over from a previous request would
        // route the next turn's text to the wrong window.
        self.streaming_thread = match &request {
            AgentRequest::ThreadMessage { thread, .. }
            | AgentRequest::ToolResult { thread, .. } => Some(thread.id.as_str().to_owned()),
            _ => None,
        };
        match request {
            AgentRequest::ThreadMessage {
                mut thread,
                content,
                knowledge,
                screen_context,
                skill_context,
                tools,
            } => {
                if thread.messages.last().is_some_and(|message| {
                    message.role == ThreadRole::User && message.content == content
                }) {
                    thread.messages.pop();
                }
                let knowledge = knowledge
                    .iter()
                    .map(|page| WireKnowledgePage {
                        id: &page.id,
                        title: &page.title,
                        summary: &page.summary,
                        body: &page.body,
                    })
                    .collect::<Vec<_>>();
                let tools = wire_tools(&tools);
                let started = Instant::now();
                let mut failure = None;
                for provider in self.chain_for(&thread.id) {
                    // A failed exchange resets the sidecar, so the thread is re-created per try.
                    let thread_id = self.sidecar_thread(&thread)?;
                    let id = self.request_id();
                    let request = ThreadMessageRequest {
                        id: &id,
                        kind: "thread_message",
                        thread_id: &thread_id,
                        content: &content,
                        knowledge: &knowledge,
                        screen_context: screen_context
                            .as_ref()
                            .map(|context| context.jpeg_data_url.as_str()),
                        skill_context: skill_context
                            .as_ref()
                            .map(|context| context.instructions.as_str()),
                        tools: &tools,
                        provider: provider.as_ref(),
                    };
                    match self.exchange::<_, ThreadMessageResult>(&id, &request) {
                        Ok(response) => return agent_message(response, started),
                        Err(error) => {
                            failure.get_or_insert(error);
                        }
                    }
                }
                Err(failure
                    .unwrap_or_else(|| LiveError::new("no model is selected — pick one from the model menu")))
            }
            AgentRequest::ToolResult {
                thread,
                results,
                screen_context,
                skill_context,
                tools,
            } => {
                let tools = wire_tools(&tools);
                let results = results
                    .iter()
                    .map(|result| WireToolResult {
                        id: &result.id,
                        content: bounded_prefix(&result.content, MAX_SIDECAR_TOOL_RESULT_BYTES),
                    })
                    .collect::<Vec<_>>();
                let started = Instant::now();
                let mut failure = None;
                for provider in self.chain_for(&thread.id) {
                    let thread_id = self.sidecar_thread(&thread)?;
                    let id = self.request_id();
                    let request = ToolResultRequest {
                        id: &id,
                        kind: "thread_tool_result",
                        thread_id: &thread_id,
                        results: &results,
                        screen_context: screen_context
                            .as_ref()
                            .map(|context| context.jpeg_data_url.as_str()),
                        skill_context: skill_context
                            .as_ref()
                            .map(|context| context.instructions.as_str()),
                        tools: &tools,
                        provider: provider.as_ref(),
                    };
                    match self.exchange::<_, ThreadMessageResult>(&id, &request) {
                        Ok(response) => return agent_message(response, started),
                        Err(error) => {
                            failure.get_or_insert(error);
                        }
                    }
                }
                Err(failure
                    .unwrap_or_else(|| LiveError::new("no model is selected — pick one from the model menu")))
            }
            AgentRequest::Analyze {
                thread,
                text,
                categories,
            } => {
                let thread_id = self.sidecar_thread(&thread)?;
                let id = self.request_id();
                let provider = self.provider.clone();
                let categories = categories
                    .iter()
                    .take(MAX_SIDECAR_CATEGORIES)
                    .map(String::as_str)
                    .collect::<Vec<_>>();
                let request = AnalyzeRequest {
                    id: &id,
                    kind: "analyze",
                    thread_id: &thread_id,
                    text: bounded_prefix(&text, MAX_SIDECAR_MESSAGE_BYTES),
                    sources: &[],
                    categories: &categories,
                    provider: provider.as_ref(),
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
                    interesting_points: artifact.interesting_points,
                    counterarguments: artifact.counterarguments,
                    sources,
                    blocks: agent_blocks(artifact.blocks)?,
                    model: artifact.model,
                    input_tokens: artifact.input_tokens,
                    output_tokens: artifact.output_tokens,
                    subagent_count: artifact.subagent_count,
                }))
            }
            AgentRequest::ReviseDocument {
                thread,
                instruction,
                document,
            } => {
                let thread_id = self.sidecar_thread(&thread)?;
                let id = self.request_id();
                let provider = self.provider.clone();
                let document = document
                    .iter()
                    .map(|block| WireBlock {
                        id: block.id.clone(),
                        block_type: block.block_type.clone(),
                        payload: block.payload.clone(),
                        fallback: bounded_prefix(&block.fallback, MAX_SIDECAR_MESSAGE_BYTES)
                            .to_owned(),
                    })
                    .collect::<Vec<_>>();
                let request = ReviseRequest {
                    id: &id,
                    kind: "revise_document",
                    thread_id: &thread_id,
                    instruction: bounded_prefix(&instruction, MAX_SIDECAR_MESSAGE_BYTES),
                    document: &document,
                    provider: provider.as_ref(),
                };
                let response: ReviseResult = self.exchange(&id, &request)?;
                Ok(AgentResponse::Document(agent_blocks(response.blocks)?))
            }
            AgentRequest::ListOpenRouterModels => self
                .list_openrouter_models()
                .map(AgentResponse::OpenRouterCatalog),
            AgentRequest::SelectOpenRouterModel { model_id, effort } => self
                .select_openrouter_model(model_id, effort)
                .map(AgentResponse::OpenRouterModelSelected),
            AgentRequest::SelectLocalModel {
                base_url,
                model_id,
                credential_env,
            } => self
                .select_local_model(base_url, model_id, credential_env)
                .map(AgentResponse::LocalModelSelected),
            AgentRequest::SetThreadModel {
                thread_id,
                model_id,
                effort,
            } => self
                .set_thread_model(thread_id, model_id, effort)
                .map(|()| AgentResponse::ThreadModelSet),
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
        let mut models = accepted_openrouter_models(response.models);
        if models.is_empty() {
            return Err(LiveError::new(
                "OpenRouter listed no models Emma can use — check your connection and try again",
            ));
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

    /// Routes a turn tries in order: the selected model, then Emma's deterministic local reply.
    /// Substituting another vendor's model was worse than no answer — the reply came back in a
    /// different model's voice with nothing on screen saying the route had changed.
    fn fallback_chain(&self) -> Vec<Option<ProviderConfig>> {
        match self.provider.clone() {
            Some(selected) => vec![Some(selected), None],
            None => vec![None],
        }
    }

    /// The same chain for a thread that was pinned to its own model, with that model
    /// in front of the app's selection. A subagent runs where its parent said, and
    /// still falls back to the local reply rather than to another vendor's voice.
    fn chain_for(&self, thread_id: &ThreadId) -> Vec<Option<ProviderConfig>> {
        match self.thread_providers.get(thread_id) {
            Some(pinned) => vec![Some(pinned.clone()), None],
            None => self.fallback_chain(),
        }
    }

    /// Pins one thread to an OpenRouter model, or clears the pin when the ID is empty.
    /// The model and its thinking mode are checked against the catalog exactly as a
    /// whole-app selection is — a route the model would 400 on is refused here.
    fn set_thread_model(
        &mut self,
        thread_id: ThreadId,
        model_id: String,
        effort: String,
    ) -> Result<(), LiveError> {
        if model_id.is_empty() {
            self.thread_providers.remove(&thread_id);
            return Ok(());
        }
        // ponytail: pins are only dropped by being cleared, so the ceiling is what
        // keeps a long-lived host from holding one per subagent it ever ran. Tie them
        // to the thread's life if that ever bites.
        if self.thread_providers.len() >= MAX_PINNED_THREADS
            && !self.thread_providers.contains_key(&thread_id)
        {
            return Err(LiveError::new(
                "Emma is tracking model pins for too many threads — restart Emma to clear them",
            ));
        }
        let mut provider = ProviderConfig::openrouter(model_id);
        provider.reasoning_effort = effort;
        provider.context_length = self.checked_openrouter_route(&provider)?;
        if let Some(configured) = self
            .provider
            .as_ref()
            .filter(|configured| configured.is_openrouter())
        {
            provider.credential_env.clone_from(&configured.credential_env);
            provider.zero_retention = configured.zero_retention;
        }
        self.thread_providers.insert(thread_id, provider);
        Ok(())
    }

    /// The model's context window, once its ID and thinking mode are known to be ones
    /// the catalog published. The same two refusals `select_openrouter_model` makes.
    fn checked_openrouter_route(&self, provider: &ProviderConfig) -> Result<u64, LiveError> {
        let Some(model) = self
            .openrouter_models
            .iter()
            .find(|model| model.id == provider.model)
        else {
            return Err(LiveError::new(
                "Emma's model list is out of date — refresh it in Settings, then pin that model again",
            ));
        };
        match provider.reasoning_effort.as_str() {
            "" => {}
            "off" if !model.reasoning_mandatory => {}
            other if model.reasoning_efforts.iter().any(|value| value == other) => {}
            _ => {
                return Err(LiveError::new(
                    "that model does not offer that thinking mode — pick another mode, or another model",
                ));
            }
        }
        Ok(model.context_length)
    }

    fn select_openrouter_model(
        &mut self,
        model_id: String,
        effort: String,
    ) -> Result<String, LiveError> {
        let Some(model) = self
            .openrouter_models
            .iter()
            .find(|model| model.id == model_id)
        else {
            return Err(LiveError::new(
                "Emma's model list is out of date — refresh it in Settings, then pick that model again",
            ));
        };
        let context_length = model.context_length;
        // A model only takes the efforts it publishes, and a mandatory reasoner cannot be
        // turned off: sending anything else is a 400 the user never asked for.
        let effort = match effort.as_str() {
            "" => String::new(),
            "off" if !model.reasoning_mandatory => effort,
            other if model.reasoning_efforts.iter().any(|value| value == other) => effort,
            _ => {
                return Err(LiveError::new(
                    "that model does not offer that thinking mode — pick another mode, or another model",
                ));
            }
        };
        if let Some(provider) = self
            .provider
            .as_mut()
            .filter(|provider| provider.is_openrouter())
        {
            provider.model.clone_from(&model_id);
            provider.protect_data = true;
            provider.reasoning_effort.clone_from(&effort);
            provider.context_length = context_length;
        } else {
            let mut provider = ProviderConfig::openrouter(model_id.clone());
            provider.reasoning_effort = effort;
            provider.context_length = context_length;
            self.provider = Some(provider);
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
        // Split the borrow: `exchange_once` needs `&mut io` while the sink needs
        // the thread tag, and both live on `self`.
        let sink = self.delta_sink.clone();
        let thread = self.streaming_thread.clone();
        // A fallback attempt starts the reply over, so tell the renderer to drop
        // whatever the failed one streamed. An empty delta means exactly that: a
        // provider never sends one, the sidecar drops it if it does.
        if let Some(thread_id) = thread.as_deref() {
            sink(thread_id, "");
        }
        let io = self.io()?;
        let result = exchange_once(io, request_id, request, &mut |text| {
            if let Some(thread_id) = thread.as_deref() {
                sink(thread_id, text);
            }
        });
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
    zero_retention: bool,
    /// The thinking effort to ask for, from the set the selected model publishes.
    /// Empty leaves the model on its own default.
    #[serde(skip_serializing_if = "String::is_empty")]
    reasoning_effort: String,
    /// The selected model's context window, so the sidecar knows when a thread is 70% of
    /// the way through it and has to be compacted. `0` means unknown — a local model has
    /// no catalog entry — and leaves the sidecar trimming the way it always did.
    context_length: u64,
}

impl ProviderConfig {
    fn openrouter(model: impl Into<String>) -> Self {
        Self {
            base_url: OPENROUTER_BASE_URL.into(),
            model: model.into(),
            credential_env: OPENROUTER_CREDENTIAL_ENV.into(),
            protect_data: true,
            // OpenRouter serves no free endpoint under zero retention, so the desktop app opts in.
            zero_retention: env::var_os("EMMA_OPENROUTER_ZDR").is_some(),
            reasoning_effort: String::new(),
            context_length: 0,
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
            zero_retention: false,
            reasoning_effort: String::new(),
            context_length: 0,
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

/// OpenRouter's reasoning efforts, plus "off" for a request that asks for no thinking at
/// all. Which of these a given model actually takes comes from its catalog entry.
fn is_effort(value: &str) -> bool {
    matches!(
        value,
        "off" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    )
}

fn valid_env_name(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some('_' | 'a'..='z' | 'A'..='Z'))
        && chars.all(|char| char == '_' || char.is_ascii_alphanumeric())
}

/// Whether Emma can publish this row. Nothing here is shown to anyone: a row that
/// fails is simply left out of the catalog.
fn openrouter_model_is_readable(model: &WireOpenRouterModel) -> bool {
    let valid_id = model.id.len() <= 128
        && model.id.split_once('/').is_some_and(|(author, slug)| {
            !author.is_empty()
                && !slug.is_empty()
                && !slug.contains('/')
                && model.id.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/' | b':')
                })
        });
    valid_id
        && !model.name.trim().is_empty()
        && model.name.len() <= 256
        && !model.name.chars().any(char::is_control)
        && (1..=100_000_000).contains(&model.context_length)
        && model
            .input_modalities
            .iter()
            .all(|modality| matches!(modality.as_str(), "image" | "file" | "audio"))
        && model.reasoning_efforts.iter().all(|effort| is_effort(effort))
}

fn bullets(items: &[String]) -> String {
    items
        .iter()
        .map(|item| format!("- {item}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// One line the sidecar may emit before the response: a chunk of assistant text
/// for the request still in flight. `deny_unknown_fields` is what keeps it from
/// swallowing a real envelope, which always carries `ok`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeltaLine {
    id: String,
    delta: String,
}

fn exchange_once<Q, R>(
    io: &mut SidecarIo,
    request_id: &str,
    request: &Q,
    on_delta: &mut dyn FnMut(&str),
) -> Result<R, LiveError>
where
    Q: Serialize,
    R: DeserializeOwned,
{
    serde_json::to_writer(&mut io.stdin, request)
        .map_err(|error| agent_fault(format!("could not encode agent request: {error}")))?;
    io.stdin
        .write_all(b"\n")
        .and_then(|()| io.stdin.flush())
        .map_err(|error| agent_fault(format!("could not write to Emma agent: {error}")))?;

    const MAX_RESPONSE_BYTES: u64 = 256 * 1024;
    let mut line = String::new();
    let envelope: Envelope<R> = loop {
        line.clear();
        let read = (&mut io.stdout)
            .take(MAX_RESPONSE_BYTES + 1)
            .read_line(&mut line)
            .map_err(|error| agent_fault(format!("could not read from Emma agent: {error}")))?;
        if read == 0 {
            let status = io
                .child
                .try_wait()
                .ok()
                .flatten()
                .map_or_else(|| "without a status".into(), |status| status.to_string());
            return Err(agent_fault(format!("Emma agent exited {status}")));
        }
        if read as u64 > MAX_RESPONSE_BYTES || !line.ends_with('\n') {
            return Err(LiveError::new(
                "the reply was too large for Emma to read — ask for a shorter answer, or narrow what the tool returns",
            ));
        }
        // A delta belonging to some other request is a protocol error, not
        // something to pass on: the sidecar answers one request at a time.
        if let Ok(chunk) = serde_json::from_str::<DeltaLine>(&line) {
            if chunk.id != request_id {
                return Err(agent_fault("Emma agent streamed a mismatched request ID"));
            }
            on_delta(&chunk.delta);
            continue;
        }
        break serde_json::from_str(&line)
            .map_err(|error| agent_fault(format!("Emma agent returned invalid JSON: {error}")))?;
    };
    if envelope.id.as_deref() != Some(request_id) {
        return Err(agent_fault("Emma agent response ID did not match the request"));
    }
    if envelope.ok {
        envelope
            .result
            .ok_or_else(|| agent_fault("Emma agent omitted a successful result"))
    } else if let Some(error) = envelope.error {
        // The agent's message is already written for the person reading it; its code is
        // for whoever is reading stderr, and led every provider failure with jargon.
        eprintln!("emma-agent error code: {}", error.code);
        Err(LiveError::new(error.message))
    } else {
        Err(agent_fault("Emma agent returned an unspecified error"))
    }
}

/// OpenRouter's list, narrowed to the rows Emma can publish. A row it cannot read, a
/// repeat of one it already has, and everything past the ceiling are dropped rather
/// than refused: one bad row used to empty the whole model picker and read as if Emma
/// were broken, when every other model on the list was fine.
fn accepted_openrouter_models(wire: Vec<WireOpenRouterModel>) -> Vec<OpenRouterModel> {
    let mut models: Vec<OpenRouterModel> = Vec::with_capacity(wire.len().min(MAX_OPENROUTER_MODELS));
    for model in wire {
        if models.len() == MAX_OPENROUTER_MODELS {
            break;
        }
        if !openrouter_model_is_readable(&model)
            || models.iter().any(|existing| existing.id == model.id)
        {
            continue;
        }
        models.push(OpenRouterModel {
            id: model.id,
            name: model.name,
            context_length: model.context_length,
            input_modalities: model.input_modalities,
            reasoning_efforts: model.reasoning_efforts,
            reasoning_mandatory: model.reasoning_mandatory,
            free: model.free,
            prompt_micro_usd_per_mtok: model.prompt_micro_usd_per_mtok,
            completion_micro_usd_per_mtok: model.completion_micro_usd_per_mtok,
        });
    }
    models
}

/// The sidecar broke its own protocol or died. Which of those it was matters to
/// whoever is reading stderr and to nobody else: every one of them is the same
/// thing to a person mid-sentence, and the same thing to do about it.
fn agent_fault(detail: impl std::fmt::Display) -> LiveError {
    eprintln!("emma-agent fault: {detail}");
    LiveError::new("Emma's agent stopped responding — try again, and restart Emma if it keeps happening")
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
                eprintln!("could not start Emma agent at {}: {error}", path.display());
                LiveError::new(
                    "Emma's agent component would not start — reinstall Emma, or set EMMA_AGENT_BIN if you built it yourself",
                )
            })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| agent_fault("Emma agent stdin was unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| agent_fault("Emma agent stdout was unavailable"))?;
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
    screen_context: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    skill_context: Option<&'a str>,
    #[serde(skip_serializing_if = "no_tools")]
    tools: &'a [WireTool<'a>],
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<&'a ProviderConfig>,
}

#[derive(Serialize)]
struct ToolResultRequest<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    thread_id: &'a str,
    results: &'a [WireToolResult<'a>],
    #[serde(skip_serializing_if = "Option::is_none")]
    screen_context: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    skill_context: Option<&'a str>,
    #[serde(skip_serializing_if = "no_tools")]
    tools: &'a [WireTool<'a>],
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<&'a ProviderConfig>,
}

#[derive(Serialize)]
struct WireTool<'a> {
    name: &'a str,
    description: &'a str,
    input_schema: &'a Value,
}

#[derive(Serialize)]
struct WireToolResult<'a> {
    id: &'a str,
    content: &'a str,
}

fn no_tools(tools: &&[WireTool<'_>]) -> bool {
    tools.is_empty()
}

fn wire_tools(tools: &[AgentTool]) -> Vec<WireTool<'_>> {
    tools
        .iter()
        .take(MAX_SIDECAR_TOOLS)
        .map(|tool| WireTool {
            name: &tool.name,
            description: bounded_prefix(&tool.description, MAX_SIDECAR_TOOL_DESCRIPTION_BYTES),
            input_schema: &tool.input_schema,
        })
        .collect()
}

fn agent_message(
    response: ThreadMessageResult,
    started: Instant,
) -> Result<AgentResponse, LiveError> {
    if response.tool_calls.len() > MAX_SIDECAR_TOOL_CALLS {
        return Err(LiveError::new(
            "the model asked to run too many tools at once — ask it to work in smaller steps",
        ));
    }
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
        tool_calls: response
            .tool_calls
            .into_iter()
            .map(|call| AgentToolCall {
                id: call.id,
                name: call.name,
                arguments: call.arguments,
            })
            .collect(),
    }))
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
    categories: &'a [&'a str],
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<&'a ProviderConfig>,
}

#[derive(Serialize)]
struct ReviseRequest<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    thread_id: &'a str,
    instruction: &'a str,
    document: &'a [WireBlock],
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<&'a ProviderConfig>,
}

#[derive(Deserialize, Serialize)]
struct WireBlock {
    id: String,
    #[serde(rename = "type")]
    block_type: String,
    payload: Value,
    fallback: String,
}

#[derive(Deserialize)]
struct ReviseResult {
    blocks: Vec<WireBlock>,
}

/// Agent-authored blocks are untrusted structure; bound them here and let
/// `emma_core` reject anything that is not a valid artifact.
fn agent_blocks(blocks: Vec<WireBlock>) -> Result<Vec<AgentBlock>, LiveError> {
    if blocks.len() > MAX_SIDECAR_DOCUMENT_BLOCKS {
        return Err(LiveError::new(
            "Emma agent returned more document blocks than Emma accepts",
        ));
    }
    Ok(blocks
        .into_iter()
        .map(|block| AgentBlock {
            id: block.id,
            block_type: block.block_type,
            payload: block.payload,
            fallback: block.fallback,
        })
        .collect())
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
    #[serde(default)]
    input_modalities: Vec<String>,
    #[serde(default)]
    reasoning_efforts: Vec<String>,
    #[serde(default)]
    reasoning_mandatory: bool,
    #[serde(default)]
    free: bool,
    /// Dollars per million tokens, in micro-dollars, as the sidecar read them off the
    /// catalog. `0` is either a free model or a price OpenRouter did not publish.
    #[serde(default)]
    prompt_micro_usd_per_mtok: u64,
    #[serde(default)]
    completion_micro_usd_per_mtok: u64,
}

#[derive(Deserialize)]
struct ThreadMessageResult {
    message: WireMessage,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    #[serde(default)]
    tool_calls: Vec<WireToolCall>,
}

#[derive(Deserialize)]
struct WireToolCall {
    id: String,
    name: String,
    arguments: String,
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
    #[serde(default)]
    blocks: Vec<WireBlock>,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    subagent_count: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use emma_core::{ScreenContext, Thread, ThreadMessage, Timestamp};

    /// None of these tests spawn the sidecar, so no delta ever reaches the sink.
    fn quiet() -> DeltaSink {
        Arc::new(|_: &str, _: &str| {})
    }

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
            tools: &[],
            id: "test",
            kind: "thread_message",
            thread_id: "thread-1",
            content: "hello",
            knowledge: &[],
            screen_context: None,
            skill_context: None,
            provider: Some(&provider),
        };
        let json = serde_json::to_value(request).unwrap();
        assert_eq!(json["provider"]["model"], "model");
        assert_eq!(json["provider"]["credential_env"], "EMMA_API_KEY");

        let context = ScreenContext::new("data:image/jpeg;base64,/9j/".into()).unwrap();
        let request = ThreadMessageRequest {
            tools: &[],
            id: "test",
            kind: "thread_message",
            thread_id: "thread-1",
            content: "hello",
            knowledge: &[],
            screen_context: Some(&context.jpeg_data_url),
            skill_context: None,
            provider: None,
        };
        assert_eq!(
            serde_json::to_value(request).unwrap()["screen_context"],
            "data:image/jpeg;base64,/9j/"
        );

        let skill =
            emma_core::SkillContext::new("Use the selected review procedure.".into()).unwrap();
        let request = ThreadMessageRequest {
            tools: &[],
            id: "test",
            kind: "thread_message",
            thread_id: "thread-1",
            content: "hello",
            knowledge: &[],
            screen_context: None,
            skill_context: Some(&skill.instructions),
            provider: None,
        };
        assert_eq!(
            serde_json::to_value(request).unwrap()["skill_context"],
            "Use the selected review procedure."
        );

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
            quiet(),
        );

        assert!(matches!(
            sidecar.call(AgentRequest::SelectFallbackModel).unwrap(),
            AgentResponse::FallbackModelSelected
        ));
        assert!(sidecar.provider.is_none());
    }

    #[test]
    fn a_failing_route_falls_back_to_the_local_reply_and_never_to_another_model() {
        let mut sidecar = Sidecar::new(PathBuf::from("unused"), None, quiet());
        // Local-only selection: no escalation to a provider, ever.
        let local_only = sidecar.fallback_chain();
        assert_eq!(local_only.len(), 1);
        assert!(local_only[0].is_none());

        sidecar.openrouter_models = vec![
            OpenRouterModel {
                id: "openai/gpt-oss-20b:free".into(),
                name: "gpt-oss".into(),
                context_length: 131_072,
                input_modalities: vec![],
                reasoning_efforts: vec![],
                reasoning_mandatory: false,
                free: true,
                prompt_micro_usd_per_mtok: 0,
                completion_micro_usd_per_mtok: 0,
            },
            OpenRouterModel {
                id: "google/gemma-4-31b-it:free".into(),
                name: "gemma".into(),
                context_length: 262_144,
                input_modalities: vec![],
                reasoning_efforts: vec![],
                reasoning_mandatory: false,
                free: true,
                prompt_micro_usd_per_mtok: 0,
                completion_micro_usd_per_mtok: 0,
            },
        ];
        sidecar
            .select_openrouter_model("openai/gpt-oss-20b:free".into(), String::new())
            .unwrap();
        let chain = sidecar.fallback_chain();
        // The selected model, then Emma's own reply: a catalogued sibling is never substituted,
        // because the answer would arrive in another vendor's voice with no sign of the swap.
        assert_eq!(chain.len(), 2);
        assert_eq!(chain[0].as_ref().unwrap().model, "openai/gpt-oss-20b:free");
        assert!(chain[1].is_none());

        // A local profile retries itself, then Emma's local reply — no remote hop.
        sidecar.provider = Some(
            ProviderConfig::local("http://localhost:1234/v1".into(), "qwen".into(), "".into())
                .unwrap(),
        );
        let chain = sidecar.fallback_chain();
        assert_eq!(chain.len(), 2);
        assert_eq!(chain[0].as_ref().unwrap().model, "qwen");
        assert!(chain[1].is_none());
    }

    #[test]
    fn a_pinned_thread_routes_to_its_own_model_and_leaves_the_selection_alone() {
        let mut sidecar = Sidecar::new(PathBuf::from("unused"), None, quiet());
        sidecar.openrouter_models = vec![OpenRouterModel {
            id: "vendor/thinker".into(),
            name: "Thinker".into(),
            context_length: 200_000,
            input_modalities: vec![],
            reasoning_efforts: vec!["low".into(), "high".into()],
            reasoning_mandatory: false,
            free: false,
            prompt_micro_usd_per_mtok: 0,
            completion_micro_usd_per_mtok: 0,
        }];
        let subagent = ThreadId::parse("2026-08-21-subagent-aaaa").unwrap();
        let parent = ThreadId::parse("2026-08-21-parent-bbbbbb").unwrap();

        // Uncatalogued models and efforts the model does not publish are refused here,
        // not sent for the provider to 400 on.
        assert!(
            sidecar
                .set_thread_model(subagent.clone(), "vendor/unknown".into(), String::new())
                .is_err()
        );
        assert!(
            sidecar
                .set_thread_model(subagent.clone(), "vendor/thinker".into(), "max".into())
                .is_err()
        );

        sidecar
            .set_thread_model(subagent.clone(), "vendor/thinker".into(), "high".into())
            .unwrap();
        let chain = sidecar.chain_for(&subagent);
        let pinned = chain[0].as_ref().unwrap();
        assert_eq!(pinned.model, "vendor/thinker");
        assert_eq!(pinned.reasoning_effort, "high");
        // The window comes off the catalog, so a pinned thread compacts like any other.
        assert_eq!(pinned.context_length, 200_000);
        // Still the local reply behind it, and never another vendor's model.
        assert!(chain[1].is_none());
        // The pin is one thread's: the app's own selection never moved.
        assert!(sidecar.provider.is_none());
        assert!(sidecar.chain_for(&parent)[0].is_none());

        // An empty model puts the thread back on whatever the app is on.
        sidecar
            .set_thread_model(subagent.clone(), String::new(), String::new())
            .unwrap();
        assert!(sidecar.chain_for(&subagent)[0].is_none());
    }

    #[test]
    fn only_catalogued_openrouter_models_can_be_selected() {
        let mut sidecar = Sidecar::new(PathBuf::from("unused"), None, quiet());
        assert!(
            sidecar
                .select_openrouter_model("vendor/paid".into(), String::new())
                .is_err()
        );
        let model = OpenRouterModel {
            id: "openai/gpt-oss-20b:free".into(),
            name: "OpenAI: gpt-oss-20b (free)".into(),
            context_length: 131_072,
            input_modalities: vec!["image".into()],
            reasoning_efforts: vec!["low".into(), "high".into()],
            reasoning_mandatory: false,
            free: true,
            prompt_micro_usd_per_mtok: 0,
            completion_micro_usd_per_mtok: 0,
        };
        sidecar.openrouter_models.push(model.clone());
        assert_eq!(
            sidecar
                .select_openrouter_model(model.id.clone(), "high".into())
                .unwrap(),
            model.id
        );
        let provider = sidecar.provider.unwrap();
        assert!(provider.protect_data);
        assert_eq!(provider.base_url, OPENROUTER_BASE_URL);
        assert_eq!(provider.credential_env, OPENROUTER_CREDENTIAL_ENV);
        // The window travels with the selection: it is what the sidecar compacts against.
        assert_eq!(provider.context_length, 131_072);

        let mut regional = Sidecar::new(
            PathBuf::from("unused"),
            Some(ProviderConfig {
                base_url: "https://eu.openrouter.ai/api/v1".into(),
                model: "vendor/old:free".into(),
                credential_env: "EMMA_EU_OPENROUTER_KEY".into(),
                protect_data: true,
                zero_retention: false,
                reasoning_effort: String::new(),
                context_length: 0,
            }),
            quiet(),
        );
        regional.openrouter_models.push(model.clone());
        regional
            .select_openrouter_model(model.id, String::new())
            .unwrap();
        let provider = regional.provider.unwrap();
        assert_eq!(provider.base_url, "https://eu.openrouter.ai/api/v1");
        assert_eq!(provider.credential_env, "EMMA_EU_OPENROUTER_KEY");

        // Paid models are catalogued too — a key gates running one, not seeing it.
        assert!(
            openrouter_model_is_readable(&WireOpenRouterModel {
                id: "vendor/model".into(),
                name: "Paid".into(),
                context_length: 1,
                input_modalities: vec![],
                reasoning_efforts: vec![],
                reasoning_mandatory: false,
                free: false,
                prompt_micro_usd_per_mtok: 0,
                completion_micro_usd_per_mtok: 0,
            })
        );
        assert!(
            !openrouter_model_is_readable(&WireOpenRouterModel {
                id: "no-author".into(),
                name: "Malformed".into(),
                context_length: 1,
                input_modalities: vec![],
                reasoning_efforts: vec![],
                reasoning_mandatory: false,
                free: false,
                prompt_micro_usd_per_mtok: 0,
                completion_micro_usd_per_mtok: 0,
            })
        );
    }

    #[test]
    fn one_unreadable_row_does_not_empty_the_model_catalog() {
        let row = |id: &str, context_length: u64| WireOpenRouterModel {
            id: id.into(),
            name: id.into(),
            context_length,
            input_modalities: vec![],
            reasoning_efforts: vec![],
            reasoning_mandatory: false,
            free: false,
            prompt_micro_usd_per_mtok: 0,
            completion_micro_usd_per_mtok: 0,
        };
        let accepted = accepted_openrouter_models(vec![
            row("vendor/good", 8_192),
            // Unreadable: no author, and a context length outside the accepted range.
            row("malformed", 8_192),
            row("vendor/zero", 0),
            // A repeat of a row already taken.
            row("vendor/good", 8_192),
            row("vendor/other", 4_096),
        ]);
        let ids: Vec<&str> = accepted.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, ["vendor/good", "vendor/other"]);
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

    /// A tool the wire drops is a tool the model is never told it has, and nothing
    /// upstream notices: core already refuses a table over `MAX_AGENT_TOOLS`, so
    /// everything that gets this far must survive the trip whole.
    #[test]
    fn every_advertised_tool_reaches_the_sidecar() {
        let tools: Vec<AgentTool> = (0..MAX_AGENT_TOOLS)
            .map(|index| {
                AgentTool::new(
                    format!("tool_{index}"),
                    "x".repeat(MAX_SIDECAR_TOOL_DESCRIPTION_BYTES),
                    serde_json::json!({"type": "object"}),
                )
                .unwrap()
            })
            .collect();

        let wired = wire_tools(&tools);
        assert_eq!(wired.len(), tools.len());
        assert_eq!(wired.last().unwrap().name, "tool_31");
        assert_eq!(
            wired[0].description.len(),
            MAX_SIDECAR_TOOL_DESCRIPTION_BYTES
        );
    }
}
