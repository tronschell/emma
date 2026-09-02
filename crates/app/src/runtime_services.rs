use std::{
    collections::{BTreeMap, VecDeque},
    fmt,
};

use serde_json::{Map, Value};

use crate::conversation::{
    CompletionMenu, ComposerSubmission, ConversationBlock, ConversationEntry,
    ConversationLoadState, ConversationMessage, ConversationPage, ConversationRole,
    ConversationRun, EditDiff, GenerationMeta, NestedAgent, NestedAgentStatus, PermissionMode,
    QueuedTurn, RunState, StepStatus, ThinkingBlock, ToolStep, split_thinking, thought_tokens,
};

pub const MAX_RUNTIME_ID_BYTES: usize = 256;
pub const MAX_RUNTIME_TEXT_BYTES: usize = 512 * 1024;
pub const MAX_RUNTIME_TITLE_BYTES: usize = 512;
pub const MAX_RUNTIME_ENTRIES: usize = 2_048;
pub const MAX_RUNTIME_QUEUE: usize = 8;
pub const MAX_RUNTIME_HOLD: usize = MAX_RUNTIME_QUEUE + 1;
pub const MAX_RUNTIME_HOST_OPERATIONS: usize = 64;
pub const MAX_RUNTIME_PERMISSIONS: usize = 32;
pub const MAX_RUNTIME_AGENTS: usize = 64;
pub const MAX_RUNTIME_PLANS: usize = 64;
pub const MAX_RUNTIME_TASK_LISTS: usize = 64;
pub const MAX_RUNTIME_TIMELINE: usize = 4_096;
pub const MAX_RUNTIME_COMPLETIONS: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeError {
    Invalid { field: String, reason: String },
    QueueFull,
    MissingThread(String),
    MissingPermission(String),
    MissingQueuedTurn(String),
    MissingOperation(String),
    StaleSequence { sequence: u64, last: u64 },
    Protocol(String),
    Unavailable(String),
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid { field, reason } => write!(formatter, "{field} is invalid: {reason}"),
            Self::QueueFull => formatter.write_str("the run queue is full"),
            Self::MissingThread(id) => write!(formatter, "thread {id} is not loaded"),
            Self::MissingPermission(id) => {
                write!(formatter, "permission request {id} is not pending")
            }
            Self::MissingQueuedTurn(id) => write!(formatter, "queued turn {id} is not pending"),
            Self::MissingOperation(id) => {
                write!(formatter, "runtime operation {id} is not pending")
            }
            Self::StaleSequence { sequence, last } => write!(
                formatter,
                "event sequence {sequence} is not newer than {last}"
            ),
            Self::Protocol(message) => formatter.write_str(message),
            Self::Unavailable(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for RuntimeError {}

fn invalid(field: &str, reason: impl Into<String>) -> RuntimeError {
    RuntimeError::Invalid {
        field: field.to_owned(),
        reason: reason.into(),
    }
}

fn text(value: &str, field: &str, max: usize, required: bool) -> Result<String, RuntimeError> {
    if value.len() > max {
        return Err(invalid(field, format!("more than {max} bytes")));
    }
    if value.contains('\0') {
        return Err(invalid(field, "contains a NUL character"));
    }
    if required && value.trim().is_empty() {
        return Err(invalid(field, "is empty"));
    }
    Ok(value.to_owned())
}

fn id(value: &str, field: &str) -> Result<String, RuntimeError> {
    let value = text(value, field, MAX_RUNTIME_ID_BYTES, true)?;
    if value.chars().any(char::is_whitespace) || value.chars().any(char::is_control) {
        return Err(invalid(field, "contains whitespace or control characters"));
    }
    Ok(value)
}

fn optional_text(
    value: Option<&str>,
    field: &str,
    max: usize,
) -> Result<Option<String>, RuntimeError> {
    value
        .map(|value| text(value, field, max, false))
        .transpose()
}

fn json_object() -> Map<String, Value> {
    Map::new()
}

fn put_string(map: &mut Map<String, Value>, key: &str, value: &str) {
    map.insert(key.to_owned(), Value::String(value.to_owned()));
}

fn put_optional_string(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        put_string(map, key, value);
    }
}

fn parse_string(
    object: &Map<String, Value>,
    key: &str,
    field: &str,
    max: usize,
    required: bool,
) -> Result<Option<String>, RuntimeError> {
    match object.get(key) {
        Some(Value::String(value)) => text(value, field, max, required).map(Some),
        Some(Value::Null) if !required => Ok(None),
        Some(_) => Err(invalid(field, "must be a string")),
        None if required => Err(invalid(field, "is missing")),
        None => Ok(None),
    }
}

fn parse_u64(
    object: &Map<String, Value>,
    key: &str,
    field: &str,
) -> Result<Option<u64>, RuntimeError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_u64()
            .ok_or_else(|| invalid(field, "must be a non-negative integer"))
            .map(Some),
        Some(Value::String(value)) => value
            .parse::<u64>()
            .map(Some)
            .map_err(|_| invalid(field, "must be a non-negative integer")),
        Some(_) => Err(invalid(field, "must be a non-negative integer")),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum HostCommand {
    Snapshot,
    ThreadSummaries,
    Thread {
        thread_id: String,
    },
    CreateThread {
        title: Option<String>,
        parent_thread_id: Option<String>,
        kind: Option<String>,
    },
    SetThreadArchived {
        thread_id: String,
        archived: bool,
    },
    RenameThread {
        thread_id: String,
        title: String,
    },
    RecordTurn {
        thread_id: String,
        prompt: String,
        response: String,
        output_tokens: u64,
        duration_milliseconds: u64,
        input_tokens: u64,
        cache_input_tokens: Option<u64>,
        cache_read_tokens: Option<u64>,
        cache_write_tokens: Option<u64>,
        cost_micro_usd: Option<u64>,
        model: Option<String>,
    },
    SetGoal {
        thread_id: String,
        objective: String,
        token_budget: Option<u64>,
    },
    UpdateGoal {
        thread_id: String,
        status: Option<String>,
        evidence: Option<String>,
        reason: Option<String>,
        extra_tokens: Option<u64>,
    },
    ClearGoal {
        thread_id: String,
    },
    RecordTrace {
        thread_id: String,
        trace: String,
    },
    ReadTrace {
        thread_id: String,
    },
    SaveScheduledJob {
        job_id: Option<String>,
        title: String,
        schedule: String,
        prompt: String,
        nodes: String,
        source_domains: Vec<String>,
        permission_mode: String,
        model: String,
    },
    DeleteScheduledJob {
        job_id: String,
    },
    RunScheduledJob {
        job_id: String,
        variables: String,
    },
    FinishScheduledJob {
        job_id: String,
        outputs: String,
        depth: u32,
    },
    FireScheduledEvent {
        event: String,
        variables: String,
    },
    SetScheduledJobEnabled {
        job_id: String,
        enabled: bool,
    },
    SaveResearchJob {
        job_id: Option<String>,
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
    },
    DeleteResearchJob {
        job_id: String,
    },
    SetResearchJobStatus {
        job_id: String,
        status: String,
        note: String,
    },
    SetResearchJobThread {
        job_id: String,
        thread_id: String,
    },
    RecordResearchIteration {
        job_id: String,
        value: Option<f64>,
        outcome: String,
        note: String,
        commit: String,
        duration_milliseconds: u64,
        input_tokens: u64,
        output_tokens: u64,
        micro_dollars: u64,
    },
}

impl HostCommand {
    pub fn method(&self) -> &'static str {
        match self {
            Self::Snapshot => "snapshot",
            Self::ThreadSummaries => "threadSummaries",
            Self::Thread { .. } => "thread",
            Self::CreateThread { .. } => "createThread",
            Self::SetThreadArchived { .. } => "setThreadArchived",
            Self::RenameThread { .. } => "renameThread",
            Self::RecordTurn { .. } => "recordTurn",
            Self::SetGoal { .. } => "setGoal",
            Self::UpdateGoal { .. } => "updateGoal",
            Self::ClearGoal { .. } => "clearGoal",
            Self::RecordTrace { .. } => "recordTrace",
            Self::ReadTrace { .. } => "readTrace",
            Self::SaveScheduledJob { .. } => "saveScheduledJob",
            Self::DeleteScheduledJob { .. } => "deleteScheduledJob",
            Self::RunScheduledJob { .. } => "runScheduledJob",
            Self::FinishScheduledJob { .. } => "finishScheduledJob",
            Self::FireScheduledEvent { .. } => "fireScheduledEvent",
            Self::SetScheduledJobEnabled { .. } => "setScheduledJobEnabled",
            Self::SaveResearchJob { .. } => "saveResearchJob",
            Self::DeleteResearchJob { .. } => "deleteResearchJob",
            Self::SetResearchJobStatus { .. } => "setResearchJobStatus",
            Self::SetResearchJobThread { .. } => "setResearchJobThread",
            Self::RecordResearchIteration { .. } => "recordResearchIteration",
        }
    }

    pub fn params(&self) -> Result<Value, RuntimeError> {
        let mut map = json_object();
        match self {
            Self::Snapshot | Self::ThreadSummaries | Self::ReadTrace { .. } => {}
            Self::Thread { thread_id } | Self::ClearGoal { thread_id } => {
                put_string(&mut map, "threadId", thread_id)
            }
            Self::CreateThread {
                title,
                parent_thread_id,
                kind,
            } => {
                put_optional_string(&mut map, "title", title.as_deref());
                put_optional_string(&mut map, "parentThreadId", parent_thread_id.as_deref());
                put_optional_string(&mut map, "kind", kind.as_deref());
            }
            Self::SetThreadArchived {
                thread_id,
                archived,
            } => {
                put_string(&mut map, "threadId", thread_id);
                put_string(
                    &mut map,
                    "archived",
                    if *archived { "true" } else { "false" },
                );
            }
            Self::RenameThread { thread_id, title } => {
                put_string(&mut map, "threadId", thread_id);
                put_string(&mut map, "title", title);
            }
            Self::RecordTurn {
                thread_id,
                prompt,
                response,
                output_tokens,
                duration_milliseconds,
                input_tokens,
                cache_input_tokens,
                cache_read_tokens,
                cache_write_tokens,
                cost_micro_usd,
                model,
            } => {
                put_string(&mut map, "threadId", thread_id);
                put_string(&mut map, "prompt", prompt);
                put_string(&mut map, "response", response);
                put_string(&mut map, "outputTokens", &output_tokens.to_string());
                put_string(
                    &mut map,
                    "durationMilliseconds",
                    &duration_milliseconds.to_string(),
                );
                put_string(&mut map, "inputTokens", &input_tokens.to_string());
                put_optional_string(
                    &mut map,
                    "cacheInputTokens",
                    cache_input_tokens.map(|value| value.to_string()).as_deref(),
                );
                put_optional_string(
                    &mut map,
                    "cacheReadTokens",
                    cache_read_tokens.map(|value| value.to_string()).as_deref(),
                );
                put_optional_string(
                    &mut map,
                    "cacheWriteTokens",
                    cache_write_tokens.map(|value| value.to_string()).as_deref(),
                );
                put_optional_string(
                    &mut map,
                    "costMicroUsd",
                    cost_micro_usd.map(|value| value.to_string()).as_deref(),
                );
                put_optional_string(&mut map, "model", model.as_deref());
            }
            Self::SetGoal {
                thread_id,
                objective,
                token_budget,
            } => {
                put_string(&mut map, "threadId", thread_id);
                put_string(&mut map, "objective", objective);
                put_optional_string(
                    &mut map,
                    "tokenBudget",
                    token_budget.map(|value| value.to_string()).as_deref(),
                );
            }
            Self::UpdateGoal {
                thread_id,
                status,
                evidence,
                reason,
                extra_tokens,
            } => {
                put_string(&mut map, "threadId", thread_id);
                put_optional_string(&mut map, "status", status.as_deref());
                put_optional_string(&mut map, "evidence", evidence.as_deref());
                put_optional_string(&mut map, "reason", reason.as_deref());
                put_optional_string(
                    &mut map,
                    "extraTokens",
                    extra_tokens.map(|value| value.to_string()).as_deref(),
                );
            }
            Self::RecordTrace { thread_id, trace } => {
                put_string(&mut map, "threadId", thread_id);
                put_string(&mut map, "trace", trace);
            }
            Self::SaveScheduledJob {
                job_id,
                title,
                schedule,
                prompt,
                nodes,
                source_domains,
                permission_mode,
                model,
            } => {
                put_optional_string(&mut map, "jobId", job_id.as_deref());
                put_string(&mut map, "title", title);
                put_string(&mut map, "schedule", schedule);
                put_string(&mut map, "prompt", prompt);
                put_string(&mut map, "nodes", nodes);
                let domains = serde_json::to_string(source_domains)
                    .map_err(|error| RuntimeError::Protocol(error.to_string()))?;
                put_string(&mut map, "sourceDomains", &domains);
                put_string(&mut map, "permissionMode", permission_mode);
                put_string(&mut map, "model", model);
            }
            Self::DeleteScheduledJob { job_id } | Self::RunScheduledJob { job_id, .. } => {
                put_string(&mut map, "jobId", job_id)
            }
            Self::FinishScheduledJob {
                job_id,
                outputs,
                depth,
            } => {
                put_string(&mut map, "jobId", job_id);
                put_string(&mut map, "outputs", outputs);
                put_string(&mut map, "depth", &depth.to_string());
            }
            Self::FireScheduledEvent { event, variables } => {
                put_string(&mut map, "event", event);
                put_string(&mut map, "variables", variables);
            }
            Self::SetScheduledJobEnabled { job_id, enabled } => {
                put_string(&mut map, "jobId", job_id);
                put_string(&mut map, "enabled", if *enabled { "true" } else { "false" });
            }
            Self::SaveResearchJob {
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
            } => {
                put_optional_string(&mut map, "jobId", job_id.as_deref());
                put_string(&mut map, "title", title);
                put_string(&mut map, "projectDir", project_dir);
                put_string(&mut map, "metricName", metric_name);
                put_string(&mut map, "metricKind", metric_kind);
                put_string(&mut map, "metricPrompt", metric_prompt);
                put_string(&mut map, "direction", direction);
                put_string(&mut map, "evalCommand", eval_command);
                put_string(&mut map, "prompt", prompt);
                put_string(&mut map, "proposerModel", proposer_model);
                put_string(&mut map, "permissionMode", permission_mode);
                put_string(&mut map, "maxSeconds", &max_seconds.to_string());
                put_string(&mut map, "maxTokens", &max_tokens.to_string());
                put_string(&mut map, "maxMicroDollars", &max_micro_dollars.to_string());
            }
            Self::DeleteResearchJob { job_id } | Self::SetResearchJobStatus { job_id, .. } => {
                put_string(&mut map, "jobId", job_id);
            }
            Self::SetResearchJobThread { job_id, thread_id } => {
                put_string(&mut map, "jobId", job_id);
                put_string(&mut map, "threadId", thread_id);
            }
            Self::RecordResearchIteration {
                job_id,
                value,
                outcome,
                note,
                commit,
                duration_milliseconds,
                input_tokens,
                output_tokens,
                micro_dollars,
            } => {
                put_string(&mut map, "jobId", job_id);
                if let Some(value) = value {
                    if !value.is_finite() {
                        return Err(invalid("value", "must be finite"));
                    }
                    put_string(&mut map, "value", &value.to_string());
                }
                put_string(&mut map, "outcome", outcome);
                put_string(&mut map, "note", note);
                put_string(&mut map, "commit", commit);
                put_string(
                    &mut map,
                    "durationMilliseconds",
                    &duration_milliseconds.to_string(),
                );
                put_string(&mut map, "inputTokens", &input_tokens.to_string());
                put_string(&mut map, "outputTokens", &output_tokens.to_string());
                put_string(&mut map, "microDollars", &micro_dollars.to_string());
            }
        }
        if matches!(self, Self::ReadTrace { .. })
            && let Self::ReadTrace { thread_id } = self
        {
            put_string(&mut map, "threadId", thread_id);
        }
        if let Self::RunScheduledJob { variables, .. } = self {
            put_string(&mut map, "variables", variables);
        }
        if let Self::SetResearchJobStatus { status, note, .. } = self {
            put_string(&mut map, "status", status);
            put_string(&mut map, "note", note);
        }
        Ok(Value::Object(map))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostGeneration {
    pub model: String,
    pub output_tokens: u64,
    pub duration_milliseconds: u64,
    pub input_tokens: u64,
    pub cache_input_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub cost_micro_usd: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostMessage {
    pub role: ConversationRole,
    pub content: String,
    pub timestamp: String,
    pub generation: Option<HostGeneration>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostThreadSummary {
    pub id: String,
    pub title: String,
    pub parent_thread_id: Option<String>,
    pub kind: Option<String>,
    pub scheduled_job_id: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub archived_at: Option<String>,
    pub display_title: Option<String>,
    pub label_prompt: Option<String>,
    pub subagent_brief: Option<String>,
    pub goal: Option<Value>,
    pub message_count: usize,
    pub messages: Option<Vec<HostMessage>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostSnapshot {
    pub threads: Vec<HostThreadSummary>,
    pub scheduled_jobs: Vec<Value>,
    pub research_jobs: Vec<Value>,
    pub warnings: Vec<String>,
}

fn object<'a>(value: &'a Value, field: &str) -> Result<&'a Map<String, Value>, RuntimeError> {
    value
        .as_object()
        .ok_or_else(|| invalid(field, "must be an object"))
}

fn array<'a>(value: &'a Value, field: &str) -> Result<&'a Vec<Value>, RuntimeError> {
    value
        .as_array()
        .ok_or_else(|| invalid(field, "must be an array"))
}

fn object_array(
    object: &Map<String, Value>,
    key: &str,
    field: &str,
) -> Result<Vec<Value>, RuntimeError> {
    let values = match object.get(key) {
        None | Some(Value::Null) => Vec::new(),
        Some(value) => array(value, field)?.clone(),
    };
    if values.len() > MAX_RUNTIME_PLANS {
        return Err(invalid(field, "contains too many entries"));
    }
    for value in &values {
        if !value.is_object() {
            return Err(invalid(field, "entries must be objects"));
        }
    }
    Ok(values)
}

fn parse_role(value: &str) -> Result<ConversationRole, RuntimeError> {
    match value {
        "user" => Ok(ConversationRole::User),
        "assistant" => Ok(ConversationRole::Assistant),
        "system" => Ok(ConversationRole::System),
        _ => Err(invalid("role", "must be user, assistant, or system")),
    }
}

fn parse_generation(value: &Value) -> Result<HostGeneration, RuntimeError> {
    let object = object(value, "generation")?;
    let model = parse_string(
        object,
        "model",
        "generation model",
        MAX_RUNTIME_TITLE_BYTES,
        false,
    )?
    .unwrap_or_default();
    Ok(HostGeneration {
        model,
        output_tokens: parse_u64(object, "outputTokens", "output tokens")?.unwrap_or_default(),
        duration_milliseconds: parse_u64(object, "durationMilliseconds", "duration")?
            .unwrap_or_default(),
        input_tokens: parse_u64(object, "inputTokens", "input tokens")?.unwrap_or_default(),
        cache_input_tokens: parse_u64(object, "cacheInputTokens", "cache input tokens")?,
        cache_read_tokens: parse_u64(object, "cacheReadTokens", "cache read tokens")?,
        cache_write_tokens: parse_u64(object, "cacheWriteTokens", "cache write tokens")?,
        cost_micro_usd: parse_u64(object, "costMicroUsd", "cost")?,
    })
}

fn parse_message(value: &Value) -> Result<HostMessage, RuntimeError> {
    let object = object(value, "message")?;
    let role = parse_role(
        parse_string(
            object,
            "role",
            "message role",
            MAX_RUNTIME_TITLE_BYTES,
            true,
        )?
        .as_deref()
        .unwrap_or_default(),
    )?;
    let content = parse_string(
        object,
        "content",
        "message content",
        MAX_RUNTIME_TEXT_BYTES,
        true,
    )?
    .unwrap_or_default();
    let timestamp = parse_string(
        object,
        "timestamp",
        "message timestamp",
        MAX_RUNTIME_TITLE_BYTES,
        true,
    )?
    .unwrap_or_default();
    let generation = match object.get("generation") {
        None | Some(Value::Null) => None,
        Some(value) => Some(parse_generation(value)?),
    };
    Ok(HostMessage {
        role,
        content,
        timestamp,
        generation,
    })
}

fn parse_thread_summary(value: &Value) -> Result<HostThreadSummary, RuntimeError> {
    let object = object(value, "thread")?;
    let thread_id =
        parse_string(object, "id", "thread ID", MAX_RUNTIME_ID_BYTES, true)?.unwrap_or_default();
    let normalized_id = id(&thread_id, "thread ID")?;
    let title = parse_string(
        object,
        "title",
        "thread title",
        MAX_RUNTIME_TITLE_BYTES,
        false,
    )?
    .unwrap_or_else(|| "New thread".to_owned());
    let parent_thread_id = parse_string(
        object,
        "parentThreadId",
        "parent thread ID",
        MAX_RUNTIME_ID_BYTES,
        false,
    )?;
    let parent_thread_id = parent_thread_id
        .as_deref()
        .map(|value| id(value, "parent thread ID"))
        .transpose()?;
    let kind = parse_string(
        object,
        "kind",
        "thread kind",
        MAX_RUNTIME_TITLE_BYTES,
        false,
    )?;
    let scheduled_job_id = parse_string(
        object,
        "scheduledJobId",
        "scheduled job ID",
        MAX_RUNTIME_ID_BYTES,
        false,
    )?;
    let created_at = parse_string(
        object,
        "createdAt",
        "thread creation time",
        MAX_RUNTIME_TITLE_BYTES,
        false,
    )?;
    let updated_at = parse_string(
        object,
        "updatedAt",
        "thread update time",
        MAX_RUNTIME_TITLE_BYTES,
        false,
    )?;
    let archived_at = parse_string(
        object,
        "archivedAt",
        "archive time",
        MAX_RUNTIME_TITLE_BYTES,
        false,
    )?;
    let display_title = parse_string(
        object,
        "displayTitle",
        "display title",
        MAX_RUNTIME_TITLE_BYTES,
        false,
    )?;
    let label_prompt = parse_string(
        object,
        "labelPrompt",
        "label prompt",
        MAX_RUNTIME_TEXT_BYTES,
        false,
    )?;
    let subagent_brief = parse_string(
        object,
        "subagentBrief",
        "subagent brief",
        MAX_RUNTIME_TEXT_BYTES,
        false,
    )?;
    let goal = match object.get("goal") {
        None | Some(Value::Null) => None,
        Some(value) if value.is_object() => Some(value.clone()),
        Some(_) => return Err(invalid("goal", "must be an object or null")),
    };
    let (message_count, messages) = match object.get("messages") {
        None | Some(Value::Null) => (0, None),
        Some(Value::Number(value)) => {
            let count = value
                .as_u64()
                .ok_or_else(|| invalid("messages", "must be a non-negative integer or array"))?;
            let count = usize::try_from(count).map_err(|_| invalid("messages", "is too large"))?;
            (count, None)
        }
        Some(value) => {
            let values = array(value, "messages")?;
            if values.len() > MAX_RUNTIME_ENTRIES {
                return Err(invalid("messages", "contains too many entries"));
            }
            let messages = values
                .iter()
                .map(parse_message)
                .collect::<Result<Vec<_>, _>>()?;
            (messages.len(), Some(messages))
        }
    };
    Ok(HostThreadSummary {
        id: normalized_id,
        title,
        parent_thread_id,
        kind,
        scheduled_job_id,
        created_at,
        updated_at,
        archived_at,
        display_title,
        label_prompt,
        subagent_brief,
        goal,
        message_count,
        messages,
    })
}

pub fn parse_host_snapshot(value: &Value) -> Result<HostSnapshot, RuntimeError> {
    let encoded =
        serde_json::to_vec(value).map_err(|error| RuntimeError::Protocol(error.to_string()))?;
    if encoded.len() > 64 * 1024 * 1024 {
        return Err(invalid("snapshot", "is too large"));
    }
    let object = object(value, "snapshot")?;
    let threads = array(
        object
            .get("threads")
            .ok_or_else(|| invalid("threads", "is missing"))?,
        "threads",
    )?;
    if threads.len() > MAX_RUNTIME_ENTRIES {
        return Err(invalid("threads", "contains too many entries"));
    }
    let threads = threads
        .iter()
        .map(parse_thread_summary)
        .collect::<Result<Vec<_>, _>>()?;
    let scheduled_jobs = object_array(object, "scheduledJobs", "scheduled jobs")?;
    let research_jobs = object_array(object, "researchJobs", "research jobs")?;
    let warnings = match object.get("warnings") {
        None | Some(Value::Null) => Vec::new(),
        Some(value) => {
            let warnings = array(value, "warnings")?;
            if warnings.len() > MAX_RUNTIME_ENTRIES {
                return Err(invalid("warnings", "contains too many entries"));
            }
            warnings
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .ok_or_else(|| invalid("warning", "must be a string"))
                        .and_then(|value| text(value, "warning", MAX_RUNTIME_TEXT_BYTES, false))
                })
                .collect::<Result<Vec<_>, _>>()?
        }
    };
    Ok(HostSnapshot {
        threads,
        scheduled_jobs,
        research_jobs,
        warnings,
    })
}

pub fn parse_host_thread(value: &Value) -> Result<HostThreadSummary, RuntimeError> {
    let encoded =
        serde_json::to_vec(value).map_err(|error| RuntimeError::Protocol(error.to_string()))?;
    if encoded.len() > 64 * 1024 * 1024 {
        return Err(invalid("thread", "is too large"));
    }
    let summary = parse_thread_summary(value)?;
    if summary.messages.is_none() {
        return Err(invalid(
            "messages",
            "full thread response must include an array",
        ));
    }
    Ok(summary)
}

fn validate_host_value(value: &Value, field: &str) -> Result<(), RuntimeError> {
    let encoded =
        serde_json::to_vec(value).map_err(|error| RuntimeError::Protocol(error.to_string()))?;
    if encoded.len() > 64 * 1024 * 1024 {
        return Err(invalid(field, "is too large"));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServiceStatus {
    Starting,
    Ready,
    Restarting,
    Offline,
    Degraded,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeIssue {
    pub message: String,
    pub recoverable: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RuntimeUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_input_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub cost_micro_usd: Option<u64>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RuntimeContext {
    pub system_prompt_bytes: u64,
    pub system_tools_bytes: u64,
    pub mcp_tools_bytes: u64,
    pub skills_bytes: u64,
    pub memory_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimePermissionOption {
    pub id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimePermissionRequest {
    pub id: String,
    pub thread_id: String,
    pub session_id: Option<String>,
    pub mode: PermissionMode,
    pub title: String,
    pub tool: String,
    pub detail: String,
    pub options: Vec<RuntimePermissionOption>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeToolCall {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub tool_name: Option<String>,
    pub status: StepStatus,
    pub input: String,
    pub output: String,
    pub path: Option<String>,
    pub edit: Option<EditDiff>,
    pub artifact_id: Option<String>,
    pub goal_thread_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeAgentUpdate {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub brief: String,
    pub color: Option<String>,
    pub status: NestedAgentStatus,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub activity: Option<String>,
    pub prompt: Option<String>,
    pub tool: bool,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub steps: usize,
    pub tool_calls: usize,
    pub input_tokens: usize,
    pub output_tokens: usize,
    pub generation_ms: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimePlanStep {
    pub id: String,
    pub title: String,
    pub status: String,
    pub needs: Vec<String>,
    pub brief: String,
    pub result: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimePlan {
    pub id: String,
    pub title: String,
    pub goal: String,
    pub updated_at: String,
    pub steps: Vec<RuntimePlanStep>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeTask {
    pub id: String,
    pub title: String,
    pub status: String,
    pub parent_id: Option<String>,
    pub depth: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeTaskList {
    pub id: String,
    pub title: String,
    pub goal: String,
    pub updated_at: String,
    pub tasks: Vec<RuntimeTask>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeTimelineSpan {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub status: String,
    pub input: Option<String>,
    pub output: Option<String>,
    pub tokens: Option<usize>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeQueuedTurn {
    pub id: String,
    pub timestamp: String,
    pub submission: ComposerSubmission,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeActiveTurn {
    pub id: String,
    pub timestamp: String,
    pub submission: ComposerSubmission,
    pub response: String,
    pub thought: String,
    pub started_at: u64,
    pub generation: u64,
    pub stop_requested: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeThread {
    pub id: String,
    pub title: String,
    pub page: ConversationPage,
    pub active: Option<RuntimeActiveTurn>,
    pub queued: VecDeque<RuntimeQueuedTurn>,
    pub held: VecDeque<RuntimeQueuedTurn>,
    pub usage: RuntimeUsage,
    pub context: RuntimeContext,
    pub agents: BTreeMap<String, RuntimeAgentUpdate>,
    pub plans: Vec<RuntimePlan>,
    pub tasks: Vec<RuntimeTaskList>,
    pub timeline: Vec<RuntimeTimelineSpan>,
    pub routed_model: Option<String>,
    pub last_sequence: u64,
}

impl RuntimeThread {
    fn new(id: String, title: String) -> Self {
        Self {
            page: ConversationPage {
                thread_id: id.clone(),
                thread_title: title.clone(),
                load_state: ConversationLoadState::Loading,
                ..ConversationPage::default()
            },
            id,
            title,
            active: None,
            queued: VecDeque::new(),
            held: VecDeque::new(),
            usage: RuntimeUsage::default(),
            context: RuntimeContext::default(),
            agents: BTreeMap::new(),
            plans: Vec::new(),
            tasks: Vec::new(),
            timeline: Vec::new(),
            routed_model: None,
            last_sequence: 0,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeState {
    pub status: ServiceStatus,
    pub generation: u64,
    pub sequence: u64,
    pub snapshot: Option<HostSnapshot>,
    pub selected_thread: Option<String>,
    pub threads: BTreeMap<String, RuntimeThread>,
    pub permissions: BTreeMap<String, RuntimePermissionRequest>,
    pub last_error: Option<RuntimeIssue>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CompletionCommand {
    Open(CompletionMenu),
    Move(isize),
    Select(String),
    Dismiss,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RuntimeCommand {
    HydrateSnapshot,
    HydrateThread {
        thread_id: String,
    },
    Submit {
        thread_id: String,
        timestamp: String,
        started_at: u64,
        submission: ComposerSubmission,
    },
    Queue {
        thread_id: String,
        timestamp: String,
        submission: ComposerSubmission,
    },
    Stop {
        thread_id: String,
    },
    ConfirmStop {
        thread_id: String,
    },
    AnswerPermission {
        request_id: String,
        option_id: Option<String>,
    },
    DropQueued {
        thread_id: String,
        turn_id: String,
    },
    SteerQueued {
        thread_id: String,
        turn_id: String,
        text: String,
    },
    ReleaseHeld {
        thread_id: String,
        turn_id: String,
    },
    DropHeld {
        thread_id: String,
        turn_id: String,
    },
    Completion {
        thread_id: String,
        command: CompletionCommand,
    },
    Restart,
    Retry {
        thread_id: String,
    },
    Host(HostCommand),
}

#[derive(Clone, Debug, PartialEq)]
pub enum RuntimeAcpEvent {
    Ready,
    AssistantDelta {
        thread_id: String,
        text: String,
    },
    ThinkingDelta {
        thread_id: String,
        text: String,
    },
    ToolCall {
        thread_id: String,
        call: RuntimeToolCall,
    },
    Diff {
        thread_id: String,
        tool_call_id: String,
        edit: EditDiff,
    },
    PermissionAsked(RuntimePermissionRequest),
    PermissionResolved {
        request_id: String,
        allowed: bool,
    },
    Subagent(RuntimeAgentUpdate),
    Plan {
        thread_id: String,
        plan: RuntimePlan,
    },
    Tasks {
        thread_id: String,
        tasks: RuntimeTaskList,
    },
    Timeline {
        thread_id: String,
        span: RuntimeTimelineSpan,
    },
    Usage {
        thread_id: String,
        usage: RuntimeUsage,
    },
    Context {
        thread_id: String,
        context: RuntimeContext,
    },
    Completion {
        thread_id: String,
        menu: Option<CompletionMenu>,
    },
    Compacted {
        thread_id: String,
        removed_turns: usize,
        summary_chars: usize,
        model_written: bool,
    },
    RoutedModel {
        thread_id: String,
        model: String,
        fell_back: bool,
    },
    Recovery {
        thread_id: String,
        message: String,
        paused: bool,
        attempt: Option<usize>,
        attempt_limit: Option<usize>,
        delay_seconds: Option<u64>,
    },
    Completed {
        thread_id: String,
        stop_reason: String,
        completed_at: u64,
        usage: RuntimeUsage,
    },
    Error {
        thread_id: Option<String>,
        message: String,
        recoverable: bool,
    },
    ChildExited {
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum RuntimeEvent {
    Status {
        status: ServiceStatus,
        generation: u64,
    },
    SnapshotHydrated {
        thread_ids: Vec<String>,
        warnings: Vec<String>,
    },
    ThreadHydrated {
        thread_id: String,
    },
    RunStarted {
        thread_id: String,
        turn_id: String,
    },
    Queued {
        thread_id: String,
        turn_id: String,
        position: usize,
    },
    QueueDropped {
        thread_id: String,
        turn_id: String,
    },
    QueueHeld {
        thread_id: String,
        turn_id: String,
    },
    QueueReleased {
        thread_id: String,
        turn_id: String,
    },
    QueueSteered {
        thread_id: String,
        turn_id: String,
    },
    AssistantDelta {
        thread_id: String,
        text: String,
    },
    ThinkingDelta {
        thread_id: String,
        text: String,
    },
    ToolUpdated {
        thread_id: String,
        step: ToolStep,
    },
    DiffUpdated {
        thread_id: String,
        tool_call_id: String,
    },
    PermissionAsked(RuntimePermissionRequest),
    PermissionResolved {
        request_id: String,
        allowed: bool,
    },
    SubagentUpdated(RuntimeAgentUpdate),
    PlanUpdated {
        thread_id: String,
        plan_id: String,
    },
    TasksUpdated {
        thread_id: String,
        list_id: String,
    },
    TimelineUpdated {
        thread_id: String,
        span_id: String,
    },
    UsageUpdated {
        thread_id: String,
        usage: RuntimeUsage,
    },
    ContextUpdated {
        thread_id: String,
        context: RuntimeContext,
    },
    CompletionUpdated {
        thread_id: String,
        menu: Option<CompletionMenu>,
    },
    CompletionText {
        thread_id: String,
        text: String,
        caret: usize,
    },
    Compacted {
        thread_id: String,
        removed_turns: usize,
        summary_chars: usize,
        model_written: bool,
    },
    RoutedModel {
        thread_id: String,
        model: String,
        fell_back: bool,
    },
    Recovery {
        thread_id: String,
        message: String,
        paused: bool,
        attempt: Option<usize>,
        attempt_limit: Option<usize>,
        delay_seconds: Option<u64>,
    },
    StopConfirmationArmed {
        thread_id: String,
    },
    RunFinished {
        thread_id: String,
        stop_reason: String,
    },
    RunFailed {
        thread_id: Option<String>,
        message: String,
        recoverable: bool,
    },
    RunStopped {
        thread_id: String,
        reason: String,
    },
    HostOperationSucceeded {
        operation_id: String,
        method: String,
        result: Value,
    },
    HostOperationFailed {
        operation_id: String,
        method: String,
        message: String,
    },
    Unavailable {
        capability: String,
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum RuntimeEffect {
    HostRequest {
        operation_id: String,
        method: String,
        params: Value,
    },
    AcpPrompt {
        thread_id: String,
        submission: ComposerSubmission,
        generation: u64,
    },
    AcpCancel {
        thread_id: String,
        generation: u64,
    },
    AcpAnswerPermission {
        request_id: String,
        session_id: Option<String>,
        option_id: Option<String>,
    },
    RestartAcp {
        generation: u64,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RuntimeOutput {
    pub events: Vec<RuntimeEvent>,
    pub effects: Vec<RuntimeEffect>,
}

#[derive(Clone, Debug)]
struct PendingHost {
    command: HostCommand,
}

pub struct RuntimeService {
    pub state: RuntimeState,
    next_sequence: u64,
    next_operation: u64,
    next_turn: u64,
    pending_host: BTreeMap<String, PendingHost>,
    restart_pending: bool,
}

impl Default for RuntimeService {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeService {
    pub fn new() -> Self {
        Self {
            state: RuntimeState {
                status: ServiceStatus::Starting,
                generation: 1,
                sequence: 0,
                snapshot: None,
                selected_thread: None,
                threads: BTreeMap::new(),
                permissions: BTreeMap::new(),
                last_error: None,
            },
            next_sequence: 1,
            next_operation: 1,
            next_turn: 1,
            pending_host: BTreeMap::new(),
            restart_pending: false,
        }
    }

    pub fn thread(&self, thread_id: &str) -> Option<&RuntimeThread> {
        self.state.threads.get(thread_id)
    }

    pub fn selected_page(&self) -> Option<&ConversationPage> {
        self.state
            .selected_thread
            .as_deref()
            .and_then(|id| self.state.threads.get(id))
            .map(|thread| &thread.page)
    }

    pub fn dispatch(&mut self, command: RuntimeCommand) -> Result<RuntimeOutput, RuntimeError> {
        match command {
            RuntimeCommand::HydrateSnapshot => self.host_effect(HostCommand::Snapshot),
            RuntimeCommand::HydrateThread { thread_id } => {
                let thread_id = id(&thread_id, "thread ID")?;
                self.host_effect(HostCommand::Thread { thread_id })
            }
            RuntimeCommand::Submit {
                thread_id,
                timestamp,
                started_at,
                submission,
            } => self.submit(thread_id, timestamp, started_at, submission, false),
            RuntimeCommand::Queue {
                thread_id,
                timestamp,
                submission,
            } => self.submit(thread_id, timestamp, 0, submission, true),
            RuntimeCommand::Stop { thread_id } => self.stop(&thread_id),
            RuntimeCommand::ConfirmStop { thread_id } => self.confirm_stop(&thread_id),
            RuntimeCommand::AnswerPermission {
                request_id,
                option_id,
            } => self.answer_permission(request_id, option_id),
            RuntimeCommand::DropQueued { thread_id, turn_id } => {
                self.drop_queued(&thread_id, &turn_id)
            }
            RuntimeCommand::SteerQueued {
                thread_id,
                turn_id,
                text,
            } => self.steer_queued(&thread_id, &turn_id, text),
            RuntimeCommand::ReleaseHeld { thread_id, turn_id } => {
                self.release_held(&thread_id, &turn_id)
            }
            RuntimeCommand::DropHeld { thread_id, turn_id } => self.drop_held(&thread_id, &turn_id),
            RuntimeCommand::Completion { thread_id, command } => {
                self.completion(&thread_id, command)
            }
            RuntimeCommand::Restart => self.restart(),
            RuntimeCommand::Retry { thread_id } => self.retry(&thread_id),
            RuntimeCommand::Host(command) => self.host_effect(command),
        }
    }

    pub fn accept_acp(&mut self, event: RuntimeAcpEvent) -> Result<RuntimeOutput, RuntimeError> {
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1).max(1);
        self.accept_acp_at(sequence, event)
    }

    pub fn accept_acp_at(
        &mut self,
        sequence: u64,
        event: RuntimeAcpEvent,
    ) -> Result<RuntimeOutput, RuntimeError> {
        if sequence <= self.state.sequence {
            return Err(RuntimeError::StaleSequence {
                sequence,
                last: self.state.sequence,
            });
        }
        self.state.sequence = sequence;
        self.next_sequence = self.next_sequence.max(sequence.saturating_add(1).max(1));
        match event {
            RuntimeAcpEvent::Ready => self.ready(),
            RuntimeAcpEvent::AssistantDelta { thread_id, text } => {
                self.delta(thread_id, text, false)
            }
            RuntimeAcpEvent::ThinkingDelta { thread_id, text } => self.delta(thread_id, text, true),
            RuntimeAcpEvent::ToolCall { thread_id, call } => self.tool_call(thread_id, call),
            RuntimeAcpEvent::Diff {
                thread_id,
                tool_call_id,
                edit,
            } => self.diff(thread_id, tool_call_id, edit),
            RuntimeAcpEvent::PermissionAsked(request) => self.permission_asked(request),
            RuntimeAcpEvent::PermissionResolved {
                request_id,
                allowed,
            } => self.permission_resolved(request_id, allowed),
            RuntimeAcpEvent::Subagent(update) => self.subagent(update),
            RuntimeAcpEvent::Plan { thread_id, plan } => self.plan(thread_id, plan),
            RuntimeAcpEvent::Tasks { thread_id, tasks } => self.tasks(thread_id, tasks),
            RuntimeAcpEvent::Timeline { thread_id, span } => self.timeline(thread_id, span),
            RuntimeAcpEvent::Usage { thread_id, usage } => self.usage(thread_id, usage),
            RuntimeAcpEvent::Context { thread_id, context } => self.context(thread_id, context),
            RuntimeAcpEvent::Completion { thread_id, menu } => {
                self.set_completion(&thread_id, menu)
            }
            RuntimeAcpEvent::Compacted {
                thread_id,
                removed_turns,
                summary_chars,
                model_written,
            } => self.compacted(thread_id, removed_turns, summary_chars, model_written),
            RuntimeAcpEvent::RoutedModel {
                thread_id,
                model,
                fell_back,
            } => self.routed_model(thread_id, model, fell_back),
            RuntimeAcpEvent::Recovery {
                thread_id,
                message,
                paused,
                attempt,
                attempt_limit,
                delay_seconds,
            } => self.recovery(
                thread_id,
                message,
                paused,
                attempt,
                attempt_limit,
                delay_seconds,
            ),
            RuntimeAcpEvent::Completed {
                thread_id,
                stop_reason,
                completed_at,
                usage,
            } => self.completed(thread_id, stop_reason, completed_at, usage),
            RuntimeAcpEvent::Error {
                thread_id,
                message,
                recoverable,
            } => self.error(thread_id, message, recoverable),
            RuntimeAcpEvent::ChildExited { message } => self.child_exited(message),
        }
    }

    pub fn accept_host_response(
        &mut self,
        operation_id: String,
        result: Result<Value, String>,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1).max(1);
        if sequence <= self.state.sequence {
            return Err(RuntimeError::StaleSequence {
                sequence,
                last: self.state.sequence,
            });
        }
        self.state.sequence = sequence;
        self.next_sequence = self.next_sequence.max(sequence.saturating_add(1).max(1));
        let pending = self
            .pending_host
            .remove(&operation_id)
            .ok_or_else(|| RuntimeError::MissingOperation(operation_id.clone()))?;
        let method = pending.command.method().to_owned();
        match result {
            Err(message) => {
                let message = text(&message, "host error", MAX_RUNTIME_TEXT_BYTES, true)?;
                self.state.status = ServiceStatus::Degraded;
                self.state.last_error = Some(RuntimeIssue {
                    message: message.clone(),
                    recoverable: true,
                });
                Ok(RuntimeOutput {
                    events: vec![RuntimeEvent::HostOperationFailed {
                        operation_id,
                        method,
                        message,
                    }],
                    effects: Vec::new(),
                })
            }
            Ok(value) => {
                validate_host_value(&value, "host response")?;
                let mut output = RuntimeOutput::default();
                match &pending.command {
                    HostCommand::Snapshot | HostCommand::ThreadSummaries => {
                        let snapshot = parse_host_snapshot(&value)?;
                        output
                            .events
                            .extend(self.hydrate_snapshot(snapshot.clone())?);
                    }
                    HostCommand::Thread { .. }
                    | HostCommand::CreateThread { .. }
                    | HostCommand::RecordTurn { .. } => {
                        let thread = parse_host_thread(&value)?;
                        output.events.push(self.hydrate_thread(thread)?);
                    }
                    _ => {}
                }
                output.events.push(RuntimeEvent::HostOperationSucceeded {
                    operation_id,
                    method,
                    result: value,
                });
                Ok(output)
            }
        }
    }

    fn host_effect(&mut self, command: HostCommand) -> Result<RuntimeOutput, RuntimeError> {
        validate_host_command(&command)?;
        if self.pending_host.len() >= MAX_RUNTIME_HOST_OPERATIONS {
            return Err(RuntimeError::QueueFull);
        }
        let params = match command {
            HostCommand::Snapshot | HostCommand::ThreadSummaries => Value::Null,
            ref command => command.params()?,
        };
        let operation_id = format!("host-{}", self.next_operation);
        self.next_operation = self.next_operation.saturating_add(1).max(1);
        let method = command.method().to_owned();
        self.pending_host
            .insert(operation_id.clone(), PendingHost { command });
        Ok(RuntimeOutput {
            events: Vec::new(),
            effects: vec![RuntimeEffect::HostRequest {
                operation_id,
                method,
                params,
            }],
        })
    }

    fn ensure_thread(&mut self, thread_id: &str) -> Result<&mut RuntimeThread, RuntimeError> {
        let thread_id = id(thread_id, "thread ID")?;
        if !self.state.threads.contains_key(&thread_id) {
            if self.state.threads.len() >= MAX_RUNTIME_ENTRIES {
                return Err(invalid("threads", "contains too many entries"));
            }
            self.state.threads.insert(
                thread_id.clone(),
                RuntimeThread::new(thread_id.clone(), "New thread".to_owned()),
            );
        }
        self.state
            .threads
            .get_mut(&thread_id)
            .ok_or(RuntimeError::MissingThread(thread_id))
    }

    fn submit(
        &mut self,
        thread_id: String,
        timestamp: String,
        started_at: u64,
        submission: ComposerSubmission,
        _queue_only: bool,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(&thread_id, "thread ID")?;
        let timestamp = text(&timestamp, "turn timestamp", MAX_RUNTIME_TITLE_BYTES, true)?;
        validate_submission(&submission)?;
        let turn_id = format!("turn-{}", self.next_turn);
        self.next_turn = self.next_turn.saturating_add(1).max(1);
        let turn = RuntimeQueuedTurn {
            id: turn_id.clone(),
            timestamp,
            submission,
        };
        let thread = self.ensure_thread(&thread_id)?;
        if thread.active.is_some() {
            if thread.queued.len() >= MAX_RUNTIME_QUEUE {
                return Err(RuntimeError::QueueFull);
            }
            thread.page.run.queued.push(QueuedTurn {
                id: turn.id.clone(),
                content: turn.submission.text.clone(),
                steerable: true,
            });
            let position = thread.queued.len();
            thread.queued.push_back(turn);
            return Ok(RuntimeOutput {
                events: vec![RuntimeEvent::Queued {
                    thread_id,
                    turn_id,
                    position,
                }],
                effects: Vec::new(),
            });
        }
        Ok(self.activate_turn(thread_id, turn, started_at))
    }

    fn activate_turn(
        &mut self,
        thread_id: String,
        turn: RuntimeQueuedTurn,
        started_at: u64,
    ) -> RuntimeOutput {
        let generation = self.state.generation;
        let thread = self
            .state
            .threads
            .get_mut(&thread_id)
            .expect("thread ensured before activation");
        let user = ConversationMessage::new(
            format!("{}-user", turn.id),
            ConversationRole::User,
            turn.submission.text.clone(),
            turn.timestamp.clone(),
        );
        thread.page.entries.push(ConversationEntry::Message(user));
        thread.page.load_state = ConversationLoadState::Ready;
        thread.page.run = ConversationRun {
            state: RunState::Waiting,
            since_ms: started_at,
            pending: Some(QueuedTurn {
                id: turn.id.clone(),
                content: turn.submission.text.clone(),
                steerable: true,
            }),
            error: None,
            ..std::mem::take(&mut thread.page.run)
        };
        thread.active = Some(RuntimeActiveTurn {
            id: turn.id.clone(),
            timestamp: turn.timestamp,
            submission: turn.submission.clone(),
            response: String::new(),
            thought: String::new(),
            started_at,
            generation,
            stop_requested: false,
        });
        RuntimeOutput {
            events: vec![RuntimeEvent::RunStarted {
                thread_id: thread_id.clone(),
                turn_id: turn.id,
            }],
            effects: vec![RuntimeEffect::AcpPrompt {
                thread_id,
                submission: turn.submission,
                generation,
            }],
        }
    }

    fn ensure_foreign_turn(thread: &mut RuntimeThread, sequence: u64, generation: u64) {
        if thread.active.is_none() {
            let turn_id = format!("foreign-{sequence}");
            thread.active = Some(RuntimeActiveTurn {
                id: turn_id,
                timestamp: String::new(),
                submission: ComposerSubmission {
                    text: String::new(),
                    mode: PermissionMode::Ask,
                    model: String::new(),
                    source: None,
                    capability: None,
                    attachments: Vec::new(),
                },
                response: String::new(),
                thought: String::new(),
                started_at: 0,
                generation,
                stop_requested: false,
            });
            thread.page.run = ConversationRun {
                state: RunState::Streaming,
                since_ms: 0,
                ..std::mem::take(&mut thread.page.run)
            };
        }
    }

    fn stop(&mut self, thread_id: &str) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(thread_id, "thread ID")?;
        let thread = self
            .state
            .threads
            .get_mut(&thread_id)
            .ok_or_else(|| RuntimeError::MissingThread(thread_id.clone()))?;
        let Some(active) = thread.active.as_mut() else {
            return Ok(RuntimeOutput::default());
        };
        active.stop_requested = true;
        thread.page.run.stop_confirmation = false;
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::RunStopped {
                thread_id: thread_id.clone(),
                reason: "cancellation requested".to_owned(),
            }],
            effects: vec![RuntimeEffect::AcpCancel {
                thread_id,
                generation: active.generation,
            }],
        })
    }

    fn confirm_stop(&mut self, thread_id: &str) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(thread_id, "thread ID")?;
        let thread = self
            .state
            .threads
            .get_mut(&thread_id)
            .ok_or_else(|| RuntimeError::MissingThread(thread_id.clone()))?;
        if thread.active.is_none() {
            return Ok(RuntimeOutput::default());
        }
        thread.page.run.stop_confirmation = true;
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::StopConfirmationArmed { thread_id }],
            effects: Vec::new(),
        })
    }

    fn answer_permission(
        &mut self,
        request_id: String,
        option_id: Option<String>,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let request_id = id(&request_id, "permission request ID")?;
        let request = self
            .state
            .permissions
            .get(&request_id)
            .ok_or_else(|| RuntimeError::MissingPermission(request_id.clone()))?;
        if let Some(option_id) = option_id.as_deref() {
            let option_id = id(option_id, "permission option ID")?;
            if !request.options.iter().any(|option| option.id == option_id) {
                return Err(invalid(
                    "permission option ID",
                    "is not offered by the request",
                ));
            }
        }
        let request = self
            .state
            .permissions
            .remove(&request_id)
            .expect("permission exists after validation");
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::PermissionResolved {
                request_id: request_id.clone(),
                allowed: option_id.is_some(),
            }],
            effects: vec![RuntimeEffect::AcpAnswerPermission {
                request_id,
                session_id: request.session_id,
                option_id,
            }],
        })
    }

    fn drop_queued(
        &mut self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(thread_id, "thread ID")?;
        let turn_id = id(turn_id, "queued turn ID")?;
        let thread = self
            .state
            .threads
            .get_mut(&thread_id)
            .ok_or_else(|| RuntimeError::MissingThread(thread_id.clone()))?;
        let position = thread
            .queued
            .iter()
            .position(|turn| turn.id == turn_id)
            .ok_or_else(|| RuntimeError::MissingQueuedTurn(turn_id.clone()))?;
        thread.queued.remove(position);
        thread.page.run.queued.retain(|turn| turn.id != turn_id);
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::QueueDropped { thread_id, turn_id }],
            effects: Vec::new(),
        })
    }

    fn steer_queued(
        &mut self,
        thread_id: &str,
        turn_id: &str,
        replacement: String,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(thread_id, "thread ID")?;
        let turn_id = id(turn_id, "queued turn ID")?;
        let replacement = text(&replacement, "queued prompt", MAX_RUNTIME_TEXT_BYTES, true)?;
        let thread = self
            .state
            .threads
            .get_mut(&thread_id)
            .ok_or_else(|| RuntimeError::MissingThread(thread_id.clone()))?;
        let turn = thread
            .queued
            .iter_mut()
            .find(|turn| turn.id == turn_id)
            .ok_or_else(|| RuntimeError::MissingQueuedTurn(turn_id.clone()))?;
        turn.submission.text = replacement.clone();
        if let Some(row) = thread
            .page
            .run
            .queued
            .iter_mut()
            .find(|row| row.id == turn_id)
        {
            row.content = replacement;
        }
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::QueueSteered { thread_id, turn_id }],
            effects: Vec::new(),
        })
    }

    fn release_held(
        &mut self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(thread_id, "thread ID")?;
        let turn_id = id(turn_id, "held turn ID")?;
        let thread = self
            .state
            .threads
            .get_mut(&thread_id)
            .ok_or_else(|| RuntimeError::MissingThread(thread_id.clone()))?;
        let position = thread
            .held
            .iter()
            .position(|turn| turn.id == turn_id)
            .ok_or_else(|| RuntimeError::MissingQueuedTurn(turn_id.clone()))?;
        if thread.active.is_some() && thread.queued.len() >= MAX_RUNTIME_QUEUE {
            return Err(RuntimeError::QueueFull);
        }
        let turn = thread.held.remove(position).expect("held position exists");
        Self::sync_held(thread);
        if thread.active.is_none() {
            let started_at = 0;
            let output = self.activate_turn(thread_id.clone(), turn, started_at);
            return Ok(RuntimeOutput {
                events: [
                    vec![RuntimeEvent::QueueReleased {
                        thread_id: thread_id.clone(),
                        turn_id,
                    }],
                    output.events,
                ]
                .concat(),
                effects: output.effects,
            });
        }
        thread.page.run.queued.push(QueuedTurn {
            id: turn.id.clone(),
            content: turn.submission.text.clone(),
            steerable: true,
        });
        thread.queued.push_back(turn);
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::QueueReleased { thread_id, turn_id }],
            effects: Vec::new(),
        })
    }

    fn drop_held(&mut self, thread_id: &str, turn_id: &str) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(thread_id, "thread ID")?;
        let turn_id = id(turn_id, "held turn ID")?;
        let thread = self
            .state
            .threads
            .get_mut(&thread_id)
            .ok_or_else(|| RuntimeError::MissingThread(thread_id.clone()))?;
        let position = thread
            .held
            .iter()
            .position(|turn| turn.id == turn_id)
            .ok_or_else(|| RuntimeError::MissingQueuedTurn(turn_id.clone()))?;
        thread.held.remove(position);
        Self::sync_held(thread);
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::QueueDropped { thread_id, turn_id }],
            effects: Vec::new(),
        })
    }

    fn completion(
        &mut self,
        thread_id: &str,
        command: CompletionCommand,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(thread_id, "thread ID")?;
        match command {
            CompletionCommand::Open(menu) => self.set_completion(&thread_id, Some(menu)),
            CompletionCommand::Dismiss => self.set_completion(&thread_id, None),
            CompletionCommand::Move(delta) => {
                let thread = self
                    .state
                    .threads
                    .get_mut(&thread_id)
                    .ok_or_else(|| RuntimeError::MissingThread(thread_id.clone()))?;
                let Some(menu) = thread.page.composer.completion.as_mut() else {
                    return Ok(RuntimeOutput::default());
                };
                if menu.items.is_empty() {
                    return Ok(RuntimeOutput::default());
                }
                let len = menu.items.len() as isize;
                menu.active = (menu.active as isize + delta).rem_euclid(len) as usize;
                Ok(RuntimeOutput {
                    events: vec![RuntimeEvent::CompletionUpdated {
                        thread_id,
                        menu: Some(menu.clone()),
                    }],
                    effects: Vec::new(),
                })
            }
            CompletionCommand::Select(item_id) => self.select_completion(&thread_id, item_id),
        }
    }

    fn select_completion(
        &mut self,
        thread_id: &str,
        item_id: String,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let item_id = id(&item_id, "completion ID")?;
        let thread = self
            .state
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| RuntimeError::MissingThread(thread_id.to_owned()))?;
        let Some(menu) = thread.page.composer.completion.take() else {
            return Ok(RuntimeOutput::default());
        };
        let Some(item) = menu.items.iter().find(|item| item.id == item_id) else {
            thread.page.composer.completion = Some(menu);
            return Err(invalid("completion ID", "is not present in the menu"));
        };
        let mut chars = thread.page.composer.text.chars().collect::<Vec<_>>();
        let caret = thread.page.composer.caret.min(chars.len());
        let mut start = caret;
        while start > 0 && !chars[start - 1].is_whitespace() {
            start -= 1;
        }
        let prefix = chars[start..caret]
            .first()
            .copied()
            .filter(|value| *value == '/' || *value == '@');
        let insertion = if prefix.is_some() {
            format!("{}{}", prefix.unwrap_or('@'), item.name)
        } else {
            item.name.clone()
        };
        chars.splice(start..caret, insertion.chars());
        let text = chars.into_iter().collect::<String>();
        let caret = start + insertion.chars().count();
        thread.page.composer.text = text.clone();
        thread.page.composer.caret = caret;
        thread.page.composer.selection_end = caret;
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::CompletionText {
                thread_id: thread_id.to_owned(),
                text,
                caret,
            }],
            effects: Vec::new(),
        })
    }

    fn restart(&mut self) -> Result<RuntimeOutput, RuntimeError> {
        self.state.generation = self.state.generation.saturating_add(1).max(1);
        self.state.status = ServiceStatus::Restarting;
        self.state.last_error = None;
        self.restart_pending = true;
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::Status {
                status: ServiceStatus::Restarting,
                generation: self.state.generation,
            }],
            effects: vec![RuntimeEffect::RestartAcp {
                generation: self.state.generation,
            }],
        })
    }

    fn retry(&mut self, thread_id: &str) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(thread_id, "thread ID")?;
        let thread = self
            .state
            .threads
            .get_mut(&thread_id)
            .ok_or_else(|| RuntimeError::MissingThread(thread_id.clone()))?;
        if thread.active.is_some() && thread.queued.len() >= MAX_RUNTIME_QUEUE {
            return Err(RuntimeError::QueueFull);
        }
        let turn = thread
            .held
            .pop_front()
            .ok_or_else(|| RuntimeError::MissingQueuedTurn("retry".to_owned()))?;
        Self::sync_held(thread);
        if thread.active.is_some() {
            thread.page.run.queued.push(QueuedTurn {
                id: turn.id.clone(),
                content: turn.submission.text.clone(),
                steerable: true,
            });
            thread.queued.push_back(turn);
            Ok(RuntimeOutput {
                events: vec![RuntimeEvent::Queued {
                    thread_id,
                    turn_id: thread
                        .queued
                        .back()
                        .map(|turn| turn.id.clone())
                        .unwrap_or_default(),
                    position: thread.queued.len(),
                }],
                effects: Vec::new(),
            })
        } else {
            Ok(self.activate_turn(thread_id, turn, 0))
        }
    }

    fn ready(&mut self) -> Result<RuntimeOutput, RuntimeError> {
        self.state.status = ServiceStatus::Ready;
        let mut output = RuntimeOutput {
            events: vec![RuntimeEvent::Status {
                status: ServiceStatus::Ready,
                generation: self.state.generation,
            }],
            effects: Vec::new(),
        };
        if self.restart_pending {
            self.restart_pending = false;
            for (thread_id, thread) in &self.state.threads {
                if let Some(active) = &thread.active {
                    output.effects.push(RuntimeEffect::AcpPrompt {
                        thread_id: thread_id.clone(),
                        submission: active.submission.clone(),
                        generation: self.state.generation,
                    });
                }
            }
        }
        Ok(output)
    }

    fn delta(
        &mut self,
        thread_id: String,
        value: String,
        thinking: bool,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(&thread_id, "thread ID")?;
        let value = text(&value, "agent delta", MAX_RUNTIME_TEXT_BYTES, false)?;
        let sequence = self.state.sequence;
        let generation = self.state.generation;
        let thread = self.ensure_thread(&thread_id)?;
        Self::ensure_foreign_turn(thread, sequence, generation);
        let active = thread.active.as_mut().expect("active turn ensured");
        if thinking {
            if active.thought.len().saturating_add(value.len()) > MAX_RUNTIME_TEXT_BYTES {
                return Err(invalid("thinking", "is too large"));
            }
            active.thought.push_str(&value);
            append_thinking(&mut thread.page.run.blocks, &value, sequence);
            thread.page.run.state = RunState::Streaming;
            thread.page.run.working_call = false;
        } else {
            if active.response.len().saturating_add(value.len()) > MAX_RUNTIME_TEXT_BYTES {
                return Err(invalid("agent response", "is too large"));
            }
            active.response.push_str(&value);
            append_markdown(&mut thread.page.run.blocks, &value, sequence);
            thread.page.run.state = RunState::Streaming;
        }
        thread.page.run.activity = if thinking {
            "Thinking".to_owned()
        } else {
            "Writing".to_owned()
        };
        thread.page.run.quiet_ms = 0;
        thread.last_sequence = sequence;
        Ok(RuntimeOutput {
            events: vec![if thinking {
                RuntimeEvent::ThinkingDelta {
                    thread_id,
                    text: value,
                }
            } else {
                RuntimeEvent::AssistantDelta {
                    thread_id,
                    text: value,
                }
            }],
            effects: Vec::new(),
        })
    }

    fn tool_call(
        &mut self,
        thread_id: String,
        call: RuntimeToolCall,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(&thread_id, "thread ID")?;
        validate_tool_call(&call)?;
        let step = ToolStep {
            id: call.id,
            title: call.title,
            kind: call.kind,
            tool_name: call.tool_name,
            status: call.status,
            input: call.input,
            output: call.output,
            path: call.path,
            edit: call.edit,
            artifact_id: call.artifact_id,
            thread_id: Some(thread_id.clone()),
            goal_thread_id: call.goal_thread_id,
        };
        let sequence = self.state.sequence;
        let generation = self.state.generation;
        let thread = self.ensure_thread(&thread_id)?;
        let known = thread.page.run.blocks.iter().any(
            |block| matches!(block, ConversationBlock::Tool(existing) if existing.id == step.id),
        );
        if !known && thread.page.run.blocks.len() >= MAX_RUNTIME_ENTRIES {
            return Err(invalid("conversation blocks", "contains too many entries"));
        }
        Self::ensure_foreign_turn(thread, sequence, generation);
        merge_tool(&mut thread.page.run.blocks, step.clone());
        thread.page.run.state = if step.status == StepStatus::InProgress {
            RunState::Streaming
        } else {
            thread.page.run.state
        };
        thread.page.run.working_call = step.status == StepStatus::InProgress;
        thread.page.run.activity = step.label();
        thread.last_sequence = sequence;
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::ToolUpdated { thread_id, step }],
            effects: Vec::new(),
        })
    }

    fn diff(
        &mut self,
        thread_id: String,
        tool_call_id: String,
        edit: EditDiff,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(&thread_id, "thread ID")?;
        let tool_call_id = id(&tool_call_id, "tool call ID")?;
        validate_edit(&edit)?;
        let sequence = self.state.sequence;
        let thread = self.ensure_thread(&thread_id)?;
        let Some(step) = find_tool_mut(&mut thread.page.run.blocks, &tool_call_id) else {
            return Err(RuntimeError::MissingQueuedTurn(tool_call_id));
        };
        step.edit = Some(edit);
        thread.last_sequence = sequence;
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::DiffUpdated {
                thread_id,
                tool_call_id,
            }],
            effects: Vec::new(),
        })
    }

    fn permission_asked(
        &mut self,
        request: RuntimePermissionRequest,
    ) -> Result<RuntimeOutput, RuntimeError> {
        validate_permission(&request)?;
        let thread_id = request.thread_id.clone();
        if self.state.permissions.len() >= MAX_RUNTIME_PERMISSIONS
            && !self.state.permissions.contains_key(&request.id)
        {
            return Err(invalid("permissions", "contains too many pending requests"));
        }
        let sequence = self.state.sequence;
        self.ensure_thread(&thread_id)?;
        self.state
            .permissions
            .insert(request.id.clone(), request.clone());
        let thread = self
            .state
            .threads
            .get_mut(&thread_id)
            .expect("thread ensured before permission update");
        thread.page.run.state = RunState::Waiting;
        thread.page.run.working_call = true;
        thread.page.run.activity = "Waiting for permission".to_owned();
        thread.last_sequence = sequence;
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::PermissionAsked(request)],
            effects: Vec::new(),
        })
    }

    fn permission_resolved(
        &mut self,
        request_id: String,
        allowed: bool,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let request_id = id(&request_id, "permission request ID")?;
        let sequence = self.state.sequence;
        if let Some(request) = self.state.permissions.remove(&request_id)
            && let Some(thread) = self.state.threads.get_mut(&request.thread_id)
        {
            thread.last_sequence = sequence;
        }
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::PermissionResolved {
                request_id,
                allowed,
            }],
            effects: Vec::new(),
        })
    }

    fn subagent(&mut self, update: RuntimeAgentUpdate) -> Result<RuntimeOutput, RuntimeError> {
        validate_agent(&update)?;
        let thread_id = update
            .parent_id
            .clone()
            .unwrap_or_else(|| update.id.clone());
        let sequence = self.state.sequence;
        let thread = self.ensure_thread(&thread_id)?;
        if !thread.agents.contains_key(&update.id) && thread.agents.len() >= MAX_RUNTIME_AGENTS {
            return Err(invalid("subagents", "contains too many entries"));
        }
        thread.agents.insert(update.id.clone(), update.clone());
        let nested = NestedAgent {
            id: update.id.clone(),
            name: update.title.clone(),
            brief: update.brief.clone(),
            color: update.color.clone(),
            status: update.status,
            model: update.model.clone(),
            activity: update.activity.clone(),
        };
        if let Some(message) = thread
            .page
            .entries
            .iter_mut()
            .rev()
            .find_map(|entry| match entry {
                ConversationEntry::Message(message)
                    if message.role == ConversationRole::Assistant =>
                {
                    Some(message)
                }
                _ => None,
            })
        {
            if let Some(existing) = message
                .spawned
                .iter_mut()
                .find(|agent| agent.id == nested.id)
            {
                *existing = nested;
            } else {
                message.spawned.push(nested);
            }
        }
        thread.last_sequence = sequence;
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::SubagentUpdated(update)],
            effects: Vec::new(),
        })
    }

    fn plan(
        &mut self,
        thread_id: String,
        plan: RuntimePlan,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(&thread_id, "thread ID")?;
        validate_plan(&plan)?;
        let plan_id = plan.id.clone();
        let sequence = self.state.sequence;
        let thread = self.ensure_thread(&thread_id)?;
        if let Some(existing) = thread.plans.iter_mut().find(|item| item.id == plan.id) {
            *existing = plan;
        } else {
            if thread.plans.len() >= MAX_RUNTIME_PLANS {
                return Err(invalid("plans", "contains too many entries"));
            }
            thread.plans.push(plan);
        }
        thread.last_sequence = sequence;
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::PlanUpdated { thread_id, plan_id }],
            effects: Vec::new(),
        })
    }

    fn tasks(
        &mut self,
        thread_id: String,
        tasks: RuntimeTaskList,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(&thread_id, "thread ID")?;
        validate_tasks(&tasks)?;
        let list_id = tasks.id.clone();
        let sequence = self.state.sequence;
        let thread = self.ensure_thread(&thread_id)?;
        if let Some(existing) = thread.tasks.iter_mut().find(|item| item.id == tasks.id) {
            *existing = tasks;
        } else {
            if thread.tasks.len() >= MAX_RUNTIME_TASK_LISTS {
                return Err(invalid("task lists", "contains too many entries"));
            }
            thread.tasks.push(tasks);
        }
        thread.last_sequence = sequence;
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::TasksUpdated { thread_id, list_id }],
            effects: Vec::new(),
        })
    }

    fn timeline(
        &mut self,
        thread_id: String,
        span: RuntimeTimelineSpan,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(&thread_id, "thread ID")?;
        validate_timeline(&span)?;
        let span_id = span.id.clone();
        let sequence = self.state.sequence;
        let thread = self.ensure_thread(&thread_id)?;
        if let Some(existing) = thread.timeline.iter_mut().find(|item| item.id == span.id) {
            *existing = span;
        } else {
            if thread.timeline.len() >= MAX_RUNTIME_TIMELINE {
                return Err(invalid("timeline", "contains too many entries"));
            }
            thread.timeline.push(span);
        }
        thread.timeline.sort_by_key(|item| item.started_at);
        thread.last_sequence = sequence;
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::TimelineUpdated { thread_id, span_id }],
            effects: Vec::new(),
        })
    }

    fn usage(
        &mut self,
        thread_id: String,
        usage: RuntimeUsage,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(&thread_id, "thread ID")?;
        validate_usage(&usage)?;
        let sequence = self.state.sequence;
        let thread = self.ensure_thread(&thread_id)?;
        thread.usage = usage.clone();
        thread.last_sequence = sequence;
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::UsageUpdated { thread_id, usage }],
            effects: Vec::new(),
        })
    }

    fn context(
        &mut self,
        thread_id: String,
        context: RuntimeContext,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(&thread_id, "thread ID")?;
        validate_context(&context)?;
        let sequence = self.state.sequence;
        let thread = self.ensure_thread(&thread_id)?;
        thread.context = context.clone();
        thread.last_sequence = sequence;
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::ContextUpdated { thread_id, context }],
            effects: Vec::new(),
        })
    }

    fn set_completion(
        &mut self,
        thread_id: &str,
        menu: Option<CompletionMenu>,
    ) -> Result<RuntimeOutput, RuntimeError> {
        if let Some(menu) = &menu {
            validate_completion(menu)?;
        }
        let sequence = self.state.sequence;
        let thread = self
            .state
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| RuntimeError::MissingThread(thread_id.to_owned()))?;
        thread.page.composer.completion = menu.clone();
        thread.last_sequence = sequence;
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::CompletionUpdated {
                thread_id: thread_id.to_owned(),
                menu,
            }],
            effects: Vec::new(),
        })
    }

    fn compacted(
        &mut self,
        thread_id: String,
        removed_turns: usize,
        summary_chars: usize,
        model_written: bool,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(&thread_id, "thread ID")?;
        let sequence = self.state.sequence;
        let thread = self.ensure_thread(&thread_id)?;
        thread.last_sequence = sequence;
        let id = format!("compaction-{sequence}");
        thread.page.run.blocks.push(ConversationBlock::Notice {
            id,
            text: format!(
                "Context compacted — {} {} became {}",
                removed_turns,
                if removed_turns == 1 { "turn" } else { "turns" },
                if model_written {
                    "a summary"
                } else {
                    "a rough summary the model did not write"
                }
            ),
            plain: true,
        });
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::Compacted {
                thread_id,
                removed_turns,
                summary_chars,
                model_written,
            }],
            effects: Vec::new(),
        })
    }

    fn routed_model(
        &mut self,
        thread_id: String,
        model: String,
        fell_back: bool,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(&thread_id, "thread ID")?;
        let model = text(&model, "model", MAX_RUNTIME_TITLE_BYTES, true)?;
        let sequence = self.state.sequence;
        let thread = self.ensure_thread(&thread_id)?;
        thread.routed_model = Some(model.clone());
        thread.last_sequence = sequence;
        if fell_back {
            thread.page.run.blocks.push(ConversationBlock::Notice {
                id: format!("route-{sequence}"),
                text: format!("Fell back to {model} — the model above it stopped answering"),
                plain: true,
            });
        }
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::RoutedModel {
                thread_id,
                model,
                fell_back,
            }],
            effects: Vec::new(),
        })
    }

    fn recovery(
        &mut self,
        thread_id: String,
        message: String,
        paused: bool,
        attempt: Option<usize>,
        attempt_limit: Option<usize>,
        _delay_seconds: Option<u64>,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(&thread_id, "thread ID")?;
        let message = text(&message, "recovery message", MAX_RUNTIME_TEXT_BYTES, true)?;
        if let Some(attempt) = attempt
            && let Some(limit) = attempt_limit
            && (attempt == 0 || attempt > limit)
        {
            return Err(invalid("recovery attempt", "is outside the attempt limit"));
        }
        let sequence = self.state.sequence;
        let thread = self.ensure_thread(&thread_id)?;
        thread.last_sequence = sequence;
        thread.page.run.state = if paused {
            RunState::Stalled
        } else {
            RunState::Waiting
        };
        thread.page.run.activity = message.clone();
        Ok(RuntimeOutput {
            events: vec![RuntimeEvent::Recovery {
                thread_id,
                message,
                paused,
                attempt,
                attempt_limit,
                delay_seconds: _delay_seconds,
            }],
            effects: Vec::new(),
        })
    }

    fn completed(
        &mut self,
        thread_id: String,
        stop_reason: String,
        completed_at: u64,
        usage: RuntimeUsage,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let thread_id = id(&thread_id, "thread ID")?;
        let stop_reason = text(&stop_reason, "stop reason", MAX_RUNTIME_TITLE_BYTES, true)?;
        validate_usage(&usage)?;
        let sequence = self.state.sequence;
        let (active, blocks, next) = {
            let thread = self
                .state
                .threads
                .get_mut(&thread_id)
                .ok_or_else(|| RuntimeError::MissingThread(thread_id.clone()))?;
            let active = thread
                .active
                .take()
                .ok_or_else(|| RuntimeError::MissingThread(thread_id.clone()))?;
            let blocks = std::mem::take(&mut thread.page.run.blocks);
            thread.page.run.pending = None;
            thread.page.run.stop_confirmation = false;
            thread.page.run.working_call = false;
            thread.page.run.quiet_ms = 0;
            thread.page.run.activity.clear();
            thread.page.run.error =
                (stop_reason == "refused").then(|| "Emma refused the request".to_owned());
            thread.last_sequence = sequence;
            thread.usage = usage.clone();
            thread.page.run.state = if stop_reason == "cancelled" {
                RunState::Stopped
            } else if stop_reason == "refused" {
                RunState::Failed
            } else {
                RunState::Idle
            };
            let next = thread.queued.pop_front();
            if let Some(next) = &next {
                thread.page.run.queued.retain(|turn| turn.id != next.id);
            }
            (active, blocks, next)
        };
        let answer = if active.response.trim().is_empty() {
            blocks_answer(&blocks)
        } else {
            active.response.clone()
        };
        let response = if answer.trim().is_empty() {
            format!("(the run ended: {stop_reason})")
        } else {
            answer
        };
        let mut events = vec![RuntimeEvent::RunFinished {
            thread_id: thread_id.clone(),
            stop_reason: stop_reason.clone(),
        }];
        events.push(RuntimeEvent::UsageUpdated {
            thread_id: thread_id.clone(),
            usage: usage.clone(),
        });
        let mut effects = Vec::new();
        if stop_reason != "refused" {
            let blocks = if blocks.is_empty() {
                vec![ConversationBlock::Markdown {
                    id: format!("{}-answer", active.id),
                    text: response.clone(),
                }]
            } else {
                blocks
            };
            let message =
                assistant_message(&active, response.clone(), blocks, completed_at, &usage);
            if let Some(thread) = self.state.threads.get_mut(&thread_id) {
                thread
                    .page
                    .entries
                    .push(ConversationEntry::Message(message));
            }
            if active.submission.text.trim().is_empty() {
                events.push(RuntimeEvent::Unavailable {
                    capability: "record-foreign-turn".to_owned(),
                    message: "The run finished without a prompt and cannot be persisted."
                        .to_owned(),
                });
            } else {
                effects.extend(
                    self.host_effect(HostCommand::RecordTurn {
                        thread_id: thread_id.clone(),
                        prompt: active.submission.text.clone(),
                        response,
                        output_tokens: usage.output_tokens,
                        duration_milliseconds: completed_at.saturating_sub(active.started_at),
                        input_tokens: usage.input_tokens,
                        cache_input_tokens: usage.cache_input_tokens,
                        cache_read_tokens: usage.cache_read_tokens,
                        cache_write_tokens: usage.cache_write_tokens,
                        cost_micro_usd: usage.cost_micro_usd,
                        model: (!active.submission.model.is_empty())
                            .then(|| active.submission.model.clone()),
                    })?
                    .effects,
                );
            }
        } else {
            events.push(RuntimeEvent::RunFailed {
                thread_id: Some(thread_id.clone()),
                message: "Emma refused the request".to_owned(),
                recoverable: false,
            });
        }
        if stop_reason == "cancelled" {
            events.push(RuntimeEvent::RunStopped {
                thread_id: thread_id.clone(),
                reason: stop_reason.clone(),
            });
        }
        if let Some(next) = next {
            let output = self.activate_turn(thread_id.clone(), next, completed_at);
            events.extend(output.events);
            effects.extend(output.effects);
        }
        Ok(RuntimeOutput { events, effects })
    }

    fn error(
        &mut self,
        thread_id: Option<String>,
        message: String,
        recoverable: bool,
    ) -> Result<RuntimeOutput, RuntimeError> {
        let message = text(&message, "runtime error", MAX_RUNTIME_TEXT_BYTES, true)?;
        if let Some(thread_id) = thread_id.as_deref() {
            let thread_id = id(thread_id, "thread ID")?;
            let held = self.fail_thread(&thread_id, &message, recoverable)?;
            self.state.last_error = Some(RuntimeIssue {
                message: message.clone(),
                recoverable,
            });
            let mut events = held
                .into_iter()
                .map(|turn_id| RuntimeEvent::QueueHeld {
                    thread_id: thread_id.clone(),
                    turn_id,
                })
                .collect::<Vec<_>>();
            events.push(RuntimeEvent::RunFailed {
                thread_id: Some(thread_id),
                message,
                recoverable,
            });
            Ok(RuntimeOutput {
                events,
                effects: Vec::new(),
            })
        } else {
            self.state.status = if recoverable {
                ServiceStatus::Degraded
            } else {
                ServiceStatus::Offline
            };
            self.state.last_error = Some(RuntimeIssue {
                message: message.clone(),
                recoverable,
            });
            Ok(RuntimeOutput {
                events: vec![RuntimeEvent::RunFailed {
                    thread_id: None,
                    message,
                    recoverable,
                }],
                effects: Vec::new(),
            })
        }
    }

    fn child_exited(&mut self, message: String) -> Result<RuntimeOutput, RuntimeError> {
        let message = text(&message, "process error", MAX_RUNTIME_TEXT_BYTES, true)?;
        self.state.status = ServiceStatus::Offline;
        self.state.last_error = Some(RuntimeIssue {
            message: message.clone(),
            recoverable: true,
        });
        let ids = self
            .state
            .threads
            .iter()
            .filter_map(|(id, thread)| thread.active.as_ref().map(|_| id.clone()))
            .collect::<Vec<_>>();
        let mut events = vec![RuntimeEvent::Status {
            status: ServiceStatus::Offline,
            generation: self.state.generation,
        }];
        for thread_id in ids {
            let held = self.fail_thread(&thread_id, &message, true)?;
            events.extend(held.into_iter().map(|turn_id| RuntimeEvent::QueueHeld {
                thread_id: thread_id.clone(),
                turn_id,
            }));
            events.push(RuntimeEvent::RunFailed {
                thread_id: Some(thread_id),
                message: message.clone(),
                recoverable: true,
            });
        }
        Ok(RuntimeOutput {
            events,
            effects: Vec::new(),
        })
    }

    fn sync_held(thread: &mut RuntimeThread) {
        thread.page.run.held = thread
            .held
            .iter()
            .map(|turn| QueuedTurn {
                id: turn.id.clone(),
                content: turn.submission.text.clone(),
                steerable: true,
            })
            .collect();
    }

    fn fail_thread(
        &mut self,
        thread_id: &str,
        message: &str,
        recoverable: bool,
    ) -> Result<Vec<String>, RuntimeError> {
        let thread = self
            .state
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| RuntimeError::MissingThread(thread_id.to_owned()))?;
        let turns_to_hold = usize::from(thread.active.is_some()) + thread.queued.len();
        if thread.held.len().saturating_add(turns_to_hold) > MAX_RUNTIME_HOLD {
            return Err(RuntimeError::QueueFull);
        }
        let mut held_ids = Vec::with_capacity(turns_to_hold);
        if let Some(active) = thread.active.take() {
            held_ids.push(active.id.clone());
            thread.held.push_front(RuntimeQueuedTurn {
                id: active.id,
                timestamp: active.timestamp,
                submission: active.submission,
            });
        }
        while let Some(turn) = thread.queued.pop_front() {
            held_ids.push(turn.id.clone());
            thread.held.push_back(turn);
        }
        thread.page.run.pending = None;
        thread.page.run.queued.clear();
        Self::sync_held(thread);
        thread.page.run.state = if recoverable {
            RunState::Failed
        } else {
            RunState::Stopped
        };
        thread.page.run.error = Some(message.to_owned());
        thread.page.run.activity.clear();
        thread.page.run.working_call = false;
        Ok(held_ids)
    }

    fn hydrate_snapshot(
        &mut self,
        snapshot: HostSnapshot,
    ) -> Result<Vec<RuntimeEvent>, RuntimeError> {
        let sequence = self.state.sequence;
        let ids = snapshot
            .threads
            .iter()
            .map(|thread| thread.id.clone())
            .collect::<Vec<_>>();
        for summary in &snapshot.threads {
            let thread = self
                .state
                .threads
                .entry(summary.id.clone())
                .or_insert_with(|| RuntimeThread::new(summary.id.clone(), summary.title.clone()));
            thread.title = summary.title.clone();
            thread.page.thread_id = summary.id.clone();
            thread.page.thread_title = summary
                .display_title
                .clone()
                .unwrap_or_else(|| summary.title.clone());
            thread.last_sequence = sequence;
            if thread.active.is_none()
                && let Some(messages) = &summary.messages
            {
                if messages.len() > MAX_RUNTIME_ENTRIES {
                    return Err(invalid("messages", "contains too many entries"));
                }
                thread.page.entries = entries_from_messages(messages);
                thread.page.load_state = if messages.is_empty() {
                    ConversationLoadState::Empty
                } else {
                    ConversationLoadState::Ready
                };
            } else if thread.page.load_state == ConversationLoadState::Loading {
                thread.page.load_state = if summary.message_count == 0 {
                    ConversationLoadState::Empty
                } else {
                    ConversationLoadState::Ready
                };
            }
        }
        self.state.selected_thread = self
            .state
            .selected_thread
            .clone()
            .filter(|id| self.state.threads.contains_key(id))
            .or_else(|| ids.first().cloned());
        self.state.snapshot = Some(snapshot.clone());
        self.state.status = ServiceStatus::Ready;
        Ok(vec![RuntimeEvent::SnapshotHydrated {
            thread_ids: ids,
            warnings: snapshot.warnings,
        }])
    }

    fn hydrate_thread(&mut self, summary: HostThreadSummary) -> Result<RuntimeEvent, RuntimeError> {
        let id = summary.id.clone();
        let sequence = self.state.sequence;
        let thread = self
            .state
            .threads
            .entry(id.clone())
            .or_insert_with(|| RuntimeThread::new(id.clone(), summary.title.clone()));
        thread.title = summary.title.clone();
        thread.page.thread_id = id.clone();
        thread.page.thread_title = summary
            .display_title
            .clone()
            .unwrap_or_else(|| summary.title.clone());
        thread.last_sequence = sequence;
        let messages = summary
            .messages
            .as_deref()
            .ok_or_else(|| invalid("messages", "full thread response must include an array"))?;
        if thread.active.is_none() {
            if messages.len() > MAX_RUNTIME_ENTRIES {
                return Err(invalid("messages", "contains too many entries"));
            }
            thread.page.entries = entries_from_messages(messages);
            thread.page.load_state = if messages.is_empty() {
                ConversationLoadState::Empty
            } else {
                ConversationLoadState::Ready
            };
        }
        self.state.selected_thread = Some(id.clone());
        Ok(RuntimeEvent::ThreadHydrated { thread_id: id })
    }
}

fn validate_host_command(command: &HostCommand) -> Result<(), RuntimeError> {
    match command {
        HostCommand::Snapshot | HostCommand::ThreadSummaries => Ok(()),
        HostCommand::Thread { thread_id }
        | HostCommand::ClearGoal { thread_id }
        | HostCommand::ReadTrace { thread_id } => id(thread_id, "thread ID").map(|_| ()),
        HostCommand::CreateThread {
            title,
            parent_thread_id,
            kind,
        } => {
            optional_text(title.as_deref(), "thread title", MAX_RUNTIME_TITLE_BYTES)?;
            optional_text(
                parent_thread_id.as_deref(),
                "parent thread ID",
                MAX_RUNTIME_ID_BYTES,
            )?;
            optional_text(kind.as_deref(), "thread kind", MAX_RUNTIME_TITLE_BYTES).map(|_| ())
        }
        HostCommand::SetThreadArchived { thread_id, .. } => id(thread_id, "thread ID").map(|_| ()),
        HostCommand::RenameThread { thread_id, title } => {
            id(thread_id, "thread ID")?;
            text(title, "thread title", MAX_RUNTIME_TITLE_BYTES, true).map(|_| ())
        }
        HostCommand::RecordTurn {
            thread_id,
            prompt,
            response,
            model,
            ..
        } => {
            id(thread_id, "thread ID")?;
            text(prompt, "prompt", MAX_RUNTIME_TEXT_BYTES, true)?;
            text(response, "response", MAX_RUNTIME_TEXT_BYTES, true)?;
            optional_text(model.as_deref(), "model", MAX_RUNTIME_TITLE_BYTES).map(|_| ())
        }
        HostCommand::SetGoal {
            thread_id,
            objective,
            ..
        } => {
            id(thread_id, "thread ID")?;
            text(objective, "goal objective", MAX_RUNTIME_TEXT_BYTES, true).map(|_| ())
        }
        HostCommand::UpdateGoal {
            thread_id,
            status,
            evidence,
            reason,
            ..
        } => {
            id(thread_id, "thread ID")?;
            optional_text(status.as_deref(), "goal status", MAX_RUNTIME_TITLE_BYTES)?;
            optional_text(evidence.as_deref(), "goal evidence", MAX_RUNTIME_TEXT_BYTES)?;
            optional_text(reason.as_deref(), "goal reason", MAX_RUNTIME_TEXT_BYTES).map(|_| ())
        }
        HostCommand::RecordTrace { thread_id, trace } => {
            id(thread_id, "thread ID")?;
            text(trace, "trace", MAX_RUNTIME_TEXT_BYTES, true).map(|_| ())
        }
        HostCommand::SaveScheduledJob {
            job_id,
            title,
            schedule,
            prompt,
            nodes,
            source_domains,
            permission_mode,
            model,
        } => {
            optional_text(job_id.as_deref(), "scheduled job ID", MAX_RUNTIME_ID_BYTES)?;
            text(title, "scheduled title", MAX_RUNTIME_TITLE_BYTES, true)?;
            text(schedule, "schedule", MAX_RUNTIME_TEXT_BYTES, true)?;
            text(prompt, "scheduled prompt", MAX_RUNTIME_TEXT_BYTES, true)?;
            text(nodes, "scheduled nodes", MAX_RUNTIME_TEXT_BYTES, false)?;
            for domain in source_domains {
                text(domain, "source domain", MAX_RUNTIME_TITLE_BYTES, true)?;
            }
            text(
                permission_mode,
                "permission mode",
                MAX_RUNTIME_TITLE_BYTES,
                true,
            )?;
            text(model, "model", MAX_RUNTIME_TITLE_BYTES, false).map(|_| ())
        }
        HostCommand::DeleteScheduledJob { job_id }
        | HostCommand::RunScheduledJob { job_id, .. }
        | HostCommand::SetScheduledJobEnabled { job_id, .. } => {
            id(job_id, "scheduled job ID").map(|_| ())
        }
        HostCommand::FinishScheduledJob {
            job_id, outputs, ..
        } => {
            id(job_id, "scheduled job ID")?;
            text(outputs, "scheduled outputs", MAX_RUNTIME_TEXT_BYTES, true).map(|_| ())
        }
        HostCommand::FireScheduledEvent { event, variables } => {
            text(event, "scheduled event", MAX_RUNTIME_TITLE_BYTES, true)?;
            text(
                variables,
                "scheduled variables",
                MAX_RUNTIME_TEXT_BYTES,
                false,
            )
            .map(|_| ())
        }
        HostCommand::SaveResearchJob {
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
            ..
        } => {
            optional_text(job_id.as_deref(), "research job ID", MAX_RUNTIME_ID_BYTES)?;
            text(title, "research title", MAX_RUNTIME_TITLE_BYTES, true)?;
            text(
                project_dir,
                "project directory",
                MAX_RUNTIME_TEXT_BYTES,
                true,
            )?;
            text(metric_name, "metric name", MAX_RUNTIME_TITLE_BYTES, true)?;
            text(metric_kind, "metric kind", MAX_RUNTIME_TITLE_BYTES, true)?;
            text(
                metric_prompt,
                "metric prompt",
                MAX_RUNTIME_TEXT_BYTES,
                false,
            )?;
            text(direction, "metric direction", MAX_RUNTIME_TITLE_BYTES, true)?;
            text(
                eval_command,
                "evaluation command",
                MAX_RUNTIME_TEXT_BYTES,
                true,
            )?;
            text(prompt, "research prompt", MAX_RUNTIME_TEXT_BYTES, false)?;
            text(
                proposer_model,
                "proposer model",
                MAX_RUNTIME_TITLE_BYTES,
                true,
            )?;
            text(
                permission_mode,
                "permission mode",
                MAX_RUNTIME_TITLE_BYTES,
                true,
            )
            .map(|_| ())
        }
        HostCommand::DeleteResearchJob { job_id }
        | HostCommand::SetResearchJobStatus { job_id, .. }
        | HostCommand::SetResearchJobThread { job_id, .. }
        | HostCommand::RecordResearchIteration { job_id, .. } => {
            id(job_id, "research job ID").map(|_| ())
        }
    }
}

fn validate_submission(submission: &ComposerSubmission) -> Result<(), RuntimeError> {
    text(&submission.text, "prompt", MAX_RUNTIME_TEXT_BYTES, true)?;
    text(&submission.model, "model", MAX_RUNTIME_TITLE_BYTES, false)?;
    optional_text(
        submission.source.as_deref(),
        "source",
        MAX_RUNTIME_TITLE_BYTES,
    )?;
    optional_text(
        submission.capability.as_deref(),
        "capability",
        MAX_RUNTIME_TITLE_BYTES,
    )?;
    if submission.attachments.len() > MAX_RUNTIME_QUEUE {
        return Err(invalid("attachments", "contains too many entries"));
    }
    for attachment in &submission.attachments {
        id(attachment, "attachment ID")?;
    }
    Ok(())
}

fn validate_tool_call(call: &RuntimeToolCall) -> Result<(), RuntimeError> {
    id(&call.id, "tool call ID")?;
    text(&call.title, "tool title", MAX_RUNTIME_TITLE_BYTES, false)?;
    text(&call.kind, "tool kind", MAX_RUNTIME_TITLE_BYTES, true)?;
    optional_text(
        call.tool_name.as_deref(),
        "tool name",
        MAX_RUNTIME_TITLE_BYTES,
    )?;
    text(&call.input, "tool input", MAX_RUNTIME_TEXT_BYTES, false)?;
    text(&call.output, "tool output", MAX_RUNTIME_TEXT_BYTES, false)?;
    optional_text(call.path.as_deref(), "tool path", MAX_RUNTIME_TEXT_BYTES)?;
    optional_text(
        call.artifact_id.as_deref(),
        "artifact ID",
        MAX_RUNTIME_ID_BYTES,
    )?;
    optional_text(
        call.goal_thread_id.as_deref(),
        "goal thread ID",
        MAX_RUNTIME_ID_BYTES,
    )?;
    if let Some(edit) = &call.edit {
        validate_edit(edit)?;
    }
    Ok(())
}

fn validate_edit(edit: &EditDiff) -> Result<(), RuntimeError> {
    text(&edit.path, "edit path", MAX_RUNTIME_TEXT_BYTES, true)?;
    if edit.hunks.len() > MAX_RUNTIME_ENTRIES {
        return Err(invalid("diff hunks", "contains too many entries"));
    }
    for line in &edit.hunks {
        text(&line.text, "diff line", MAX_RUNTIME_TEXT_BYTES, false)?;
    }
    Ok(())
}

fn validate_permission(request: &RuntimePermissionRequest) -> Result<(), RuntimeError> {
    id(&request.id, "permission request ID")?;
    id(&request.thread_id, "thread ID")?;
    optional_text(
        request.session_id.as_deref(),
        "session ID",
        MAX_RUNTIME_ID_BYTES,
    )?;
    text(
        &request.title,
        "permission title",
        MAX_RUNTIME_TITLE_BYTES,
        true,
    )?;
    text(
        &request.tool,
        "permission tool",
        MAX_RUNTIME_TITLE_BYTES,
        true,
    )?;
    text(
        &request.detail,
        "permission detail",
        MAX_RUNTIME_TEXT_BYTES,
        false,
    )?;
    if request.options.len() > MAX_RUNTIME_COMPLETIONS {
        return Err(invalid("permission options", "contains too many entries"));
    }
    for option in &request.options {
        id(&option.id, "permission option ID")?;
        text(
            &option.name,
            "permission option",
            MAX_RUNTIME_TITLE_BYTES,
            true,
        )?;
        text(
            &option.kind,
            "permission kind",
            MAX_RUNTIME_TITLE_BYTES,
            true,
        )?;
    }
    Ok(())
}

fn validate_agent(update: &RuntimeAgentUpdate) -> Result<(), RuntimeError> {
    id(&update.id, "subagent ID")?;
    optional_text(
        update.parent_id.as_deref(),
        "parent thread ID",
        MAX_RUNTIME_ID_BYTES,
    )?;
    text(
        &update.title,
        "subagent title",
        MAX_RUNTIME_TITLE_BYTES,
        true,
    )?;
    text(
        &update.brief,
        "subagent brief",
        MAX_RUNTIME_TEXT_BYTES,
        false,
    )?;
    optional_text(
        update.color.as_deref(),
        "subagent color",
        MAX_RUNTIME_TITLE_BYTES,
    )?;
    optional_text(
        update.model.as_deref(),
        "subagent model",
        MAX_RUNTIME_TITLE_BYTES,
    )?;
    optional_text(
        update.effort.as_deref(),
        "subagent effort",
        MAX_RUNTIME_TITLE_BYTES,
    )?;
    optional_text(
        update.activity.as_deref(),
        "subagent activity",
        MAX_RUNTIME_TEXT_BYTES,
    )?;
    optional_text(
        update.prompt.as_deref(),
        "subagent prompt",
        MAX_RUNTIME_TEXT_BYTES,
    )?;
    optional_text(
        update.error.as_deref(),
        "subagent error",
        MAX_RUNTIME_TEXT_BYTES,
    )
    .map(|_| ())
}

fn validate_plan(plan: &RuntimePlan) -> Result<(), RuntimeError> {
    id(&plan.id, "plan ID")?;
    text(&plan.title, "plan title", MAX_RUNTIME_TITLE_BYTES, true)?;
    text(&plan.goal, "plan goal", MAX_RUNTIME_TEXT_BYTES, false)?;
    text(
        &plan.updated_at,
        "plan update time",
        MAX_RUNTIME_TITLE_BYTES,
        false,
    )?;
    if plan.steps.len() > MAX_RUNTIME_ENTRIES {
        return Err(invalid("plan steps", "contains too many entries"));
    }
    for step in &plan.steps {
        id(&step.id, "plan step ID")?;
        text(
            &step.title,
            "plan step title",
            MAX_RUNTIME_TITLE_BYTES,
            true,
        )?;
        text(
            &step.status,
            "plan step status",
            MAX_RUNTIME_TITLE_BYTES,
            true,
        )?;
        text(
            &step.brief,
            "plan step brief",
            MAX_RUNTIME_TEXT_BYTES,
            false,
        )?;
        optional_text(
            step.result.as_deref(),
            "plan step result",
            MAX_RUNTIME_TEXT_BYTES,
        )?;
        for need in &step.needs {
            id(need, "plan dependency ID")?;
        }
    }
    Ok(())
}

fn validate_tasks(tasks: &RuntimeTaskList) -> Result<(), RuntimeError> {
    id(&tasks.id, "task list ID")?;
    text(
        &tasks.title,
        "task list title",
        MAX_RUNTIME_TITLE_BYTES,
        true,
    )?;
    text(&tasks.goal, "task list goal", MAX_RUNTIME_TEXT_BYTES, false)?;
    text(
        &tasks.updated_at,
        "task list update time",
        MAX_RUNTIME_TITLE_BYTES,
        false,
    )?;
    if tasks.tasks.len() > MAX_RUNTIME_ENTRIES {
        return Err(invalid("tasks", "contains too many entries"));
    }
    for task in &tasks.tasks {
        id(&task.id, "task ID")?;
        text(&task.title, "task title", MAX_RUNTIME_TITLE_BYTES, true)?;
        text(&task.status, "task status", MAX_RUNTIME_TITLE_BYTES, true)?;
        optional_text(
            task.parent_id.as_deref(),
            "parent task ID",
            MAX_RUNTIME_ID_BYTES,
        )?;
    }
    Ok(())
}

fn validate_timeline(span: &RuntimeTimelineSpan) -> Result<(), RuntimeError> {
    id(&span.id, "timeline span ID")?;
    optional_text(
        span.parent_id.as_deref(),
        "timeline parent ID",
        MAX_RUNTIME_ID_BYTES,
    )?;
    text(&span.name, "timeline name", MAX_RUNTIME_TITLE_BYTES, true)?;
    text(&span.kind, "timeline kind", MAX_RUNTIME_TITLE_BYTES, true)?;
    text(
        &span.status,
        "timeline status",
        MAX_RUNTIME_TITLE_BYTES,
        true,
    )?;
    optional_text(
        span.input.as_deref(),
        "timeline input",
        MAX_RUNTIME_TEXT_BYTES,
    )?;
    optional_text(
        span.output.as_deref(),
        "timeline output",
        MAX_RUNTIME_TEXT_BYTES,
    )
    .map(|_| ())
}

fn validate_usage(usage: &RuntimeUsage) -> Result<(), RuntimeError> {
    if let (Some(read), Some(input)) = (usage.cache_read_tokens, usage.cache_input_tokens)
        && read > input
    {
        return Err(invalid("cache usage", "read tokens exceed input tokens"));
    }
    if let Some(write) = usage.cache_write_tokens
        && write > usage.cache_input_tokens.unwrap_or(usage.input_tokens)
    {
        return Err(invalid("cache usage", "write tokens exceed input tokens"));
    }
    Ok(())
}

fn validate_context(context: &RuntimeContext) -> Result<(), RuntimeError> {
    let parts = [
        context.system_prompt_bytes,
        context.system_tools_bytes,
        context.mcp_tools_bytes,
        context.skills_bytes,
        context.memory_bytes,
    ];
    if parts.iter().any(|value| *value > 64 * 1024 * 1024) {
        return Err(invalid("context", "contains an oversized section"));
    }
    Ok(())
}

fn validate_completion(menu: &CompletionMenu) -> Result<(), RuntimeError> {
    if menu.items.len() > MAX_RUNTIME_COMPLETIONS {
        return Err(invalid("completion items", "contains too many entries"));
    }
    if !menu.items.is_empty() && menu.active >= menu.items.len() {
        return Err(invalid(
            "completion active index",
            "is outside the item list",
        ));
    }
    text(
        &menu.query,
        "completion query",
        MAX_RUNTIME_TITLE_BYTES,
        false,
    )?;
    for item in &menu.items {
        id(&item.id, "completion ID")?;
        text(&item.name, "completion name", MAX_RUNTIME_TITLE_BYTES, true)?;
        text(
            &item.detail,
            "completion detail",
            MAX_RUNTIME_TEXT_BYTES,
            false,
        )?;
    }
    Ok(())
}

fn append_markdown(blocks: &mut Vec<ConversationBlock>, delta: &str, sequence: u64) {
    if delta.is_empty() {
        return;
    }
    if let Some(ConversationBlock::Markdown { text, .. }) = blocks.last_mut() {
        text.push_str(delta);
    } else {
        blocks.push(ConversationBlock::Markdown {
            id: format!("answer-{sequence}"),
            text: delta.to_owned(),
        });
    }
}

fn append_thinking(blocks: &mut Vec<ConversationBlock>, delta: &str, sequence: u64) {
    if delta.is_empty() {
        return;
    }
    if let Some(ConversationBlock::Thinking(thinking)) = blocks.last_mut() {
        thinking.text.push_str(delta);
        thinking.tokens = thought_tokens(&thinking.text);
    } else {
        blocks.push(ConversationBlock::Thinking(ThinkingBlock {
            id: format!("thinking-{sequence}"),
            text: delta.to_owned(),
            duration_ms: 0,
            tokens: thought_tokens(delta),
            live: Some("Thinking".to_owned()),
        }));
    }
}

fn merge_tool(blocks: &mut Vec<ConversationBlock>, step: ToolStep) {
    if let Some(existing) = find_tool_mut(blocks, &step.id) {
        *existing = step;
        return;
    }
    blocks.push(ConversationBlock::Tool(step));
}

fn find_tool_mut<'a>(blocks: &'a mut [ConversationBlock], id: &str) -> Option<&'a mut ToolStep> {
    blocks.iter_mut().find_map(|block| match block {
        ConversationBlock::Tool(step) if step.id == id => Some(step),
        _ => None,
    })
}

fn blocks_answer(blocks: &[ConversationBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            ConversationBlock::Markdown { text, .. } | ConversationBlock::Notice { text, .. } => {
                Some(text.as_str())
            }
            ConversationBlock::Visual(visual) => Some(visual.content.as_str()),
            ConversationBlock::Thinking(_) | ConversationBlock::Tool(_) => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

fn assistant_message(
    active: &RuntimeActiveTurn,
    response: String,
    blocks: Vec<ConversationBlock>,
    completed_at: u64,
    usage: &RuntimeUsage,
) -> ConversationMessage {
    let mut message = ConversationMessage::new(
        format!("{}-assistant", active.id),
        ConversationRole::Assistant,
        response,
        if active.timestamp.is_empty() {
            completed_at.to_string()
        } else {
            active.timestamp.clone()
        },
    );
    message.blocks = blocks;
    message.generation = Some(GenerationMeta {
        model: active.submission.model.clone(),
        output_tokens: usize::try_from(usage.output_tokens).unwrap_or(usize::MAX),
        duration_ms: completed_at.saturating_sub(active.started_at),
        input_tokens: usize::try_from(usage.input_tokens).unwrap_or(usize::MAX),
    });
    message
}

fn entries_from_messages(messages: &[HostMessage]) -> Vec<ConversationEntry> {
    messages
        .iter()
        .enumerate()
        .map(|(index, message)| {
            let mut converted = ConversationMessage::new(
                format!("message-{index}"),
                message.role,
                message.content.clone(),
                message.timestamp.clone(),
            );
            if let Some(generation) = &message.generation {
                converted.generation = Some(GenerationMeta {
                    model: generation.model.clone(),
                    output_tokens: usize::try_from(generation.output_tokens).unwrap_or(usize::MAX),
                    duration_ms: generation.duration_milliseconds,
                    input_tokens: usize::try_from(generation.input_tokens).unwrap_or(usize::MAX),
                });
            }
            if message.role == ConversationRole::Assistant {
                let (answer, thought) = split_thinking(&message.content);
                converted.content = answer;
                if !thought.trim().is_empty() {
                    converted
                        .blocks
                        .push(ConversationBlock::Thinking(ThinkingBlock {
                            id: format!("message-{index}-thinking"),
                            text: thought.clone(),
                            duration_ms: 0,
                            tokens: thought_tokens(&thought),
                            live: None,
                        }));
                }
                if !converted.content.is_empty() {
                    converted.blocks.push(ConversationBlock::Markdown {
                        id: format!("message-{index}-markdown"),
                        text: converted.content.clone(),
                    });
                }
            } else {
                converted.blocks.push(ConversationBlock::Markdown {
                    id: format!("message-{index}-markdown"),
                    text: converted.content.clone(),
                });
            }
            ConversationEntry::Message(converted)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation::CompletionItem;
    use serde_json::json;

    fn thread(id: &str) -> Value {
        json!({
            "id": id,
            "title": "Thread",
            "messages": [],
        })
    }

    fn submission(text: &str) -> ComposerSubmission {
        ComposerSubmission {
            text: text.to_owned(),
            mode: PermissionMode::Ask,
            model: "model".to_owned(),
            source: Some("source".to_owned()),
            capability: Some("capability".to_owned()),
            attachments: vec!["file-1".to_owned()],
        }
    }

    #[test]
    fn host_snapshot_hydration_preserves_full_messages_and_warnings() {
        let value = json!({
            "threads": [{
                "id": "thread-1",
                "title": "Thread",
                "messages": [{"role":"user","content":"hello","timestamp":"2026-01-01T00:00:00Z"}]
            }],
            "scheduledJobs": [],
            "researchJobs": [],
            "warnings": ["stale catalog"]
        });
        let snapshot = parse_host_snapshot(&value).expect("snapshot parses");
        assert_eq!(snapshot.threads[0].message_count, 1);
        assert_eq!(snapshot.warnings, vec!["stale catalog"]);
        let mut service = RuntimeService::new();
        let output = service
            .hydrate_snapshot(snapshot)
            .expect("snapshot hydrates");
        assert_eq!(
            output[0],
            RuntimeEvent::SnapshotHydrated {
                thread_ids: vec!["thread-1".to_owned()],
                warnings: vec!["stale catalog".to_owned()],
            }
        );
        assert_eq!(
            service.selected_page().map(|page| page.entries.len()),
            Some(1)
        );
    }

    #[test]
    fn deltas_merge_in_order_and_completion_routes_a_record_turn() {
        let mut service = RuntimeService::new();
        service
            .hydrate_thread(parse_host_thread(&thread("thread-1")).expect("thread parses"))
            .expect("thread hydrates");
        let output = service
            .dispatch(RuntimeCommand::Submit {
                thread_id: "thread-1".to_owned(),
                timestamp: "2026-01-01T00:00:00Z".to_owned(),
                started_at: 100,
                submission: submission("hello"),
            })
            .expect("submit succeeds");
        assert!(matches!(output.effects[0], RuntimeEffect::AcpPrompt { .. }));
        service
            .accept_acp(RuntimeAcpEvent::AssistantDelta {
                thread_id: "thread-1".to_owned(),
                text: "hel".to_owned(),
            })
            .expect("delta succeeds");
        service
            .accept_acp(RuntimeAcpEvent::AssistantDelta {
                thread_id: "thread-1".to_owned(),
                text: "lo".to_owned(),
            })
            .expect("delta succeeds");
        let completed = service
            .accept_acp(RuntimeAcpEvent::Completed {
                thread_id: "thread-1".to_owned(),
                stop_reason: "end_turn".to_owned(),
                completed_at: 250,
                usage: RuntimeUsage {
                    input_tokens: 3,
                    output_tokens: 2,
                    ..RuntimeUsage::default()
                },
            })
            .expect("completion succeeds");
        assert!(completed.effects.iter().any(|effect| matches!(
            effect,
            RuntimeEffect::HostRequest { method, .. } if method == "recordTurn"
        )));
        let page = service.thread("thread-1").expect("thread exists");
        assert_eq!(page.page.entries.len(), 2);
        assert_eq!(page.page.run.state, RunState::Idle);
    }

    #[test]
    fn queued_submission_keeps_mode_model_source_capability_and_attachments() {
        let mut service = RuntimeService::new();
        service
            .hydrate_thread(parse_host_thread(&thread("thread-1")).expect("thread parses"))
            .expect("thread hydrates");
        service
            .dispatch(RuntimeCommand::Submit {
                thread_id: "thread-1".to_owned(),
                timestamp: "2026-01-01T00:00:00Z".to_owned(),
                started_at: 100,
                submission: submission("first"),
            })
            .expect("submit succeeds");
        service
            .dispatch(RuntimeCommand::Queue {
                thread_id: "thread-1".to_owned(),
                timestamp: "2026-01-01T00:00:01Z".to_owned(),
                submission: submission("second"),
            })
            .expect("queue succeeds");
        let queued = &service.thread("thread-1").expect("thread exists").queued[0].submission;
        assert_eq!(queued, &submission("second"));
    }

    #[test]
    fn permission_answers_are_fail_closed_and_validate_option_ids() {
        let mut service = RuntimeService::new();
        service
            .accept_acp(RuntimeAcpEvent::PermissionAsked(RuntimePermissionRequest {
                id: "permission-1".to_owned(),
                thread_id: "thread-1".to_owned(),
                session_id: Some("session-1".to_owned()),
                mode: PermissionMode::Ask,
                title: "Write file".to_owned(),
                tool: "write_file".to_owned(),
                detail: "file.txt".to_owned(),
                options: vec![RuntimePermissionOption {
                    id: "allow".to_owned(),
                    name: "Allow".to_owned(),
                    kind: "allow_once".to_owned(),
                }],
            }))
            .expect("permission asks");
        assert!(
            service
                .dispatch(RuntimeCommand::AnswerPermission {
                    request_id: "permission-1".to_owned(),
                    option_id: Some("unknown".to_owned()),
                })
                .is_err()
        );
        let denied = service
            .dispatch(RuntimeCommand::AnswerPermission {
                request_id: "permission-1".to_owned(),
                option_id: None,
            })
            .expect("deny succeeds");
        assert!(matches!(
            denied.effects[0],
            RuntimeEffect::AcpAnswerPermission {
                option_id: None,
                ..
            }
        ));
    }

    #[test]
    fn completion_selection_replaces_only_the_active_token() {
        let mut service = RuntimeService::new();
        service
            .hydrate_thread(parse_host_thread(&thread("thread-1")).expect("thread parses"))
            .expect("thread hydrates");
        let thread = service
            .state
            .threads
            .get_mut("thread-1")
            .expect("thread exists");
        thread.page.composer.text = "look /pla".to_owned();
        thread.page.composer.caret = "look /pla".chars().count();
        thread.page.composer.selection_end = thread.page.composer.caret;
        let output = service
            .dispatch(RuntimeCommand::Completion {
                thread_id: "thread-1".to_owned(),
                command: CompletionCommand::Open(CompletionMenu {
                    sigil: crate::conversation::CompletionSigil::Slash,
                    query: "pla".to_owned(),
                    items: vec![CompletionItem {
                        id: "plan".to_owned(),
                        name: "plan".to_owned(),
                        kind: crate::conversation::CompletionKind::Builtin,
                        detail: "Write a plan".to_owned(),
                    }],
                    active: 0,
                }),
            })
            .expect("completion opens");
        assert!(matches!(
            output.events[0],
            RuntimeEvent::CompletionUpdated { .. }
        ));
        let output = service
            .dispatch(RuntimeCommand::Completion {
                thread_id: "thread-1".to_owned(),
                command: CompletionCommand::Select("plan".to_owned()),
            })
            .expect("completion selects");
        assert_eq!(
            output.events[0],
            RuntimeEvent::CompletionText {
                thread_id: "thread-1".to_owned(),
                text: "look /plan".to_owned(),
                caret: 10,
            }
        );
    }

    #[test]
    fn restart_replays_active_submission_after_ready() {
        let mut service = RuntimeService::new();
        service
            .hydrate_thread(parse_host_thread(&thread("thread-1")).expect("thread parses"))
            .expect("thread hydrates");
        service
            .dispatch(RuntimeCommand::Submit {
                thread_id: "thread-1".to_owned(),
                timestamp: "2026-01-01T00:00:00Z".to_owned(),
                started_at: 1,
                submission: submission("retry me"),
            })
            .expect("submit succeeds");
        service
            .dispatch(RuntimeCommand::Restart)
            .expect("restart succeeds");
        let output = service
            .accept_acp(RuntimeAcpEvent::Ready)
            .expect("ready succeeds");
        assert!(output.effects.iter().any(|effect| matches!(
            effect,
            RuntimeEffect::AcpPrompt { thread_id, .. } if thread_id == "thread-1"
        )));
    }

    #[test]
    fn research_creation_omits_job_id_instead_of_sending_an_empty_id() {
        let command = HostCommand::SaveResearchJob {
            job_id: None,
            title: "Research".to_owned(),
            project_dir: "/tmp/project".to_owned(),
            metric_name: "score".to_owned(),
            metric_kind: "grep".to_owned(),
            metric_prompt: String::new(),
            direction: "higher".to_owned(),
            eval_command: "rg score".to_owned(),
            prompt: String::new(),
            proposer_model: "model".to_owned(),
            permission_mode: "ask".to_owned(),
            max_seconds: 1,
            max_tokens: 2,
            max_micro_dollars: 3,
        };
        let params = command.params().expect("params encode");
        assert!(params.get("jobId").is_none());
    }

    #[test]
    fn explicit_sequences_advance_generated_event_sequences() {
        let mut service = RuntimeService::new();
        service
            .accept_acp_at(100, RuntimeAcpEvent::Ready)
            .expect("explicit sequence succeeds");
        service
            .accept_acp(RuntimeAcpEvent::Ready)
            .expect("generated sequence succeeds");
        assert_eq!(service.state.sequence, 101);
        assert!(service.accept_acp_at(101, RuntimeAcpEvent::Ready).is_err());
    }

    #[test]
    fn failed_runs_hold_active_and_queued_turns_for_recovery() {
        let mut service = RuntimeService::new();
        service
            .hydrate_thread(parse_host_thread(&thread("thread-1")).expect("thread parses"))
            .expect("thread hydrates");
        service
            .dispatch(RuntimeCommand::Submit {
                thread_id: "thread-1".to_owned(),
                timestamp: "2026-01-01T00:00:00Z".to_owned(),
                started_at: 1,
                submission: submission("first"),
            })
            .expect("submit succeeds");
        service
            .dispatch(RuntimeCommand::Queue {
                thread_id: "thread-1".to_owned(),
                timestamp: "2026-01-01T00:00:01Z".to_owned(),
                submission: submission("second"),
            })
            .expect("queue succeeds");
        let output = service
            .accept_acp(RuntimeAcpEvent::Error {
                thread_id: Some("thread-1".to_owned()),
                message: "agent stopped".to_owned(),
                recoverable: false,
            })
            .expect("error reduces");
        assert_eq!(
            output
                .events
                .iter()
                .filter(|event| matches!(event, RuntimeEvent::QueueHeld { .. }))
                .count(),
            2
        );
        let thread = service.thread("thread-1").expect("thread exists");
        assert!(thread.active.is_none());
        assert!(thread.queued.is_empty());
        assert_eq!(thread.held.len(), 2);
        assert_eq!(thread.page.run.held.len(), 2);
        assert_eq!(thread.page.run.state, RunState::Stopped);
    }

    #[test]
    fn active_hydration_keeps_optimistic_transcript() {
        let mut service = RuntimeService::new();
        service
            .hydrate_thread(parse_host_thread(&thread("thread-1")).expect("thread parses"))
            .expect("thread hydrates");
        service
            .dispatch(RuntimeCommand::Submit {
                thread_id: "thread-1".to_owned(),
                timestamp: "2026-01-01T00:00:00Z".to_owned(),
                started_at: 1,
                submission: submission("optimistic"),
            })
            .expect("submit succeeds");
        service
            .hydrate_thread(
                parse_host_thread(&json!({
                    "id": "thread-1",
                    "title": "Thread",
                    "messages": [{"role":"user","content":"stored","timestamp":"2026-01-01T00:00:00Z"}]
                }))
                .expect("thread parses"),
            )
            .expect("thread hydrates");
        let thread = service.thread("thread-1").expect("thread exists");
        assert_eq!(thread.page.entries.len(), 1);
        assert_eq!(thread.page.entries[0].id(), "turn-1-user");
    }
}
