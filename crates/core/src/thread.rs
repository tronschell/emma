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

use crate::{KnowledgeBaseId, Timestamp, ValidationError, quote, unquote, validate_text};
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
}

impl GenerationTelemetry {
    pub fn new(output_tokens: u64, duration_milliseconds: u64) -> Result<Self, ValidationError> {
        if duration_milliseconds == 0 {
            return Err(ValidationError::new("generation duration must be positive"));
        }
        Ok(Self {
            output_tokens,
            duration_milliseconds,
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
pub struct Thread {
    pub id: ThreadId,
    pub title: String,
    pub knowledge_base_id: KnowledgeBaseId,
    pub source_knowledge_base_ids: Vec<KnowledgeBaseId>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub messages: Vec<ThreadMessage>,
}

impl Thread {
    pub fn new(title: impl Into<String>, created_at: Timestamp) -> Result<Self, ValidationError> {
        let title = title.into();
        validate_text("thread title", &title, true)?;
        Ok(Self {
            id: ThreadId::generate(created_at),
            title,
            knowledge_base_id: KnowledgeBaseId::default_id(),
            source_knowledge_base_ids: vec![KnowledgeBaseId::default_id()],
            created_at,
            updated_at: created_at,
            messages: Vec::new(),
        })
    }

    pub fn push(&mut self, message: ThreadMessage) -> Result<(), ValidationError> {
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
        let mut output = String::from("---\nemma-thread-format: 4\n");
        field(&mut output, "id", self.id.as_str());
        field(&mut output, "title", &self.title);
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
        output.push_str(&format!("message-count: {}\n---\n", self.messages.len()));
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
            } else {
                output.push_str("Generation: none\n");
            }
            output.push('\n');
            output.push_str(&quote(&message.content));
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
            _ => return Err(ValidationError::new("unsupported thread format")),
        };
        let id = ThreadId::parse(parser.field("id")?)?;
        let title = parser.field("title")?;
        validate_text("thread title", &title, true)?;
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
            if count == 0 || count > 256 {
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
        let count: usize = parser
            .number("message-count")?
            .try_into()
            .map_err(|_| ValidationError::new("message count is too large"))?;
        parser.exact("---")?;
        let mut messages = Vec::with_capacity(count.min(1_024));
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
                    "present" => Some(GenerationTelemetry::new(
                        parser.number("Output-Tokens")?,
                        parser.number("Duration-Milliseconds")?,
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
        if parser.lines.next().is_some() || updated_at != last {
            return Err(ValidationError::new(
                "thread updated timestamp does not match messages",
            ));
        }
        Ok(Self {
            id,
            title,
            knowledge_base_id,
            source_knowledge_base_ids,
            created_at,
            updated_at,
            messages,
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
