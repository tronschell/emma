use std::{
    error::Error,
    fmt,
    path::PathBuf,
    sync::{
        Arc,
        mpsc::{self, RecvTimeoutError, Sender},
    },
    thread,
    time::{Duration, Instant},
};

use crate::{
    GenerationTelemetry, GoalStatus, MAX_TRIGGER_DEPTH, ResearchJob, ResearchJobId,
    ResearchJobStore, ScheduledJob, ScheduledJobId, ScheduledJobStore, Thread, ThreadId,
    ThreadKind, ThreadMessage, ThreadRole, ThreadStore, ThreadTrace, Timestamp, elide_middle,
    validate_text,
};
use serde::Serialize;

const MAX_AGENT_TITLE_BYTES: usize = 256;
const MAX_AGENT_MESSAGE_BYTES: usize = 64 * 1024;
pub const ARCHIVE_RETENTION_SECONDS: i64 = 30 * 24 * 60 * 60;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSnapshot {
    pub threads: Vec<Arc<Thread>>,
    pub scheduled_jobs: Vec<ScheduledJob>,
    pub research_jobs: Vec<ResearchJob>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveError(String);

impl LiveError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for LiveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl Error for LiveError {}

type Reply<T> = Sender<Result<T, LiveError>>;

enum Command {
    Snapshot(Reply<LiveSnapshot>),
    UncachedSnapshot(Reply<LiveSnapshot>),
    Thread {
        thread_id: ThreadId,
        reply: Reply<Thread>,
    },
    CreateThread {
        title: Option<String>,
        parent_thread_id: Option<ThreadId>,
        kind: ThreadKind,
        reply: Reply<Thread>,
    },
    SetThreadArchived {
        thread_id: ThreadId,
        archived: bool,
        reply: Reply<Thread>,
    },
    RenameThread {
        thread_id: ThreadId,
        title: String,
        reply: Reply<Thread>,
    },
    RecordTurn {
        thread_id: ThreadId,
        prompt: String,
        response: String,
        output_tokens: u64,
        duration_milliseconds: u64,
        input_tokens: u64,
        cache_input_tokens: Option<u64>,
        cache_read_tokens: Option<u64>,
        cache_write_tokens: Option<u64>,
        cost_micro_usd: Option<u64>,
        model: String,
        reply: Reply<Thread>,
    },
    SetGoal {
        thread_id: ThreadId,
        objective: String,
        token_budget: u64,
        reply: Reply<Thread>,
    },
    UpdateGoal {
        thread_id: ThreadId,
        status: Option<GoalStatus>,
        evidence: String,
        reason: String,
        extra_tokens: u64,
        reply: Reply<Thread>,
    },
    ClearGoal {
        thread_id: ThreadId,
        reply: Reply<Thread>,
    },
    RecordTrace {
        thread_id: ThreadId,
        trace: String,
        reply: Reply<()>,
    },
    ReadTrace {
        thread_id: ThreadId,
        reply: Reply<Vec<ThreadTrace>>,
    },
    SaveScheduledJob {
        job_id: Option<ScheduledJobId>,
        title: String,
        schedule: String,
        prompt: String,
        nodes: String,
        source_domains: Vec<String>,
        permission_mode: String,
        model: String,
        reply: Reply<ScheduledJob>,
    },
    SetScheduledJobEnabled {
        job_id: ScheduledJobId,
        enabled: bool,
        reply: Reply<ScheduledJob>,
    },
    DeleteScheduledJob {
        job_id: ScheduledJobId,
        reply: Reply<()>,
    },
    RunScheduledJob {
        job_id: ScheduledJobId,
        variables: String,
        reply: Reply<ScheduledJob>,
    },
    FinishScheduledJob {
        job_id: ScheduledJobId,
        outputs: String,
        depth: u32,
        reply: Reply<ScheduledJob>,
    },
    FireScheduledEvent {
        event: String,
        variables: String,
        reply: Reply<Vec<ScheduledJob>>,
    },
    SaveResearchJob {
        job_id: Option<ResearchJobId>,
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
        reply: Reply<ResearchJob>,
    },
    DeleteResearchJob {
        job_id: ResearchJobId,
        reply: Reply<()>,
    },
    SetResearchJobStatus {
        job_id: ResearchJobId,
        status: String,
        note: String,
        reply: Reply<ResearchJob>,
    },
    SetResearchJobThread {
        job_id: ResearchJobId,
        thread_id: ThreadId,
        reply: Reply<ResearchJob>,
    },
    RecordResearchIteration {
        job_id: ResearchJobId,
        value: Option<f64>,
        outcome: String,
        note: String,
        commit: String,
        duration_ms: u64,
        input_tokens: u64,
        output_tokens: u64,
        micro_dollars: u64,
        reply: Reply<ResearchJob>,
    },
}

#[derive(Clone)]
pub struct LiveClient {
    commands: Sender<Command>,
}

impl LiveClient {
    pub fn snapshot(&self) -> Result<LiveSnapshot, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::Snapshot(reply))
            .map_err(|_| LiveError::new("Emma runtime stopped before loading the library"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while loading the library"))?
    }

    pub fn snapshot_uncached(&self) -> Result<LiveSnapshot, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::UncachedSnapshot(reply))
            .map_err(|_| LiveError::new("Emma runtime stopped before loading the library"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while loading the library"))?
    }

    pub fn thread(&self, thread_id: ThreadId) -> Result<Thread, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::Thread { thread_id, reply })
            .map_err(|_| LiveError::new("Emma runtime stopped before loading the thread"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while loading the thread"))?
    }

    pub fn create_thread(
        &self,
        title: Option<String>,
        parent_thread_id: Option<ThreadId>,
        kind: ThreadKind,
    ) -> Result<Thread, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::CreateThread {
                title,
                parent_thread_id,
                kind,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before creating the thread"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while creating the thread"))?
    }

    pub fn set_thread_archived(
        &self,
        thread_id: ThreadId,
        archived: bool,
    ) -> Result<Thread, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SetThreadArchived {
                thread_id,
                archived,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before archiving the thread"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while archiving the thread"))?
    }

    pub fn rename_thread(&self, thread_id: ThreadId, title: String) -> Result<Thread, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::RenameThread {
                thread_id,
                title,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before renaming the thread"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while renaming the thread"))?
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_turn(
        &self,
        thread_id: ThreadId,
        prompt: String,
        response: String,
        output_tokens: u64,
        duration_milliseconds: u64,
        input_tokens: u64,
        cache_input_tokens: Option<u64>,
        cache_read_tokens: Option<u64>,
        cache_write_tokens: Option<u64>,
        cost_micro_usd: Option<u64>,
        model: String,
    ) -> Result<Thread, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::RecordTurn {
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
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before recording the turn"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while recording the turn"))?
    }

    pub fn set_goal(
        &self,
        thread_id: ThreadId,
        objective: String,
        token_budget: u64,
    ) -> Result<Thread, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SetGoal {
                thread_id,
                objective,
                token_budget,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before setting the goal"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while setting the goal"))?
    }

    pub fn update_goal(
        &self,
        thread_id: ThreadId,
        status: Option<GoalStatus>,
        evidence: String,
        reason: String,
        extra_tokens: u64,
    ) -> Result<Thread, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::UpdateGoal {
                thread_id,
                status,
                evidence,
                reason,
                extra_tokens,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before updating the goal"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while updating the goal"))?
    }

    pub fn clear_goal(&self, thread_id: ThreadId) -> Result<Thread, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::ClearGoal { thread_id, reply })
            .map_err(|_| LiveError::new("Emma runtime stopped before clearing the goal"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while clearing the goal"))?
    }

    pub fn record_trace(&self, thread_id: ThreadId, trace: String) -> Result<(), LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::RecordTrace {
                thread_id,
                trace,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before recording the trace"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while recording the trace"))?
    }

    pub fn read_trace(&self, thread_id: ThreadId) -> Result<Vec<ThreadTrace>, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::ReadTrace { thread_id, reply })
            .map_err(|_| LiveError::new("Emma runtime stopped before reading the trace"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while reading the trace"))?
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_scheduled_job(
        &self,
        job_id: Option<ScheduledJobId>,
        title: String,
        schedule: String,
        prompt: String,
        nodes: String,
        source_domains: Vec<String>,
        permission_mode: String,
        model: String,
    ) -> Result<ScheduledJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SaveScheduledJob {
                job_id,
                title,
                schedule,
                prompt,
                nodes,
                source_domains,
                permission_mode,
                model,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before saving the scheduled job"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while saving the scheduled job"))?
    }

    pub fn delete_scheduled_job(&self, job_id: ScheduledJobId) -> Result<(), LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::DeleteScheduledJob { job_id, reply })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before deleting the scheduled job")
            })?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while deleting the scheduled job"))?
    }

    pub fn run_scheduled_job(
        &self,
        job_id: ScheduledJobId,
        variables: String,
    ) -> Result<ScheduledJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::RunScheduledJob {
                job_id,
                variables,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before running the scheduled job"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while running the scheduled job"))?
    }

    pub fn finish_scheduled_job(
        &self,
        job_id: ScheduledJobId,
        outputs: String,
        depth: u32,
    ) -> Result<ScheduledJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::FinishScheduledJob {
                job_id,
                outputs,
                depth,
                reply,
            })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before finishing the scheduled job")
            })?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while finishing the scheduled job"))?
    }

    pub fn fire_scheduled_event(
        &self,
        event: String,
        variables: String,
    ) -> Result<Vec<ScheduledJob>, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::FireScheduledEvent {
                event,
                variables,
                reply,
            })
            .map_err(|_| LiveError::new("Emma runtime stopped before raising the event"))?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while raising the event"))?
    }

    pub fn set_scheduled_job_enabled(
        &self,
        job_id: ScheduledJobId,
        enabled: bool,
    ) -> Result<ScheduledJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SetScheduledJobEnabled {
                job_id,
                enabled,
                reply,
            })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before updating the scheduled job")
            })?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while updating the scheduled job"))?
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_research_job(
        &self,
        job_id: Option<ResearchJobId>,
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
    ) -> Result<ResearchJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SaveResearchJob {
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
                reply,
            })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before saving the autoresearch job")
            })?;
        result
            .recv()
            .map_err(|_| LiveError::new("Emma runtime stopped while saving the autoresearch job"))?
    }

    pub fn delete_research_job(&self, job_id: ResearchJobId) -> Result<(), LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::DeleteResearchJob { job_id, reply })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before deleting the autoresearch job")
            })?;
        result.recv().map_err(|_| {
            LiveError::new("Emma runtime stopped while deleting the autoresearch job")
        })?
    }

    pub fn set_research_job_status(
        &self,
        job_id: ResearchJobId,
        status: String,
        note: String,
    ) -> Result<ResearchJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SetResearchJobStatus {
                job_id,
                status,
                note,
                reply,
            })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before updating the autoresearch job")
            })?;
        result.recv().map_err(|_| {
            LiveError::new("Emma runtime stopped while updating the autoresearch job")
        })?
    }

    pub fn set_research_job_thread(
        &self,
        job_id: ResearchJobId,
        thread_id: ThreadId,
    ) -> Result<ResearchJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::SetResearchJobThread {
                job_id,
                thread_id,
                reply,
            })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before updating the autoresearch job")
            })?;
        result.recv().map_err(|_| {
            LiveError::new("Emma runtime stopped while updating the autoresearch job")
        })?
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_research_iteration(
        &self,
        job_id: ResearchJobId,
        value: Option<f64>,
        outcome: String,
        note: String,
        commit: String,
        duration_ms: u64,
        input_tokens: u64,
        output_tokens: u64,
        micro_dollars: u64,
    ) -> Result<ResearchJob, LiveError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(Command::RecordResearchIteration {
                job_id,
                value,
                outcome,
                note,
                commit,
                duration_ms,
                input_tokens,
                output_tokens,
                micro_dollars,
                reply,
            })
            .map_err(|_| {
                LiveError::new("Emma runtime stopped before recording the autoresearch iteration")
            })?;
        result.recv().map_err(|_| {
            LiveError::new("Emma runtime stopped while recording the autoresearch iteration")
        })?
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueJob {
    pub job_id: String,
    pub thread_id: String,
    pub title: String,
    pub prompt: String,
    pub nodes: String,
    pub variables: String,
    pub permission_mode: String,
    pub model: String,
    pub depth: u32,
}

pub type JobSink = Arc<dyn Fn(DueJob) + Send + Sync>;

pub fn start_live_runtime(
    thread_root: PathBuf,
    scheduled_root: PathBuf,
    research_root: PathBuf,
    jobs: JobSink,
) -> Result<LiveClient, LiveError> {
    let (commands, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("emma-live-runtime".into())
        .spawn(move || {
            let mut runtime = Runtime::new(thread_root, scheduled_root, research_root, jobs);
            let tick = Duration::from_secs(30);
            let mut due = Instant::now() + tick;
            loop {
                match receiver.recv_timeout(due.saturating_duration_since(Instant::now())) {
                    Ok(command) => runtime.handle(command),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                if Instant::now() >= due {
                    runtime.run_due_jobs();
                    due = Instant::now() + tick;
                }
            }
        })
        .map_err(|error| LiveError::new(format!("could not start Emma runtime: {error}")))?;
    Ok(LiveClient { commands })
}

struct Runtime {
    threads: ThreadStore,
    scheduled: ScheduledJobStore,
    research: ResearchJobStore,
    jobs: JobSink,
}

impl Runtime {
    fn new(
        thread_root: PathBuf,
        scheduled_root: PathBuf,
        research_root: PathBuf,
        jobs: JobSink,
    ) -> Self {
        Self {
            threads: ThreadStore::new(thread_root),
            scheduled: ScheduledJobStore::new(scheduled_root),
            research: ResearchJobStore::new(research_root),
            jobs,
        }
    }

    fn handle(&mut self, command: Command) {
        match command {
            Command::Snapshot(reply) => {
                let _ = reply.send(self.snapshot());
            }
            Command::UncachedSnapshot(reply) => {
                let _ = reply.send(self.snapshot_uncached());
            }
            Command::Thread { thread_id, reply } => {
                let _ = reply.send(self.thread(thread_id));
            }
            Command::CreateThread {
                title,
                parent_thread_id,
                kind,
                reply,
            } => {
                let _ = reply.send(self.create_thread(title, parent_thread_id, kind));
            }
            Command::SetThreadArchived {
                thread_id,
                archived,
                reply,
            } => {
                let _ = reply.send(self.set_thread_archived(thread_id, archived));
            }
            Command::RenameThread {
                thread_id,
                title,
                reply,
            } => {
                let _ = reply.send(self.rename_thread(thread_id, title));
            }
            Command::RecordTurn {
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
                reply,
            } => {
                let _ = reply.send(self.record_turn(
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
                ));
            }
            Command::SetGoal {
                thread_id,
                objective,
                token_budget,
                reply,
            } => {
                let _ = reply.send(self.set_goal(thread_id, objective, token_budget));
            }
            Command::UpdateGoal {
                thread_id,
                status,
                evidence,
                reason,
                extra_tokens,
                reply,
            } => {
                let _ =
                    reply.send(self.update_goal(thread_id, status, evidence, reason, extra_tokens));
            }
            Command::ClearGoal { thread_id, reply } => {
                let _ = reply.send(self.clear_goal(thread_id));
            }
            Command::RecordTrace {
                thread_id,
                trace,
                reply,
            } => {
                let _ = reply.send(self.record_trace(thread_id, trace));
            }
            Command::ReadTrace { thread_id, reply } => {
                let _ = reply.send(self.read_trace(thread_id));
            }
            Command::SaveScheduledJob {
                job_id,
                title,
                schedule,
                prompt,
                nodes,
                source_domains,
                permission_mode,
                model,
                reply,
            } => {
                let _ = reply.send(self.save_scheduled_job(
                    job_id,
                    title,
                    schedule,
                    prompt,
                    nodes,
                    source_domains,
                    permission_mode,
                    model,
                ));
            }
            Command::SetScheduledJobEnabled {
                job_id,
                enabled,
                reply,
            } => {
                let _ = reply.send(self.set_scheduled_job_enabled(job_id, enabled));
            }
            Command::DeleteScheduledJob { job_id, reply } => {
                let _ = reply.send(self.delete_scheduled_job(job_id));
            }
            Command::RunScheduledJob {
                job_id,
                variables,
                reply,
            } => {
                let _ = reply.send(self.run_scheduled_job(job_id, variables));
            }
            Command::FinishScheduledJob {
                job_id,
                outputs,
                depth,
                reply,
            } => {
                let _ = reply.send(self.finish_scheduled_job(job_id, outputs, depth));
            }
            Command::FireScheduledEvent {
                event,
                variables,
                reply,
            } => {
                let _ = reply.send(self.fire_scheduled_event(event, variables));
            }
            Command::SaveResearchJob {
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
                reply,
            } => {
                let _ = reply.send(self.save_research_job(
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
                ));
            }
            Command::DeleteResearchJob { job_id, reply } => {
                let _ = reply.send(self.delete_research_job(job_id));
            }
            Command::SetResearchJobStatus {
                job_id,
                status,
                note,
                reply,
            } => {
                let _ = reply.send(self.set_research_job_status(job_id, status, note));
            }
            Command::SetResearchJobThread {
                job_id,
                thread_id,
                reply,
            } => {
                let _ = reply.send(self.set_research_job_thread(job_id, thread_id));
            }
            Command::RecordResearchIteration {
                job_id,
                value,
                outcome,
                note,
                commit,
                duration_ms,
                input_tokens,
                output_tokens,
                micro_dollars,
                reply,
            } => {
                let _ = reply.send(self.record_research_iteration(
                    job_id,
                    value,
                    outcome,
                    note,
                    commit,
                    duration_ms,
                    input_tokens,
                    output_tokens,
                    micro_dollars,
                ));
            }
        }
    }

    fn run_due_jobs(&mut self) {
        let Ok(listing) = self.scheduled.list() else {
            return;
        };
        let now = Timestamp::now();
        for mut job in listing.jobs {
            if job.claim_run(now) != Ok(true) || self.scheduled.save(&job).is_err() {
                continue;
            }
            let _ = self.hand_out_run(&mut job, String::new(), 0);
        }
    }

    fn hand_out_run(
        &mut self,
        job: &mut ScheduledJob,
        variables: String,
        depth: u32,
    ) -> Result<(), LiveError> {
        let mut thread = Thread::new(job.title.clone(), Timestamp::now())
            .map_err(|error| LiveError::new(format!("could not open the run's thread: {error}")))?;
        thread.scheduled_job_id = Some(job.id.clone());
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save the run's thread: {error}")))?;
        job.last_thread_id = Some(thread.id.to_string());
        self.scheduled
            .save(job)
            .map_err(|error| LiveError::new(format!("could not save scheduled job: {error}")))?;
        (self.jobs)(DueJob {
            job_id: job.id.as_str().to_string(),
            thread_id: thread.id.to_string(),
            title: job.title.clone(),
            prompt: job.prompt.clone(),
            nodes: job.nodes.clone(),
            variables,
            permission_mode: job.permission_mode.clone(),
            model: job.model.clone(),
            depth,
        });
        Ok(())
    }

    fn fire_trigger(
        &mut self,
        key: &str,
        variables: String,
        depth: u32,
    ) -> Result<Vec<ScheduledJob>, LiveError> {
        if depth > MAX_TRIGGER_DEPTH {
            return Ok(Vec::new());
        }
        let listing = self
            .scheduled
            .list()
            .map_err(|error| LiveError::new(format!("could not load scheduled jobs: {error}")))?;
        let mut fired = Vec::new();
        for mut job in listing.jobs {
            if !job.enabled || job.schedule != key {
                continue;
            }
            job.start_run(Timestamp::now());
            if self
                .hand_out_run(&mut job, variables.clone(), depth)
                .is_ok()
            {
                fired.push(job);
            }
        }
        Ok(fired)
    }

    fn snapshot(&self) -> Result<LiveSnapshot, LiveError> {
        self.snapshot_with_thread_cache(true)
    }

    fn snapshot_uncached(&self) -> Result<LiveSnapshot, LiveError> {
        self.snapshot_with_thread_cache(false)
    }

    fn snapshot_with_thread_cache(&self, cache_threads: bool) -> Result<LiveSnapshot, LiveError> {
        let mut thread_listing = if cache_threads {
            self.threads.list()
        } else {
            self.threads.list_uncached()
        }
        .map_err(|error| LiveError::new(format!("could not load threads: {error}")))?;
        let expired = Timestamp::now().unix_seconds() - ARCHIVE_RETENTION_SECONDS;
        thread_listing.threads.retain(|thread| {
            let keep = thread
                .archived_at
                .is_none_or(|at| at.unix_seconds() > expired);
            if !keep {
                let _ = self.threads.delete(&thread.id);
            }
            keep
        });
        let job_listing = self
            .scheduled
            .list()
            .map_err(|error| LiveError::new(format!("could not load scheduled jobs: {error}")))?;
        let research_listing = self.research.list().map_err(|error| {
            LiveError::new(format!("could not load autoresearch jobs: {error}"))
        })?;
        let mut warnings = thread_listing
            .malformed
            .into_iter()
            .map(|item| {
                format!(
                    "Skipped malformed thread {}: {}",
                    item.path.display(),
                    item.reason
                )
            })
            .collect::<Vec<_>>();
        warnings.extend(job_listing.malformed.into_iter().map(|(path, reason)| {
            format!(
                "Skipped malformed scheduled job {}: {}",
                path.display(),
                reason
            )
        }));
        warnings.extend(
            research_listing
                .malformed
                .into_iter()
                .map(|(path, reason)| {
                    format!(
                        "Skipped malformed autoresearch job {}: {}",
                        path.display(),
                        reason
                    )
                }),
        );
        Ok(LiveSnapshot {
            threads: thread_listing.threads,
            scheduled_jobs: job_listing.jobs,
            research_jobs: research_listing.jobs,
            warnings,
        })
    }

    fn thread(&self, thread_id: ThreadId) -> Result<Thread, LiveError> {
        self.threads
            .load(&thread_id)
            .map_err(|error| LiveError::new(format!("could not load thread {thread_id}: {error}")))
    }

    #[allow(clippy::too_many_arguments)]
    fn save_scheduled_job(
        &self,
        job_id: Option<ScheduledJobId>,
        title: String,
        schedule: String,
        prompt: String,
        nodes: String,
        source_domains: Vec<String>,
        permission_mode: String,
        model: String,
    ) -> Result<ScheduledJob, LiveError> {
        let existing = match &job_id {
            Some(id) => Some(
                self.scheduled
                    .load(id)
                    .map_err(|error| LiveError::new(format!("no such scheduled job: {error}")))?,
            ),
            None => None,
        };
        let now = Timestamp::now();
        let mut job = ScheduledJob::from_fields(
            title,
            schedule,
            prompt,
            nodes,
            source_domains,
            permission_mode,
            now,
        )
        .map_err(|error| LiveError::new(format!("scheduled job is invalid: {error}")))?;
        job.set_model(model)
            .map_err(|error| LiveError::new(format!("scheduled job is invalid: {error}")))?;
        if !existing
            .as_ref()
            .is_some_and(|existing| existing.schedule == job.schedule)
        {
            job.book_next_run(now)
                .map_err(|error| LiveError::new(format!("scheduled job is invalid: {error}")))?;
        }
        if let Some(existing) = existing {
            job.id = existing.id;
            job.created_at = existing.created_at;
            job.enabled = existing.enabled;
            job.last_run_at = existing.last_run_at;
            job.last_thread_id = existing.last_thread_id;
            job.outputs = existing.outputs;
            if existing.schedule == job.schedule {
                job.next_run_at = existing.next_run_at;
            }
        }
        self.scheduled
            .save(&job)
            .map_err(|error| LiveError::new(format!("could not save scheduled job: {error}")))?;
        Ok(job)
    }

    fn delete_scheduled_job(&self, job_id: ScheduledJobId) -> Result<(), LiveError> {
        self.scheduled
            .delete(&job_id)
            .map_err(|error| LiveError::new(format!("could not delete scheduled job: {error}")))
    }

    fn run_scheduled_job(
        &mut self,
        job_id: ScheduledJobId,
        variables: String,
    ) -> Result<ScheduledJob, LiveError> {
        let mut job = self
            .scheduled
            .load(&job_id)
            .map_err(|error| LiveError::new(format!("could not load scheduled job: {error}")))?;
        job.start_run(Timestamp::now());
        self.hand_out_run(&mut job, variables, 0)?;
        Ok(job)
    }

    fn finish_scheduled_job(
        &mut self,
        job_id: ScheduledJobId,
        outputs: String,
        depth: u32,
    ) -> Result<ScheduledJob, LiveError> {
        let mut job = self
            .scheduled
            .load(&job_id)
            .map_err(|error| LiveError::new(format!("could not load scheduled job: {error}")))?;
        job.set_outputs(outputs.clone())
            .map_err(|error| LiveError::new(format!("run outputs are invalid: {error}")))?;
        self.scheduled
            .save(&job)
            .map_err(|error| LiveError::new(format!("could not save scheduled job: {error}")))?;
        self.fire_trigger(&format!("after {job_id}"), outputs, depth.saturating_add(1))?;
        Ok(job)
    }

    fn fire_scheduled_event(
        &mut self,
        event: String,
        variables: String,
    ) -> Result<Vec<ScheduledJob>, LiveError> {
        self.fire_trigger(&format!("on {}", event.trim()), variables, 0)
    }

    fn set_scheduled_job_enabled(
        &self,
        job_id: ScheduledJobId,
        enabled: bool,
    ) -> Result<ScheduledJob, LiveError> {
        let mut job = self
            .scheduled
            .load(&job_id)
            .map_err(|error| LiveError::new(format!("could not load scheduled job: {error}")))?;
        job.enabled = enabled;
        self.scheduled
            .save(&job)
            .map_err(|error| LiveError::new(format!("could not save scheduled job: {error}")))?;
        Ok(job)
    }

    #[allow(clippy::too_many_arguments)]
    fn save_research_job(
        &self,
        job_id: Option<ResearchJobId>,
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
    ) -> Result<ResearchJob, LiveError> {
        let job = match job_id {
            Some(id) => {
                let mut job = self.research.load(&id).map_err(|error| {
                    LiveError::new(format!("no such autoresearch job: {error}"))
                })?;
                job.apply_edit(
                    title,
                    project_dir,
                    metric_name,
                    metric_kind,
                    direction,
                    eval_command,
                    prompt,
                    proposer_model,
                    permission_mode,
                    max_seconds,
                    max_tokens,
                    max_micro_dollars,
                )
                .map_err(|error| LiveError::new(error.to_string()))?;
                job
            }
            None => ResearchJob::new(
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
                Timestamp::now(),
            )
            .map_err(|error| LiveError::new(format!("autoresearch job is invalid: {error}")))?,
        };
        self.research
            .save(&job)
            .map_err(|error| LiveError::new(format!("could not save autoresearch job: {error}")))?;
        Ok(job)
    }

    fn delete_research_job(&self, job_id: ResearchJobId) -> Result<(), LiveError> {
        self.research
            .delete(&job_id)
            .map_err(|error| LiveError::new(format!("could not delete autoresearch job: {error}")))
    }

    fn set_research_job_status(
        &self,
        job_id: ResearchJobId,
        status: String,
        note: String,
    ) -> Result<ResearchJob, LiveError> {
        let mut job = self
            .research
            .load(&job_id)
            .map_err(|error| LiveError::new(format!("could not load autoresearch job: {error}")))?;
        job.set_status(status, note)
            .map_err(|error| LiveError::new(error.to_string()))?;
        self.research
            .save(&job)
            .map_err(|error| LiveError::new(format!("could not save autoresearch job: {error}")))?;
        Ok(job)
    }

    fn set_research_job_thread(
        &self,
        job_id: ResearchJobId,
        thread_id: ThreadId,
    ) -> Result<ResearchJob, LiveError> {
        let mut job = self
            .research
            .load(&job_id)
            .map_err(|error| LiveError::new(format!("could not load autoresearch job: {error}")))?;
        job.thread_id = Some(thread_id.to_string());
        self.research
            .save(&job)
            .map_err(|error| LiveError::new(format!("could not save autoresearch job: {error}")))?;
        Ok(job)
    }

    #[allow(clippy::too_many_arguments)]
    fn record_research_iteration(
        &self,
        job_id: ResearchJobId,
        value: Option<f64>,
        outcome: String,
        note: String,
        commit: String,
        duration_ms: u64,
        input_tokens: u64,
        output_tokens: u64,
        micro_dollars: u64,
    ) -> Result<ResearchJob, LiveError> {
        let mut job = self
            .research
            .load(&job_id)
            .map_err(|error| LiveError::new(format!("could not load autoresearch job: {error}")))?;
        job.record_iteration(
            value,
            outcome,
            note,
            commit,
            duration_ms,
            input_tokens,
            output_tokens,
            micro_dollars,
            Timestamp::now(),
        )
        .map_err(|error| LiveError::new(error.to_string()))?;
        job.add_seconds(duration_ms / 1000);
        self.research
            .save(&job)
            .map_err(|error| LiveError::new(format!("could not save autoresearch job: {error}")))?;
        Ok(job)
    }

    fn create_thread(
        &self,
        title: Option<String>,
        parent_thread_id: Option<ThreadId>,
        kind: ThreadKind,
    ) -> Result<Thread, LiveError> {
        let title = title.unwrap_or_else(|| "New thread".to_owned());
        validate_agent_text("thread title", &title, true, MAX_AGENT_TITLE_BYTES)?;
        let mut thread = Thread::new(title, Timestamp::now())
            .map_err(|error| LiveError::new(format!("could not create thread: {error}")))?;
        if let Some(parent) = parent_thread_id {
            self.threads.load(&parent).map_err(|error| {
                LiveError::new(format!("parent thread {parent} is unusable: {error}"))
            })?;
            thread.parent_thread_id = Some(parent);
        } else if kind == ThreadKind::Subagent {
            return Err(LiveError::new("a subagent thread must have a parent"));
        }
        thread.kind = kind;
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save new thread: {error}")))?;
        Ok(thread)
    }

    fn set_thread_archived(
        &self,
        thread_id: ThreadId,
        archived: bool,
    ) -> Result<Thread, LiveError> {
        let mut thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        thread.archived_at = archived.then(Timestamp::now);
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save archived thread: {error}")))?;
        Ok(thread)
    }

    fn rename_thread(&self, thread_id: ThreadId, title: String) -> Result<Thread, LiveError> {
        let title: String = title.split_whitespace().collect::<Vec<_>>().join(" ");
        let title: String = title.chars().take(120).collect();
        validate_text("thread title", &title, true)
            .map_err(|error| LiveError::new(format!("thread title is invalid: {error}")))?;
        let mut thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        thread.title = title;
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save renamed thread: {error}")))?;
        Ok(thread)
    }

    #[allow(clippy::too_many_arguments)]
    fn record_turn(
        &mut self,
        thread_id: ThreadId,
        prompt: String,
        response: String,
        output_tokens: u64,
        duration_milliseconds: u64,
        input_tokens: u64,
        cache_input_tokens: Option<u64>,
        cache_read_tokens: Option<u64>,
        cache_write_tokens: Option<u64>,
        cost_micro_usd: Option<u64>,
        model: String,
    ) -> Result<Thread, LiveError> {
        let prompt = elide_middle(&prompt, MAX_AGENT_MESSAGE_BYTES);
        let response = elide_middle(&response, MAX_AGENT_MESSAGE_BYTES);
        validate_agent_text("prompt", &prompt, true, MAX_AGENT_MESSAGE_BYTES)?;
        validate_agent_text("response", &response, true, MAX_AGENT_MESSAGE_BYTES)?;
        let mut thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        let asked = Timestamp::now().max(thread.updated_at);
        thread
            .push(
                ThreadMessage::new(ThreadRole::User, prompt, asked)
                    .map_err(|error| LiveError::new(format!("prompt is invalid: {error}")))?,
            )
            .map_err(|error| LiveError::new(format!("could not append prompt: {error}")))?;
        let mut answer = ThreadMessage::new(
            ThreadRole::Assistant,
            response,
            asked.max(thread.updated_at),
        )
        .map_err(|error| LiveError::new(format!("response is invalid: {error}")))?;
        answer.generation = GenerationTelemetry::measured(
            output_tokens,
            duration_milliseconds,
            input_tokens,
            model,
        )
        .and_then(|generation| {
            generation.with_provider_usage(
                cache_read_tokens,
                cache_input_tokens,
                cache_write_tokens,
                cost_micro_usd,
            )
        })
        .ok();
        thread
            .push(answer)
            .map_err(|error| LiveError::new(format!("could not append response: {error}")))?;
        thread.note_goal_turn(
            output_tokens.saturating_add(input_tokens),
            duration_milliseconds,
            Timestamp::now(),
        );
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save the turn: {error}")))?;
        Ok(thread)
    }

    fn set_goal(
        &mut self,
        thread_id: ThreadId,
        objective: String,
        token_budget: u64,
    ) -> Result<Thread, LiveError> {
        let mut thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        thread
            .set_goal(objective, token_budget, Timestamp::now())
            .map_err(|error| LiveError::new(format!("goal is invalid: {error}")))?;
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save the goal: {error}")))?;
        Ok(thread)
    }

    fn update_goal(
        &mut self,
        thread_id: ThreadId,
        status: Option<GoalStatus>,
        evidence: String,
        reason: String,
        extra_tokens: u64,
    ) -> Result<Thread, LiveError> {
        let mut thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        let at = Timestamp::now();
        if extra_tokens > 0 {
            thread
                .extend_goal(extra_tokens, at)
                .map_err(|error| LiveError::new(format!("goal cannot be extended: {error}")))?;
        }
        if let Some(status) = status {
            thread
                .update_goal(status, &evidence, &reason, at)
                .map_err(|error| LiveError::new(format!("goal cannot be updated: {error}")))?;
        }
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save the goal: {error}")))?;
        Ok(thread)
    }

    fn clear_goal(&mut self, thread_id: ThreadId) -> Result<Thread, LiveError> {
        let mut thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        if thread.clear_goal() {
            self.threads
                .save(&thread)
                .map_err(|error| LiveError::new(format!("could not clear the goal: {error}")))?;
        }
        Ok(thread)
    }

    fn record_trace(&mut self, thread_id: ThreadId, trace: String) -> Result<(), LiveError> {
        let mut thread = self.threads.load(&thread_id).map_err(|error| {
            LiveError::new(format!("could not load thread {thread_id}: {error}"))
        })?;
        thread.record_trace(
            ThreadTrace::new(Timestamp::now(), &trace)
                .map_err(|error| LiveError::new(format!("trace is invalid: {error}")))?,
        );
        self.threads
            .save(&thread)
            .map_err(|error| LiveError::new(format!("could not save the trace: {error}")))?;
        Ok(())
    }

    fn read_trace(&mut self, thread_id: ThreadId) -> Result<Vec<ThreadTrace>, LiveError> {
        self.threads
            .load(&thread_id)
            .map(|thread| newest_within(thread.traces, MAX_TRACE_REPLY_BYTES))
            .map_err(|error| LiveError::new(format!("could not load thread {thread_id}: {error}")))
    }
}

pub const MAX_TRACE_REPLY_BYTES: usize = 8 * 1024 * 1024;

fn newest_within(traces: Vec<ThreadTrace>, budget: usize) -> Vec<ThreadTrace> {
    let mut room = budget;
    let mut kept: Vec<ThreadTrace> = Vec::new();
    for trace in traces.into_iter().rev() {
        let cost = trace.text.len().saturating_add(64);
        if cost > room && !kept.is_empty() {
            break;
        }
        room = room.saturating_sub(cost);
        kept.push(trace);
    }
    kept.reverse();
    kept
}

fn validate_agent_text(
    name: &str,
    value: &str,
    required: bool,
    max_bytes: usize,
) -> Result<(), LiveError> {
    validate_text(name, value, required)
        .map_err(|error| LiveError::new(format!("{name} is invalid: {error}")))?;
    if value.len() > max_bytes {
        return Err(LiveError::new(format!(
            "{name} cannot exceed {max_bytes} bytes"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_thread_of_huge_traces_answers_with_the_newest_that_fit() {
        let big = |seconds: i64, size: usize| {
            ThreadTrace::new(Timestamp::from_unix_seconds(seconds), &"x".repeat(size)).unwrap()
        };
        let traces = vec![big(1, 4_000), big(2, 4_000), big(3, 4_000)];
        let kept = newest_within(traces, 8_500);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].timestamp, Timestamp::from_unix_seconds(2));
        assert_eq!(kept[1].timestamp, Timestamp::from_unix_seconds(3));

        let one = newest_within(vec![big(4, 4_000)], 16);
        assert_eq!(one.len(), 1);
    }
    use super::*;

    use std::{
        fs,
        sync::{
            Mutex,
            atomic::{AtomicU64, Ordering},
        },
    };

    fn no_jobs() -> JobSink {
        Arc::new(|_| {})
    }

    fn collect_jobs() -> (JobSink, Arc<Mutex<Vec<DueJob>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        (Arc::new(move |job| sink.lock().unwrap().push(job)), seen)
    }

    fn project_dir() -> String {
        if cfg!(windows) {
            r"C:\tmp\project".into()
        } else {
            "/tmp/project".into()
        }
    }

    fn temp_child() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "emma-live-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn live_flow_resaves_one_thread_and_recovers_a_stale_temp() {
        let root = temp_child();
        let thread_root = root.join("threads");
        let mut runtime = Runtime::new(
            thread_root.clone(),
            root.join("scheduled"),
            root.join("research"),
            no_jobs(),
        );

        let created = runtime.create_thread(None, None, ThreadKind::Main).unwrap();
        assert!(
            runtime
                .threads
                .load(&created.id)
                .unwrap()
                .messages
                .is_empty()
        );
        let stale_temp = thread_root.join(format!(".{}.tmp", created.id));
        fs::write(&stale_temp, "stale interrupted save").unwrap();
        let updated = runtime
            .record_turn(
                created.id.clone(),
                "hello".into(),
                "Fake reply to hello".into(),
                4,
                200,
                2,
                None,
                None,
                None,
                None,
                "fake".into(),
            )
            .unwrap();

        assert_eq!(updated.id, created.id);
        assert_eq!(updated.messages.len(), 2);
        assert_eq!(
            updated.messages[1]
                .generation
                .as_ref()
                .map(|generation| (generation.output_tokens, generation.duration_milliseconds)),
            Some((4, 200))
        );
        assert_eq!(runtime.threads.load(&created.id).unwrap(), updated);
        assert!(!stale_temp.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn targeted_thread_load_reads_only_the_requested_record() {
        let root = temp_child();
        let runtime = Runtime::new(
            root.join("threads"),
            root.join("scheduled"),
            root.join("research"),
            no_jobs(),
        );
        let first = runtime.create_thread(None, None, ThreadKind::Main).unwrap();
        let second = runtime.create_thread(None, None, ThreadKind::Main).unwrap();
        let loaded = runtime.thread(first.id.clone()).unwrap();
        assert_eq!(loaded.id, first.id);
        assert_ne!(loaded.id, second.id);
        let missing = ThreadId::parse("missing-thread-id").unwrap();
        assert!(runtime.thread(missing).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compact_snapshot_does_not_populate_the_thread_cache() {
        let root = temp_child();
        let runtime = Runtime::new(
            root.join("threads"),
            root.join("scheduled"),
            root.join("research"),
            no_jobs(),
        );
        let first = runtime.create_thread(None, None, ThreadKind::Main).unwrap();
        let second = runtime.create_thread(None, None, ThreadKind::Main).unwrap();
        runtime.threads.clear_cache_for_test();
        let full = runtime.snapshot().unwrap();
        assert_eq!(full.threads.len(), 2);
        assert_eq!(runtime.threads.cached_len(), 2);
        runtime.threads.clear_cache_for_test();
        runtime.thread(first.id.clone()).unwrap();
        assert_eq!(runtime.threads.cached_len(), 1);
        let compact = runtime.snapshot_uncached().unwrap();
        assert_eq!(compact.threads.len(), 2);
        assert_eq!(runtime.threads.cached_len(), 0);
        assert_eq!(runtime.thread(first.id.clone()).unwrap().id, first.id);
        assert_eq!(runtime.threads.cached_len(), 1);
        runtime.thread(second.id.clone()).unwrap();
        fs::remove_file(root.join("threads").join(format!("{}.md", second.id))).unwrap();
        let compact = runtime.snapshot_uncached().unwrap();
        assert_eq!(compact.threads.len(), 1);
        assert_eq!(runtime.threads.cached_len(), 0);
        fs::remove_dir_all(root.join("threads")).unwrap();
        let compact = runtime.snapshot_uncached().unwrap();
        assert!(compact.threads.is_empty());
        assert_eq!(runtime.threads.cached_len(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn renaming_a_thread_collapses_whitespace_and_refuses_an_empty_name() {
        let root = temp_child();
        let runtime = Runtime::new(
            root.join("threads"),
            root.join("scheduled"),
            root.join("research"),
            no_jobs(),
        );
        let thread = runtime.create_thread(None, None, ThreadKind::Main).unwrap();
        let named = runtime
            .rename_thread(thread.id.clone(), "  Trip\n  plans  ".into())
            .unwrap();
        assert_eq!(named.title, "Trip plans");
        assert_eq!(
            runtime.threads.load(&thread.id).unwrap().title,
            "Trip plans"
        );
        assert!(
            runtime
                .rename_thread(thread.id.clone(), "   ".into())
                .is_err()
        );
        assert_eq!(
            runtime.threads.load(&thread.id).unwrap().title,
            "Trip plans"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archived_threads_survive_until_the_retention_window_closes() {
        let root = temp_child();
        let runtime = Runtime::new(
            root.join("threads"),
            root.join("scheduled"),
            root.join("research"),
            no_jobs(),
        );
        let kept = runtime.create_thread(None, None, ThreadKind::Main).unwrap();
        let expired = runtime.create_thread(None, None, ThreadKind::Main).unwrap();
        assert!(
            runtime
                .set_thread_archived(kept.id.clone(), true)
                .unwrap()
                .archived_at
                .is_some()
        );
        let mut stale = runtime
            .set_thread_archived(expired.id.clone(), true)
            .unwrap();
        stale.archived_at = Some(Timestamp::from_unix_seconds(
            Timestamp::now().unix_seconds() - ARCHIVE_RETENTION_SECONDS - 1,
        ));
        runtime.threads.save(&stale).unwrap();

        let threads = runtime.snapshot().unwrap().threads;
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].id, kept.id);
        assert!(runtime.threads.load(&expired.id).is_err());
        assert!(
            runtime
                .set_thread_archived(kept.id.clone(), false)
                .unwrap()
                .archived_at
                .is_none()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_recorded_turn_lands_in_the_thread_without_reaching_the_agent() {
        let root = temp_child();
        let mut runtime = Runtime::new(
            root.join("threads"),
            root.join("scheduled"),
            root.join("research"),
            no_jobs(),
        );
        let thread = runtime.create_thread(None, None, ThreadKind::Main).unwrap();
        runtime
            .record_turn(
                thread.id.clone(),
                "build me a timer".into(),
                "Built it in timer.html.".into(),
                42,
                1_500,
                3_700,
                Some(3_700),
                Some(2_800),
                Some(1_000),
                Some(12_345),
                "claude-opus-4".into(),
            )
            .unwrap();

        let saved = runtime.threads.load(&thread.id).unwrap();
        assert_eq!(saved.messages.len(), 2);
        assert_eq!(saved.messages[0].role, ThreadRole::User);
        assert_eq!(saved.messages[1].content, "Built it in timer.html.");
        assert_eq!(
            saved.messages[1].generation.as_ref().unwrap().output_tokens,
            42
        );
        assert_eq!(
            saved.messages[1].generation.as_ref().unwrap().input_tokens,
            3_700
        );
        assert_eq!(
            saved.messages[1]
                .generation
                .as_ref()
                .unwrap()
                .cache_read_tokens,
            Some(2_800)
        );
        assert_eq!(
            saved.messages[1]
                .generation
                .as_ref()
                .unwrap()
                .cache_write_tokens,
            Some(1_000)
        );
        assert_eq!(
            saved.messages[1]
                .generation
                .as_ref()
                .unwrap()
                .cost_micro_usd,
            Some(12_345)
        );
        assert_eq!(
            saved.messages[1].generation.as_ref().unwrap().model,
            "claude-opus-4"
        );
        assert!(
            runtime
                .record_turn(
                    thread.id.clone(),
                    "ask".into(),
                    "  ".into(),
                    0,
                    0,
                    0,
                    None,
                    None,
                    None,
                    None,
                    String::new()
                )
                .is_err()
        );
        let long = "let x = 1;\n".repeat(MAX_AGENT_MESSAGE_BYTES / 8);
        runtime
            .record_turn(
                thread.id.clone(),
                "build a 3js game".into(),
                long,
                0,
                0,
                0,
                None,
                None,
                None,
                None,
                String::new(),
            )
            .unwrap();
        let saved = runtime.threads.load(&thread.id).unwrap();
        assert_eq!(saved.messages.len(), 4);
        assert!(saved.messages[3].content.len() <= MAX_AGENT_MESSAGE_BYTES);
        assert!(saved.messages[3].content.contains("lines elided"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scheduled_job_edits_book_changed_cron_from_now_and_preserve_run_state() {
        let root = temp_child();
        let runtime = Runtime::new(
            root.join("threads"),
            root.join("scheduled"),
            root.join("research"),
            no_jobs(),
        );
        let now = Timestamp::now().unix_seconds();
        let mut original = ScheduledJob::new(
            "Daily reading".into(),
            "0 9 * * *".into(),
            "Find useful reading".into(),
            "[]".into(),
            vec!["example.com".into()],
            "acceptEdits".into(),
            Timestamp::from_unix_seconds(now - 30 * 86_400),
        )
        .unwrap();
        original.enabled = false;
        original.next_run_at = Some(Timestamp::from_unix_seconds(now + 3 * 86_400));
        original.last_run_at = Some(Timestamp::from_unix_seconds(now - 86_400));
        original.last_thread_id = Some("thread-1700000000-a-b-c".into());
        original.outputs = "{\"digest\":\"three items\"}".into();
        original.model = "openrouter:deepseek/deepseek-chat".into();
        for schedule in [
            "0 9 * * *",
            "0 10 * * *",
            "manual",
            "on page-saved",
            "after job-1700000000-a-b-c",
        ] {
            runtime.scheduled.save(&original).unwrap();
            let before = Timestamp::now();
            let saved = runtime
                .save_scheduled_job(
                    Some(original.id.clone()),
                    original.title.clone(),
                    schedule.into(),
                    original.prompt.clone(),
                    original.nodes.clone(),
                    original.source_domains.clone(),
                    original.permission_mode.clone(),
                    original.model.clone(),
                )
                .unwrap();
            let after = Timestamp::now();
            let mut expected = original.clone();
            expected.schedule = schedule.into();
            if schedule == "0 10 * * *" {
                let next = saved.next_run_at.unwrap();
                assert!(next > before);
                assert!(next.unix_seconds() <= after.unix_seconds() + 86_400);
                expected.next_run_at = Some(next);
            } else if schedule != original.schedule {
                expected.next_run_at = None;
            }
            assert_eq!(saved, expected);
            assert_eq!(runtime.scheduled.load(&original.id).unwrap(), expected);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rare_cron_bookings_survive_reload_and_title_edits() {
        let root = temp_child();
        let runtime = Runtime::new(
            root.join("threads"),
            root.join("scheduled"),
            root.join("research"),
            no_jobs(),
        );
        let created_at = "2024-01-01T00:00:00Z".parse().unwrap();
        for (schedule, booked_at, next_run_at) in [
            (
                "0 10 28 2 0",
                "2026-08-28T00:00:00Z",
                "2027-02-28T10:00:00Z",
            ),
            (
                "0 10 29 2 *",
                "2028-01-01T00:00:00Z",
                "2028-02-29T10:00:00Z",
            ),
        ] {
            let mut job = ScheduledJob::new(
                "Rare reading".into(),
                schedule.into(),
                "Find useful reading".into(),
                String::new(),
                vec![],
                "ask".into(),
                booked_at.parse().unwrap(),
            )
            .unwrap();
            job.created_at = created_at;
            job.enabled = false;
            assert_eq!(job.next_run_at, Some(next_run_at.parse().unwrap()));
            runtime.scheduled.save(&job).unwrap();
            assert_eq!(runtime.scheduled.load(&job.id).unwrap(), job);
            let saved = runtime
                .save_scheduled_job(
                    Some(job.id.clone()),
                    "Renamed reading".into(),
                    job.schedule.clone(),
                    job.prompt.clone(),
                    job.nodes.clone(),
                    job.source_domains.clone(),
                    job.permission_mode.clone(),
                    job.model.clone(),
                )
                .unwrap();
            job.title = "Renamed reading".into();
            assert_eq!(saved, job);
            assert_eq!(runtime.scheduled.load(&job.id).unwrap(), job);
            let snapshot = runtime.snapshot().unwrap();
            assert!(snapshot.warnings.is_empty());
            assert!(snapshot.scheduled_jobs.contains(&job));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn due_scheduled_job_claims_once_and_hands_its_turn_out_under_its_saved_mode() {
        let root = temp_child();
        let (sink, due) = collect_jobs();
        let mut runtime = Runtime::new(
            root.join("threads"),
            root.join("scheduled"),
            root.join("research"),
            sink,
        );
        let mut job = runtime
            .save_scheduled_job(
                None,
                "Weekly discovery".into(),
                "0 9 * * 1".into(),
                "Find useful reading".into(),
                String::new(),
                vec!["example.com".into()],
                "acceptEdits".into(),
                "openrouter:deepseek/deepseek-chat".into(),
            )
            .unwrap();
        job.created_at = Timestamp::from_unix_seconds(0);
        job.next_run_at = Some(Timestamp::from_unix_seconds(60));
        runtime.scheduled.save(&job).unwrap();

        runtime.run_due_jobs();
        runtime.run_due_jobs();

        let jobs = runtime.scheduled.list().unwrap().jobs;
        let threads = runtime.threads.list().unwrap().threads;
        let handed = due.lock().unwrap();
        assert_eq!(threads.len(), 1);
        assert_eq!(handed.len(), 1);
        assert_eq!(handed[0].thread_id, threads[0].id.to_string());
        assert_eq!(handed[0].prompt, "Find useful reading");
        assert_eq!(handed[0].permission_mode, "acceptEdits");
        assert_eq!(jobs[0].model, "openrouter:deepseek/deepseek-chat");
        assert_eq!(handed[0].model, jobs[0].model);
        assert_eq!(
            jobs[0].last_thread_id.as_deref(),
            Some(threads[0].id.as_str())
        );
        assert!(jobs[0].last_run_at.is_some());
        assert_eq!(threads[0].scheduled_job_id.as_ref(), Some(&jobs[0].id));
        drop(handed);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_finished_job_fires_what_waits_on_it_and_a_trigger_loop_runs_out() {
        let root = temp_child();
        let (sink, due) = collect_jobs();
        let mut runtime = Runtime::new(
            root.join("threads"),
            root.join("scheduled"),
            root.join("research"),
            sink,
        );
        let first = runtime
            .save_scheduled_job(
                None,
                "Collect".into(),
                "manual".into(),
                "Collect the week".into(),
                String::new(),
                vec![],
                "ask".into(),
                String::new(),
            )
            .unwrap();
        let second = runtime
            .save_scheduled_job(
                None,
                "Summarise".into(),
                format!("after {}", first.id),
                "Summarise {{digest}}".into(),
                String::new(),
                vec![],
                "ask".into(),
                String::new(),
            )
            .unwrap();
        runtime
            .save_scheduled_job(
                Some(first.id.clone()),
                "Collect".into(),
                format!("after {}", second.id),
                "Collect the week".into(),
                String::new(),
                vec![],
                "ask".into(),
                String::new(),
            )
            .unwrap();
        assert_eq!(first.next_run_at, None);

        let outputs = "{\"digest\":\"three items\"}";
        runtime
            .finish_scheduled_job(first.id.clone(), outputs.into(), 0)
            .unwrap();
        for finished in 0..16 {
            let next = due.lock().unwrap().get(finished).cloned();
            let Some(run) = next else { break };
            runtime
                .finish_scheduled_job(
                    ScheduledJobId::parse(run.job_id).unwrap(),
                    outputs.into(),
                    run.depth,
                )
                .unwrap();
        }

        let handed = due.lock().unwrap();
        assert_eq!(handed[0].job_id, second.id.as_str());
        assert_eq!(handed[0].variables, outputs);
        assert_eq!(handed[0].depth, 1);
        assert_eq!(handed.len(), MAX_TRIGGER_DEPTH as usize, "{handed:?}");
        assert_eq!(runtime.scheduled.load(&first.id).unwrap().outputs, outputs);
        drop(handed);

        runtime.delete_scheduled_job(second.id.clone()).unwrap();
        assert!(runtime.scheduled.load(&second.id).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_autoresearch_edit_keeps_the_run_it_already_has_and_refuses_a_new_metric() {
        let root = temp_child();
        let runtime = Runtime::new(
            root.join("threads"),
            root.join("scheduled"),
            root.join("research"),
            no_jobs(),
        );
        let save = |job_id, title: &str, metric: &str, budget| {
            runtime.save_research_job(
                job_id,
                title.into(),
                project_dir(),
                metric.into(),
                "grep".into(),
                String::new(),
                "lower".into(),
                "uv run train.py 2>&1".into(),
                "Only touch the optimiser".into(),
                "openai/gpt-5".into(),
                "ask".into(),
                budget,
                0,
                0,
            )
        };
        let job = save(None, "Lower the loss", "val_bpb", 0).unwrap();
        assert_eq!(job.status, "paused");

        runtime
            .record_research_iteration(
                job.id.clone(),
                Some(1.5),
                "keep".into(),
                "widened the window".into(),
                "abc1234".into(),
                90_000,
                300,
                200,
                7,
            )
            .unwrap();
        let recorded = runtime
            .record_research_iteration(
                job.id.clone(),
                Some(2.0),
                "discard".into(),
                String::new(),
                String::new(),
                30_000,
                100,
                100,
                3,
            )
            .unwrap();
        assert_eq!(recorded.iterations[1].index, 1);
        assert_eq!(recorded.iterations[1].best, Some(1.5));
        assert_eq!(recorded.spent_tokens, 700);
        assert_eq!(recorded.spent_micro_dollars, 10);
        assert_eq!(recorded.spent_seconds, 120);

        let edited = save(Some(job.id.clone()), "Lower the loss more", "val_bpb", 600).unwrap();
        assert_eq!(edited.max_seconds, 600);
        assert_eq!(edited.iterations.len(), 2);
        assert_eq!(edited.spent_seconds, 120);
        assert!(save(Some(job.id.clone()), "Lower the loss more", "val_loss", 600).is_err());

        let paused = runtime
            .set_research_job_status(job.id.clone(), "paused".into(), "out of seconds".into())
            .unwrap();
        assert_eq!(paused.status_note, "out of seconds");
        let thread = runtime.create_thread(None, None, ThreadKind::Main).unwrap();
        let attached = runtime
            .set_research_job_thread(job.id.clone(), thread.id.clone())
            .unwrap();
        assert_eq!(
            attached.thread_id.as_deref(),
            Some(thread.id.to_string().as_str())
        );
        assert_eq!(runtime.snapshot().unwrap().research_jobs.len(), 1);

        runtime.delete_research_job(job.id.clone()).unwrap();
        assert!(runtime.snapshot().unwrap().research_jobs.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
