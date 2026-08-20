use std::{
    error::Error,
    fmt, io,
    path::PathBuf,
    sync::mpsc::{self, RecvTimeoutError, Sender},
    thread,
    time::Duration,
};

use crate::{
    AnalysisContent, CapturedContext, Category, CitedSource, GenerationTelemetry, KnowledgeBase,
    KnowledgeBaseId, KnowledgePage, KnowledgeStore, PageId, RunTelemetry, ScheduledJob,
    ScheduledJobId, ScheduledJobStore, SourceUrl, StoreError, Thread, ThreadId, ThreadMessage,
    ThreadRole, ThreadStore, Timestamp, validate_text,
};
use serde::Serialize;

const MAX_AGENT_TITLE_BYTES: usize = 256;
const MAX_AGENT_SUMMARY_BYTES: usize = 4 * 1024;
const MAX_AGENT_BODY_BYTES: usize = 64 * 1024;
const MAX_AGENT_CONTEXT_BODY_BYTES: usize = 8 * 1024;
const MAX_AGENT_MESSAGE_BYTES: usize = 64 * 1024;

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
    ListOpenRouterModels,
    SelectOpenRouterModel {
        model_id: String,
    },
    SelectLocalModel {
        base_url: String,
        model_id: String,
        credential_env: String,
    },
    SelectFallbackModel,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterModel {
    pub id: String,
    pub name: String,
    pub context_length: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterCatalog {
    pub selected_model: Option<String>,
    pub models: Vec<OpenRouterModel>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentKnowledgePage {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentMessage {
    pub content: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub duration_milliseconds: u64,
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
    OpenRouterCatalog(OpenRouterCatalog),
    OpenRouterModelSelected(String),
    LocalModelSelected(String),
    FallbackModelSelected,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSnapshot {
    pub threads: Vec<Thread>,
    pub knowledge_bases: Vec<KnowledgeBase>,
    pub pages: Vec<KnowledgePage>,
    pub scheduled_jobs: Vec<ScheduledJob>,
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
    SelectThreadSources {
        thread_id: ThreadId,
        knowledge_base_ids: Vec<KnowledgeBaseId>,
        reply: Reply<Thread>,
    },
    AddKnowledgeBaseCategory {
        knowledge_base_id: KnowledgeBaseId,
        category: String,
        reply: Reply<KnowledgeBase>,
    },
    RemoveKnowledgeBaseCategory {
        knowledge_base_id: KnowledgeBaseId,
        category: String,
        reply: Reply<KnowledgeBase>,
    },
    UpdatePage {
        page_id: PageId,
        title: String,
        category: String,
        summary: String,
        body: String,
        reply: Reply<KnowledgePage>,
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
    CreateScheduledJob {
        title: String,
        schedule: String,
        prompt: String,
        source_domains: Vec<String>,
        reply: Reply<ScheduledJob>,
    },
    SetScheduledJobEnabled {
        job_id: ScheduledJobId,
        enabled: bool,
        reply: Reply<ScheduledJob>,
    },
    ListOpenRouterModels(Reply<OpenRouterCatalog>),
    SelectOpenRouterModel {
        model_id: String,
        reply: Reply<String>,
    },
    SelectLocalModel {
        base_url: String,
        model_id: String,
        credential_env: String,
        reply: Reply<String>,
    },
    SelectFallbackModel(Reply<()>),
}

/// Blocking handle to the typed runtime worker. Call these methods only from a
/// background executor, never from a UI event loop.
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

    pub fn select_thread_sources(
        &self,
        thread_id: ThreadId,
        knowledge_base_ids: Vec<KnowledgeBaseId>,
    ) -> Result<Thread, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SelectThreadSources {
                thread_id,
                knowledge_base_ids,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before selecting source bases"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while selecting source bases"))?
    }

    pub fn add_knowledge_base_category(
        &self,
        knowledge_base_id: KnowledgeBaseId,
        category: String,
    ) -> Result<KnowledgeBase, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::AddKnowledgeBaseCategory {
                knowledge_base_id,
                category,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before adding the category"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while adding the category"))?
    }

    pub fn remove_knowledge_base_category(
        &self,
        knowledge_base_id: KnowledgeBaseId,
        category: String,
    ) -> Result<KnowledgeBase, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::RemoveKnowledgeBaseCategory {
                knowledge_base_id,
                category,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before removing the category"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while removing the category"))?
    }

    pub fn update_page(
        &self,
        page_id: PageId,
        title: String,
        category: String,
        summary: String,
        body: String,
    ) -> Result<KnowledgePage, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::UpdatePage {
                page_id,
                title,
                category,
                summary,
                body,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before updating the page"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while updating the page"))?
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

    pub fn create_scheduled_job(
        &self,
        title: String,
        schedule: String,
        prompt: String,
        source_domains: Vec<String>,
    ) -> Result<ScheduledJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::CreateScheduledJob {
                title,
                schedule,
                prompt,
                source_domains,
                reply,
            })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before creating the scheduled job")
            })?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while creating the scheduled job"))?
    }

    pub fn set_scheduled_job_enabled(
        &self,
        job_id: ScheduledJobId,
        enabled: bool,
    ) -> Result<ScheduledJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SetScheduledJobEnabled {
                job_id,
                enabled,
                reply,
            })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before updating the scheduled job")
            })?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while updating the scheduled job"))?
    }

    pub fn list_openrouter_models(&self) -> Result<OpenRouterCatalog, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::ListOpenRouterModels(reply))
            .map_err(|_| LiveError::new("Emma runtime stopped before loading OpenRouter models"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while loading OpenRouter models"))?
    }

    pub fn select_openrouter_model(&self, model_id: String) -> Result<String, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SelectOpenRouterModel { model_id, reply })
            .map_err(|_| LiveError::new("Emma runtime stopped before selecting the model"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while selecting the model"))?
    }

    pub fn select_local_model(
        &self,
        base_url: String,
        model_id: String,
        credential_env: String,
    ) -> Result<String, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SelectLocalModel {
                base_url,
                model_id,
                credential_env,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before selecting the local model"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while selecting the local model"))?
    }

    pub fn select_fallback_model(&self) -> Result<(), LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SelectFallbackModel(reply))
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before selecting the local fallback")
            })?;
        result.recv().map_err(|_| {
            LiveError::new("Emma runtime stopped while selecting the local fallback")
        })?
    }
}

pub fn start_live_runtime<A>(
    thread_root: PathBuf,
    knowledge_root: PathBuf,
    scheduled_root: PathBuf,
    agent: A,
) -> Result<LiveClient, LiveError>
where
    A: FnMut(AgentRequest) -> Result<AgentResponse, LiveError> + Send + 'static,
{
    let (commands, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("emma-live-runtime".into())
        .spawn(move || {
            let mut runtime = Runtime::new(thread_root, knowledge_root, scheduled_root, agent);
            loop {
                match receiver.recv_timeout(Duration::from_secs(30)) {
                    Ok(command) => runtime.handle(command),
                    Err(RecvTimeoutError::Timeout) => runtime.run_due_jobs(),
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .map_err(|error| LiveError::new(format!("could not start Emma runtime: {error}")))?;
    Ok(LiveClient { commands })
}

struct Runtime<A> {
    threads: ThreadStore,
    knowledge: KnowledgeStore,
    scheduled: ScheduledJobStore,
    agent: A,
}

impl<A> Runtime<A>
where
    A: FnMut(AgentRequest) -> Result<AgentResponse, LiveError>,
{
    fn new(
        thread_root: PathBuf,
        knowledge_root: PathBuf,
        scheduled_root: PathBuf,
        agent: A,
    ) -> Self {
        Self {
            threads: ThreadStore::new(thread_root),
            knowledge: KnowledgeStore::new(knowledge_root),
            scheduled: ScheduledJobStore::new(scheduled_root),
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
            Command::SelectThreadSources {
                thread_id,
                knowledge_base_ids,
                reply,
            } => {
                let _ = reply.send(self.select_thread_sources(thread_id, knowledge_base_ids));
            }
            Command::AddKnowledgeBaseCategory {
                knowledge_base_id,
                category,
                reply,
            } => {
                let _ = reply.send(self.change_category(knowledge_base_id, category, true));
            }
            Command::RemoveKnowledgeBaseCategory {
                knowledge_base_id,
                category,
                reply,
            } => {
                let _ = reply.send(self.change_category(knowledge_base_id, category, false));
            }
            Command::UpdatePage {
                page_id,
                title,
                category,
                summary,
                body,
                reply,
            } => {
                let _ = reply.send(self.update_page(page_id, title, category, summary, body));
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
            Command::CreateScheduledJob {
                title,
                schedule,
                prompt,
                source_domains,
                reply,
            } => {
                let _ =
                    reply.send(self.create_scheduled_job(title, schedule, prompt, source_domains));
            }
            Command::SetScheduledJobEnabled {
                job_id,
                enabled,
                reply,
            } => {
                let _ = reply.send(self.set_scheduled_job_enabled(job_id, enabled));
            }
            Command::ListOpenRouterModels(reply) => {
                let _ = reply.send(self.list_openrouter_models());
            }
            Command::SelectOpenRouterModel { model_id, reply } => {
                let _ = reply.send(self.select_openrouter_model(model_id));
            }
            Command::SelectLocalModel {
                base_url,
                model_id,
                credential_env,
                reply,
            } => {
                let _ = reply.send(self.select_local_model(base_url, model_id, credential_env));
            }
            Command::SelectFallbackModel(reply) => {
                let _ = reply.send(self.select_fallback_model());
            }
        }
    }

    fn run_due_jobs(&mut self) {
        let Ok(listing) = self.scheduled.list() else {
            return;
        };
        let now = Timestamp::now();
        for mut job in listing.jobs {
            if job.claim_run(now) != Ok(true) || self.scheduled.save(&job).is_err() {
                continue;
            }
            let Ok(thread) = Thread::new(job.title.clone(), now) else {
                continue;
            };
            if self.threads.save(&thread).is_err() {
                continue;
            }
            job.last_thread_id = Some(thread.id.to_string());
            let _ = self.scheduled.save(&job);
            let _ = self.send_message(thread.id, job.prompt.clone());
        }
    }

    fn list_openrouter_models(&mut self) -> Result<OpenRouterCatalog, LiveError> {
        match (self.agent)(AgentRequest::ListOpenRouterModels)? {
            AgentResponse::OpenRouterCatalog(catalog) => Ok(catalog),
            _ => Err(LiveError::new(
                "agent returned an unexpected response for the OpenRouter catalog",
            )),
        }
    }

    fn select_openrouter_model(&mut self, model_id: String) -> Result<String, LiveError> {
        match (self.agent)(AgentRequest::SelectOpenRouterModel { model_id })? {
            AgentResponse::OpenRouterModelSelected(model_id) => Ok(model_id),
            _ => Err(LiveError::new(
                "agent returned an unexpected response after selecting an OpenRouter model",
            )),
        }
    }

    fn select_local_model(
        &mut self,
        base_url: String,
        model_id: String,
        credential_env: String,
    ) -> Result<String, LiveError> {
        match (self.agent)(AgentRequest::SelectLocalModel {
            base_url,
            model_id,
            credential_env,
        })? {
            AgentResponse::LocalModelSelected(model_id) => Ok(model_id),
            _ => Err(LiveError::new(
                "agent returned an unexpected response after selecting the local model",
            )),
        }
    }

    fn select_fallback_model(&mut self) -> Result<(), LiveError> {
        match (self.agent)(AgentRequest::SelectFallbackModel)? {
            AgentResponse::FallbackModelSelected => Ok(()),
            _ => Err(LiveError::new(
                "agent returned an unexpected response after selecting the local fallback",
            )),
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
        let job_listing = self
            .scheduled
            .list()
            .map_err(|error| LiveError::new(format!("could not load scheduled jobs: {error}")))?;
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
        warnings.extend(job_listing.malformed.into_iter().map(|(path, reason)| {
            format!(
                "Skipped malformed scheduled job {}: {}",
                path.display(),
                reason
            )
        }));
        Ok(LiveSnapshot {
            threads: thread_listing.threads,
            knowledge_bases: base_listing.bases,
            pages: page_listing.pages,
            scheduled_jobs: job_listing.jobs,
            warnings,
        })
    }

    fn create_scheduled_job(
        &self,
        title: String,
        schedule: String,
        prompt: String,
        source_domains: Vec<String>,
    ) -> Result<ScheduledJob, LiveError> {
        let job = ScheduledJob::new(title, schedule, prompt, source_domains, Timestamp::now())
            .map_err(|error| LiveError::new(format!("scheduled job is invalid: {error}")))?;
        self.scheduled
            .save(&job)
            .map_err(|error| LiveError::new(format!("could not save scheduled job: {error}")))?;
        Ok(job)
    }

    fn set_scheduled_job_enabled(
        &self,
        job_id: ScheduledJobId,
        enabled: bool,
    ) -> Result<ScheduledJob, LiveError> {
        let mut job = self
            .scheduled
            .load(&job_id)
            .map_err(|error| LiveError::new(format!("could not load scheduled job: {error}")))?;
        job.enabled = enabled;
        self.scheduled
            .save(&job)
            .map_err(|error| LiveError::new(format!("could not save scheduled job: {error}")))?;
        Ok(job)
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

    fn select_thread_sources(
        &self,
        thread_id: ThreadId,
        ids: Vec<KnowledgeBaseId>,
    ) -> Result<Thread, LiveError> {
        if ids.len() > 64 {
            return Err(LiveError::new(
                "a thread cannot use more than 64 source bases",
            ));
        }
        for id in &ids {
            self.load_base(id)?;
        }
        let mut thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        thread.select_source_knowledge_bases(ids);
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save source bases: {error}")))?;
        Ok(thread)
    }

    fn change_category(
        &self,
        id: KnowledgeBaseId,
        value: String,
        add: bool,
    ) -> Result<KnowledgeBase, LiveError> {
        let category = Category::parse(value)
            .map_err(|error| LiveError::new(format!("category is invalid: {error}")))?;
        let mut base = self.load_base(&id)?;
        if add {
            if !base.categories.contains(&category) {
                base.categories.push(category);
                base.categories.sort();
            }
        } else {
            base.categories.retain(|existing| existing != &category);
        }
        self.knowledge
            .save_base(&base)
            .map_err(|error| LiveError::new(format!("could not save categories: {error}")))?;
        Ok(base)
    }

    fn update_page(
        &self,
        id: PageId,
        title: String,
        category: String,
        summary: String,
        body: String,
    ) -> Result<KnowledgePage, LiveError> {
        validate_agent_text("page title", &title, true, MAX_AGENT_TITLE_BYTES)?;
        validate_agent_text("analysis summary", &summary, true, MAX_AGENT_SUMMARY_BYTES)?;
        validate_agent_text("analysis body", &body, false, MAX_AGENT_BODY_BYTES)?;
        let mut page = self
            .knowledge
            .load(&id)
            .map_err(|error| LiveError::new(format!("could not load page {id}: {error}")))?;
        page.title = title;
        page.category = Category::parse(category)
            .map_err(|error| LiveError::new(format!("category is invalid: {error}")))?;
        page.analysis = AnalysisContent::new(summary, body)
            .map_err(|error| LiveError::new(format!("page content is invalid: {error}")))?;
        self.knowledge
            .save(&page)
            .map_err(|error| LiveError::new(format!("could not update page: {error}")))?;
        Ok(page)
    }

    fn send_message(&mut self, thread_id: ThreadId, content: String) -> Result<Thread, LiveError> {
        validate_agent_text("prompt", &content, true, MAX_AGENT_MESSAGE_BYTES)?;
        let mut thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        let timestamp = Timestamp::now().max(thread.updated_at);
        let message = ThreadMessage::new(ThreadRole::User, content.clone(), timestamp)
            .map_err(|error| LiveError::new(format!("prompt is invalid: {error}")))?;
        let mut relevant = Vec::new();
        for base_id in &thread.source_knowledge_base_ids {
            self.load_base(base_id)?;
            let pages = self
                .knowledge
                .relevant_pages(base_id, &content, crate::MAX_RELEVANT_PAGES)
                .map_err(|error| {
                    LiveError::new(format!("could not retrieve relevant knowledge: {error}"))
                })?;
            for (rank, page) in pages.into_iter().enumerate() {
                relevant.push((rank, base_id.clone(), page));
            }
        }
        relevant.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then(left.1.cmp(&right.1))
                .then(left.2.id.cmp(&right.2.id))
        });
        let knowledge = relevant
            .into_iter()
            .take(crate::MAX_RELEVANT_PAGES)
            .map(|(_, _, page)| page)
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
            output_tokens,
            duration_milliseconds,
            ..
        } = response;
        let timestamp = Timestamp::now().max(thread.updated_at);
        let message = ThreadMessage::new(ThreadRole::Assistant, assistant_content, timestamp);
        let mut message = message
            .map_err(|error| LiveError::new(format!("assistant response is invalid: {error}")))?;
        message.generation = Some(
            GenerationTelemetry::new(output_tokens, duration_milliseconds).map_err(|error| {
                LiveError::new(format!("generation telemetry is invalid: {error}"))
            })?,
        );
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
        let scheduled_root = root.join("scheduled");
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
                    duration_milliseconds: 200,
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
            AgentRequest::ListOpenRouterModels
            | AgentRequest::SelectOpenRouterModel { .. }
            | AgentRequest::SelectLocalModel { .. }
            | AgentRequest::SelectFallbackModel => {
                unreachable!()
            }
        };
        let mut runtime = Runtime::new(
            thread_root.clone(),
            knowledge_root.clone(),
            scheduled_root,
            agent,
        );

        let created = runtime.create_thread().unwrap();
        let oversized = "x".repeat(MAX_AGENT_MESSAGE_BYTES + 1);
        assert!(
            runtime
                .send_message(created.id.clone(), oversized)
                .unwrap_err()
                .to_string()
                .contains("cannot exceed 65536 bytes")
        );
        assert!(
            runtime
                .threads
                .load(&created.id)
                .unwrap()
                .messages
                .is_empty()
        );
        let stale_temp = thread_root.join(format!(".{}.tmp", created.id));
        fs::write(&stale_temp, "stale interrupted save").unwrap();
        let updated = runtime
            .send_message(created.id.clone(), "hello".into())
            .unwrap();

        assert_eq!(updated.id, created.id);
        assert_eq!(updated.messages.len(), 2);
        assert_eq!(
            updated.messages[1]
                .generation
                .as_ref()
                .map(|generation| (generation.output_tokens, generation.duration_milliseconds)),
            Some((4, 200))
        );
        assert_eq!(runtime.threads.load(&created.id).unwrap(), updated);
        assert!(!stale_temp.exists());
        assert!(runtime.knowledge.list().unwrap().pages.is_empty());

        let page = runtime.save_to_knowledge(created.id.clone()).unwrap();
        assert_eq!(page.source_thread_id, Some(created.id));
        assert_eq!(page.knowledge_base_id, KnowledgeBaseId::default_id());
        assert_eq!(runtime.knowledge.list().unwrap().pages, [page]);

        let project = runtime.create_knowledge_base("Project".into()).unwrap();
        let project = runtime
            .change_category(project.id, "research".into(), true)
            .unwrap();
        assert_eq!(project.categories, [Category::parse("research").unwrap()]);
        runtime
            .select_thread_knowledge_base(updated.id.clone(), project.id.clone())
            .unwrap();
        let project_page = runtime.save_to_knowledge(updated.id.clone()).unwrap();
        assert_eq!(project_page.knowledge_base_id, project.id);
        let edited = runtime
            .update_page(
                project_page.id.clone(),
                "Edited page".into(),
                "research".into(),
                "Edited summary".into(),
                "Edited body".into(),
            )
            .unwrap();
        assert_eq!(edited.source_thread_id, project_page.source_thread_id);
        assert_eq!(edited.telemetry, project_page.telemetry);
        let extra = runtime.create_knowledge_base("Extra".into()).unwrap();
        let sourced = runtime
            .select_thread_sources(
                updated.id.clone(),
                vec![extra.id.clone(), project.id.clone()],
            )
            .unwrap();
        assert_eq!(
            sourced.source_knowledge_base_ids,
            [project.id.clone(), extra.id]
        );

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
    fn due_scheduled_job_claims_once_and_creates_an_ordinary_thread() {
        let root = temp_child();
        let mut runtime = Runtime::new(
            root.join("threads"),
            root.join("knowledge"),
            root.join("scheduled"),
            |request| match request {
                AgentRequest::ThreadMessage { content, .. } => {
                    Ok(AgentResponse::Message(AgentMessage {
                        content: format!("Ran: {content}"),
                        model: "fake".into(),
                        input_tokens: 1,
                        output_tokens: 1,
                        duration_milliseconds: 1,
                    }))
                }
                _ => unreachable!(),
            },
        );
        let mut job = runtime
            .create_scheduled_job(
                "Weekly discovery".into(),
                "0 9 * * 1".into(),
                "Find useful reading".into(),
                vec!["example.com".into()],
            )
            .unwrap();
        job.created_at = Timestamp::from_unix_seconds(0);
        job.next_run_at = Timestamp::from_unix_seconds(60);
        runtime.scheduled.save(&job).unwrap();

        runtime.run_due_jobs();
        runtime.run_due_jobs();

        let jobs = runtime.scheduled.list().unwrap().jobs;
        let threads = runtime.threads.list().unwrap().threads;
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].messages.len(), 2);
        assert_eq!(
            jobs[0].last_thread_id.as_deref(),
            Some(threads[0].id.as_str())
        );
        assert!(jobs[0].last_run_at.is_some());
        fs::remove_dir_all(root).unwrap();
    }
}
