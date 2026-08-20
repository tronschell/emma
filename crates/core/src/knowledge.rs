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

use crate::ThreadId;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedContext {
    pub text: String,
    pub source_application: Option<String>,
    pub source_url: Option<SourceUrl>,
}

impl CapturedContext {
    pub fn new(
        text: impl Into<String>,
        source_application: Option<String>,
        source_url: Option<SourceUrl>,
    ) -> Result<Self, ValidationError> {
        let text = text.into();
        validate_text("captured text", &text, false)?;
        if let Some(application) = &source_application {
            validate_text("source application", application, false)?;
        }
        Ok(Self {
            text,
            source_application,
            source_url,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Category(String);

impl Category {
    pub fn parse(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 64
            || value.starts_with('-')
            || value.ends_with('-')
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(ValidationError::new(
                "category must be a lowercase slug no longer than 64 bytes",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl FromStr for Category {
    type Err = ValidationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnalysisContent {
    pub summary: String,
    pub body: String,
}

impl AnalysisContent {
    pub fn new(
        summary: impl Into<String>,
        body: impl Into<String>,
    ) -> Result<Self, ValidationError> {
        let summary = summary.into();
        let body = body.into();
        validate_text("analysis summary", &summary, true)?;
        validate_text("analysis body", &body, false)?;
        Ok(Self { summary, body })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CitedSource {
    pub title: String,
    pub url: SourceUrl,
}

impl CitedSource {
    pub fn new(title: impl Into<String>, url: SourceUrl) -> Result<Self, ValidationError> {
        let title = title.into();
        validate_text("source title", &title, true)?;
        Ok(Self { title, url })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceUrl(String);

impl SourceUrl {
    pub fn parse(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        let rest = value
            .strip_prefix("https://")
            .or_else(|| value.strip_prefix("http://"))
            .ok_or_else(|| ValidationError::new("URL must use http or https"))?;
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let (host, port) = authority
            .rsplit_once(':')
            .map_or((authority, None), |(host, port)| (host, Some(port)));
        if authority.is_empty()
            || authority.contains('@')
            || host.is_empty()
            || !host
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
            || port.is_some_and(|port| {
                port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit())
            })
            || value.contains('\\')
            || value.chars().any(char::is_whitespace)
            || value.chars().any(char::is_control)
        {
            return Err(ValidationError::new(
                "URL has an invalid authority or character",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SourceUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Timestamp(i64);

impl Timestamp {
    pub fn now() -> Self {
        Self::from(SystemTime::now())
    }

    pub const fn from_unix_seconds(seconds: i64) -> Self {
        Self(seconds)
    }

    pub const fn unix_seconds(self) -> i64 {
        self.0
    }

    pub fn to_iso8601(self) -> String {
        let days = self.0.div_euclid(86_400);
        let seconds = self.0.rem_euclid(86_400);
        let (year, month, day) = civil_from_days(days);
        format!(
            "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
            seconds / 3_600,
            seconds / 60 % 60,
            seconds % 60
        )
    }
}

impl From<SystemTime> for Timestamp {
    fn from(value: SystemTime) -> Self {
        match value.duration_since(UNIX_EPOCH) {
            Ok(duration) => Self(i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)),
            Err(error) => {
                let duration = error.duration();
                let seconds = duration.as_secs() + u64::from(duration.subsec_nanos() != 0);
                Self(-i64::try_from(seconds).unwrap_or(i64::MAX))
            }
        }
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.to_iso8601())
    }
}

impl FromStr for Timestamp {
    type Err = ValidationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if !value.is_ascii()
            || value.len() != 20
            || &value[4..5] != "-"
            || &value[7..8] != "-"
            || &value[10..11] != "T"
            || &value[13..14] != ":"
            || &value[16..17] != ":"
            || &value[19..] != "Z"
        {
            return Err(ValidationError::new("timestamp is not ISO-8601 UTC"));
        }
        let number = |range: std::ops::Range<usize>| {
            value[range]
                .parse::<u32>()
                .map_err(|_| ValidationError::new("timestamp contains a non-number"))
        };
        let year = number(0..4)? as i32;
        let month = number(5..7)?;
        let day = number(8..10)?;
        let hour = number(11..13)?;
        let minute = number(14..16)?;
        let second = number(17..19)?;
        let max_day = days_in_month(year, month)
            .ok_or_else(|| ValidationError::new("timestamp month is invalid"))?;
        if day == 0 || day > max_day || hour > 23 || minute > 59 || second > 59 {
            return Err(ValidationError::new("timestamp component is out of range"));
        }
        Ok(Self(
            days_from_civil(year, month, day) * 86_400
                + i64::from(hour * 3_600 + minute * 60 + second),
        ))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunTelemetry {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub subagent_count: u32,
}

impl RunTelemetry {
    pub fn new(
        model: impl Into<String>,
        input_tokens: u64,
        output_tokens: u64,
        subagent_count: u32,
    ) -> Result<Self, ValidationError> {
        let model = model.into();
        validate_text("model", &model, true)?;
        Ok(Self {
            model,
            input_tokens,
            output_tokens,
            subagent_count,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PageId(String);

impl PageId {
    pub fn parse(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.len() < 16
            || value.len() > 96
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(ValidationError::new("page ID is not a safe filename"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn generate(now: Timestamp) -> Self {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        Self(format!(
            "{}-{:x}-{:x}-{:x}",
            now.unix_seconds(),
            std::process::id(),
            nanos,
            sequence
        ))
    }
}

impl fmt::Display for PageId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnowledgePage {
    pub id: PageId,
    pub title: String,
    pub category: Category,
    pub context: CapturedContext,
    pub analysis: AnalysisContent,
    pub sources: Vec<CitedSource>,
    pub added_at: Timestamp,
    pub analyzed_at: Timestamp,
    pub telemetry: RunTelemetry,
    pub source_thread_id: Option<ThreadId>,
}

impl KnowledgePage {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        title: impl Into<String>,
        category: Category,
        context: CapturedContext,
        analysis: AnalysisContent,
        sources: Vec<CitedSource>,
        added_at: Timestamp,
        analyzed_at: Timestamp,
        telemetry: RunTelemetry,
    ) -> Result<Self, ValidationError> {
        let title = title.into();
        validate_text("page title", &title, true)?;
        if analyzed_at < added_at {
            return Err(ValidationError::new("analysis cannot predate capture"));
        }
        Ok(Self {
            id: PageId::generate(added_at),
            title,
            category,
            context,
            analysis,
            sources,
            added_at,
            analyzed_at,
            telemetry,
            source_thread_id: None,
        })
    }

    pub fn with_source_thread(mut self, thread_id: ThreadId) -> Self {
        self.source_thread_id = Some(thread_id);
        self
    }

    pub fn to_markdown(&self) -> String {
        let mut output = String::from("---\nemma-format: 1\n");
        field(&mut output, "id", self.id.as_str());
        field(&mut output, "title", &self.title);
        field(&mut output, "category", self.category.as_str());
        field(&mut output, "added-at", &self.added_at.to_string());
        field(&mut output, "analyzed-at", &self.analyzed_at.to_string());
        field(&mut output, "model", &self.telemetry.model);
        number_field(&mut output, "input-tokens", self.telemetry.input_tokens);
        number_field(&mut output, "output-tokens", self.telemetry.output_tokens);
        number_field(
            &mut output,
            "subagent-count",
            u64::from(self.telemetry.subagent_count),
        );
        optional_field(
            &mut output,
            "source-application",
            self.context.source_application.as_deref(),
        );
        optional_field(
            &mut output,
            "source-url",
            self.context.source_url.as_ref().map(SourceUrl::as_str),
        );
        optional_field(
            &mut output,
            "source-thread-id",
            self.source_thread_id.as_ref().map(ThreadId::as_str),
        );
        number_field(&mut output, "cited-source-count", self.sources.len() as u64);
        for (index, source) in self.sources.iter().enumerate() {
            field(&mut output, &format!("cited-{index}-title"), &source.title);
            field(
                &mut output,
                &format!("cited-{index}-url"),
                source.url.as_str(),
            );
        }
        output.push_str("---\n\n## Captured context\n\n");
        output.push_str(&quote(&self.context.text));
        output.push_str("\n\n## Analysis summary\n\n");
        output.push_str(&quote(&self.analysis.summary));
        output.push_str("\n\n## Analysis\n\n");
        output.push_str(&quote(&self.analysis.body));
        output.push('\n');
        output
    }

    pub fn from_markdown(markdown: &str) -> Result<Self, ValidationError> {
        Parser::new(markdown).parse()
    }
}

#[derive(Debug)]
pub struct KnowledgeStore {
    root: PathBuf,
}

impl KnowledgeStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn save(&self, page: &KnowledgePage) -> Result<PathBuf, StoreError> {
        fs::create_dir_all(&self.root)?;
        let destination = self.path_for(&page.id);
        let temporary = self.root.join(format!(".{}.tmp", page.id));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(page.to_markdown().as_bytes())?;
            file.sync_all()?;
            fs::rename(&temporary, &destination)?;
            Ok(destination)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map_err(StoreError::Io)
    }

    pub fn load(&self, id: &PageId) -> Result<KnowledgePage, StoreError> {
        let path = self.path_for(id);
        let markdown = fs::read_to_string(&path)?;
        let page = KnowledgePage::from_markdown(&markdown).map_err(|error| {
            StoreError::Malformed(MalformedPage {
                path: path.clone(),
                reason: error.to_string(),
            })
        })?;
        if &page.id != id {
            return Err(StoreError::Malformed(MalformedPage {
                path,
                reason: "page ID does not match filename".into(),
            }));
        }
        Ok(page)
    }

    pub fn list(&self) -> Result<StoreListing, StoreError> {
        let mut listing = StoreListing::default();
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(listing),
            Err(error) => return Err(StoreError::Io(error)),
        };
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                listing.malformed.push(MalformedPage {
                    path,
                    reason: "filename is not UTF-8".into(),
                });
                continue;
            };
            let id = match PageId::parse(stem) {
                Ok(id) => id,
                Err(error) => {
                    listing.malformed.push(MalformedPage {
                        path,
                        reason: error.to_string(),
                    });
                    continue;
                }
            };
            match self.load(&id) {
                Ok(page) => listing.pages.push(page),
                Err(StoreError::Malformed(page)) => listing.malformed.push(page),
                Err(StoreError::Io(error)) => return Err(StoreError::Io(error)),
            }
        }
        listing.pages.sort_by(|left, right| {
            right
                .added_at
                .cmp(&left.added_at)
                .then(right.id.cmp(&left.id))
        });
        listing
            .malformed
            .sort_by(|left, right| left.path.cmp(&right.path));
        Ok(listing)
    }

    fn path_for(&self, id: &PageId) -> PathBuf {
        self.root.join(format!("{id}.md"))
    }
}

#[derive(Debug, Default)]
pub struct StoreListing {
    pub pages: Vec<KnowledgePage>,
    pub malformed: Vec<MalformedPage>,
}

#[derive(Debug)]
pub struct MalformedPage {
    pub path: PathBuf,
    pub reason: String,
}

#[derive(Debug)]
pub enum StoreError {
    Io(io::Error),
    Malformed(MalformedPage),
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            Self::Malformed(page) => write!(formatter, "{}: {}", page.path.display(), page.reason),
        }
    }
}

impl Error for StoreError {}

impl From<io::Error> for StoreError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleStage {
    Capture,
    Analyze,
    Save,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CaptureLifecycle {
    Ready,
    Capturing,
    Analyzing(CapturedContext),
    Saving(KnowledgePage),
    Saved(KnowledgePage),
    Failed {
        stage: LifecycleStage,
        message: String,
    },
    Cancelled,
}

impl CaptureLifecycle {
    pub fn start(self) -> Result<Self, LifecycleError> {
        match self {
            Self::Ready => Ok(Self::Capturing),
            _ => Err(LifecycleError),
        }
    }

    pub fn captured(self, context: CapturedContext) -> Result<Self, LifecycleError> {
        match self {
            Self::Capturing => Ok(Self::Analyzing(context)),
            _ => Err(LifecycleError),
        }
    }

    pub fn analyzed(self, page: KnowledgePage) -> Result<Self, LifecycleError> {
        match self {
            Self::Analyzing(_) => Ok(Self::Saving(page)),
            _ => Err(LifecycleError),
        }
    }

    pub fn saved(self) -> Result<Self, LifecycleError> {
        match self {
            Self::Saving(page) => Ok(Self::Saved(page)),
            _ => Err(LifecycleError),
        }
    }

    pub fn fail(self, message: impl Into<String>) -> Result<Self, LifecycleError> {
        let stage = match self {
            Self::Capturing => LifecycleStage::Capture,
            Self::Analyzing(_) => LifecycleStage::Analyze,
            Self::Saving(_) => LifecycleStage::Save,
            _ => return Err(LifecycleError),
        };
        Ok(Self::Failed {
            stage,
            message: message.into(),
        })
    }

    pub fn cancel(self) -> Result<Self, LifecycleError> {
        match self {
            Self::Capturing | Self::Analyzing(_) | Self::Saving(_) => Ok(Self::Cancelled),
            _ => Err(LifecycleError),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LifecycleError;

impl fmt::Display for LifecycleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid capture lifecycle transition")
    }
}

impl Error for LifecycleError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidationError(String);

impl ValidationError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for ValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl Error for ValidationError {}

pub(crate) fn validate_text(
    name: &str,
    value: &str,
    required: bool,
) -> Result<(), ValidationError> {
    if required && value.trim().is_empty() {
        return Err(ValidationError::new(format!("{name} cannot be empty")));
    }
    if value
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(ValidationError::new(format!(
            "{name} contains a control character"
        )));
    }
    Ok(())
}

fn field(output: &mut String, name: &str, value: &str) {
    output.push_str(name);
    output.push_str(": ");
    output.push_str(&quote(value));
    output.push('\n');
}

fn optional_field(output: &mut String, name: &str, value: Option<&str>) {
    if let Some(value) = value {
        field(output, name, value)
    } else {
        output.push_str(name);
        output.push_str(": null\n");
    }
}

fn number_field(output: &mut String, name: &str, value: u64) {
    output.push_str(name);
    output.push_str(": ");
    output.push_str(&value.to_string());
    output.push('\n');
}

pub(crate) fn quote(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character => output.push(character),
        }
    }
    output.push('"');
    output
}

pub(crate) fn unquote(value: &str) -> Result<String, ValidationError> {
    let value = value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .ok_or_else(|| ValidationError::new("expected a quoted string"))?;
    let mut output = String::new();
    let mut characters = value.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            output.push(character);
            continue;
        }
        output.push(match characters.next() {
            Some('"') => '"',
            Some('\\') => '\\',
            Some('n') => '\n',
            Some('r') => '\r',
            Some('t') => '\t',
            _ => return Err(ValidationError::new("invalid string escape")),
        });
    }
    Ok(output)
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

    fn parse(mut self) -> Result<KnowledgePage, ValidationError> {
        self.exact("---")?;
        self.exact("emma-format: 1")?;
        let id = PageId::parse(self.string_field("id")?)?;
        let title = self.string_field("title")?;
        let category = self.string_field("category")?.parse()?;
        let added_at = self.string_field("added-at")?.parse()?;
        let analyzed_at = self.string_field("analyzed-at")?.parse()?;
        let model = self.string_field("model")?;
        let input_tokens = self.number_field("input-tokens")?;
        let output_tokens = self.number_field("output-tokens")?;
        let subagent_count = self
            .number_field("subagent-count")?
            .try_into()
            .map_err(|_| ValidationError::new("subagent count is too large"))?;
        let source_application = self.optional_field("source-application")?;
        let source_url = self
            .optional_field("source-url")?
            .map(SourceUrl::parse)
            .transpose()?;
        let source_thread_id = self
            .optional_field("source-thread-id")?
            .map(ThreadId::parse)
            .transpose()?;
        let cited_count: usize = self
            .number_field("cited-source-count")?
            .try_into()
            .map_err(|_| ValidationError::new("cited source count is too large"))?;
        let mut sources = Vec::with_capacity(cited_count.min(1_024));
        for index in 0..cited_count {
            let source_title = self.string_field(&format!("cited-{index}-title"))?;
            let url = SourceUrl::parse(self.string_field(&format!("cited-{index}-url"))?)?;
            sources.push(CitedSource::new(source_title, url)?);
        }
        self.exact("---")?;
        self.exact("")?;
        self.exact("## Captured context")?;
        self.exact("")?;
        let text = unquote(self.next()?)?;
        self.exact("")?;
        self.exact("## Analysis summary")?;
        self.exact("")?;
        let summary = unquote(self.next()?)?;
        self.exact("")?;
        self.exact("## Analysis")?;
        self.exact("")?;
        let body = unquote(self.next()?)?;
        if self.lines.next().is_some() {
            return Err(ValidationError::new("unexpected content after page body"));
        }
        validate_text("page title", &title, true)?;
        if analyzed_at < added_at {
            return Err(ValidationError::new("analysis cannot predate capture"));
        }
        Ok(KnowledgePage {
            id,
            title,
            category,
            context: CapturedContext::new(text, source_application, source_url)?,
            analysis: AnalysisContent::new(summary, body)?,
            sources,
            added_at,
            analyzed_at,
            telemetry: RunTelemetry::new(model, input_tokens, output_tokens, subagent_count)?,
            source_thread_id,
        })
    }

    fn next(&mut self) -> Result<&'a str, ValidationError> {
        self.lines
            .next()
            .ok_or_else(|| ValidationError::new("page ended unexpectedly"))
    }
    fn exact(&mut self, expected: &str) -> Result<(), ValidationError> {
        if self.next()? == expected {
            Ok(())
        } else {
            Err(ValidationError::new(format!("expected {expected:?}")))
        }
    }
    fn string_field(&mut self, name: &str) -> Result<String, ValidationError> {
        let line = self.next()?;
        unquote(
            line.strip_prefix(name)
                .and_then(|v| v.strip_prefix(": "))
                .ok_or_else(|| ValidationError::new(format!("expected field {name}")))?,
        )
    }
    fn optional_field(&mut self, name: &str) -> Result<Option<String>, ValidationError> {
        let line = self.next()?;
        let value = line
            .strip_prefix(name)
            .and_then(|v| v.strip_prefix(": "))
            .ok_or_else(|| ValidationError::new(format!("expected field {name}")))?;
        if value == "null" {
            Ok(None)
        } else {
            unquote(value).map(Some)
        }
    }
    fn number_field(&mut self, name: &str) -> Result<u64, ValidationError> {
        let line = self.next()?;
        line.strip_prefix(name)
            .and_then(|v| v.strip_prefix(": "))
            .ok_or_else(|| ValidationError::new(format!("expected field {name}")))?
            .parse()
            .map_err(|_| ValidationError::new(format!("field {name} is not a number")))
    }
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year as i32, month as u32, day as u32)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = i64::from(year) - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    era * 146_097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year - 719_468
}

fn days_in_month(year: i32, month: u32) -> Option<u32> {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => Some(31),
        4 | 6 | 9 | 11 => Some(30),
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => Some(29),
        2 => Some(28),
        _ => None,
    }
}
