use std::{
    error::Error,
    fmt,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    KnowledgeBaseId, ScheduledJobId, Timestamp, ValidationError, quote, unquote, validate_text,
};
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

/// What kind of agent owns a thread. `Main` is a thread the user talks to: a root
/// thread, or a sub thread another main thread started and owns. `Subagent` is the
/// transcript of one `task` call — work delegated inside a turn, several of which
/// can run under one thread, and none of which belongs in the projects list.
///
/// Both shapes carry `parent_thread_id`; this is what tells them apart.
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

pub const MAX_THREAD_MESSAGES: usize = 1_024;
pub const MAX_THREAD_SOURCE_BASES: usize = 256;
/// Traces a thread keeps, oldest dropped first. A runaway agent must not be able
/// to grow a thread file without bound, so the two ceilings together cap the
/// trace section of one thread at a megabyte.
pub const MAX_THREAD_TRACES: usize = 64;
pub const MAX_TRACE_BYTES: usize = 16 * 1024;

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
    /// Everything the provider billed as input for this turn: the system prompt,
    /// the tool schemas, retrieved knowledge and the transcript. It is the only
    /// honest measure of what a turn carried, because the parts assembled below
    /// Emma are not visible to the app that draws the context inspector.
    pub input_tokens: u64,
    /// Which model wrote this turn, as the composer's picker named it. Stored per
    /// message rather than read off the current picker, because the picker moves:
    /// a thread half answered by one model and half by another has to read back
    /// as what actually happened. Empty when the caller reported no model, and on
    /// every thread written before format 11 — the transcript then shows no route
    /// rather than attributing an old turn to today's pick.
    pub model: String,
}

/// Long enough for any real `vendor/model-version:variant`, short enough that a
/// junk value cannot bloat the thread file.
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
        // Clamped rather than refused: the model name is a label on the turn, and
        // losing a whole recorded turn over a cosmetic field is the worse failure.
        let model: String = model.into().trim().chars().take(MAX_MODEL_NAME_CHARS).collect();
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

/// One finished turn as an execution trace: every tool call, every subagent, and
/// every subagent's own calls, already rendered as the indented outline a model
/// reads. Core stores it as opaque bounded text rather than a parsed span tree
/// because nothing here reasons about it — `desktop/shared/trace.ts` is the one
/// place the format is written, and a second implementation of it would only
/// drift.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTrace {
    pub timestamp: Timestamp,
    pub text: String,
}

impl ThreadTrace {
    /// An oversized trace loses its middle rather than the whole turn: what a
    /// run set out to do and where it ended up are what diagnose it, and the
    /// repetitive middle is exactly what a stuck agent produces.
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
    // Split by line, so the cut is never inside a character, and spend the budget
    // from both ends at once.
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
    /// The thread that owns this one: the parent of a sub thread, or the thread
    /// whose turn spawned a subagent. Roots leave it empty. Ownership alone says
    /// nothing about which of the two this is — `kind` does.
    pub parent_thread_id: Option<ThreadId>,
    pub kind: ThreadKind,
    /// Set when a scheduled job's due run opened this thread. It is an ordinary
    /// main thread either way; this is what files it under Scheduled tasks
    /// instead of a project the user put threads in themselves.
    pub scheduled_job_id: Option<ScheduledJobId>,
    pub knowledge_base_id: KnowledgeBaseId,
    pub source_knowledge_base_ids: Vec<KnowledgeBaseId>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub archived_at: Option<Timestamp>,
    pub messages: Vec<ThreadMessage>,
    /// Kept out of the snapshot on purpose: at the ceilings above a thread can
    /// hold a megabyte of trace, and every window would carry every thread's.
    /// `read_trace` is how a caller asks for one.
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
            knowledge_base_id: KnowledgeBaseId::default_id(),
            source_knowledge_base_ids: vec![KnowledgeBaseId::default_id()],
            created_at,
            updated_at: created_at,
            archived_at: None,
            messages: Vec::new(),
            traces: Vec::new(),
        })
    }

    /// Appends one turn's trace, dropping the oldest once the thread is full.
    /// Deliberately does not touch `updated_at`: a trace records what a turn did,
    /// it is not itself something said in the thread.
    pub fn record_trace(&mut self, trace: ThreadTrace) {
        self.traces.push(trace);
        while self.traces.len() > MAX_THREAD_TRACES {
            self.traces.remove(0);
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

    pub fn select_knowledge_base(&mut self, id: KnowledgeBaseId) {
        self.knowledge_base_id = id.clone();
        if !self.source_knowledge_base_ids.contains(&id) {
            self.source_knowledge_base_ids.push(id);
        }
    }

    pub fn select_source_knowledge_bases(&mut self, ids: Vec<KnowledgeBaseId>) {
        self.source_knowledge_base_ids.clear();
        for id in std::iter::once(self.knowledge_base_id.clone()).chain(ids) {
            if !self.source_knowledge_base_ids.contains(&id) {
                self.source_knowledge_base_ids.push(id);
            }
        }
    }

    pub fn to_markdown(&self) -> String {
        let mut output = String::from("---\nemma-thread-format: 11\n");
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
        field(
            &mut output,
            "knowledge-base-id",
            self.knowledge_base_id.as_str(),
        );
        output.push_str(&format!(
            "source-knowledge-base-count: {}\n",
            self.source_knowledge_base_ids.len()
        ));
        for (index, id) in self.source_knowledge_base_ids.iter().enumerate() {
            field(&mut output, &format!("source-{index}-id"), id.as_str());
        }
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
        // After the messages, so a reader that stops at the transcript still sees
        // a well-formed thread and the trailing-content check below still holds.
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
        let format = match parser.next()? {
            "emma-thread-format: 1" => 1,
            "emma-thread-format: 2" => 2,
            "emma-thread-format: 3" => 3,
            "emma-thread-format: 4" => 4,
            "emma-thread-format: 5" => 5,
            "emma-thread-format: 6" => 6,
            "emma-thread-format: 7" => 7,
            "emma-thread-format: 8" => 8,
            "emma-thread-format: 9" => 9,
            "emma-thread-format: 10" => 10,
            "emma-thread-format: 11" => 11,
            _ => return Err(ValidationError::new("unsupported thread format")),
        };
        let id = ThreadId::parse(parser.field("id")?)?;
        let title = parser.field("title")?;
        validate_text("thread title", &title, true)?;
        let parent_thread_id = if format < 6 {
            None
        } else {
            match parser.field("parent-thread-id")? {
                value if value.is_empty() => None,
                value => Some(ThreadId::parse(value)?),
            }
        };
        if parent_thread_id.as_ref() == Some(&id) {
            return Err(ValidationError::new("a thread cannot be its own parent"));
        }
        // Before format 9 the only thing that ever had a parent was a subagent's
        // transcript, so that is exactly what an owned older thread reads back as.
        let kind = if format < 9 {
            if parent_thread_id.is_some() {
                ThreadKind::Subagent
            } else {
                ThreadKind::Main
            }
        } else {
            parser.field("kind")?.parse()?
        };
        if kind == ThreadKind::Subagent && parent_thread_id.is_none() {
            return Err(ValidationError::new("a subagent thread must have a parent"));
        }
        // Threads written before format 10 predate scheduled runs being tagged;
        // they read back unfiled rather than being refused.
        let scheduled_job_id = if format < 10 {
            None
        } else {
            match parser.field("scheduled-job-id")? {
                value if value.is_empty() => None,
                value => Some(ScheduledJobId::parse(value)?),
            }
        };
        let knowledge_base_id = if format == 1 {
            KnowledgeBaseId::default_id()
        } else {
            KnowledgeBaseId::parse(parser.field("knowledge-base-id")?)?
        };
        let source_knowledge_base_ids = if format < 3 {
            vec![knowledge_base_id.clone()]
        } else {
            let count: usize = parser
                .number("source-knowledge-base-count")?
                .try_into()
                .map_err(|_| ValidationError::new("source base count is too large"))?;
            if count == 0 || count > MAX_THREAD_SOURCE_BASES {
                return Err(ValidationError::new("source base count is invalid"));
            }
            let mut ids = Vec::with_capacity(count);
            for index in 0..count {
                let id = KnowledgeBaseId::parse(parser.field(&format!("source-{index}-id"))?)?;
                if ids.contains(&id) {
                    return Err(ValidationError::new("source base IDs must be unique"));
                }
                ids.push(id);
            }
            if !ids.contains(&knowledge_base_id) {
                return Err(ValidationError::new(
                    "destination base must also be a source",
                ));
            }
            ids
        };
        let created_at = parser.field("created-at")?.parse()?;
        let updated_at = parser.field("updated-at")?.parse()?;
        let archived_at = if format < 5 {
            None
        } else {
            match parser.field("archived-at")? {
                value if value.is_empty() => None,
                value => Some(value.parse()?),
            }
        };
        let count: usize = parser
            .number("message-count")?
            .try_into()
            .map_err(|_| ValidationError::new("message count is too large"))?;
        if count > MAX_THREAD_MESSAGES {
            return Err(ValidationError::new("thread message count is too large"));
        }
        // Threads written before format 8 carry no traces; they read back with
        // none rather than being refused.
        let trace_count: usize = if format < 8 {
            0
        } else {
            parser
                .number("trace-count")?
                .try_into()
                .map_err(|_| ValidationError::new("trace count is too large"))?
        };
        if trace_count > MAX_THREAD_TRACES {
            return Err(ValidationError::new("thread trace count is too large"));
        }
        parser.exact("---")?;
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
                    // Threads written before format 7 have no input count; they
                    // read back as zero rather than being refused.
                    "present" => Some(GenerationTelemetry::measured(
                        parser.number("Output-Tokens")?,
                        parser.number("Duration-Milliseconds")?,
                        if format < 7 {
                            0
                        } else {
                            parser.number("Input-Tokens")?
                        },
                        // Threads written before format 11 name no model; they read
                        // back unattributed rather than being refused.
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
            knowledge_base_id,
            source_knowledge_base_ids,
            created_at,
            updated_at,
            archived_at,
            messages,
            traces,
        })
    }
}

#[derive(Debug)]
pub struct ThreadStore {
    root: PathBuf,
}

impl ThreadStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
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
        if thread.source_knowledge_base_ids.len() > MAX_THREAD_SOURCE_BASES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("thread cannot have more than {MAX_THREAD_SOURCE_BASES} source bases"),
            )
            .into());
        }
        fs::create_dir_all(&self.root)?;
        let destination = self.path_for(&thread.id);
        let temporary = self.root.join(format!(".{}.tmp", thread.id));
        let result = (|| {
            // ponytail: The single persistence worker owns this temp name; use
            // unique temp names or locking if multi-process writers arrive.
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
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map_err(ThreadStoreError::Io)
    }

    pub fn load(&self, id: &ThreadId) -> Result<Thread, ThreadStoreError> {
        let path = self.path_for(id);
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
        Ok(thread)
    }

    pub fn delete(&self, id: &ThreadId) -> Result<(), ThreadStoreError> {
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
            match self.load(&id) {
                Ok(thread) => listing.threads.push(thread),
                Err(ThreadStoreError::Malformed(thread)) => listing.malformed.push(thread),
                Err(ThreadStoreError::Io(error)) => return Err(ThreadStoreError::Io(error)),
            }
        }
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
    pub threads: Vec<Thread>,
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
