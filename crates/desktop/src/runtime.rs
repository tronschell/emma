use std::{
    collections::HashMap,
    env,
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

use emma_core::{
    AgentAnalysis, AgentKnowledgeMutation, AgentMessage, AgentRequest, AgentResponse, AgentSource,
    LiveClient, LiveError, Thread, ThreadId, ThreadRole, start_live_runtime,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

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
    next_request_id: u64,
}

impl Sidecar {
    fn new(path: PathBuf, provider: Option<ProviderConfig>) -> Self {
        Self {
            path,
            provider,
            io: None,
            thread_ids: HashMap::new(),
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
                let response: ThreadMessageResult = self.exchange(&id, &request)?;
                Ok(AgentResponse::Message(
                    self.finish_thread_message(&thread.id, response)?,
                ))
            }
            AgentRequest::Analyze { thread, text } => {
                let thread_id = self.sidecar_thread(&thread)?;
                let id = self.request_id();
                let request = AnalyzeRequest {
                    id: &id,
                    kind: "analyze",
                    thread_id: &thread_id,
                    text: &text,
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
        }
    }

    fn finish_thread_message(
        &mut self,
        thread_id: &ThreadId,
        response: ThreadMessageResult,
    ) -> Result<AgentMessage, LiveError> {
        if response.knowledge_mutation.is_some() {
            self.thread_ids.remove(thread_id);
        }
        Ok(AgentMessage {
            content: response.message.content,
            model: response.model,
            input_tokens: response.input_tokens,
            output_tokens: response.output_tokens,
            knowledge_mutation: response
                .knowledge_mutation
                .map(translate_knowledge_mutation)
                .transpose()?,
        })
    }

    fn sidecar_thread(&mut self, thread: &Thread) -> Result<String, LiveError> {
        if let Some(id) = self.thread_ids.get(&thread.id) {
            return Ok(id.clone());
        }
        let id = self.request_id();
        let messages = thread
            .messages
            .iter()
            .map(|message| ImportedMessage {
                role: match message.role {
                    ThreadRole::User => "user",
                    ThreadRole::Assistant => "assistant",
                    ThreadRole::System => "system",
                },
                content: &message.content,
            })
            .collect::<Vec<_>>();
        let request = ThreadCreateRequest {
            id: &id,
            kind: "thread_create",
            title: &thread.title,
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

#[derive(Clone, Serialize)]
struct ProviderConfig {
    base_url: String,
    model: String,
    credential_env: String,
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
struct ThreadMessageResult {
    message: WireMessage,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    #[serde(default)]
    knowledge_mutation: Option<WireKnowledgeMutation>,
}

#[derive(Deserialize)]
struct WireMessage {
    content: String,
}

#[derive(Deserialize)]
struct WireKnowledgeMutation {
    #[serde(rename = "type")]
    kind: String,
    arguments: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreatePageArguments {
    title: String,
    #[serde(default)]
    category: Option<String>,
    summary: String,
    body: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdatePageArguments {
    page_id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    body: Option<String>,
}

fn translate_knowledge_mutation(
    mutation: WireKnowledgeMutation,
) -> Result<AgentKnowledgeMutation, LiveError> {
    match mutation.kind.as_str() {
        "create_page" => {
            let arguments: CreatePageArguments = serde_json::from_value(mutation.arguments)
                .map_err(|error| {
                    LiveError::new(format!(
                        "Emma agent returned invalid create-page arguments: {error}"
                    ))
                })?;
            Ok(AgentKnowledgeMutation::Create {
                title: arguments.title,
                category: arguments.category,
                summary: arguments.summary,
                body: arguments.body,
            })
        }
        "update_page" => {
            let arguments: UpdatePageArguments = serde_json::from_value(mutation.arguments)
                .map_err(|error| {
                    LiveError::new(format!(
                        "Emma agent returned invalid update-page arguments: {error}"
                    ))
                })?;
            Ok(AgentKnowledgeMutation::Update {
                page_id: arguments.page_id,
                title: arguments.title,
                category: arguments.category,
                summary: arguments.summary,
                body: arguments.body,
            })
        }
        _ => Err(LiveError::new(
            "Emma agent returned an unknown knowledge action",
        )),
    }
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
    }

    #[test]
    fn knowledge_mutations_translate_without_loosening_the_core_boundary() {
        let mutation = translate_knowledge_mutation(WireKnowledgeMutation {
            kind: "update_page".into(),
            arguments: serde_json::json!({
                "page_id": "page-00000000000",
                "body": "replacement"
            }),
        })
        .unwrap();
        assert_eq!(
            mutation,
            AgentKnowledgeMutation::Update {
                page_id: "page-00000000000".into(),
                title: None,
                category: None,
                summary: None,
                body: Some("replacement".into()),
            }
        );
    }

    #[test]
    fn a_knowledge_mutation_invalidates_the_cached_sidecar_thread() {
        let mut sidecar = Sidecar::new(PathBuf::from("unused"), None);
        let thread_id = ThreadId::parse("thread-0000000000").unwrap();
        sidecar
            .thread_ids
            .insert(thread_id.clone(), "zig-thread".into());

        let message = sidecar
            .finish_thread_message(
                &thread_id,
                ThreadMessageResult {
                    message: WireMessage {
                        content: "I saved that.".into(),
                    },
                    model: "fixture".into(),
                    input_tokens: 4,
                    output_tokens: 2,
                    knowledge_mutation: Some(WireKnowledgeMutation {
                        kind: "create_page".into(),
                        arguments: serde_json::json!({
                            "title": "Clock notes",
                            "summary": "Timing matters",
                            "body": "Durable details"
                        }),
                    }),
                },
            )
            .unwrap();

        assert!(message.knowledge_mutation.is_some());
        assert!(!sidecar.thread_ids.contains_key(&thread_id));
    }
}
