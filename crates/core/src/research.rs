use std::{
    error::Error,
    fmt,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    PERMISSION_MODES, ThreadId, Timestamp, ValidationError, quote, unquote, validate_text,
};
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct ResearchJobId(String);

impl ResearchJobId {
    pub fn parse(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.len() < 16
            || value.len() > 96
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(ValidationError::new(
                "autoresearch job ID is not a safe filename",
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
            "research-{}-{:x}-{:x}-{sequence:x}",
            now.unix_seconds(),
            std::process::id(),
            nanos
        ))
    }
}

impl fmt::Display for ResearchJobId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// A measurement is an `f64`, so the job it belongs to cannot be `Eq` — which is
/// only a problem for tests, and `assert_eq!` needs no more than `PartialEq`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchJob {
    pub id: ResearchJobId,
    pub title: String,
    /// The git repository the loop edits. Core never touches it; the app runs the
    /// eval command with this as its working directory.
    pub project_dir: String,
    /// The four fields that make a job's numbers comparable to each other: what is
    /// measured, how it is read, the rubric a judge scores against, and which way
    /// is better. Once iterations exist, changing any of them is refused.
    pub metric_name: String,
    pub metric_kind: String,
    pub metric_prompt: String,
    pub direction: String,
    pub eval_command: String,
    /// Free text the user steers the proposer with, in the composer's own grammar:
    /// "/skill" and "@file" tokens are resolved by the app on every iteration.
    /// Empty is normal — the loop has its own instructions without one.
    pub prompt: String,
    pub proposer_model: String,
    pub permission_mode: String,
    /// Each budget is a ceiling, `0` meaning none. The app checks them before an
    /// iteration and pauses the job when one is spent.
    pub max_seconds: u64,
    pub max_tokens: u64,
    pub max_micro_dollars: u64,
    pub spent_seconds: u64,
    pub spent_tokens: u64,
    pub spent_micro_dollars: u64,
    pub status: String,
    pub status_note: String,
    pub thread_id: Option<String>,
    pub created_at: Timestamp,
    pub iterations: Vec<ResearchIteration>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchIteration {
    pub index: u32,
    pub at: Timestamp,
    /// The measurement, and the best measurement after it. A crashed run has
    /// neither a value nor any claim on the best, which is what makes the graph's
    /// line flat across a crash instead of broken.
    pub value: Option<f64>,
    pub best: Option<f64>,
    pub outcome: String,
    pub note: String,
    pub commit: String,
    pub duration_ms: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub micro_dollars: u64,
}

/// Far more attempts than any real experiment needs, and a hard stop for the one
/// that has run away: a job with a file this long is a job nobody is watching.
pub const MAX_RESEARCH_ITERATIONS: usize = 1000;

impl ResearchJob {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
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
        created_at: Timestamp,
    ) -> Result<Self, ValidationError> {
        validate_text("autoresearch title", &title, true)?;
        validate_text("autoresearch project folder", &project_dir, true)?;
        validate_text("autoresearch metric name", &metric_name, true)?;
        validate_text("autoresearch eval command", &eval_command, true)?;
        validate_text("autoresearch model", &proposer_model, true)?;
        validate_text("autoresearch prompt", &prompt, false)?;
        // A judge has nothing to score against without a rubric, and a grep metric
        // reads a number out of the output, so a rubric there would be ignored.
        validate_text(
            "autoresearch metric prompt",
            &metric_prompt,
            metric_kind == "judge",
        )?;
        if metric_kind == "grep" && !metric_prompt.is_empty() {
            return Err(ValidationError::new(
                "a grep metric is read from the output, so it takes no rubric",
            ));
        }
        if title.len() > 128
            || project_dir.len() > 1024
            || metric_name.len() > 64
            || metric_prompt.len() > 4096
            || eval_command.len() > 4096
            || prompt.len() > 8192
            || proposer_model.len() > 256
        {
            return Err(ValidationError::new("autoresearch job text is too long"));
        }
        if !matches!(metric_kind.as_str(), "grep" | "judge") {
            return Err(ValidationError::new("autoresearch metric kind is invalid"));
        }
        if !matches!(direction.as_str(), "lower" | "higher") {
            return Err(ValidationError::new(
                "autoresearch direction must be \"lower\" or \"higher\"",
            ));
        }
        // The app resolves nothing: the folder it is handed is the folder it runs
        // the eval command in, so a relative or climbing path is refused here.
        if !project_dir.starts_with('/') || project_dir.split('/').any(|part| part == "..") {
            return Err(ValidationError::new(
                "autoresearch project folder must be an absolute path without \"..\"",
            ));
        }
        if !PERMISSION_MODES.contains(&permission_mode.as_str()) {
            return Err(ValidationError::new(
                "autoresearch permission mode is invalid",
            ));
        }
        Ok(Self {
            id: ResearchJobId::generate(created_at),
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
            spent_seconds: 0,
            spent_tokens: 0,
            spent_micro_dollars: 0,
            // Saving a job does not start it; the user presses play.
            status: "paused".into(),
            status_note: String::new(),
            thread_id: None,
            created_at,
            iterations: Vec::new(),
        })
    }

    /// Re-saving a job. Everything the loop reads on its next pass may change, but
    /// the metric may not: a job whose numbers were measured two different ways is
    /// a graph of two unrelated experiments.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_edit(
        &mut self,
        title: String,
        project_dir: String,
        metric_name: String,
        metric_kind: String,
        direction: String,
        eval_command: String,
        prompt: String,
        proposer_model: String,
        permission_mode: String,
        max_seconds: u64,
        max_tokens: u64,
        max_micro_dollars: u64,
    ) -> Result<(), ValidationError> {
        if metric_name != self.metric_name
            || metric_kind != self.metric_kind
            || direction != self.direction
            || project_dir != self.project_dir
        {
            return Err(ValidationError::new(
                "an autoresearch metric cannot be changed — create a new job for a different metric",
            ));
        }
        // Validating an edit is validating the job it produces, so build that job
        // and keep its fields rather than repeating every bound here.
        let edited = Self::new(
            title,
            project_dir,
            metric_name,
            metric_kind,
            self.metric_prompt.clone(),
            direction,
            eval_command,
            prompt,
            proposer_model,
            permission_mode,
            max_seconds,
            max_tokens,
            max_micro_dollars,
            self.created_at,
        )?;
        self.title = edited.title;
        self.eval_command = edited.eval_command;
        self.prompt = edited.prompt;
        self.proposer_model = edited.proposer_model;
        self.permission_mode = edited.permission_mode;
        self.max_seconds = edited.max_seconds;
        self.max_tokens = edited.max_tokens;
        self.max_micro_dollars = edited.max_micro_dollars;
        Ok(())
    }

    /// What the app reports about one attempt. The index, the best-so-far and the
    /// three running totals are core's to work out — the app knows what happened,
    /// not what it adds up to.
    #[allow(clippy::too_many_arguments)]
    pub fn record_iteration(
        &mut self,
        value: Option<f64>,
        outcome: String,
        note: String,
        commit: String,
        duration_ms: u64,
        input_tokens: u64,
        output_tokens: u64,
        micro_dollars: u64,
        at: Timestamp,
    ) -> Result<&ResearchIteration, ValidationError> {
        let index = self.iterations.len();
        if index >= MAX_RESEARCH_ITERATIONS {
            return Err(ValidationError::new(format!(
                "autoresearch job has reached its limit of {MAX_RESEARCH_ITERATIONS} iterations — start a new job"
            )));
        }
        let previous = self.iterations.last().and_then(|iteration| iteration.best);
        let improved = |candidate: f64| match previous {
            None => true,
            Some(best) if self.direction == "lower" => candidate < best,
            Some(best) => candidate > best,
        };
        let iteration = ResearchIteration {
            index: index as u32,
            at,
            value,
            best: match value {
                Some(value) if improved(value) => Some(value),
                _ => previous,
            },
            outcome,
            note,
            commit,
            duration_ms,
            input_tokens,
            output_tokens,
            micro_dollars,
        };
        iteration.validate()?;
        self.iterations.push(iteration);
        self.spent_tokens = self
            .spent_tokens
            .saturating_add(input_tokens)
            .saturating_add(output_tokens);
        self.spent_micro_dollars = self.spent_micro_dollars.saturating_add(micro_dollars);
        Ok(&self.iterations[index])
    }

    pub fn set_status(&mut self, status: String, note: String) -> Result<(), ValidationError> {
        if !matches!(
            status.as_str(),
            "running" | "paused" | "finished" | "failed"
        ) {
            return Err(ValidationError::new("autoresearch status is invalid"));
        }
        validate_text("autoresearch status note", &note, false)?;
        if note.len() > 512 {
            return Err(ValidationError::new("autoresearch status note is too long"));
        }
        self.status = status;
        self.status_note = note;
        Ok(())
    }

    /// Wall clock spent, across every run of the job — a resumed job keeps the time
    /// its earlier runs already spent.
    pub fn add_seconds(&mut self, seconds: u64) {
        self.spent_seconds = self.spent_seconds.saturating_add(seconds);
    }

    pub fn to_markdown(&self) -> String {
        let mut output = String::from("---\nemma-research-format: 2\n");
        field(&mut output, "id", self.id.as_str());
        field(&mut output, "title", &self.title);
        field(&mut output, "project-dir", &self.project_dir);
        field(&mut output, "metric-name", &self.metric_name);
        field(&mut output, "metric-kind", &self.metric_kind);
        field(&mut output, "metric-prompt", &self.metric_prompt);
        field(&mut output, "direction", &self.direction);
        field(&mut output, "eval-command", &self.eval_command);
        field(&mut output, "prompt", &self.prompt);
        field(&mut output, "proposer-model", &self.proposer_model);
        field(&mut output, "permission-mode", &self.permission_mode);
        field(&mut output, "status", &self.status);
        field(&mut output, "status-note", &self.status_note);
        field(
            &mut output,
            "thread-id",
            self.thread_id.as_deref().unwrap_or(""),
        );
        field(&mut output, "created-at", &self.created_at.to_string());
        number(&mut output, "max-seconds", self.max_seconds);
        number(&mut output, "max-tokens", self.max_tokens);
        number(&mut output, "max-micro-dollars", self.max_micro_dollars);
        number(&mut output, "spent-seconds", self.spent_seconds);
        number(&mut output, "spent-tokens", self.spent_tokens);
        number(&mut output, "spent-micro-dollars", self.spent_micro_dollars);
        number(&mut output, "iteration-count", self.iterations.len() as u64);
        for (index, iteration) in self.iterations.iter().enumerate() {
            let name = |suffix: &str| format!("iteration-{index}-{suffix}");
            field(&mut output, &name("at"), &iteration.at.to_string());
            field(&mut output, &name("value"), &measurement(iteration.value));
            field(&mut output, &name("best"), &measurement(iteration.best));
            field(&mut output, &name("outcome"), &iteration.outcome);
            field(&mut output, &name("note"), &iteration.note);
            field(&mut output, &name("commit"), &iteration.commit);
            number(&mut output, &name("duration-ms"), iteration.duration_ms);
            number(&mut output, &name("input-tokens"), iteration.input_tokens);
            number(&mut output, &name("output-tokens"), iteration.output_tokens);
            number(&mut output, &name("micro-dollars"), iteration.micro_dollars);
        }
        output.push_str("---\n");
        output
    }

    pub fn from_markdown(markdown: &str) -> Result<Self, ValidationError> {
        let mut lines = markdown.lines();
        exact(&mut lines, "---")?;
        // Version 1 is every job saved before the steering prompt existed: it reads
        // back with an empty one and is rewritten as 2 the next time it is saved.
        let version = prefixed(&mut lines, "emma-research-format: ")?;
        if !matches!(version, "1" | "2") {
            return Err(ValidationError::new(
                "autoresearch job was written by a newer Emma",
            ));
        }
        let id = ResearchJobId::parse(field_value(&mut lines, "id")?)?;
        let title = field_value(&mut lines, "title")?;
        let project_dir = field_value(&mut lines, "project-dir")?;
        let metric_name = field_value(&mut lines, "metric-name")?;
        let metric_kind = field_value(&mut lines, "metric-kind")?;
        let metric_prompt = field_value(&mut lines, "metric-prompt")?;
        let direction = field_value(&mut lines, "direction")?;
        let eval_command = field_value(&mut lines, "eval-command")?;
        let prompt = if version == "1" {
            String::new()
        } else {
            field_value(&mut lines, "prompt")?
        };
        let proposer_model = field_value(&mut lines, "proposer-model")?;
        let permission_mode = field_value(&mut lines, "permission-mode")?;
        let status = field_value(&mut lines, "status")?;
        let status_note = field_value(&mut lines, "status-note")?;
        let thread_id = match field_value(&mut lines, "thread-id")? {
            value if value.is_empty() => None,
            value => Some(ThreadId::parse(value)?.to_string()),
        };
        let created_at = field_value(&mut lines, "created-at")?.parse()?;
        let max_seconds = number_value(&mut lines, "max-seconds")?;
        let max_tokens = number_value(&mut lines, "max-tokens")?;
        let max_micro_dollars = number_value(&mut lines, "max-micro-dollars")?;
        let spent_seconds = number_value(&mut lines, "spent-seconds")?;
        let spent_tokens = number_value(&mut lines, "spent-tokens")?;
        let spent_micro_dollars = number_value(&mut lines, "spent-micro-dollars")?;
        let count = number_value(&mut lines, "iteration-count")? as usize;
        if count > MAX_RESEARCH_ITERATIONS {
            return Err(ValidationError::new(
                "autoresearch iteration count is too large",
            ));
        }
        let mut iterations = Vec::with_capacity(count);
        for index in 0..count {
            let name = |suffix: &str| format!("iteration-{index}-{suffix}");
            let at = field_value(&mut lines, &name("at"))?.parse()?;
            let value = measurement_value(&mut lines, &name("value"))?;
            let best = measurement_value(&mut lines, &name("best"))?;
            let outcome = field_value(&mut lines, &name("outcome"))?;
            let note = field_value(&mut lines, &name("note"))?;
            let commit = field_value(&mut lines, &name("commit"))?;
            let iteration = ResearchIteration {
                index: index as u32,
                at,
                value,
                best,
                outcome,
                note,
                commit,
                duration_ms: number_value(&mut lines, &name("duration-ms"))?,
                input_tokens: number_value(&mut lines, &name("input-tokens"))?,
                output_tokens: number_value(&mut lines, &name("output-tokens"))?,
                micro_dollars: number_value(&mut lines, &name("micro-dollars"))?,
            };
            iteration.validate()?;
            iterations.push(iteration);
        }
        exact(&mut lines, "---")?;
        if lines.next().is_some() {
            return Err(ValidationError::new(
                "autoresearch job has trailing content",
            ));
        }
        let mut job = Self::new(
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
            created_at,
        )?;
        job.set_status(status, status_note)?;
        job.add_seconds(spent_seconds);
        job.id = id;
        job.thread_id = thread_id;
        job.spent_tokens = spent_tokens;
        job.spent_micro_dollars = spent_micro_dollars;
        job.iterations = iterations;
        Ok(job)
    }
}

impl ResearchIteration {
    fn validate(&self) -> Result<(), ValidationError> {
        if [self.value, self.best]
            .into_iter()
            .flatten()
            .any(|number| !number.is_finite())
        {
            return Err(ValidationError::new(
                "an autoresearch measurement must be a finite number",
            ));
        }
        if !matches!(self.outcome.as_str(), "keep" | "discard" | "crash") {
            return Err(ValidationError::new("autoresearch outcome is invalid"));
        }
        validate_text("autoresearch iteration note", &self.note, false)?;
        validate_text("autoresearch iteration commit", &self.commit, false)?;
        if self.note.len() > 280 || self.commit.len() > 64 {
            return Err(ValidationError::new(
                "autoresearch iteration text is too long",
            ));
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct ResearchJobStore {
    root: PathBuf,
}

impl ResearchJobStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn save(&self, job: &ResearchJob) -> Result<(), ResearchJobStoreError> {
        if job.iterations.len() > MAX_RESEARCH_ITERATIONS {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "autoresearch job cannot have more than {MAX_RESEARCH_ITERATIONS} iterations"
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
        result.map_err(ResearchJobStoreError::Io)
    }

    pub fn load(&self, id: &ResearchJobId) -> Result<ResearchJob, ResearchJobStoreError> {
        let path = self.path_for(id);
        let job = ResearchJob::from_markdown(&fs::read_to_string(&path)?)
            .map_err(|error| ResearchJobStoreError::Malformed(path.clone(), error.to_string()))?;
        if &job.id != id {
            return Err(ResearchJobStoreError::Malformed(
                path,
                "job ID does not match filename".into(),
            ));
        }
        Ok(job)
    }

    /// Deleting a job that is already gone is a success: the caller wanted it gone.
    pub fn delete(&self, id: &ResearchJobId) -> Result<(), ResearchJobStoreError> {
        match fs::remove_file(self.path_for(id)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub fn list(&self) -> Result<ResearchJobListing, ResearchJobStoreError> {
        let mut listing = ResearchJobListing::default();
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
            let id = match ResearchJobId::parse(stem) {
                Ok(id) => id,
                Err(error) => {
                    listing.malformed.push((path, error.to_string()));
                    continue;
                }
            };
            match self.load(&id) {
                Ok(job) => listing.jobs.push(job),
                Err(ResearchJobStoreError::Malformed(path, reason)) => {
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

    fn path_for(&self, id: &ResearchJobId) -> PathBuf {
        self.root.join(format!("{id}.md"))
    }
}

#[derive(Debug, Default)]
pub struct ResearchJobListing {
    pub jobs: Vec<ResearchJob>,
    pub malformed: Vec<(PathBuf, String)>,
}

#[derive(Debug)]
pub enum ResearchJobStoreError {
    Io(io::Error),
    Malformed(PathBuf, String),
}

impl fmt::Display for ResearchJobStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            Self::Malformed(path, reason) => write!(formatter, "{}: {reason}", path.display()),
        }
    }
}

impl Error for ResearchJobStoreError {}

impl From<io::Error> for ResearchJobStoreError {
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

fn number(output: &mut String, name: &str, value: u64) {
    output.push_str(name);
    output.push_str(": ");
    output.push_str(&value.to_string());
    output.push('\n');
}

/// A measurement on the way out. Rust prints the shortest text that parses back to
/// the same `f64`, so the round-trip is exact and a missing value is just empty.
fn measurement(value: Option<f64>) -> String {
    value.map_or_else(String::new, |value| value.to_string())
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

fn number_value(lines: &mut std::str::Lines<'_>, name: &str) -> Result<u64, ValidationError> {
    prefixed(lines, &format!("{name}: "))?
        .parse()
        .map_err(|_| ValidationError::new(format!("{name} is not a number")))
}

fn measurement_value(
    lines: &mut std::str::Lines<'_>,
    name: &str,
) -> Result<Option<f64>, ValidationError> {
    match field_value(lines, name)? {
        value if value.is_empty() => Ok(None),
        value => value
            .parse()
            .map(Some)
            .map_err(|_| ValidationError::new(format!("{name} is not a number"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(direction: &str) -> ResearchJob {
        ResearchJob::new(
            "Lower the loss".into(),
            "/Users/me/nanochat".into(),
            "val_bpb".into(),
            "grep".into(),
            String::new(),
            direction.into(),
            "uv run train.py 2>&1".into(),
            "Try /muon ideas from @notes/plan.md".into(),
            "anthropic/claude-opus-4".into(),
            "acceptEdits".into(),
            0,
            0,
            0,
            Timestamp::from_unix_seconds(1_700_000_000),
        )
        .unwrap()
    }

    fn record(job: &mut ResearchJob, value: Option<f64>, outcome: &str) {
        job.record_iteration(
            value,
            outcome.into(),
            "widened the layer".into(),
            "a1b2c3d".into(),
            1_000,
            30,
            12,
            450,
            Timestamp::from_unix_seconds(1_700_000_100),
        )
        .unwrap();
    }

    #[test]
    fn research_job_round_trips_with_its_iterations() {
        let mut job = job("lower");
        job.thread_id = Some("thread-1700000000-a-b-c".into());
        job.set_status("running".into(), "".into()).unwrap();
        record(&mut job, Some(0.997_9), "keep");
        record(&mut job, None, "crash");
        job.add_seconds(42);
        assert_eq!(ResearchJob::from_markdown(&job.to_markdown()).unwrap(), job);
        assert!(ResearchJob::from_markdown(&(job.to_markdown() + "extra\n")).is_err());
        // A job saved before the steering prompt existed still loads, without one.
        let older = job
            .to_markdown()
            .replace("emma-research-format: 2", "emma-research-format: 1")
            .replace(&format!("prompt: {}\n", quote(&job.prompt)), "");
        assert_eq!(ResearchJob::from_markdown(&older).unwrap().prompt, "");
        assert!(job.set_status("sleeping".into(), "".into()).is_err());
    }

    #[test]
    fn the_metric_cannot_be_edited_but_everything_else_can() {
        let mut job = job("lower");
        let edit = |job: &mut ResearchJob, metric: &str, folder: &str| {
            job.apply_edit(
                "Lower the loss, harder".into(),
                folder.into(),
                metric.into(),
                "grep".into(),
                "lower".into(),
                "uv run train.py --fast 2>&1".into(),
                "Stay inside @train.py".into(),
                "openai/gpt-5".into(),
                "full".into(),
                600,
                1_000,
                5_000,
            )
        };
        assert_eq!(
            edit(&mut job, "val_loss", "/Users/me/nanochat").unwrap_err(),
            ValidationError::new(
                "an autoresearch metric cannot be changed — create a new job for a different metric"
            )
        );
        assert!(edit(&mut job, "val_bpb", "/Users/me/elsewhere").is_err());
        assert_eq!(job.title, "Lower the loss");
        edit(&mut job, "val_bpb", "/Users/me/nanochat").unwrap();
        assert_eq!(job.title, "Lower the loss, harder");
        assert_eq!(job.proposer_model, "openai/gpt-5");
        assert_eq!(job.prompt, "Stay inside @train.py");
        assert_eq!(job.max_micro_dollars, 5_000);
    }

    #[test]
    fn the_best_is_the_best_in_the_jobs_own_direction() {
        let mut lower = job("lower");
        record(&mut lower, Some(1.5), "keep");
        record(&mut lower, Some(2.0), "discard");
        record(&mut lower, None, "crash");
        record(&mut lower, Some(0.5), "keep");
        assert_eq!(
            lower
                .iterations
                .iter()
                .map(|it| it.best)
                .collect::<Vec<_>>(),
            [Some(1.5), Some(1.5), Some(1.5), Some(0.5)]
        );
        let mut higher = job("higher");
        record(&mut higher, Some(1.5), "keep");
        record(&mut higher, Some(2.0), "keep");
        record(&mut higher, None, "crash");
        assert_eq!(
            higher
                .iterations
                .iter()
                .map(|it| it.best)
                .collect::<Vec<_>>(),
            [Some(1.5), Some(2.0), Some(2.0)]
        );
        assert_eq!(higher.iterations[2].index, 2);
    }

    #[test]
    fn spending_accumulates_over_every_iteration() {
        let mut job = job("lower");
        record(&mut job, Some(1.0), "keep");
        record(&mut job, None, "crash");
        job.add_seconds(30);
        job.add_seconds(u64::MAX);
        assert_eq!(job.spent_tokens, 84);
        assert_eq!(job.spent_micro_dollars, 900);
        assert_eq!(job.spent_seconds, u64::MAX);
    }

    #[test]
    fn a_job_stops_recording_at_the_ceiling() {
        let mut job = job("lower");
        for _ in 0..MAX_RESEARCH_ITERATIONS {
            record(&mut job, Some(1.0), "keep");
        }
        let error = job
            .record_iteration(
                Some(1.0),
                "keep".into(),
                String::new(),
                String::new(),
                0,
                0,
                0,
                0,
                Timestamp::from_unix_seconds(1_700_000_200),
            )
            .unwrap_err();
        assert!(error.to_string().contains("1000 iterations"));
    }

    #[test]
    fn a_measurement_that_is_not_a_number_is_refused() {
        let mut job = job("lower");
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(
                job.record_iteration(
                    Some(value),
                    "keep".into(),
                    String::new(),
                    String::new(),
                    0,
                    0,
                    0,
                    0,
                    Timestamp::from_unix_seconds(1_700_000_100),
                )
                .is_err(),
                "accepted {value}"
            );
        }
        assert!(job.iterations.is_empty());
        assert_eq!(job.spent_tokens, 0);
    }

    #[test]
    fn a_project_folder_cannot_be_relative_or_climb() {
        for folder in ["/Users/me/../../etc", "nanochat", "~/nanochat", ".."] {
            assert!(
                ResearchJob::new(
                    "x".into(),
                    folder.into(),
                    "val_bpb".into(),
                    "grep".into(),
                    String::new(),
                    "lower".into(),
                    "make test".into(),
                    String::new(),
                    "openai/gpt-5".into(),
                    "ask".into(),
                    0,
                    0,
                    0,
                    Timestamp::from_unix_seconds(0),
                )
                .is_err(),
                "accepted {folder}"
            );
        }
    }
}
