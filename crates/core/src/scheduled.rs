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
    pub source_domains: Vec<String>,
    pub enabled: bool,
    pub created_at: Timestamp,
    pub next_run_at: Timestamp,
    pub last_run_at: Option<Timestamp>,
    pub last_thread_id: Option<String>,
}

impl ScheduledJob {
    pub fn new(
        title: String,
        schedule: String,
        prompt: String,
        source_domains: Vec<String>,
        created_at: Timestamp,
    ) -> Result<Self, ValidationError> {
        validate_text("scheduled job title", &title, true)?;
        validate_text("scheduled job prompt", &prompt, true)?;
        if title.len() > 128 || prompt.len() > 8 * 1024 {
            return Err(ValidationError::new("scheduled job text is too long"));
        }
        validate_schedule(&schedule)?;
        if source_domains.len() > 32 {
            return Err(ValidationError::new(
                "scheduled job has too many source domains",
            ));
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
        let next_run_at = next_run(&schedule, created_at)?;
        Ok(Self {
            id: ScheduledJobId::generate(created_at),
            title,
            schedule,
            prompt,
            source_domains: domains,
            enabled: true,
            created_at,
            next_run_at,
            last_run_at: None,
            last_thread_id: None,
        })
    }

    pub fn claim_run(&mut self, now: Timestamp) -> Result<bool, ValidationError> {
        if !self.enabled || now < self.next_run_at {
            return Ok(false);
        }
        self.last_run_at = Some(now);
        self.next_run_at = next_run(&self.schedule, now)?;
        Ok(true)
    }

    pub fn to_markdown(&self) -> String {
        let mut output = String::from("---\nemma-scheduled-job-format: 1\n");
        field(&mut output, "id", self.id.as_str());
        field(&mut output, "title", &self.title);
        field(&mut output, "schedule", &self.schedule);
        field(&mut output, "prompt", &self.prompt);
        field(&mut output, "created-at", &self.created_at.to_string());
        field(&mut output, "next-run-at", &self.next_run_at.to_string());
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
        exact(&mut lines, "emma-scheduled-job-format: 1")?;
        let id = ScheduledJobId::parse(field_value(&mut lines, "id")?)?;
        let title = field_value(&mut lines, "title")?;
        let schedule = field_value(&mut lines, "schedule")?;
        let prompt = field_value(&mut lines, "prompt")?;
        let created_at = field_value(&mut lines, "created-at")?.parse()?;
        let next_run_at = field_value(&mut lines, "next-run-at")?.parse()?;
        let last_run_at = match field_value(&mut lines, "last-run-at")? {
            value if value.is_empty() => None,
            value => Some(value.parse()?),
        };
        let last_thread_id = match field_value(&mut lines, "last-thread-id")? {
            value if value.is_empty() => None,
            value => Some(ThreadId::parse(value)?.to_string()),
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
        let mut domains = Vec::with_capacity(count.min(32));
        for index in 0..count {
            domains.push(field_value(&mut lines, &format!("source-domain-{index}"))?);
        }
        exact(&mut lines, "---")?;
        if lines.next().is_some() {
            return Err(ValidationError::new("scheduled job has trailing content"));
        }
        let mut job = Self::new(title, schedule, prompt, domains, created_at)?;
        if last_run_at.is_some_and(|last| last < created_at)
            || next_run_at <= last_run_at.unwrap_or(created_at)
        {
            return Err(ValidationError::new(
                "scheduled job run timestamps are invalid",
            ));
        }
        job.id = id;
        job.enabled = enabled;
        job.next_run_at = next_run_at;
        job.last_run_at = last_run_at;
        job.last_thread_id = last_thread_id;
        Ok(job)
    }
}

fn validate_schedule(value: &str) -> Result<(), ValidationError> {
    let fields = value.split_ascii_whitespace().collect::<Vec<_>>();
    if value.len() > 128 || fields.len() != 5 {
        return Err(ValidationError::new(
            "schedule must be a five-field cron expression",
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

    #[test]
    fn scheduled_job_round_trips_and_rejects_invalid_cron() {
        let job = ScheduledJob::new(
            "Find fresh reading".into(),
            "0 9 * * 1".into(),
            "Find new material".into(),
            vec!["Example.COM".into(), "example.com".into()],
            Timestamp::from_unix_seconds(1_700_000_000),
        )
        .unwrap();
        assert_eq!(
            ScheduledJob::from_markdown(&job.to_markdown()).unwrap(),
            job
        );
        assert_eq!(job.source_domains, ["example.com"]);
        assert_eq!(job.next_run_at.to_string(), "2023-11-20T09:00:00Z");
        assert!(
            ScheduledJob::new(
                "x".into(),
                "daily".into(),
                "x".into(),
                vec![],
                Timestamp::from_unix_seconds(0)
            )
            .is_err()
        );
    }

    #[test]
    fn cron_rejects_invalid_members_in_compound_fields() {
        for schedule in ["1,999 * * * *", "1,2-999 * * * *", "1,*/0 * * * *"] {
            assert!(validate_schedule(schedule).is_err(), "accepted {schedule}");
        }
    }
}
