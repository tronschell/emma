use std::{
    error::Error,
    fmt,
    path::PathBuf,
    sync::mpsc::{self, Sender},
    thread,
};

use crate::{
    AnalysisContent, CapturedContext, Category, CitedSource, KnowledgePage, KnowledgeStore,
    RunTelemetry, SourceUrl, Thread, ThreadId, ThreadMessage, ThreadRole, ThreadStore, Timestamp,
};

#[derive(Clone, Debug)]
pub enum AgentRequest {
    ThreadMessage { thread: Thread, content: String },
    Analyze { thread: Thread, text: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentMessage {
    pub content: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentSource {
    pub title: String,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentAnalysis {
    pub title: String,
    pub category: String,
    pub summary: String,
    pub body: String,
    pub sources: Vec<AgentSource>,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub subagent_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentResponse {
    Message(AgentMessage),
    Analysis(AgentAnalysis),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LiveSnapshot {
    pub threads: Vec<Thread>,
    pub pages: Vec<KnowledgePage>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveError(String);

impl LiveError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for LiveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl Error for LiveError {}

type Reply<T> = Sender<Result<T, LiveError>>;

enum Command {
    Snapshot(Reply<LiveSnapshot>),
    CreateThread(Reply<Thread>),
    SendMessage {
        thread_id: ThreadId,
        content: String,
        reply: Reply<Thread>,
    },
    SaveToKnowledge {
        thread_id: ThreadId,
        reply: Reply<KnowledgePage>,
    },
}

/// Blocking handle to the typed runtime worker. Call these methods only from a
/// background executor, never while rendering GPUI.
#[derive(Clone)]
pub struct LiveClient {
    commands: Sender<Command>,
}

impl LiveClient {
    pub fn snapshot(&self) -> Result<LiveSnapshot, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::Snapshot(reply))
            .map_err(|_| LiveError::new("Emma runtime stopped before loading the library"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while loading the library"))?
    }

    pub fn create_thread(&self) -> Result<Thread, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::CreateThread(reply))
            .map_err(|_| LiveError::new("Emma runtime stopped before creating the thread"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while creating the thread"))?
    }

    pub fn send_message(&self, thread_id: ThreadId, content: String) -> Result<Thread, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SendMessage {
                thread_id,
                content,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before sending the message"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while sending the message"))?
    }

    pub fn save_to_knowledge(&self, thread_id: ThreadId) -> Result<KnowledgePage, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SaveToKnowledge { thread_id, reply })
            .map_err(|_| LiveError::new("Emma runtime stopped before saving the analysis"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while saving the analysis"))?
    }
}

pub fn start_live_runtime<A>(
    thread_root: PathBuf,
    knowledge_root: PathBuf,
    agent: A,
) -> Result<LiveClient, LiveError>
where
    A: FnMut(AgentRequest) -> Result<AgentResponse, LiveError> + Send + 'static,
{
    let (commands, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("emma-live-runtime".into())
        .spawn(move || {
            let mut runtime = Runtime::new(thread_root, knowledge_root, agent);
            while let Ok(command) = receiver.recv() {
                runtime.handle(command);
            }
        })
        .map_err(|error| LiveError::new(format!("could not start Emma runtime: {error}")))?;
    Ok(LiveClient { commands })
}

struct Runtime<A> {
    threads: ThreadStore,
    knowledge: KnowledgeStore,
    agent: A,
}

impl<A> Runtime<A>
where
    A: FnMut(AgentRequest) -> Result<AgentResponse, LiveError>,
{
    fn new(thread_root: PathBuf, knowledge_root: PathBuf, agent: A) -> Self {
        Self {
            threads: ThreadStore::new(thread_root),
            knowledge: KnowledgeStore::new(knowledge_root),
            agent,
        }
    }

    fn handle(&mut self, command: Command) {
        match command {
            Command::Snapshot(reply) => {
                let _ = reply.send(self.snapshot());
            }
            Command::CreateThread(reply) => {
                let _ = reply.send(self.create_thread());
            }
            Command::SendMessage {
                thread_id,
                content,
                reply,
            } => {
                let _ = reply.send(self.send_message(thread_id, content));
            }
            Command::SaveToKnowledge { thread_id, reply } => {
                let _ = reply.send(self.save_to_knowledge(thread_id));
            }
        }
    }

    fn snapshot(&self) -> Result<LiveSnapshot, LiveError> {
        let thread_listing = self
            .threads
            .list()
            .map_err(|error| LiveError::new(format!("could not load threads: {error}")))?;
        let page_listing = self
            .knowledge
            .list()
            .map_err(|error| LiveError::new(format!("could not load knowledge pages: {error}")))?;
        let mut warnings = thread_listing
            .malformed
            .into_iter()
            .map(|item| {
                format!(
                    "Skipped malformed thread {}: {}",
                    item.path.display(),
                    item.reason
                )
            })
            .collect::<Vec<_>>();
        warnings.extend(page_listing.malformed.into_iter().map(|item| {
            format!(
                "Skipped malformed knowledge page {}: {}",
                item.path.display(),
                item.reason
            )
        }));
        Ok(LiveSnapshot {
            threads: thread_listing.threads,
            pages: page_listing.pages,
            warnings,
        })
    }

    fn create_thread(&self) -> Result<Thread, LiveError> {
        let thread = Thread::new("New thread", Timestamp::now())
            .map_err(|error| LiveError::new(format!("could not create thread: {error}")))?;
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save new thread: {error}")))?;
        Ok(thread)
    }

    fn send_message(&mut self, thread_id: ThreadId, content: String) -> Result<Thread, LiveError> {
        let mut thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        let timestamp = Timestamp::now().max(thread.updated_at);
        let message = ThreadMessage::new(ThreadRole::User, content.clone(), timestamp)
            .map_err(|error| LiveError::new(format!("prompt is invalid: {error}")))?;
        thread
            .push(message)
            .map_err(|error| LiveError::new(format!("could not append prompt: {error}")))?;
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save prompt: {error}")))?;

        let response = (self.agent)(AgentRequest::ThreadMessage {
            thread: thread.clone(),
            content,
        })?;
        let AgentResponse::Message(response) = response else {
            return Err(LiveError::new(
                "agent returned analysis when a thread message was expected",
            ));
        };
        let timestamp = Timestamp::now().max(thread.updated_at);
        let message = ThreadMessage::new(ThreadRole::Assistant, response.content, timestamp)
            .map_err(|error| LiveError::new(format!("assistant response is invalid: {error}")))?;
        thread
            .push(message)
            .map_err(|error| LiveError::new(format!("could not append response: {error}")))?;
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save response: {error}")))?;
        Ok(thread)
    }

    fn save_to_knowledge(&mut self, thread_id: ThreadId) -> Result<KnowledgePage, LiveError> {
        let thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        let text = thread
            .messages
            .iter()
            .rev()
            .find(|message| message.role == ThreadRole::Assistant)
            .map(|message| message.content.clone())
            .ok_or_else(|| LiveError::new("send a message before saving an analysis"))?;
        let response = (self.agent)(AgentRequest::Analyze {
            thread: thread.clone(),
            text: text.clone(),
        })?;
        let AgentResponse::Analysis(response) = response else {
            return Err(LiveError::new(
                "agent returned a message when analysis was expected",
            ));
        };
        let sources = response
            .sources
            .into_iter()
            .map(|source| {
                let url = SourceUrl::parse(source.url).map_err(|error| {
                    LiveError::new(format!("analysis source is invalid: {error}"))
                })?;
                CitedSource::new(source.title, url)
                    .map_err(|error| LiveError::new(format!("analysis source is invalid: {error}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let timestamp = Timestamp::now().max(thread.updated_at);
        let page = KnowledgePage::new(
            response.title,
            Category::parse(response.category).map_err(|error| {
                LiveError::new(format!("analysis category is invalid: {error}"))
            })?,
            CapturedContext::new(text, Some("Emma".into()), None)
                .map_err(|error| LiveError::new(format!("analysis context is invalid: {error}")))?,
            AnalysisContent::new(response.summary, response.body)
                .map_err(|error| LiveError::new(format!("analysis content is invalid: {error}")))?,
            sources,
            timestamp,
            timestamp,
            RunTelemetry::new(
                response.model,
                response.input_tokens,
                response.output_tokens,
                response.subagent_count,
            )
            .map_err(|error| LiveError::new(format!("analysis telemetry is invalid: {error}")))?,
        )
        .map_err(|error| LiveError::new(format!("knowledge page is invalid: {error}")))?
        .with_source_thread(thread_id);
        self.knowledge
            .save(&page)
            .map_err(|error| LiveError::new(format!("could not save knowledge page: {error}")))?;
        Ok(page)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    fn temp_child() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "emma-live-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn live_flow_resaves_one_thread_recovers_stale_temp_and_saves_only_on_action() {
        let root = temp_child();
        let thread_root = root.join("threads");
        let knowledge_root = root.join("knowledge");
        let agent = |request| match request {
            AgentRequest::ThreadMessage { thread, content } => {
                assert_eq!(thread.messages.len(), 1);
                Ok(AgentResponse::Message(AgentMessage {
                    content: format!("Fake reply to {content}"),
                    model: "fake".into(),
                    input_tokens: 2,
                    output_tokens: 4,
                }))
            }
            AgentRequest::Analyze { thread, text } => {
                assert_eq!(thread.messages.len(), 2);
                Ok(AgentResponse::Analysis(AgentAnalysis {
                    title: "Saved fake analysis".into(),
                    category: "general".into(),
                    summary: "Focused integration analysis".into(),
                    body: format!("Analyzed: {text}"),
                    sources: Vec::new(),
                    model: "fake".into(),
                    input_tokens: 4,
                    output_tokens: 6,
                    subagent_count: 0,
                }))
            }
        };
        let mut runtime = Runtime::new(thread_root.clone(), knowledge_root.clone(), agent);

        let created = runtime.create_thread().unwrap();
        let stale_temp = thread_root.join(format!(".{}.tmp", created.id));
        fs::write(&stale_temp, "stale interrupted save").unwrap();
        let updated = runtime
            .send_message(created.id.clone(), "hello".into())
            .unwrap();

        assert_eq!(updated.id, created.id);
        assert_eq!(updated.messages.len(), 2);
        assert_eq!(runtime.threads.load(&created.id).unwrap(), updated);
        assert!(!stale_temp.exists());
        assert!(runtime.knowledge.list().unwrap().pages.is_empty());

        let page = runtime.save_to_knowledge(created.id.clone()).unwrap();
        assert_eq!(page.source_thread_id, Some(created.id));
        assert_eq!(runtime.knowledge.list().unwrap().pages, [page]);
        fs::remove_dir_all(root).unwrap();
    }
}
