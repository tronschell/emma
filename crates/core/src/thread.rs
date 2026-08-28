use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    error::Error,
    fmt,
    fs::{self, Metadata, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{ScheduledJobId, Timestamp, ValidationError, quote, unquote, validate_text};
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct ThreadId(String);

impl ThreadId {
    pub fn parse(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.len() < 16
            || value.len() > 96
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(ValidationError::new("thread ID is not a safe filename"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn generate(now: Timestamp) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        Self(format!(
            "{}-{:x}-{:x}-{sequence:x}",
            now.unix_seconds(),
            std::process::id(),
            nanos
        ))
    }
}

impl fmt::Display for ThreadId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadRole {
    User,
    Assistant,
    System,
}

impl ThreadRole {
    fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadKind {
    Main,
    Subagent,
}

impl ThreadKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Subagent => "subagent",
        }
    }
}

impl FromStr for ThreadKind {
    type Err = ValidationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "main" => Ok(Self::Main),
            "subagent" => Ok(Self::Subagent),
            _ => Err(ValidationError::new("unknown thread kind")),
        }
    }
}

const THREAD_FORMAT: u64 = 13;

pub const MAX_THREAD_MESSAGES: usize = 1_024;
pub const MAX_THREAD_TRACES: usize = 64;
pub const MAX_TRACE_BYTES: usize = 16 * 1024;

pub const MAX_GOAL_OBJECTIVE_CHARS: usize = 2_000;
pub const MAX_GOAL_EVIDENCE_CHARS: usize = 4_000;
pub const MAX_GOAL_REASON_CHARS: usize = 1_000;
pub const DEFAULT_GOAL_TOKEN_BUDGET: u64 = 200_000;
pub const GOAL_BLOCKED_TURNS: u64 = 3;
pub const MAX_GOAL_TURNS: u64 = 40;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GoalStatus {
    Active,
    Paused,
    Complete,
    Blocked,
    BudgetLimited,
    UsageLimited,
}

impl GoalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Complete => "complete",
            Self::Blocked => "blocked",
            Self::BudgetLimited => "budgetLimited",
            Self::UsageLimited => "usageLimited",
        }
    }

    pub fn pursuing(self) -> bool {
        self == Self::Active
    }

    pub fn settled(self) -> bool {
        matches!(self, Self::Complete | Self::Blocked)
    }
}

impl FromStr for GoalStatus {
    type Err = ValidationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "active" => Ok(Self::Active),
            "paused" => Ok(Self::Paused),
            "complete" => Ok(Self::Complete),
            "blocked" => Ok(Self::Blocked),
            "budgetLimited" => Ok(Self::BudgetLimited),
            "usageLimited" => Ok(Self::UsageLimited),
            _ => Err(ValidationError::new("unknown goal status")),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub objective: String,
    pub status: GoalStatus,
    pub evidence: String,
    pub blocked_reason: String,
    pub blocked_streak: u64,
    pub blocked_at_turn: u64,
    pub token_budget: u64,
    pub tokens_used: u64,
    pub time_used_seconds: u64,
    pub turns: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Goal {
    pub fn new(
        objective: impl Into<String>,
        token_budget: u64,
        at: Timestamp,
    ) -> Result<Self, ValidationError> {
        let objective = capped(
            "goal objective",
            objective.into(),
            MAX_GOAL_OBJECTIVE_CHARS,
            true,
        )?;
        Ok(Self {
            objective,
            status: GoalStatus::Active,
            evidence: String::new(),
            blocked_reason: String::new(),
            blocked_streak: 0,
            blocked_at_turn: 0,
            token_budget: match token_budget {
                0 => DEFAULT_GOAL_TOKEN_BUDGET,
                budget => budget,
            },
            tokens_used: 0,
            time_used_seconds: 0,
            turns: 0,
            created_at: at,
            updated_at: at,
        })
    }

    pub fn tokens_left(&self) -> u64 {
        self.token_budget.saturating_sub(self.tokens_used)
    }
}

fn capped(
    name: &str,
    value: String,
    max: usize,
    required: bool,
) -> Result<String, ValidationError> {
    let value: String = value.trim().chars().take(max).collect();
    validate_text(name, &value, required)?;
    Ok(value)
}

fn same_blocker(previous: &str, reason: &str) -> bool {
    !previous.is_empty() && previous.eq_ignore_ascii_case(reason)
}

impl FromStr for ThreadRole {
    type Err = ValidationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "user" => Ok(Self::User),
            "assistant" => Ok(Self::Assistant),
            "system" => Ok(Self::System),
            _ => Err(ValidationError::new("unknown thread message role")),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationTelemetry {
    pub output_tokens: u64,
    pub duration_milliseconds: u64,
    pub input_tokens: u64,
    pub model: String,
}

const MAX_MODEL_NAME_CHARS: usize = 128;

impl GenerationTelemetry {
    pub fn new(output_tokens: u64, duration_milliseconds: u64) -> Result<Self, ValidationError> {
        Self::measured(output_tokens, duration_milliseconds, 0, "")
    }

    pub fn measured(
        output_tokens: u64,
        duration_milliseconds: u64,
        input_tokens: u64,
        model: impl Into<String>,
    ) -> Result<Self, ValidationError> {
        if duration_milliseconds == 0 {
            return Err(ValidationError::new("generation duration must be positive"));
        }
        let model: String = model
            .into()
            .trim()
            .chars()
            .take(MAX_MODEL_NAME_CHARS)
            .collect();
        validate_text("generation model", &model, false)?;
        Ok(Self {
            output_tokens,
            duration_milliseconds,
            input_tokens,
            model,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessage {
    pub role: ThreadRole,
    pub content: String,
    pub timestamp: Timestamp,
    pub generation: Option<GenerationTelemetry>,
}

impl ThreadMessage {
    pub fn new(
        role: ThreadRole,
        content: impl Into<String>,
        timestamp: Timestamp,
    ) -> Result<Self, ValidationError> {
        let content = content.into();
        validate_text("thread message", &content, true)?;
        Ok(Self {
            role,
            content,
            timestamp,
            generation: None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTrace {
    pub timestamp: Timestamp,
    pub text: String,
}

impl ThreadTrace {
    pub fn new(timestamp: Timestamp, text: &str) -> Result<Self, ValidationError> {
        let text = elide_middle(text, MAX_TRACE_BYTES);
        validate_text("thread trace", &text, true)?;
        Ok(Self { timestamp, text })
    }
}

pub(crate) fn elide_middle(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let lines: Vec<&str> = text.lines().collect();
    let budget = max.saturating_sub(64);
    let mut head: Vec<&str> = Vec::new();
    let mut tail: Vec<&str> = Vec::new();
    let mut used = 0;
    let mut low = 0;
    let mut high = lines.len();
    while low < high {
        let from_head = head.len() <= tail.len();
        let line = if from_head {
            lines[low]
        } else {
            lines[high - 1]
        };
        if used + line.len() + 1 > budget {
            break;
        }
        used += line.len() + 1;
        if from_head {
            head.push(line);
            low += 1;
        } else {
            tail.push(line);
            high -= 1;
        }
    }
    tail.reverse();
    let note = format!("  … {} lines elided …", high - low);
    head.push(&note);
    head.extend(tail);
    head.join("\n")
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: ThreadId,
    pub title: String,
    pub parent_thread_id: Option<ThreadId>,
    pub kind: ThreadKind,
    pub scheduled_job_id: Option<ScheduledJobId>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub archived_at: Option<Timestamp>,
    pub goal: Option<Goal>,
    pub messages: Vec<ThreadMessage>,
    #[serde(skip)]
    pub traces: Vec<ThreadTrace>,
}

impl Thread {
    pub fn new(title: impl Into<String>, created_at: Timestamp) -> Result<Self, ValidationError> {
        let title = title.into();
        validate_text("thread title", &title, true)?;
        Ok(Self {
            id: ThreadId::generate(created_at),
            title,
            parent_thread_id: None,
            kind: ThreadKind::Main,
            scheduled_job_id: None,
            created_at,
            updated_at: created_at,
            archived_at: None,
            goal: None,
            messages: Vec::new(),
            traces: Vec::new(),
        })
    }

    pub fn record_trace(&mut self, trace: ThreadTrace) {
        self.traces.push(trace);
        while self.traces.len() > MAX_THREAD_TRACES {
            self.traces.remove(0);
        }
    }

    pub fn set_goal(
        &mut self,
        objective: impl Into<String>,
        token_budget: u64,
        at: Timestamp,
    ) -> Result<&Goal, ValidationError> {
        let mut goal = Goal::new(objective, token_budget, at)?;
        if let Some(spent) = self.goal.as_ref().filter(|goal| !goal.status.settled()) {
            goal.tokens_used = spent.tokens_used;
            goal.turns = spent.turns;
            goal.time_used_seconds = spent.time_used_seconds;
            goal.created_at = spent.created_at;
        }
        self.goal = Some(goal);
        Ok(self.goal.as_ref().expect("a goal was just set"))
    }

    pub fn clear_goal(&mut self) -> bool {
        self.goal.take().is_some()
    }

    pub fn update_goal(
        &mut self,
        status: GoalStatus,
        evidence: &str,
        reason: &str,
        at: Timestamp,
    ) -> Result<&Goal, ValidationError> {
        let evidence = capped(
            "goal evidence",
            evidence.to_owned(),
            MAX_GOAL_EVIDENCE_CHARS,
            false,
        )?;
        let reason = capped(
            "goal blocker",
            reason.to_owned(),
            MAX_GOAL_REASON_CHARS,
            false,
        )?;
        let goal = self
            .goal
            .as_mut()
            .ok_or_else(|| ValidationError::new("this thread has no goal"))?;
        if goal.status == GoalStatus::Complete
            || (goal.status.settled() && status != GoalStatus::Active)
        {
            return Err(ValidationError::new(format!(
                "this goal is already {}",
                goal.status.as_str()
            )));
        }
        match status {
            GoalStatus::Complete => {
                if evidence.is_empty() {
                    return Err(ValidationError::new(
                        "a goal is complete only with evidence: what was run, what it printed, what changed",
                    ));
                }
                goal.evidence = evidence;
                goal.status = GoalStatus::Complete;
            }
            GoalStatus::Blocked => {
                if goal.blocked_streak == 0 || goal.blocked_at_turn != goal.turns {
                    goal.blocked_streak = match same_blocker(&goal.blocked_reason, &reason) {
                        true => goal.blocked_streak + 1,
                        false => 1,
                    };
                    goal.blocked_at_turn = goal.turns;
                }
                goal.blocked_reason = reason;
                goal.status = match goal.blocked_streak >= GOAL_BLOCKED_TURNS {
                    true => GoalStatus::Blocked,
                    false => GoalStatus::Active,
                };
            }
            GoalStatus::Active => {
                goal.status = GoalStatus::Active;
                goal.blocked_streak = 0;
                goal.blocked_reason = String::new();
                if !evidence.is_empty() {
                    goal.evidence = evidence;
                }
            }
            status => {
                goal.status = status;
                if !evidence.is_empty() {
                    goal.evidence = evidence;
                }
                if !reason.is_empty() {
                    goal.blocked_reason = reason;
                }
            }
        }
        goal.updated_at = at;
        Ok(self.goal.as_ref().expect("a goal was just updated"))
    }

    pub fn extend_goal(
        &mut self,
        extra_tokens: u64,
        at: Timestamp,
    ) -> Result<&Goal, ValidationError> {
        let goal = self
            .goal
            .as_mut()
            .ok_or_else(|| ValidationError::new("this thread has no goal"))?;
        if goal.status == GoalStatus::Complete {
            return Err(ValidationError::new("this goal is already complete"));
        }
        goal.token_budget = goal.token_budget.saturating_add(match extra_tokens {
            0 => DEFAULT_GOAL_TOKEN_BUDGET,
            tokens => tokens,
        });
        goal.status = GoalStatus::Active;
        goal.turns = 0;
        goal.blocked_streak = 0;
        goal.blocked_reason = String::new();
        goal.updated_at = at;
        Ok(self.goal.as_ref().expect("a goal was just extended"))
    }

    pub fn note_goal_turn(&mut self, tokens: u64, duration_milliseconds: u64, at: Timestamp) {
        let Some(goal) = self.goal.as_mut() else {
            return;
        };
        if goal.status == GoalStatus::Paused {
            return;
        }
        goal.turns += 1;
        goal.tokens_used = goal.tokens_used.saturating_add(tokens);
        goal.time_used_seconds = goal
            .time_used_seconds
            .saturating_add(duration_milliseconds / 1_000);
        goal.updated_at = at;
        if goal.status.pursuing()
            && (goal.tokens_used >= goal.token_budget || goal.turns >= MAX_GOAL_TURNS)
        {
            goal.status = GoalStatus::BudgetLimited;
        }
    }

    pub fn push(&mut self, message: ThreadMessage) -> Result<(), ValidationError> {
        if self.messages.len() >= MAX_THREAD_MESSAGES {
            return Err(ValidationError::new(format!(
                "thread cannot have more than {MAX_THREAD_MESSAGES} messages"
            )));
        }
        if message.generation.is_some() && message.role != ThreadRole::Assistant {
            return Err(ValidationError::new(
                "generation telemetry belongs only to assistant messages",
            ));
        }
        if message.timestamp < self.updated_at {
            return Err(ValidationError::new(
                "thread messages must be chronological",
            ));
        }
        self.updated_at = message.timestamp;
        self.messages.push(message);
        Ok(())
    }

    pub fn to_markdown(&self) -> String {
        let mut output = format!("---\nemma-thread-format: {THREAD_FORMAT}\n");
        field(&mut output, "id", self.id.as_str());
        field(&mut output, "title", &self.title);
        field(
            &mut output,
            "parent-thread-id",
            self.parent_thread_id
                .as_ref()
                .map_or("", |parent| parent.as_str()),
        );
        field(&mut output, "kind", self.kind.as_str());
        field(
            &mut output,
            "scheduled-job-id",
            self.scheduled_job_id
                .as_ref()
                .map_or("", |job| job.as_str()),
        );
        field(&mut output, "created-at", &self.created_at.to_string());
        field(&mut output, "updated-at", &self.updated_at.to_string());
        field(
            &mut output,
            "archived-at",
            &self
                .archived_at
                .map(|at| at.to_string())
                .unwrap_or_default(),
        );
        if let Some(goal) = &self.goal {
            field(&mut output, "goal-objective", &goal.objective);
            field(&mut output, "goal-status", goal.status.as_str());
            field(&mut output, "goal-evidence", &goal.evidence);
            field(&mut output, "goal-blocked-reason", &goal.blocked_reason);
            output.push_str(&format!("goal-blocked-streak: {}\n", goal.blocked_streak));
            output.push_str(&format!("goal-blocked-at-turn: {}\n", goal.blocked_at_turn));
            output.push_str(&format!("goal-token-budget: {}\n", goal.token_budget));
            output.push_str(&format!("goal-tokens-used: {}\n", goal.tokens_used));
            output.push_str(&format!(
                "goal-time-used-seconds: {}\n",
                goal.time_used_seconds
            ));
            output.push_str(&format!("goal-turns: {}\n", goal.turns));
            field(&mut output, "goal-created-at", &goal.created_at.to_string());
            field(&mut output, "goal-updated-at", &goal.updated_at.to_string());
        }
        output.push_str(&format!("message-count: {}\n", self.messages.len()));
        output.push_str(&format!("trace-count: {}\n---\n", self.traces.len()));
        for (index, message) in self.messages.iter().enumerate() {
            output.push_str(&format!("\n## Message {}\n\n", index + 1));
            output.push_str(&format!("Role: {}\n\n", message.role.as_str()));
            output.push_str(&format!("Time: {}\n\n", message.timestamp));
            if let Some(generation) = &message.generation {
                output.push_str("Generation: present\n");
                output.push_str(&format!("Output-Tokens: {}\n", generation.output_tokens));
                output.push_str(&format!(
                    "Duration-Milliseconds: {}\n",
                    generation.duration_milliseconds
                ));
                output.push_str(&format!("Input-Tokens: {}\n", generation.input_tokens));
                field(&mut output, "Model", &generation.model);
            } else {
                output.push_str("Generation: none\n");
            }
            output.push('\n');
            output.push_str(&quote(&message.content));
            output.push('\n');
        }
        for (index, trace) in self.traces.iter().enumerate() {
            output.push_str(&format!("\n## Trace {}\n\n", index + 1));
            output.push_str(&format!("Time: {}\n\n", trace.timestamp));
            output.push_str(&quote(&trace.text));
            output.push('\n');
        }
        output
    }

    pub fn from_markdown(markdown: &str) -> Result<Self, ValidationError> {
        let mut parser = Parser::new(markdown);
        parser.exact("---")?;
        let header = Header::read(&mut parser)?;
        let format = header.number("emma-thread-format")?;
        if format == 0 || format > THREAD_FORMAT {
            return Err(ValidationError::new("unsupported thread format"));
        }
        let id = ThreadId::parse(header.field("id")?)?;
        let title = header.field("title")?;
        validate_text("thread title", &title, true)?;
        let parent_thread_id = match header.optional("parent-thread-id")? {
            value if value.is_empty() => None,
            value => Some(ThreadId::parse(value)?),
        };
        if parent_thread_id.as_ref() == Some(&id) {
            return Err(ValidationError::new("a thread cannot be its own parent"));
        }
        let kind = match header.optional("kind")?.as_str() {
            "" => match parent_thread_id {
                Some(_) => ThreadKind::Subagent,
                None => ThreadKind::Main,
            },
            value => value.parse()?,
        };
        if kind == ThreadKind::Subagent && parent_thread_id.is_none() {
            return Err(ValidationError::new("a subagent thread must have a parent"));
        }
        let scheduled_job_id = match header.optional("scheduled-job-id")? {
            value if value.is_empty() => None,
            value => Some(ScheduledJobId::parse(value)?),
        };
        let created_at = header.field("created-at")?.parse()?;
        let updated_at = header.field("updated-at")?.parse()?;
        let archived_at = match header.optional("archived-at")? {
            value if value.is_empty() => None,
            value => Some(value.parse()?),
        };
        let objective = header.optional("goal-objective")?;
        let goal = match objective.trim().is_empty() {
            true => None,
            false => Some(Goal {
                objective: capped("goal objective", objective, MAX_GOAL_OBJECTIVE_CHARS, true)?,
                status: match header.optional("goal-status")?.as_str() {
                    "" => GoalStatus::Active,
                    value => value.parse()?,
                },
                evidence: capped(
                    "goal evidence",
                    header.optional("goal-evidence")?,
                    MAX_GOAL_EVIDENCE_CHARS,
                    false,
                )?,
                blocked_reason: capped(
                    "goal blocker",
                    header.optional("goal-blocked-reason")?,
                    MAX_GOAL_REASON_CHARS,
                    false,
                )?,
                blocked_streak: header.optional_number("goal-blocked-streak")?,
                blocked_at_turn: header.optional_number("goal-blocked-at-turn")?,
                token_budget: match header.optional_number("goal-token-budget")? {
                    0 => DEFAULT_GOAL_TOKEN_BUDGET,
                    budget => budget,
                },
                tokens_used: header.optional_number("goal-tokens-used")?,
                time_used_seconds: header.optional_number("goal-time-used-seconds")?,
                turns: header.optional_number("goal-turns")?,
                created_at: match header.optional("goal-created-at")? {
                    value if value.is_empty() => created_at,
                    value => value.parse()?,
                },
                updated_at: match header.optional("goal-updated-at")? {
                    value if value.is_empty() => updated_at,
                    value => value.parse()?,
                },
            }),
        };
        let count: usize = header
            .number("message-count")?
            .try_into()
            .map_err(|_| ValidationError::new("message count is too large"))?;
        if count > MAX_THREAD_MESSAGES {
            return Err(ValidationError::new("thread message count is too large"));
        }
        let trace_count: usize = header
            .optional_number("trace-count")?
            .try_into()
            .map_err(|_| ValidationError::new("trace count is too large"))?;
        if trace_count > MAX_THREAD_TRACES {
            return Err(ValidationError::new("thread trace count is too large"));
        }
        let mut messages = Vec::with_capacity(count);
        let mut last = created_at;
        for index in 0..count {
            parser.exact("")?;
            parser.exact(&format!("## Message {}", index + 1))?;
            parser.exact("")?;
            let role = parser.prefixed("Role: ")?.parse()?;
            parser.exact("")?;
            let timestamp: Timestamp = parser.prefixed("Time: ")?.parse()?;
            parser.exact("")?;
            let generation = if format < 4 {
                None
            } else {
                let generation = match parser.prefixed("Generation: ")? {
                    "none" => None,
                    "present" => Some(GenerationTelemetry::measured(
                        parser.number("Output-Tokens")?,
                        parser.number("Duration-Milliseconds")?,
                        if format < 7 {
                            0
                        } else {
                            parser.number("Input-Tokens")?
                        },
                        if format < 11 {
                            String::new()
                        } else {
                            parser.field("Model")?
                        },
                    )?),
                    _ => return Err(ValidationError::new("unknown generation telemetry state")),
                };
                parser.exact("")?;
                generation
            };
            let content = unquote(parser.next()?)?;
            validate_text("thread message", &content, true)?;
            if timestamp < last {
                return Err(ValidationError::new(
                    "thread messages must be chronological",
                ));
            }
            if generation.is_some() && role != ThreadRole::Assistant {
                return Err(ValidationError::new(
                    "generation telemetry belongs only to assistant messages",
                ));
            }
            last = timestamp;
            messages.push(ThreadMessage {
                role,
                content,
                timestamp,
                generation,
            });
        }
        let mut traces = Vec::with_capacity(trace_count);
        for index in 0..trace_count {
            parser.exact("")?;
            parser.exact(&format!("## Trace {}", index + 1))?;
            parser.exact("")?;
            let timestamp: Timestamp = parser.prefixed("Time: ")?.parse()?;
            parser.exact("")?;
            let text = unquote(parser.next()?)?;
            traces.push(ThreadTrace::new(timestamp, &text)?);
        }
        if parser.lines.next().is_some() || updated_at != last {
            return Err(ValidationError::new(
                "thread updated timestamp does not match messages",
            ));
        }
        Ok(Self {
            id,
            title,
            parent_thread_id,
            kind,
            scheduled_job_id,
            created_at,
            updated_at,
            archived_at,
            goal,
            messages,
            traces,
        })
    }
}

#[derive(Debug)]
struct ParsedThread {
    modified: SystemTime,
    length: u64,
    thread: Arc<Thread>,
}

fn file_stamp(metadata: &Metadata) -> Option<(SystemTime, u64)> {
    Some((metadata.modified().ok()?, metadata.len()))
}

#[derive(Debug)]
pub struct ThreadStore {
    root: PathBuf,
    parsed: RefCell<HashMap<ThreadId, ParsedThread>>,
}

impl ThreadStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            parsed: RefCell::new(HashMap::new()),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn take_parsed(&self, id: &ThreadId, stamp: (SystemTime, u64)) -> Option<Arc<Thread>> {
        self.parsed
            .borrow()
            .get(id)
            .filter(|entry| (entry.modified, entry.length) == stamp)
            .map(|entry| Arc::clone(&entry.thread))
    }

    fn keep_parsed(&self, stamp: (SystemTime, u64), thread: Arc<Thread>) {
        self.parsed.borrow_mut().insert(
            thread.id.clone(),
            ParsedThread {
                modified: stamp.0,
                length: stamp.1,
                thread,
            },
        );
    }

    pub fn save(&self, thread: &Thread) -> Result<PathBuf, ThreadStoreError> {
        if thread.messages.len() > MAX_THREAD_MESSAGES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("thread cannot have more than {MAX_THREAD_MESSAGES} messages"),
            )
            .into());
        }
        if thread.traces.len() > MAX_THREAD_TRACES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("thread cannot have more than {MAX_THREAD_TRACES} traces"),
            )
            .into());
        }
        fs::create_dir_all(&self.root)?;
        let destination = self.path_for(&thread.id);
        let temporary = self.root.join(format!(".{}.tmp", thread.id));
        let result = (|| {
            match fs::remove_file(&temporary) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(thread.to_markdown().as_bytes())?;
            file.sync_all()?;
            fs::rename(&temporary, &destination)?;
            Ok(destination)
        })();
        match &result {
            Ok(written) => match fs::metadata(written).ok().and_then(|it| file_stamp(&it)) {
                Some(stamp) => self.keep_parsed(stamp, Arc::new(thread.clone())),
                None => {
                    self.parsed.borrow_mut().remove(&thread.id);
                }
            },
            Err(_) => {
                let _ = fs::remove_file(&temporary);
                self.parsed.borrow_mut().remove(&thread.id);
            }
        }
        result.map_err(ThreadStoreError::Io)
    }

    pub fn load(&self, id: &ThreadId) -> Result<Thread, ThreadStoreError> {
        self.cached(id).map(|thread| (*thread).clone())
    }

    fn cached(&self, id: &ThreadId) -> Result<Arc<Thread>, ThreadStoreError> {
        let path = self.path_for(id);
        let stamp = fs::metadata(&path).ok().and_then(|it| file_stamp(&it));
        if let Some(thread) = stamp.and_then(|stamp| self.take_parsed(id, stamp)) {
            return Ok(thread);
        }
        let markdown = fs::read_to_string(&path)?;
        let thread = Thread::from_markdown(&markdown).map_err(|error| {
            ThreadStoreError::Malformed(MalformedThread {
                path: path.clone(),
                reason: error.to_string(),
            })
        })?;
        if &thread.id != id {
            return Err(ThreadStoreError::Malformed(MalformedThread {
                path,
                reason: "thread ID does not match filename".into(),
            }));
        }
        let thread = Arc::new(thread);
        if let Some(stamp) = stamp {
            self.keep_parsed(stamp, Arc::clone(&thread));
        }
        Ok(thread)
    }

    pub fn delete(&self, id: &ThreadId) -> Result<(), ThreadStoreError> {
        self.parsed.borrow_mut().remove(id);
        match fs::remove_file(self.path_for(id)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }

    pub fn list(&self) -> Result<ThreadListing, ThreadStoreError> {
        let mut listing = ThreadListing::default();
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(listing),
            Err(error) => return Err(ThreadStoreError::Io(error)),
        };
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                listing.malformed.push(MalformedThread {
                    path,
                    reason: "filename is not UTF-8".into(),
                });
                continue;
            };
            let id = match ThreadId::parse(stem) {
                Ok(id) => id,
                Err(error) => {
                    listing.malformed.push(MalformedThread {
                        path,
                        reason: error.to_string(),
                    });
                    continue;
                }
            };
            match self.cached(&id) {
                Ok(thread) => listing.threads.push(thread),
                Err(ThreadStoreError::Malformed(thread)) => listing.malformed.push(thread),
                Err(ThreadStoreError::Io(error)) => return Err(ThreadStoreError::Io(error)),
            }
        }
        let present: HashSet<&ThreadId> = listing.threads.iter().map(|thread| &thread.id).collect();
        self.parsed
            .borrow_mut()
            .retain(|id, _| present.contains(id));
        listing.threads.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then(right.id.cmp(&left.id))
        });
        listing
            .malformed
            .sort_by(|left, right| left.path.cmp(&right.path));
        Ok(listing)
    }

    fn path_for(&self, id: &ThreadId) -> PathBuf {
        self.root.join(format!("{id}.md"))
    }
}

#[derive(Debug, Default)]
pub struct ThreadListing {
    pub threads: Vec<Arc<Thread>>,
    pub malformed: Vec<MalformedThread>,
}

#[derive(Debug)]
pub struct MalformedThread {
    pub path: PathBuf,
    pub reason: String,
}

#[derive(Debug)]
pub enum ThreadStoreError {
    Io(io::Error),
    Malformed(MalformedThread),
}

impl fmt::Display for ThreadStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            Self::Malformed(thread) => {
                write!(formatter, "{}: {}", thread.path.display(), thread.reason)
            }
        }
    }
}

impl Error for ThreadStoreError {}

impl From<io::Error> for ThreadStoreError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

fn field(output: &mut String, name: &str, value: &str) {
    output.push_str(name);
    output.push_str(": ");
    output.push_str(&quote(value));
    output.push('\n');
}

struct Header(HashMap<String, String>);

impl Header {
    fn read(parser: &mut Parser<'_>) -> Result<Self, ValidationError> {
        let mut fields = HashMap::new();
        loop {
            let line = parser.next()?;
            if line == "---" {
                return Ok(Self(fields));
            }
            if let Some((name, value)) = line.split_once(": ") {
                fields.insert(name.to_owned(), value.to_owned());
            }
        }
    }

    fn field(&self, name: &str) -> Result<String, ValidationError> {
        match self.0.get(name) {
            Some(value) => unquote(value),
            None => Err(ValidationError::new(format!("expected field {name}"))),
        }
    }

    fn optional(&self, name: &str) -> Result<String, ValidationError> {
        match self.0.get(name) {
            Some(value) => unquote(value),
            None => Ok(String::new()),
        }
    }

    fn number(&self, name: &str) -> Result<u64, ValidationError> {
        match self.0.get(name) {
            Some(value) => value
                .parse()
                .map_err(|_| ValidationError::new(format!("field {name} is not a number"))),
            None => Err(ValidationError::new(format!("expected field {name}"))),
        }
    }

    fn optional_number(&self, name: &str) -> Result<u64, ValidationError> {
        match self.0.contains_key(name) {
            true => self.number(name),
            false => Ok(0),
        }
    }
}

struct Parser<'a> {
    lines: std::str::Lines<'a>,
}

impl<'a> Parser<'a> {
    fn new(markdown: &'a str) -> Self {
        Self {
            lines: markdown.lines(),
        }
    }

    fn next(&mut self) -> Result<&'a str, ValidationError> {
        self.lines
            .next()
            .ok_or_else(|| ValidationError::new("thread ended unexpectedly"))
    }

    fn exact(&mut self, expected: &str) -> Result<(), ValidationError> {
        if self.next()? == expected {
            Ok(())
        } else {
            Err(ValidationError::new(format!("expected {expected:?}")))
        }
    }

    fn prefixed(&mut self, prefix: &str) -> Result<&'a str, ValidationError> {
        self.next()?
            .strip_prefix(prefix)
            .ok_or_else(|| ValidationError::new(format!("expected {prefix:?}")))
    }

    fn field(&mut self, name: &str) -> Result<String, ValidationError> {
        unquote(self.prefixed(&format!("{name}: "))?)
    }

    fn number(&mut self, name: &str) -> Result<u64, ValidationError> {
        self.prefixed(&format!("{name}: "))?
            .parse()
            .map_err(|_| ValidationError::new(format!("field {name} is not a number")))
    }
}
