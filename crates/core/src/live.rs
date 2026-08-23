use std::{
    error::Error,
    fmt, io,
    path::PathBuf,
    sync::{
        Arc,
        mpsc::{self, RecvTimeoutError, Sender},
    },
    thread,
    time::Duration,
};

use crate::{
    AnalysisContent, ArtifactBlock, ArtifactSource, CapturedContext, Category, CitedSource,
    GenerationTelemetry, KnowledgeBase, KnowledgeBaseId, KnowledgePage, KnowledgeStore,
    MAX_TRIGGER_DEPTH, PageId, PageVersion, ResearchJob, ResearchJobId, ResearchJobStore,
    RunTelemetry, ScheduledJob, ScheduledJobId, ScheduledJobStore, SourceUrl, StoreError, Thread,
    ThreadId, ThreadKind, ThreadMessage, ThreadRole, ThreadStore, ThreadTrace, Timestamp,
    elide_middle, validate_text,
};
use serde::Serialize;
use serde_json::json;

const MAX_AGENT_TITLE_BYTES: usize = 256;
const MAX_AGENT_SUMMARY_BYTES: usize = 4 * 1024;
const MAX_AGENT_BODY_BYTES: usize = 64 * 1024;
const MAX_AGENT_CONTEXT_BODY_BYTES: usize = 8 * 1024;
const MAX_AGENT_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_CAPTURE_SUMMARY_BYTES: usize = 400;
/// Where an item lands when it is dropped in before anyone decides where it
/// belongs. Never learned as a real category.
pub const UNFILED_CATEGORY: &str = "unfiled";
/// Archived threads are discarded permanently once they are this old.
pub const ARCHIVE_RETENTION_SECONDS: i64 = 30 * 24 * 60 * 60;
pub const MAX_SCREEN_CONTEXT_BYTES: usize = 96 * 1024;
pub const MAX_SKILL_CONTEXT_BYTES: usize = 64 * 1024;
/// Tool ceilings mirror the sidecar's own; both layers refuse independently.
pub const MAX_AGENT_TOOLS: usize = 32;
pub const MAX_TOOL_RESULT_BYTES: usize = 16 * 1024;
const MAX_TOOL_NAME_BYTES: usize = 128;
/// Room for a tool whose description is its manual — `workflow` states a whole
/// node grammar, `autoresearch` a whole job's semantics. Mirrors the sidecar.
const MAX_TOOL_DESCRIPTION_BYTES: usize = 4 * 1024;
const JPEG_DATA_URL_PREFIX: &str = "data:image/jpeg;base64,";

#[derive(Clone, Debug)]
pub enum AgentRequest {
    ThreadMessage {
        thread: Thread,
        content: String,
        knowledge: Vec<AgentKnowledgePage>,
        screen_context: Option<ScreenContext>,
        skill_context: Option<SkillContext>,
        tools: Vec<AgentTool>,
    },
    /// Results of the tool calls the previous step asked for, plus the next step's
    /// tools. The pending-call bookkeeping lives in the sidecar, not here.
    ToolResult {
        thread: Thread,
        results: Vec<AgentToolResult>,
        screen_context: Option<ScreenContext>,
        skill_context: Option<SkillContext>,
        tools: Vec<AgentTool>,
    },
    Analyze {
        thread: Thread,
        text: String,
        /// Categories the user already keeps in the destination base. The agent
        /// files into one of these rather than inventing a private taxonomy.
        categories: Vec<String>,
    },
    ReviseDocument {
        thread: Thread,
        instruction: String,
        document: Vec<ArtifactBlock>,
    },
    ListOpenRouterModels,
    SelectOpenRouterModel {
        model_id: String,
        /// The thinking mode to run this model in, from the set it publishes. Empty
        /// leaves the model on its own default.
        effort: String,
    },
    SelectLocalModel {
        base_url: String,
        model_id: String,
        credential_env: String,
    },
    /// Runs one thread on a model of its own — what a subagent takes — leaving the
    /// app's own selection where it is. An empty model ID clears the pin.
    SetThreadModel {
        thread_id: ThreadId,
        model_id: String,
        effort: String,
    },
    SelectFallbackModel,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterModel {
    pub id: String,
    pub name: String,
    pub context_length: u64,
    /// Non-text inputs the model accepts ("image", "file", "audio"); empty means text only.
    pub input_modalities: Vec<String>,
    /// The thinking modes this model offers, weakest first; empty means no thinking knob.
    pub reasoning_efforts: Vec<String>,
    /// The model always reasons, so "off" is not one of the choices.
    pub reasoning_mandatory: bool,
    /// Zero prompt and completion price. Paid models are listed too — a key gates running
    /// one, not seeing it.
    pub free: bool,
    /// What a million tokens costs, in micro-dollars ($1 = 1_000_000), so a spend budget
    /// adds prices up without floats. `0` is free, or a price OpenRouter did not publish.
    pub prompt_micro_usd_per_mtok: u64,
    pub completion_micro_usd_per_mtok: u64,
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
pub struct ScreenContext {
    pub jpeg_data_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillContext {
    pub instructions: String,
}

impl SkillContext {
    pub fn new(instructions: String) -> Result<Self, LiveError> {
        validate_text("skill context", &instructions, true)
            .map_err(|error| LiveError::new(error.to_string()))?;
        if instructions.len() > MAX_SKILL_CONTEXT_BYTES {
            return Err(LiveError::new("skill context is invalid or too large"));
        }
        Ok(Self { instructions })
    }
}

impl ScreenContext {
    pub fn new(jpeg_data_url: String) -> Result<Self, LiveError> {
        let encoded = jpeg_data_url
            .strip_prefix(JPEG_DATA_URL_PREFIX)
            .ok_or_else(|| LiveError::new("screen context must be a JPEG data URL"))?;
        let content_len = encoded.trim_end_matches('=').len();
        let padding = encoded.len() - content_len;
        if jpeg_data_url.len() > MAX_SCREEN_CONTEXT_BYTES
            || encoded.is_empty()
            || !encoded.len().is_multiple_of(4)
            || padding > 2
            || !encoded[..content_len]
                .bytes()
                .all(|byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/'))
        {
            return Err(LiveError::new("screen context is invalid or too large"));
        }
        Ok(Self { jpeg_data_url })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentMessage {
    pub content: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub duration_milliseconds: u64,
    /// Non-empty when the agent wants tools run before it answers. The caller
    /// executes them behind its own permission gate and submits the results.
    pub tool_calls: Vec<AgentToolCall>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolCall {
    pub id: String,
    pub name: String,
    /// The model's raw JSON arguments. Emma never interprets them here; the
    /// executor validates them against the schema it advertised.
    pub arguments: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentTool {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

impl AgentTool {
    pub fn new(
        name: String,
        description: String,
        input_schema: serde_json::Value,
    ) -> Result<Self, LiveError> {
        validate_text("tool name", &name, true)
            .map_err(|error| LiveError::new(error.to_string()))?;
        validate_text("tool description", &description, true)
            .map_err(|error| LiveError::new(error.to_string()))?;
        if name.len() > MAX_TOOL_NAME_BYTES
            || description.len() > MAX_TOOL_DESCRIPTION_BYTES
            || !input_schema.is_object()
        {
            return Err(LiveError::new("tool definition is invalid or too large"));
        }
        Ok(Self {
            name,
            description,
            input_schema,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentToolResult {
    pub id: String,
    pub content: String,
}

impl AgentToolResult {
    pub fn new(id: String, content: String) -> Result<Self, LiveError> {
        validate_text("tool call id", &id, true)
            .map_err(|error| LiveError::new(error.to_string()))?;
        validate_text("tool result", &content, true)
            .map_err(|error| LiveError::new(format!("tool result is invalid: {error}")))?;
        if id.len() > MAX_TOOL_NAME_BYTES {
            return Err(LiveError::new("tool call id is too long"));
        }
        Ok(Self {
            id,
            content: truncate_tool_result(content),
        })
    }
}

/// One step of a turn: the durable thread as it stands, plus any tool calls the
/// caller must run before the turn can finish.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnOutcome {
    #[serde(flatten)]
    pub thread: Thread,
    pub tool_calls: Vec<AgentToolCall>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentSource {
    pub title: String,
    pub url: String,
}

/// One block of an agent-authored document, before it is validated into an
/// [`ArtifactBlock`]. The agent chooses the block types, so a document can carry
/// charts, tables, and how-to-apply sections instead of a fixed shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentBlock {
    pub id: String,
    pub block_type: String,
    pub payload: serde_json::Value,
    pub fallback: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentAnalysis {
    pub title: String,
    pub category: String,
    pub summary: String,
    pub body: String,
    pub interesting_points: Vec<String>,
    pub counterarguments: Vec<String>,
    pub sources: Vec<AgentSource>,
    pub blocks: Vec<AgentBlock>,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub subagent_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentResponse {
    Message(AgentMessage),
    Analysis(AgentAnalysis),
    Document(Vec<AgentBlock>),
    OpenRouterCatalog(OpenRouterCatalog),
    OpenRouterModelSelected(String),
    LocalModelSelected(String),
    ThreadModelSet,
    FallbackModelSelected,
}

// Not `Eq`: an iteration's measurement is an `f64`, and two of those are not
// equal in the reflexive sense the trait promises.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSnapshot {
    pub threads: Vec<Thread>,
    pub knowledge_bases: Vec<KnowledgeBase>,
    pub pages: Vec<KnowledgePage>,
    pub scheduled_jobs: Vec<ScheduledJob>,
    pub research_jobs: Vec<ResearchJob>,
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
    CreateThread {
        title: Option<String>,
        parent_thread_id: Option<ThreadId>,
        kind: ThreadKind,
        reply: Reply<Thread>,
    },
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
    SetThreadArchived {
        thread_id: ThreadId,
        archived: bool,
        reply: Reply<Thread>,
    },
    RenameThread {
        thread_id: ThreadId,
        title: String,
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
    UpdatePageDocument {
        page_id: PageId,
        title: String,
        category: String,
        summary: String,
        body: String,
        artifacts: Vec<ArtifactBlock>,
        reply: Reply<KnowledgePage>,
    },
    SendMessage {
        thread_id: ThreadId,
        content: String,
        screen_context: Option<ScreenContext>,
        skill_context: Option<SkillContext>,
        tools: Vec<AgentTool>,
        reply: Reply<TurnOutcome>,
    },
    SubmitToolResult {
        thread_id: ThreadId,
        results: Vec<AgentToolResult>,
        screen_context: Option<ScreenContext>,
        skill_context: Option<SkillContext>,
        tools: Vec<AgentTool>,
        reply: Reply<TurnOutcome>,
    },
    RecordTurn {
        thread_id: ThreadId,
        prompt: String,
        response: String,
        output_tokens: u64,
        duration_milliseconds: u64,
        input_tokens: u64,
        model: String,
        reply: Reply<TurnOutcome>,
    },
    RecordTrace {
        thread_id: ThreadId,
        trace: String,
        reply: Reply<()>,
    },
    ReadTrace {
        thread_id: ThreadId,
        reply: Reply<Vec<ThreadTrace>>,
    },
    SaveToKnowledge {
        thread_id: ThreadId,
        reply: Reply<KnowledgePage>,
    },
    CaptureToKnowledge {
        knowledge_base_id: KnowledgeBaseId,
        category: String,
        title: String,
        text: String,
        source_url: Option<String>,
        source_application: Option<String>,
        images: Vec<String>,
        /// The page this capture replaces, for a re-read of something already kept.
        page_id: Option<PageId>,
        reply: Reply<KnowledgePage>,
    },
    AnalyzePage {
        page_id: PageId,
        keep_category: bool,
        reply: Reply<KnowledgePage>,
    },
    ListPageVersions {
        page_id: PageId,
        reply: Reply<Vec<PageVersion>>,
    },
    RestorePageVersion {
        page_id: PageId,
        name: String,
        reply: Reply<KnowledgePage>,
    },
    ChatAboutPage {
        page_id: PageId,
        content: String,
        reply: Reply<Thread>,
    },
    RevisePageDocument {
        page_id: PageId,
        instruction: String,
        reply: Reply<Vec<ArtifactBlock>>,
    },
    ReadPageAsset {
        name: String,
        reply: Reply<String>,
    },
    SaveScheduledJob {
        job_id: Option<ScheduledJobId>,
        title: String,
        schedule: String,
        prompt: String,
        nodes: String,
        source_domains: Vec<String>,
        permission_mode: String,
        reply: Reply<ScheduledJob>,
    },
    SetScheduledJobEnabled {
        job_id: ScheduledJobId,
        enabled: bool,
        reply: Reply<ScheduledJob>,
    },
    DeleteScheduledJob {
        job_id: ScheduledJobId,
        reply: Reply<()>,
    },
    RunScheduledJob {
        job_id: ScheduledJobId,
        variables: String,
        reply: Reply<ScheduledJob>,
    },
    FinishScheduledJob {
        job_id: ScheduledJobId,
        outputs: String,
        depth: u32,
        reply: Reply<ScheduledJob>,
    },
    FireScheduledEvent {
        event: String,
        variables: String,
        reply: Reply<Vec<ScheduledJob>>,
    },
    SaveResearchJob {
        job_id: Option<ResearchJobId>,
        title: String,
        project_dir: String,
        metric_name: String,
        metric_kind: String,
        metric_prompt: String,
        direction: String,
        eval_command: String,
        prompt: String,
        proposer_model: String,
        permission_mode: String,
        max_seconds: u64,
        max_tokens: u64,
        max_micro_dollars: u64,
        reply: Reply<ResearchJob>,
    },
    DeleteResearchJob {
        job_id: ResearchJobId,
        reply: Reply<()>,
    },
    SetResearchJobStatus {
        job_id: ResearchJobId,
        status: String,
        note: String,
        reply: Reply<ResearchJob>,
    },
    SetResearchJobThread {
        job_id: ResearchJobId,
        thread_id: ThreadId,
        reply: Reply<ResearchJob>,
    },
    RecordResearchIteration {
        job_id: ResearchJobId,
        value: Option<f64>,
        outcome: String,
        note: String,
        commit: String,
        duration_ms: u64,
        input_tokens: u64,
        output_tokens: u64,
        micro_dollars: u64,
        reply: Reply<ResearchJob>,
    },
    ListOpenRouterModels(Reply<OpenRouterCatalog>),
    SelectOpenRouterModel {
        model_id: String,
        effort: String,
        reply: Reply<String>,
    },
    SelectLocalModel {
        base_url: String,
        model_id: String,
        credential_env: String,
        reply: Reply<String>,
    },
    SetThreadModel {
        thread_id: ThreadId,
        model_id: String,
        effort: String,
        reply: Reply<()>,
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

    /// A sub thread and a subagent's transcript are both owned child threads and
    /// both stay ordinary threads on disk; `kind` is what separates the two.
    pub fn create_thread(
        &self,
        title: Option<String>,
        parent_thread_id: Option<ThreadId>,
        kind: ThreadKind,
    ) -> Result<Thread, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::CreateThread {
                title,
                parent_thread_id,
                kind,
                reply,
            })
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

    pub fn set_thread_archived(
        &self,
        thread_id: ThreadId,
        archived: bool,
    ) -> Result<Thread, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SetThreadArchived {
                thread_id,
                archived,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before archiving the thread"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while archiving the thread"))?
    }

    pub fn rename_thread(&self, thread_id: ThreadId, title: String) -> Result<Thread, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::RenameThread {
                thread_id,
                title,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before renaming the thread"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while renaming the thread"))?
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

    pub fn send_message(
        &self,
        thread_id: ThreadId,
        content: String,
        screen_context: Option<ScreenContext>,
        skill_context: Option<SkillContext>,
        tools: Vec<AgentTool>,
    ) -> Result<TurnOutcome, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SendMessage {
                thread_id,
                content,
                screen_context,
                skill_context,
                tools,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before sending the message"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while sending the message"))?
    }

    /// Writes a turn that already ran elsewhere into the durable thread.
    ///
    /// The coding harness owns the live session, its tool calls and its own
    /// history; this is the one-way sync back, so the Markdown thread stays the
    /// record of what was said even though core never drove the model.
    pub fn record_turn(
        &self,
        thread_id: ThreadId,
        prompt: String,
        response: String,
        output_tokens: u64,
        duration_milliseconds: u64,
        input_tokens: u64,
        model: String,
    ) -> Result<TurnOutcome, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::RecordTurn {
                thread_id,
                prompt,
                response,
                output_tokens,
                duration_milliseconds,
                input_tokens,
                model,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before recording the turn"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while recording the turn"))?
    }

    /// Stores one finished turn's execution trace on the thread.
    ///
    /// Separate from `record_turn` because it has to serve both paths: the
    /// coding harness's turn is written by `record_turn`, but Emma's own loop
    /// has its answer written from inside `finish_step`, and neither knows about
    /// the other's trace. A trace is its own block on the thread, so it never
    /// has to arrive in step with a message.
    pub fn record_trace(&self, thread_id: ThreadId, trace: String) -> Result<(), LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::RecordTrace {
                thread_id,
                trace,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before recording the trace"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while recording the trace"))?
    }

    /// This thread's traces, oldest first, for an agent reading back what it did.
    pub fn read_trace(&self, thread_id: ThreadId) -> Result<Vec<ThreadTrace>, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::ReadTrace { thread_id, reply })
            .map_err(|_| LiveError::new("Emma runtime stopped before reading the trace"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while reading the trace"))?
    }

    pub fn submit_tool_result(
        &self,
        thread_id: ThreadId,
        results: Vec<AgentToolResult>,
        screen_context: Option<ScreenContext>,
        skill_context: Option<SkillContext>,
        tools: Vec<AgentTool>,
    ) -> Result<TurnOutcome, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SubmitToolResult {
                thread_id,
                results,
                screen_context,
                skill_context,
                tools,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before submitting tool results"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while submitting tool results"))?
    }

    pub fn update_page_document(
        &self,
        page_id: PageId,
        title: String,
        category: String,
        summary: String,
        body: String,
        artifacts: Vec<ArtifactBlock>,
    ) -> Result<KnowledgePage, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::UpdatePageDocument {
                page_id,
                title,
                category,
                summary,
                body,
                artifacts,
                reply,
            })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before updating the page document")
            })?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while updating the page document"))?
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

    #[allow(clippy::too_many_arguments)]
    pub fn capture_to_knowledge(
        &self,
        knowledge_base_id: KnowledgeBaseId,
        category: String,
        title: String,
        text: String,
        source_url: Option<String>,
        source_application: Option<String>,
        images: Vec<String>,
        page_id: Option<PageId>,
    ) -> Result<KnowledgePage, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::CaptureToKnowledge {
                knowledge_base_id,
                category,
                title,
                text,
                source_url,
                source_application,
                images,
                page_id,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before filing the item"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while filing the item"))?
    }

    /// Turns a captured item into an analyzed document: Emma files it into one
    /// of the base's categories and authors the blocks.
    /// `keep_category` builds the document but leaves the filing alone, for bases that
    /// have not yet taught Emma what their categories look like.
    pub fn analyze_page(
        &self,
        page_id: PageId,
        keep_category: bool,
    ) -> Result<KnowledgePage, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::AnalyzePage {
                page_id,
                keep_category,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before building the document"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while building the document"))?
    }

    pub fn list_page_versions(&self, page_id: PageId) -> Result<Vec<PageVersion>, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::ListPageVersions { page_id, reply })
            .map_err(|_| LiveError::new("Emma runtime stopped before listing versions"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while listing versions"))?
    }

    pub fn restore_page_version(
        &self,
        page_id: PageId,
        name: String,
    ) -> Result<KnowledgePage, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::RestorePageVersion {
                page_id,
                name,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before restoring the version"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while restoring the version"))?
    }

    pub fn chat_about_page(&self, page_id: PageId, content: String) -> Result<Thread, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::ChatAboutPage {
                page_id,
                content,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before opening the conversation"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while opening the conversation"))?
    }

    pub fn revise_page_document(
        &self,
        page_id: PageId,
        instruction: String,
    ) -> Result<Vec<ArtifactBlock>, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::RevisePageDocument {
                page_id,
                instruction,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before drafting the revision"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while drafting the revision"))?
    }

    pub fn read_page_asset(&self, name: String) -> Result<String, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::ReadPageAsset { name, reply })
            .map_err(|_| LiveError::new("Emma runtime stopped before reading the attachment"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while reading the attachment"))?
    }

    /// Creates when `job_id` is `None`, otherwise rewrites that job in place. One
    /// call either way: the workspace form and Emma's own workflow tool both edit
    /// a job by saving the whole of it.
    #[allow(clippy::too_many_arguments)]
    pub fn save_scheduled_job(
        &self,
        job_id: Option<ScheduledJobId>,
        title: String,
        schedule: String,
        prompt: String,
        nodes: String,
        source_domains: Vec<String>,
        permission_mode: String,
    ) -> Result<ScheduledJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SaveScheduledJob {
                job_id,
                title,
                schedule,
                prompt,
                nodes,
                source_domains,
                permission_mode,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before saving the scheduled job"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while saving the scheduled job"))?
    }

    pub fn delete_scheduled_job(&self, job_id: ScheduledJobId) -> Result<(), LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::DeleteScheduledJob { job_id, reply })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before deleting the scheduled job")
            })?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while deleting the scheduled job"))?
    }

    /// Fires one job now, whatever its trigger says and whether or not it is paused:
    /// this is a person, or Emma on their behalf, asking for a run. The run itself
    /// is handed out through the job sink exactly as a due run is.
    pub fn run_scheduled_job(
        &self,
        job_id: ScheduledJobId,
        variables: String,
    ) -> Result<ScheduledJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::RunScheduledJob {
                job_id,
                variables,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before running the scheduled job"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while running the scheduled job"))?
    }

    /// Records what a finished run produced and fires whatever was waiting on it.
    /// Downstream jobs inherit those outputs as their starting variables, which is
    /// the whole of how one workflow depends on another.
    pub fn finish_scheduled_job(
        &self,
        job_id: ScheduledJobId,
        outputs: String,
        depth: u32,
    ) -> Result<ScheduledJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::FinishScheduledJob {
                job_id,
                outputs,
                depth,
                reply,
            })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before finishing the scheduled job")
            })?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while finishing the scheduled job"))?
    }

    /// Raises one of the app's own events. Every enabled job triggered `on <event>`
    /// runs, with the event's variables as its starting point.
    pub fn fire_scheduled_event(
        &self,
        event: String,
        variables: String,
    ) -> Result<Vec<ScheduledJob>, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::FireScheduledEvent {
                event,
                variables,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before raising the event"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while raising the event"))?
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

    /// Creates when `job_id` is `None`, otherwise rewrites that job in place. An
    /// edit refuses to move the metric — see `ResearchJob::apply_edit`.
    #[allow(clippy::too_many_arguments)]
    pub fn save_research_job(
        &self,
        job_id: Option<ResearchJobId>,
        title: String,
        project_dir: String,
        metric_name: String,
        metric_kind: String,
        metric_prompt: String,
        direction: String,
        eval_command: String,
        prompt: String,
        proposer_model: String,
        permission_mode: String,
        max_seconds: u64,
        max_tokens: u64,
        max_micro_dollars: u64,
    ) -> Result<ResearchJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SaveResearchJob {
                job_id,
                title,
                project_dir,
                metric_name,
                metric_kind,
                metric_prompt,
                direction,
                eval_command,
                prompt,
                proposer_model,
                permission_mode,
                max_seconds,
                max_tokens,
                max_micro_dollars,
                reply,
            })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before saving the autoresearch job")
            })?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while saving the autoresearch job"))?
    }

    pub fn delete_research_job(&self, job_id: ResearchJobId) -> Result<(), LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::DeleteResearchJob { job_id, reply })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before deleting the autoresearch job")
            })?;
        result.recv().map_err(|_| {
            LiveError::new("Emma runtime stopped while deleting the autoresearch job")
        })?
    }

    /// Play, pause, and the two ways a job ends. The note says which budget ran out
    /// or what failed, so a paused job explains itself without a log.
    pub fn set_research_job_status(
        &self,
        job_id: ResearchJobId,
        status: String,
        note: String,
    ) -> Result<ResearchJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SetResearchJobStatus {
                job_id,
                status,
                note,
                reply,
            })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before updating the autoresearch job")
            })?;
        result.recv().map_err(|_| {
            LiveError::new("Emma runtime stopped while updating the autoresearch job")
        })?
    }

    /// The app opens the job's thread and tells core which one it is, exactly as a
    /// due scheduled run records the thread it was handed.
    pub fn set_research_job_thread(
        &self,
        job_id: ResearchJobId,
        thread_id: ThreadId,
    ) -> Result<ResearchJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SetResearchJobThread {
                job_id,
                thread_id,
                reply,
            })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before updating the autoresearch job")
            })?;
        result.recv().map_err(|_| {
            LiveError::new("Emma runtime stopped while updating the autoresearch job")
        })?
    }

    /// One finished attempt. The caller reports what happened; the index, the
    /// best-so-far and the running totals are core's to work out.
    #[allow(clippy::too_many_arguments)]
    pub fn record_research_iteration(
        &self,
        job_id: ResearchJobId,
        value: Option<f64>,
        outcome: String,
        note: String,
        commit: String,
        duration_ms: u64,
        input_tokens: u64,
        output_tokens: u64,
        micro_dollars: u64,
    ) -> Result<ResearchJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::RecordResearchIteration {
                job_id,
                value,
                outcome,
                note,
                commit,
                duration_ms,
                input_tokens,
                output_tokens,
                micro_dollars,
                reply,
            })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before recording the autoresearch iteration")
            })?;
        result.recv().map_err(|_| {
            LiveError::new("Emma runtime stopped while recording the autoresearch iteration")
        })?
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

    pub fn select_openrouter_model(
        &self,
        model_id: String,
        effort: String,
    ) -> Result<String, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SelectOpenRouterModel {
                model_id,
                effort,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before selecting the model"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while selecting the model"))?
    }

    /// Pins one thread to a model of its own, without moving the app's selection.
    ///
    /// What a subagent runs on: the parent picks the route, the thread it spawns
    /// takes it for its whole life. An empty model ID puts the thread back on the
    /// selected model.
    pub fn set_thread_model(
        &self,
        thread_id: ThreadId,
        model_id: String,
        effort: String,
    ) -> Result<(), LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SetThreadModel {
                thread_id,
                model_id,
                effort,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before setting the thread's model"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while setting the thread's model"))?
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

/// One scheduled job that just came due, with its thread already created and saved.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueJob {
    pub job_id: String,
    pub thread_id: String,
    pub title: String,
    pub prompt: String,
    /// The job's node graph as stored, empty for a job that is one step on `prompt`.
    pub nodes: String,
    /// What this run starts with: the outputs of the job that triggered it, or the
    /// variables the event carried. Empty for a run nothing handed anything to.
    pub variables: String,
    pub permission_mode: String,
    /// How many triggers deep this run is, so the app can pass it back when the run
    /// finishes and core can stop a chain that feeds itself.
    pub depth: u32,
}

/// Called when a job comes due. The caller runs the turn rather than core doing it,
/// because the tools a job may use — the filesystem, the shell, the pointer — live
/// in the app process, and an unattended run gets the mode it was saved with.
/// Runs on the live runtime thread, so it must not block on anything that thread drives.
pub type JobSink = Arc<dyn Fn(DueJob) + Send + Sync>;

pub fn start_live_runtime<A>(
    thread_root: PathBuf,
    knowledge_root: PathBuf,
    knowledge_export: Option<PathBuf>,
    scheduled_root: PathBuf,
    research_root: PathBuf,
    jobs: JobSink,
    agent: A,
) -> Result<LiveClient, LiveError>
where
    A: FnMut(AgentRequest) -> Result<AgentResponse, LiveError> + Send + 'static,
{
    let (commands, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("emma-live-runtime".into())
        .spawn(move || {
            let mut runtime = Runtime::new(
                thread_root,
                knowledge_root,
                knowledge_export,
                scheduled_root,
                research_root,
                jobs,
                agent,
            );
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
    research: ResearchJobStore,
    jobs: JobSink,
    agent: A,
}

impl<A> Runtime<A>
where
    A: FnMut(AgentRequest) -> Result<AgentResponse, LiveError>,
{
    fn new(
        thread_root: PathBuf,
        knowledge_root: PathBuf,
        knowledge_export: Option<PathBuf>,
        scheduled_root: PathBuf,
        research_root: PathBuf,
        jobs: JobSink,
        agent: A,
    ) -> Self {
        let knowledge = KnowledgeStore::new(knowledge_root);
        Self {
            threads: ThreadStore::new(thread_root),
            knowledge: match knowledge_export {
                Some(export) => knowledge.with_export(export),
                None => knowledge,
            },
            scheduled: ScheduledJobStore::new(scheduled_root),
            research: ResearchJobStore::new(research_root),
            jobs,
            agent,
        }
    }

    fn handle(&mut self, command: Command) {
        match command {
            Command::Snapshot(reply) => {
                let _ = reply.send(self.snapshot());
            }
            Command::CreateThread {
                title,
                parent_thread_id,
                kind,
                reply,
            } => {
                let _ = reply.send(self.create_thread(title, parent_thread_id, kind));
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
            Command::SetThreadArchived {
                thread_id,
                archived,
                reply,
            } => {
                let _ = reply.send(self.set_thread_archived(thread_id, archived));
            }
            Command::RenameThread {
                thread_id,
                title,
                reply,
            } => {
                let _ = reply.send(self.rename_thread(thread_id, title));
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
            Command::UpdatePageDocument {
                page_id,
                title,
                category,
                summary,
                body,
                artifacts,
                reply,
            } => {
                let _ = reply.send(
                    self.update_page_document(page_id, title, category, summary, body, artifacts),
                );
            }
            Command::SendMessage {
                thread_id,
                content,
                screen_context,
                skill_context,
                tools,
                reply,
            } => {
                let _ = reply.send(self.send_message(
                    thread_id,
                    content,
                    screen_context,
                    skill_context,
                    tools,
                ));
            }
            Command::SubmitToolResult {
                thread_id,
                results,
                screen_context,
                skill_context,
                tools,
                reply,
            } => {
                let _ = reply.send(self.submit_tool_result(
                    thread_id,
                    results,
                    screen_context,
                    skill_context,
                    tools,
                ));
            }
            Command::RecordTurn {
                thread_id,
                prompt,
                response,
                output_tokens,
                duration_milliseconds,
                input_tokens,
                model,
                reply,
            } => {
                let _ = reply.send(self.record_turn(
                    thread_id,
                    prompt,
                    response,
                    output_tokens,
                    duration_milliseconds,
                    input_tokens,
                    model,
                ));
            }
            Command::RecordTrace {
                thread_id,
                trace,
                reply,
            } => {
                let _ = reply.send(self.record_trace(thread_id, trace));
            }
            Command::ReadTrace { thread_id, reply } => {
                let _ = reply.send(self.read_trace(thread_id));
            }
            Command::SaveToKnowledge { thread_id, reply } => {
                let _ = reply.send(self.save_to_knowledge(thread_id));
            }
            Command::CaptureToKnowledge {
                knowledge_base_id,
                category,
                title,
                text,
                source_url,
                source_application,
                images,
                page_id,
                reply,
            } => {
                let _ = reply.send(self.capture_to_knowledge(
                    knowledge_base_id,
                    category,
                    title,
                    text,
                    source_url,
                    source_application,
                    images,
                    page_id,
                ));
            }
            Command::AnalyzePage {
                page_id,
                keep_category,
                reply,
            } => {
                let _ = reply.send(self.analyze_page(page_id, keep_category));
            }
            Command::ListPageVersions { page_id, reply } => {
                let _ = reply.send(self.list_page_versions(&page_id));
            }
            Command::RestorePageVersion {
                page_id,
                name,
                reply,
            } => {
                let _ = reply.send(self.restore_page_version(&page_id, &name));
            }
            Command::ChatAboutPage {
                page_id,
                content,
                reply,
            } => {
                let _ = reply.send(self.chat_about_page(page_id, content));
            }
            Command::RevisePageDocument {
                page_id,
                instruction,
                reply,
            } => {
                let _ = reply.send(self.revise_page_document(page_id, instruction));
            }
            Command::ReadPageAsset { name, reply } => {
                let _ = reply.send(self.read_page_asset(&name));
            }
            Command::SaveScheduledJob {
                job_id,
                title,
                schedule,
                prompt,
                nodes,
                source_domains,
                permission_mode,
                reply,
            } => {
                let _ = reply.send(self.save_scheduled_job(
                    job_id,
                    title,
                    schedule,
                    prompt,
                    nodes,
                    source_domains,
                    permission_mode,
                ));
            }
            Command::SetScheduledJobEnabled {
                job_id,
                enabled,
                reply,
            } => {
                let _ = reply.send(self.set_scheduled_job_enabled(job_id, enabled));
            }
            Command::DeleteScheduledJob { job_id, reply } => {
                let _ = reply.send(self.delete_scheduled_job(job_id));
            }
            Command::RunScheduledJob {
                job_id,
                variables,
                reply,
            } => {
                let _ = reply.send(self.run_scheduled_job(job_id, variables));
            }
            Command::FinishScheduledJob {
                job_id,
                outputs,
                depth,
                reply,
            } => {
                let _ = reply.send(self.finish_scheduled_job(job_id, outputs, depth));
            }
            Command::FireScheduledEvent {
                event,
                variables,
                reply,
            } => {
                let _ = reply.send(self.fire_scheduled_event(event, variables));
            }
            Command::SaveResearchJob {
                job_id,
                title,
                project_dir,
                metric_name,
                metric_kind,
                metric_prompt,
                direction,
                eval_command,
                prompt,
                proposer_model,
                permission_mode,
                max_seconds,
                max_tokens,
                max_micro_dollars,
                reply,
            } => {
                let _ = reply.send(self.save_research_job(
                    job_id,
                    title,
                    project_dir,
                    metric_name,
                    metric_kind,
                    metric_prompt,
                    direction,
                    eval_command,
                    prompt,
                    proposer_model,
                    permission_mode,
                    max_seconds,
                    max_tokens,
                    max_micro_dollars,
                ));
            }
            Command::DeleteResearchJob { job_id, reply } => {
                let _ = reply.send(self.delete_research_job(job_id));
            }
            Command::SetResearchJobStatus {
                job_id,
                status,
                note,
                reply,
            } => {
                let _ = reply.send(self.set_research_job_status(job_id, status, note));
            }
            Command::SetResearchJobThread {
                job_id,
                thread_id,
                reply,
            } => {
                let _ = reply.send(self.set_research_job_thread(job_id, thread_id));
            }
            Command::RecordResearchIteration {
                job_id,
                value,
                outcome,
                note,
                commit,
                duration_ms,
                input_tokens,
                output_tokens,
                micro_dollars,
                reply,
            } => {
                let _ = reply.send(self.record_research_iteration(
                    job_id,
                    value,
                    outcome,
                    note,
                    commit,
                    duration_ms,
                    input_tokens,
                    output_tokens,
                    micro_dollars,
                ));
            }
            Command::ListOpenRouterModels(reply) => {
                let _ = reply.send(self.list_openrouter_models());
            }
            Command::SelectOpenRouterModel {
                model_id,
                effort,
                reply,
            } => {
                let _ = reply.send(self.select_openrouter_model(model_id, effort));
            }
            Command::SelectLocalModel {
                base_url,
                model_id,
                credential_env,
                reply,
            } => {
                let _ = reply.send(self.select_local_model(base_url, model_id, credential_env));
            }
            Command::SetThreadModel {
                thread_id,
                model_id,
                effort,
                reply,
            } => {
                let _ = reply.send(self.set_thread_model(thread_id, model_id, effort));
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
            let _ = self.hand_out_run(&mut job, String::new(), 0);
        }
    }

    /// Opens the run's thread, records it on the job, and hands the run to the app.
    /// Handed out rather than run here: a job is a full agent turn under the mode it
    /// was saved with, and the tools that mode gates live in the app process.
    fn hand_out_run(
        &mut self,
        job: &mut ScheduledJob,
        variables: String,
        depth: u32,
    ) -> Result<(), LiveError> {
        let mut thread = Thread::new(job.title.clone(), Timestamp::now())
            .map_err(|error| LiveError::new(format!("could not open the run's thread: {error}")))?;
        thread.scheduled_job_id = Some(job.id.clone());
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save the run's thread: {error}")))?;
        job.last_thread_id = Some(thread.id.to_string());
        self.scheduled
            .save(job)
            .map_err(|error| LiveError::new(format!("could not save scheduled job: {error}")))?;
        (self.jobs)(DueJob {
            job_id: job.id.as_str().to_string(),
            thread_id: thread.id.to_string(),
            title: job.title.clone(),
            prompt: job.prompt.clone(),
            nodes: job.nodes.clone(),
            variables,
            permission_mode: job.permission_mode.clone(),
            depth,
        });
        Ok(())
    }

    /// Every enabled job whose trigger is exactly `key` — `after <job-id>` or
    /// `on <event>` — started with the same variables. Past the depth ceiling
    /// nothing fires: that is the loop breaker.
    fn fire_trigger(
        &mut self,
        key: &str,
        variables: String,
        depth: u32,
    ) -> Result<Vec<ScheduledJob>, LiveError> {
        if depth > MAX_TRIGGER_DEPTH {
            return Ok(Vec::new());
        }
        let listing = self
            .scheduled
            .list()
            .map_err(|error| LiveError::new(format!("could not load scheduled jobs: {error}")))?;
        let mut fired = Vec::new();
        for mut job in listing.jobs {
            if !job.enabled || job.schedule != key {
                continue;
            }
            job.start_run(Timestamp::now());
            if self
                .hand_out_run(&mut job, variables.clone(), depth)
                .is_ok()
            {
                fired.push(job);
            }
        }
        Ok(fired)
    }

    fn list_openrouter_models(&mut self) -> Result<OpenRouterCatalog, LiveError> {
        match (self.agent)(AgentRequest::ListOpenRouterModels)? {
            AgentResponse::OpenRouterCatalog(catalog) => Ok(catalog),
            _ => Err(LiveError::new(
                "agent returned an unexpected response for the OpenRouter catalog",
            )),
        }
    }

    fn select_openrouter_model(
        &mut self,
        model_id: String,
        effort: String,
    ) -> Result<String, LiveError> {
        match (self.agent)(AgentRequest::SelectOpenRouterModel { model_id, effort })? {
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

    fn set_thread_model(
        &mut self,
        thread_id: ThreadId,
        model_id: String,
        effort: String,
    ) -> Result<(), LiveError> {
        match (self.agent)(AgentRequest::SetThreadModel {
            thread_id,
            model_id,
            effort,
        })? {
            AgentResponse::ThreadModelSet => Ok(()),
            _ => Err(LiveError::new(
                "agent returned an unexpected response after setting the thread's model",
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
        let mut thread_listing = self
            .threads
            .list()
            .map_err(|error| LiveError::new(format!("could not load threads: {error}")))?;
        let expired = Timestamp::now().unix_seconds() - ARCHIVE_RETENTION_SECONDS;
        thread_listing.threads.retain(|thread| {
            let keep = thread
                .archived_at
                .is_none_or(|at| at.unix_seconds() > expired);
            if !keep {
                let _ = self.threads.delete(&thread.id);
            }
            keep
        });
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
        let research_listing = self.research.list().map_err(|error| {
            LiveError::new(format!("could not load autoresearch jobs: {error}"))
        })?;
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
        warnings.extend(
            research_listing
                .malformed
                .into_iter()
                .map(|(path, reason)| {
                    format!(
                        "Skipped malformed autoresearch job {}: {}",
                        path.display(),
                        reason
                    )
                }),
        );
        Ok(LiveSnapshot {
            threads: thread_listing.threads,
            knowledge_bases: base_listing.bases,
            pages: page_listing.pages,
            scheduled_jobs: job_listing.jobs,
            research_jobs: research_listing.jobs,
            warnings,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn save_scheduled_job(
        &self,
        job_id: Option<ScheduledJobId>,
        title: String,
        schedule: String,
        prompt: String,
        nodes: String,
        source_domains: Vec<String>,
        permission_mode: String,
    ) -> Result<ScheduledJob, LiveError> {
        // An edit keeps everything the job earned by existing — when it was made,
        // whether it is paused, what its last run produced — and replaces only what
        // was saved. Rebuilding it from scratch would silently resume a paused job.
        let existing = match &job_id {
            Some(id) => Some(
                self.scheduled
                    .load(id)
                    .map_err(|error| LiveError::new(format!("no such scheduled job: {error}")))?,
            ),
            None => None,
        };
        let mut job = ScheduledJob::new(
            title,
            schedule,
            prompt,
            nodes,
            source_domains,
            permission_mode,
            existing
                .as_ref()
                .map_or_else(Timestamp::now, |job| job.created_at),
        )
        .map_err(|error| LiveError::new(format!("scheduled job is invalid: {error}")))?;
        if let Some(existing) = existing {
            job.id = existing.id;
            job.enabled = existing.enabled;
            job.last_run_at = existing.last_run_at;
            job.last_thread_id = existing.last_thread_id;
            job.outputs = existing.outputs;
            // A booking survives only while the trigger it was made for does.
            if existing.schedule == job.schedule {
                job.next_run_at = existing.next_run_at;
            }
        }
        self.scheduled
            .save(&job)
            .map_err(|error| LiveError::new(format!("could not save scheduled job: {error}")))?;
        Ok(job)
    }

    fn delete_scheduled_job(&self, job_id: ScheduledJobId) -> Result<(), LiveError> {
        self.scheduled
            .delete(&job_id)
            .map_err(|error| LiveError::new(format!("could not delete scheduled job: {error}")))
    }

    fn run_scheduled_job(
        &mut self,
        job_id: ScheduledJobId,
        variables: String,
    ) -> Result<ScheduledJob, LiveError> {
        let mut job = self
            .scheduled
            .load(&job_id)
            .map_err(|error| LiveError::new(format!("could not load scheduled job: {error}")))?;
        job.start_run(Timestamp::now());
        self.hand_out_run(&mut job, variables, 0)?;
        Ok(job)
    }

    fn finish_scheduled_job(
        &mut self,
        job_id: ScheduledJobId,
        outputs: String,
        depth: u32,
    ) -> Result<ScheduledJob, LiveError> {
        let mut job = self
            .scheduled
            .load(&job_id)
            .map_err(|error| LiveError::new(format!("could not load scheduled job: {error}")))?;
        job.set_outputs(outputs.clone())
            .map_err(|error| LiveError::new(format!("run outputs are invalid: {error}")))?;
        self.scheduled
            .save(&job)
            .map_err(|error| LiveError::new(format!("could not save scheduled job: {error}")))?;
        self.fire_trigger(&format!("after {job_id}"), outputs, depth + 1)?;
        Ok(job)
    }

    fn fire_scheduled_event(
        &mut self,
        event: String,
        variables: String,
    ) -> Result<Vec<ScheduledJob>, LiveError> {
        self.fire_trigger(&format!("on {}", event.trim()), variables, 0)
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

    #[allow(clippy::too_many_arguments)]
    fn save_research_job(
        &self,
        job_id: Option<ResearchJobId>,
        title: String,
        project_dir: String,
        metric_name: String,
        metric_kind: String,
        metric_prompt: String,
        direction: String,
        eval_command: String,
        prompt: String,
        proposer_model: String,
        permission_mode: String,
        max_seconds: u64,
        max_tokens: u64,
        max_micro_dollars: u64,
    ) -> Result<ResearchJob, LiveError> {
        // An edit is applied to the stored job rather than rebuilt from the form,
        // because everything the job earned by running — its iterations, its spend,
        // whether it is paused — is not in the form, and the metric it was measured
        // against is what `apply_edit` refuses to let the form move.
        let job = match job_id {
            Some(id) => {
                let mut job = self.research.load(&id).map_err(|error| {
                    LiveError::new(format!("no such autoresearch job: {error}"))
                })?;
                job.apply_edit(
                    title,
                    project_dir,
                    metric_name,
                    metric_kind,
                    direction,
                    eval_command,
                    prompt,
                    proposer_model,
                    permission_mode,
                    max_seconds,
                    max_tokens,
                    max_micro_dollars,
                )
                .map_err(|error| LiveError::new(error.to_string()))?;
                job
            }
            None => ResearchJob::new(
                title,
                project_dir,
                metric_name,
                metric_kind,
                metric_prompt,
                direction,
                eval_command,
                prompt,
                proposer_model,
                permission_mode,
                max_seconds,
                max_tokens,
                max_micro_dollars,
                Timestamp::now(),
            )
            .map_err(|error| LiveError::new(format!("autoresearch job is invalid: {error}")))?,
        };
        self.research
            .save(&job)
            .map_err(|error| LiveError::new(format!("could not save autoresearch job: {error}")))?;
        Ok(job)
    }

    fn delete_research_job(&self, job_id: ResearchJobId) -> Result<(), LiveError> {
        self.research
            .delete(&job_id)
            .map_err(|error| LiveError::new(format!("could not delete autoresearch job: {error}")))
    }

    fn set_research_job_status(
        &self,
        job_id: ResearchJobId,
        status: String,
        note: String,
    ) -> Result<ResearchJob, LiveError> {
        let mut job = self
            .research
            .load(&job_id)
            .map_err(|error| LiveError::new(format!("could not load autoresearch job: {error}")))?;
        job.set_status(status, note)
            .map_err(|error| LiveError::new(error.to_string()))?;
        self.research
            .save(&job)
            .map_err(|error| LiveError::new(format!("could not save autoresearch job: {error}")))?;
        Ok(job)
    }

    fn set_research_job_thread(
        &self,
        job_id: ResearchJobId,
        thread_id: ThreadId,
    ) -> Result<ResearchJob, LiveError> {
        let mut job = self
            .research
            .load(&job_id)
            .map_err(|error| LiveError::new(format!("could not load autoresearch job: {error}")))?;
        job.thread_id = Some(thread_id.to_string());
        self.research
            .save(&job)
            .map_err(|error| LiveError::new(format!("could not save autoresearch job: {error}")))?;
        Ok(job)
    }

    #[allow(clippy::too_many_arguments)]
    fn record_research_iteration(
        &self,
        job_id: ResearchJobId,
        value: Option<f64>,
        outcome: String,
        note: String,
        commit: String,
        duration_ms: u64,
        input_tokens: u64,
        output_tokens: u64,
        micro_dollars: u64,
    ) -> Result<ResearchJob, LiveError> {
        let mut job = self
            .research
            .load(&job_id)
            .map_err(|error| LiveError::new(format!("could not load autoresearch job: {error}")))?;
        job.record_iteration(
            value,
            outcome,
            note,
            commit,
            duration_ms,
            input_tokens,
            output_tokens,
            micro_dollars,
            Timestamp::now(),
        )
        .map_err(|error| LiveError::new(error.to_string()))?;
        // The seconds budget is wall clock over every run, so it grows by the time
        // this attempt took — nobody times the job from outside.
        job.add_seconds(duration_ms / 1000);
        self.research
            .save(&job)
            .map_err(|error| LiveError::new(format!("could not save autoresearch job: {error}")))?;
        Ok(job)
    }

    fn create_thread(
        &self,
        title: Option<String>,
        parent_thread_id: Option<ThreadId>,
        kind: ThreadKind,
    ) -> Result<Thread, LiveError> {
        let title = title.unwrap_or_else(|| "New thread".to_owned());
        validate_agent_text("thread title", &title, true, MAX_AGENT_TITLE_BYTES)?;
        let mut thread = Thread::new(title, Timestamp::now())
            .map_err(|error| LiveError::new(format!("could not create thread: {error}")))?;
        if let Some(parent) = parent_thread_id {
            // A parent that is not on disk would orphan the child in the agent list.
            let owner = self.threads.load(&parent).map_err(|error| {
                LiveError::new(format!("parent thread {parent} is unusable: {error}"))
            })?;
            // A sub thread lands in its parent's project, which is where the user
            // expects to find it; a subagent's transcript is never listed anyway.
            thread.knowledge_base_id = owner.knowledge_base_id.clone();
            thread.source_knowledge_base_ids = owner.source_knowledge_base_ids.clone();
            thread.parent_thread_id = Some(parent);
        } else if kind == ThreadKind::Subagent {
            return Err(LiveError::new("a subagent thread must have a parent"));
        }
        thread.kind = kind;
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

    fn set_thread_archived(
        &self,
        thread_id: ThreadId,
        archived: bool,
    ) -> Result<Thread, LiveError> {
        let mut thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        thread.archived_at = archived.then(Timestamp::now);
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save archived thread: {error}")))?;
        Ok(thread)
    }

    /// A title the user typed goes through the same gate as one Emma derived: the
    /// thread file writes it as a header field, so a newline in it is a corrupt file.
    fn rename_thread(&self, thread_id: ThreadId, title: String) -> Result<Thread, LiveError> {
        // ponytail: whitespace collapsed and cut at 120 chars — a nav row shows far
        // less than that. Widen the cap if titles ever get their own detail view.
        let title: String = title.split_whitespace().collect::<Vec<_>>().join(" ");
        let title: String = title.chars().take(120).collect();
        validate_text("thread title", &title, true)
            .map_err(|error| LiveError::new(format!("thread title is invalid: {error}")))?;
        let mut thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        thread.title = title;
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save renamed thread: {error}")))?;
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
        let artifacts = self
            .knowledge
            .load(&id)
            .map_err(|error| LiveError::new(format!("could not load page {id}: {error}")))?
            .artifacts;
        self.update_page_document(id, title, category, summary, body, artifacts)
    }

    fn update_page_document(
        &self,
        id: PageId,
        title: String,
        category: String,
        summary: String,
        body: String,
        artifacts: Vec<ArtifactBlock>,
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
        page.replace_artifacts(artifacts)
            .map_err(|error| LiveError::new(format!("page artifacts are invalid: {error}")))?;
        self.knowledge
            .save_versioned(&page)
            .map_err(|error| LiveError::new(format!("could not update page: {error}")))?;
        Ok(page)
    }

    fn send_message(
        &mut self,
        thread_id: ThreadId,
        content: String,
        screen_context: Option<ScreenContext>,
        skill_context: Option<SkillContext>,
        tools: Vec<AgentTool>,
    ) -> Result<TurnOutcome, LiveError> {
        validate_agent_text("prompt", &content, true, MAX_AGENT_MESSAGE_BYTES)?;
        if tools.len() > MAX_AGENT_TOOLS {
            return Err(LiveError::new("too many tools for one turn"));
        }
        let thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
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
        self.run_turn(
            thread,
            content,
            knowledge,
            screen_context,
            skill_context,
            tools,
        )
    }

    /// Submits the results of a step's tool calls and takes the next step. The
    /// prompt is already durable; only the agent's own answer is still pending.
    fn submit_tool_result(
        &mut self,
        thread_id: ThreadId,
        results: Vec<AgentToolResult>,
        screen_context: Option<ScreenContext>,
        skill_context: Option<SkillContext>,
        tools: Vec<AgentTool>,
    ) -> Result<TurnOutcome, LiveError> {
        if results.is_empty() || tools.len() > MAX_AGENT_TOOLS {
            return Err(LiveError::new("tool results are invalid"));
        }
        let thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        let response = (self.agent)(AgentRequest::ToolResult {
            thread: thread.clone(),
            results,
            screen_context,
            skill_context,
            tools,
        })?;
        self.finish_step(thread, response)
    }

    /// One durable user turn: append the prompt, ask the agent, append the
    /// reply. Both ordinary threads and document conversations route here.
    fn run_turn(
        &mut self,
        mut thread: Thread,
        content: String,
        knowledge: Vec<AgentKnowledgePage>,
        screen_context: Option<ScreenContext>,
        skill_context: Option<SkillContext>,
        tools: Vec<AgentTool>,
    ) -> Result<TurnOutcome, LiveError> {
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
            knowledge,
            screen_context,
            skill_context,
            tools,
        })?;
        self.finish_step(thread, response)
    }

    /// Appends a finished prompt and answer without running the agent, because
    /// the harness already ran it. Both messages land in one save so a thread is
    /// never left holding a prompt whose reply exists only in the harness.
    fn record_turn(
        &mut self,
        thread_id: ThreadId,
        prompt: String,
        response: String,
        output_tokens: u64,
        duration_milliseconds: u64,
        input_tokens: u64,
        model: String,
    ) -> Result<TurnOutcome, LiveError> {
        // The run already happened, so an oversized half loses its middle rather
        // than the whole turn — the same bound a trace gets. Refusing here took
        // the prompt down with it, and a long build left nothing in the thread
        // but the error that refused to write it.
        let prompt = elide_middle(&prompt, MAX_AGENT_MESSAGE_BYTES);
        let response = elide_middle(&response, MAX_AGENT_MESSAGE_BYTES);
        validate_agent_text("prompt", &prompt, true, MAX_AGENT_MESSAGE_BYTES)?;
        validate_agent_text("response", &response, true, MAX_AGENT_MESSAGE_BYTES)?;
        let mut thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        let asked = Timestamp::now().max(thread.updated_at);
        thread
            .push(
                ThreadMessage::new(ThreadRole::User, prompt, asked)
                    .map_err(|error| LiveError::new(format!("prompt is invalid: {error}")))?,
            )
            .map_err(|error| LiveError::new(format!("could not append prompt: {error}")))?;
        let mut answer = ThreadMessage::new(
            ThreadRole::Assistant,
            response,
            asked.max(thread.updated_at),
        )
        .map_err(|error| LiveError::new(format!("response is invalid: {error}")))?;
        // Telemetry is best effort here: a harness that reports no usage leaves the
        // counts at zero rather than failing the turn, and the inspector shows a
        // dash instead of a fake rate.
        answer.generation =
            GenerationTelemetry::measured(output_tokens, duration_milliseconds, input_tokens, model)
                .ok();
        thread
            .push(answer)
            .map_err(|error| LiveError::new(format!("could not append response: {error}")))?;
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save the turn: {error}")))?;
        Ok(TurnOutcome {
            thread,
            tool_calls: Vec::new(),
        })
    }

    fn record_trace(&mut self, thread_id: ThreadId, trace: String) -> Result<(), LiveError> {
        let mut thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        // `ThreadTrace::new` is the bound: an oversized trace loses its middle,
        // so a runaway turn can never refuse to be recorded at all.
        thread.record_trace(
            ThreadTrace::new(Timestamp::now(), &trace)
                .map_err(|error| LiveError::new(format!("trace is invalid: {error}")))?,
        );
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save the trace: {error}")))?;
        Ok(())
    }

    fn read_trace(&mut self, thread_id: ThreadId) -> Result<Vec<ThreadTrace>, LiveError> {
        self.threads
            .load(&thread_id)
            .map(|thread| thread.traces)
            .map_err(|error| LiveError::new(format!("could not load thread {thread_id}: {error}")))
    }

    /// A step that asked for tools stays open: the pending calls go back to the
    /// caller and nothing is written until the agent produces a real answer.
    fn finish_step(
        &mut self,
        mut thread: Thread,
        response: AgentResponse,
    ) -> Result<TurnOutcome, LiveError> {
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
            duration_milliseconds,
            tool_calls,
            ..
        } = response;
        if !tool_calls.is_empty() {
            return Ok(TurnOutcome { thread, tool_calls });
        }
        let timestamp = Timestamp::now().max(thread.updated_at);
        let message = ThreadMessage::new(ThreadRole::Assistant, assistant_content, timestamp);
        let mut message = message
            .map_err(|error| LiveError::new(format!("assistant response is invalid: {error}")))?;
        message.generation = Some(
            GenerationTelemetry::measured(output_tokens, duration_milliseconds, input_tokens, model)
                .map_err(|error| {
                    LiveError::new(format!("generation telemetry is invalid: {error}"))
                })?,
        );
        thread
            .push(message)
            .map_err(|error| LiveError::new(format!("could not append response: {error}")))?;
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save response: {error}")))?;
        Ok(TurnOutcome {
            thread,
            tool_calls: Vec::new(),
        })
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
            categories: selected_base
                .categories
                .iter()
                .map(|category| category.as_str().to_owned())
                .collect(),
        })?;
        let AgentResponse::Analysis(response) = response else {
            return Err(LiveError::new(
                "agent returned a message when analysis was expected",
            ));
        };
        let AgentAnalysis {
            title,
            category,
            summary,
            body,
            interesting_points,
            counterarguments,
            sources: response_sources,
            blocks,
            model,
            input_tokens,
            output_tokens,
            subagent_count,
        } = response;
        let sources = response_sources
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
        let category = Category::parse(category)
            .map_err(|error| LiveError::new(format!("analysis category is invalid: {error}")))?;
        self.learn_category(&selected_base, &category)?;
        let mut page = KnowledgePage::new(
            title,
            category,
            CapturedContext::new(text, Some("Emma".into()), None)
                .map_err(|error| LiveError::new(format!("analysis context is invalid: {error}")))?,
            AnalysisContent::new(summary, body)
                .map_err(|error| LiveError::new(format!("analysis content is invalid: {error}")))?,
            sources,
            timestamp,
            timestamp,
            RunTelemetry::new(model, input_tokens, output_tokens, subagent_count).map_err(
                |error| LiveError::new(format!("analysis telemetry is invalid: {error}")),
            )?,
        )
        .map_err(|error| LiveError::new(format!("knowledge page is invalid: {error}")))?
        .with_source_thread(thread_id.clone())
        .in_knowledge_base(selected_base.id);
        let source = ArtifactSource::from_thread(Some(&thread_id));
        if !blocks.is_empty() {
            // The agent authored the document itself; its blocks replace the
            // fixed summary/body scaffold entirely.
            let artifacts = artifact_blocks(blocks, &source)?;
            let page = page.with_artifacts(artifacts).map_err(|error| {
                LiveError::new(format!("knowledge artifacts are invalid: {error}"))
            })?;
            self.knowledge.save(&page).map_err(|error| {
                LiveError::new(format!("could not save knowledge page: {error}"))
            })?;
            return Ok(page);
        }
        let mut artifacts = page.artifacts.clone();
        append_list_artifact(
            &mut artifacts,
            "interesting-points",
            &interesting_points,
            source.clone(),
        )?;
        append_list_artifact(
            &mut artifacts,
            "counterarguments",
            &counterarguments,
            source.clone(),
        )?;
        if !interesting_points.is_empty() || !counterarguments.is_empty() {
            let values = vec![interesting_points.len(), counterarguments.len()];
            artifacts.push(
                ArtifactBlock::new(
                    "evidence-balance",
                    "chart",
                    1,
                    source,
                    json!({
                        "labels": ["Interesting points", "Counterarguments"],
                        "values": values,
                    }),
                    format!(
                        "Interesting points: {}\nCounterarguments: {}",
                        interesting_points.len(),
                        counterarguments.len()
                    ),
                )
                .map_err(|error| {
                    LiveError::new(format!("analysis artifact is invalid: {error}"))
                })?,
            );
        }
        page = page
            .with_artifacts(artifacts)
            .map_err(|error| LiveError::new(format!("knowledge artifacts are invalid: {error}")))?;
        self.knowledge
            .save(&page)
            .map_err(|error| LiveError::new(format!("could not save knowledge page: {error}")))?;
        Ok(page)
    }

    /// Filing an item under a category the base has never seen teaches the base
    /// that category, so the taxonomy grows from real use instead of a setting.
    fn learn_category(&self, base: &KnowledgeBase, category: &Category) -> Result<(), LiveError> {
        // Reserved holding pen for items dropped in before anyone filed them.
        if category.as_str() == UNFILED_CATEGORY || base.categories.contains(category) {
            return Ok(());
        }
        if base.categories.len() >= crate::MAX_KNOWLEDGE_BASE_CATEGORIES {
            return Ok(());
        }
        let mut base = base.clone();
        base.categories.push(category.clone());
        base.categories.sort();
        self.knowledge
            .save_base(&base)
            .map_err(|error| LiveError::new(format!("could not learn the category: {error}")))?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn capture_to_knowledge(
        &self,
        knowledge_base_id: KnowledgeBaseId,
        category: String,
        title: String,
        text: String,
        source_url: Option<String>,
        source_application: Option<String>,
        images: Vec<String>,
        page_id: Option<PageId>,
    ) -> Result<KnowledgePage, LiveError> {
        validate_agent_text("page title", &title, true, MAX_AGENT_TITLE_BYTES)?;
        validate_agent_text("captured text", &text, false, MAX_AGENT_BODY_BYTES)?;
        if let Some(application) = &source_application {
            validate_agent_text(
                "source application",
                application,
                true,
                MAX_AGENT_TITLE_BYTES,
            )?;
        }
        let base = self.load_base(&knowledge_base_id)?;
        // Refreshing a page the user already keeps: the fresh clip replaces its
        // capture, and the page keeps its identity — same tile, same conversation,
        // same history — because a second row for one URL is the bug, not the save.
        let replacing = page_id
            .map(|id| {
                self.knowledge
                    .load(&id)
                    .map_err(|error| LiveError::new(format!("could not load page {id}: {error}")))
            })
            .transpose()?;
        let category = Category::parse(category)
            .map_err(|error| LiveError::new(format!("category is invalid: {error}")))?;
        self.learn_category(&base, &category)?;
        let source_url = source_url
            .map(SourceUrl::parse)
            .transpose()
            .map_err(|error| LiveError::new(format!("source URL is invalid: {error}")))?;
        // A capture has no analysis yet; the first line stands in as the summary
        // until the user asks Emma to build the document.
        let text = if text.trim().is_empty() {
            title.clone()
        } else {
            text
        };
        let summary = bounded(
            text.lines()
                .find(|line| !line.trim().is_empty())
                .unwrap_or(&title),
            MAX_CAPTURE_SUMMARY_BYTES,
        );
        let timestamp = Timestamp::now();
        let mut page = KnowledgePage::new(
            title.clone(),
            category,
            CapturedContext::new(text.clone(), source_application, source_url)
                .map_err(|error| LiveError::new(format!("captured context is invalid: {error}")))?,
            AnalysisContent::new(summary, text)
                .map_err(|error| LiveError::new(format!("captured content is invalid: {error}")))?,
            Vec::new(),
            timestamp,
            timestamp,
            RunTelemetry::new("capture", 0, 0, 0).map_err(|error| {
                LiveError::new(format!("capture telemetry is invalid: {error}"))
            })?,
        )
        .map_err(|error| LiveError::new(format!("captured page is invalid: {error}")))?
        .in_knowledge_base(base.id);
        // Grafted before the pictures are stored, so their asset names sit under the
        // id the page actually keeps. The filing survives too: a page already shelved
        // does not fall back to unfiled because it was re-read.
        if let Some(previous) = &replacing {
            page.id = previous.id.clone();
            page.category = previous.category.clone();
            page.added_at = previous.added_at;
            page.source_thread_id = previous.source_thread_id.clone();
            page.conversation_thread_id = previous.conversation_thread_id.clone();
        }
        if !images.is_empty() {
            // The first picture leads the document; a clipped page puts its favicon there.
            let mut artifacts = page.artifacts.clone();
            for (index, image) in images.iter().enumerate() {
                let extension = image_data_url_extension(image)?;
                let name = self
                    .knowledge
                    .save_asset(&page.id, extension, image.as_bytes())
                    .map_err(|error| {
                        LiveError::new(format!("could not store the image: {error}"))
                    })?;
                let id = if index == 0 {
                    "capture-image".to_owned()
                } else {
                    format!("capture-image-{}", index + 1)
                };
                artifacts.push(
                    ArtifactBlock::new(
                        id,
                        "image",
                        1,
                        ArtifactSource::default(),
                        json!({"asset": name, "alt": title}),
                        "Captured image",
                    )
                    .map_err(|error| {
                        LiveError::new(format!("captured image block is invalid: {error}"))
                    })?,
                );
            }
            page = page.with_artifacts(artifacts).map_err(|error| {
                LiveError::new(format!("captured artifacts are invalid: {error}"))
            })?;
        }
        // A replacement keeps the document it overwrote in version history, so a
        // refresh that reads worse than what it replaced can be restored.
        let saved = if replacing.is_some() {
            self.knowledge.save_versioned(&page)
        } else {
            self.knowledge.save(&page)
        };
        saved.map_err(|error| LiveError::new(format!("could not file the item: {error}")))?;
        Ok(page)
    }

    fn list_page_versions(&self, id: &PageId) -> Result<Vec<PageVersion>, LiveError> {
        self.knowledge
            .list_versions(id)
            .map_err(|error| LiveError::new(format!("could not list versions: {error}")))
    }

    fn restore_page_version(&self, id: &PageId, name: &str) -> Result<KnowledgePage, LiveError> {
        let current = self
            .knowledge
            .load(id)
            .map_err(|error| LiveError::new(format!("could not load page {id}: {error}")))?;
        let mut restored = self
            .knowledge
            .load_version(id, name)
            .map_err(|error| LiveError::new(format!("could not load that version: {error}")))?;
        // The conversation belongs to the page, not to any one revision of it.
        restored.conversation_thread_id = current.conversation_thread_id;
        self.knowledge
            .save_versioned(&restored)
            .map_err(|error| LiveError::new(format!("could not restore the version: {error}")))?;
        Ok(restored)
    }

    fn read_page_asset(&self, name: &str) -> Result<String, LiveError> {
        let bytes = self
            .knowledge
            .load_asset(name)
            .map_err(|error| LiveError::new(format!("could not read the attachment: {error}")))?;
        let value = String::from_utf8(bytes)
            .map_err(|_| LiveError::new("attachment is not a stored data URL"))?;
        image_data_url_extension(&value)?;
        Ok(value)
    }

    /// Lazily attaches a durable thread to the page so the document has one
    /// conversation history no matter where the user talks to it from.
    fn conversation_thread(&self, page: &mut KnowledgePage) -> Result<Thread, LiveError> {
        if let Some(id) = page.conversation_thread_id.clone() {
            return self
                .threads
                .load(&id)
                .map_err(|error| LiveError::new(format!("could not load conversation: {error}")));
        }
        let mut thread = Thread::new(
            bounded(&page.title, MAX_AGENT_TITLE_BYTES),
            Timestamp::now(),
        )
        .map_err(|error| LiveError::new(format!("could not create conversation: {error}")))?;
        thread.select_knowledge_base(page.knowledge_base_id.clone());
        thread.select_source_knowledge_bases(vec![page.knowledge_base_id.clone()]);
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save conversation: {error}")))?;
        page.conversation_thread_id = Some(thread.id.clone());
        self.knowledge
            .save(page)
            .map_err(|error| LiveError::new(format!("could not link conversation: {error}")))?;
        Ok(thread)
    }

    /// Re-analyzes an existing page from what was captured: Emma picks the
    /// category out of the ones this base already keeps, retitles, and authors
    /// the document. Images captured with the item stay, and stay on top.
    fn analyze_page(
        &mut self,
        page_id: PageId,
        keep_category: bool,
    ) -> Result<KnowledgePage, LiveError> {
        let mut page = self
            .knowledge
            .load(&page_id)
            .map_err(|error| LiveError::new(format!("could not load page {page_id}: {error}")))?;
        let base = self.load_base(&page.knowledge_base_id)?;
        let thread = self.conversation_thread(&mut page)?;
        let text = if page.context.text.trim().is_empty() {
            page.analysis.body.clone()
        } else {
            page.context.text.clone()
        };
        let response = (self.agent)(AgentRequest::Analyze {
            thread: thread.clone(),
            text,
            categories: base
                .categories
                .iter()
                .map(|category| category.as_str().to_owned())
                .collect(),
        })?;
        let AgentResponse::Analysis(response) = response else {
            return Err(LiveError::new(
                "agent returned a message when analysis was expected",
            ));
        };
        let category = Category::parse(response.category)
            .map_err(|error| LiveError::new(format!("analysis category is invalid: {error}")))?;
        // An untrained base gets the document without the filing: neither the page nor the
        // base's taxonomy moves until the user's own filing has taught it this category.
        if !keep_category {
            self.learn_category(&base, &category)?;
            page.category = category;
        }
        page.title = response.title;
        page.analysis = AnalysisContent::new(response.summary, response.body)
            .map_err(|error| LiveError::new(format!("analysis content is invalid: {error}")))?;
        page.telemetry = RunTelemetry::new(
            response.model,
            response.input_tokens,
            response.output_tokens,
            response.subagent_count,
        )
        .map_err(|error| LiveError::new(format!("analysis telemetry is invalid: {error}")))?;
        page.analyzed_at = Timestamp::now().max(page.added_at);
        let source = ArtifactSource::from_thread(Some(&thread.id));
        let images: Vec<ArtifactBlock> = page
            .artifacts
            .iter()
            .filter(|block| block.block_type == "image")
            .cloned()
            .collect();
        let mut artifacts = if response.blocks.is_empty() {
            crate::knowledge::legacy_artifacts(&page.analysis, &page.sources, Some(&thread.id))
                .map_err(|error| {
                    LiveError::new(format!("analysis artifacts are invalid: {error}"))
                })?
        } else {
            artifact_blocks(response.blocks, &source)?
        };
        // The captured pictures ride directly under the opening summary, where the
        // reader meets them already knowing what the page is about.
        let at = artifacts.len().min(1);
        artifacts.splice(at..at, images);
        page.replace_artifacts(artifacts)
            .map_err(|error| LiveError::new(format!("analysis artifacts are invalid: {error}")))?;
        self.knowledge
            .save_versioned(&page)
            .map_err(|error| LiveError::new(format!("could not save the document: {error}")))?;
        Ok(page)
    }

    fn chat_about_page(&mut self, page_id: PageId, content: String) -> Result<Thread, LiveError> {
        validate_agent_text("prompt", &content, true, MAX_AGENT_MESSAGE_BYTES)?;
        let mut page = self
            .knowledge
            .load(&page_id)
            .map_err(|error| LiveError::new(format!("could not load page {page_id}: {error}")))?;
        let thread = self.conversation_thread(&mut page)?;
        let knowledge = vec![document_context(&page)];
        self.run_turn(thread, content, knowledge, None, None, Vec::new())
            .map(|outcome| outcome.thread)
    }

    fn revise_page_document(
        &mut self,
        page_id: PageId,
        instruction: String,
    ) -> Result<Vec<ArtifactBlock>, LiveError> {
        validate_agent_text("instruction", &instruction, true, MAX_AGENT_MESSAGE_BYTES)?;
        let mut page = self
            .knowledge
            .load(&page_id)
            .map_err(|error| LiveError::new(format!("could not load page {page_id}: {error}")))?;
        let thread = self.conversation_thread(&mut page)?;
        let source = ArtifactSource::from_thread(Some(&thread.id));
        let response = (self.agent)(AgentRequest::ReviseDocument {
            thread,
            instruction,
            document: page.artifacts.clone(),
        })?;
        let AgentResponse::Document(blocks) = response else {
            return Err(LiveError::new(
                "agent returned an unexpected response when a document was expected",
            ));
        };
        if blocks.is_empty() {
            return Err(LiveError::new("agent returned an empty document"));
        }
        artifact_blocks(blocks, &source)
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

/// A tool that returns more than the ceiling is normal (a long file, a big
/// listing); the turn keeps going on a truncated result instead of failing.
fn truncate_tool_result(content: String) -> String {
    if content.len() <= MAX_TOOL_RESULT_BYTES {
        return content;
    }
    const NOTICE: &str = "\n… truncated: tool result exceeded 16384 bytes";
    let mut end = MAX_TOOL_RESULT_BYTES - NOTICE.len();
    while !content.is_char_boundary(end) {
        end -= 1;
    }
    let mut kept = content;
    kept.truncate(end);
    kept.push_str(NOTICE);
    kept
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

/// Validates agent-authored blocks into durable artifacts. The agent picks the
/// block types, so this is the trust boundary for a generated document.
fn artifact_blocks(
    blocks: Vec<AgentBlock>,
    source: &ArtifactSource,
) -> Result<Vec<ArtifactBlock>, LiveError> {
    let mut artifacts = Vec::with_capacity(blocks.len());
    for block in blocks {
        artifacts.push(
            ArtifactBlock::new(
                block.id,
                block.block_type,
                1,
                source.clone(),
                block.payload,
                block.fallback,
            )
            .map_err(|error| LiveError::new(format!("document block is invalid: {error}")))?,
        );
    }
    Ok(artifacts)
}

/// The page as the agent sees it while chatting about the document: every block
/// in reading order, using each block's portable fallback text.
fn document_context(page: &KnowledgePage) -> AgentKnowledgePage {
    let body = page
        .artifacts
        .iter()
        .map(|block| format!("[{} · {}]\n{}", block.id, block.block_type, block.fallback))
        .collect::<Vec<_>>()
        .join("\n\n");
    AgentKnowledgePage {
        id: page.id.as_str().to_owned(),
        title: bounded(&page.title, MAX_AGENT_TITLE_BYTES),
        summary: bounded(&page.analysis.summary, MAX_AGENT_SUMMARY_BYTES),
        body: bounded(&body, MAX_AGENT_BODY_BYTES),
    }
}

fn image_data_url_extension(value: &str) -> Result<&'static str, LiveError> {
    let (extension, encoded) = if let Some(rest) = value.strip_prefix("data:image/jpeg;base64,") {
        ("jpeg", rest)
    } else if let Some(rest) = value.strip_prefix("data:image/png;base64,") {
        ("png", rest)
    } else {
        return Err(LiveError::new("image must be a JPEG or PNG data URL"));
    };
    let content = encoded.trim_end_matches('=');
    if value.len() > crate::MAX_ASSET_BYTES
        || encoded.is_empty()
        || !encoded.len().is_multiple_of(4)
        || encoded.len() - content.len() > 2
        || !content
            .bytes()
            .all(|byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/'))
    {
        return Err(LiveError::new("image data URL is invalid or too large"));
    }
    Ok(extension)
}

fn append_list_artifact(
    artifacts: &mut Vec<ArtifactBlock>,
    id: &str,
    items: &[String],
    source: ArtifactSource,
) -> Result<(), LiveError> {
    if items.is_empty() {
        return Ok(());
    }
    for item in items {
        validate_agent_text("analysis point", item, true, MAX_AGENT_SUMMARY_BYTES)?;
    }
    let fallback = items
        .iter()
        .map(|item| format!("- {item}"))
        .collect::<Vec<_>>()
        .join("\n");
    artifacts.push(
        ArtifactBlock::new(
            id,
            "list",
            1,
            source,
            json!({"items": items, "ordered": false}),
            fallback,
        )
        .map_err(|error| LiveError::new(format!("analysis artifact is invalid: {error}")))?,
    );
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

    #[test]
    fn an_oversized_tool_result_is_truncated_instead_of_refused() {
        let content = "é".repeat(MAX_TOOL_RESULT_BYTES);
        let result = AgentToolResult::new("call-a".into(), content).expect("accepted");
        assert!(result.content.len() <= MAX_TOOL_RESULT_BYTES);
        assert!(
            result
                .content
                .ends_with("truncated: tool result exceeded 16384 bytes")
        );
    }
    use std::{
        fs,
        sync::{
            Mutex,
            atomic::{AtomicU64, Ordering},
        },
    };

    /// For the tests that never reach the clock. Anything due here would be dropped.
    fn no_jobs() -> JobSink {
        Arc::new(|_| {})
    }

    /// Records what came due, so a test can assert on it without a host on the other end.
    fn collect_jobs() -> (JobSink, Arc<Mutex<Vec<DueJob>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        (Arc::new(move |job| sink.lock().unwrap().push(job)), seen)
    }

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
                screen_context,
                skill_context,
                tools,
            } => {
                assert_eq!(thread.messages.len(), 1);
                assert!(knowledge.is_empty());
                assert!(screen_context.is_none());
                assert!(skill_context.is_none());
                assert!(tools.is_empty());
                Ok(AgentResponse::Message(AgentMessage {
                    content: format!("Fake reply to {content}"),
                    model: "fake".into(),
                    input_tokens: 2,
                    output_tokens: 4,
                    duration_milliseconds: 200,
                    tool_calls: Vec::new(),
                }))
            }
            AgentRequest::Analyze { thread, text, .. } => {
                assert_eq!(thread.messages.len(), 2);
                Ok(AgentResponse::Analysis(AgentAnalysis {
                    blocks: Vec::new(),
                    title: "Saved fake analysis".into(),
                    category: "general".into(),
                    summary: "Focused integration analysis".into(),
                    body: format!("Analyzed: {text}"),
                    interesting_points: vec!["A useful point".into()],
                    counterarguments: vec!["A caveat".into()],
                    sources: Vec::new(),
                    model: "fake".into(),
                    input_tokens: 4,
                    output_tokens: 6,
                    subagent_count: 0,
                }))
            }
            AgentRequest::ToolResult { .. }
            | AgentRequest::ReviseDocument { .. }
            | AgentRequest::ListOpenRouterModels
            | AgentRequest::SelectOpenRouterModel { .. }
            | AgentRequest::SelectLocalModel { .. }
            | AgentRequest::SetThreadModel { .. }
            | AgentRequest::SelectFallbackModel => {
                unreachable!()
            }
        };
        let mut runtime = Runtime::new(
            thread_root.clone(),
            knowledge_root.clone(),
            None,
            scheduled_root,
            root.join("research"),
            no_jobs(),
            agent,
        );

        let created = runtime.create_thread(None, None, ThreadKind::Main).unwrap();
        let oversized = "x".repeat(MAX_AGENT_MESSAGE_BYTES + 1);
        assert!(
            runtime
                .send_message(created.id.clone(), oversized, None, None, Vec::new())
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
            .send_message(created.id.clone(), "hello".into(), None, None, Vec::new())
            .unwrap()
            .thread;

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
        assert!(page.artifacts.iter().any(|block| block.id == "summary"));
        assert!(
            page.artifacts
                .iter()
                .any(|block| block.id == "interesting-points")
        );
        assert!(
            page.artifacts
                .iter()
                .any(|block| block.id == "counterarguments")
        );
        assert!(
            page.artifacts
                .iter()
                .any(|block| block.block_type == "chart")
        );
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
        let before_failed_update = runtime.knowledge.load(&edited.id).unwrap();
        let duplicate_artifacts = vec![
            ArtifactBlock::new(
                "duplicate",
                "rich-text",
                1,
                ArtifactSource::default(),
                serde_json::json!({"markdown": "one"}),
                "one",
            )
            .unwrap(),
            ArtifactBlock::new(
                "duplicate",
                "rich-text",
                1,
                ArtifactSource::default(),
                serde_json::json!({"markdown": "two"}),
                "two",
            )
            .unwrap(),
        ];
        assert!(
            runtime
                .update_page_document(
                    edited.id.clone(),
                    "Should not persist".into(),
                    "research".into(),
                    "Should not persist".into(),
                    "Should not persist".into(),
                    duplicate_artifacts,
                )
                .is_err()
        );
        assert_eq!(
            runtime.knowledge.load(&edited.id).unwrap(),
            before_failed_update
        );
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
    fn captured_items_learn_categories_and_documents_keep_history_and_versions() {
        let root = temp_child();
        let mut runtime = Runtime::new(
            root.join("threads"),
            root.join("knowledge"),
            None,
            root.join("scheduled"),
            root.join("research"),
            no_jobs(),
            |request| match request {
                AgentRequest::ThreadMessage { knowledge, .. } => {
                    assert_eq!(knowledge.len(), 1);
                    assert!(knowledge[0].body.contains("Raw captured research"));
                    Ok(AgentResponse::Message(AgentMessage {
                        tool_calls: Vec::new(),
                        content: "Reply about the document".into(),
                        model: "fake".into(),
                        input_tokens: 1,
                        output_tokens: 1,
                        duration_milliseconds: 1,
                    }))
                }
                AgentRequest::ReviseDocument { document, .. } => {
                    assert!(!document.is_empty());
                    Ok(AgentResponse::Document(vec![
                        AgentBlock {
                            id: "how-to-apply".into(),
                            block_type: "list".into(),
                            payload: json!({"items": ["Try it on one project"]}),
                            fallback: "- Try it on one project".into(),
                        },
                        AgentBlock {
                            id: "adoption".into(),
                            block_type: "chart".into(),
                            payload: json!({"labels": ["Now", "Later"], "values": [3, 1]}),
                            fallback: "Now: 3\nLater: 1".into(),
                        },
                    ]))
                }
                _ => unreachable!(),
            },
        );

        let base = runtime.create_knowledge_base("Reading".into()).unwrap();
        let page = runtime
            .capture_to_knowledge(
                base.id.clone(),
                "field-notes".into(),
                "A captured article".into(),
                "Raw captured research\n\nSecond paragraph".into(),
                Some("https://example.com/article".into()),
                Some("Safari".into()),
                vec![
                    format!("data:image/png;base64,{}", "AAAA".repeat(4)),
                    format!("data:image/jpeg;base64,{}", "BBBB".repeat(4)),
                ],
                None,
            )
            .unwrap();
        assert_eq!(page.knowledge_base_id, base.id);
        assert_eq!(page.analysis.summary, "Raw captured research");
        // Every picture the capture carried is kept, each in its own block.
        let images: Vec<&str> = page
            .artifacts
            .iter()
            .filter(|block| block.block_type == "image")
            .map(|block| block.id.as_str())
            .collect();
        assert_eq!(images, ["capture-image", "capture-image-2"]);
        // Filing under a new category teaches the base that category.
        assert_eq!(
            runtime.load_base(&base.id).unwrap().categories,
            [Category::parse("field-notes").unwrap()]
        );

        let asset = objects_asset_name(&page);
        assert!(
            runtime
                .read_page_asset(&asset)
                .unwrap()
                .starts_with("data:image/png")
        );
        assert!(runtime.read_page_asset("../escape.png").is_err());

        // Chatting about the document creates one durable conversation and reuses it.
        let conversation = runtime
            .chat_about_page(page.id.clone(), "What does this argue?".into())
            .unwrap();
        assert_eq!(conversation.messages.len(), 2);
        let linked = runtime.knowledge.load(&page.id).unwrap();
        assert_eq!(linked.conversation_thread_id, Some(conversation.id.clone()));
        let conversation = runtime
            .chat_about_page(page.id.clone(), "And the counterargument?".into())
            .unwrap();
        assert_eq!(conversation.id, linked.conversation_thread_id.unwrap());
        assert_eq!(conversation.messages.len(), 4);

        // A revision is a proposal: nothing durable changes until it is applied.
        let proposed = runtime
            .revise_page_document(page.id.clone(), "Add how to apply it".into())
            .unwrap();
        assert_eq!(proposed.len(), 2);
        assert_eq!(
            runtime.knowledge.load(&page.id).unwrap().artifacts,
            linked.artifacts
        );
        assert!(runtime.list_page_versions(&page.id).unwrap().is_empty());

        let applied = runtime
            .update_page_document(
                page.id.clone(),
                "A captured article".into(),
                "field-notes".into(),
                "Now with guidance".into(),
                "Body".into(),
                proposed,
            )
            .unwrap();
        assert!(
            applied
                .artifacts
                .iter()
                .any(|block| block.id == "how-to-apply")
        );
        let versions = runtime.list_page_versions(&page.id).unwrap();
        assert_eq!(versions.len(), 1);

        let restored = runtime
            .restore_page_version(&page.id, &versions[0].name)
            .unwrap();
        assert_eq!(restored.artifacts, linked.artifacts);
        // Restoring keeps the conversation and is itself undoable.
        assert_eq!(
            restored.conversation_thread_id,
            applied.conversation_thread_id
        );
        assert_eq!(runtime.list_page_versions(&page.id).unwrap().len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_unfiled_capture_is_filed_and_documented_by_the_agent() {
        let root = temp_child();
        let mut runtime = Runtime::new(
            root.join("threads"),
            root.join("knowledge"),
            None,
            root.join("scheduled"),
            root.join("research"),
            no_jobs(),
            |request| match request {
                AgentRequest::Analyze {
                    text, categories, ..
                } => {
                    assert!(text.contains("Raw captured research"));
                    assert_eq!(categories, ["field-notes"]);
                    Ok(AgentResponse::Analysis(AgentAnalysis {
                        blocks: vec![
                            AgentBlock {
                                id: "summary".into(),
                                block_type: "rich-text".into(),
                                payload: json!({"markdown": "What it argues"}),
                                fallback: "What it argues".into(),
                            },
                            AgentBlock {
                                id: "how-to-apply".into(),
                                block_type: "list".into(),
                                payload: json!({"items": ["Try it once"]}),
                                fallback: "- Try it once".into(),
                            },
                        ],
                        title: "A filed article".into(),
                        category: "field-notes".into(),
                        summary: "What it argues".into(),
                        body: "The long form".into(),
                        interesting_points: Vec::new(),
                        counterarguments: Vec::new(),
                        sources: Vec::new(),
                        model: "fake".into(),
                        input_tokens: 4,
                        output_tokens: 6,
                        subagent_count: 0,
                    }))
                }
                _ => unreachable!(),
            },
        );

        let base = runtime.create_knowledge_base("Reading".into()).unwrap();
        runtime
            .change_category(base.id.clone(), "field-notes".into(), true)
            .unwrap();
        let captured = runtime
            .capture_to_knowledge(
                base.id.clone(),
                UNFILED_CATEGORY.into(),
                "Dropped in".into(),
                "Raw captured research".into(),
                None,
                None,
                vec![format!("data:image/png;base64,{}", "AAAA".repeat(4))],
                None,
            )
            .unwrap();
        // The holding pen never becomes part of the user's taxonomy.
        assert_eq!(
            runtime.load_base(&base.id).unwrap().categories,
            [Category::parse("field-notes").unwrap()]
        );

        // An untrained base still gets the whole document, but nothing is filed by it.
        let documented = runtime.analyze_page(captured.id.clone(), true).unwrap();
        assert_eq!(documented.category.as_str(), UNFILED_CATEGORY);
        assert!(
            documented
                .artifacts
                .iter()
                .any(|block| block.id == "how-to-apply")
        );
        assert_eq!(
            runtime.load_base(&base.id).unwrap().categories,
            [Category::parse("field-notes").unwrap()]
        );

        let filed = runtime.analyze_page(captured.id.clone(), false).unwrap();
        assert_eq!(filed.category.as_str(), "field-notes");
        assert_eq!(filed.title, "A filed article");
        // The summary opens the document and the picture rides directly under it.
        assert_eq!(filed.artifacts[0].id, "summary");
        assert_eq!(filed.artifacts[1].block_type, "image");
        assert!(
            filed
                .artifacts
                .iter()
                .any(|block| block.id == "how-to-apply")
        );
        // One version per analysis: the unfiled document, then the filed one.
        assert_eq!(runtime.list_page_versions(&filed.id).unwrap().len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    fn objects_asset_name(page: &KnowledgePage) -> String {
        let block = page
            .artifacts
            .iter()
            .find(|block| block.block_type == "image")
            .expect("image block");
        block.payload["asset"].as_str().expect("asset name").into()
    }

    /// Re-reading something already kept refreshes that page rather than shelving a
    /// second copy of one URL — the case a retried save used to leave behind.
    #[test]
    fn a_capture_that_names_a_page_replaces_it() {
        let root = temp_child();
        let runtime = Runtime::new(
            root.join("threads"),
            root.join("knowledge"),
            None,
            root.join("scheduled"),
            root.join("research"),
            no_jobs(),
            |_| Err(LiveError::new("the agent is not used here")),
        );
        let base = runtime.create_knowledge_base("Reading".into()).unwrap();
        let first = runtime
            .capture_to_knowledge(
                base.id.clone(),
                "field-notes".into(),
                "Old title".into(),
                "Old text".into(),
                Some("https://example.com/a".into()),
                None,
                Vec::new(),
                None,
            )
            .unwrap();
        let again = runtime
            .capture_to_knowledge(
                base.id.clone(),
                UNFILED_CATEGORY.into(),
                "New title".into(),
                "New text".into(),
                Some("https://example.com/a".into()),
                None,
                Vec::new(),
                Some(first.id.clone()),
            )
            .unwrap();
        assert_eq!(again.id, first.id);
        assert_eq!(again.added_at, first.added_at);
        assert_eq!(again.title, "New title");
        assert_eq!(again.context.text, "New text");
        // A page already shelved stays shelved: the re-read carries "unfiled", and
        // that must not undo the user's own filing.
        assert_eq!(again.category.as_str(), "field-notes");
        assert_eq!(runtime.knowledge.list().unwrap().pages.len(), 1);
        // What it overwrote is recoverable.
        assert_eq!(runtime.list_page_versions(&first.id).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn renaming_a_thread_collapses_whitespace_and_refuses_an_empty_name() {
        let root = temp_child();
        let runtime = Runtime::new(
            root.join("threads"),
            root.join("knowledge"),
            None,
            root.join("scheduled"),
            root.join("research"),
            no_jobs(),
            |_| Err(LiveError::new("the agent is not used here")),
        );
        let thread = runtime.create_thread(None, None, ThreadKind::Main).unwrap();
        let named = runtime
            .rename_thread(thread.id.clone(), "  Trip\n  plans  ".into())
            .unwrap();
        assert_eq!(named.title, "Trip plans");
        // The title is a header field in the thread file, so it has to survive a reload.
        assert_eq!(
            runtime.threads.load(&thread.id).unwrap().title,
            "Trip plans"
        );
        assert!(
            runtime
                .rename_thread(thread.id.clone(), "   ".into())
                .is_err()
        );
        assert_eq!(
            runtime.threads.load(&thread.id).unwrap().title,
            "Trip plans"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archived_threads_survive_until_the_retention_window_closes() {
        let root = temp_child();
        let runtime = Runtime::new(
            root.join("threads"),
            root.join("knowledge"),
            None,
            root.join("scheduled"),
            root.join("research"),
            no_jobs(),
            |_| Err(LiveError::new("the agent is not used here")),
        );
        let kept = runtime.create_thread(None, None, ThreadKind::Main).unwrap();
        let expired = runtime.create_thread(None, None, ThreadKind::Main).unwrap();
        assert!(
            runtime
                .set_thread_archived(kept.id.clone(), true)
                .unwrap()
                .archived_at
                .is_some()
        );
        let mut stale = runtime
            .set_thread_archived(expired.id.clone(), true)
            .unwrap();
        stale.archived_at = Some(Timestamp::from_unix_seconds(
            Timestamp::now().unix_seconds() - ARCHIVE_RETENTION_SECONDS - 1,
        ));
        runtime.threads.save(&stale).unwrap();

        let threads = runtime.snapshot().unwrap().threads;
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].id, kept.id);
        assert!(runtime.threads.load(&expired.id).is_err());
        assert!(
            runtime
                .set_thread_archived(kept.id.clone(), false)
                .unwrap()
                .archived_at
                .is_none()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_recorded_turn_lands_in_the_thread_without_reaching_the_agent() {
        let root = temp_child();
        let mut runtime = Runtime::new(
            root.join("threads"),
            root.join("knowledge"),
            None,
            root.join("scheduled"),
            root.join("research"),
            no_jobs(),
            // The harness already ran this turn, so calling the agent is the bug.
            |_| unreachable!("a recorded turn does not run the agent"),
        );
        let thread = runtime.create_thread(None, None, ThreadKind::Main).unwrap();
        let outcome = runtime
            .record_turn(
                thread.id.clone(),
                "build me a timer".into(),
                "Built it in timer.html.".into(),
                42,
                1_500,
                3_700,
                "claude-opus-4".into(),
            )
            .unwrap();

        assert!(outcome.tool_calls.is_empty());
        // Both halves are durable, so a reload sees the turn the harness ran.
        let saved = runtime.threads.load(&thread.id).unwrap();
        assert_eq!(saved.messages.len(), 2);
        assert_eq!(saved.messages[0].role, ThreadRole::User);
        assert_eq!(saved.messages[1].content, "Built it in timer.html.");
        assert_eq!(
            saved.messages[1].generation.as_ref().unwrap().output_tokens,
            42
        );
        // What the turn carried in, so the context inspector is measuring and not
        // guessing at the system prompt and tool schemas it cannot see.
        assert_eq!(
            saved.messages[1].generation.as_ref().unwrap().input_tokens,
            3_700
        );
        // Which model wrote it, so a thread the user switched models midway
        // through reads back as what actually answered each turn.
        assert_eq!(
            saved.messages[1].generation.as_ref().unwrap().model,
            "claude-opus-4"
        );
        // An empty half would silently drop one side of the exchange.
        assert!(
            runtime
                .record_turn(thread.id.clone(), "ask".into(), "  ".into(), 0, 0, 0, String::new())
                .is_err()
        );
        // A long build's answer is elided, not refused: refusing wrote neither
        // half, so the run's work was on disk with nothing in the thread.
        let long = "let x = 1;\n".repeat(MAX_AGENT_MESSAGE_BYTES / 8);
        runtime
            .record_turn(thread.id.clone(), "build a 3js game".into(), long, 0, 0, 0, String::new())
            .unwrap();
        let saved = runtime.threads.load(&thread.id).unwrap();
        assert_eq!(saved.messages.len(), 4);
        assert!(saved.messages[3].content.len() <= MAX_AGENT_MESSAGE_BYTES);
        assert!(saved.messages[3].content.contains("lines elided"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn due_scheduled_job_claims_once_and_hands_its_turn_out_under_its_saved_mode() {
        let root = temp_child();
        let (sink, due) = collect_jobs();
        let mut runtime = Runtime::new(
            root.join("threads"),
            root.join("knowledge"),
            None,
            root.join("scheduled"),
            root.join("research"),
            sink,
            // Core no longer drives a due job itself, so reaching the agent here is the bug.
            |_| unreachable!("a due job is run by the caller, not by core"),
        );
        let mut job = runtime
            .save_scheduled_job(
                None,
                "Weekly discovery".into(),
                "0 9 * * 1".into(),
                "Find useful reading".into(),
                String::new(),
                vec!["example.com".into()],
                "acceptEdits".into(),
            )
            .unwrap();
        job.created_at = Timestamp::from_unix_seconds(0);
        job.next_run_at = Some(Timestamp::from_unix_seconds(60));
        runtime.scheduled.save(&job).unwrap();

        runtime.run_due_jobs();
        runtime.run_due_jobs();

        let jobs = runtime.scheduled.list().unwrap().jobs;
        let threads = runtime.threads.list().unwrap().threads;
        let handed = due.lock().unwrap();
        assert_eq!(threads.len(), 1);
        // Claimed once, so the second tick hands out nothing: a job that fired twice
        // in one window would run the same unattended turn twice.
        assert_eq!(handed.len(), 1);
        assert_eq!(handed[0].thread_id, threads[0].id.to_string());
        assert_eq!(handed[0].prompt, "Find useful reading");
        assert_eq!(handed[0].permission_mode, "acceptEdits");
        assert_eq!(
            jobs[0].last_thread_id.as_deref(),
            Some(threads[0].id.as_str())
        );
        assert!(jobs[0].last_run_at.is_some());
        // The run's thread is tagged with its job, and the tag survives a reload:
        // that is what files it under Scheduled tasks instead of a project.
        assert_eq!(threads[0].scheduled_job_id.as_ref(), Some(&jobs[0].id));
        drop(handed);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_finished_job_fires_what_waits_on_it_and_a_trigger_loop_runs_out() {
        let root = temp_child();
        let (sink, due) = collect_jobs();
        let mut runtime = Runtime::new(
            root.join("threads"),
            root.join("knowledge"),
            None,
            root.join("scheduled"),
            root.join("research"),
            sink,
            |_| unreachable!("a triggered job is run by the caller, not by core"),
        );
        let first = runtime
            .save_scheduled_job(
                None,
                "Collect".into(),
                "manual".into(),
                "Collect the week".into(),
                String::new(),
                vec![],
                "ask".into(),
            )
            .unwrap();
        // Waits on the first, and the first waits on it: a loop, on purpose.
        let second = runtime
            .save_scheduled_job(
                None,
                "Summarise".into(),
                format!("after {}", first.id),
                "Summarise {{digest}}".into(),
                String::new(),
                vec![],
                "ask".into(),
            )
            .unwrap();
        runtime
            .save_scheduled_job(
                Some(first.id.clone()),
                "Collect".into(),
                format!("after {}", second.id),
                "Collect the week".into(),
                String::new(),
                vec![],
                "ask".into(),
            )
            .unwrap();
        assert_eq!(first.next_run_at, None);

        let outputs = "{\"digest\":\"three items\"}";
        runtime
            .finish_scheduled_job(first.id.clone(), outputs.into(), 0)
            .unwrap();
        // Stand in for the app: every run handed out finishes, which is what feeds
        // the loop. Bounded so a runaway chain fails the test instead of hanging it.
        let mut finished = 0;
        for _ in 0..16 {
            let next = due.lock().unwrap().get(finished).cloned();
            let Some(run) = next else { break };
            finished += 1;
            runtime
                .finish_scheduled_job(
                    ScheduledJobId::parse(run.job_id).unwrap(),
                    outputs.into(),
                    run.depth,
                )
                .unwrap();
        }

        let handed = due.lock().unwrap();
        // The downstream job ran, starting from what the upstream one produced, and
        // the ping-pong between the two stopped at the depth ceiling rather than
        // filling the disk with threads.
        assert_eq!(handed[0].job_id, second.id.as_str());
        assert_eq!(handed[0].variables, outputs);
        assert_eq!(handed[0].depth, 1);
        assert_eq!(handed.len(), MAX_TRIGGER_DEPTH as usize, "{handed:?}");
        assert_eq!(runtime.scheduled.load(&first.id).unwrap().outputs, outputs);
        drop(handed);

        runtime.delete_scheduled_job(second.id.clone()).unwrap();
        assert!(runtime.scheduled.load(&second.id).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_autoresearch_edit_keeps_the_run_it_already_has_and_refuses_a_new_metric() {
        let root = temp_child();
        let runtime = Runtime::new(
            root.join("threads"),
            root.join("knowledge"),
            None,
            root.join("scheduled"),
            root.join("research"),
            no_jobs(),
            |_| unreachable!("an autoresearch iteration is run by the caller, not by core"),
        );
        let save = |job_id, title: &str, metric: &str, budget| {
            runtime.save_research_job(
                job_id,
                title.into(),
                "/tmp/project".into(),
                metric.into(),
                "grep".into(),
                String::new(),
                "lower".into(),
                "uv run train.py 2>&1".into(),
                "Only touch the optimiser".into(),
                "openai/gpt-5".into(),
                "ask".into(),
                budget,
                0,
                0,
            )
        };
        let job = save(None, "Lower the loss", "val_bpb", 0).unwrap();
        assert_eq!(job.status, "paused");

        runtime
            .record_research_iteration(
                job.id.clone(),
                Some(1.5),
                "keep".into(),
                "widened the window".into(),
                "abc1234".into(),
                90_000,
                300,
                200,
                7,
            )
            .unwrap();
        let recorded = runtime
            .record_research_iteration(
                job.id.clone(),
                Some(2.0),
                "discard".into(),
                String::new(),
                String::new(),
                30_000,
                100,
                100,
                3,
            )
            .unwrap();
        // Lower is better here, so the worse second attempt leaves the line where it
        // was, and all three budgets count both attempts.
        assert_eq!(recorded.iterations[1].index, 1);
        assert_eq!(recorded.iterations[1].best, Some(1.5));
        assert_eq!(recorded.spent_tokens, 700);
        assert_eq!(recorded.spent_micro_dollars, 10);
        assert_eq!(recorded.spent_seconds, 120);

        let edited = save(Some(job.id.clone()), "Lower the loss more", "val_bpb", 600).unwrap();
        assert_eq!(edited.max_seconds, 600);
        assert_eq!(edited.iterations.len(), 2);
        assert_eq!(edited.spent_seconds, 120);
        // The one thing an edit may not do, because it would make the two attempts
        // above measurements of different experiments.
        assert!(save(Some(job.id.clone()), "Lower the loss more", "val_loss", 600).is_err());

        let paused = runtime
            .set_research_job_status(job.id.clone(), "paused".into(), "out of seconds".into())
            .unwrap();
        assert_eq!(paused.status_note, "out of seconds");
        let thread = runtime.create_thread(None, None, ThreadKind::Main).unwrap();
        let attached = runtime
            .set_research_job_thread(job.id.clone(), thread.id.clone())
            .unwrap();
        assert_eq!(
            attached.thread_id.as_deref(),
            Some(thread.id.to_string().as_str())
        );
        assert_eq!(runtime.snapshot().unwrap().research_jobs.len(), 1);

        runtime.delete_research_job(job.id.clone()).unwrap();
        assert!(runtime.snapshot().unwrap().research_jobs.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
