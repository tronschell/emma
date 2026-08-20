use std::{
    error::Error,
    fmt, io,
    path::PathBuf,
    sync::mpsc::{self, Sender},
    thread,
};

use crate::{
    AnalysisContent, CapturedContext, Category, CitedSource, KnowledgeBase, KnowledgeBaseId,
    KnowledgePage, KnowledgeStore, PageId, RunTelemetry, SourceUrl, StoreError, Thread, ThreadId,
    ThreadMessage, ThreadRole, ThreadStore, Timestamp, validate_text,
};

const MAX_AGENT_TITLE_BYTES: usize = 256;
const MAX_AGENT_SUMMARY_BYTES: usize = 4 * 1024;
const MAX_AGENT_BODY_BYTES: usize = 64 * 1024;
const MAX_AGENT_CONTEXT_BODY_BYTES: usize = 8 * 1024;

#[derive(Clone, Debug)]
pub enum AgentRequest {
    ThreadMessage {
        thread: Thread,
        content: String,
        knowledge: Vec<AgentKnowledgePage>,
    },
    Analyze {
        thread: Thread,
        text: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentKnowledgePage {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentKnowledgeMutation {
    Create {
        title: String,
        category: Option<String>,
        summary: String,
        body: String,
    },
    Update {
        page_id: String,
        title: Option<String>,
        category: Option<String>,
        summary: Option<String>,
        body: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentMessage {
    pub content: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub knowledge_mutation: Option<AgentKnowledgeMutation>,
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
    pub knowledge_bases: Vec<KnowledgeBase>,
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
    CreateKnowledgeBase {
        name: String,
        reply: Reply<KnowledgeBase>,
    },
    SelectThreadKnowledgeBase {
        thread_id: ThreadId,
        knowledge_base_id: KnowledgeBaseId,
        reply: Reply<Thread>,
    },
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

    pub fn create_knowledge_base(&self, name: String) -> Result<KnowledgeBase, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::CreateKnowledgeBase { name, reply })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before creating the knowledge base")
            })?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while creating the knowledge base"))?
    }

    pub fn select_thread_knowledge_base(
        &self,
        thread_id: ThreadId,
        knowledge_base_id: KnowledgeBaseId,
    ) -> Result<Thread, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SelectThreadKnowledgeBase {
                thread_id,
                knowledge_base_id,
                reply,
            })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before selecting the knowledge base")
            })?;
        result.recv().map_err(|_| {
            LiveError::new("Emma runtime stopped while selecting the knowledge base")
        })?
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
            Command::CreateKnowledgeBase { name, reply } => {
                let _ = reply.send(self.create_knowledge_base(name));
            }
            Command::SelectThreadKnowledgeBase {
                thread_id,
                knowledge_base_id,
                reply,
            } => {
                let _ = reply.send(self.select_thread_knowledge_base(thread_id, knowledge_base_id));
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
        let base_listing = self
            .knowledge
            .list_bases()
            .map_err(|error| LiveError::new(format!("could not load knowledge bases: {error}")))?;
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
        warnings.extend(base_listing.malformed.into_iter().map(|item| {
            format!(
                "Skipped malformed knowledge base {}: {}",
                item.path.display(),
                item.reason
            )
        }));
        Ok(LiveSnapshot {
            threads: thread_listing.threads,
            knowledge_bases: base_listing.bases,
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

    fn create_knowledge_base(&self, name: String) -> Result<KnowledgeBase, LiveError> {
        let base = KnowledgeBase::new(name, Timestamp::now())
            .map_err(|error| LiveError::new(format!("knowledge base name is invalid: {error}")))?;
        let listing = self.knowledge.list_bases().map_err(|error| {
            LiveError::new(format!("could not check existing knowledge bases: {error}"))
        })?;
        if listing
            .bases
            .iter()
            .any(|existing| existing.name.to_lowercase() == base.name.to_lowercase())
        {
            return Err(LiveError::new(format!(
                "a knowledge base named {:?} already exists",
                base.name
            )));
        }
        self.knowledge
            .save_base(&base)
            .map_err(|error| LiveError::new(format!("could not save knowledge base: {error}")))?;
        Ok(base)
    }

    fn select_thread_knowledge_base(
        &self,
        thread_id: ThreadId,
        knowledge_base_id: KnowledgeBaseId,
    ) -> Result<Thread, LiveError> {
        self.load_base(&knowledge_base_id)?;
        let mut thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        thread.select_knowledge_base(knowledge_base_id);
        self.threads.save(&thread).map_err(|error| {
            LiveError::new(format!("could not save thread knowledge base: {error}"))
        })?;
        Ok(thread)
    }

    fn send_message(&mut self, thread_id: ThreadId, content: String) -> Result<Thread, LiveError> {
        let mut thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        let timestamp = Timestamp::now().max(thread.updated_at);
        let message = ThreadMessage::new(ThreadRole::User, content.clone(), timestamp)
            .map_err(|error| LiveError::new(format!("prompt is invalid: {error}")))?;
        let selected_base = self.load_base(&thread.knowledge_base_id)?;
        let knowledge = self
            .knowledge
            .relevant_pages(&selected_base.id, &content, crate::MAX_RELEVANT_PAGES)
            .map_err(|error| {
                LiveError::new(format!("could not retrieve relevant knowledge: {error}"))
            })?
            .into_iter()
            .map(|page| AgentKnowledgePage {
                id: page.id.as_str().to_owned(),
                title: bounded(&page.title, MAX_AGENT_TITLE_BYTES),
                summary: bounded(&page.analysis.summary, MAX_AGENT_SUMMARY_BYTES),
                body: bounded(&page.analysis.body, MAX_AGENT_CONTEXT_BODY_BYTES),
            })
            .collect();
        thread
            .push(message)
            .map_err(|error| LiveError::new(format!("could not append prompt: {error}")))?;
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save prompt: {error}")))?;

        let response = (self.agent)(AgentRequest::ThreadMessage {
            thread: thread.clone(),
            content: content.clone(),
            knowledge,
        })?;
        let AgentResponse::Message(response) = response else {
            return Err(LiveError::new(
                "agent returned analysis when a thread message was expected",
            ));
        };
        let AgentMessage {
            content: assistant_content,
            model,
            input_tokens,
            output_tokens,
            knowledge_mutation,
        } = response;
        let mutation_result = knowledge_mutation.map(|mutation| {
            self.apply_knowledge_mutation(
                &thread,
                &selected_base,
                &content,
                mutation,
                &model,
                input_tokens,
                output_tokens,
            )
        });
        let assistant_content = match (assistant_content.trim().is_empty(), mutation_result) {
            (false, Some(Ok(message))) => format!("{assistant_content}\n\n{message}"),
            (false, Some(Err(error))) => {
                format!("{assistant_content}\n\nKnowledge update failed: {error}")
            }
            (false, None) => assistant_content,
            (true, Some(Ok(message))) => message,
            (true, Some(Err(error))) => format!("Knowledge update failed: {error}"),
            (true, None) => {
                return Err(LiveError::new(
                    "agent returned neither assistant text nor a knowledge action",
                ));
            }
        };
        let timestamp = Timestamp::now().max(thread.updated_at);
        let message = ThreadMessage::new(ThreadRole::Assistant, assistant_content, timestamp)
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
        let selected_base = self.load_base(&thread.knowledge_base_id)?;
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
        .with_source_thread(thread_id)
        .in_knowledge_base(selected_base.id);
        self.knowledge
            .save(&page)
            .map_err(|error| LiveError::new(format!("could not save knowledge page: {error}")))?;
        Ok(page)
    }

    fn load_base(&self, id: &KnowledgeBaseId) -> Result<KnowledgeBase, LiveError> {
        self.knowledge.load_base(id).map_err(|error| match error {
            StoreError::Io(error) if error.kind() == io::ErrorKind::NotFound => {
                LiveError::new(format!("selected knowledge base {id} does not exist"))
            }
            error => LiveError::new(format!("could not load selected knowledge base: {error}")),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_knowledge_mutation(
        &self,
        thread: &Thread,
        base: &KnowledgeBase,
        prompt: &str,
        mutation: AgentKnowledgeMutation,
        model: &str,
        input_tokens: u64,
        output_tokens: u64,
    ) -> Result<String, LiveError> {
        let telemetry = || {
            RunTelemetry::new(model, input_tokens, output_tokens, 0).map_err(|error| {
                LiveError::new(format!("knowledge action telemetry is invalid: {error}"))
            })
        };
        match mutation {
            AgentKnowledgeMutation::Create {
                title,
                category,
                summary,
                body,
            } => {
                validate_agent_text("page title", &title, true, MAX_AGENT_TITLE_BYTES)?;
                validate_agent_text("analysis summary", &summary, true, MAX_AGENT_SUMMARY_BYTES)?;
                validate_agent_text("analysis body", &body, false, MAX_AGENT_BODY_BYTES)?;
                let timestamp = Timestamp::now().max(thread.updated_at);
                let page = KnowledgePage::new(
                    title,
                    Category::parse(category.unwrap_or_else(|| "general".into())).map_err(
                        |error| LiveError::new(format!("page category is invalid: {error}")),
                    )?,
                    CapturedContext::new(prompt, Some("Emma agent".into()), None).map_err(
                        |error| LiveError::new(format!("page context is invalid: {error}")),
                    )?,
                    AnalysisContent::new(summary, body).map_err(|error| {
                        LiveError::new(format!("page content is invalid: {error}"))
                    })?,
                    Vec::new(),
                    timestamp,
                    timestamp,
                    telemetry()?,
                )
                .map_err(|error| LiveError::new(format!("knowledge page is invalid: {error}")))?
                .with_source_thread(thread.id.clone())
                .in_knowledge_base(base.id.clone());
                self.knowledge.save(&page).map_err(|error| {
                    LiveError::new(format!("could not create knowledge page: {error}"))
                })?;
                Ok(format!("Created “{}” in {}.", page.title, base.name))
            }
            AgentKnowledgeMutation::Update {
                page_id,
                title,
                category,
                summary,
                body,
            } => {
                if title.is_none() && category.is_none() && summary.is_none() && body.is_none() {
                    return Err(LiveError::new("update did not include any page changes"));
                }
                let page_id = PageId::parse(page_id)
                    .map_err(|error| LiveError::new(format!("page ID is invalid: {error}")))?;
                let mut page = self.knowledge.load(&page_id).map_err(|error| match error {
                    StoreError::Io(error) if error.kind() == io::ErrorKind::NotFound => {
                        LiveError::new(format!("page {page_id} does not exist"))
                    }
                    error => LiveError::new(format!("could not load page {page_id}: {error}")),
                })?;
                if page.knowledge_base_id != base.id {
                    return Err(LiveError::new(format!(
                        "page {page_id} is outside the selected knowledge base"
                    )));
                }
                if let Some(title) = title {
                    validate_agent_text("page title", &title, true, MAX_AGENT_TITLE_BYTES)?;
                    page.title = title;
                }
                if let Some(category) = category {
                    page.category = Category::parse(category).map_err(|error| {
                        LiveError::new(format!("page category is invalid: {error}"))
                    })?;
                }
                if summary.is_some() || body.is_some() {
                    let summary = summary.unwrap_or_else(|| page.analysis.summary.clone());
                    let body = body.unwrap_or_else(|| page.analysis.body.clone());
                    validate_agent_text(
                        "analysis summary",
                        &summary,
                        true,
                        MAX_AGENT_SUMMARY_BYTES,
                    )?;
                    validate_agent_text("analysis body", &body, false, MAX_AGENT_BODY_BYTES)?;
                    page.analysis = AnalysisContent::new(summary, body).map_err(|error| {
                        LiveError::new(format!("page content is invalid: {error}"))
                    })?;
                }
                page.analyzed_at = Timestamp::now().max(page.analyzed_at);
                page.telemetry = telemetry()?;
                self.knowledge.save(&page).map_err(|error| {
                    LiveError::new(format!("could not update knowledge page: {error}"))
                })?;
                Ok(format!("Updated “{}” in {}.", page.title, base.name))
            }
        }
    }
}

fn validate_agent_text(
    name: &str,
    value: &str,
    required: bool,
    max_bytes: usize,
) -> Result<(), LiveError> {
    validate_text(name, value, required)
        .map_err(|error| LiveError::new(format!("{name} is invalid: {error}")))?;
    if value.len() > max_bytes {
        return Err(LiveError::new(format!(
            "{name} cannot exceed {max_bytes} bytes"
        )));
    }
    Ok(())
}

fn bounded(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::RefCell,
        collections::VecDeque,
        fs,
        rc::Rc,
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
            AgentRequest::ThreadMessage {
                thread,
                content,
                knowledge,
            } => {
                assert_eq!(thread.messages.len(), 1);
                assert!(knowledge.is_empty());
                Ok(AgentResponse::Message(AgentMessage {
                    content: format!("Fake reply to {content}"),
                    model: "fake".into(),
                    input_tokens: 2,
                    output_tokens: 4,
                    knowledge_mutation: None,
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
        assert_eq!(page.knowledge_base_id, KnowledgeBaseId::default_id());
        assert_eq!(runtime.knowledge.list().unwrap().pages, [page]);

        let project = runtime.create_knowledge_base("Project".into()).unwrap();
        runtime
            .select_thread_knowledge_base(updated.id.clone(), project.id.clone())
            .unwrap();
        let project_page = runtime.save_to_knowledge(updated.id.clone()).unwrap();
        assert_eq!(project_page.knowledge_base_id, project.id);

        let page_count = runtime.knowledge.list().unwrap().pages.len();
        let mut orphaned = runtime.threads.load(&updated.id).unwrap();
        orphaned.select_knowledge_base(KnowledgeBaseId::parse("orphan-base").unwrap());
        runtime.threads.save(&orphaned).unwrap();
        assert!(
            runtime
                .save_to_knowledge(updated.id)
                .unwrap_err()
                .to_string()
                .contains("does not exist")
        );
        assert_eq!(runtime.knowledge.list().unwrap().pages.len(), page_count);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn named_base_selection_and_agent_mutations_stay_inside_the_selected_base() {
        let root = temp_child();
        let responses = Rc::new(RefCell::new(VecDeque::<AgentMessage>::new()));
        let seen_knowledge = Rc::new(RefCell::new(Vec::<Vec<AgentKnowledgePage>>::new()));
        let queued = responses.clone();
        let seen = seen_knowledge.clone();
        let agent = move |request| match request {
            AgentRequest::ThreadMessage { knowledge, .. } => {
                seen.borrow_mut().push(knowledge);
                Ok(AgentResponse::Message(
                    queued.borrow_mut().pop_front().unwrap(),
                ))
            }
            AgentRequest::Analyze { .. } => unreachable!(),
        };
        let mut runtime = Runtime::new(root.join("threads"), root.join("knowledge"), agent);
        let research = runtime.create_knowledge_base("Research".into()).unwrap();
        let personal = runtime.create_knowledge_base("Personal".into()).unwrap();
        assert!(runtime.create_knowledge_base("research".into()).is_err());
        assert_eq!(
            runtime.knowledge.list_bases().unwrap().bases[0],
            KnowledgeBase::default_base()
        );

        let thread = runtime.create_thread().unwrap();
        let thread = runtime
            .select_thread_knowledge_base(thread.id, research.id.clone())
            .unwrap();
        assert_eq!(thread.knowledge_base_id, research.id);
        responses.borrow_mut().push_back(AgentMessage {
            content: "I saved that.".into(),
            model: "fixture".into(),
            input_tokens: 4,
            output_tokens: 2,
            knowledge_mutation: Some(AgentKnowledgeMutation::Create {
                title: "Satellite clock".into(),
                category: Some("research".into()),
                summary: "Clock drift matters".into(),
                body: "Satellite timing details".into(),
            }),
        });
        let thread = runtime
            .send_message(thread.id, "remember satellite timing".into())
            .unwrap();
        assert!(
            thread
                .messages
                .last()
                .unwrap()
                .content
                .starts_with("I saved that.")
        );
        assert!(
            thread
                .messages
                .last()
                .unwrap()
                .content
                .contains("Created “Satellite clock” in Research")
        );
        let page = runtime.knowledge.list().unwrap().pages.pop().unwrap();
        assert_eq!(page.knowledge_base_id, research.id);

        responses.borrow_mut().push_back(AgentMessage {
            content: String::new(),
            model: "fixture".into(),
            input_tokens: 6,
            output_tokens: 3,
            knowledge_mutation: Some(AgentKnowledgeMutation::Update {
                page_id: page.id.as_str().into(),
                title: None,
                category: None,
                summary: None,
                body: Some("Updated satellite timing details".into()),
            }),
        });
        let thread = runtime
            .send_message(thread.id, "update satellite details".into())
            .unwrap();
        assert_eq!(seen_knowledge.borrow()[1][0].id, page.id.as_str());
        assert_eq!(
            runtime.knowledge.load(&page.id).unwrap().analysis.body,
            "Updated satellite timing details"
        );

        let thread = runtime
            .select_thread_knowledge_base(thread.id, personal.id)
            .unwrap();
        for page_id in [page.id.as_str(), "missing-page-0000"] {
            responses.borrow_mut().push_back(AgentMessage {
                content: String::new(),
                model: "fixture".into(),
                input_tokens: 2,
                output_tokens: 1,
                knowledge_mutation: Some(AgentKnowledgeMutation::Update {
                    page_id: page_id.into(),
                    title: None,
                    category: None,
                    summary: Some("must not apply".into()),
                    body: None,
                }),
            });
            let failed = runtime
                .send_message(thread.id.clone(), "update satellite".into())
                .unwrap();
            assert!(
                failed
                    .messages
                    .last()
                    .unwrap()
                    .content
                    .starts_with("Knowledge update failed:")
            );
        }
        assert_eq!(
            runtime.knowledge.load(&page.id).unwrap().analysis.summary,
            "Clock drift matters"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
