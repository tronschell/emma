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

use crate::{Timestamp, ValidationError, quote, unquote, validate_text};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadMessage {
    pub role: ThreadRole,
    pub content: String,
    pub timestamp: Timestamp,
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
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Thread {
    pub id: ThreadId,
    pub title: String,
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
            created_at,
            updated_at: created_at,
            messages: Vec::new(),
        })
    }

    pub fn push(&mut self, message: ThreadMessage) -> Result<(), ValidationError> {
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
        let mut output = String::from("---\nemma-thread-format: 1\n");
        field(&mut output, "id", self.id.as_str());
        field(&mut output, "title", &self.title);
        field(&mut output, "created-at", &self.created_at.to_string());
        field(&mut output, "updated-at", &self.updated_at.to_string());
        output.push_str(&format!("message-count: {}\n---\n", self.messages.len()));
        for (index, message) in self.messages.iter().enumerate() {
            output.push_str(&format!("\n## Message {}\n\n", index + 1));
            output.push_str(&format!("Role: {}\n\n", message.role.as_str()));
            output.push_str(&format!("Time: {}\n\n", message.timestamp));
            output.push_str(&quote(&message.content));
            output.push('\n');
        }
        output
    }

    pub fn from_markdown(markdown: &str) -> Result<Self, ValidationError> {
        let mut parser = Parser::new(markdown);
        parser.exact("---")?;
        parser.exact("emma-thread-format: 1")?;
        let id = ThreadId::parse(parser.field("id")?)?;
        let title = parser.field("title")?;
        validate_text("thread title", &title, true)?;
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
            let content = unquote(parser.next()?)?;
            validate_text("thread message", &content, true)?;
            if timestamp < last {
                return Err(ValidationError::new(
                    "thread messages must be chronological",
                ));
            }
            last = timestamp;
            messages.push(ThreadMessage {
                role,
                content,
                timestamp,
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
