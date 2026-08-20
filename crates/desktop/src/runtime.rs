use std::{
    collections::HashMap,
    env,
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

use emma_core::{
    AgentAnalysis, AgentMessage, AgentRequest, AgentResponse, AgentSource, LiveClient, LiveError,
    Thread, ThreadId, ThreadRole, start_live_runtime,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

pub fn start() -> Result<LiveClient, LiveError> {
    let data_root = match env::var_os("EMMA_DATA_DIR") {
        Some(path) => PathBuf::from(path),
        None => default_data_root()?,
    };
    let agent_path = env::var_os("EMMA_AGENT_BIN").map_or_else(default_agent_path, PathBuf::from);
    let mut sidecar = Sidecar::new(agent_path);
    start_live_runtime(
        data_root.join("threads"),
        data_root.join("knowledge"),
        move |request| sidecar.call(request),
    )
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
    io: Option<SidecarIo>,
    thread_ids: HashMap<ThreadId, String>,
    next_request_id: u64,
}

impl Sidecar {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
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
            } => {
                if thread.messages.last().is_some_and(|message| {
                    message.role == ThreadRole::User && message.content == content
                }) {
                    thread.messages.pop();
                }
                let thread_id = self.sidecar_thread(&thread)?;
                let id = self.request_id();
                let request = ThreadMessageRequest {
                    id: &id,
                    kind: "thread_message",
                    thread_id: &thread_id,
                    content: &content,
                };
                let response: ThreadMessageResult = self.exchange(&id, &request)?;
                Ok(AgentResponse::Message(AgentMessage {
                    content: response.message.content,
                    model: response.model,
                    input_tokens: response.input_tokens,
                    output_tokens: response.output_tokens,
                }))
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
