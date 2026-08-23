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
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
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

impl Serialize for Timestamp {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_iso8601())
    }
}

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

    pub(crate) fn utc_components(self) -> (u32, u32, u32, u32, u32) {
        let days = self.0.div_euclid(86_400);
        let seconds = self.0.rem_euclid(86_400);
        let (_, month, day) = civil_from_days(days);
        let weekday = (days + 4).rem_euclid(7) as u32;
        (
            seconds as u32 / 3_600,
            seconds as u32 / 60 % 60,
            day,
            month,
            weekday,
        )
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
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

pub const DEFAULT_KNOWLEDGE_BASE_NAME: &str = "Default";
pub const MAX_KNOWLEDGE_BASE_CATEGORIES: usize = 256;
pub const MAX_CITED_SOURCES: usize = 1_024;
pub const MAX_RELEVANT_PAGES: usize = 4;
pub const MAX_ARTIFACT_BLOCKS: usize = 64;
pub const MAX_ARTIFACT_PAYLOAD_BYTES: usize = 32 * 1024;
pub const MAX_ARTIFACT_FALLBACK_BYTES: usize = 64 * 1024;
pub const MAX_ARTIFACT_DOCUMENT_BYTES: usize = 512 * 1024;
pub const MAX_PAGE_VERSIONS: usize = 50;
pub const MAX_ASSET_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct KnowledgeBaseId(String);

impl KnowledgeBaseId {
    pub fn parse(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 96
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(ValidationError::new(
                "knowledge base ID is not a safe filename",
            ));
        }
        Ok(Self(value))
    }

    pub fn default_id() -> Self {
        Self("default".into())
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
            "base-{}-{:x}-{:x}-{sequence:x}",
            now.unix_seconds(),
            std::process::id(),
            nanos
        ))
    }
}

impl Default for KnowledgeBaseId {
    fn default() -> Self {
        Self::default_id()
    }
}

impl fmt::Display for KnowledgeBaseId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBase {
    pub id: KnowledgeBaseId,
    pub name: String,
    pub created_at: Timestamp,
    pub categories: Vec<Category>,
}

impl KnowledgeBase {
    pub fn new(name: impl Into<String>, created_at: Timestamp) -> Result<Self, ValidationError> {
        let name = name.into().trim().to_owned();
        validate_text("knowledge base name", &name, true)?;
        if name.len() > 128 {
            return Err(ValidationError::new(
                "knowledge base name cannot exceed 128 bytes",
            ));
        }
        Ok(Self {
            id: KnowledgeBaseId::generate(created_at),
            name,
            created_at,
            categories: Vec::new(),
        })
    }

    pub fn default_base() -> Self {
        Self {
            id: KnowledgeBaseId::default_id(),
            name: DEFAULT_KNOWLEDGE_BASE_NAME.into(),
            created_at: Timestamp::from_unix_seconds(0),
            categories: Vec::new(),
        }
    }

    pub fn to_markdown(&self) -> String {
        let mut output = String::from("---\nemma-knowledge-base-format: 2\n");
        field(&mut output, "id", self.id.as_str());
        field(&mut output, "name", &self.name);
        field(&mut output, "created-at", &self.created_at.to_string());
        output.push_str(&format!("category-count: {}\n", self.categories.len()));
        for (index, category) in self.categories.iter().enumerate() {
            field(&mut output, &format!("category-{index}"), category.as_str());
        }
        output.push_str("---\n");
        output
    }

    pub fn from_markdown(markdown: &str) -> Result<Self, ValidationError> {
        let mut parser = Parser::new(markdown);
        parser.exact("---")?;
        let format = match parser.next()? {
            "emma-knowledge-base-format: 1" => 1,
            "emma-knowledge-base-format: 2" => 2,
            _ => return Err(ValidationError::new("unsupported knowledge base format")),
        };
        let id = KnowledgeBaseId::parse(parser.string_field("id")?)?;
        let name = parser.string_field("name")?.trim().to_owned();
        validate_text("knowledge base name", &name, true)?;
        if name.len() > 128 {
            return Err(ValidationError::new(
                "knowledge base name cannot exceed 128 bytes",
            ));
        }
        let created_at = parser.string_field("created-at")?.parse()?;
        let categories = if format == 1 {
            Vec::new()
        } else {
            let count: usize = parser
                .number_field("category-count")?
                .try_into()
                .map_err(|_| ValidationError::new("category count is too large"))?;
            if count > MAX_KNOWLEDGE_BASE_CATEGORIES {
                return Err(ValidationError::new("category count is too large"));
            }
            let mut categories = Vec::with_capacity(count);
            for index in 0..count {
                let category = Category::parse(parser.string_field(&format!("category-{index}"))?)?;
                if categories.contains(&category) {
                    return Err(ValidationError::new("categories must be unique"));
                }
                categories.push(category);
            }
            categories
        };
        parser.exact("---")?;
        if parser.lines.next().is_some() {
            return Err(ValidationError::new(
                "unexpected content after knowledge base metadata",
            ));
        }
        Ok(Self {
            id,
            name,
            created_at,
            categories,
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSource {
    pub source_thread_id: Option<String>,
    pub source_url: Option<String>,
}

impl ArtifactSource {
    pub fn new(
        source_thread_id: Option<String>,
        source_url: Option<String>,
    ) -> Result<Self, ValidationError> {
        if let Some(id) = &source_thread_id {
            ThreadId::parse(id.clone())?;
        }
        if let Some(url) = &source_url {
            SourceUrl::parse(url.clone())?;
        }
        Ok(Self {
            source_thread_id,
            source_url,
        })
    }

    fn validate(&self) -> Result<(), ValidationError> {
        Self::new(self.source_thread_id.clone(), self.source_url.clone()).map(|_| ())
    }

    pub fn from_thread(thread_id: Option<&ThreadId>) -> Self {
        Self {
            source_thread_id: thread_id.map(|id| id.as_str().to_owned()),
            source_url: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactBlock {
    pub id: String,
    #[serde(rename = "type")]
    pub block_type: String,
    pub version: u32,
    pub source: ArtifactSource,
    pub payload: Value,
    pub fallback: String,
}

impl ArtifactBlock {
    pub fn new(
        id: impl Into<String>,
        block_type: impl Into<String>,
        version: u32,
        source: ArtifactSource,
        payload: Value,
        fallback: impl Into<String>,
    ) -> Result<Self, ValidationError> {
        let block = Self {
            id: id.into(),
            block_type: block_type.into(),
            version,
            source,
            payload,
            fallback: fallback.into(),
        };
        block.validate()?;
        Ok(block)
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_artifact_identifier("artifact block ID", &self.id)?;
        validate_artifact_identifier("artifact block type", &self.block_type)?;
        if self.version == 0 {
            return Err(ValidationError::new(
                "artifact block version must be positive",
            ));
        }
        self.source.validate()?;
        if self.payload.is_null() {
            return Err(ValidationError::new(
                "artifact block payload cannot be null",
            ));
        }
        let payload = serde_json::to_vec(&self.payload)
            .map_err(|_| ValidationError::new("artifact block payload is not valid JSON"))?;
        if payload.len() > MAX_ARTIFACT_PAYLOAD_BYTES {
            return Err(ValidationError::new(format!(
                "artifact block payload cannot exceed {MAX_ARTIFACT_PAYLOAD_BYTES} bytes"
            )));
        }
        validate_text("artifact block fallback", &self.fallback, true)?;
        if self.fallback.len() > MAX_ARTIFACT_FALLBACK_BYTES {
            return Err(ValidationError::new(format!(
                "artifact block fallback cannot exceed {MAX_ARTIFACT_FALLBACK_BYTES} bytes"
            )));
        }
        Ok(())
    }
}

fn validate_artifact_identifier(name: &str, value: &str) -> Result<(), ValidationError> {
    if value.is_empty()
        || value.len() > 96
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_uppercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
    {
        return Err(ValidationError::new(format!(
            "{name} must contain only ASCII letters, numbers, '-', '_', '.', ':', or '/'"
        )));
    }
    Ok(())
}

fn validate_artifacts(artifacts: &[ArtifactBlock]) -> Result<(), ValidationError> {
    if artifacts.len() > MAX_ARTIFACT_BLOCKS {
        return Err(ValidationError::new(format!(
            "knowledge page cannot have more than {MAX_ARTIFACT_BLOCKS} artifact blocks"
        )));
    }
    let mut total = 0usize;
    for (index, block) in artifacts.iter().enumerate() {
        block.validate().map_err(|error| {
            ValidationError::new(format!("artifact block {index} is invalid: {error}"))
        })?;
        if artifacts[..index]
            .iter()
            .any(|existing| existing.id == block.id)
        {
            return Err(ValidationError::new("artifact block IDs must be unique"));
        }
        total = total
            .saturating_add(block.id.len())
            .saturating_add(block.block_type.len())
            .saturating_add(block.fallback.len())
            .saturating_add(
                serde_json::to_vec(&block.payload)
                    .map_err(|_| ValidationError::new("artifact block payload is not valid JSON"))?
                    .len(),
            );
    }
    if total > MAX_ARTIFACT_DOCUMENT_BYTES {
        return Err(ValidationError::new(format!(
            "artifact document cannot exceed {MAX_ARTIFACT_DOCUMENT_BYTES} bytes"
        )));
    }
    Ok(())
}

fn bounded_artifact_text(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn portable_fallback(value: &str) -> String {
    value
        .trim_end()
        .lines()
        .map(|line| format!("> {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn legacy_artifacts(
    analysis: &AnalysisContent,
    sources: &[CitedSource],
    source_thread_id: Option<&ThreadId>,
) -> Result<Vec<ArtifactBlock>, ValidationError> {
    let source = ArtifactSource::from_thread(source_thread_id);
    let summary = bounded_artifact_text(&analysis.summary, MAX_ARTIFACT_PAYLOAD_BYTES / 2);
    let body = bounded_artifact_text(&analysis.body, MAX_ARTIFACT_PAYLOAD_BYTES / 2);
    let mut artifacts = vec![
        ArtifactBlock::new(
            "summary",
            "rich-text",
            1,
            source.clone(),
            json!({"markdown": summary}),
            bounded_artifact_text(&analysis.summary, MAX_ARTIFACT_FALLBACK_BYTES),
        )?,
        ArtifactBlock::new(
            "body",
            "rich-text",
            1,
            source.clone(),
            json!({"markdown": body}),
            bounded_artifact_text(&analysis.body, MAX_ARTIFACT_FALLBACK_BYTES),
        )?,
    ];
    if !sources.is_empty() {
        let items = sources
            .iter()
            .map(|source| json!({"title": source.title, "url": source.url.as_str()}))
            .collect::<Vec<_>>();
        let fallback = sources
            .iter()
            .map(|source| format!("- [{}]({})", source.title, source.url))
            .collect::<Vec<_>>()
            .join("\n");
        artifacts.push(ArtifactBlock::new(
            "citations",
            "citations",
            1,
            source,
            json!({"items": items}),
            bounded_artifact_text(&fallback, MAX_ARTIFACT_FALLBACK_BYTES),
        )?);
    }
    validate_artifacts(&artifacts)?;
    Ok(artifacts)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgePage {
    pub id: PageId,
    pub knowledge_base_id: KnowledgeBaseId,
    pub title: String,
    pub category: Category,
    pub context: CapturedContext,
    pub analysis: AnalysisContent,
    pub sources: Vec<CitedSource>,
    pub added_at: Timestamp,
    pub analyzed_at: Timestamp,
    pub telemetry: RunTelemetry,
    pub source_thread_id: Option<ThreadId>,
    /// Durable thread holding the conversation the user has *about* this
    /// document, distinct from `source_thread_id`, which is where it came from.
    pub conversation_thread_id: Option<ThreadId>,
    pub artifacts: Vec<ArtifactBlock>,
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
        if sources.len() > MAX_CITED_SOURCES {
            return Err(ValidationError::new(format!(
                "knowledge page cannot have more than {MAX_CITED_SOURCES} cited sources"
            )));
        }
        if analyzed_at < added_at {
            return Err(ValidationError::new("analysis cannot predate capture"));
        }
        let mut page = Self {
            id: PageId::generate(added_at),
            knowledge_base_id: KnowledgeBaseId::default_id(),
            title,
            category,
            context,
            analysis,
            sources,
            added_at,
            analyzed_at,
            telemetry,
            source_thread_id: None,
            conversation_thread_id: None,
            artifacts: Vec::new(),
        };
        page.artifacts = legacy_artifacts(&page.analysis, &page.sources, None)?;
        Ok(page)
    }

    pub fn with_conversation_thread(mut self, thread_id: ThreadId) -> Self {
        self.conversation_thread_id = Some(thread_id);
        self
    }

    pub fn with_source_thread(mut self, thread_id: ThreadId) -> Self {
        self.source_thread_id = Some(thread_id.clone());
        for block in &mut self.artifacts {
            if block.source.source_thread_id.is_none() {
                block.source.source_thread_id = Some(thread_id.as_str().to_owned());
            }
        }
        self
    }

    pub fn in_knowledge_base(mut self, knowledge_base_id: KnowledgeBaseId) -> Self {
        self.knowledge_base_id = knowledge_base_id;
        self
    }

    pub fn with_artifacts(
        mut self,
        artifacts: Vec<ArtifactBlock>,
    ) -> Result<Self, ValidationError> {
        self.replace_artifacts(artifacts)?;
        Ok(self)
    }

    pub fn replace_artifacts(
        &mut self,
        artifacts: Vec<ArtifactBlock>,
    ) -> Result<(), ValidationError> {
        validate_artifacts(&artifacts)?;
        self.artifacts = artifacts;
        Ok(())
    }

    pub fn validate_artifacts(&self) -> Result<(), ValidationError> {
        validate_artifacts(&self.artifacts)
    }

    pub fn to_markdown(&self) -> String {
        let mut output = String::from("---\nemma-format: 4\n");
        field(&mut output, "id", self.id.as_str());
        field(&mut output, "title", &self.title);
        field(&mut output, "category", self.category.as_str());
        field(
            &mut output,
            "knowledge-base-id",
            self.knowledge_base_id.as_str(),
        );
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
        optional_field(
            &mut output,
            "conversation-thread-id",
            self.conversation_thread_id.as_ref().map(ThreadId::as_str),
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
        number_field(&mut output, "artifact-count", self.artifacts.len() as u64);
        for (index, block) in self.artifacts.iter().enumerate() {
            field(&mut output, &format!("artifact-{index}-id"), &block.id);
            field(
                &mut output,
                &format!("artifact-{index}-type"),
                &block.block_type,
            );
            number_field(
                &mut output,
                &format!("artifact-{index}-version"),
                u64::from(block.version),
            );
            optional_field(
                &mut output,
                &format!("artifact-{index}-source-thread-id"),
                block.source.source_thread_id.as_deref(),
            );
            optional_field(
                &mut output,
                &format!("artifact-{index}-source-url"),
                block.source.source_url.as_deref(),
            );
            let payload = serde_json::to_string(&block.payload).unwrap_or_else(|_| "null".into());
            field(&mut output, &format!("artifact-{index}-payload"), &payload);
            field(
                &mut output,
                &format!("artifact-{index}-fallback"),
                &block.fallback,
            );
        }
        output.push_str("---\n\n## Captured context\n\n");
        output.push_str(&quote(&self.context.text));
        output.push_str("\n\n## Analysis summary\n\n");
        output.push_str(&quote(&self.analysis.summary));
        output.push_str("\n\n## Analysis\n\n");
        output.push_str(&quote(&self.analysis.body));
        output.push_str("\n\n## Artifact document\n\n");
        for block in &self.artifacts {
            output.push_str("### ");
            output.push_str(&block.id);
            output.push_str("\n\n");
            output.push_str(&portable_fallback(&block.fallback));
            output.push_str("\n\n");
        }
        output
    }

    pub fn from_markdown(markdown: &str) -> Result<Self, ValidationError> {
        Parser::new(markdown).parse()
    }
}

#[derive(Debug)]
pub struct KnowledgeStore {
    root: PathBuf,
    export: Option<PathBuf>,
}

impl KnowledgeStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root, export: None }
    }

    /// Mirror every saved page into `export` as ordinary Markdown, so the
    /// knowledge base is readable by the user and by any other agent on this
    /// Mac without knowing Emma's storage format.
    pub fn with_export(mut self, export: PathBuf) -> Self {
        self.export = Some(export);
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn save(&self, page: &KnowledgePage) -> Result<PathBuf, StoreError> {
        if page.sources.len() > MAX_CITED_SOURCES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("knowledge page cannot have more than {MAX_CITED_SOURCES} cited sources"),
            )
            .into());
        }
        page.validate_artifacts()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
        fs::create_dir_all(&self.root)?;
        let destination = self.path_for(&page.id);
        let temporary = self.root.join(format!(".{}.tmp", page.id));
        atomic_write(&temporary, &destination, page.to_markdown().as_bytes())?;
        // The mirror is derived and never read back, so a folder Emma may not
        // write to (macOS asks before ~/Documents) costs the copy, not the save.
        if let Err(error) = self.export_plain(page) {
            eprintln!(
                "emma: could not export page {} as Markdown: {error}",
                page.id
            );
        }
        Ok(destination)
    }

    fn export_plain(&self, page: &KnowledgePage) -> io::Result<()> {
        let Some(root) = &self.export else {
            return Ok(());
        };
        fs::create_dir_all(root)?;
        // The name carries the title, so retitling a page renames its file:
        // the ID suffix is what identifies the older copy to clear away.
        let suffix = format!("--{}.md", page.id);
        let name = format!("{}{suffix}", slug(&page.title));
        for entry in fs::read_dir(root)? {
            let path = entry?.path();
            let stale = path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|existing| existing.ends_with(&suffix) && existing != name);
            if stale {
                fs::remove_file(path)?;
            }
        }
        atomic_write(
            &root.join(format!(".{name}.tmp")),
            &root.join(&name),
            plain_markdown(page).as_bytes(),
        )
    }

    /// Snapshots whatever is on disk, then writes `page`. Every durable edit
    /// routes through here so the document the user replaced stays recoverable.
    pub fn save_versioned(&self, page: &KnowledgePage) -> Result<PathBuf, StoreError> {
        self.snapshot_version(&page.id)?;
        self.save(page)
    }

    fn snapshot_version(&self, id: &PageId) -> Result<(), StoreError> {
        let current = match fs::read(self.path_for(id)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(StoreError::Io(error)),
        };
        let root = self.version_root(id);
        fs::create_dir_all(&root)?;
        let name = version_name();
        atomic_write(
            &root.join(format!(".{name}.tmp")),
            &root.join(format!("{name}.md")),
            &current,
        )?;
        self.prune_versions(id)
    }

    fn prune_versions(&self, id: &PageId) -> Result<(), StoreError> {
        let mut names = self.version_names(id)?;
        if names.len() <= MAX_PAGE_VERSIONS {
            return Ok(());
        }
        names.sort();
        let root = self.version_root(id);
        for name in &names[..names.len() - MAX_PAGE_VERSIONS] {
            fs::remove_file(root.join(format!("{name}.md")))?;
        }
        Ok(())
    }

    fn version_names(&self, id: &PageId) -> Result<Vec<String>, StoreError> {
        let entries = match fs::read_dir(self.version_root(id)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(StoreError::Io(error)),
        };
        let mut names = Vec::new();
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("md") {
                continue;
            }
            if let Some(name) = path
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|name| parse_version_name(name).is_some())
            {
                names.push(name.to_owned());
            }
        }
        Ok(names)
    }

    /// Newest first. Each entry is a complete page, so a restore is a plain load.
    pub fn list_versions(&self, id: &PageId) -> Result<Vec<PageVersion>, StoreError> {
        let mut names = self.version_names(id)?;
        names.sort_by(|left, right| right.cmp(left));
        // ponytail: parses every version to show its title; 50 small local files.
        let mut versions = Vec::with_capacity(names.len());
        for name in names {
            let Some(saved_at) = parse_version_name(&name) else {
                continue;
            };
            let title = self
                .load_version(id, &name)
                .map_or_else(|_| "Unreadable version".to_owned(), |page| page.title);
            versions.push(PageVersion {
                name,
                saved_at,
                title,
            });
        }
        Ok(versions)
    }

    pub fn load_version(&self, id: &PageId, name: &str) -> Result<KnowledgePage, StoreError> {
        if parse_version_name(name).is_none() {
            return Err(
                io::Error::new(io::ErrorKind::InvalidInput, "version name is invalid").into(),
            );
        }
        let path = self.version_root(id).join(format!("{name}.md"));
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
                reason: "version page ID does not match its page".into(),
            }));
        }
        Ok(page)
    }

    /// Binary attachments live beside the Markdown so a page stays small and
    /// stays plain text. Returns the generated file name.
    pub fn save_asset(
        &self,
        page_id: &PageId,
        extension: &str,
        bytes: &[u8],
    ) -> Result<String, StoreError> {
        if bytes.is_empty() || bytes.len() > MAX_ASSET_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("asset must be between 1 and {MAX_ASSET_BYTES} bytes"),
            )
            .into());
        }
        if extension.is_empty()
            || extension.len() > 8
            || !extension.bytes().all(|byte| byte.is_ascii_lowercase())
        {
            return Err(
                io::Error::new(io::ErrorKind::InvalidInput, "asset extension is invalid").into(),
            );
        }
        let root = self.asset_root();
        fs::create_dir_all(&root)?;
        let name = format!("{page_id}-{}.{extension}", version_name());
        atomic_write(&root.join(format!(".{name}.tmp")), &root.join(&name), bytes)?;
        Ok(name)
    }

    pub fn load_asset(&self, name: &str) -> Result<Vec<u8>, StoreError> {
        if !valid_asset_name(name) {
            return Err(
                io::Error::new(io::ErrorKind::InvalidInput, "asset name is invalid").into(),
            );
        }
        let bytes = fs::read(self.asset_root().join(name))?;
        if bytes.len() > MAX_ASSET_BYTES {
            return Err(
                io::Error::new(io::ErrorKind::InvalidData, "asset is too large to read").into(),
            );
        }
        Ok(bytes)
    }

    pub fn save_base(&self, base: &KnowledgeBase) -> Result<PathBuf, StoreError> {
        if base.categories.len() > MAX_KNOWLEDGE_BASE_CATEGORIES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "knowledge base cannot have more than {MAX_KNOWLEDGE_BASE_CATEGORIES} categories"
                ),
            )
            .into());
        }
        let root = self.base_root();
        fs::create_dir_all(&root)?;
        let destination = root.join(format!("{}.md", base.id));
        let temporary = root.join(format!(".{}.tmp", base.id));
        atomic_write(&temporary, &destination, base.to_markdown().as_bytes())?;
        Ok(destination)
    }

    pub fn load_base(&self, id: &KnowledgeBaseId) -> Result<KnowledgeBase, StoreError> {
        let path = self.base_root().join(format!("{id}.md"));
        let markdown = match fs::read_to_string(&path) {
            Ok(markdown) => markdown,
            Err(error)
                if id == &KnowledgeBaseId::default_id()
                    && error.kind() == io::ErrorKind::NotFound =>
            {
                return Ok(KnowledgeBase::default_base());
            }
            Err(error) => return Err(StoreError::Io(error)),
        };
        let base = KnowledgeBase::from_markdown(&markdown).map_err(|error| {
            StoreError::Malformed(MalformedPage {
                path: path.clone(),
                reason: error.to_string(),
            })
        })?;
        if &base.id != id {
            return Err(StoreError::Malformed(MalformedPage {
                path,
                reason: "knowledge base ID does not match filename".into(),
            }));
        }
        Ok(base)
    }

    pub fn list_bases(&self) -> Result<KnowledgeBaseListing, StoreError> {
        let mut listing = KnowledgeBaseListing {
            bases: vec![self.load_base(&KnowledgeBaseId::default_id())?],
            malformed: Vec::new(),
        };
        let root = self.base_root();
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(listing),
            Err(error) => return Err(StoreError::Io(error)),
        };
        for entry in entries {
            let path = entry?.path();
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
            let id = match KnowledgeBaseId::parse(stem) {
                Ok(id) if id != KnowledgeBaseId::default_id() => id,
                Ok(_) => continue,
                Err(error) => {
                    listing.malformed.push(MalformedPage {
                        path,
                        reason: error.to_string(),
                    });
                    continue;
                }
            };
            match self.load_base(&id) {
                Ok(base) => listing.bases.push(base),
                Err(StoreError::Malformed(base)) => listing.malformed.push(base),
                Err(StoreError::Io(error)) => return Err(StoreError::Io(error)),
            }
        }
        listing.bases[1..].sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.id.cmp(&right.id))
        });
        listing
            .malformed
            .sort_by(|left, right| left.path.cmp(&right.path));
        Ok(listing)
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

    pub fn relevant_pages(
        &self,
        base_id: &KnowledgeBaseId,
        query: &str,
        limit: usize,
    ) -> Result<Vec<KnowledgePage>, StoreError> {
        // ponytail: This deterministic O(n) scan is enough for local Markdown;
        // add an index only when real base sizes make the measured latency matter.
        let mut scored = self
            .list()?
            .pages
            .into_iter()
            .filter(|page| &page.knowledge_base_id == base_id)
            .filter_map(|page| {
                let score = lexical_score(query, &page);
                (score != 0).then_some((score, page))
            })
            .collect::<Vec<_>>();
        scored.sort_by(|(left_score, left), (right_score, right)| {
            right_score
                .cmp(left_score)
                .then_with(|| right.analyzed_at.cmp(&left.analyzed_at))
                .then_with(|| right.id.cmp(&left.id))
        });
        Ok(scored
            .into_iter()
            .take(limit.min(MAX_RELEVANT_PAGES))
            .map(|(_, page)| page)
            .collect())
    }

    fn path_for(&self, id: &PageId) -> PathBuf {
        self.root.join(format!("{id}.md"))
    }

    fn base_root(&self) -> PathBuf {
        self.root.join("bases")
    }

    fn version_root(&self, id: &PageId) -> PathBuf {
        self.root.join("versions").join(id.as_str())
    }

    fn asset_root(&self) -> PathBuf {
        self.root.join("assets")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageVersion {
    pub name: String,
    pub saved_at: Timestamp,
    pub title: String,
}

/// The page as a file anyone can read: YAML front matter every tool already
/// understands, then the document Emma built, in its portable form.
pub fn plain_markdown(page: &KnowledgePage) -> String {
    let mut output = String::from("---\n");
    field(&mut output, "title", &page.title);
    field(&mut output, "category", page.category.as_str());
    optional_field(
        &mut output,
        "source",
        page.context.source_url.as_ref().map(SourceUrl::as_str),
    );
    optional_field(
        &mut output,
        "application",
        page.context.source_application.as_deref(),
    );
    field(&mut output, "saved", &page.added_at.to_string());
    field(&mut output, "emma-page", page.id.as_str());
    output.push_str("---\n\n# ");
    output.push_str(&page.title);
    output.push_str("\n\n");
    if page.artifacts.is_empty() {
        output.push_str(page.analysis.body.trim_end());
        output.push('\n');
        return output;
    }
    for block in &page.artifacts {
        output.push_str(block.fallback.trim_end());
        output.push_str("\n\n");
    }
    output
}

/// A readable filename from a title. Non-ASCII titles fall back to `page`,
/// which the ID suffix still makes unique.
fn slug(title: &str) -> String {
    let mut slug = String::new();
    for character in title.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= 60 {
            break;
        }
    }
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "page".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// `{unix seconds}-{nanos}` in fixed width, so a lexical sort is chronological.
fn version_name() -> String {
    let now = SystemTime::now();
    let nanos = now
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.subsec_nanos());
    format!(
        "{:010}-{nanos:09}",
        Timestamp::from(now).unix_seconds().max(0)
    )
}

fn parse_version_name(name: &str) -> Option<Timestamp> {
    let (seconds, nanos) = name.split_once('-')?;
    if seconds.len() != 10 || nanos.len() != 9 || !nanos.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    seconds.parse().ok().map(Timestamp::from_unix_seconds)
}

fn valid_asset_name(name: &str) -> bool {
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && name.len() <= 128
        && !extension.is_empty()
        && extension.len() <= 8
        && extension.bytes().all(|byte| byte.is_ascii_lowercase())
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn atomic_write(temporary: &Path, destination: &Path, contents: &[u8]) -> io::Result<()> {
    match fs::remove_file(temporary) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        fs::rename(temporary, destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn lexical_score(query: &str, page: &KnowledgePage) -> usize {
    let mut terms = query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| term.chars().count() >= 3)
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    terms.sort_unstable();
    terms.dedup();
    let title = page.title.to_lowercase();
    let summary = page.analysis.summary.to_lowercase();
    let body = page.analysis.body.to_lowercase();
    terms
        .into_iter()
        .map(|term| {
            usize::from(title.contains(&term)) * 4
                + usize::from(summary.contains(&term)) * 2
                + usize::from(body.contains(&term))
        })
        .sum()
}

#[derive(Debug, Default)]
pub struct StoreListing {
    pub pages: Vec<KnowledgePage>,
    pub malformed: Vec<MalformedPage>,
}

#[derive(Debug, Default)]
pub struct KnowledgeBaseListing {
    pub bases: Vec<KnowledgeBase>,
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
        let format = match self.next()? {
            "emma-format: 1" => 1,
            "emma-format: 2" => 2,
            "emma-format: 3" => 3,
            "emma-format: 4" => 4,
            _ => return Err(ValidationError::new("unsupported knowledge page format")),
        };
        let legacy = format == 1;
        let id = PageId::parse(self.string_field("id")?)?;
        let title = self.string_field("title")?;
        let category = self.string_field("category")?.parse()?;
        let knowledge_base_id = if legacy {
            KnowledgeBaseId::default_id()
        } else {
            KnowledgeBaseId::parse(self.string_field("knowledge-base-id")?)?
        };
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
        let conversation_thread_id = if format >= 4 {
            self.optional_field("conversation-thread-id")?
                .map(ThreadId::parse)
                .transpose()?
        } else {
            None
        };
        let cited_count: usize = self
            .number_field("cited-source-count")?
            .try_into()
            .map_err(|_| ValidationError::new("cited source count is too large"))?;
        if cited_count > MAX_CITED_SOURCES {
            return Err(ValidationError::new("cited source count is too large"));
        }
        let mut sources = Vec::with_capacity(cited_count);
        for index in 0..cited_count {
            let source_title = self.string_field(&format!("cited-{index}-title"))?;
            let url = SourceUrl::parse(self.string_field(&format!("cited-{index}-url"))?)?;
            sources.push(CitedSource::new(source_title, url)?);
        }
        let artifacts = if format >= 3 {
            let count: usize = self
                .number_field("artifact-count")?
                .try_into()
                .map_err(|_| ValidationError::new("artifact count is too large"))?;
            if count > MAX_ARTIFACT_BLOCKS {
                return Err(ValidationError::new("artifact count is too large"));
            }
            let mut artifacts = Vec::with_capacity(count);
            for index in 0..count {
                let id = self.string_field(&format!("artifact-{index}-id"))?;
                let block_type = self.string_field(&format!("artifact-{index}-type"))?;
                let version = self
                    .number_field(&format!("artifact-{index}-version"))?
                    .try_into()
                    .map_err(|_| ValidationError::new("artifact block version is too large"))?;
                let source_thread_id =
                    self.optional_field(&format!("artifact-{index}-source-thread-id"))?;
                let source_url = self.optional_field(&format!("artifact-{index}-source-url"))?;
                let payload = serde_json::from_str::<Value>(
                    &self.string_field(&format!("artifact-{index}-payload"))?,
                )
                .map_err(|_| ValidationError::new("artifact block payload is not valid JSON"))?;
                let fallback = self.string_field(&format!("artifact-{index}-fallback"))?;
                artifacts.push(ArtifactBlock::new(
                    id,
                    block_type,
                    version,
                    ArtifactSource::new(source_thread_id, source_url)?,
                    payload,
                    fallback,
                )?);
            }
            validate_artifacts(&artifacts)?;
            artifacts
        } else {
            Vec::new()
        };
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
        if format < 3 && self.lines.next().is_some() {
            return Err(ValidationError::new("unexpected content after page body"));
        }
        validate_text("page title", &title, true)?;
        if analyzed_at < added_at {
            return Err(ValidationError::new("analysis cannot predate capture"));
        }
        let context = CapturedContext::new(text, source_application, source_url)?;
        let analysis = AnalysisContent::new(summary, body)?;
        let artifacts = if format >= 3 {
            artifacts
        } else {
            legacy_artifacts(&analysis, &sources, source_thread_id.as_ref())?
        };
        Ok(KnowledgePage {
            id,
            knowledge_base_id,
            title,
            category,
            context,
            analysis,
            sources,
            added_at,
            analyzed_at,
            telemetry: RunTelemetry::new(model, input_tokens, output_tokens, subagent_count)?,
            source_thread_id,
            conversation_thread_id,
            artifacts,
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
