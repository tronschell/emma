use std::{
    error::Error,
    fmt,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{ThreadId, Timestamp, ValidationError, quote, unquote, validate_text};
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct ScheduledJobId(String);

impl ScheduledJobId {
    pub fn parse(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.len() < 16
            || value.len() > 96
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(ValidationError::new(
                "scheduled job ID is not a safe filename",
            ));
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
            "job-{}-{:x}-{:x}-{sequence:x}",
            now.unix_seconds(),
            std::process::id(),
            nanos
        ))
    }
}

impl fmt::Display for ScheduledJobId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledJob {
    pub id: ScheduledJobId,
    pub title: String,
    pub schedule: String,
    pub prompt: String,
    pub nodes: String,
    pub outputs: String,
    pub source_domains: Vec<String>,
    pub enabled: bool,
    pub created_at: Timestamp,
    pub next_run_at: Option<Timestamp>,
    pub last_run_at: Option<Timestamp>,
    pub last_thread_id: Option<String>,
    pub permission_mode: String,
    pub model: String,
}

pub const MAX_SCHEDULED_SOURCE_DOMAINS: usize = 32;
pub const PERMISSION_MODES: [&str; 3] = ["ask", "acceptEdits", "full"];
pub const MAX_SCHEDULED_MODEL_LEN: usize = 128;
pub const MAX_WORKFLOW_NODE_BYTES: usize = 32 * 1024;
pub const MAX_WORKFLOW_OUTPUT_BYTES: usize = 16 * 1024;
pub const MAX_TRIGGER_DEPTH: u32 = 3;

pub fn stored_permission_mode(stored: String) -> String {
    match stored.as_str() {
        "plan" => "ask".to_string(),
        _ => stored,
    }
}

impl ScheduledJob {
    pub fn new(
        title: String,
        schedule: String,
        prompt: String,
        nodes: String,
        source_domains: Vec<String>,
        permission_mode: String,
        created_at: Timestamp,
    ) -> Result<Self, ValidationError> {
        let mut job = Self::from_fields(
            title,
            schedule,
            prompt,
            nodes,
            source_domains,
            permission_mode,
            created_at,
        )?;
        job.book_next_run(created_at)?;
        Ok(job)
    }

    pub(crate) fn from_fields(
        title: String,
        schedule: String,
        prompt: String,
        nodes: String,
        source_domains: Vec<String>,
        permission_mode: String,
        created_at: Timestamp,
    ) -> Result<Self, ValidationError> {
        if !PERMISSION_MODES.contains(&permission_mode.as_str()) {
            return Err(ValidationError::new(
                "scheduled job permission mode is invalid",
            ));
        }
        validate_text("scheduled job title", &title, true)?;
        validate_text("scheduled job prompt", &prompt, true)?;
        validate_text("scheduled job nodes", &nodes, false)?;
        if title.len() > 128 || prompt.len() > 8 * 1024 {
            return Err(ValidationError::new("scheduled job text is too long"));
        }
        if nodes.len() > MAX_WORKFLOW_NODE_BYTES {
            return Err(ValidationError::new("scheduled job graph is too large"));
        }
        validate_schedule(&schedule)?;
        if source_domains.len() > MAX_SCHEDULED_SOURCE_DOMAINS {
            return Err(ValidationError::new(format!(
                "scheduled job cannot have more than {MAX_SCHEDULED_SOURCE_DOMAINS} source domains"
            )));
        }
        let mut domains = Vec::new();
        for domain in source_domains {
            let domain = domain.trim().to_ascii_lowercase();
            if domain.is_empty()
                || domain.len() > 253
                || !domain.bytes().all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'.' | b'-')
                })
            {
                return Err(ValidationError::new(
                    "scheduled job source domain is invalid",
                ));
            }
            if !domains.contains(&domain) {
                domains.push(domain);
            }
        }
        Ok(Self {
            id: ScheduledJobId::generate(created_at),
            title,
            schedule,
            prompt,
            nodes,
            outputs: String::new(),
            source_domains: domains,
            enabled: true,
            created_at,
            next_run_at: None,
            last_run_at: None,
            last_thread_id: None,
            permission_mode,
            model: String::new(),
        })
    }

    pub fn claim_run(&mut self, now: Timestamp) -> Result<bool, ValidationError> {
        let Some(due) = self.next_run_at else {
            return Ok(false);
        };
        if !self.enabled || now < due {
            return Ok(false);
        }
        self.last_run_at = Some(now);
        self.book_next_run(now)?;
        Ok(true)
    }

    pub(crate) fn book_next_run(&mut self, now: Timestamp) -> Result<(), ValidationError> {
        self.next_run_at = cron_expression(&self.schedule)
            .map(|cron| next_run(cron, now))
            .transpose()?;
        Ok(())
    }

    pub fn start_run(&mut self, now: Timestamp) {
        self.last_run_at = Some(now);
    }

    pub fn set_model(&mut self, model: String) -> Result<(), ValidationError> {
        validate_text("scheduled job model", &model, false)?;
        if model.len() > MAX_SCHEDULED_MODEL_LEN {
            return Err(ValidationError::new("scheduled job model is too long"));
        }
        self.model = model;
        Ok(())
    }

    pub fn set_outputs(&mut self, outputs: String) -> Result<(), ValidationError> {
        validate_text("scheduled job outputs", &outputs, false)?;
        if outputs.len() > MAX_WORKFLOW_OUTPUT_BYTES {
            return Err(ValidationError::new("scheduled job outputs are too large"));
        }
        self.outputs = outputs;
        Ok(())
    }

    pub fn to_markdown(&self) -> String {
        let mut output = String::from("---\nemma-scheduled-job-format: 4\n");
        field(&mut output, "id", self.id.as_str());
        field(&mut output, "title", &self.title);
        field(&mut output, "schedule", &self.schedule);
        field(&mut output, "prompt", &self.prompt);
        field(&mut output, "nodes", &self.nodes);
        field(&mut output, "outputs", &self.outputs);
        field(&mut output, "created-at", &self.created_at.to_string());
        field(
            &mut output,
            "next-run-at",
            &self
                .next_run_at
                .map_or_else(String::new, |value| value.to_string()),
        );
        field(
            &mut output,
            "last-run-at",
            &self
                .last_run_at
                .map_or_else(String::new, |value| value.to_string()),
        );
        field(
            &mut output,
            "last-thread-id",
            self.last_thread_id.as_deref().unwrap_or(""),
        );
        field(&mut output, "permission-mode", &self.permission_mode);
        field(&mut output, "model", &self.model);
        output.push_str(&format!("enabled: {}\n", self.enabled));
        output.push_str(&format!(
            "source-domain-count: {}\n",
            self.source_domains.len()
        ));
        for (index, domain) in self.source_domains.iter().enumerate() {
            field(&mut output, &format!("source-domain-{index}"), domain);
        }
        output.push_str("---\n");
        output
    }

    pub fn from_markdown(markdown: &str) -> Result<Self, ValidationError> {
        let mut lines = markdown.lines();
        exact(&mut lines, "---")?;
        let format = match prefixed(&mut lines, "emma-scheduled-job-format: ")? {
            "1" => 1,
            "2" => 2,
            "3" => 3,
            "4" => 4,
            _ => {
                return Err(ValidationError::new(
                    "scheduled job format is not supported",
                ));
            }
        };
        let id = ScheduledJobId::parse(field_value(&mut lines, "id")?)?;
        let title = field_value(&mut lines, "title")?;
        let schedule = field_value(&mut lines, "schedule")?;
        let prompt = field_value(&mut lines, "prompt")?;
        let (nodes, outputs) = if format >= 3 {
            (
                field_value(&mut lines, "nodes")?,
                field_value(&mut lines, "outputs")?,
            )
        } else {
            (String::new(), String::new())
        };
        let created_at = field_value(&mut lines, "created-at")?.parse()?;
        let next_run_at = match field_value(&mut lines, "next-run-at")? {
            value if value.is_empty() => None,
            value => Some(value.parse()?),
        };
        let last_run_at = match field_value(&mut lines, "last-run-at")? {
            value if value.is_empty() => None,
            value => Some(value.parse()?),
        };
        let last_thread_id = match field_value(&mut lines, "last-thread-id")? {
            value if value.is_empty() => None,
            value => Some(ThreadId::parse(value)?.to_string()),
        };
        let permission_mode = if format >= 2 {
            stored_permission_mode(field_value(&mut lines, "permission-mode")?)
        } else {
            "ask".to_string()
        };
        let model = if format >= 4 {
            field_value(&mut lines, "model")?
        } else {
            String::new()
        };
        let enabled = match prefixed(&mut lines, "enabled: ")? {
            "true" => true,
            "false" => false,
            _ => {
                return Err(ValidationError::new(
                    "scheduled job enabled state is invalid",
                ));
            }
        };
        let count: usize = prefixed(&mut lines, "source-domain-count: ")?
            .parse()
            .map_err(|_| ValidationError::new("scheduled job source count is invalid"))?;
        if count > MAX_SCHEDULED_SOURCE_DOMAINS {
            return Err(ValidationError::new(
                "scheduled job source count is too large",
            ));
        }
        let mut domains = Vec::with_capacity(count);
        for index in 0..count {
            domains.push(field_value(&mut lines, &format!("source-domain-{index}"))?);
        }
        exact(&mut lines, "---")?;
        if lines.next().is_some() {
            return Err(ValidationError::new("scheduled job has trailing content"));
        }
        let mut job = Self::from_fields(
            title,
            schedule,
            prompt,
            nodes,
            domains,
            permission_mode,
            created_at,
        )?;
        if last_run_at.is_some_and(|last| last < created_at)
            || next_run_at.is_some() != cron_expression(&job.schedule).is_some()
        {
            return Err(ValidationError::new(
                "scheduled job run timestamps are invalid",
            ));
        }
        job.set_outputs(outputs)?;
        job.set_model(model)?;
        job.id = id;
        job.enabled = enabled;
        job.next_run_at = next_run_at;
        job.last_run_at = last_run_at;
        job.last_thread_id = last_thread_id;
        Ok(job)
    }
}

fn cron_expression(schedule: &str) -> Option<&str> {
    (schedule.split_ascii_whitespace().count() == 5).then_some(schedule)
}

fn validate_schedule(value: &str) -> Result<(), ValidationError> {
    if value.len() > 128 {
        return Err(ValidationError::new("trigger is too long"));
    }
    if value == "manual" {
        return Ok(());
    }
    if let Some(job) = value.strip_prefix("after ") {
        ScheduledJobId::parse(job.trim())?;
        return Ok(());
    }
    if let Some(event) = value.strip_prefix("on ") {
        let event = event.trim();
        if event.is_empty()
            || event.len() > 64
            || !event
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(ValidationError::new("trigger event name is invalid"));
        }
        return Ok(());
    }
    let fields = value.split_ascii_whitespace().collect::<Vec<_>>();
    if fields.len() != 5 {
        return Err(ValidationError::new(
            "trigger must be a five-field cron expression, \"manual\", \"after <job-id>\", or \"on <event>\"",
        ));
    }
    for (field, min, max) in [
        (fields[0], 0, 59),
        (fields[1], 0, 23),
        (fields[2], 1, 31),
        (fields[3], 1, 12),
        (fields[4], 0, 7),
    ] {
        if field
            .split(',')
            .any(|part| !(min..=max).any(|value| field_matches(part, value, min, max)))
        {
            return Err(ValidationError::new(
                "schedule contains an invalid cron field",
            ));
        }
    }
    Ok(())
}

fn next_run(schedule: &str, after: Timestamp) -> Result<Timestamp, ValidationError> {
    let start = after.unix_seconds().div_euclid(60) * 60 + 60;
    for minute in 0..527_040 {
        let candidate = Timestamp::from_unix_seconds(start + minute * 60);
        if schedule_matches(schedule, candidate) {
            return Ok(candidate);
        }
    }
    Err(ValidationError::new(
        "schedule has no occurrence in the next year",
    ))
}

fn schedule_matches(schedule: &str, timestamp: Timestamp) -> bool {
    let fields = schedule.split_ascii_whitespace().collect::<Vec<_>>();
    if fields.len() != 5 {
        return false;
    }
    let (hour, minute, day, month, weekday) = timestamp.utc_components();
    field_matches(fields[0], minute, 0, 59)
        && field_matches(fields[1], hour, 0, 23)
        && field_matches(fields[2], day, 1, 31)
        && field_matches(fields[3], month, 1, 12)
        && (field_matches(fields[4], weekday, 0, 7)
            || (weekday == 0 && field_matches(fields[4], 7, 0, 7)))
}

fn field_matches(field: &str, value: u32, min: u32, max: u32) -> bool {
    field.split(',').any(|part| {
        let (range, step) = part.split_once('/').map_or((part, 1), |(range, step)| {
            (range, step.parse::<u32>().unwrap_or(0))
        });
        if step == 0 {
            return false;
        }
        let bounds = if range == "*" {
            Some((min, max))
        } else if let Some((start, end)) = range.split_once('-') {
            start.parse().ok().zip(end.parse().ok())
        } else {
            range.parse().ok().map(|exact| (exact, exact))
        };
        let Some((start, end)) = bounds else {
            return false;
        };
        (min..=max).contains(&start)
            && (min..=max).contains(&end)
            && start <= value
            && value <= end
            && (value - start).is_multiple_of(step)
    })
}

#[derive(Debug)]
pub struct ScheduledJobStore {
    root: PathBuf,
}

impl ScheduledJobStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn save(&self, job: &ScheduledJob) -> Result<(), ScheduledJobStoreError> {
        if job.source_domains.len() > MAX_SCHEDULED_SOURCE_DOMAINS {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "scheduled job cannot have more than {MAX_SCHEDULED_SOURCE_DOMAINS} source domains"
                ),
            )
            .into());
        }
        fs::create_dir_all(&self.root)?;
        let destination = self.path_for(&job.id);
        let temporary = self.root.join(format!(".{}.tmp", job.id));
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
            file.write_all(job.to_markdown().as_bytes())?;
            file.sync_all()?;
            fs::rename(&temporary, &destination)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map_err(ScheduledJobStoreError::Io)
    }

    pub fn load(&self, id: &ScheduledJobId) -> Result<ScheduledJob, ScheduledJobStoreError> {
        let path = self.path_for(id);
        let job = ScheduledJob::from_markdown(&fs::read_to_string(&path)?)
            .map_err(|error| ScheduledJobStoreError::Malformed(path.clone(), error.to_string()))?;
        if &job.id != id {
            return Err(ScheduledJobStoreError::Malformed(
                path,
                "job ID does not match filename".into(),
            ));
        }
        Ok(job)
    }

    pub fn find(
        &self,
        id: &ScheduledJobId,
    ) -> Result<Option<ScheduledJob>, ScheduledJobStoreError> {
        match self.load(id) {
            Ok(job) => Ok(Some(job)),
            Err(ScheduledJobStoreError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    pub fn delete(&self, id: &ScheduledJobId) -> Result<(), ScheduledJobStoreError> {
        match fs::remove_file(self.path_for(id)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub fn list(&self) -> Result<ScheduledJobListing, ScheduledJobStoreError> {
        let mut listing = ScheduledJobListing::default();
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(listing),
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                listing
                    .malformed
                    .push((path, "filename is not UTF-8".into()));
                continue;
            };
            let id = match ScheduledJobId::parse(stem) {
                Ok(id) => id,
                Err(error) => {
                    listing.malformed.push((path, error.to_string()));
                    continue;
                }
            };
            match self.load(&id) {
                Ok(job) => listing.jobs.push(job),
                Err(ScheduledJobStoreError::Malformed(path, reason)) => {
                    listing.malformed.push((path, reason))
                }
                Err(error) => return Err(error),
            }
        }
        listing.jobs.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then(right.id.cmp(&left.id))
        });
        Ok(listing)
    }

    fn path_for(&self, id: &ScheduledJobId) -> PathBuf {
        self.root.join(format!("{id}.md"))
    }
}

#[derive(Debug, Default)]
pub struct ScheduledJobListing {
    pub jobs: Vec<ScheduledJob>,
    pub malformed: Vec<(PathBuf, String)>,
}

#[derive(Debug)]
pub enum ScheduledJobStoreError {
    Io(io::Error),
    Malformed(PathBuf, String),
}

impl fmt::Display for ScheduledJobStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            Self::Malformed(path, reason) => write!(formatter, "{}: {reason}", path.display()),
        }
    }
}

impl Error for ScheduledJobStoreError {}

impl From<io::Error> for ScheduledJobStoreError {
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

fn exact(lines: &mut std::str::Lines<'_>, expected: &str) -> Result<(), ValidationError> {
    if lines.next() == Some(expected) {
        Ok(())
    } else {
        Err(ValidationError::new(format!("expected {expected:?}")))
    }
}

fn prefixed<'a>(lines: &mut std::str::Lines<'a>, prefix: &str) -> Result<&'a str, ValidationError> {
    lines
        .next()
        .and_then(|line| line.strip_prefix(prefix))
        .ok_or_else(|| ValidationError::new(format!("expected {prefix:?}")))
}

fn field_value(lines: &mut std::str::Lines<'_>, name: &str) -> Result<String, ValidationError> {
    unquote(prefixed(lines, &format!("{name}: "))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(schedule: &str) -> ScheduledJob {
        ScheduledJob::new(
            "Find fresh reading".into(),
            schedule.into(),
            "Find new material".into(),
            String::new(),
            vec!["Example.COM".into(), "example.com".into()],
            "full".into(),
            Timestamp::from_unix_seconds(1_700_000_000),
        )
        .unwrap()
    }

    #[test]
    fn scheduled_job_round_trips_and_rejects_invalid_cron() {
        let job = job("0 9 * * 1");
        assert_eq!(
            ScheduledJob::from_markdown(&job.to_markdown()).unwrap(),
            job
        );
        assert_eq!(job.source_domains, ["example.com"]);
        assert_eq!(job.next_run_at.unwrap().to_string(), "2023-11-20T09:00:00Z");
        assert!(
            ScheduledJob::new(
                "x".into(),
                "daily".into(),
                "x".into(),
                String::new(),
                vec![],
                "ask".into(),
                Timestamp::from_unix_seconds(0)
            )
            .is_err()
        );
        let retired = job
            .to_markdown()
            .replace("permission-mode: \"full\"\n", "permission-mode: \"plan\"\n");
        assert_eq!(
            ScheduledJob::from_markdown(&retired)
                .unwrap()
                .permission_mode,
            "ask"
        );
        let unpinned = job
            .to_markdown()
            .replacen(
                "emma-scheduled-job-format: 4",
                "emma-scheduled-job-format: 3",
                1,
            )
            .replace("model: \"\"\n", "");
        assert_eq!(ScheduledJob::from_markdown(&unpinned).unwrap().model, "");
        let mut pinned = job.clone();
        pinned
            .set_model("openrouter:deepseek/deepseek-chat".into())
            .unwrap();
        assert_eq!(
            ScheduledJob::from_markdown(&pinned.to_markdown()).unwrap(),
            pinned
        );
        assert!(pinned.set_model("x".repeat(129)).is_err());
        let older = job
            .to_markdown()
            .replacen(
                "emma-scheduled-job-format: 4",
                "emma-scheduled-job-format: 1",
                1,
            )
            .replace("permission-mode: \"full\"\n", "")
            .replace("model: \"\"\n", "")
            .replace("nodes: \"\"\n", "")
            .replace("outputs: \"\"\n", "");
        let migrated = ScheduledJob::from_markdown(&older).unwrap();
        assert_eq!(migrated.permission_mode, "ask");
        assert_eq!(migrated.nodes, "");
        assert!(
            ScheduledJob::new(
                "x".into(),
                "0 9 * * 1".into(),
                "x".into(),
                String::new(),
                vec![],
                "root".into(),
                Timestamp::from_unix_seconds(0)
            )
            .is_err()
        );
    }

    #[test]
    fn a_job_the_clock_does_not_own_has_no_next_run_and_never_claims() {
        let now = Timestamp::from_unix_seconds(1_800_000_000);
        for trigger in ["manual", "after job-1700000000-a-b-c", "on page-saved"] {
            let mut job = job(trigger);
            assert_eq!(job.next_run_at, None, "{trigger} booked a run");
            assert_eq!(job.claim_run(now), Ok(false), "{trigger} claimed a run");
            job.start_run(now);
            assert_eq!(job.last_run_at, Some(now));
            assert_eq!(job.next_run_at, None);
            assert_eq!(
                ScheduledJob::from_markdown(&job.to_markdown()).unwrap(),
                job
            );
        }
        assert!(
            job("manual")
                .set_outputs("{\"digest\":\"three items\"}".into())
                .is_ok()
        );
        for trigger in ["after nope", "on Page Saved", "on ", "* * * * * *"] {
            assert!(validate_schedule(trigger).is_err(), "accepted {trigger}");
        }
    }

    #[test]
    fn a_cron_job_run_by_hand_keeps_its_booking() {
        let mut job = job("0 9 * * 1");
        let booked = job.next_run_at;
        job.start_run(Timestamp::from_unix_seconds(1_700_000_100));
        assert_eq!(job.next_run_at, booked);
        assert_eq!(
            ScheduledJob::from_markdown(&job.to_markdown()).unwrap(),
            job
        );
    }

    #[test]
    fn cron_rejects_invalid_members_in_compound_fields() {
        for schedule in ["1,999 * * * *", "1,2-999 * * * *", "1,*/0 * * * *"] {
            assert!(validate_schedule(schedule).is_err(), "accepted {schedule}");
        }
    }
}
